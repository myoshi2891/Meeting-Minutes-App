import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  ChunkStore,
  MeetingStore,
  SettingsStore,
  STORE_CHUNKS,
  STORE_MEETINGS,
  STORE_SETTINGS,
  isAudioChunkRecord,
  isMeetingRecord,
  isQuotaExceeded,
  openDatabase,
} from "../src/storage/idb";
import type { MeetingRecord } from "../src/types/recording";
import { makeChunkRecord } from "./harness";

/** テストごとに独立した IndexedDB を開く */
function freshDb(): Promise<IDBDatabase> {
  return openDatabase(new IDBFactory());
}

function makeMeeting(meetingId: string, status: MeetingRecord["status"]): MeetingRecord {
  return {
    meetingId,
    title: "t",
    status,
    sessionClock: {
      sessionStartEpochMs: 0,
      performanceTimeOrigin: 0,
      sessionStartPerformanceMs: 0,
      audioContextStartTime: 0,
      nativeSampleRate: 48000,
      audioFrameCount: 0,
    },
    consentConfirmedAt: 1,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    finalChunkCount: null,
  };
}

describe("openDatabase", () => {
  it("v1 マイグレーションで 3 store と索引が作られる", async () => {
    const db = await freshDb();
    expect([...db.objectStoreNames].sort()).toEqual([STORE_CHUNKS, STORE_MEETINGS, STORE_SETTINGS].sort());
    const tx = db.transaction(STORE_CHUNKS, "readonly");
    expect([...tx.objectStore(STORE_CHUNKS).indexNames].sort()).toEqual(["by_meeting", "by_meeting_seq", "by_meeting_status", "by_status"]);
  });
});

describe("ChunkStore", () => {
  it("put した Chunk を get で取り出せる", async () => {
    const store = new ChunkStore(await freshDb());
    const r = await makeChunkRecord("m1", 0, 160);
    await store.putChunk(r);
    const loaded = await store.getChunk(r.chunkKey);
    expect(loaded?.meta.sha256).toBe(r.meta.sha256);
  });

  it("存在しない chunkKey は undefined", async () => {
    const store = new ChunkStore(await freshDb());
    expect(await store.getChunk("nope")).toBeUndefined();
  });

  it("listByMeeting は sequenceNo 昇順で、他会議を含まない", async () => {
    const store = new ChunkStore(await freshDb());
    for (const seq of [2, 0, 1]) await store.putChunk(await makeChunkRecord("m1", seq, 160));
    await store.putChunk(await makeChunkRecord("m2", 0, 160));
    const list = await store.listByMeeting("m1", "mic");
    expect(list.map((r) => r.meta.sequenceNo)).toEqual([0, 1, 2]);
  });

  it("同一 (meetingId, source, sequenceNo) で別 chunkKey の書き込みは一意索引で拒否される", async () => {
    const store = new ChunkStore(await freshDb());
    const r = await makeChunkRecord("m1", 0, 160);
    await store.putChunk(r);
    await expect(store.putChunk({ ...r, chunkKey: "other-key" })).rejects.toBeDefined();
  });

  it("updateSaveState は状態を更新し updatedAt を進める", async () => {
    const store = new ChunkStore(await freshDb());
    const r = await makeChunkRecord("m1", 0, 160);
    await store.putChunk(r);
    await store.updateSaveState(r.chunkKey, (rec) => {
      rec.save.status = "IDB_STORED";
    });
    const loaded = await store.getChunk(r.chunkKey);
    expect(loaded?.save.status).toBe("IDB_STORED");
    expect(loaded?.save.updatedAt).toBeGreaterThan(0);
  });

  it("updateSaveState は存在しない Chunk でエラーを投げる（握りつぶさない）", async () => {
    const store = new ChunkStore(await freshDb());
    await expect(store.updateSaveState("missing", () => undefined)).rejects.toThrow("chunk not found");
  });

  it("listUnfinished は DB_REGISTERED 以外を返し、countByStatus は会議×状態で数える", async () => {
    const store = new ChunkStore(await freshDb());
    const a = await makeChunkRecord("m1", 0, 160);
    const b = await makeChunkRecord("m1", 1, 160);
    b.save.status = "DB_REGISTERED";
    await store.putChunk(a);
    await store.putChunk(b);
    expect((await store.listUnfinished()).map((r) => r.chunkKey)).toEqual([a.chunkKey]);
    expect(await store.countByStatus("m1", "DB_REGISTERED")).toBe(1);
    expect(await store.countByStatus("m1", "GENERATED")).toBe(1);
    expect(await store.countByStatus("m2", "GENERATED")).toBe(0);
  });

  it("dropBlob は WAV 本体だけを消しメタデータを残す", async () => {
    const store = new ChunkStore(await freshDb());
    const r = await makeChunkRecord("m1", 0, 160);
    await store.putChunk(r);
    await store.dropBlob(r.chunkKey);
    const loaded = await store.getChunk(r.chunkKey);
    expect(loaded?.wav).toBeNull();
    expect(loaded?.meta.sha256).toBe(r.meta.sha256);
  });
});

describe("MeetingStore / SettingsStore", () => {
  it("listByStatus は指定状態の会議のみ返す", async () => {
    const store = new MeetingStore(await freshDb());
    await store.put(makeMeeting("a", "recording"));
    await store.put(makeMeeting("b", "finalized"));
    expect((await store.listByStatus("recording")).map((m) => m.meetingId)).toEqual(["a"]);
    expect((await store.get("b"))?.status).toBe("finalized");
    expect(await store.get("zzz")).toBeUndefined();
  });

  it("settings は値を保存でき、未設定キーは undefined", async () => {
    const store = new SettingsStore(await freshDb());
    await store.set("token", "abc");
    expect(await store.get("token")).toBe("abc");
    expect(await store.get("missing")).toBeUndefined();
  });
});

describe("型ガード", () => {
  it("isQuotaExceeded は QuotaExceededError の DOMException のみ true", () => {
    expect(isQuotaExceeded(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaExceeded(new DOMException("x", "AbortError"))).toBe(false);
    expect(isQuotaExceeded(new Error("QuotaExceededError"))).toBe(false);
  });

  it("isAudioChunkRecord / isMeetingRecord は不完全な値を拒否する", () => {
    expect(isAudioChunkRecord(null)).toBe(false);
    expect(isAudioChunkRecord({ chunkKey: "k", meta: null, save: {} })).toBe(false);
    expect(isMeetingRecord({ meetingId: "m" })).toBe(false);
    expect(isMeetingRecord(makeMeeting("m", "created"))).toBe(true);
  });
});
