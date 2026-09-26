import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import { ChunkStore, openDatabase } from "../src/storage/idb";
import { enforceQuota, estimateQuota, requestPersistence } from "../src/storage/quota-monitor";
import type { AudioChunkRecord } from "../src/types/recording";
import { makeChunkRecord } from "./harness";

const QUOTA = 1_000;

/** navigator.storage を差し替える。estimate は呼ぶたびに ratios を先頭から返し、最後の値を繰り返す */
function stubStorage(storage: { persist?: () => Promise<boolean>; ratios?: number[] }): ReturnType<typeof vi.fn> {
  const ratios = [...(storage.ratios ?? [])];
  const estimate = vi.fn(async () => {
    const ratio = ratios.length > 1 ? (ratios.shift() as number) : ratios[0];
    return { usage: ratio * QUOTA, quota: QUOTA };
  });
  vi.stubGlobal("navigator", { storage: { persist: storage.persist, estimate: storage.ratios === undefined ? undefined : estimate } });
  return estimate;
}

let meetingSeq = 0;

/** 会議の Chunk を status 付きで IDB に置く。会議 ID はテストごとに変える（fake-indexeddb の共有対策） */
async function seedChunks(statuses: AudioChunkRecord["save"]["status"][]): Promise<{ chunkStore: ChunkStore; meetingId: string }> {
  const chunkStore = new ChunkStore(await openDatabase(new IDBFactory()));
  const meetingId = `m-quota-${meetingSeq++}`;
  for (const [seq, status] of statuses.entries()) {
    const r = await makeChunkRecord(meetingId, seq, 160);
    r.save.status = status;
    await chunkStore.putChunk(r);
  }
  return { chunkStore, meetingId };
}

async function blobKept(chunkStore: ChunkStore, meetingId: string): Promise<boolean[]> {
  const chunks = await chunkStore.listByMeeting(meetingId, "mic");
  return chunks.map((c) => c.wav !== null);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPersistence", () => {
  it("persist API がなければ null を返し、health にも null を記録する", async () => {
    // Arrange
    stubStorage({});
    const health = createInitialHealth("running");
    health.storagePersisted = true;
    // Act
    const result = await requestPersistence(health);
    // Assert
    expect(result).toBeNull();
    expect(health.storagePersisted).toBeNull();
  });

  it.each([true, false])("persist の結果（%s）を返し、health に記録する", async (granted) => {
    // Arrange
    stubStorage({ persist: async () => granted });
    const health = createInitialHealth("running");
    // Act
    const result = await requestPersistence(health);
    // Assert
    expect(result).toBe(granted);
    expect(health.storagePersisted).toBe(granted);
  });
});

describe("estimateQuota", () => {
  it("estimate API がなければ null", async () => {
    stubStorage({});
    expect(await estimateQuota()).toBeNull();
  });

  it("使用量 / 上限を ratio として返す", async () => {
    stubStorage({ ratios: [0.25] });
    const quota = await estimateQuota();
    expect(quota).toMatchObject({ usageBytes: 250, quotaBytes: 1_000, ratio: 0.25 });
  });

  it("上限が 0 なら ratio は 0（ゼロ除算しない）", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 10, quota: 0 }) } });
    expect((await estimateQuota())?.ratio).toBe(0);
  });
});

describe("enforceQuota", () => {
  it("estimate API がなければ何もしない", async () => {
    // Arrange
    stubStorage({});
    const { chunkStore, meetingId } = await seedChunks(["DB_REGISTERED"]);
    const health = createInitialHealth("running");
    // Act
    const action = await enforceQuota(chunkStore, meetingId, health);
    // Assert
    expect(action).toBe("none");
    expect(health.storageUsageRatio).toBeNull();
    expect(await blobKept(chunkStore, meetingId)).toEqual([true]);
  });

  it("使用率 80% 未満なら IDB_QUOTA_WARNING だけを外し、他の劣化理由は残す", async () => {
    // Arrange
    stubStorage({ ratios: [0.5] });
    const { chunkStore, meetingId } = await seedChunks(["DB_REGISTERED"]);
    const health = createInitialHealth("running");
    health.degradedReasons = ["IDB_QUOTA_WARNING", "BACKEND_UNREACHABLE"];
    // Act
    const action = await enforceQuota(chunkStore, meetingId, health);
    // Assert
    expect(action).toBe("none");
    expect(health.storageUsageRatio).toBe(0.5);
    expect(health.degradedReasons).toEqual(["BACKEND_UNREACHABLE"]);
    expect(await blobKept(chunkStore, meetingId)).toEqual([true]);
  });

  it("使用率 80% 以上なら DB_REGISTERED の Blob を古い順に消し、80% を下回ったら止める", async () => {
    // Arrange：1 件消した後はまだ 85%、2 件目を消すと 70% に下がる
    stubStorage({ ratios: [0.9, 0.85, 0.7] });
    const { chunkStore, meetingId } = await seedChunks(["DB_REGISTERED", "SAVED", "DB_REGISTERED", "DB_REGISTERED"]);
    const health = createInitialHealth("running");
    // Act
    const action = await enforceQuota(chunkStore, meetingId, health);
    // Assert：未検証（SAVED）の Chunk は再送のため残す
    expect(action).toBe("dropped_registered_blobs");
    expect(await blobKept(chunkStore, meetingId)).toEqual([false, true, false, true]);
    expect(health.degradedReasons).toContain("IDB_QUOTA_WARNING");
  });

  it("使用率 80〜95% で削除できる Blob がなければ、警告だけ付けて none", async () => {
    // Arrange
    stubStorage({ ratios: [0.9] });
    const { chunkStore, meetingId } = await seedChunks(["BACKEND_UNAVAILABLE"]);
    const health = createInitialHealth("running");
    // Act
    const action = await enforceQuota(chunkStore, meetingId, health);
    // Assert
    expect(action).toBe("none");
    expect(health.degradedReasons).toEqual(["IDB_QUOTA_WARNING"]);
    expect(await blobKept(chunkStore, meetingId)).toEqual([true]);
  });

  it("使用率 95% 以上で削除できる Blob がなければ、エクスポートを要求する", async () => {
    // Arrange
    stubStorage({ ratios: [0.97] });
    const { chunkStore, meetingId } = await seedChunks(["BACKEND_UNAVAILABLE", "LOCAL_SAVE_PENDING"]);
    const health = createInitialHealth("running");
    health.degradedReasons = ["IDB_QUOTA_WARNING"];
    // Act
    const action = await enforceQuota(chunkStore, meetingId, health);
    // Assert：警告は重複させない
    expect(action).toBe("export_required");
    expect(health.degradedReasons).toEqual(["IDB_QUOTA_WARNING"]);
    expect(await blobKept(chunkStore, meetingId)).toEqual([true, true]);
  });
});
