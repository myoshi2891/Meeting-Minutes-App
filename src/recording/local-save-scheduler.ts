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
  /** PUT が 401/403 で失敗したとき呼ぶ。配線先は BackendHealthMonitor.reportUnauthorized()（§18） */
  readonly onBackendUnauthorized: () => void;
}

export class LocalSaveScheduler {
  /** LOCAL_SAVE_PENDING / RETRYING / BACKEND_UNAVAILABLE の chunkKey。sequenceNo 順を保つため sorted に保持。 */
  private readonly pending: string[] = [];
  /** PUT 実行中の chunkKey。同じ Chunk を並行して二重送信しないために使う。 */
  private readonly inFlight = new Set<string>();
  private pumping = false;
  /** pump 実行中に再度 pump が要求されたら true。実行終了後にもう一度回す。 */
  private pumpRequested = false;
  /** BACKEND_UNAVAILABLE を書き込み済みの pending キー。backend 停止中の enqueue ごとに全件を書き直さないために使う。 */
  private readonly markedUnavailable = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  async enqueue(chunkKey: string): Promise<void> {
    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      r.save.status = "LOCAL_SAVE_PENDING";
    });
    // 状態を LOCAL_SAVE_PENDING に書き戻したので、停止中なら再度 BACKEND_UNAVAILABLE を書く必要がある
    this.markedUnavailable.delete(chunkKey);
    this.insertSorted(chunkKey);
    this.deps.health.pendingChunkCount = this.pendingCount;
    void this.pump();
  }

  /** backend が HEALTHY に戻ったとき、BACKEND_UNAVAILABLE / 上限到達 LOCAL_SAVE_FAILED を一括再投入する。 */
  async resumeAll(): Promise<void> {
    const unfinished = await this.deps.chunkStore.listUnfinished();
    for (const r of unfinished) {
      const s = r.save.status;
      if (isResumable(s) && !this.pending.includes(r.chunkKey) && !this.inFlight.has(r.chunkKey)) {
        await this.deps.chunkStore.updateSaveState(r.chunkKey, (x) => {
          // 一覧取得後に別経路で保存が進んでいたら書き戻さない
          if (!isResumable(x.save.status)) return;
          x.save.status = "LOCAL_SAVE_PENDING";
          x.save.nextRetryAt = null;
        });
        this.insertSorted(r.chunkKey);
      }
    }
    this.deps.health.pendingChunkCount = this.pendingCount;
    void this.pump();
  }

  get pendingCount(): number {
    // runOne 中の再投入で pending と inFlight の両方に同じキーが一時的に載りうるため、重複を数えない
    return this.pending.filter((k) => !this.inFlight.has(k)).length + this.inFlight.size;
  }

  private insertSorted(chunkKey: string): void {
    // 同じ Chunk の二重投入（enqueue / resumeAll / リトライタイマーの競合）を排除する
    if (this.pending.includes(chunkKey)) return;
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
      while (this.inFlight.size < this.deps.maxConcurrency && this.pending.length > 0) {
        const backend = this.deps.backend();
        const saver = this.deps.saver();
        // DEGRADED（応答は返るが遅い）は HEALTHY と同様に PUT を試みる（§18）
        const available = backend.status === "HEALTHY" || backend.status === "DEGRADED";
        if (!available || backend.unauthorized || saver === null) {
          await this.markAllPendingUnavailable();
          return;
        }
        // 実行中の Chunk は完了後の pump で拾う（runOne 自身が再投入したキーもここで待たせる）
        const index = this.pending.findIndex((k) => !this.inFlight.has(k));
        if (index === -1) return;
        const [chunkKey] = this.pending.splice(index, 1);
        this.markedUnavailable.delete(chunkKey);
        this.inFlight.add(chunkKey);
        void this.runOne(chunkKey, saver)
          .catch((error: unknown) => this.recoverFailedRun(chunkKey, error))
          .finally(() => {
            this.inFlight.delete(chunkKey);
            this.deps.health.pendingChunkCount = this.pendingCount;
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
      if (this.markedUnavailable.has(key)) continue;
      this.markedUnavailable.add(key);
      await this.deps.chunkStore.updateSaveState(key, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
      });
    }
    // pending 配列は保持する。resumeAll() または backend 復帰時の pump() で再開する。
  }

  /**
   * runOne が例外（IDB の書き込み失敗など）で終わった Chunk を再開可能な状態に戻す。
   * SAVING のまま残すと runOne が「送信中」とみなして永久に送らないため、RETRYING に戻してバックオフ後に再投入する。
   */
  private async recoverFailedRun(chunkKey: string, error: unknown): Promise<void> {
    const at = this.deps.now();
    // nextRetryAt より前にタイマーが発火すると runOne が再投入だけして空回りするため、遅延は 1 回だけ決める
    let delay = backoffMs(1);
    let exhausted = false;
    try {
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        const attempts = Math.max(r.save.attempts, 1);
        delay = backoffMs(attempts);
        // 例外より前に保存が終わっていた・別経路で状態が進んでいた場合は書き戻さない
        if (r.save.status !== "SAVING") return;
        exhausted = attempts >= MAX_SAVE_ATTEMPTS;
        r.save.status = exhausted ? "LOCAL_SAVE_FAILED" : "RETRYING";
        r.save.lastError = { kind: "UNKNOWN", message: errorMessage(error), httpStatus: null, at };
        r.save.nextRetryAt = exhausted ? null : at + delay;
      });
    } catch (restoreError: unknown) {
      // 状態も書き戻せない（IDB が使えない）。バックオフ後に復旧処理ごとやり直す
      this.deps.setTimer(() => void this.recoverFailedRun(chunkKey, restoreError), delay);
      return;
    }
    if (exhausted) return;
    this.deps.setTimer(() => {
      this.insertSorted(chunkKey);
      void this.pump();
    }, delay);
  }

  private async runOne(chunkKey: string, saver: LocalSaver): Promise<void> {
    const record = await this.deps.chunkStore.getChunk(chunkKey);
    if (record === undefined) return;
    // リトライタイマーが遅れて発火した場合など、別経路で保存済み・送信中なら送らない
    if (record.save.status === "DB_REGISTERED" || record.save.status === "SAVING") return;
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
      // Monitor が unauthorized を知らないままだと再投入 → 即 401 の連打になる。通知して resumeAll() まで待機させる
      this.deps.onBackendUnauthorized();
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
        r.save.lastError = error;
      });
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

function isResumable(status: AudioChunkRecord["save"]["status"]): boolean {
  return status === "BACKEND_UNAVAILABLE" || status === "LOCAL_SAVE_FAILED" || status === "RETRYING" || status === "LOCAL_SAVE_PENDING" || status === "IDB_STORED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTerminal(record: AudioChunkRecord): boolean {
  return record.save.status === "DB_REGISTERED";
}
