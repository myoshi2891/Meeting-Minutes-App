import { beforeEach, describe, expect, it } from "vitest";
import { finalizeMeeting, type FinalizerDeps } from "../src/recording/finalizer";
import type { MeetingRecord } from "../src/types/recording";
import { BASE_URL, createHarness, makeChunkRecord, TOKEN, type Harness } from "./harness";

// createHarness() はグローバル IndexedDB を共有するため、テストごとに会議 ID を分ける
let testNo = 0;
let MEETING_ID = "";
beforeEach(() => {
  MEETING_ID = `m-fin-${++testNo}`;
});

function meeting(): MeetingRecord {
  return {
    meetingId: MEETING_ID,
    title: "fin",
    status: "stop_requested",
    sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 960000 },
    consentConfirmedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    finalChunkCount: null,
  };
}

/** seq 0..n-1 を保存し、Scheduler 経由でサーバーへ送り切る */
async function recordAndSave(h: Harness, n: number): Promise<void> {
  await h.meetingStore.put(meeting());
  for (let seq = 0; seq < n; seq++) {
    const r = await makeChunkRecord(MEETING_ID, seq, 1600);
    await h.chunkStore.putChunk(r);
    await h.scheduler.enqueue(r.chunkKey);
  }
  for (let i = 0; i < 5; i++) await h.advance(100);
}

function deps(h: Harness, fetchImpl: typeof fetch = h.server.fetch): FinalizerDeps {
  return { chunkStore: h.chunkStore, meetingStore: h.meetingStore, scheduler: h.scheduler, baseUrl: BASE_URL, token: TOKEN, fetchImpl, unpersistedChunkCount: () => 0 };
}

describe("finalizeMeeting（Finalization Barrier）", () => {
  it("全 Chunk が DB_REGISTERED かつサーバー一覧と一致すれば finalized になる", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 2);
    const posted: unknown[] = [];
    const spy: typeof fetch = async (input, init) => {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      return h.server.fetch(input, init);
    };
    // Act
    const result = await finalizeMeeting(deps(h, spy), MEETING_ID);
    // Assert
    expect(result).toEqual({ ok: true });
    const m = await h.meetingStore.get(MEETING_ID);
    expect(m?.status).toBe("finalized");
    expect(m?.finalChunkCount).toBe(2);
    expect(posted).toEqual([{ expectedChunkCounts: { mic: 2, system: 0 }, endedAtEpochMs: m?.endedAt, totalAudioFrames: 960000 }]);
  });

  it("未登録 Chunk が残っていれば finalizing に進まず waiting_local_save を返し、再投入する", async () => {
    const h = await createHarness();
    await h.meetingStore.put(meeting());
    h.backend.status = "UNREACHABLE";
    const r = await makeChunkRecord(MEETING_ID, 0, 1600);
    await h.chunkStore.putChunk(r);
    await h.scheduler.enqueue(r.chunkKey);
    await h.advance(100);

    const result = await finalizeMeeting(deps(h), MEETING_ID);
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("stop_requested");

    // サーバー復帰後は再試行で通る
    h.backend.status = "HEALTHY";
    await h.scheduler.resumeAll();
    await h.advance(100);
    expect(await finalizeMeeting(deps(h), MEETING_ID)).toEqual({ ok: true });
  });

  it("sequenceNo に欠番があれば verify で止まる", async () => {
    const h = await createHarness();
    await h.meetingStore.put(meeting());
    for (const seq of [0, 2]) {
      const r = await makeChunkRecord(MEETING_ID, seq, 1600);
      await h.chunkStore.putChunk(r);
      await h.scheduler.enqueue(r.chunkKey);
    }
    await h.advance(100);
    expect(await finalizeMeeting(deps(h), MEETING_ID)).toMatchObject({ ok: false, stage: "verify", detail: "sequence gap at 1" });
  });

  it("サーバー側から Chunk が消えていたら再投入し、再送後に finalize できる", async () => {
    const h = await createHarness();
    await recordAndSave(h, 2);
    h.server.stored.delete(`${MEETING_ID}:mic:1`);

    const first = await finalizeMeeting(deps(h), MEETING_ID);
    expect(first).toMatchObject({ ok: false, stage: "verify", detail: "server mismatch at seq 1" });
    await h.advance(100);
    expect(h.server.stored.has(`${MEETING_ID}:mic:1`)).toBe(true);
    expect(await finalizeMeeting(deps(h), MEETING_ID)).toEqual({ ok: true });
  });

  it("POST /finalize が 409 なら stop_requested に戻して finalize ステージの失敗を返す", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const conflict: typeof fetch = async (input, init) =>
      init?.method === "POST" ? new Response(JSON.stringify({ error: "missing", code: "CONFLICT_CHUNKS_MISSING" }), { status: 409 }) : h.server.fetch(input, init);
    expect(await finalizeMeeting(deps(h, conflict), MEETING_ID)).toMatchObject({ ok: false, stage: "finalize" });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("stop_requested");
  });

  it("存在しない会議は verify の失敗", async () => {
    const h = await createHarness();
    expect(await finalizeMeeting(deps(h), "nope")).toMatchObject({ ok: false, stage: "verify", detail: "meeting not found" });
  });

  it("GET /chunks の応答が契約に合わなければ例外ではなく verify の失敗 Result を返す", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const malformed: typeof fetch = async (input, init) => (String(input).endsWith("/chunks") ? new Response(JSON.stringify({ unexpected: true }), { status: 200 }) : h.server.fetch(input, init));
    expect(await finalizeMeeting(deps(h, malformed), MEETING_ID)).toMatchObject({ ok: false, stage: "verify" });
  });

  it("finalize 中にサーバーへ接続できなければ例外ではなく Result を返し、会議は stop_requested に戻る", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const dropsOnPost: typeof fetch = async (input, init) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return h.server.fetch(input, init);
    };
    expect(await finalizeMeeting(deps(h, dropsOnPost), MEETING_ID)).toMatchObject({ ok: false, stage: "finalize" });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("stop_requested");
  });

  it("一覧取得時に接続できなければ verify の失敗 Result を返す", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const down: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await finalizeMeeting(deps(h, down), MEETING_ID)).toMatchObject({ ok: false, stage: "verify" });
  });

  it("GET /chunks が応答しなければ timeoutMs で verify の失敗 Result を返す", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const hangsOnList: typeof fetch = (input, init) =>
      String(input).endsWith("/chunks")
        ? new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
        : h.server.fetch(input, init);
    const result = await finalizeMeeting({ ...deps(h, hangsOnList), timeoutMs: 20 }, MEETING_ID);
    expect(result).toMatchObject({ ok: false, stage: "verify" });
  });

  it("POST /finalize が応答しなければ timeoutMs で finalize の失敗 Result を返し、stop_requested に戻る", async () => {
    const h = await createHarness();
    await recordAndSave(h, 1);
    const hangsOnPost: typeof fetch = (input, init) =>
      init?.method === "POST"
        ? new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
        : h.server.fetch(input, init);
    const result = await finalizeMeeting({ ...deps(h, hangsOnPost), timeoutMs: 20 }, MEETING_ID);
    expect(result).toMatchObject({ ok: false, stage: "finalize" });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("stop_requested");
  });
});

describe("finalizeMeeting（Barrier の追加条件）", () => {
  it("メモリ待機中の Chunk があれば IDB 上が揃っていても finalizing に進まない", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 2);
    // Act
    const result = await finalizeMeeting({ ...deps(h), unpersistedChunkCount: () => 1 }, MEETING_ID);
    // Assert
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("stop_requested");
  });

  it("SAVED の Chunk はサーバー一覧で登録確認できれば DB_REGISTERED に進み finalized になる", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 2);
    const [first] = await h.chunkStore.listByMeeting(MEETING_ID, "mic");
    await h.chunkStore.updateSaveState(first.chunkKey, (r) => {
      r.save.status = "SAVED";
    });
    // Act
    const result = await finalizeMeeting(deps(h), MEETING_ID);
    // Assert
    expect(result).toEqual({ ok: true });
    expect((await h.chunkStore.getChunk(first.chunkKey))?.save.status).toBe("DB_REGISTERED");
  });
});

describe("finalizeMeeting（会議の状態による前提条件）", () => {
  it("recording 中の会議は stop の前提を満たさないため verify で失敗し、サーバーへ問い合わせない", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 1);
    const m = await h.meetingStore.get(MEETING_ID);
    await h.meetingStore.put({ ...(m as MeetingRecord), status: "recording" });
    let calls = 0;
    const spy: typeof fetch = async (input, init) => {
      calls++;
      return h.server.fetch(input, init);
    };
    // Act
    const result = await finalizeMeeting(deps(h, spy), MEETING_ID);
    // Assert
    expect(result).toMatchObject({ ok: false, stage: "verify" });
    expect(calls).toBe(0);
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("recording");
  });

  it("finalized 済みの会議は再度 POST /finalize せず成功を返し、endedAt を書き換えない", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 1);
    expect(await finalizeMeeting(deps(h), MEETING_ID)).toEqual({ ok: true });
    const endedAt = (await h.meetingStore.get(MEETING_ID))?.endedAt;
    let posts = 0;
    const spy: typeof fetch = async (input, init) => {
      if (init?.method === "POST") posts++;
      return h.server.fetch(input, init);
    };
    // Act
    const result = await finalizeMeeting(deps(h, spy), MEETING_ID);
    // Assert
    expect(result).toEqual({ ok: true });
    expect(posts).toBe(0);
    expect((await h.meetingStore.get(MEETING_ID))?.endedAt).toBe(endedAt);
  });

  it("finalizing のまま中断された会議（POST 中のクラッシュ）は再試行で finalized になる", async () => {
    // Arrange
    const h = await createHarness();
    await recordAndSave(h, 1);
    const m = await h.meetingStore.get(MEETING_ID);
    await h.meetingStore.put({ ...(m as MeetingRecord), status: "finalizing" });
    // Act
    const result = await finalizeMeeting(deps(h), MEETING_ID);
    // Assert
    expect(result).toEqual({ ok: true });
    expect((await h.meetingStore.get(MEETING_ID))?.status).toBe("finalized");
  });
});
