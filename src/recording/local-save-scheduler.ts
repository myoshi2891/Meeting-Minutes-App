// src/recording/local-save-scheduler.ts
import type { LocalSaver } from "../api/local-saver";
import type { ChunkStore } from "../storage/idb";
import type { AudioChunkRecord, LocalBackendHealth, RecordingHealth } from "../types/recording";
import { backoffMs, MAX_SAVE_ATTEMPTS } from "./backoff";

export interface SchedulerDeps {
  readonly chunkStore: ChunkStore;
  readonly saver: () => LocalSaver | null; // 設定未完了なら null
  readonly backend: () => LocalBackendHealth;
  readonly health: RecordingHealth;
  readonly maxConcurrency: number;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  /** PUT が NETWORK / TIMEOUT で失敗したとき呼ぶ。配線先は BackendHealthMonitor.reportUnreachable()（§18） */
  readonly onBackendUnreachable: () => void;
}

export class LocalSaveScheduler {
  /** LOCAL_SAVE_PENDING / RETRYING / BACKEND_UNAVAILABLE の chunkKey。sequenceNo 順を保つため sorted に保持。 */
  private readonly pending: string[] = [];
  private inFlight = 0;
  private pumping = false;
  /** pump 実行中に再度 pump が要求されたら true。実行終了後にもう一度回す。 */
  private pumpRequested = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async enqueue(chunkKey: string): Promise<void> {
    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      r.save.status = "LOCAL_SAVE_PENDING";
    });
    this.insertSorted(chunkKey);
    this.deps.health.pendingChunkCount = this.pending.length + this.inFlight;
    void this.pump();
  }

  /** backend が HEALTHY に戻ったとき、BACKEND_UNAVAILABLE / 上限到達 LOCAL_SAVE_FAILED を一括再投入する。 */
  async resumeAll(): Promise<void> {
    const unfinished = await this.deps.chunkStore.listUnfinished();
    for (const r of unfinished) {
      const s = r.save.status;
      if (s === "BACKEND_UNAVAILABLE" || s === "LOCAL_SAVE_FAILED" || s === "RETRYING" || s === "LOCAL_SAVE_PENDING" || s === "IDB_STORED") {
        if (!this.pending.includes(r.chunkKey)) {
          await this.deps.chunkStore.updateSaveState(r.chunkKey, (x) => {
            x.save.status = "LOCAL_SAVE_PENDING";
            x.save.nextRetryAt = null;
          });
          this.insertSorted(r.chunkKey);
        }
      }
    }
    this.deps.health.pendingChunkCount = this.pending.length + this.inFlight;
    void this.pump();
  }

  get pendingCount(): number {
    return this.pending.length + this.inFlight;
  }

  private insertSorted(chunkKey: string): void {
    // chunkKey は sequenceNo ゼロ埋めなので文字列順 = sequenceNo 順
    let i = 0;
    while (i < this.pending.length && this.pending[i] < chunkKey) i++;
    this.pending.splice(i, 0, chunkKey);
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      // backend 復帰通知や enqueue が pump 中に来た場合、終了後に必ずもう一周する
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    try {
      while (this.inFlight < this.deps.maxConcurrency && this.pending.length > 0) {
        const backend = this.deps.backend();
        const saver = this.deps.saver();
        // DEGRADED（応答は返るが遅い）は HEALTHY と同様に PUT を試みる（§18）
        const available = backend.status === "HEALTHY" || backend.status === "DEGRADED";
        if (!available || backend.unauthorized || saver === null) {
          await this.markAllPendingUnavailable();
          return;
        }
        const chunkKey = this.pending.shift();
        if (chunkKey === undefined) return;
        this.inFlight++;
        void this.runOne(chunkKey, saver).finally(() => {
          this.inFlight--;
          this.deps.health.pendingChunkCount = this.pending.length + this.inFlight;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
      if (this.pumpRequested) {
        this.pumpRequested = false;
        void this.pump();
      }
    }
  }

  private async markAllPendingUnavailable(): Promise<void> {
    for (const key of this.pending) {
      await this.deps.chunkStore.updateSaveState(key, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
      });
    }
    // pending 配列は保持する。resumeAll() または backend 復帰時の pump() で再開する。
  }

  private async runOne(chunkKey: string, saver: LocalSaver): Promise<void> {
    const record = await this.deps.chunkStore.getChunk(chunkKey);
    if (record === undefined) return;
    if (record.save.status === "RETRYING" && record.save.nextRetryAt !== null && record.save.nextRetryAt > this.deps.now()) {
      this.insertSorted(chunkKey);
      return;
    }

    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      r.save.status = "SAVING";
      r.save.attempts += 1;
    });

    const outcome = await saver.put(record);

    if (outcome.ok) {
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        r.save.status = outcome.registered ? "DB_REGISTERED" : "SAVED";
        r.save.savedVia = "api";
        r.save.serverPath = outcome.serverPath;
        r.save.lastError = null;
        r.save.nextRetryAt = null;
      });
      this.deps.health.lastSuccessfulLocalSaveAt = this.deps.now();
      return;
    }

    const { error, retryable } = outcome;
    if (error.kind === "UNAUTHORIZED") {
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
        r.save.lastError = error;
      });
      this.insertSorted(chunkKey);
      return;
    }
    if (error.kind === "NETWORK" || error.kind === "TIMEOUT") {
      // ポーリングを待たず即座に UNREACHABLE 扱いにする（§3.6）。BackendHealthMonitor 側も同じ判定を行う。
      // backend() が HEALTHY のままだと再投入 → 即 pump → 再失敗の連打になるため、先に Monitor へ通知する。
      this.deps.onBackendUnreachable();
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
        r.save.lastError = error;
      });
      this.insertSorted(chunkKey);
      return;
    }

    const attempts = record.save.attempts + 1;
    if (retryable && attempts < MAX_SAVE_ATTEMPTS) {
      const delay = backoffMs(attempts);
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        r.save.status = "RETRYING";
        r.save.lastError = error;
        r.save.nextRetryAt = this.deps.now() + delay;
      });
      this.deps.setTimer(() => {
        this.insertSorted(chunkKey);
        void this.pump();
      }, delay);
      return;
    }

    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      r.save.status = "LOCAL_SAVE_FAILED";
      r.save.lastError = error;
      r.save.nextRetryAt = null;
    });
  }
}

export function isTerminal(record: AudioChunkRecord): boolean {
  return record.save.status === "DB_REGISTERED";
}
