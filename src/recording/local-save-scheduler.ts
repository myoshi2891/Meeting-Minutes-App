// src/recording/local-save-scheduler.ts
import { isRetryableError, type LocalSaver } from "../api/local-saver";
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
  /** 明示的に確定中止された会議は、再投入時と送信直前に除外する。 */
  readonly isMeetingAbandoned?: (meetingId: string) => Promise<boolean>;
  /** 成功状態を IDB に保存した後の通知。SAVED も Barrier のサーバー照合を再開させる。 */
  readonly onChunkSaved?: (meetingId: string) => void;
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
  /** 送信中の chunkKey → このタブが SAVING を確保したときの attempts。失敗の書き戻しは、この確保が残っているときだけ行う */
  private readonly claims = new Map<string, number>();

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

  /**
   * backend が HEALTHY に戻ったとき、BACKEND_UNAVAILABLE / 上限到達 LOCAL_SAVE_FAILED（retryable のみ）を一括再投入する。
   * skipMeetingIds の会議（別タブで録音中）の Chunk は、そのタブのスケジューラに任せて触らない。
   */
  async resumeAll(skipMeetingIds: ReadonlySet<string> = new Set()): Promise<void> {
    const unfinished = await this.deps.chunkStore.listUnfinished();
    /** 会議ごとの中止判定。null は読み取り失敗で、その会議の Chunk は今回送らず次の resumeAll で読み直す */
    const abandoned = new Map<string, boolean | null>();
    for (const r of unfinished) {
      const meetingId = r.meta.meetingId;
      if (skipMeetingIds.has(meetingId)) continue;
      if (this.deps.isMeetingAbandoned !== undefined && !abandoned.has(meetingId)) {
        abandoned.set(meetingId, await this.deps.isMeetingAbandoned(meetingId).catch(() => null));
      }
      const state = abandoned.get(meetingId);
      if (state === true || state === null) continue;
      if (isResumable(r) && !this.pending.includes(r.chunkKey) && !this.inFlight.has(r.chunkKey)) {
        await this.deps.chunkStore.updateSaveState(r.chunkKey, (x) => {
          // 一覧取得後に別経路で保存が進んでいたら書き戻さない
          if (!isResumable(x)) return;
          x.save.status = "LOCAL_SAVE_PENDING";
          x.save.nextRetryAt = null;
        });
        this.insertSorted(r.chunkKey);
      }
    }
    this.deps.health.pendingChunkCount = this.pendingCount;
    void this.pump();
  }

  /**
   * 確定中止した会議の待機キーを外す。backend の状態に関係なく呼べる。送信中のキーは完了まで待つ（runOne が送信前に中止を確認する）。
   * IDB の Chunk には触らない（音声は残す）。
   */
  discardMeeting(meetingId: string): void {
    const prefix = `${meetingId}:`;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const key = this.pending[i];
      if (!key.startsWith(prefix) || this.inFlight.has(key)) continue;
      this.pending.splice(i, 1);
      this.markedUnavailable.delete(key);
    }
    this.deps.health.pendingChunkCount = this.pendingCount;
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
          .catch((error: unknown) => this.recoverFailedRun(chunkKey, error, this.claims.get(chunkKey)))
          .finally(() => {
            this.claims.delete(chunkKey);
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
    const abandoned = new Map<string, boolean>();
    // 保存済みのキーを pending から外すため、コピーを走査する
    for (const key of [...this.pending]) {
      // 中止後にリトライタイマーが再投入したキーも、backend 停止中の件数に数えない
      const meetingId = key.slice(0, key.indexOf(":"));
      if (this.deps.isMeetingAbandoned !== undefined && !abandoned.has(meetingId)) {
        // 読めなければ中止とみなさない（件数に残すだけで、送信は runOne が送信前に再確認する）
        abandoned.set(meetingId, await this.deps.isMeetingAbandoned(meetingId).catch(() => false));
      }
      if (abandoned.get(meetingId) === true) {
        // 読み取りを待つ間に discardMeeting などで外れていれば何もしない（-1 で末尾を消さない）
        const index = this.pending.indexOf(key);
        if (index !== -1) this.pending.splice(index, 1);
        this.markedUnavailable.delete(key);
        continue;
      }
      if (this.markedUnavailable.has(key)) continue;
      let settled = false;
      await this.deps.chunkStore.updateSaveState(key, (r) => {
        // リトライタイマーが resumeAll 後に遅れて再投入したキーなど、別経路で保存済み・送信中なら書き戻さない
        settled = r.save.status === "DB_REGISTERED" || r.save.status === "SAVED" || r.save.status === "SAVING";
        if (settled) return;
        r.save.status = "BACKEND_UNAVAILABLE";
      });
      if (settled) {
        // 書き込みを待つ間に discardMeeting などで外れていれば何もしない（-1 で末尾を消さない）
        const index = this.pending.indexOf(key);
        if (index !== -1) this.pending.splice(index, 1);
        continue;
      }
      this.markedUnavailable.add(key);
    }
    this.deps.health.pendingChunkCount = this.pendingCount;
    // pending 配列は保持する。resumeAll() または backend 復帰時の pump() で再開する。
  }

  /**
   * runOne が例外（IDB の書き込み失敗など）で終わった Chunk を再開可能な状態に戻す。
   * SAVING のまま残すと runOne が「送信中」とみなして永久に送らないため、RETRYING に戻してバックオフ後に再投入する。
   */
  private async recoverFailedRun(chunkKey: string, error: unknown, claim: number | undefined): Promise<void> {
    const at = this.deps.now();
    // nextRetryAt より前にタイマーが発火すると runOne が再投入だけして空回りするため、遅延は 1 回だけ決める
    let delay = backoffMs(1);
    let exhausted = false;
    try {
      await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
        const attempts = Math.max(r.save.attempts, 1);
        delay = backoffMs(attempts);
        // 例外より前に保存が終わっていた・別経路で状態が進んでいた・このタブが確保した SAVING でない場合は書き戻さない
        if (r.save.status !== "SAVING" || r.save.attempts !== claim) return;
        exhausted = attempts >= MAX_SAVE_ATTEMPTS;
        r.save.status = exhausted ? "LOCAL_SAVE_FAILED" : "RETRYING";
        r.save.lastError = { kind: "UNKNOWN", message: errorMessage(error), httpStatus: null, at };
        r.save.nextRetryAt = exhausted ? null : at + delay;
      });
    } catch (restoreError: unknown) {
      // 状態も書き戻せない（IDB が使えない）。バックオフ後に復旧処理ごとやり直す
      this.deps.setTimer(() => void this.recoverFailedRun(chunkKey, restoreError, claim), delay);
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
    let abandoned: boolean | undefined;
    try {
      abandoned = await this.deps.isMeetingAbandoned?.(record.meta.meetingId);
    } catch {
      // 中止か分からないまま送らない。recoverFailedRun に回すと別タブが送信中の SAVING を書き換えるため、状態に触れず読み直す
      this.deps.setTimer(() => {
        this.insertSorted(chunkKey);
        void this.pump();
      }, backoffMs(1));
      return;
    }
    if (abandoned === true) return;
    // 読み込み・中止判定を待つ間に別タブが送信を始めていることがある。古い record ではなく、
    // 同じトランザクションで現在の状態を確かめてから SAVING を確保する
    const claim: { attempts: number | null; notYet: boolean } = { attempts: null, notYet: false };
    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      // リトライタイマーが遅れて発火した場合など、別経路で保存済み・送信中なら送らない
      // SAVED（ファイル保存済み・DB 未登録）の登録確認は Finalizer のサーバー一覧照合に任せる
      if (r.save.status === "DB_REGISTERED" || r.save.status === "SAVED" || r.save.status === "SAVING") return;
      if (r.save.status === "RETRYING" && r.save.nextRetryAt !== null && r.save.nextRetryAt > this.deps.now()) {
        claim.notYet = true;
        return;
      }
      r.save.status = "SAVING";
      r.save.attempts += 1;
      claim.attempts = r.save.attempts;
    });
    if (claim.notYet) {
      this.insertSorted(chunkKey);
      return;
    }
    const attempts = claim.attempts;
    if (attempts === null) return;
    this.claims.set(chunkKey, attempts);

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
      this.deps.onChunkSaved?.(record.meta.meetingId);
      return;
    }

    const { error, retryable } = outcome;
    if (error.kind === "UNAUTHORIZED") {
      // Monitor が unauthorized を知らないままだと再投入 → 即 401 の連打になる。通知して resumeAll() まで待機させる
      // 会議登録の 401/403 は MeetingRegistrar が報告済み。同じ要求を二重に数えない
      if (outcome.unauthorizedReported !== true) this.deps.onBackendUnauthorized();
      await this.updateClaimed(chunkKey, attempts, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
        r.save.lastError = error;
      });
      return;
    }
    if (error.kind === "NETWORK" || error.kind === "TIMEOUT") {
      // ポーリングを待たず即座に UNREACHABLE 扱いにする（§3.6）。BackendHealthMonitor 側も同じ判定を行う。
      // backend() が HEALTHY のままだと再投入 → 即 pump → 再失敗の連打になるため、先に Monitor へ通知する。
      this.deps.onBackendUnreachable();
      const owned = await this.updateClaimed(chunkKey, attempts, (r) => {
        r.save.status = "BACKEND_UNAVAILABLE";
        r.save.lastError = error;
      });
      if (owned) this.insertSorted(chunkKey);
      return;
    }

    if (outcome.tokenChanged === true) {
      // 送信中にトークンが替わり続けただけでサーバーは拒否していない。上限の回でも LOCAL_SAVE_FAILED に残さず、新しいトークンですぐ送り直す
      // （setToken の resumeAll は送信中のキーを拾えず、ここで止めると次のヘルス状態の変化まで送られない）
      // 確保時に足した試行回数も戻し、トークン変更の回を以後の上限判定に数えない
      const owned = await this.updateClaimed(chunkKey, attempts, (r) => {
        r.save.status = "RETRYING";
        r.save.attempts = Math.max(0, r.save.attempts - 1);
        r.save.lastError = error;
        r.save.nextRetryAt = null;
      });
      if (owned) this.insertSorted(chunkKey);
      return;
    }

    if (retryable && attempts < MAX_SAVE_ATTEMPTS) {
      const delay = backoffMs(attempts);
      const owned = await this.updateClaimed(chunkKey, attempts, (r) => {
        r.save.status = "RETRYING";
        r.save.lastError = error;
        r.save.nextRetryAt = this.deps.now() + delay;
      });
      if (!owned) return;
      this.deps.setTimer(() => {
        this.insertSorted(chunkKey);
        void this.pump();
      }, delay);
      return;
    }

    await this.updateClaimed(chunkKey, attempts, (r) => {
      r.save.status = "LOCAL_SAVE_FAILED";
      r.save.lastError = error;
      r.save.nextRetryAt = null;
    });
  }

  /**
   * 失敗の書き戻し。このタブが確保した SAVING（attempts が確保時の値）のままのときだけ mutate を適用し、適用したかを返す。
   * 送信中に別タブの復旧が書き戻して送り直した・保存を終えた Chunk の状態は上書きしない（再投入もそのタブに任せる）。
   */
  private async updateClaimed(chunkKey: string, attempts: number, mutate: (record: AudioChunkRecord) => void): Promise<boolean> {
    const result = { owned: false };
    await this.deps.chunkStore.updateSaveState(chunkKey, (r) => {
      result.owned = r.save.status === "SAVING" && r.save.attempts === attempts;
      if (result.owned) mutate(r);
    });
    return result.owned;
  }
}

export function isResumable(record: AudioChunkRecord): boolean {
  const { status, lastError } = record.save;
  // non-retryable（VALIDATION / CONFLICT / 408・429 以外の 4xx）は送り直しても結果が変わらないため、手動再試行のみ（§17）
  if (status === "LOCAL_SAVE_FAILED") return lastError === null || isRetryableError(lastError);
  return status === "BACKEND_UNAVAILABLE" || status === "RETRYING" || status === "LOCAL_SAVE_PENDING" || status === "IDB_STORED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTerminal(record: AudioChunkRecord): boolean {
  return record.save.status === "DB_REGISTERED";
}
