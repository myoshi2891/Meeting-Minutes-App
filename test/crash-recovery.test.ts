// test/crash-recovery.test.ts
import { describe, expect, it } from "vitest";
import { createHarness, makeChunkRecord } from "./harness";
import { recoverOnStartup } from "../src/recording/recovery";
import { tryAcquireMeetingLock } from "../src/recording/meeting-lock";
import type { MeetingRecord } from "../src/types/recording";

describe("ブラウザクラッシュ後の復旧", () => {
  it("recording 中に落ちた会議は stop_requested になり、SAVING で止まった Chunk も再送される", async () => {
    // --- クラッシュ前の状態を IDB に作る ---
    const before = await createHarness();
    const meetingId = "m-crash";
    const meeting: MeetingRecord = {
      meetingId,
      title: "crash",
      status: "recording",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 480000 * 3 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    };
    await before.meetingStore.put(meeting);
    const statuses = ["DB_REGISTERED", "SAVING", "IDB_STORED"] as const;
    for (let seq = 0; seq < 3; seq++) {
      const r = await makeChunkRecord(meetingId, seq);
      r.save.status = statuses[seq];
      await before.chunkStore.putChunk(r);
      if (statuses[seq] === "DB_REGISTERED") {
        // サーバー側にも存在する状態を再現
        const wav = r.wav;
        if (wav === null) throw new Error("wav is null");
        await before.server.fetch(`http://127.0.0.1:43117/v1/meetings/${meetingId}/chunks/mic/${seq}`, {
          method: "PUT",
          headers: { Authorization: "Bearer test-token" },
          body: wav,
        });
      }
    }
    // Scheduler のメモリ状態は失われる（クラッシュ）。IDB と server だけが残る。
    before.db.close();

    // --- 再起動 ---
    const after = await createHarness();
    after.server.stored.clear();
    for (const [k, v] of before.server.stored) after.server.stored.set(k, v);
    const report = await recoverOnStartup(after.meetingStore, after.chunkStore, after.scheduler, after.locks);
    expect(report.interruptedMeetings).toEqual([{ meetingId, status: "stop_requested", chunkCount: 3 }]);
    expect(report.requeuedChunks).toBe(2); // SAVING と IDB_STORED

    for (let i = 0; i < 20; i++) await after.advance(100);
    const chunks = await after.chunkStore.listByMeeting(meetingId, "mic");
    expect(chunks.map((c) => c.save.status)).toEqual(["DB_REGISTERED", "DB_REGISTERED", "DB_REGISTERED"]);
    expect((await after.meetingStore.get(meetingId))?.status).toBe("stop_requested");
  });

  it("recording 中に落ちた会議は、保存済み Chunk の最大 endFrame から audioFrameCount を復元する", async () => {
    // Arrange：audioFrameCount は stop() でしか永続化されないため、録音中のクラッシュでは初期値のまま残る
    const h = await createHarness();
    const meetingId = "m-crash-frames";
    const stale: MeetingRecord = {
      meetingId,
      title: "frames",
      status: "recording",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    };
    await h.meetingStore.put(stale);
    for (let seq = 0; seq < 2; seq++) {
      const r = await makeChunkRecord(meetingId, seq, 1600);
      r.save.status = "DB_REGISTERED";
      await h.chunkStore.putChunk(r);
    }
    // Act
    await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // Assert：seq 1 の endFrame = 480000 + 1600
    expect((await h.meetingStore.get(meetingId))?.sessionClock.audioFrameCount).toBe(481600);
  });

  it("保存済みの audioFrameCount が Chunk の最大 endFrame より大きければ維持する", async () => {
    const h = await createHarness();
    const meetingId = "m-crash-frames-keep";
    await h.meetingStore.put({
      meetingId,
      title: "frames",
      status: "recording",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 999_999 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    });
    const r = await makeChunkRecord(meetingId, 0, 1600);
    r.save.status = "DB_REGISTERED";
    await h.chunkStore.putChunk(r);
    await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    expect((await h.meetingStore.get(meetingId))?.sessionClock.audioFrameCount).toBe(999_999);
  });

  it("finalizing の会議は中断扱いで列挙し、created / finalized は対象外", async () => {
    const h = await createHarness();
    const base = (meetingId: string, status: MeetingRecord["status"]): MeetingRecord => ({
      meetingId,
      title: meetingId,
      status,
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    });
    await h.meetingStore.put(base("r-fin", "finalizing"));
    await h.meetingStore.put(base("r-done", "finalized"));
    await h.meetingStore.put(base("r-new", "created"));
    const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // 同一ファイルの前テストの会議（グローバル IDB を共有）を除外して検証する
    expect(report.interruptedMeetings.map((m) => m.meetingId).filter((id) => id.startsWith("r-"))).toEqual(["r-fin"]);
    expect(report.requeuedChunks).toBe(0);
  });

  it("中断状態（GENERATED / SAVING）だけを書き戻し、non-retryable の LOCAL_SAVE_FAILED と SAVED は再送しない", async () => {
    // Arrange
    const h = await createHarness();
    const meetingId = "m-crash-terminal";
    const statuses = ["LOCAL_SAVE_FAILED", "SAVED", "GENERATED", "SAVING"] as const;
    for (let seq = 0; seq < statuses.length; seq++) {
      const r = await makeChunkRecord(meetingId, seq, 160);
      r.save.status = statuses[seq];
      if (statuses[seq] === "LOCAL_SAVE_FAILED") r.save.lastError = { kind: "VALIDATION", message: "422", httpStatus: 422, at: 0 };
      await h.chunkStore.putChunk(r);
    }
    // Act
    const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    for (let i = 0; i < 20; i++) await h.advance(100);
    // Assert：再投入は GENERATED と SAVING の 2 件だけ
    expect(report.requeuedChunks).toBe(2);
    expect(h.server.putCount).toBe(2);
    const chunks = await h.chunkStore.listByMeeting(meetingId, "mic");
    expect(chunks.map((c) => c.save.status)).toEqual(["LOCAL_SAVE_FAILED", "SAVED", "DB_REGISTERED", "DB_REGISTERED"]);
  });

  it("会議ロックが保持中（別タブで録音中）の会議は stop_requested に変えず、Chunk も書き戻さない", async () => {
    // Arrange：別タブが録音中。会議は recording、PUT 中の Chunk は SAVING
    const h = await createHarness();
    const meetingId = "m-crash-active";
    await h.meetingStore.put({
      meetingId,
      title: "active",
      status: "recording",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    });
    const r = await makeChunkRecord(meetingId, 0, 160);
    r.save.status = "SAVING";
    await h.chunkStore.putChunk(r);
    // 録音タブのスケジューラが backend 停止で待機させている Chunk（resumeAll の再投入対象になる状態）
    const waiting = await makeChunkRecord(meetingId, 1, 160);
    waiting.save.status = "BACKEND_UNAVAILABLE";
    await h.chunkStore.putChunk(waiting);
    const release = await tryAcquireMeetingLock(h.locks, meetingId);
    // Act
    const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    for (let i = 0; i < 5; i++) await h.advance(100);
    // Assert
    const meeting = await h.meetingStore.get(meetingId);
    expect(meeting?.status).toBe("recording");
    expect(meeting?.updatedAt).toBe(1);
    expect(report.interruptedMeetings.map((m) => m.meetingId)).not.toContain(meetingId);
    expect((await h.chunkStore.getChunk(r.chunkKey))?.save.status).toBe("SAVING");
    expect((await h.chunkStore.getChunk(waiting.chunkKey))?.save.status).toBe("BACKEND_UNAVAILABLE");
    expect(h.server.putCount).toBe(0);
    release?.();
  });

  it("会議ロックが解放済み（録音タブが落ちた）なら、従来どおり stop_requested に落とす", async () => {
    // Arrange
    const h = await createHarness();
    const meetingId = "m-crash-released";
    await h.meetingStore.put({
      meetingId,
      title: "released",
      status: "recording",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    });
    const release = await tryAcquireMeetingLock(h.locks, meetingId);
    release?.();
    // Act
    await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // Assert：復旧中に取ったロックも解放されている
    expect((await h.meetingStore.get(meetingId))?.status).toBe("stop_requested");
    expect(h.locks.held.size).toBe(0);
  });
});
