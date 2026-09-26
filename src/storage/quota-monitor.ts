// src/storage/quota-monitor.ts
import type { ChunkStore } from "./idb";
import type { LocalStorageQuota, RecordingHealth } from "../types/recording";

export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CRITICAL_RATIO = 0.95;

export async function requestPersistence(health: RecordingHealth): Promise<boolean | null> {
  if (typeof navigator.storage?.persist !== "function") {
    health.storagePersisted = null;
    return null;
  }
  const granted = await navigator.storage.persist();
  health.storagePersisted = granted;
  return granted;
}

export async function estimateQuota(): Promise<LocalStorageQuota | null> {
  if (typeof navigator.storage?.estimate !== "function") return null;
  const est = await navigator.storage.estimate();
  const usage = est.usage ?? 0;
  const quota = est.quota ?? 0;
  return { usageBytes: usage, quotaBytes: quota, ratio: quota > 0 ? usage / quota : 0, checkedAt: performance.now() };
}

export type QuotaAction = "none" | "dropped_registered_blobs" | "export_required";

/**
 * Chunk 保存ごとに呼ぶ。
 * 段階1: ratio >= 0.8 → DB_REGISTERED の Blob を sequenceNo 昇順に削除
 * 段階2: ratio >= 0.95 かつ削除対象なし → エクスポートを要求
 */
export async function enforceQuota(chunkStore: ChunkStore, meetingId: string, health: RecordingHealth): Promise<QuotaAction> {
  const quota = await estimateQuota();
  if (quota === null) return "none";
  health.storageUsageRatio = quota.ratio;

  const reasons = health.degradedReasons.filter((r) => r !== "IDB_QUOTA_WARNING");
  if (quota.ratio < QUOTA_WARN_RATIO) {
    health.degradedReasons = reasons;
    return "none";
  }
  health.degradedReasons = [...reasons, "IDB_QUOTA_WARNING"];

  const chunks = await chunkStore.listByMeeting(meetingId, "mic");
  const droppable = chunks.filter((c) => c.save.status === "DB_REGISTERED" && c.wav !== null);
  if (droppable.length > 0) {
    // 古いものから、使用率が閾値を下回るまで削除する
    for (const c of droppable) {
      await chunkStore.dropBlob(c.chunkKey);
      const again = await estimateQuota();
      if (again !== null && again.ratio < QUOTA_WARN_RATIO) break;
    }
    return "dropped_registered_blobs";
  }
  return quota.ratio >= QUOTA_CRITICAL_RATIO ? "export_required" : "none";
}
