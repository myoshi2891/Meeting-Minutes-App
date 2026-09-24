// test/backend-outage.test.ts
import { describe, expect, it } from "vitest";
import { createHarness, makeChunkRecord } from "./harness";

describe("常駐サーバー停止 5 分 → 復旧", () => {
  it("停止中は BACKEND_UNAVAILABLE で IDB に滞留し、復旧後 sequenceNo 順に DB_REGISTERED になる", async () => {
    const h = await createHarness();
    const meetingId = "m-outage";

    // 最初の 2 Chunk はサーバー稼働中に保存
    for (let seq = 0; seq < 2; seq++) {
      const r = await makeChunkRecord(meetingId, seq);
      await h.chunkStore.putChunk(r);
      await h.scheduler.enqueue(r.chunkKey);
    }
    await h.advance(100);
    expect((await h.chunkStore.getChunk(`${meetingId}:mic:000000`))?.save.status).toBe("DB_REGISTERED");
    expect((await h.chunkStore.getChunk(`${meetingId}:mic:000001`))?.save.status).toBe("DB_REGISTERED");

    // サーバー停止（5 分 = 10 Chunk 分）
    h.server.up = false;
    h.backend.status = "UNREACHABLE";
    for (let seq = 2; seq < 12; seq++) {
      const r = await makeChunkRecord(meetingId, seq);
      await h.chunkStore.putChunk(r);
      await h.scheduler.enqueue(r.chunkKey);
      await h.advance(30_000);
    }
    const stalled = await h.chunkStore.listByMeeting(meetingId, "mic");
    const stalledStatuses = stalled.slice(2).map((c) => c.save.status);
    expect(stalledStatuses.every((s) => s === "BACKEND_UNAVAILABLE" || s === "LOCAL_SAVE_PENDING")).toBe(true);
    expect(h.server.putCount).toBe(2); // 停止中は PUT が到達していない
    // 録音側の健全性：pendingChunkCount が増えるだけで、録音を止める理由（recordingCritical）は立たない
    expect(h.health.pendingChunkCount).toBe(10);

    // 復旧
    h.server.up = true;
    h.backend.status = "HEALTHY";
    await h.scheduler.resumeAll();
    for (let i = 0; i < 30; i++) await h.advance(100);

    const after = await h.chunkStore.listByMeeting(meetingId, "mic");
    expect(after.map((c) => c.save.status)).toEqual(Array<string>(12).fill("DB_REGISTERED"));
    // サーバー側は 12 個、PUT の到達順が sequenceNo 昇順
    expect(h.server.arrivalOrder).toEqual(Array.from({ length: 12 }, (_, i) => `${meetingId}:mic:${i}`));
    expect(h.health.pendingChunkCount).toBe(0);
  });

  it("401 は BACKEND_UNAVAILABLE（unauthorized）になり、トークン修正後に再開できる", async () => {
    const h = await createHarness();
    const r = await makeChunkRecord("m-auth", 0);
    await h.chunkStore.putChunk(r);
    h.backend.unauthorized = true;
    await h.scheduler.enqueue(r.chunkKey);
    await h.advance(100);
    expect((await h.chunkStore.getChunk(r.chunkKey))?.save.status).toBe("BACKEND_UNAVAILABLE");
    h.backend.unauthorized = false;
    await h.scheduler.resumeAll();
    await h.advance(100);
    expect((await h.chunkStore.getChunk(r.chunkKey))?.save.status).toBe("DB_REGISTERED");
  });
});
