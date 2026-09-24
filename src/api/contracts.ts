// src/api/contracts.ts
import type { AudioSource, ChunkTimingMetadata, LocalBackendCapabilities } from "../types/recording";

export interface HealthResponse {
  readonly status: "ok" | "degraded";
  readonly service: "minutes-local";
  /** 認証済みのときだけ含まれる */
  readonly capabilities?: LocalBackendCapabilities;
}

export interface CreateMeetingRequest {
  readonly meetingId: string;
  readonly title: string;
  readonly sessionStartEpochMs: number;
  readonly nativeSampleRate: number;
  readonly consentConfirmedAt: number;
}

export interface MeetingResponse {
  readonly meetingId: string;
  readonly status: "created" | "recording" | "finalizing" | "finalized";
  readonly dataPath: string;
}

export interface ChunkResponse {
  readonly meetingId: string;
  readonly source: AudioSource;
  readonly sequenceNo: number;
  /** サーバーが受信バイト列から再計算した値。ブラウザはこれを送信前の値と比較する。 */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly path: string;
  /** SQLite audio_chunks への登録が同一トランザクションで完了したら true */
  readonly registered: boolean;
}

export interface ChunkListResponse {
  readonly meetingId: string;
  readonly chunks: ReadonlyArray<{
    readonly source: AudioSource;
    readonly sequenceNo: number;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly registered: boolean;
  }>;
}

export interface FinalizeRequest {
  readonly expectedChunkCounts: Readonly<Record<AudioSource, number>>;
  readonly endedAtEpochMs: number;
  readonly totalAudioFrames: number;
}

export interface FinalizeResponse {
  readonly meetingId: string;
  readonly status: "finalized";
  readonly registeredChunkCounts: Readonly<Record<AudioSource, number>>;
}

export interface ApiErrorBody {
  readonly error: string;
  readonly code:
    | "UNAUTHORIZED"
    | "NOT_FOUND"
    | "CONFLICT_HASH_MISMATCH"
    | "CONFLICT_CHUNKS_MISSING"
    | "VALIDATION"
    | "INSUFFICIENT_STORAGE"
    | "INTERNAL";
  readonly detail?: string;
}

/**
 * 検証するのは全経路で共通して必要な 3 フィールドに限る。`meetingId` / `source` / `sequenceNo` /
 * `path` は一覧応答（`ChunkListResponse.chunks`、Phase 3 §6）では省かれうるため、
 * ここで必須にはしない。送信応答の同一性と `path` の型は §18 の `interpret()` が確かめる。
 */
export function isChunkResponse(value: unknown): value is ChunkResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sha256 === "string" && typeof v.sizeBytes === "number" && typeof v.registered === "boolean";
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.status === "ok" || v.status === "degraded") && v.service === "minutes-local";
}

/** ChunkTimingMetadata を X-Chunk-Meta ヘッダ用に Base64URL 化する（ヘッダに非 ASCII を載せない）。 */
export function encodeChunkMetaHeader(meta: ChunkTimingMetadata): string {
  const json = JSON.stringify(meta);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** GET /v1/meetings/{id}/chunks の応答。各要素は isChunkResponse の 3 フィールドに加え、照合キー（source / sequenceNo）を必須にする。 */
export function isChunkListResponse(value: unknown): value is ChunkListResponse {
  if (typeof value !== "object" || value === null) return false;
  const chunks = (value as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return false;
  return chunks.every((c: unknown) => {
    if (!isChunkResponse(c)) return false;
    const v = c as unknown as Record<string, unknown>;
    return (v.source === "mic" || v.source === "system") && typeof v.sequenceNo === "number";
  });
}
