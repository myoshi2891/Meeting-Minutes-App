// src/recording/recovery.ts
import type { ChunkStore, MeetingStore } from "../storage/idb";
import { isResumable, type LocalSaveScheduler } from "./local-save-scheduler";
import { tryAcquireMeetingLock, type MeetingLockManager } from "./meeting-lock";
import type { AudioChunkRecord, MeetingRecord } from "../types/recording";

export interface RecoveryReport {
  /** status は復旧前の値。recording と通常停止後の確定待ちを UI で区別する。 */
  readonly interruptedMeetings: ReadonlyArray<{ readonly meetingId: string; readonly status: MeetingRecord["status"]; readonly chunkCount: number }>;
  readonly requeuedChunks: number;
  /** ロック後の読み直しに失敗した会議。状態を確かめられないので触らず（Chunk も再投入しない）、次回の起動・サーバー復帰時の再投入に任せる */
  readonly unreadMeetingIds: ReadonlyArray<string>;
}

/**
 * アプリ起動時に 1 回呼ぶ。
 * - recording / stop_requested / finalizing を復旧前の状態付きで列挙。abandoned は復旧・再送しない
 * - 保存の途中で止まった Chunk（GENERATED / SAVING）を LOCAL_SAVE_PENDING に書き戻し、resumeAll で再投入する（冪等 PUT なので安全）
 *   non-retryable の LOCAL_SAVE_FAILED は resumeAll の判定に任せ、SAVED は Finalizer のサーバー一覧照合に任せる
 * - recording のまま残っていた会議は stop_requested に落とす（音声はもう来ない）
 *   audioFrameCount は stop() でしか永続化されないため、保存済み Chunk の最大 endFrame から復元する
 * - stop_requested でも audioFrameCount が保存済み Chunk の最大 endFrame より小さければ補う（flush 後の最終保存の前に落ちた会議）
 * - 停止理由と検出時刻の片方だけが残った会議は両方を外して書き直す（put が拒否して起動ごと止まらないように）
 * - 会議ロック（§15）が保持中の会議は別タブで録音中なので、会議も Chunk も触らない
 */
export async function recoverOnStartup(
  meetingStore: MeetingStore,
  chunkStore: ChunkStore,
  scheduler: LocalSaveScheduler,
  locks: MeetingLockManager,
): Promise<RecoveryReport> {
  const interrupted: Array<{ meetingId: string; status: MeetingRecord["status"]; chunkCount: number }> = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  const active = new Set((await meetingStore.listByStatus("abandoned")).map((m) => m.meetingId));
  for (const status of ["recording", "stop_requested", "finalizing"] as const) {
    for (const m of await meetingStore.listByStatus(status)) {
      // recording → stop_requested に更新した会議を次の status で二重に拾わない
      if (seen.has(m.meetingId)) continue;
      seen.add(m.meetingId);
      // 復旧中もロックを持ち、録音タブと同時に会議を書き換えない
      const release = await tryAcquireMeetingLock(locks, m.meetingId);
      if (release === null) {
        active.add(m.meetingId);
        continue;
      }
      try {
        // 一覧取得後に別タブが停止・確定・中止した会議を巻き戻さない。Chunk の再送もそのタブに任せる。
        let current: MeetingRecord | undefined;
        try {
          current = await meetingStore.get(m.meetingId);
        } catch {
          // 読めなければ検証済みとして扱わない。録音タブと同じく触らずに残し、起動と他の会議の復旧は続ける
          unread.push(m.meetingId);
          active.add(m.meetingId);
          continue;
        }
        if (current?.status !== status) {
          active.add(m.meetingId);
          continue;
        }
        const originalStatus = current.status;
        const chunks = await chunkStore.listByMeeting(m.meetingId, "mic");
        // Finalizer が totalAudioFrames として送る値。既に大きい値があれば維持する。
        // stop_requested でも、flush 後の最終保存の前に落ちた会議は値が古いので補う（書き直しを持つ App のメモリは再読み込みで失われる）
        // 一覧の m はロック前の値。一覧取得後に停止処理が書いた audioFrameCount などを巻き戻さないよう、ロック後に読み直した current を書く
        const lastEndFrame = chunks.reduce((max, c) => Math.max(max, c.meta.endFrame), 0);
        // 停止理由と検出時刻の片方だけの行（壊れた行など）は put が拒否して起動ごと止まり、サーバーの確定も 422 になる。両方を外して未観測として扱う
        const incompleteStop = (current.stopReason === undefined) !== (current.stopDetectedAtEpochMs === undefined);
        if (incompleteStop) {
          delete current.stopReason;
          delete current.stopDetectedAtEpochMs;
        }
        const needsFrames = current.status === "recording" || (current.status === "stop_requested" && lastEndFrame > current.sessionClock.audioFrameCount);
        if (needsFrames) {
          current.sessionClock.audioFrameCount = Math.max(current.sessionClock.audioFrameCount, lastEndFrame);
          current.status = "stop_requested";
        }
        if (needsFrames || incompleteStop) {
          current.updatedAt = Date.now();
          await meetingStore.put(current);
        }
        interrupted.push({ meetingId: m.meetingId, status: originalStatus, chunkCount: chunks.length });
      } finally {
        release();
      }
    }
  }

  const unfinished = await chunkStore.listUnfinished();
  let requeued = 0;
  for (const c of unfinished) {
    // 録音中のタブが PUT している最中の Chunk。書き戻すと SAVING が PENDING に巻き戻る
    if (active.has(c.meta.meetingId)) continue;
    if (isInterrupted(c)) {
      // SAVING のまま落ちた Chunk はサーバー側に届いているかもしれない。冪等 PUT で再送し、200/201 どちらでも SAVED にする。
      await chunkStore.updateSaveState(c.chunkKey, (r) => {
        if (!isInterrupted(r)) return;
        r.save.status = "LOCAL_SAVE_PENDING";
        r.save.nextRetryAt = null;
      });
    } else if (!isResumable(c)) {
      continue;
    }
    requeued++;
  }
  // 録音中の会議の Chunk は録音タブのスケジューラが送る。ここで再投入すると二重に PUT する
  await scheduler.resumeAll(active);
  return { interruptedMeetings: interrupted, requeuedChunks: requeued, unreadMeetingIds: unread };
}

/** IDB 書き込み直後（GENERATED）や PUT 中（SAVING）に落ちた Chunk。どの経路からも再開されないため復旧で書き戻す。 */
function isInterrupted(record: AudioChunkRecord): boolean {
  return record.save.status === "GENERATED" || record.save.status === "SAVING";
}
