// src/app/app.ts
import { BackendHealthMonitor } from "../api/backend-health-monitor";
import { LocalSaver } from "../api/local-saver";
import { MeetingRegistrar, type RegistrationOutcome } from "../api/meeting-registrar";
import { finalizeMeeting, type FinalizeResult } from "../recording/finalizer";
import { LocalSaveScheduler } from "../recording/local-save-scheduler";
import { tryAcquireMeetingLock, type MeetingLockManager } from "../recording/meeting-lock";
import { attachPageLifecycle } from "../recording/page-lifecycle";
import { RecordingController, type ChunkEnqueuer, type MemoryBacklogFile, type RecordingControllerDeps } from "../recording/recording-controller";
import { createInitialHealth } from "../recording/recording-health-monitor";
import { recoverOnStartup, type RecoveryReport } from "../recording/recovery";
import { ChunkStore, MeetingStore, SettingsStore } from "../storage/idb";
import { enforceQuota, requestPersistence } from "../storage/quota-monitor";
import type { LocalBackendHealth, MeetingRecord, RecordingHealth, RecordingStopReason } from "../types/recording";

/** settings ストアでトークンを保存するキー（§4.3） */
export const BACKEND_TOKEN_KEY = "backendToken";

/** Authorization ヘッダーに載せられる、空白を含まない印字可能 ASCII。範囲外の文字は fetch が送信前に TypeError を投げる */
const BACKEND_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/** UI への通知。UI はこれを表示するだけで、部品を直接呼ばない */
export type AppEvent =
  | { readonly type: "finalize_pending"; readonly meetingId: string; readonly result: Extract<FinalizeResult, { ok: false }> }
  | { readonly type: "finalize_abandoned"; readonly meetingId: string }
  | { readonly type: "recording_stopped"; readonly meetingId: string; readonly reason: "manual" | "mic_ended" }
  | { readonly type: "recovered"; readonly report: RecoveryReport }
  /** missingTailMs：末尾が欠けたまま確定した長さ（§22）。UI は「末尾 約◯秒が保存されていません」と警告する */
  | { readonly type: "finalized"; readonly meetingId: string; readonly missingTailMs?: number }
  /** §3.4 段階2：IDB 使用率 95% 以上で削除できる Blob がない。UI はエクスポートを促す */
  | { readonly type: "export_required"; readonly meetingId: string }
  /** IDB にもサーバーにも保存できない Chunk がメモリ待機に残っている。UI は exportMemoryBacklog() の書き出しを促す（§15） */
  | { readonly type: "memory_backlog_export_required"; readonly meetingId: string; readonly error: unknown }
  | { readonly type: "error"; readonly error: unknown };

/** 録音セッションが使う RecordingController の口。テストでは Fake を差し込む */
export type SessionController = Pick<RecordingController, "start" | "stop" | "flush" | "drainMemoryBacklog" | "exportMemoryBacklog" | "memoryBacklogCount" | "takeMeetingLock">;

export interface AppDeps {
  readonly db: IDBDatabase;
  readonly baseUrl: string; // 例: "http://127.0.0.1:43117"
  readonly workletModuleUrl: string;
  readonly locks: MeetingLockManager; // 本番は navigator.locks
  readonly onEvent: (event: AppEvent) => void;
  readonly fetchImpl?: typeof fetch;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly now?: () => number;
  readonly createController?: (deps: RecordingControllerDeps) => SessionController;
}

export interface StartRecordingInput {
  readonly audioContext: AudioContext;
  readonly mediaStream: MediaStream;
  readonly meetingId: string;
  readonly title: string;
  readonly consentConfirmedAt: number;
  /** タブが hidden になったとき（§20）。UI が Health の監視間隔を詰める */
  readonly onHidden?: () => void;
}

export interface RecordingSession {
  readonly meetingId: string;
  readonly controller: SessionController;
  /** 録音を止め、Finalization Barrier を試みる（§22）。サーバー未起動なら stop_requested のまま残り、復帰時に再試行される */
  stop(): Promise<FinalizeResult>;
}

const HEALTH_CONFIG = { healthyIntervalMs: 10_000, unreachableIntervalMs: 5_000, timeoutMs: 2_000, degradedLatencyMs: 1_000 } as const;
const PUT_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PUTS = 2;

/** 起動時に 1 回呼ぶ。§23 の復旧を済ませてからヘルスチェックを始める */
export async function createApp(deps: AppDeps): Promise<App> {
  const stored = await new SettingsStore(deps.db).get(BACKEND_TOKEN_KEY);
  const app = new App(deps, typeof stored === "string" && stored !== "" ? stored : null);
  await app.init();
  return app;
}

export class App {
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly health: RecordingHealth;
  readonly monitor: BackendHealthMonitor;
  readonly scheduler: LocalSaveScheduler;
  private readonly settings: SettingsStore;
  private saver: LocalSaver | null = null;
  private readonly registrar: MeetingRegistrar;
  private readonly meetingFallbacks = new Map<string, MeetingRecord>();
  private session: RecordingSession | null = null;
  /** startRecording の開始処理中（session が入る前）か */
  private starting = false;
  /** このタブで録音した会議の controller。stop 後もメモリ待機が残りうるため、Barrier の unpersistedChunkCount に使う（§22） */
  private readonly controllers = new Map<string, SessionController>();
  /** stop 後もメモリ待機が残る会議のロック。別タブの Barrier はこのタブのメモリ待機を数えられないため、空になるまで持つ（§22） */
  private readonly heldLocks = new Map<string, () => void>();
  /** heldLocks を借りて確定・中止を実行中の会議。借用中は同じタブの別処理にも貸さない */
  private readonly heldLockBusy = new Set<string>();
  /** 会議ごとのメモリ待機の drain。stop 後に残った末尾を、サーバー復帰時に確定より先に送る */
  private readonly drains = new Map<string, (notify: boolean) => Promise<void>>();
  private unsubscribeMonitor: () => void = () => undefined;
  private disposed = false;
  private readonly finalizing = new Map<string, Promise<FinalizeResult>>();
  private readonly finalizeRequested = new Set<string>();
  /** 実行中の Barrier が古いトークンで 401/403 を受けた会議。ロックを持ったまま現在のトークンでやり直す */
  private readonly finalizeTokenChanged = new Set<string>();
  /** 直接送信で DB 登録まで済んだ件数。IDB に残らないので、確定待ちの件数表示に足す */
  private readonly directRegistered = new Map<string, number>();
  /** 直接送信で DB 登録まで済んだ Chunk の最大 endFrame。確定待ちの末尾の網羅確認に使う */
  private readonly directRegisteredEndFrame = new Map<string, number>();
  private readonly waitingForSave = new Set<string>();
  private readonly finalizeIssues = new Map<string, Extract<FinalizeResult, { ok: false }>>();
  /** このタブで確定中止した会議。IDB が読めなくなっても、中止済みの会議に PUT を始めないために使う */
  private readonly abandoned = new Set<string>();

  constructor(
    private readonly deps: AppDeps,
    private token: string | null,
  ) {
    this.chunkStore = new ChunkStore(deps.db);
    this.meetingStore = new MeetingStore(deps.db);
    this.settings = new SettingsStore(deps.db);
    this.registrar = new MeetingRegistrar({
      baseUrl: deps.baseUrl,
      token: () => this.token,
      getMeeting: async (meetingId) => {
        try {
          return (await this.meetingStore.get(meetingId)) ?? this.meetingFallbacks.get(meetingId);
        } catch {
          return this.meetingFallbacks.get(meetingId);
        }
      },
      fetchImpl: deps.fetchImpl ?? fetch,
      timeoutMs: PUT_TIMEOUT_MS,
      onBackendUnauthorized: () => this.monitor.reportUnauthorized(),
    });
    this.health = createInitialHealth("running");
    const fetchImpl = deps.fetchImpl ?? fetch;
    this.monitor = new BackendHealthMonitor({ baseUrl: deps.baseUrl, token: () => this.token, ...HEALTH_CONFIG }, this.health, fetchImpl);
    this.scheduler = new LocalSaveScheduler({
      chunkStore: this.chunkStore,
      saver: () => this.saver,
      backend: () => this.monitor.state,
      health: this.health,
      maxConcurrency: MAX_CONCURRENT_PUTS,
      now: deps.now ?? Date.now,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      // §18：PUT の失敗をポーリングを待たずに Monitor へ伝える
      onBackendUnreachable: () => this.monitor.reportUnreachable(),
      onBackendUnauthorized: () => this.monitor.reportUnauthorized(),
      isMeetingAbandoned: async (id) => (await this.meetingStore.get(id))?.status === "abandoned",
      onChunkSaved: (meetingId) => { void this.onChunkSaved(meetingId); },
    });
    if (token !== null) this.saver = this.createSaver(token);
  }

  get currentSession(): RecordingSession | null {
    return this.session;
  }

  async init(): Promise<void> {
    const report = await recoverOnStartup(this.meetingStore, this.chunkStore, this.scheduler, this.deps.locks);
    this.deps.onEvent({ type: "recovered", report });
    this.unsubscribeMonitor = this.monitor.onChange((state) => {
      if (isUsable(state)) void this.onBackendAvailable();
    });
    this.monitor.start();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeMonitor();
    this.monitor.stop();
  }

  /** 設定画面からトークンを保存する（§4.3）。ヘルス状態が変わらなくても、待機中の Chunk をすぐ送り直す */
  async setToken(token: string): Promise<void> {
    if (token === "") throw new Error("token is empty");
    // 保存してしまうと全通信が送信前に失敗し「サーバー未接続」としか出ないため、保存前に弾く
    if (!BACKEND_TOKEN_PATTERN.test(token)) throw new Error("トークンの形式が正しくありません。サーバーのトークンファイルの中身をそのまま貼り付けてください");
    await this.settings.set(BACKEND_TOKEN_KEY, token);
    this.token = token;
    // 差し替えずに更新する。Scheduler が IDB 読み込み中に掴んでいる saver も新しいトークンで送る
    if (this.saver === null) this.saver = this.createSaver(token);
    else this.saver.setToken(token);
    const state = await this.monitor.checkOnce();
    if (isUsable(state)) await this.onBackendAvailable();
  }

  async startRecording(input: StartRecordingInput): Promise<RecordingSession> {
    // session は開始処理の await 後に入るため、開始中フラグでも弾く（別会議 ID の同時開始を含む）
    if (this.session !== null || this.starting) throw new Error("already recording");
    this.starting = true;
    try {
      return await this.startSession(input);
    } finally {
      this.starting = false;
    }
  }

  private async startSession(input: StartRecordingInput): Promise<RecordingSession> {
    const { meetingId } = input;
    // 永続化は録音開始のついでに要求する。拒否・失敗しても録音は止めない（§3.4）
    await requestPersistence(this.health).catch((error: unknown) => this.deps.onEvent({ type: "error", error }));

    let quotaCheck: Promise<void> = Promise.resolve();
    let draining = false;
    /** notify：空になったら確定を再開させる。onBackendAvailable は自分で確定するので false で呼ぶ */
    const drain = async (notify = true): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        await controller.drainMemoryBacklog();
        // 直接送信は Scheduler を通らず onChunkSaved が来ない。空になったら停止後の Barrier を再開させる
        if (controller.memoryBacklogCount === 0) {
          this.releaseHeldLockIfDrained(meetingId);
          if (notify) void this.onChunkSaved(meetingId);
        }
      } catch (error) {
        this.deps.onEvent({ type: "memory_backlog_export_required", meetingId, error });
      } finally {
        draining = false;
      }
    };
    const enqueuer: ChunkEnqueuer = {
      enqueue: async (chunkKey) => {
        await this.scheduler.enqueue(chunkKey);
        // §21：Chunk 保存ごとにクォータを確認する。enqueue の失敗と混ざらないよう待たずに直列で回す
        quotaCheck = quotaCheck.then(async () => {
          try {
            const action = await enforceQuota(this.chunkStore, meetingId, this.health);
            if (action === "export_required") this.deps.onEvent({ type: "export_required", meetingId });
            // Blob を消して空きができたら、クォータ超過でメモリ待機に回った Chunk を IDB へ書き戻す（§15）
            if (action === "dropped_registered_blobs" && controller.memoryBacklogCount > 0) await drain();
          } catch (error) {
            this.deps.onEvent({ type: "error", error });
          }
        });
      },
    };
    let micEnded = false;
    let micEndedAt = 0;
    let stopForMic: (() => void) | undefined;
    const create = this.deps.createController ?? ((d: RecordingControllerDeps) => new RecordingController(d));
    const controller = create({
      audioContext: input.audioContext,
      mediaStream: input.mediaStream,
      chunkStore: this.chunkStore,
      meetingStore: this.meetingStore,
      scheduler: enqueuer,
      health: this.health,
      workletModuleUrl: this.deps.workletModuleUrl,
      onError: (error) => {
        this.deps.onEvent({ type: "error", error });
        // クォータ以外の IDB 失敗は IDB の回復を待たずにサーバーへ直接送る（§15）
        if (this.health.degradedReasons.includes("IDB_WRITE_FAILED")) void drain();
      },
      setTimer: this.deps.setTimer,
      locks: this.deps.locks,
      onMicEnded: () => {
        if (!micEnded) micEndedAt = (this.deps.now ?? Date.now)();
        micEnded = true;
        stopForMic?.();
      },
      onMeetingCreated: (meeting) => this.meetingFallbacks.set(meeting.meetingId, meeting),
      // 送るたびに現在の saver を引く。録音中に setToken しても、開始時のトークン（未設定・失効）で送り続けない
      directSaver: {
        put: async (record) => {
          const outcome = (await this.saver?.put(record)) ??
            { ok: false, retryable: false, error: { kind: "UNAUTHORIZED", message: "backend token is not set", httpStatus: null, at: (this.deps.now ?? Date.now)() } };
          // Scheduler を通らないので、PUT の 401/403 はここで Monitor へ伝える（会議登録の分は MeetingRegistrar が報告済み）
          if (!outcome.ok && outcome.error.kind === "UNAUTHORIZED" && outcome.unauthorizedReported !== true &&
            (outcome.error.httpStatus === 401 || outcome.error.httpStatus === 403)) {
            this.monitor.reportUnauthorized();
          }
          if (outcome.ok && outcome.registered) {
            this.directRegistered.set(meetingId, this.directRegisteredCount(meetingId) + 1);
            this.directRegisteredEndFrame.set(meetingId, Math.max(this.directRegisteredEndFrame.get(meetingId) ?? 0, record.meta.endFrame));
          }
          return outcome;
        },
      },
    });

    await controller.start(meetingId, input.title, input.consentConfirmedAt);
    // Fake controller も含め、コールバックが未実装の実装では IDB から補完する。
    if (!this.meetingFallbacks.has(meetingId)) {
      const startedMeeting = await this.meetingStore.get(meetingId).catch(() => undefined);
      if (startedMeeting !== undefined) this.meetingFallbacks.set(meetingId, startedMeeting);
    }
    this.controllers.set(meetingId, controller);
    this.drains.set(meetingId, drain);
    let recording = true;
    const lifecycle = attachPageLifecycle(controller, () => recording, input.onHidden ?? (() => undefined));
    let stopping: Promise<FinalizeResult> | undefined;
    const stopOnce = async (reason: RecordingStopReason, detectedAtEpochMs: number): Promise<FinalizeResult> => {
      try {
        await controller.stop(reason, detectedAtEpochMs);
      } finally {
        recording = false;
        const held = controller.takeMeetingLock();
        if (held !== null) this.heldLocks.set(meetingId, held);
        lifecycle.detach();
        this.session = null;
        this.deps.onEvent({ type: "recording_stopped", meetingId, reason });
        if (controller.memoryBacklogCount > 0) {
          this.deps.onEvent({ type: "memory_backlog_export_required", meetingId, error: new Error("audio remains in memory") });
        }
      }
      // stop 完了後に会議ロックを取り直し、確定中止操作との競合も防ぐ。
      return this.retryFinalize(meetingId);
    };
    const session: RecordingSession = {
      meetingId,
      controller,
      stop: () => stopping ??= stopOnce("manual", (this.deps.now ?? Date.now)()),
    };
    this.session = session;
    stopForMic = () => { void (stopping ??= stopOnce("mic_ended", micEndedAt)).catch((error: unknown) => this.deps.onEvent({ type: "error", error })); };
    if (micEnded) stopForMic();
    return session;
  }

  /** 停止したが確定していない会議。自動再試行に加えて UI からの手動再試行も用意する */
  async listPendingFinalize(): Promise<MeetingRecord[]> {
    const stopped = await this.meetingStore.listByStatus("stop_requested");
    const finalizing = await this.meetingStore.listByStatus("finalizing");
    return [...stopped, ...finalizing];
  }

  getFinalizeIssue(meetingId: string): Extract<FinalizeResult, { ok: false }> | undefined {
    return this.finalizeIssues.get(meetingId);
  }

  memoryBacklogCount(meetingId?: string): number {
    if (meetingId !== undefined) return this.controllers.get(meetingId)?.memoryBacklogCount ?? 0;
    return [...this.controllers.values()].reduce((sum, c) => sum + c.memoryBacklogCount, 0);
  }

  /** このタブが直接送信で登録した件数。再読み込みで失われるので、0 は「直接送信なし」を保証しない */
  directRegisteredCount(meetingId: string): number {
    return this.directRegistered.get(meetingId) ?? 0;
  }

  /** IDB に残らない Chunk（このタブの直接送信・メモリ待機）の最大 endFrame。再読み込みで失われる */
  offIdbEndFrame(meetingId: string): number {
    const memory = this.exportMemoryBacklog(meetingId).map((f) => f.meta.endFrame);
    return Math.max(this.directRegisteredEndFrame.get(meetingId) ?? 0, ...memory);
  }

  exportMemoryBacklog(meetingId: string): MemoryBacklogFile[] {
    return this.controllers.get(meetingId)?.exportMemoryBacklog() ?? [];
  }

  /** UI で対象・未保存の可能性を説明し、確認した場合だけ呼ぶ。データは削除しない。 */
  async abandonFinalize(meetingId: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("確定の中止には確認が必要です");
    if (this.session?.meetingId === meetingId) throw new Error("録音中の会議は中止できません");
    const release = await this.acquireMeetingLock(meetingId);
    if (release === null) throw new Error("別の処理がこの会議を使用中です。完了後にやり直してください");
    try {
      const meeting = await this.meetingStore.get(meetingId);
      if (meeting?.status === "abandoned") {
        this.abandoned.add(meetingId);
        return;
      }
      if (meeting?.status !== "stop_requested" && meeting?.status !== "finalizing") throw new Error("確定待ちの会議だけ中止できます");
      meeting.status = "abandoned";
      meeting.updatedAt = (this.deps.now ?? Date.now)();
      await this.meetingStore.put(meeting);
      this.abandoned.add(meetingId);
      this.scheduler.discardMeeting(meetingId);
      this.waitingForSave.delete(meetingId);
      this.finalizeRequested.delete(meetingId);
      this.finalizeIssues.delete(meetingId);
      this.deps.onEvent({ type: "finalize_abandoned", meetingId });
    } finally {
      release();
    }
  }

  /** 会議ロックを取って Barrier を再試行する。別タブが録音・確定中の会議には触らない（§23 と同じ） */
  async retryFinalize(meetingId: string): Promise<FinalizeResult> {
    const release = await this.acquireMeetingLock(meetingId);
    if (release === null) return { ok: false, stage: "verify", detail: "meeting is locked by another tab" };
    try {
      return await this.finalize(meetingId);
    } finally {
      release();
    }
  }

  /** 自タブが stop 後も保持しているロックがあれば借り、なければ取りにいく。取れなければ null */
  private async acquireMeetingLock(meetingId: string): Promise<(() => void) | null> {
    if (!this.heldLocks.has(meetingId)) return tryAcquireMeetingLock(this.deps.locks, meetingId);
    if (this.heldLockBusy.has(meetingId)) return null;
    this.heldLockBusy.add(meetingId);
    return () => {
      this.heldLockBusy.delete(meetingId);
      this.releaseHeldLockIfDrained(meetingId);
    };
  }

  /** メモリ待機が空になり、借用中でなければ保持していたロックを解放する */
  private releaseHeldLockIfDrained(meetingId: string): void {
    const release = this.heldLocks.get(meetingId);
    if (release === undefined || this.heldLockBusy.has(meetingId) || this.memoryBacklogCount(meetingId) > 0) return;
    this.heldLocks.delete(meetingId);
    release();
  }

  private createSaver(token: string): LocalSaver {
    return new LocalSaver({ baseUrl: this.deps.baseUrl, token, requestTimeoutMs: PUT_TIMEOUT_MS }, this.deps.fetchImpl ?? fetch, (id) => this.prepareChunkPut(id));
  }

  /**
   * PUT の直前処理。Scheduler と直接送信の両方がここを通る。
   * 登録を待つ間に確定中止された会議には新しい PUT を始めない（開始済みの PUT は完了させる）。
   * 再送しても結果が変わらないので non-retryable で返し、音声は IDB またはメモリ待機に残す。
   */
  private async prepareChunkPut(meetingId: string): Promise<RegistrationOutcome> {
    const registration = await this.registrar.ensure(meetingId);
    if (!registration.ok) return registration;
    const at = (this.deps.now ?? Date.now)();
    const abandoned = { ok: false, retryable: false, error: { kind: "VALIDATION", message: "meeting abandoned", httpStatus: null, at } } as const;
    if (this.abandoned.has(meetingId)) return abandoned;
    let meeting: MeetingRecord | undefined;
    try {
      meeting = await this.meetingStore.get(meetingId);
    } catch (error) {
      // IDB が読めないときこそ直接送信が必要。このタブが会議ロックを持つ間（録音中・メモリ待機の保持中）は
      // 中止できるのもこのタブだけなので、上のこのタブの中止記録で判定済みとして送る
      if (this.session?.meetingId === meetingId || this.heldLocks.has(meetingId)) return registration;
      // ロックがなければ別タブが中止したかもしれない。中止と断定せず、再試行できる失敗で PUT を始めない
      return { ok: false, retryable: true, error: { kind: "UNKNOWN", message: `meeting status read failed: ${error instanceof Error ? error.message : String(error)}`, httpStatus: null, at } };
    }
    return meeting?.status === "abandoned" ? abandoned : registration;
  }

  private async onChunkSaved(meetingId: string): Promise<void> {
    if (this.disposed || this.session?.meetingId === meetingId) return;
    // Barrier が未登録一覧を読んだ直後に保存が終わっても、完了後にもう一度判定する。
    if (this.finalizing.has(meetingId)) {
      this.finalizeRequested.add(meetingId);
      return;
    }
    // 照合不一致による再送は、成功 PUT → 不一致 → 再送のループにしない。
    if (!this.waitingForSave.has(meetingId)) return;
    try {
      const meeting = await this.meetingStore.get(meetingId);
      if (!this.disposed && (meeting?.status === "stop_requested" || meeting?.status === "finalizing")) {
        await this.retryFinalize(meetingId);
      }
    } catch (error) {
      this.deps.onEvent({ type: "error", error });
    }
  }

  private finalize(meetingId: string): Promise<FinalizeResult> {
    const running = this.finalizing.get(meetingId);
    if (running !== undefined) return running;
    const run = async (): Promise<FinalizeResult> => {
      let result: FinalizeResult;
      do {
        this.finalizeRequested.delete(meetingId);
        this.finalizeTokenChanged.delete(meetingId);
        result = await this.finalizeOnce(meetingId);
        if (!result.ok && result.stage === "waiting_local_save") this.waitingForSave.add(meetingId);
        else this.waitingForSave.delete(meetingId);
      } while (!this.disposed && (this.finalizeTokenChanged.has(meetingId) || (this.waitingForSave.has(meetingId) && this.finalizeRequested.has(meetingId))));
      if (result.ok) this.finalizeIssues.delete(meetingId);
      else {
        const previous = this.finalizeIssues.get(meetingId);
        this.finalizeIssues.set(meetingId, result);
        if (previous?.stage !== result.stage || previous.detail !== result.detail) {
          this.deps.onEvent({ type: "finalize_pending", meetingId, result });
        }
      }
      return result;
    };
    const promise = run().finally(() => {
      this.finalizing.delete(meetingId);
      this.finalizeRequested.delete(meetingId);
      this.finalizeTokenChanged.delete(meetingId);
    });
    this.finalizing.set(meetingId, promise);
    return promise;
  }

  private async finalizeOnce(meetingId: string): Promise<FinalizeResult> {
    if (this.token === null) return { ok: false, stage: "waiting_local_save", detail: "backend token is not set" };
    const controller = this.controllers.get(meetingId);
    const token = this.token;
    const result = await finalizeMeeting(
      {
        chunkStore: this.chunkStore,
        meetingStore: this.meetingStore,
        scheduler: this.scheduler,
        baseUrl: this.deps.baseUrl,
        token,
        fetchImpl: this.deps.fetchImpl,
        unpersistedChunkCount: () => controller?.memoryBacklogCount ?? 0,
        ensureMeeting: (id) => this.registrar.ensure(id),
        onBackendUnauthorized: () => {
          if (this.token === token) this.monitor.reportUnauthorized();
          // setToken からの再試行は実行中のロックに阻まれているので、この Barrier が終わったら自分でやり直す
          else this.finalizeTokenChanged.add(meetingId);
        },
      },
      meetingId,
    );
    if (result.ok) {
      this.deps.onEvent(result.missingTailMs === undefined ? { type: "finalized", meetingId } : { type: "finalized", meetingId, missingTailMs: result.missingTailMs });
    }
    return result;
  }

  /**
   * backend が使える状態に戻ったとき（§18 onChange / setToken）。
   * 待機中の Chunk を再投入し、stop_requested / finalizing のまま残った会議の Barrier を再試行する（§22）。
   * 別タブが録音中（会議ロック保持中）の会議には触らない（§23 と同じ）。
   */
  private async onBackendAvailable(): Promise<void> {
    try {
      const recording = await this.meetingStore.listByStatus("recording");
      const lockedElsewhere = new Set<string>();
      for (const m of recording) {
        if (m.meetingId === this.session?.meetingId) continue;
        const release = await tryAcquireMeetingLock(this.deps.locks, m.meetingId);
        if (release === null) lockedElsewhere.add(m.meetingId);
        else release();
      }
      await this.scheduler.resumeAll(lockedElsewhere);
      // stop 後もメモリ待機が残る会議（このタブがロックを保持）は、確定の前に末尾を送る。送れなければロックを持ったまま残す
      for (const [id, drain] of this.drains) {
        if (id !== this.session?.meetingId && this.memoryBacklogCount(id) > 0) await drain(false);
      }

      for (const m of await this.listPendingFinalize()) await this.retryFinalize(m.meetingId);
    } catch (error) {
      this.deps.onEvent({ type: "error", error });
    }
  }
}

function isUsable(state: LocalBackendHealth): boolean {
  return (state.status === "HEALTHY" || state.status === "DEGRADED") && !state.unauthorized;
}
