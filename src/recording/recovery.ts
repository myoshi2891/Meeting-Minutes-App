// src/recording/recovery.ts
import type { ChunkStore, MeetingStore } from "../storage/idb";
import { isResumable, type LocalSaveScheduler } from "./local-save-scheduler";
import { tryAcquireMeetingLock, type MeetingLockManager } from "./meeting-lock";
import type { AudioChunkRecord, MeetingRecord } from "../types/recording";

export interface RecoveryReport {
  readonly interruptedMeetings: ReadonlyArray<{ readonly meetingId: string; readonly status: MeetingRecord["status"]; readonly chunkCount: number }>;
  readonly requeuedChunks: number;
}

/**
 * アプリ起動時に 1 回呼ぶ。
 * - status が recording / stop_requested / finalizing の会議を「中断された会議」として列挙
 * - 保存の途中で止まった Chunk（GENERATED / SAVING）を LOCAL_SAVE_PENDING に書き戻し、resumeAll で再投入する（冪等 PUT なので安全）
 *   non-retryable の LOCAL_SAVE_FAILED は resumeAll の判定に任せ、SAVED は Finalizer のサーバー一覧照合に任せる
 * - recording のまま残っていた会議は stop_requested に落とす（音声はもう来ない）
 *   audioFrameCount は stop() でしか永続化されないため、保存済み Chunk の最大 endFrame から復元する
 * - 会議ロック（§15）が保持中の会議は別タブで録音中なので、会議も Chunk も触らない
 */
export async function recoverOnStartup(
  meetingStore: MeetingStore,
  chunkStore: ChunkStore,
  scheduler: LocalSaveScheduler,
  locks: MeetingLockManager,
): Promise<RecoveryReport> {
  const interrupted: Array<{ meetingId: string; status: MeetingRecord["status"]; chunkCount: number }> = [];
  const seen = new Set<string>();
  const active = new Set<string>();
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
        const chunks = await chunkStore.listByMeeting(m.meetingId, "mic");
        if (m.status === "recording") {
          // Finalizer が totalAudioFrames として送る値。既に大きい値があれば維持する
          const lastEndFrame = chunks.reduce((max, c) => Math.max(max, c.meta.endFrame), 0);
          m.sessionClock.audioFrameCount = Math.max(m.sessionClock.audioFrameCount, lastEndFrame);
          m.status = "stop_requested";
          m.updatedAt = Date.now();
          await meetingStore.put(m);
        }
        interrupted.push({ meetingId: m.meetingId, status: m.status, chunkCount: chunks.length });
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
  await scheduler.resumeAll();
  return { interruptedMeetings: interrupted, requeuedChunks: requeued };
}

/** IDB 書き込み直後（GENERATED）や PUT 中（SAVING）に落ちた Chunk。どの経路からも再開されないため復旧で書き戻す。 */
function isInterrupted(record: AudioChunkRecord): boolean {
  return record.save.status === "GENERATED" || record.save.status === "SAVING";
}
