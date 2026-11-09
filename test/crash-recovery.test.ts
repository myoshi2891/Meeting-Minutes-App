// test/crash-recovery.test.ts
import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createHarness, makeChunkRecord, type Harness } from "./harness";
import { recoverOnStartup } from "../src/recording/recovery";
import { tryAcquireMeetingLock } from "../src/recording/meeting-lock";
import type { MeetingRecord } from "../src/types/recording";

function meetingOf(meetingId: string, status: MeetingRecord["status"]): MeetingRecord {
  return {
    meetingId,
    title: meetingId,
    status,
    sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
    consentConfirmedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    finalChunkCount: null,
  };
}

/** listedStatus の一覧を返した直後（ロック取得の前）に、別タブが会議を next へ進めた状態を作る */
function changeStatusAfterListing(h: Harness, listedStatus: MeetingRecord["status"], meetingId: string, next: MeetingRecord["status"]): void {
  const list = h.meetingStore.listByStatus.bind(h.meetingStore);
  vi.spyOn(h.meetingStore, "listByStatus").mockImplementation(async (status) => {
    const meetings = await list(status);
    if (status === listedStatus) await h.meetingStore.put(meetingOf(meetingId, next));
    return meetings;
  });
}

async function seedUnfinishedChunks(h: Harness, meetingId: string): Promise<{ saving: string; waiting: string }> {
  const saving = await makeChunkRecord(meetingId, 0, 160);
  saving.save.status = "SAVING";
  await h.chunkStore.putChunk(saving);
  const waiting = await makeChunkRecord(meetingId, 1, 160);
  waiting.save.status = "BACKEND_UNAVAILABLE";
  await h.chunkStore.putChunk(waiting);
  return { saving: saving.chunkKey, waiting: waiting.chunkKey };
}

describe("ブラウザクラッシュ後の復旧", () => {
  it("復旧は保存済みの停止理由を保持し、未記録の中断理由を推測しない", async () => {
    // Arrange
    vi.stubGlobal("indexedDB", new IDBFactory());
    try {
      const h = await createHarness();
      await h.meetingStore.put({ ...meetingOf("stop-recovery-known", "stop_requested"), stopReason: "mic_ended", stopDetectedAtEpochMs: 123456 });
      await h.meetingStore.put(meetingOf("stop-recovery-unknown", "recording"));
      // Act
      await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
      // Assert
      expect(await h.meetingStore.get("stop-recovery-known")).toMatchObject({ stopReason: "mic_ended", stopDetectedAtEpochMs: 123456 });
      const unknown = await h.meetingStore.get("stop-recovery-unknown");
      expect(unknown?.status).toBe("stop_requested");
      expect(unknown?.stopReason).toBeUndefined();
      expect(unknown?.stopDetectedAtEpochMs).toBeUndefined();
      h.db.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
    expect(report.interruptedMeetings).toEqual([{ meetingId, status: "recording", chunkCount: 3 }]);
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

  it.each([
    ["stop_requested の最終保存に失敗して落ちた会議は、保存済み Chunk の最大 endFrame まで audioFrameCount を補う", 0, 481600],
    ["stop_requested の会議でも、保存済みの audioFrameCount が大きければ維持する", 999_999, 999_999],
  ])("%s", async (_name, stored, expected) => {
    // Arrange：stop() の最初の保存（stop_requested）だけ成功し、flush 後の最終保存の前に落ちた
    const h = await createHarness();
    const meetingId = `m-crash-stop-frames-${stored}`;
    await h.meetingStore.put({
      meetingId,
      title: "frames",
      status: "stop_requested",
      stopReason: "manual",
      stopDetectedAtEpochMs: 1,
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: stored },
      consentConfirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      finalChunkCount: null,
    });
    for (let seq = 0; seq < 2; seq++) {
      const r = await makeChunkRecord(meetingId, seq, 1600);
      r.save.status = "DB_REGISTERED";
      await h.chunkStore.putChunk(r);
    }
    // Act
    await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // Assert：停止理由と状態は変えない
    const m = await h.meetingStore.get(meetingId);
    expect(m?.sessionClock.audioFrameCount).toBe(expected);
    expect(m).toMatchObject({ status: "stop_requested", stopReason: "manual", stopDetectedAtEpochMs: 1 });
  });

  it("一覧取得後に停止処理が最終保存した audioFrameCount を、一覧時点の古い値で巻き戻さない", async () => {
    // Arrange：stop_requested（audioFrameCount 0）として一覧に載った直後、停止中のタブが最終保存で 999_999 を書く
    const h = await createHarness();
    const meetingId = "m-crash-stop-frames-after-list";
    const listed: MeetingRecord = { ...meetingOf(meetingId, "stop_requested"), stopReason: "manual", stopDetectedAtEpochMs: 1 };
    await h.meetingStore.put(listed);
    for (let seq = 0; seq < 2; seq++) {
      const r = await makeChunkRecord(meetingId, seq, 1600);
      r.save.status = "DB_REGISTERED";
      await h.chunkStore.putChunk(r);
    }
    const list = h.meetingStore.listByStatus.bind(h.meetingStore);
    vi.spyOn(h.meetingStore, "listByStatus").mockImplementation(async (status) => {
      const meetings = await list(status);
      if (status === "stop_requested") {
        await h.meetingStore.put({ ...listed, sessionClock: { ...listed.sessionClock, audioFrameCount: 999_999 }, updatedAt: 2 });
      }
      return meetings;
    });
    // Act
    await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // Assert
    expect(await h.meetingStore.get(meetingId)).toMatchObject({ status: "stop_requested", updatedAt: 2, sessionClock: { audioFrameCount: 999_999 } });
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

  it("停止理由と検出時刻の片方だけが残った会議は両方を外して直し、起動も他の会議の復旧も止めない", async () => {
    // Arrange：MeetingStore.put は片方だけの会議を拒否するので、壊れた行は IDB へ直接書く
    const h = await createHarness();
    const rawPut = (meeting: MeetingRecord & Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const tx = h.db.transaction("meetings", "readwrite");
      tx.objectStore("meetings").put(meeting);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await rawPut({ ...meetingOf("pair-rec", "recording"), stopReason: "manual" });
    await rawPut({ ...meetingOf("pair-stop", "stop_requested"), stopDetectedAtEpochMs: 5 });
    await h.meetingStore.put(meetingOf("pair-ok", "recording"));
    const r = await makeChunkRecord("pair-rec", 0, 160);
    await h.chunkStore.putChunk(r);
    // Act
    const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    // Assert：音声と停止状態の復旧は残し、確定（put・サーバーの 422）で止まらないよう未観測として扱う
    const ids = report.interruptedMeetings.map((m) => m.meetingId).filter((id) => id.startsWith("pair-"));
    expect(ids.sort()).toEqual(["pair-ok", "pair-rec", "pair-stop"]);
    const rec = await h.meetingStore.get("pair-rec");
    expect(rec).toMatchObject({ status: "stop_requested", sessionClock: { audioFrameCount: r.meta.endFrame } });
    expect(rec?.stopReason).toBeUndefined();
    const stop = await h.meetingStore.get("pair-stop");
    expect(stop?.status).toBe("stop_requested");
    expect(stop?.stopDetectedAtEpochMs).toBeUndefined();
    expect((await h.meetingStore.get("pair-ok"))?.status).toBe("stop_requested");
    expect(await h.chunkStore.getChunk(r.chunkKey)).toBeDefined();
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

  it("確定中止済みの会議は未完了 Chunk があっても報告も再送もしない", async () => {
    // Arrange
    const h = await createHarness();
    const meetingId = "m-crash-abandoned";
    await h.meetingStore.put(meetingOf(meetingId, "abandoned"));
    const chunks = await seedUnfinishedChunks(h, meetingId);
    // Act
    const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
    for (let i = 0; i < 5; i++) await h.advance(100);
    // Assert
    expect(report.interruptedMeetings.map((m) => m.meetingId)).not.toContain(meetingId);
    expect(report.requeuedChunks).toBe(0);
    expect((await h.chunkStore.getChunk(chunks.saving))?.save.status).toBe("SAVING");
    expect((await h.chunkStore.getChunk(chunks.waiting))?.save.status).toBe("BACKEND_UNAVAILABLE");
    expect(h.server.putCount).toBe(0);
  });

  it.each(["abandoned", "stop_requested", "finalized"] as const)("一覧取得後からロック取得までに別タブが %s へ進めた会議の Chunk は復旧しない", async (next) => {
    // Arrange
    const h = await createHarness();
    const meetingId = `m-crash-moved-${next}`;
    const listed = next === "stop_requested" ? "recording" : "stop_requested";
    await h.meetingStore.put(meetingOf(meetingId, listed));
    const chunks = await seedUnfinishedChunks(h, meetingId);
    changeStatusAfterListing(h, listed, meetingId, next);
    try {
      // Act
      const report = await recoverOnStartup(h.meetingStore, h.chunkStore, h.scheduler, h.locks);
      for (let i = 0; i < 5; i++) await h.advance(100);
      // Assert
      expect(report.interruptedMeetings.map((m) => m.meetingId)).not.toContain(meetingId);
      expect(report.requeuedChunks).toBe(0);
      expect((await h.chunkStore.getChunk(chunks.saving))?.save.status).toBe("SAVING");
      expect((await h.chunkStore.getChunk(chunks.waiting))?.save.status).toBe("BACKEND_UNAVAILABLE");
      expect(h.server.putCount).toBe(0);
      expect((await h.meetingStore.get(meetingId))?.status).toBe(next);
    } finally {
      // fake-indexeddb は DB を共有するので、Assert が失敗しても後続テストの復旧に拾われないよう片付ける
      await h.meetingStore.put(meetingOf(meetingId, "finalized"));
      for (const key of [chunks.saving, chunks.waiting]) await h.chunkStore.updateSaveState(key, (r) => { r.save.status = "DB_REGISTERED"; });
    }
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
