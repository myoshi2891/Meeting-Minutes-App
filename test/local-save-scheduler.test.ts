import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { LocalSaver } from "../src/api/local-saver";
import { LocalSaveScheduler } from "../src/recording/local-save-scheduler";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import { ChunkStore, openDatabase } from "../src/storage/idb";
import type { AudioChunkRecord, LocalBackendHealth } from "../src/types/recording";
import { BASE_URL, makeChunkRecord, TOKEN } from "./harness";

type Responder = (record: { sequenceNo: number; attempt: number }) => Response | "network-error";

function okResponse(r: AudioChunkRecord, registered = true): Response {
  const { meetingId, source, sequenceNo, sha256, sizeBytes } = r.meta;
  return new Response(JSON.stringify({ meetingId, source, sequenceNo, sha256, sizeBytes, path: `p/${sequenceNo}`, registered }), { status: 201 });
}

async function setup(respond: (r: AudioChunkRecord, attempt: number) => Response | "network-error", backendStatus: LocalBackendHealth["status"] = "HEALTHY") {
  const chunkStore = new ChunkStore(await openDatabase(new IDBFactory()));
  const backend: LocalBackendHealth = { status: backendStatus, lastCheckedAt: 0, lastHealthyAt: 0, latencyMs: 5, consecutiveFailures: 0, capabilities: null, unauthorized: false };
  const health = createInitialHealth("running");
  const timers: Array<{ fn: () => void; at: number }> = [];
  const records = new Map<number, AudioChunkRecord>();
  const attempts = new Map<number, number>();
  let now = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let putCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    putCount++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 0));
    inFlight--;
    const seq = Number(String(input).split("/").pop());
    const attempt = (attempts.get(seq) ?? 0) + 1;
    attempts.set(seq, attempt);
    const res = respond(records.get(seq) as AudioChunkRecord, attempt);
    if (res === "network-error") throw new TypeError("Failed to fetch");
    return res;
  };
  const scheduler = new LocalSaveScheduler({
    chunkStore,
    saver: () => new LocalSaver({ baseUrl: BASE_URL, token: TOKEN, requestTimeoutMs: 1000 }, fetchImpl),
    backend: () => backend,
    health,
    maxConcurrency: 2,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
    onBackendUnreachable: () => {
      backend.status = "UNREACHABLE";
    },
    onBackendUnauthorized: () => {
      backend.unauthorized = true;
    },
  });
  const add = async (seq: number) => {
    const r = await makeChunkRecord("m", seq, 160);
    records.set(seq, r);
    await chunkStore.putChunk(r);
    await scheduler.enqueue(r.chunkKey);
    return r;
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const status = async (seq: number) => (await chunkStore.getChunk(`m:mic:${String(seq).padStart(6, "0")}`))?.save;
  return { scheduler, chunkStore, backend, health, timers, add, advance, status, stats: () => ({ putCount, maxInFlight }) };
}

describe("LocalSaveScheduler", () => {
  it("registered=false の応答は SAVED で止まる（DB 登録は後から確認）", async () => {
    const s = await setup((r) => okResponse(r, false));
    await s.add(0);
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("SAVED");
    expect((await s.status(0))?.savedVia).toBe("api");
  });

  it("並列 PUT は maxConcurrency（2）を超えない", async () => {
    const s = await setup((r) => okResponse(r));
    for (let i = 0; i < 6; i++) await s.add(i);
    await s.advance(0);
    await s.advance(0);
    for (let i = 0; i < 6; i++) expect((await s.status(i))?.status).toBe("DB_REGISTERED");
    expect(s.stats().maxInFlight).toBeLessThanOrEqual(2);
    expect(s.health.pendingChunkCount).toBe(0);
  });

  it("5xx は RETRYING になり、バックオフ経過後の再送で成功する", async () => {
    const s = await setup((r, attempt) => (attempt === 1 ? new Response("{}", { status: 500 }) : okResponse(r)));
    await s.add(0);
    await s.advance(0);
    const retrying = await s.status(0);
    expect(retrying?.status).toBe("RETRYING");
    expect(retrying?.lastError?.kind).toBe("SERVER");
    expect(retrying?.nextRetryAt).toBeGreaterThan(0);
    await s.advance(3_000); // 2s ± 20% を確実に越える
    const done = await s.status(0);
    expect(done?.status).toBe("DB_REGISTERED");
    expect(done?.attempts).toBe(2);
  });

  it("non-retryable（422）は LOCAL_SAVE_FAILED に留まり、後続 Chunk は詰まらない", async () => {
    const s = await setup((r) => (r.meta.sequenceNo === 0 ? new Response("{}", { status: 422 }) : okResponse(r)));
    await s.add(0);
    await s.add(1);
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("LOCAL_SAVE_FAILED");
    expect((await s.status(1))?.status).toBe("DB_REGISTERED");
    expect(s.timers).toHaveLength(0);
  });

  it("resumeAll は non-retryable の LOCAL_SAVE_FAILED を再投入せず、上限到達の retryable な LOCAL_SAVE_FAILED は再投入する", async () => {
    // Arrange：seq 0 は 422（non-retryable）、seq 1 は 5xx を上限まで繰り返して LOCAL_SAVE_FAILED にする
    let serverDown = true;
    const s = await setup((r) => {
      if (r.meta.sequenceNo === 0) return new Response("{}", { status: 422 });
      return serverDown ? new Response("{}", { status: 500 }) : okResponse(r);
    });
    await s.add(0);
    await s.add(1);
    for (let i = 0; i < 20; i++) await s.advance(600_000);
    expect((await s.status(0))?.status).toBe("LOCAL_SAVE_FAILED");
    expect((await s.status(1))?.status).toBe("LOCAL_SAVE_FAILED");
    const putsBefore = s.stats().putCount;
    // Act
    serverDown = false;
    await s.scheduler.resumeAll();
    await s.advance(0);
    // Assert：non-retryable は手動再試行のみ。retryable は上限到達でも再開する
    expect((await s.status(0))?.status).toBe("LOCAL_SAVE_FAILED");
    expect((await s.status(1))?.status).toBe("DB_REGISTERED");
    expect(s.stats().putCount).toBe(putsBefore + 1);
  });

  it("DEGRADED（遅いが応答あり）の backend には PUT を試みる（§18）", async () => {
    const s = await setup((r) => okResponse(r), "DEGRADED");
    await s.add(0);
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
  });

  it("saver 未設定（トークン未入力）なら BACKEND_UNAVAILABLE で待機", async () => {
    const s = await setup((r) => okResponse(r));
    const noSaver = new LocalSaveScheduler({
      chunkStore: s.chunkStore,
      saver: () => null,
      backend: () => s.backend,
      health: s.health,
      maxConcurrency: 2,
      now: () => 0,
      setTimer: () => undefined,
      onBackendUnreachable: () => undefined,
      onBackendUnauthorized: () => undefined,
    });
    const r = await makeChunkRecord("m", 9, 160);
    await s.chunkStore.putChunk(r);
    await noSaver.enqueue(r.chunkKey);
    await s.advance(0);
    expect((await s.status(9))?.status).toBe("BACKEND_UNAVAILABLE");
  });

  it("接続不能（NETWORK）はポーリングを待たず backend を UNREACHABLE にし、PUT を連打しない", async () => {
    // Arrange：backend はまだ HEALTHY と認識しているがサーバーは落ちている
    const s = await setup(() => "network-error");
    // Act
    await s.add(0);
    for (let i = 0; i < 5; i++) await s.advance(10);
    // Assert
    expect(s.backend.status).toBe("UNREACHABLE");
    expect(s.stats().putCount).toBe(1);
    expect((await s.status(0))?.status).toBe("BACKEND_UNAVAILABLE");
    expect((await s.status(0))?.lastError?.kind).toBe("NETWORK");
  });

  it("401 は Monitor に unauthorized を通知して待機し、PUT を連打しない。resumeAll で再開する", async () => {
    // Arrange：backend はまだ認証済みと認識しているがトークンが失効している
    let tokenValid = false;
    const s = await setup((r) => (tokenValid ? okResponse(r) : new Response(JSON.stringify({ error: "x", code: "UNAUTHORIZED" }), { status: 401 })));
    // Act
    await s.add(0);
    for (let i = 0; i < 5; i++) await s.advance(10);
    // Assert
    expect(s.backend.unauthorized).toBe(true);
    expect(s.stats().putCount).toBe(1);
    expect((await s.status(0))?.status).toBe("BACKEND_UNAVAILABLE");

    tokenValid = true;
    s.backend.unauthorized = false;
    await s.scheduler.resumeAll();
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
    expect(s.stats().putCount).toBe(2);
  });

  it("resumeAll で保存済みになった Chunk を、後から発火したリトライタイマーが再送しない", async () => {
    const s = await setup((r, attempt) => (attempt === 1 ? new Response("{}", { status: 500 }) : okResponse(r)));
    await s.add(0);
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("RETRYING");

    await s.scheduler.resumeAll(); // backend 復帰通知などでタイマーより先に再投入される
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
    expect(s.stats().putCount).toBe(2);

    await s.advance(3_000); // リトライタイマー発火
    expect(s.stats().putCount).toBe(2);
    expect(s.health.pendingChunkCount).toBe(0);
  });

  it("resumeAll で保存済みになった Chunk を、backend 停止中に発火したリトライタイマーが BACKEND_UNAVAILABLE に書き戻さない", async () => {
    // Arrange：1 回目は 5xx でリトライタイマーが残り、resumeAll による 2 回目で DB_REGISTERED になる
    const s = await setup((r, attempt) => (attempt === 1 ? new Response("{}", { status: 500 }) : okResponse(r)));
    await s.add(0);
    await s.advance(0);
    await s.scheduler.resumeAll();
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
    // Act：backend が停止した後にリトライタイマーが発火する
    s.backend.status = "UNREACHABLE";
    await s.advance(3_000);
    // Assert：登録済みの状態を保ち、pending にも残さない
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
    expect(s.health.pendingChunkCount).toBe(0);
  });

  it("resumeAll で SAVED になった Chunk を、後から発火したリトライタイマーが再送しない", async () => {
    // Arrange：1 回目は 5xx でリトライタイマーが残り、resumeAll による 2 回目で SAVED（DB 未登録）になる
    const s = await setup((r, attempt) => (attempt === 1 ? new Response("{}", { status: 500 }) : okResponse(r, false)));
    await s.add(0);
    await s.advance(0);
    await s.scheduler.resumeAll();
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("SAVED");
    // Act：リトライタイマー発火
    await s.advance(3_000);
    // Assert：SAVED の登録確認は Finalizer のサーバー一覧照合に任せ、再送しない
    expect(s.stats().putCount).toBe(2);
    expect((await s.status(0))?.status).toBe("SAVED");
  });

  it("同じ Chunk を二重に enqueue しても PUT は 1 回", async () => {
    const s = await setup((r) => okResponse(r));
    const r = await makeChunkRecord("m", 0, 160);
    await s.chunkStore.putChunk(r);
    s.backend.status = "UNREACHABLE";
    await s.scheduler.enqueue(r.chunkKey);
    await s.scheduler.enqueue(r.chunkKey);
    s.backend.status = "HEALTHY";
    await s.scheduler.resumeAll();
    await s.advance(0);
    await s.advance(0);
    expect(s.stats().putCount).toBe(1);
  });

  it("保存状態の書き込みが例外で失敗しても SAVING に取り残さず、バックオフ後に再送して保存を終える", async () => {
    // Arrange：PUT 成功後の DB_REGISTERED 書き込みだけを 1 回失敗させる（IDB の一時的な失敗）
    const s = await setup((r) => okResponse(r));
    const original = s.chunkStore.updateSaveState.bind(s.chunkStore);
    let failOnce = true;
    s.chunkStore.updateSaveState = (key, mutate) =>
      original(key, (r) => {
        mutate(r);
        if (failOnce && r.save.status === "DB_REGISTERED") {
          failOnce = false;
          throw new Error("idb write failed");
        }
      });
    // Act
    await s.add(0);
    await s.advance(0);
    // Assert：SAVING ではなく再開可能な RETRYING に戻り、即時の再送はしない
    const retrying = await s.status(0);
    expect(retrying?.status).toBe("RETRYING");
    expect(retrying?.lastError?.kind).toBe("UNKNOWN");
    expect(s.stats().putCount).toBe(1);
    await s.advance(3_000);
    expect((await s.status(0))?.status).toBe("DB_REGISTERED");
    expect(s.stats().putCount).toBe(2);
  });

  it("backend 停止中に何度 enqueue しても、各 Chunk への BACKEND_UNAVAILABLE の書き込みは 1 回だけ", async () => {
    // Arrange：BACKEND_UNAVAILABLE を書いた回数を chunkKey ごとに数える
    const s = await setup((r) => okResponse(r), "UNREACHABLE");
    const original = s.chunkStore.updateSaveState.bind(s.chunkStore);
    const unavailableWrites = new Map<string, number>();
    s.chunkStore.updateSaveState = (key, mutate) =>
      original(key, (r) => {
        mutate(r);
        if (r.save.status === "BACKEND_UNAVAILABLE") unavailableWrites.set(key, (unavailableWrites.get(key) ?? 0) + 1);
      });
    // Act
    for (let i = 0; i < 5; i++) await s.add(i);
    await s.advance(0);
    // Assert
    for (let i = 0; i < 5; i++) expect((await s.status(i))?.status).toBe("BACKEND_UNAVAILABLE");
    expect(unavailableWrites.get("m:mic:000000")).toBe(1);
    expect([...unavailableWrites.values()].every((n) => n === 1)).toBe(true);
    expect(s.stats().putCount).toBe(0);
  });

  it("backend が復帰して送信を試みた Chunk は、再停止したら再び BACKEND_UNAVAILABLE を書く", async () => {
    // Arrange：停止中に BACKEND_UNAVAILABLE を書き、復帰後の 1 回目の PUT は 5xx で RETRYING になる
    const s = await setup((r, attempt) => (attempt === 1 ? new Response("{}", { status: 500 }) : okResponse(r)), "UNREACHABLE");
    await s.add(0);
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("BACKEND_UNAVAILABLE");
    s.backend.status = "HEALTHY";
    await s.scheduler.resumeAll();
    await s.advance(0);
    expect((await s.status(0))?.status).toBe("RETRYING");
    // Act：再停止した後にリトライタイマーが発火する
    s.backend.status = "UNREACHABLE";
    await s.advance(3_000);
    // Assert：RETRYING のまま放置せず、停止中の待機状態を書き直す
    expect((await s.status(0))?.status).toBe("BACKEND_UNAVAILABLE");
    expect(s.stats().putCount).toBe(1);
  });
});
