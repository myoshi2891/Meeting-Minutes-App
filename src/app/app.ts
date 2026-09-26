// src/app/app.ts
import { BackendHealthMonitor } from "../api/backend-health-monitor";
import { LocalSaver } from "../api/local-saver";
import { finalizeMeeting, type FinalizeResult } from "../recording/finalizer";
import { LocalSaveScheduler } from "../recording/local-save-scheduler";
import { tryAcquireMeetingLock, type MeetingLockManager } from "../recording/meeting-lock";
import { attachPageLifecycle } from "../recording/page-lifecycle";
import { RecordingController, type ChunkEnqueuer, type RecordingControllerDeps } from "../recording/recording-controller";
import { createInitialHealth } from "../recording/recording-health-monitor";
import { recoverOnStartup, type RecoveryReport } from "../recording/recovery";
import { ChunkStore, MeetingStore, SettingsStore } from "../storage/idb";
import { enforceQuota, requestPersistence } from "../storage/quota-monitor";
import type { LocalBackendHealth, RecordingHealth } from "../types/recording";

/** settings ストアでトークンを保存するキー（§4.3） */
export const BACKEND_TOKEN_KEY = "backendToken";

/** UI への通知。UI はこれを表示するだけで、部品を直接呼ばない */
export type AppEvent =
  | { readonly type: "recovered"; readonly report: RecoveryReport }
  /** missingTailMs：末尾が欠けたまま確定した長さ（§22）。UI は「末尾 約◯秒が保存されていません」と警告する */
  | { readonly type: "finalized"; readonly meetingId: string; readonly missingTailMs?: number }
  /** §3.4 段階2：IDB 使用率 95% 以上で削除できる Blob がない。UI はエクスポートを促す */
  | { readonly type: "export_required"; readonly meetingId: string }
  /** IDB にもサーバーにも保存できない Chunk がメモリ待機に残っている。UI は exportMemoryBacklog() の書き出しを促す（§15） */
  | { readonly type: "memory_backlog_export_required"; readonly meetingId: string; readonly error: unknown }
  | { readonly type: "error"; readonly error: unknown };

/** 録音セッションが使う RecordingController の口。テストでは Fake を差し込む */
export type SessionController = Pick<RecordingController, "start" | "stop" | "flush" | "drainMemoryBacklog" | "exportMemoryBacklog" | "memoryBacklogCount">;

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
  private session: RecordingSession | null = null;
  /** このタブで録音した会議の controller。stop 後もメモリ待機が残りうるため、Barrier の unpersistedChunkCount に使う（§22） */
  private readonly controllers = new Map<string, SessionController>();
  private unsubscribeMonitor: () => void = () => undefined;

  constructor(
    private readonly deps: AppDeps,
    private token: string | null,
  ) {
    this.chunkStore = new ChunkStore(deps.db);
    this.meetingStore = new MeetingStore(deps.db);
    this.settings = new SettingsStore(deps.db);
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
    this.unsubscribeMonitor();
    this.monitor.stop();
  }

  /** 設定画面からトークンを保存する（§4.3）。ヘルス状態が変わらなくても、待機中の Chunk をすぐ送り直す */
  async setToken(token: string): Promise<void> {
    if (token === "") throw new Error("token is empty");
    await this.settings.set(BACKEND_TOKEN_KEY, token);
    this.token = token;
    this.saver = this.createSaver(token);
    const state = await this.monitor.checkOnce();
    if (isUsable(state)) await this.onBackendAvailable();
  }

  async startRecording(input: StartRecordingInput): Promise<RecordingSession> {
    if (this.session !== null) throw new Error("already recording");
    const { meetingId } = input;
    // 永続化は録音開始のついでに要求する。拒否・失敗しても録音は止めない（§3.4）
    await requestPersistence(this.health).catch((error: unknown) => this.deps.onEvent({ type: "error", error }));

    let quotaCheck: Promise<void> = Promise.resolve();
    let draining = false;
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        await controller.drainMemoryBacklog();
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
      // 送るたびに現在の saver を引く。録音中に setToken しても、開始時のトークン（未設定・失効）で送り続けない
      directSaver: {
        put: async (record) =>
          this.saver?.put(record) ??
          { ok: false, retryable: false, error: { kind: "UNAUTHORIZED", message: "backend token is not set", httpStatus: null, at: (this.deps.now ?? Date.now)() } },
      },
    });

    await controller.start(meetingId, input.title, input.consentConfirmedAt);
    this.controllers.set(meetingId, controller);
    let recording = true;
    const lifecycle = attachPageLifecycle(controller, () => recording, input.onHidden ?? (() => undefined));
    const session: RecordingSession = {
      meetingId,
      controller,
      stop: async () => {
        try {
          await controller.stop();
        } finally {
          recording = false;
          lifecycle.detach();
          this.session = null;
        }
        // stop() 完了後にだけ Barrier を試みる（§22 の呼び出し規約）
        return this.finalize(meetingId);
      },
    };
    this.session = session;
    return session;
  }

  private createSaver(token: string): LocalSaver {
    return new LocalSaver({ baseUrl: this.deps.baseUrl, token, requestTimeoutMs: PUT_TIMEOUT_MS }, this.deps.fetchImpl ?? fetch);
  }

  private async finalize(meetingId: string): Promise<FinalizeResult> {
    if (this.token === null) return { ok: false, stage: "waiting_local_save", detail: "backend token is not set" };
    const controller = this.controllers.get(meetingId);
    const result = await finalizeMeeting(
      {
        chunkStore: this.chunkStore,
        meetingStore: this.meetingStore,
        scheduler: this.scheduler,
        baseUrl: this.deps.baseUrl,
        token: this.token,
        fetchImpl: this.deps.fetchImpl,
        unpersistedChunkCount: () => controller?.memoryBacklogCount ?? 0,
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

      for (const status of ["stop_requested", "finalizing"] as const) {
        for (const m of await this.meetingStore.listByStatus(status)) {
          const release = await tryAcquireMeetingLock(this.deps.locks, m.meetingId);
          if (release === null) continue;
          try {
            await this.finalize(m.meetingId);
          } finally {
            release();
          }
        }
      }
    } catch (error) {
      this.deps.onEvent({ type: "error", error });
    }
  }
}

function isUsable(state: LocalBackendHealth): boolean {
  return (state.status === "HEALTHY" || state.status === "DEGRADED") && !state.unauthorized;
}
