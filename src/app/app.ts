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
  /**
   * 会議ごとのメモリ待機の drain。stop 後に残った末尾を、サーバー復帰時に確定より先に送る。
   * direct：false ならサーバーへの直接送信を試さず、IDB への書き戻しだけ行う（失敗も通知しない）
   */
  private readonly drains = new Map<string, (notify: boolean, direct?: boolean) => Promise<void>>();
  private unsubscribeMonitor: () => void = () => undefined;
  /** Monitor の通知で始めた onBackendAvailable がすべて終わると解決する */
  private backendRecovery: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly finalizing = new Map<string, Promise<FinalizeResult>>();
  private readonly finalizeRequested = new Set<string>();
  /** 実行中の Barrier が古いトークンで 401/403 を受けた会議。ロックを持ったまま現在のトークンでやり直す */
  private readonly finalizeTokenChanged = new Set<string>();
  /** 直接送信で DB 登録まで済んだ件数。IDB に残らないので、確定待ちの件数表示に足す */
  private readonly directRegistered = new Map<string, number>();
  /**
   * 直接送信で DB 登録まで済んだ Chunk の連番 → endFrame。確定待ちの欠番判定・末尾の網羅確認と、確定時の末尾の欠けの計測に使う。
   * directRegistered と合わせて、確定したら消す（確定待ちの間は内訳の表示に使う）
   */
  private readonly directRegisteredEndFrames = new Map<string, Map<number, number>>();
  private readonly waitingForSave = new Set<string>();
  /** サーバー照合の不一致による送り直しの後、保存完了で確認し直す機会を使った会議。確定できたら外す */
  private readonly mismatchRechecked = new Set<string>();
  private readonly finalizeIssues = new Map<string, Extract<FinalizeResult, { ok: false }>>();
  /** このタブで確定中止した会議。IDB が読めなくなっても、中止済みの会議に PUT を始めないために使う */
  private readonly abandoned = new Set<string>();
  /** 停止状態（stop_requested・停止理由）を IDB に書けなかった会議。確定待ちに残し、確定・中止の前に書き直す */
  private readonly unsavedStops = new Map<string, MeetingRecord>();
  /** 停止後もメモリ待機が残る会議のページライフサイクル（離脱確認）。空になったら外す */
  private readonly lifecycles = new Map<string, { readonly detach: () => void }>();

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

  /** サーバー復帰の通知で始めた復旧（再投入・確定の再試行）がここまでに始まった分すべて終わるまで待つ */
  whenBackendRecoverySettled(): Promise<void> {
    return this.backendRecovery;
  }

  async init(): Promise<void> {
    const report = await recoverOnStartup(this.meetingStore, this.chunkStore, this.scheduler, this.deps.locks);
    this.deps.onEvent({ type: "recovered", report });
    if (report.unreadMeetingIds.length > 0) {
      this.deps.onEvent({ type: "error", error: new Error(`起動時の復旧で会議を読めませんでした（${report.unreadMeetingIds.join(", ")}）。再読み込みで再試行します`) });
    }
    this.unsubscribeMonitor = this.monitor.onChange((state) => {
      if (!isUsable(state)) return;
      const run = this.onBackendAvailable().catch((error: unknown) => this.deps.onEvent({ type: "error", error }));
      this.backendRecovery = Promise.all([this.backendRecovery, run]).then(() => undefined);
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
    /** 実行中の drain が直接送信を許すか。サーバーが使えない間の確定再試行は IDB への書き戻しだけ試す */
    let directAllowed = true;
    /** 実行中の drain の直接送信が、送信中のトークン変更で送れなかったか */
    let tokenChangedDuringDrain = false;
    /** 直接送信を試さない drain の実行中に、直接送信する drain（サーバー復帰）が要求されたか */
    let directRequestedDuringDrain = false;
    /** notify：空になったら確定を再開させる。onBackendAvailable は自分で確定するので false で呼ぶ */
    const drain = async (notify = true, direct = true): Promise<void> => {
      if (draining) {
        // サーバー停止中の確定再試行（IDB への書き戻しだけ）がロックを借りている間にサーバーが戻ると、
        // onBackendAvailable の drain も確定もここで弾かれる。終わってから直接送信で送り直す
        if (direct && !directAllowed) directRequestedDuringDrain = true;
        return;
      }
      draining = true;
      directRequestedDuringDrain = false;
      directAllowed = direct;
      tokenChangedDuringDrain = false;
      try {
        await controller.drainMemoryBacklog();
        // 直接送信は Scheduler を通らず onChunkSaved が来ない。空になったら停止後の Barrier を再開させる
        if (controller.memoryBacklogCount === 0) {
          this.releaseHeldLockIfDrained(meetingId);
          this.releaseLifecycleIfSettled(meetingId);
          if (notify) void this.onChunkSaved(meetingId);
        }
      } catch (error) {
        // トークン変更の失敗はすぐ送り直す。直接送信を試さなかった失敗は停止時に通知済み
        if (!tokenChangedDuringDrain && direct) this.deps.onEvent({ type: "memory_backlog_export_required", meetingId, error });
      } finally {
        draining = false;
        directAllowed = true;
      }
      // setToken・サーバー復帰からの drain は実行中の drain に弾かれているので、終わってから現在のトークンで送り直す。
      // draining を戻した直後に同期的に呼ぶので、別の drain と並行しない。空になれば notify に従って確定を再開する
      // （確定再試行の中なら、その再試行が続けて確定する）
      const directRequested = directRequestedDuringDrain;
      directRequestedDuringDrain = false;
      if ((tokenChangedDuringDrain || directRequested) && controller.memoryBacklogCount > 0) await drain(notify, direct || directRequested);
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
      // 別の会議（停止後もメモリ待機が残る）の分。この controller は開始完了まで controllers にないので、同一性で除く
      otherMeetingsBacklogCount: () => [...this.controllers.values()].filter((c) => c !== controller).reduce((sum, c) => sum + c.memoryBacklogCount, 0),
      // 送るたびに現在の saver を引く。録音中に setToken しても、開始時のトークン（未設定・失効）で送り続けない
      directSaver: {
        put: async (record) => {
          const at = (this.deps.now ?? Date.now)();
          // サーバーが使えない間の確定再試行では送らない（IDB への書き戻しだけ試す）
          if (!directAllowed) return { ok: false, retryable: true, error: { kind: "NETWORK", message: "backend unavailable", httpStatus: null, at } };
          const outcome = (await this.saver?.put(record)) ??
            { ok: false, retryable: false, error: { kind: "UNAUTHORIZED", message: "backend token is not set", httpStatus: null, at } };
          if (!outcome.ok && outcome.tokenChanged === true) tokenChangedDuringDrain = true;
          // Scheduler を通らないので、PUT の 401/403 はここで Monitor へ伝える（会議登録の分は MeetingRegistrar が報告済み）
          if (!outcome.ok && outcome.error.kind === "UNAUTHORIZED" && outcome.unauthorizedReported !== true &&
            (outcome.error.httpStatus === 401 || outcome.error.httpStatus === 403)) {
            this.monitor.reportUnauthorized();
          }
          if (outcome.ok && outcome.registered) {
            this.directRegistered.set(meetingId, this.directRegisteredCount(meetingId) + 1);
            const endFrames = this.directRegisteredEndFrames.get(meetingId) ?? new Map<number, number>();
            this.directRegisteredEndFrames.set(meetingId, endFrames.set(record.meta.sequenceNo, record.meta.endFrame));
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
    // 停止後もメモリ待機が残る間は、タブを閉じると音声が失われるので離脱確認を続ける（pagehide の flush は停止後は何もしない）。
    // 停止状態を書けていない間も、閉じると停止理由と最終の音声フレーム数が失われるので続ける
    const lifecycle = attachPageLifecycle(controller, () => recording || controller.memoryBacklogCount > 0 || this.unsavedStops.has(meetingId), input.onHidden ?? (() => undefined));
    let stopping: Promise<FinalizeResult> | undefined;
    const stopOnce = async (reason: RecordingStopReason, detectedAtEpochMs: number): Promise<FinalizeResult> => {
      try {
        await controller.stop(reason, detectedAtEpochMs);
      } catch (error) {
        // 停止状態を IDB に書けなかった。録音は止まっているので、会議を確定待ちに残して確定の前に書き直す
        const meeting = this.meetingFallbacks.get(meetingId);
        if (meeting === undefined) throw error;
        const firstStop = meeting.stopReason === undefined ? { stopReason: reason, stopDetectedAtEpochMs: detectedAtEpochMs } : {};
        this.unsavedStops.set(meetingId, { ...meeting, ...firstStop, status: "stop_requested", updatedAt: (this.deps.now ?? Date.now)() });
        this.deps.onEvent({ type: "error", error });
      } finally {
        recording = false;
        const held = controller.takeMeetingLock();
        if (held !== null) this.heldLocks.set(meetingId, held);
        if (controller.memoryBacklogCount > 0 || this.unsavedStops.has(meetingId)) this.lifecycles.set(meetingId, lifecycle);
        else lifecycle.detach();
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
    // 会議 ID で 1 行にまとめる。2 つの取得の間に stop_requested → finalizing へ進んだ会議は両方に載るので、後の取得を残す
    const listed = new Map<string, MeetingRecord>();
    // 片方の取得に失敗しても、読めたほうは返す
    for (const status of ["stop_requested", "finalizing"] as const) {
      try {
        for (const m of await this.meetingStore.listByStatus(status)) listed.set(m.meetingId, m);
      } catch (error) {
        // IDB が読めないときこそ、停止状態を書けずにメモリで保持している会議の再試行を出す必要がある
        this.deps.onEvent({ type: "error", error });
      }
    }
    // IDB にはまだ recording のまま残っている会議も、停止済みとして並べる
    const unsaved = [...this.unsavedStops.values()].filter((m) => !listed.has(m.meetingId));
    return [...listed.values(), ...unsaved];
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
    return Math.max(0, ...(this.directRegisteredEndFrames.get(meetingId)?.values() ?? []), ...memory);
  }

  /** IDB に残らない Chunk（このタブの直接送信・メモリ待機）の連番。再読み込みで失われる */
  offIdbSequenceNos(meetingId: string): number[] {
    const memory = this.exportMemoryBacklog(meetingId).map((f) => f.meta.sequenceNo);
    return [...new Set([...(this.directRegisteredEndFrames.get(meetingId)?.keys() ?? []), ...memory])];
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
      const unsaved = await this.saveUnsavedStop(meetingId);
      if (unsaved !== null) throw new Error(`停止状態を保存できていないため中止できません（${unsaved.detail}）`);
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
      this.mismatchRechecked.delete(meetingId);
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
      // メモリ待機が残る会議は、Barrier の前に末尾を IDB へ書き戻すか直接送信する（残れば Barrier が waiting_local_save を返す）。
      // 停止状態を書けていなくても音声は先に送る（IDB が書けないときこそメモリ待機しか残っていない）。確定は下で止める。
      // サーバーが使えない間も IDB への書き戻しは試す。直接送信は試さず、停止時の memory_backlog_export_required も重ねて通知しない
      const drain = this.drains.get(meetingId);
      if (drain !== undefined && this.session?.meetingId !== meetingId && this.memoryBacklogCount(meetingId) > 0) {
        await drain(false, isUsable(this.monitor.state));
      }
      const unsaved = await this.saveUnsavedStop(meetingId);
      if (unsaved !== null) {
        // 確定の失敗と同じく、確定待ちの行に理由を出す
        this.recordFinalizeIssue(meetingId, unsaved);
        return unsaved;
      }
      return await this.finalize(meetingId);
    } finally {
      release();
    }
  }

  /**
   * 停止時に書けなかった停止状態を書き直す。会議ロックを持って呼ぶ。書けたか、書く必要がなければ null。
   * recording なら丸ごと書く。stop_requested（最初の保存だけ成功し、flush 後の最終保存に失敗）なら、
   * Controller が持つ最終の音声フレーム数と未記録の停止理由だけを載せる（他タブの確定 POST の失敗で残った値は保つ）。
   * ロックは stop 後に一度手放しているので、別タブが先に進めた会議（finalizing・finalized・abandoned）は上書きしない。
   */
  private async saveUnsavedStop(meetingId: string): Promise<Extract<FinalizeResult, { ok: false }> | null> {
    const pending = this.unsavedStops.get(meetingId);
    if (pending === undefined) return null;
    try {
      const current = await this.meetingStore.get(meetingId);
      if (current === undefined || current.status === "recording") await this.meetingStore.put(pending);
      else if (current.status === "stop_requested") {
        const firstStop = current.stopReason === undefined ? { stopReason: pending.stopReason, stopDetectedAtEpochMs: pending.stopDetectedAtEpochMs } : {};
        await this.meetingStore.put({ ...current, ...firstStop, sessionClock: { ...pending.sessionClock }, updatedAt: pending.updatedAt });
      }
      this.unsavedStops.delete(meetingId);
      this.releaseLifecycleIfSettled(meetingId);
      return null;
    } catch (error) {
      return { ok: false, stage: "verify", detail: `stop state not saved: ${error instanceof Error ? error.message : String(error)}` };
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

  /** メモリ待機が空になり、停止状態も書き直せていて、借用中でなければ保持していたロックを解放する */
  private releaseHeldLockIfDrained(meetingId: string): void {
    const release = this.heldLocks.get(meetingId);
    if (release === undefined || this.heldLockBusy.has(meetingId) || this.memoryBacklogCount(meetingId) > 0 || this.unsavedStops.has(meetingId)) return;
    this.heldLocks.delete(meetingId);
    release();
  }

  /** メモリ待機が空になり、停止状態も書き直せていれば、停止後に残した離脱確認を外す */
  private releaseLifecycleIfSettled(meetingId: string): void {
    if (this.memoryBacklogCount(meetingId) > 0 || this.unsavedStops.has(meetingId)) return;
    this.lifecycles.get(meetingId)?.detach();
    this.lifecycles.delete(meetingId);
  }

  /** 確定できなかった理由を記録し、前回と変わったときだけ finalize_pending を通知する */
  private recordFinalizeIssue(meetingId: string, result: Extract<FinalizeResult, { ok: false }>): void {
    const previous = this.finalizeIssues.get(meetingId);
    this.finalizeIssues.set(meetingId, result);
    if (previous?.stage !== result.stage || previous.detail !== result.detail) {
      this.deps.onEvent({ type: "finalize_pending", meetingId, result });
    }
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
      // 読み取りを待つ間にこのタブで中止されたかもしれない。ロック保持中の送信可否より先に確かめる
      if (this.abandoned.has(meetingId)) return abandoned;
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
    // 照合不一致による再送は 1 回だけ確認し直し（finalize の mismatchRechecked）、成功 PUT → 不一致 → 再送のループにしない。
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
        // 照合不一致で送り直した Chunk の保存完了で 1 回だけ確認し直す。再び不一致なら待たず、送信ループにしない
        else if (!result.ok && result.detail.startsWith("server mismatch") && !this.mismatchRechecked.has(meetingId)) {
          this.mismatchRechecked.add(meetingId);
          this.waitingForSave.add(meetingId);
        } else this.waitingForSave.delete(meetingId);
      } while (!this.disposed && (this.finalizeTokenChanged.has(meetingId) || (this.waitingForSave.has(meetingId) && this.finalizeRequested.has(meetingId))));
      if (result.ok) {
        this.finalizeIssues.delete(meetingId);
        this.mismatchRechecked.delete(meetingId);
        // 確定待ちの内訳と末尾の欠けの計測（finalizeOnce 内で済み）にしか使わないので、確定したら消す
        this.directRegistered.delete(meetingId);
        this.directRegisteredEndFrames.delete(meetingId);
      } else this.recordFinalizeIssue(meetingId, result);
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
    if (this.token === null) return { ok: false, stage: "waiting_local_save", detail: "backend token is not set", reason: "unauthorized" };
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
        offIdbEndFrame: (sequenceNo) => this.directRegisteredEndFrames.get(meetingId)?.get(sequenceNo),
        ensureMeeting: async (id) => {
          const registration = await this.registrar.ensure(id);
          // 登録の途中でトークンが変わった失敗は、この Barrier が終わったら現在のトークンでやり直す（onBackendUnauthorized と同じ）
          if (!registration.ok && this.token !== token) this.finalizeTokenChanged.add(meetingId);
          return registration;
        },
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
    // stop 後もメモリ待機が残る会議（このタブがロックを保持）は、確定の前に末尾を送る。送れなければロックを持ったまま残す。
    // 直接送信は IDB を使わないので、IDB の一覧取得・再投入より先に行い、IDB の障害で止めない（drain は自分で失敗を通知する）
    // 確定中止した会議は送らない（送信は prepareChunkPut が拒否するので、書き出し用にメモリ待機へ残す）
    for (const [id, drain] of this.drains) {
      if (id !== this.session?.meetingId && !this.abandoned.has(id) && this.memoryBacklogCount(id) > 0) await drain(false);
    }
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
      for (const m of await this.listPendingFinalize()) await this.retryFinalize(m.meetingId);
    } catch (error) {
      this.deps.onEvent({ type: "error", error });
    }
  }
}

function isUsable(state: LocalBackendHealth): boolean {
  return (state.status === "HEALTHY" || state.status === "DEGRADED") && !state.unauthorized;
}
