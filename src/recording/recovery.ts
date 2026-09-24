// src/recording/recovery.ts
import type { ChunkStore, MeetingStore } from "../storage/idb";
import type { LocalSaveScheduler } from "./local-save-scheduler";
import type { MeetingRecord } from "../types/recording";

export interface RecoveryReport {
  readonly interruptedMeetings: ReadonlyArray<{ readonly meetingId: string; readonly status: MeetingRecord["status"]; readonly chunkCount: number }>;
  readonly requeuedChunks: number;
}

/**
 * アプリ起動時に 1 回呼ぶ。
 * - status が recording / stop_requested / finalizing の会議を「中断された会議」として列挙
 * - DB_REGISTERED 以外の Chunk を Scheduler に再投入（SAVING で止まっていたものも含む。冪等 PUT なので安全）
 * - recording のまま残っていた会議は stop_requested に落とす（音声はもう来ない）
 */
export async function recoverOnStartup(meetingStore: MeetingStore, chunkStore: ChunkStore, scheduler: LocalSaveScheduler): Promise<RecoveryReport> {
  const interrupted: Array<{ meetingId: string; status: MeetingRecord["status"]; chunkCount: number }> = [];
  const seen = new Set<string>();
  for (const status of ["recording", "stop_requested", "finalizing"] as const) {
    for (const m of await meetingStore.listByStatus(status)) {
      // recording → stop_requested に更新した会議を次の status で二重に拾わない
      if (seen.has(m.meetingId)) continue;
      seen.add(m.meetingId);
      const chunks = await chunkStore.listByMeeting(m.meetingId, "mic");
      if (m.status === "recording") {
        m.status = "stop_requested";
        m.updatedAt = Date.now();
        await meetingStore.put(m);
      }
      interrupted.push({ meetingId: m.meetingId, status: m.status, chunkCount: chunks.length });
    }
  }

  const unfinished = await chunkStore.listUnfinished();
  for (const c of unfinished) {
    // SAVING のまま落ちた Chunk はサーバー側に届いているかもしれない。冪等 PUT で再送し、200/201 どちらでも SAVED にする。
    await chunkStore.updateSaveState(c.chunkKey, (r) => {
      r.save.status = "LOCAL_SAVE_PENDING";
      r.save.nextRetryAt = null;
    });
  }
  await scheduler.resumeAll();
  return { interruptedMeetings: interrupted, requeuedChunks: unfinished.length };
}
