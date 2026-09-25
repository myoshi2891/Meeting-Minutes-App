# 議事録Webアプリケーション Phase 2 詳細設計書 ── ブラウザ側（TypeScript）

**対象:** Phase 1 詳細設計書（`design-local-phase1.md`）のブラウザ側コードを前提に、Phase 2 で追加・変更するファイルの実装コードとテストコード。
**上位文書:** Phase 2 基本設計書（`design-local-phase2.md`）§14・§16〜§19。
**対となる文書:** Phase 2 詳細設計書 ── サーバー側（`design-local-phase2-server.md`）。API 契約はそちらの §21 と 1 対 1。
**制約:** ブラウザ標準 API（`MediaStream` / `AudioContext` / `AudioWorklet` / `IndexedDB` / `fetch` / `EventSource`）と TypeScript のみ。UI フレームワークは本書で選定せず、状態モデル（§11）をフレームワーク非依存の reducer として定義する。
**検証状態:** 本書の全 `typescript` コードブロック（17 ファイル）は Phase 1 のコードと同じツリーに抽出され、`tsc --noEmit`（strict）を通過し、Phase 1 の 11 テストと本書の 23 テスト（計 11 ファイル 34 件）が Node 22 + Vitest で全件通過することを設計時点で確認している（§12）。

---

# 1. 目的と範囲、Phase 1 ファイルの変更一覧

Phase 2 のブラウザ側の責務は次の 3 つである。

1. System Audio を 2 系統目の `pcm-chunker` として録音し、Mic と同じ経路で保存する（基本設計 §16）
2. サーバーの処理結果（transcript / summary / jobs）を SSE と型付き fetch で受け取り、UI 状態に反映する（基本設計 §14・§18）
3. 利用者所有の手動ノートを、サーバー未起動時も失わずに保存する（基本設計 §19）

## 1.1 Phase 1 ファイルの変更一覧（基本設計 §17 の確定版）

| ファイル | 種別 | 内容 | 本書 |
| --- | --- | --- | --- |
| `src/types/recording.ts` | 変更（追加のみ） | `DegradedReason` に 2 値追加、`ChunkTimingMetadata.frameClockDriftMs?` 追加 | §2 |
| `src/recording/recording-controller.ts` | 変更 | `source` をコンストラクタ引数化。`start()` に会議登録の有無を渡す。`frameClockDriftMs` をメタデータに載せる | §4 |
| `src/recording/finalizer.ts` | 変更 | mic / system の両方を検証し、`expectedChunkCounts.system` に実数を入れる | §7 |
| `src/api/contracts.ts` | 変更なし | Phase 1 §12 の契約は不変 | — |
| `src/api/contracts-phase2.ts` | 新規 | 基本設計 §7.1・§14 の型 | §3 |
| `src/api/contracts-summary.ts` | 新規 | 基本設計 §12.4 の型 | §3 |
| `src/recording/system-audio.ts` | 新規 | `getDisplayMedia` と track 監視 | §5 |
| `src/recording/multi-source-recorder.ts` | 新規 | 2 Controller の束ねとドリフト差の計測 | §6 |
| `src/api/events.ts` | 新規 | SSE クライアント（`fetch` + `ReadableStream` で Bearer 認証。`EventSource` は使わない） | §8 |
| `src/api/phase2-client.ts` | 新規 | 型付き fetch | §9 |
| `src/notes/notes-store.ts` | 新規 | ノートの Autosave | §10 |
| `src/ui/state.ts` | 新規 | UI 状態 reducer | §11 |
| `src/worklet/pcm-chunker.worklet.ts`、`src/audio/wav.ts`、`src/storage/idb.ts`、`src/api/local-saver.ts`、`src/recording/local-save-scheduler.ts`、`src/api/backend-health-monitor.ts` | 変更なし | — | — |

変更禁止の根拠は基本設計 §2（WAV 生成・IndexedDB スキーマ・Phase 1 API 契約の不変）である。`src/storage/idb.ts` の `DB_VERSION` は 1 のままとする。

---

# 2. `src/types/recording.ts` の差分

Phase 1 §7 のファイル全体のうち、変更は 2 箇所である。抽出可能なように全文を再掲し、変更箇所に `// Phase 2:` コメントを付す。

```typescript
// src/types/recording.ts
// Phase 1 の型定義一式に Phase 2 の追加を加えたもの。変更箇所は「Phase 2:」コメントの 2 行のみ。

export interface AudioPipelineConfig {
  readonly targetSampleRate: 16000;
  readonly channels: 1;
  readonly bitDepth: 16;
  readonly chunkDurationMs: 30000;
  readonly samplesPerChunk: 480000;
}

export const AUDIO_PIPELINE_CONFIG: AudioPipelineConfig = {
  targetSampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  chunkDurationMs: 30000,
  samplesPerChunk: 480000,
};

export interface SessionClock {
  readonly sessionStartEpochMs: number;
  readonly performanceTimeOrigin: number;
  readonly sessionStartPerformanceMs: number;
  readonly audioContextStartTime: number;
  readonly nativeSampleRate: number;
  audioFrameCount: number;
}

export type AudioSource = "mic" | "system";

export interface ChunkTimingMetadata {
  readonly meetingId: string;
  readonly source: AudioSource;
  readonly sequenceNo: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly wallClockStartEpochMs: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly vadScore: number;
  readonly hasVoice: boolean;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Phase 2: Chunk 生成時点の音声時計と performance 時計の差（基本設計 §16.3）。Phase 1 サーバーは無視する。 */
  readonly frameClockDriftMs?: number;
}

export interface VADConfig {
  readonly threshold: number;
  readonly minSpeechMs: number;
  readonly hangoverMs: number;
  readonly floorDbfs: number;
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  threshold: 0.15,
  minSpeechMs: 200,
  hangoverMs: 300,
  floorDbfs: -60,
};

export interface VADResult {
  readonly score: number;
  readonly hasVoice: boolean;
  readonly voicedSamples: number;
}

export interface RecordingHealth {
  lastAudioFrameAt: number;
  lastChunkAt: number;
  lastSuccessfulLocalSaveAt: number;
  lastBackendHealthCheckAt: number;
  frameClockDriftMs: number;
  storagePersisted: boolean | null;
  storageUsageRatio: number | null;
  pendingChunkCount: number;
  audioContextState: AudioContextState;
  degradedReasons: ReadonlyArray<DegradedReason>;
}

export type DegradedReason =
  | "AUDIO_CONTEXT_SUSPENDED"
  | "AUDIO_CONTEXT_CLOSED"
  | "NO_AUDIO_FRAMES"
  | "BACKEND_UNREACHABLE"
  | "BACKEND_DEGRADED"
  | "BACKEND_UNAUTHORIZED"
  | "IDB_QUOTA_WARNING"
  | "IDB_QUOTA_EXHAUSTED"
  | "STORAGE_NOT_PERSISTED"
  | "MIC_TRACK_ENDED"
  /** Phase 2: System Audio 系統の終了・取得不可。録音（Mic）は継続する。 */
  | "SYSTEM_TRACK_ENDED"
  | "SYSTEM_UNAVAILABLE";

export type LocalSaveStatus =
  | "GENERATED"
  | "IDB_STORED"
  | "LOCAL_SAVE_PENDING"
  | "SAVING"
  | "SAVED"
  | "DB_REGISTERED"
  | "LOCAL_SAVE_FAILED"
  | "RETRYING"
  | "BACKEND_UNAVAILABLE";

export type SavedVia = "api" | "fsa";

export interface LocalSaveState {
  status: LocalSaveStatus;
  savedVia: SavedVia | null;
  attempts: number;
  nextRetryAt: number | null;
  lastError: LocalSaveError | null;
  serverPath: string | null;
  updatedAt: number;
}

export interface LocalSaveError {
  readonly kind: LocalSaveErrorKind;
  readonly message: string;
  readonly httpStatus: number | null;
  readonly at: number;
}

export type LocalSaveErrorKind =
  | "NETWORK"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "HASH_MISMATCH"
  | "SERVER"
  | "STORAGE_FULL"
  | "VALIDATION"
  | "UNKNOWN";

export type LocalBackendStatus = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNREACHABLE";

export interface LocalBackendHealth {
  status: LocalBackendStatus;
  lastCheckedAt: number;
  lastHealthyAt: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  capabilities: LocalBackendCapabilities | null;
  unauthorized: boolean;
}

export interface LocalBackendCapabilities {
  readonly service: "minutes-local";
  readonly version: string;
  readonly dataDir: string;
  readonly freeDiskBytes: number;
  readonly gpu: { readonly available: boolean; readonly name: string | null; readonly vramBytes: number | null };
  readonly cpuCores: number;
  readonly totalMemoryBytes: number;
  readonly sttModel: string | null;
  readonly llmModel: string | null;
  readonly maxConcurrentStt: number;
}

export interface LocalStorageQuota {
  readonly usageBytes: number;
  readonly quotaBytes: number;
  readonly ratio: number;
  readonly checkedAt: number;
}

export type MeetingStatus = "created" | "recording" | "stop_requested" | "finalizing" | "finalized";

export interface MeetingRecord {
  readonly meetingId: string;
  title: string;
  status: MeetingStatus;
  readonly sessionClock: SessionClock;
  readonly consentConfirmedAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  finalChunkCount: number | null;
}

export interface AudioChunkRecord {
  readonly chunkKey: string;
  readonly meta: ChunkTimingMetadata;
  save: LocalSaveState;
  wav: Blob | null;
  readonly createdAt: number;
}

export type WorkletCommand =
  | { readonly type: "configure"; readonly vad: VADConfig }
  | { readonly type: "start" }
  /** requestId は flushed で同じ値が返る（Phase 1 §7）。 */
  | { readonly type: "flush"; readonly requestId: number }
  | { readonly type: "stop"; readonly requestId: number };

export type WorkletEvent =
  | { readonly type: "ready"; readonly nativeSampleRate: number; readonly renderQuantum: number }
  | {
      readonly type: "chunk";
      readonly pcm: ArrayBuffer;
      readonly sampleCount: number;
      readonly startFrame: number;
      readonly endFrame: number;
      readonly vad: VADResult;
      readonly partial: boolean;
    }
  | { readonly type: "heartbeat"; readonly audioFrameCount: number; readonly currentTime: number }
  | { readonly type: "flushed"; readonly requestId: number; readonly audioFrameCount: number };

export function isWorkletEvent(value: unknown): value is WorkletEvent {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === "ready" || t === "chunk" || t === "heartbeat" || t === "flushed";
}
```

---

# 3. Phase 2 契約型 `src/api/contracts-phase2.ts` / `src/api/contracts-summary.ts`

基本設計 §7.1・§12.4・§14 を統合した確定版。サーバー側 §21 のレスポンスと 1 対 1。

```typescript
// src/api/contracts-summary.ts
export interface SummaryTopic {
  readonly title: string;
  readonly description: string;
  readonly sourceSegmentIds: ReadonlyArray<string>;
}

/** quote が引用元セグメント本文のどこにあるかを示す半開区間 [start, end)（v4.0 §66.1）。 */
export interface EvidenceSpan {
  readonly segmentId: string;
  readonly start: number;
  readonly end: number;
}

export interface SummaryActionItem {
  readonly task: string;
  readonly assignee: string | null;
  readonly deadline: string | null;
  readonly sourceSegmentIds: ReadonlyArray<string>;
  /** 引用元セグメント本文からの逐語引用。サーバー側で位置と逐語一致を検証済み（v4.0 §66.2）。 */
  readonly quote: string;
  readonly evidenceSpan: EvidenceSpan;
}

export interface SummaryDecision {
  readonly text: string;
  readonly sourceSegmentIds: ReadonlyArray<string>;
  readonly quote: string;
  readonly evidenceSpan: EvidenceSpan;
}

export interface MeetingSummaryDraft {
  readonly summary: string;
  readonly topics: ReadonlyArray<SummaryTopic>;
  readonly decisions: ReadonlyArray<SummaryDecision>;
  readonly actionItems: ReadonlyArray<SummaryActionItem>;
}

export type RejectionReason =
  | "SEGMENT_ID_NOT_FOUND"
  | "SEGMENT_ID_EMPTY"
  | "ASSIGNEE_NOT_IN_TRANSCRIPT"
  | "DEADLINE_NOT_IN_TRANSCRIPT"
  | "DUPLICATE"
  | "QUOTE_NOT_VERBATIM"
  | "EVIDENCE_SPAN_MISMATCH"
  | "CLAIM_NOT_SUPPORTED";

export interface RejectedItem {
  readonly kind: "topic" | "decision" | "actionItem";
  readonly item: SummaryTopic | SummaryDecision | SummaryActionItem;
  readonly reasons: ReadonlyArray<RejectionReason>;
}

export interface MeetingSummary extends MeetingSummaryDraft {
  readonly rejected: ReadonlyArray<RejectedItem>;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly transcriptVersion: number;
  readonly generatedAt: number;
  readonly modelCaveats: ReadonlyArray<string>;
}

export interface SummaryValidationReport {
  readonly schemaValid: boolean;
  readonly schemaRetries: number;
  readonly mapWindows: number;
  readonly totalItems: number;
  readonly rejectedItems: number;
  readonly unresolvedSegmentIds: ReadonlyArray<string>;
}

export function isMeetingSummary(value: unknown): value is MeetingSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.summary === "string" && Array.isArray(v.topics) && Array.isArray(v.rejected) && typeof v.modelName === "string";
}
```

```typescript
// src/api/contracts-phase2.ts
import type { LocalBackendCapabilities } from "../types/recording";
import type { MeetingSummary, SummaryValidationReport } from "./contracts-summary";

export type HardwareTier = "gpu_large" | "gpu_medium" | "gpu_small" | "cpu_only";

export interface SttModelInfo {
  readonly name: string;
  readonly computeType: "float16" | "int8_float16" | "int8";
  readonly estimatedMemoryBytes: number;
  readonly installed: boolean;
}

export interface LlmModelInfo {
  readonly name: string;
  readonly parameterSizeB: number | null;
  readonly quantization: string | null;
  readonly estimatedMemoryBytes: number | null;
}

export interface LocalBackendCapabilitiesV2 extends LocalBackendCapabilities {
  readonly tier: HardwareTier;
  readonly availableSttModels: ReadonlyArray<SttModelInfo>;
  readonly availableLlmModels: ReadonlyArray<LlmModelInfo>;
  readonly ollamaReachable: boolean;
  readonly allowConcurrentSttAndLlm: boolean;
}

export type JobType = "vad_chunk" | "transcribe_chunk" | "merge_transcript" | "synthesize_minutes";
export type JobStatus = "pending" | "leased" | "processing" | "retrying" | "completed" | "failed" | "cancelled";
export type JobErrorClass =
  | "OOM" | "MODEL_MISSING" | "INVALID_AUDIO" | "PROVIDER_UNREACHABLE"
  | "SCHEMA_VALIDATION" | "BUSINESS_VALIDATION" | "TIMEOUT" | "INTERNAL";

export type MeetingStatusV2 =
  | "created" | "recording" | "finalizing" | "finalized"
  | "transcribing" | "transcribed" | "summarizing" | "completed" | "failed";

export interface JobSummary {
  readonly jobId: string;
  readonly jobType: JobType;
  readonly status: JobStatus;
  readonly chunkId: string | null;
  readonly attempts: number;
  readonly errorClass: JobErrorClass | null;
  readonly lastError: string | null;
  readonly modelName: string | null;
  readonly durationMs: number | null;
  readonly updatedAt: number;
}

export interface JobListResponse {
  readonly meetingId: string;
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly counts: Readonly<Record<JobStatus, number>>;
}

export type SttStatus = "pending" | "queued" | "processing" | "completed" | "skipped" | "failed";

export interface MeetingDetailResponse {
  readonly meetingId: string;
  readonly title: string;
  readonly status: MeetingStatusV2;
  readonly chunkCounts: Readonly<Record<"mic" | "system", number>>;
  readonly sttStatusCounts: Readonly<Record<SttStatus, number>>;
  readonly transcriptVersion: number;
  readonly latestSummaryVersion: number | null;
  readonly sttModelUsed: string | null;
  readonly llmModelUsed: string | null;
  readonly syncDriftMs: { readonly p95: number; readonly p99: number } | null;
}

export interface TranscriptSegmentView {
  readonly id: string;
  readonly source: "mic" | "system";
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly confidence: number | null;
  readonly language: string | null;
  readonly chunkSequenceNo: number;
  readonly speakerId: string | null;
}

export interface TranscriptGap {
  readonly source: "mic" | "system";
  readonly startMs: number;
  readonly endMs: number;
}

export interface TranscriptResponse {
  readonly meetingId: string;
  readonly transcriptVersion: number;
  readonly segments: ReadonlyArray<TranscriptSegmentView>;
  readonly gaps: ReadonlyArray<TranscriptGap>;
}

export interface SummaryResponse {
  readonly meetingId: string;
  readonly version: number;
  readonly summary: MeetingSummary;
  readonly validation: SummaryValidationReport;
}

export interface NotesResponse {
  readonly meetingId: string;
  readonly blocknoteJson: unknown;
  readonly revision: number;
  readonly lastAppliedSummaryVersion: number | null;
}

export interface ModelsResponse {
  readonly stt: ReadonlyArray<{ readonly name: string; readonly installed: boolean; readonly selected: boolean; readonly recommended: boolean }>;
  readonly llm: ReadonlyArray<{ readonly name: string; readonly selected: boolean; readonly recommended: boolean }>;
  readonly ollamaReachable: boolean;
}

export type MeetingEvent =
  | { readonly type: "job"; readonly job: JobSummary }
  | { readonly type: "meeting_status"; readonly status: MeetingStatusV2 }
  | { readonly type: "transcript_version"; readonly transcriptVersion: number }
  | { readonly type: "summary_version"; readonly version: number }
  | { readonly type: "progress"; readonly jobType: JobType; readonly done: number; readonly total: number };

const JOB_TYPES: ReadonlyArray<string> = ["vad_chunk", "transcribe_chunk", "merge_transcript", "synthesize_minutes"];
const MEETING_STATUSES: ReadonlyArray<string> = [
  "created", "recording", "finalizing", "finalized",
  "transcribing", "transcribed", "summarizing", "completed", "failed",
];

/**
 * 判別子だけでなく、その種別が必要とするフィールドまで検証する。
 * SSE は外部入力であり、type だけ見て通すと `{ type: "job" }` が reducer に届いて
 * applyEvent が `event.job.jobId` で落ちる。型述語は「検証済み」の宣言なので中身まで見る。
 */
export function isMeetingEvent(value: unknown): value is MeetingEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "job":
      return typeof v.job === "object" && v.job !== null && typeof (v.job as { jobId?: unknown }).jobId === "string";
    case "meeting_status":
      return typeof v.status === "string" && MEETING_STATUSES.includes(v.status);
    case "transcript_version":
      return typeof v.transcriptVersion === "number";
    case "summary_version":
      return typeof v.version === "number";
    case "progress":
      return typeof v.jobType === "string" && JOB_TYPES.includes(v.jobType)
        && typeof v.done === "number" && typeof v.total === "number";
    default:
      return false;
  }
}

/** サーバー側 §13.2：JobRunner が publish する job は snake_case の DB 行なので、ここで camelCase に変換する。 */
export function jobFromServerRow(row: Record<string, unknown>): JobSummary | null {
  const id = row.id ?? row.jobId;
  const jobType = row.job_type ?? row.jobType;
  const status = row.status;
  if (typeof id !== "string" || typeof jobType !== "string" || typeof status !== "string") return null;
  return {
    jobId: id,
    jobType: jobType as JobType,
    status: status as JobStatus,
    chunkId: typeof row.chunk_id === "string" ? row.chunk_id : typeof row.chunkId === "string" ? row.chunkId : null,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    errorClass: (row.error_class ?? row.errorClass ?? null) as JobErrorClass | null,
    lastError: (row.last_error ?? row.lastError ?? null) as string | null,
    modelName: (row.model_name ?? row.modelName ?? null) as string | null,
    durationMs: (row.duration_ms ?? row.durationMs ?? null) as number | null,
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}
```

サーバー側 §13.2 の `JobRunner._publish_job` は `job.model_dump()`（snake_case）をそのまま publish し、REST の `GET /jobs` は `job_view`（camelCase）を返す。この不一致は SSE クライアント（§8）が `jobFromServerRow` で吸収する。サーバー側で統一する方が望ましいが、Phase 1 API 契約と同様に「追加のみ」の原則を守るため、ブラウザ側の変換で対応する（**基本設計 §14 からの補足**）。

---

# 4. `src/recording/recording-controller.ts` の変更

変更点は 4 つ。(1) `source` をコンストラクタ引数に、(2) `start()` に `registerMeeting` を追加（System 側は会議レコードを作らない）、(3) `start()` に `timelineOriginEpochMs` を追加し、`startOffsetMs` / `endOffsetMs` を会議タイムライン（Mic の `sessionStartEpochMs`）基準へ正規化する（基本設計 §16.2）、(4) `frameClockDriftMs` をメタデータに載せる。それ以外は Phase 1 §15 と同一（`requestId` による `flushed` の対応付けとタイムアウト、書き込み失敗時のメモリ待機を含む）。

`stop()` の最後の会議レコード保存だけは Phase 1 と形が違う。Phase 1 は Controller が会議レコードを保持し、その `sessionClock` が Controller の時計と同じオブジェクトなので、保存し直すだけで最終 `audioFrameCount` が残る。Phase 2 は `registerMeeting` のため会議レコードを IndexedDB から読み直すので、別オブジェクトになる。そこで Mic 側は、最終 Chunk の書き込み完了後に会議レコードを読み直し、Controller の `SessionClock` を写した新しいオブジェクトとして保存する。`sessionClock` は `readonly` なので、書き換えずに置き換える。System 側は会議レコードを持たないので何もしない。

```typescript
// src/recording/recording-controller.ts
import {
  AUDIO_PIPELINE_CONFIG,
  DEFAULT_VAD_CONFIG,
  isWorkletEvent,
  type AudioChunkRecord,
  type AudioSource,
  type ChunkTimingMetadata,
  type MeetingRecord,
  type RecordingHealth,
  type SessionClock,
  type WorkletCommand,
  type WorkletEvent,
} from "../types/recording";
import { computeFrameClockDriftMs, createSessionClock, frameToOffsetMs } from "./session-clock";
import { buildStandaloneWav } from "../audio/wav";
import { ChunkStore, MeetingStore, isQuotaExceeded } from "../storage/idb";
import type { LocalSaveScheduler } from "./local-save-scheduler";

export interface RecordingControllerDeps {
  readonly audioContext: AudioContext;
  readonly mediaStream: MediaStream;
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly scheduler: LocalSaveScheduler;
  readonly health: RecordingHealth;
  readonly workletModuleUrl: string;
  readonly onError: (error: Error) => void;
  /** flush / stop の応答待ちタイムアウト用。既定は setTimeout（Phase 1 §15 と同じ） */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

/** Worklet が flush / stop に応答しないときに待機を打ち切るまでの時間（Phase 1 §15 と同じ） */
const FLUSH_TIMEOUT_MS = 5_000;

export interface StartOptions {
  /** Phase 2: System 側は false。会議レコードは Mic 側が 1 回だけ作る。 */
  readonly registerMeeting?: boolean;
  /**
   * 会議タイムラインの原点（= Mic の sessionStartEpochMs）。基本設計 §16.2。
   * System 側は Mic の値を受け取り、start/end オフセットを Mic 基準へ揃える。
   * 未指定なら自身の sessionStartEpochMs を原点とする（Mic 側。Phase 1 と同じ値になる）。
   */
  readonly timelineOriginEpochMs?: number;
}

export function makeChunkKey(meetingId: string, source: AudioSource, sequenceNo: number): string {
  return `${meetingId}:${source}:${sequenceNo.toString().padStart(6, "0")}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class RecordingController {
  private node: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private clock: SessionClock | null = null;
  private meetingId: string | null = null;
  private timelineOriginEpochMs = 0;
  private nextSequenceNo = 0;
  private readonly memoryBacklog: AudioChunkRecord[] = [];
  private chunkQueue: Promise<void> = Promise.resolve();
  /** requestId → flushed 待機（Phase 1 §15 と同じ） */
  private readonly flushWaiters = new Map<number, () => void>();
  private nextRequestId = 0;

  constructor(private readonly deps: RecordingControllerDeps, readonly source: AudioSource = "mic") {}

  get sessionClock(): SessionClock | null {
    return this.clock;
  }

  get chunkCount(): number {
    return this.nextSequenceNo;
  }

  async start(meetingId: string, title: string, consentConfirmedAt: number, options: StartOptions = {}): Promise<void> {
    const { audioContext, mediaStream, workletModuleUrl } = this.deps;
    await audioContext.audioWorklet.addModule(workletModuleUrl);
    this.clock = createSessionClock(audioContext);
    this.meetingId = meetingId;
    // Mic は自身が原点。System は Mic の原点を受け取り、両 source の start_offset_ms を
    // 同じ基準に揃える（§11.4 の start_ms 順マージが成立する前提、基本設計 §16.2）。
    this.timelineOriginEpochMs = options.timelineOriginEpochMs ?? this.clock.sessionStartEpochMs;

    if (options.registerMeeting !== false) {
      const meeting: MeetingRecord = {
        meetingId,
        title,
        status: "recording",
        sessionClock: this.clock,
        consentConfirmedAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: null,
        finalChunkCount: null,
      };
      await this.deps.meetingStore.put(meeting);
    }

    const node = new AudioWorkletNode(audioContext, "pcm-chunker", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isWorkletEvent(event.data)) return;
      this.handleWorkletEvent(event.data);
    };
    this.sourceNode = audioContext.createMediaStreamSource(mediaStream);
    this.sourceNode.connect(node);
    this.node = node;

    const endedReason = this.source === "mic" ? "MIC_TRACK_ENDED" : "SYSTEM_TRACK_ENDED";
    for (const track of mediaStream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!this.deps.health.degradedReasons.includes(endedReason)) {
          this.deps.health.degradedReasons = [...this.deps.health.degradedReasons, endedReason];
        }
      });
    }

    this.post({ type: "configure", vad: DEFAULT_VAD_CONFIG });
    this.post({ type: "start" });
  }

  async flush(): Promise<void> {
    if (this.node === null) return;
    await this.requestFlush("flush");
    await this.chunkQueue;
  }

  async stop(): Promise<void> {
    if (this.node === null || this.meetingId === null) return;
    try {
      if (this.source === "mic") {
        const meeting = await this.deps.meetingStore.get(this.meetingId);
        if (meeting !== undefined) {
          meeting.status = "stop_requested";
          await this.deps.meetingStore.put(meeting);
        }
      }
      await this.requestFlush("stop");
      await this.chunkQueue;
      if (this.source === "mic" && this.clock !== null) {
        // flush 後の最終 audioFrameCount を永続化する（Finalizer が totalAudioFrames として送る値、Phase 1 §15）。
        // 会議レコードは IDB から読み直した別オブジェクトなので、Controller の SessionClock を写して保存し直す
        const meeting = await this.deps.meetingStore.get(this.meetingId);
        if (meeting !== undefined) {
          await this.deps.meetingStore.put({ ...meeting, sessionClock: { ...this.clock }, updatedAt: Date.now() });
        }
      }
    } finally {
      // 途中で reject してもマイク／画面共有トラックと Worklet を解放する（Phase 1 §15 と同じ）
      this.sourceNode?.disconnect();
      if (this.node !== null) this.node.port.onmessage = null;
      this.node = null;
      for (const track of this.deps.mediaStream.getAudioTracks()) track.stop();
    }
  }

  async drainMemoryBacklog(): Promise<number> {
    let drained = 0;
    while (this.memoryBacklog.length > 0) {
      const record = this.memoryBacklog[0];
      try {
        await this.deps.chunkStore.putChunk(record);
      } catch (error) {
        if (isQuotaExceeded(error)) break;
        throw error;
      }
      this.memoryBacklog.shift();
      record.save.status = "IDB_STORED";
      await this.deps.scheduler.enqueue(record.chunkKey);
      drained++;
    }
    return drained;
  }

  get memoryBacklogCount(): number {
    return this.memoryBacklog.length;
  }

  /** flush / stop を送り、同じ requestId の flushed を待つ。応答がなければタイムアウトで onError を通知して打ち切る（Phase 1 §15 と同じ）。 */
  private requestFlush(type: "flush" | "stop"): Promise<void> {
    const requestId = ++this.nextRequestId;
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    return new Promise<void>((resolve) => {
      this.flushWaiters.set(requestId, resolve);
      setTimer(() => {
        if (!this.flushWaiters.delete(requestId)) return;
        this.deps.onError(new Error(`${this.source} worklet did not respond to ${type} within ${FLUSH_TIMEOUT_MS}ms`));
        resolve();
      }, FLUSH_TIMEOUT_MS);
      this.post({ type, requestId });
    });
  }

  private post(cmd: WorkletCommand): void {
    this.node?.port.postMessage(cmd);
  }

  private handleWorkletEvent(event: WorkletEvent): void {
    const now = performance.now();
    switch (event.type) {
      case "ready":
        if (this.clock !== null && this.clock.nativeSampleRate !== event.nativeSampleRate) {
          this.deps.onError(new Error(`sampleRate mismatch: main=${this.clock.nativeSampleRate} worklet=${event.nativeSampleRate}`));
        }
        break;
      case "heartbeat":
        this.deps.health.lastAudioFrameAt = now;
        if (this.clock !== null) this.clock.audioFrameCount = event.audioFrameCount;
        break;
      case "chunk":
        this.deps.health.lastAudioFrameAt = now;
        if (this.clock !== null) this.clock.audioFrameCount = event.endFrame;
        this.chunkQueue = this.chunkQueue
          .then(() => this.persistChunk(event))
          .catch((error: unknown) => this.deps.onError(error instanceof Error ? error : new Error(String(error))));
        break;
      case "flushed":
        if (this.clock !== null) this.clock.audioFrameCount = event.audioFrameCount;
        // 要求した requestId の待機だけを解放する（Phase 1 §15 と同じ）
        this.chunkQueue = this.chunkQueue.then(() => {
          const resolve = this.flushWaiters.get(event.requestId);
          this.flushWaiters.delete(event.requestId);
          resolve?.();
        });
        break;
    }
  }

  private async persistChunk(event: Extract<WorkletEvent, { type: "chunk" }>): Promise<void> {
    if (this.meetingId === null || this.clock === null) throw new Error("recording not started");

    const sequenceNo = this.nextSequenceNo++;
    const pcm = new Int16Array(event.pcm, 0, event.sampleCount);
    const wavBuffer = buildStandaloneWav(pcm);
    const sha256 = await sha256Hex(wavBuffer);

    // source ごとに SessionClock が別なので、原点差を足して会議タイムラインへ揃える。
    // Mic は originShiftMs === 0 となり Phase 1 と同じ値になる。durationMs は差分なので影響を受けない。
    const originShiftMs = this.clock.sessionStartEpochMs - this.timelineOriginEpochMs;
    const startOffsetMs = frameToOffsetMs(event.startFrame) + originShiftMs;
    const endOffsetMs = frameToOffsetMs(event.endFrame) + originShiftMs;
    const meta: ChunkTimingMetadata = {
      meetingId: this.meetingId,
      source: this.source,
      sequenceNo,
      startFrame: event.startFrame,
      endFrame: event.endFrame,
      startOffsetMs,
      endOffsetMs,
      wallClockStartEpochMs: this.timelineOriginEpochMs + startOffsetMs,
      sampleRate: AUDIO_PIPELINE_CONFIG.targetSampleRate,
      channels: AUDIO_PIPELINE_CONFIG.channels,
      durationMs: endOffsetMs - startOffsetMs,
      sampleCount: event.sampleCount,
      vadScore: event.vad.score,
      hasVoice: event.vad.hasVoice,
      sha256,
      sizeBytes: wavBuffer.byteLength,
      frameClockDriftMs: computeFrameClockDriftMs(this.clock, performance.now()),
    };

    const record: AudioChunkRecord = {
      chunkKey: makeChunkKey(meta.meetingId, meta.source, sequenceNo),
      meta,
      save: { status: "GENERATED", savedVia: null, attempts: 0, nextRetryAt: null, lastError: null, serverPath: null, updatedAt: performance.now() },
      wav: new Blob([wavBuffer], { type: "audio/wav" }),
      createdAt: Date.now(),
    };

    try {
      await this.deps.chunkStore.putChunk(record);
    } catch (error) {
      // 失敗理由を問わずメモリ待機に残す。sequenceNo は採番済みなので、捨てると欠番になる（Phase 1 §15）
      this.memoryBacklog.push(record);
      if (isQuotaExceeded(error)) {
        if (!this.deps.health.degradedReasons.includes("IDB_QUOTA_EXHAUSTED")) {
          this.deps.health.degradedReasons = [...this.deps.health.degradedReasons, "IDB_QUOTA_EXHAUSTED"];
        }
        return;
      }
      throw error;
    }

    record.save.status = "IDB_STORED";
    await this.deps.chunkStore.updateSaveState(record.chunkKey, (r) => {
      r.save.status = "IDB_STORED";
    });
    this.deps.health.lastChunkAt = performance.now();
    await this.deps.scheduler.enqueue(record.chunkKey);
  }
}
```

---

# 5. System Audio 取得 `src/recording/system-audio.ts`

```typescript
// src/recording/system-audio.ts
// getDisplayMedia による System Audio 取得。取得可否はブラウザ・OS・共有対象に依存し、失敗は Mic-only 継続の契機にする。
import type { RecordingHealth } from "../types/recording";

export type SystemAudioResult =
  | { readonly ok: true; readonly stream: MediaStream; readonly stop: () => void }
  | { readonly ok: false; readonly reason: SystemAudioFailure };

export type SystemAudioFailure =
  | "UNSUPPORTED"          // getDisplayMedia が存在しない
  | "DENIED"               // 利用者がキャンセル / 権限拒否
  | "NO_AUDIO_TRACK"       // 共有ダイアログで音声を外した、または OS が音声を提供しない
  | "ERROR";

export interface SystemAudioDeps {
  readonly getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly health: RecordingHealth;
  readonly onEnded: () => void;
}

export function defaultSystemAudioDeps(health: RecordingHealth, onEnded: () => void): SystemAudioDeps | null {
  const md = navigator.mediaDevices;
  if (md === undefined || typeof md.getDisplayMedia !== "function") return null;
  return { getDisplayMedia: (c) => md.getDisplayMedia(c), health, onEnded };
}

function addReason(health: RecordingHealth, reason: "SYSTEM_UNAVAILABLE" | "SYSTEM_TRACK_ENDED"): void {
  if (!health.degradedReasons.includes(reason)) {
    health.degradedReasons = [...health.degradedReasons, reason];
  }
}

/**
 * user activation 内で呼ぶこと（同意ダイアログの「開始」クリックと同一のイベント内）。
 * video は取得直後に停止し、audio トラックだけを含む MediaStream を返す。
 */
export async function acquireSystemAudio(deps: SystemAudioDeps | null): Promise<SystemAudioResult> {
  if (deps === null) {
    return { ok: false, reason: "UNSUPPORTED" };
  }
  let display: MediaStream;
  try {
    display = await deps.getDisplayMedia({ video: true, audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    addReason(deps.health, "SYSTEM_UNAVAILABLE");
    return { ok: false, reason: name === "NotAllowedError" || name === "AbortError" ? "DENIED" : "ERROR" };
  }
  for (const v of display.getVideoTracks()) v.stop();
  const audioTracks = display.getAudioTracks();
  if (audioTracks.length === 0) {
    addReason(deps.health, "SYSTEM_UNAVAILABLE");
    return { ok: false, reason: "NO_AUDIO_TRACK" };
  }
  const stream = new MediaStream(audioTracks);
  for (const t of audioTracks) {
    t.addEventListener("ended", () => {
      addReason(deps.health, "SYSTEM_TRACK_ENDED");
      deps.onEnded();
    });
  }
  return {
    ok: true,
    stream,
    stop: () => {
      for (const t of audioTracks) t.stop();
    },
  };
}
```

`video: true` を同時に要求するのは、`audio` のみの `getDisplayMedia` を多くのブラウザが拒否するためである（基本設計 §16.1）。この挙動は仕様上の保証ではなく、実装時に対象ブラウザで確認する。

---

# 6. 複数ソース録音 `src/recording/multi-source-recorder.ts`

Mic と System の 2 つの `RecordingController` を束ね、共有 `LocalSaveScheduler` に流し、ドリフト差を計測する。Controller の生成は依存として注入し、テストでは Fake を使う。

```typescript
// src/recording/multi-source-recorder.ts
import type { AudioSource, RecordingHealth, SessionClock } from "../types/recording";
import { computeFrameClockDriftMs } from "./session-clock";

/** RecordingController のうち本クラスが使う面だけを切り出した契約。テストで Fake に差し替える。 */
export interface SourceController {
  readonly source: AudioSource;
  readonly sessionClock: SessionClock | null;
  readonly chunkCount: number;
  start(meetingId: string, title: string, consentConfirmedAt: number, options: { registerMeeting: boolean; timelineOriginEpochMs?: number }): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
}

export interface MultiSourceDeps {
  readonly createController: (source: AudioSource, stream: MediaStream) => SourceController;
  readonly acquireMic: () => Promise<MediaStream>;
  /** null を返したら System なし（Mic-only mode）。 */
  readonly acquireSystem: () => Promise<MediaStream | null>;
  readonly health: RecordingHealth;
  readonly now: () => number;
}

export interface DriftSample {
  readonly atMs: number;
  readonly micDriftMs: number;
  readonly systemDriftMs: number;
  /** mic − system。正なら Mic の音声時計が System より遅れている。 */
  readonly deltaMs: number;
}

export interface DriftStats {
  readonly count: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function driftStats(samples: ReadonlyArray<DriftSample>): DriftStats {
  const abs = samples.map((s) => Math.abs(s.deltaMs)).sort((a, b) => a - b);
  return { count: abs.length, p95: percentile(abs, 95), p99: percentile(abs, 99), max: abs[abs.length - 1] ?? 0 };
}

export class MultiSourceRecorder {
  private mic: SourceController | null = null;
  private system: SourceController | null = null;
  private readonly samples: DriftSample[] = [];

  constructor(private readonly deps: MultiSourceDeps) {}

  get hasSystem(): boolean {
    return this.system !== null;
  }

  get driftSamples(): ReadonlyArray<DriftSample> {
    return this.samples;
  }

  /** user activation 内で呼ぶ。System の取得失敗は Mic-only で継続する（v4.0 §13）。 */
  async start(meetingId: string, title: string, consentConfirmedAt: number): Promise<{ readonly systemEnabled: boolean }> {
    const micStream = await this.deps.acquireMic();
    this.mic = this.deps.createController("mic", micStream);
    // getDisplayMedia は transient user activation を要求する。mic.start() は addModule と
    // IndexedDB 書き込みを待つため、その後で呼ぶと activation が切れて取得に失敗しうる。
    // 呼び出しだけ先に出し、await は mic の初期化後に行う。
    // 生成直後に catch を付けるのは、await するまでの間に reject しても unhandled にしないため。
    const systemPromise = this.deps.acquireSystem().catch(() => null);
    await this.mic.start(meetingId, title, consentConfirmedAt, { registerMeeting: true });

    const systemStream = await systemPromise;
    if (systemStream !== null) {
      this.system = this.deps.createController("system", systemStream);
      await this.system.start(meetingId, title, consentConfirmedAt, {
        registerMeeting: false,
        // System のオフセットを Mic の原点へ揃える（基本設計 §16.2）。
        timelineOriginEpochMs: this.mic.sessionClock?.sessionStartEpochMs,
      });
    }
    return { systemEnabled: this.system !== null };
  }

  /** 30 秒ごと（Chunk 生成時）に呼ぶ。System がなければ何もしない。 */
  sampleDrift(): DriftSample | null {
    if (this.mic === null || this.system === null) return null;
    const micClock = this.mic.sessionClock;
    const sysClock = this.system.sessionClock;
    if (micClock === null || sysClock === null) return null;
    const now = this.deps.now();
    const micDrift = computeFrameClockDriftMs(micClock, now);
    const sysDrift = computeFrameClockDriftMs(sysClock, now);
    const sample: DriftSample = { atMs: now, micDriftMs: micDrift, systemDriftMs: sysDrift, deltaMs: micDrift - sysDrift };
    this.samples.push(sample);
    return sample;
  }

  stats(): DriftStats {
    return driftStats(this.samples);
  }

  async flush(): Promise<void> {
    await Promise.all([this.mic?.flush(), this.system?.flush()]);
  }

  /** System を先に止め、最後に Mic を止める（Mic 側が meeting.status を stop_requested にする）。 */
  async stop(): Promise<{ readonly mic: number; readonly system: number }> {
    if (this.system !== null) await this.system.stop();
    if (this.mic !== null) await this.mic.stop();
    return { mic: this.mic?.chunkCount ?? 0, system: this.system?.chunkCount ?? 0 };
  }

  /** System 系統だけを止める（共有停止時）。Mic は継続。 */
  async dropSystem(): Promise<void> {
    if (this.system === null) return;
    await this.system.stop();
    this.system = null;
  }
}
```

`sequenceNo` は Controller ごとに 0 から採番され、`chunkKey` が `source` を含むため IndexedDB 上で衝突しない（基本設計 §16.2）。

---

# 7. `src/recording/finalizer.ts` の変更

mic / system の両方を検証する。System なしの会議は `expectedChunkCounts.system = 0`。会議の状態の検査（`finalized` なら POST せず成功を返す、`stop_requested` / `finalizing` 以外は `verify` で失敗させる）と、`GET /chunks` の応答を `isChunkListResponse` に通す検査は Phase 1 §22 と同じ。

```typescript
// src/recording/finalizer.ts
import type { ChunkStore, MeetingStore } from "../storage/idb";
import type { LocalSaveScheduler } from "./local-save-scheduler";
import { isChunkListResponse, type FinalizeRequest } from "../api/contracts";
import { assertLocalHost } from "../api/local-saver";
import type { AudioSource } from "../types/recording";

export interface FinalizerDeps {
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly scheduler: LocalSaveScheduler;
  readonly baseUrl: string;
  readonly token: string;
  /** 既定 10000。ローカルサーバー相手でも無期限には待たない（Phase 1 §17.1 と同じ方針）。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** mic / system 両 Controller の memoryBacklogCount の合計。0 でない限り Barrier を通さない（Phase 1 §22）。 */
  readonly unpersistedChunkCount: () => number;
}

/** AbortController でタイムアウトさせる。fetch 自身にタイムアウトはない。 */
async function fetchWithTimeout(fetchImpl: typeof fetch, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === "AbortError") return `TIMEOUT after ${timeoutMs}ms`;
  return error instanceof Error ? error.message : String(error);
}

export type FinalizeResult =
  | { readonly ok: true; readonly counts: Readonly<Record<AudioSource, number>> }
  | { readonly ok: false; readonly stage: "waiting_local_save" | "verify" | "finalize"; readonly detail: string };

const SOURCES: ReadonlyArray<AudioSource> = ["mic", "system"];

export async function finalizeMeeting(deps: FinalizerDeps, meetingId: string): Promise<FinalizeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const meeting = await deps.meetingStore.get(meetingId);
  if (meeting === undefined) return { ok: false, stage: "verify", detail: "meeting not found" };
  // 二重に POST /finalize して endedAt を書き換えない（Phase 1 §22）
  if (meeting.status === "finalized") {
    const counts = { mic: (await deps.chunkStore.listByMeeting(meetingId, "mic")).length, system: (await deps.chunkStore.listByMeeting(meetingId, "system")).length };
    return { ok: true, counts };
  }
  // recording 中は stop() 完了の前提を満たさない。finalizing は POST 中に中断された会議の再試行（Phase 1 §22）
  if (meeting.status !== "stop_requested" && meeting.status !== "finalizing") {
    return { ok: false, stage: "verify", detail: `meeting status is ${meeting.status}` };
  }

  // 末尾の Chunk がメモリ待機中だと IDB 上は欠番なしに見えるため、先に弾く
  const unpersisted = deps.unpersistedChunkCount();
  if (unpersisted > 0) {
    return { ok: false, stage: "waiting_local_save", detail: `${unpersisted} chunks not persisted to IDB` };
  }

  const bySource: Record<AudioSource, Awaited<ReturnType<ChunkStore["listByMeeting"]>>> = { mic: [], system: [] };
  for (const source of SOURCES) {
    bySource[source] = await deps.chunkStore.listByMeeting(meetingId, source);
    // SAVED はサーバー一覧で登録確認する（再送しても registered: false が続きうる）
    const notRegistered = bySource[source].filter((c) => c.save.status !== "DB_REGISTERED" && c.save.status !== "SAVED");
    if (notRegistered.length > 0) {
      await deps.scheduler.resumeAll();
      return { ok: false, stage: "waiting_local_save", detail: `${source}: ${notRegistered.length} chunks not registered` };
    }
    for (let i = 0; i < bySource[source].length; i++) {
      if (bySource[source][i].meta.sequenceNo !== i) {
        return { ok: false, stage: "verify", detail: `${source}: sequence gap at ${i}` };
      }
    }
  }

  const listUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/chunks`, deps.baseUrl);
  assertLocalHost(listUrl);
  let listRes: Response;
  try {
    listRes = await fetchWithTimeout(fetchImpl, listUrl, { headers: { Authorization: `Bearer ${deps.token}` }, credentials: "omit" }, timeoutMs);
  } catch (error) {
    return { ok: false, stage: "verify", detail: `list failed: ${describeFetchError(error, timeoutMs)}` };
  }
  if (!listRes.ok) return { ok: false, stage: "verify", detail: `list HTTP ${listRes.status}` };
  // サーバー応答は外部入力。型ガードを通してから使う（壊れた JSON も Result で返す、Phase 1 §22）
  const list: unknown = await listRes.json().catch(() => null);
  if (!isChunkListResponse(list)) return { ok: false, stage: "verify", detail: "malformed ChunkListResponse" };
  const serverByKey = new Map(list.chunks.map((c) => [`${c.source}:${c.sequenceNo}`, c]));
  for (const source of SOURCES) {
    for (const c of bySource[source]) {
      const s = serverByKey.get(`${c.meta.source}:${c.meta.sequenceNo}`);
      if (s === undefined || s.sha256 !== c.meta.sha256 || !s.registered) {
        await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
          r.save.status = "LOCAL_SAVE_PENDING";
        });
        await deps.scheduler.resumeAll();
        return { ok: false, stage: "verify", detail: `server mismatch at ${source}/${c.meta.sequenceNo}` };
      }
      if (c.save.status === "SAVED") {
        await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
          r.save.status = "DB_REGISTERED";
        });
      }
    }
  }

  const counts: Record<AudioSource, number> = { mic: bySource.mic.length, system: bySource.system.length };

  // finalizing へ進める前の値を控える。POST が失敗・タイムアウトしたらここへ戻す。
  // 戻さないと、IndexedDB に finalizing のまま取り残された会議ができ、再開経路がなくなる。
  const before = { status: meeting.status, endedAt: meeting.endedAt, finalChunkCount: meeting.finalChunkCount };
  const restore = async (): Promise<void> => {
    meeting.status = before.status;
    meeting.endedAt = before.endedAt;
    meeting.finalChunkCount = before.finalChunkCount;
    await deps.meetingStore.put(meeting);
  };

  meeting.status = "finalizing";
  meeting.finalChunkCount = counts.mic + counts.system;
  meeting.endedAt = Date.now();
  await deps.meetingStore.put(meeting);

  const body: FinalizeRequest = {
    expectedChunkCounts: counts,
    endedAtEpochMs: meeting.endedAt,
    totalAudioFrames: meeting.sessionClock.audioFrameCount,
  };
  const finUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/finalize`, deps.baseUrl);
  assertLocalHost(finUrl);
  let finRes: Response;
  try {
    finRes = await fetchWithTimeout(fetchImpl, finUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }, timeoutMs);
  } catch (error) {
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize failed: ${describeFetchError(error, timeoutMs)}` };
  }
  if (!finRes.ok) {
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize HTTP ${finRes.status}` };
  }
  meeting.status = "finalized";
  await deps.meetingStore.put(meeting);
  return { ok: true, counts };
}
```

---

# 8. SSE クライアント `src/api/events.ts`

SSE は `fetch` + `ReadableStream` で読む。`EventSource` はリクエストヘッダを付けられず、トークンが IndexedDB にある本設計（Phase 1 §4.3）では認証できないためである。自動再接続は失われるので指数バックオフで自前に持ち、切断中に取りこぼしたイベントは再接続時の `GET /meetings/{id}` と `GET /jobs` で補完する（基本設計 §14）。

```typescript
// src/api/events.ts
import { assertLocalHost } from "./local-saver";
import { isMeetingEvent, jobFromServerRow, type JobListResponse, type MeetingDetailResponse, type MeetingEvent } from "./contracts-phase2";

/** EventSource のうち使う面だけ。テストで Fake に差し替える。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  close(): void;
}

export interface EventsClientDeps {
  readonly baseUrl: string;
  /** IndexedDB の settings ストアに入っているトークン（Phase 1 §4.3）。 */
  readonly token: string;
  readonly createEventSource: (url: URL, token: string) => EventSourceLike;
  /** 再接続後の補完用。失敗は無視せず onError に渡す。 */
  readonly fetchJobs: () => Promise<JobListResponse>;
  /** 再接続後の補完用。会議の status と各版を取り戻す。 */
  readonly fetchMeeting: () => Promise<MeetingDetailResponse>;
  readonly onEvent: (event: MeetingEvent) => void;
  readonly onError: (error: Error) => void;
}

const EVENT_TYPES = ["job", "meeting_status", "transcript_version", "summary_version", "progress"] as const;

export class MeetingEventsClient {
  private source: EventSourceLike | null = null;
  private everConnected = false;
  private disconnected = false;

  constructor(private readonly deps: EventsClientDeps, private readonly meetingId: string) {}

  connect(): void {
    if (this.source !== null) return;
    const url = new URL(`/v1/meetings/${encodeURIComponent(this.meetingId)}/events`, this.deps.baseUrl);
    assertLocalHost(url);
    const es = this.deps.createEventSource(url, this.deps.token);
    this.source = es;

    es.addEventListener("open", () => {
      const isReconnect = this.everConnected && this.disconnected;
      this.everConnected = true;
      this.disconnected = false;
      if (isReconnect) void this.backfill();
    });
    es.addEventListener("error", () => {
      // 再接続は transport 側に任せる。ここでは切断状態を記録するだけ。
      this.disconnected = true;
    });
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (event: MessageEvent<string>) => this.handle(event.data));
    }
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }

  /** テストと再接続補完で使う。JSON を MeetingEvent に変換して通知する。 */
  handle(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      this.deps.onError(error instanceof Error ? error : new Error("invalid SSE payload"));
      return;
    }
    const normalized = normalizeEvent(parsed);
    if (normalized === null) return;
    this.deps.onEvent(normalized);
  }

  /**
   * 切断中に落ちたイベントを取り戻す。jobs だけでは meeting_status と各版が復元されず、
   * UI が古い status を表示し続ける。MeetingDetailResponse が 3 つとも持っているので 1 リクエストで足りる。
   * transcript / summary の本文は取りに行かない。版だけ流せば §11 の staleTranscriptVersion /
   * staleSummaryVersion が立ち、UI が必要になった時点で本文を取得する（再接続のたびに全文を引かない）。
   */
  private async backfill(): Promise<void> {
    try {
      const meeting = await this.deps.fetchMeeting();
      this.deps.onEvent({ type: "meeting_status", status: meeting.status });
      this.deps.onEvent({ type: "transcript_version", transcriptVersion: meeting.transcriptVersion });
      if (meeting.latestSummaryVersion !== null) {
        this.deps.onEvent({ type: "summary_version", version: meeting.latestSummaryVersion });
      }
      const list = await this.deps.fetchJobs();
      for (const job of list.jobs) this.deps.onEvent({ type: "job", job });
    } catch (error) {
      this.deps.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** サーバーの job イベントは snake_case 行なので camelCase に変換する（§3）。 */
export function normalizeEvent(value: unknown): MeetingEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === "job" && typeof v.job === "object" && v.job !== null) {
    const job = jobFromServerRow(v.job as Record<string, unknown>);
    return job === null ? null : { type: "job", job };
  }
  return isMeetingEvent(value) ? value : null;
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * SSE を fetch + ReadableStream で読む。`EventSource` を使わない理由は 2 つある。
 * (1) `EventSource` は Authorization ヘッダを付けられない。トークンは IndexedDB にあり、
 *     Phase 1 §4.3 の `Set-Cookie` は「してもよい」という任意扱いなので Cookie は当てにできない。
 * (2) Phase 3 のマルチユーザーは利用者ごとに別トークンで、Cookie 1 本では表現できない。
 * 代償として `EventSource` の自動再接続が失われるため、指数バックオフの再接続を自前で持つ。
 * `open` / `error` の発火タイミングは `EventSource` と揃えてあり、MeetingEventsClient 側は変わらない。
 */
export class FetchEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private closed = false;

  constructor(private readonly url: URL, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {
    void this.run();
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.controller = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const res = await this.fetchImpl(this.url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
          credentials: "omit",
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) throw new Error(`SSE HTTP ${res.status}`);
        this.retryMs = INITIAL_RETRY_MS;            // 接続できたらバックオフを初期値へ戻す
        this.emit("open", "");
        await this.pump(res.body);
      } catch {
        // 中断も切断も同じ扱い。close() 済みならこの下で抜ける。
      }
      this.controller = null;
      if (this.closed) return;
      this.emit("error", "");
      await this.waitBeforeRetry();
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      // イベントは空行区切り。LF / CRLF の両方を受ける。
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (match === null) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        this.dispatchBlock(block);
      }
    }
  }

  /** 1 イベントぶんのブロックを解釈する。`event:` の省略時は SSE 既定の "message"。 */
  private dispatchBlock(block: string): void {
    let type = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue;      // コメント行（keep-alive）は捨てる
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") type = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length > 0) this.emit(type, dataLines.join("\n"));
  }

  private waitBeforeRetry(): Promise<void> {
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    return new Promise((resolve) => {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        resolve();
      }, delay);
    });
  }
}

export function defaultCreateEventSource(url: URL, token: string): EventSourceLike {
  return new FetchEventSource(url, token);
}
```

---

# 9. 型付き fetch `src/api/phase2-client.ts`

```typescript
// src/api/phase2-client.ts
import { assertLocalHost } from "./local-saver";
import type {
  JobListResponse, MeetingDetailResponse, ModelsResponse, NotesResponse, SummaryResponse, TranscriptResponse,
} from "./contracts-phase2";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T; readonly status: number }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

export interface Phase2ClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
}

export class Phase2Client {
  private readonly base: URL;

  constructor(private readonly config: Phase2ClientConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = new URL(config.baseUrl);
    assertLocalHost(this.base);
  }

  getMeeting(meetingId: string): Promise<ApiResult<MeetingDetailResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}`);
  }

  getTranscript(meetingId: string, version?: number): Promise<ApiResult<TranscriptResponse>> {
    const q = version === undefined ? "" : `?version=${version}`;
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/transcript${q}`);
  }

  getSummary(meetingId: string, version?: number): Promise<ApiResult<SummaryResponse>> {
    const q = version === undefined ? "" : `?version=${version}`;
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/summary${q}`);
  }

  getJobs(meetingId: string): Promise<ApiResult<JobListResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/jobs`);
  }

  retryJob(jobId: string): Promise<ApiResult<{ jobId: string; status: string }>> {
    return this.request("POST", `/v1/jobs/${enc(jobId)}/retry`);
  }

  excludeFailed(meetingId: string): Promise<ApiResult<{ excluded: number }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/jobs/exclude-failed`);
  }

  regenerateSummary(meetingId: string): Promise<ApiResult<{ jobId: string | null }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/summary/regenerate`);
  }

  rerunTranscript(meetingId: string, sttModel: string | null): Promise<ApiResult<{ jobsCreated: number }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/transcript/rerun`, { sttModel });
  }

  transcribeSilentChunk(meetingId: string, source: "mic" | "system", seq: number): Promise<ApiResult<{ jobId: string | null }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/chunks/${source}/${seq}/transcribe`);
  }

  getNotes(meetingId: string): Promise<ApiResult<NotesResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/notes`);
  }

  /** If-Match に revision を載せる。不一致は status 409 の失敗として返る。 */
  putNotes(meetingId: string, blocknoteJson: unknown, revision: number, lastAppliedSummaryVersion: number | null): Promise<ApiResult<NotesResponse>> {
    return this.request("PUT", `/v1/meetings/${enc(meetingId)}/notes`, { blocknoteJson, lastAppliedSummaryVersion }, { "If-Match": String(revision) });
  }

  getModels(): Promise<ApiResult<ModelsResponse>> {
    return this.request("GET", "/v1/models");
  }

  putSettings(values: { language?: string; sttModel?: string; llmModel?: string }): Promise<ApiResult<{ updated: string[] }>> {
    return this.request("PUT", "/v1/settings", values);
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
    const url = new URL(path, this.base);
    assertLocalHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}`, ...extraHeaders };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
      });
      const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
      if (res.ok) return { ok: true, value: json as T, status: res.status };
      const err = (typeof json === "object" && json !== null ? json : {}) as { code?: unknown; error?: unknown };
      return {
        ok: false,
        status: res.status,
        code: typeof err.code === "string" ? err.code : "UNKNOWN",
        message: typeof err.error === "string" ? err.error : `HTTP ${res.status}`,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { ok: false, status: 0, code: "TIMEOUT", message: `timeout after ${this.config.timeoutMs}ms` };
      }
      return { ok: false, status: 0, code: "NETWORK", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
```

---

# 10. ノートの Autosave `src/notes/notes-store.ts`

基本設計 §19。debounce 1〜2 秒で `PUT /notes`、同時に IndexedDB `settings` ストアへ一時保存し、サーバー未起動時の編集を失わない。`409` は上書きせず差分 UI に委ねる。

```typescript
// src/notes/notes-store.ts
import type { ApiResult } from "../api/phase2-client";
import type { NotesResponse } from "../api/contracts-phase2";

export type NotesSyncStatus = "idle" | "dirty" | "saving" | "saved" | "offline" | "conflict";

export interface NotesState {
  readonly meetingId: string;
  readonly json: unknown;
  readonly revision: number;
  readonly lastAppliedSummaryVersion: number | null;
  readonly sync: NotesSyncStatus;
  /** conflict のときサーバー側の最新 */
  readonly serverNotes: NotesResponse | null;
}

/** IndexedDB の SettingsStore のうち使う面。 */
export interface DraftStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface NotesStoreDeps {
  readonly getNotes: (meetingId: string) => Promise<ApiResult<NotesResponse>>;
  readonly putNotes: (meetingId: string, json: unknown, revision: number, lastApplied: number | null) => Promise<ApiResult<NotesResponse>>;
  readonly drafts: DraftStore;
  readonly debounceMs: number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onChange: (state: NotesState) => void;
}

interface Draft {
  readonly json: unknown;
  readonly revision: number;
  readonly lastAppliedSummaryVersion: number | null;
  readonly savedAt: number;
  /**
   * この revision の内容をサーバーへ送信済みか。true は「保存済みの控え」、
   * false と未設定は「未送信の編集」。optional なのは、このフィールドを持たない
   * 旧ビルドの下書きを isDraft で弾いて未送信の編集を失わないため（未設定は未送信として扱う）。
   */
  readonly saved?: boolean;
}

function isDraft(v: unknown): v is Draft {
  return typeof v === "object" && v !== null && "json" in v && typeof (v as { revision?: unknown }).revision === "number";
}

export class NotesStore {
  private state: NotesState;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: NotesStoreDeps, meetingId: string) {
    this.state = { meetingId, json: null, revision: 0, lastAppliedSummaryVersion: null, sync: "idle", serverNotes: null };
  }

  get current(): NotesState {
    return this.state;
  }

  private draftKey(): string {
    return `notes:${this.state.meetingId}`;
  }

  /** 起動時：IndexedDB の下書きとサーバーの両方を見て、新しい方を採用する。 */
  async load(): Promise<void> {
    const draftRaw = await this.deps.drafts.get(this.draftKey());
    const draft = isDraft(draftRaw) ? draftRaw : null;
    const res = await this.deps.getNotes(this.state.meetingId);
    if (!res.ok) {
      // サーバー未起動：下書きがあればそれで開始
      if (draft !== null) {
        this.set({ json: draft.json, revision: draft.revision, lastAppliedSummaryVersion: draft.lastAppliedSummaryVersion, sync: "offline" });
      } else {
        this.set({ sync: "offline" });
      }
      return;
    }
    const server = res.value;
    if (draft !== null && draft.revision === server.revision) {
      // 保存済みの控え（doSave / acceptServer が書いたもの）は未送信ではない。
      // ここで saved を見ないと、リロードのたびに同じ内容を PUT し続けることになる。
      if (draft.saved === true) {
        this.set({ json: draft.json, revision: server.revision, lastAppliedSummaryVersion: draft.lastAppliedSummaryVersion, sync: "saved" });
        return;
      }
      // 同じ版から編集した未送信の下書き → 下書きを優先し dirty として送る
      this.set({ json: draft.json, revision: server.revision, lastAppliedSummaryVersion: draft.lastAppliedSummaryVersion, sync: "dirty" });
      this.schedule();
      return;
    }
    if (draft !== null && draft.revision !== server.revision) {
      // 別タブ等でサーバーが進んでいる → 差分 UI に委ねる
      this.set({ json: draft.json, revision: draft.revision, lastAppliedSummaryVersion: draft.lastAppliedSummaryVersion, sync: "conflict", serverNotes: server });
      return;
    }
    this.set({ json: server.blocknoteJson, revision: server.revision, lastAppliedSummaryVersion: server.lastAppliedSummaryVersion, sync: "saved" });
  }

  /** エディタの変更ごとに呼ぶ。debounce して保存する。 */
  setDraft(json: unknown, lastAppliedSummaryVersion: number | null = this.state.lastAppliedSummaryVersion): void {
    this.set({ json, lastAppliedSummaryVersion, sync: this.state.sync === "conflict" ? "conflict" : "dirty" });
    void this.deps.drafts.set(this.draftKey(), { json, revision: this.state.revision, lastAppliedSummaryVersion, savedAt: Date.now(), saved: false } satisfies Draft);
    if (this.state.sync !== "conflict") this.schedule();
  }

  /** 差分 UI で「サーバー版を採用」を選んだとき。 */
  acceptServer(): void {
    const s = this.state.serverNotes;
    if (s === null) return;
    this.set({ json: s.blocknoteJson, revision: s.revision, lastAppliedSummaryVersion: s.lastAppliedSummaryVersion, sync: "saved", serverNotes: null });
    void this.deps.drafts.set(this.draftKey(), { json: s.blocknoteJson, revision: s.revision, lastAppliedSummaryVersion: s.lastAppliedSummaryVersion, savedAt: Date.now(), saved: true } satisfies Draft);
  }

  /** 差分 UI で「自分の版で上書き」を選んだとき：サーバーの revision を採用して再送。 */
  overwriteServer(): void {
    const s = this.state.serverNotes;
    if (s === null) return;
    this.set({ revision: s.revision, sync: "dirty", serverNotes: null });
    this.schedule();
  }

  /** サーバー復帰時に呼ぶ。 */
  resume(): void {
    if (this.state.sync === "offline" || this.state.sync === "dirty") {
      this.set({ sync: "dirty" });
      this.schedule();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    await this.save();
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.save();
    }, this.deps.debounceMs);
  }

  private async save(): Promise<void> {
    if (this.inflight !== null) {
      await this.inflight;
      return;
    }
    if (this.state.sync !== "dirty") return;
    this.inflight = this.doSave();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doSave(): Promise<void> {
    const snapshot = this.state;
    this.set({ sync: "saving" });
    const res = await this.deps.putNotes(snapshot.meetingId, snapshot.json, snapshot.revision, snapshot.lastAppliedSummaryVersion);
    if (res.ok) {
      const stillSame = this.state.json === snapshot.json;
      this.set({ revision: res.value.revision, sync: stillSame ? "saved" : "dirty" });
      // stillSame が false なら保存中に編集が入っている＝控えの内容はまだ未送信。
      void this.deps.drafts.set(this.draftKey(), { json: this.state.json, revision: res.value.revision, lastAppliedSummaryVersion: this.state.lastAppliedSummaryVersion, savedAt: Date.now(), saved: stillSame } satisfies Draft);
      if (!stillSame) this.schedule();
      return;
    }
    if (res.status === 409) {
      const latest = await this.deps.getNotes(snapshot.meetingId);
      this.set({ sync: "conflict", serverNotes: latest.ok ? latest.value : null });
      return;
    }
    // NETWORK / TIMEOUT / 5xx：下書きは IndexedDB にある。復帰時に resume() で再送。
    this.set({ sync: "offline" });
  }

  private set(patch: Partial<NotesState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }
}
```

---

# 11. UI 状態モデル `src/ui/state.ts`

フレームワーク非依存の reducer。基本設計 §18 の各ペインが必要とする状態をまとめる。

```typescript
// src/ui/state.ts
import type { LocalBackendHealth } from "../types/recording";
import type {
  JobSummary, JobType, MeetingDetailResponse, MeetingEvent, MeetingStatusV2, SummaryResponse, TranscriptResponse,
} from "../api/contracts-phase2";
import type { RejectedItem } from "../api/contracts-summary";

export interface UiState {
  readonly meeting: MeetingDetailResponse | null;
  readonly status: MeetingStatusV2 | null;
  readonly transcript: TranscriptResponse | null;
  readonly summary: SummaryResponse | null;
  readonly jobs: ReadonlyMap<string, JobSummary>;
  readonly progress: Readonly<Partial<Record<JobType, { done: number; total: number }>>>;
  readonly backend: LocalBackendHealth | null;
  readonly showRejected: boolean;
  /** SSE で新しい版を知ったが未取得のもの */
  readonly staleTranscriptVersion: number | null;
  readonly staleSummaryVersion: number | null;
  readonly confidenceDimBelow: number;
}

export const INITIAL_UI_STATE: UiState = {
  meeting: null, status: null, transcript: null, summary: null, jobs: new Map(), progress: {},
  backend: null, showRejected: false, staleTranscriptVersion: null, staleSummaryVersion: null, confidenceDimBelow: 0.4,
};

export type UiAction =
  | { readonly type: "meeting_loaded"; readonly meeting: MeetingDetailResponse }
  | { readonly type: "transcript_loaded"; readonly transcript: TranscriptResponse }
  | { readonly type: "summary_loaded"; readonly summary: SummaryResponse }
  | { readonly type: "jobs_loaded"; readonly jobs: ReadonlyArray<JobSummary> }
  | { readonly type: "backend"; readonly backend: LocalBackendHealth }
  | { readonly type: "event"; readonly event: MeetingEvent }
  | { readonly type: "toggle_rejected" };

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "meeting_loaded":
      return { ...state, meeting: action.meeting, status: action.meeting.status };
    case "transcript_loaded":
      return {
        ...state,
        transcript: action.transcript,
        staleTranscriptVersion: state.staleTranscriptVersion !== null && state.staleTranscriptVersion <= action.transcript.transcriptVersion ? null : state.staleTranscriptVersion,
      };
    case "summary_loaded":
      return {
        ...state,
        summary: action.summary,
        staleSummaryVersion: state.staleSummaryVersion !== null && state.staleSummaryVersion <= action.summary.version ? null : state.staleSummaryVersion,
      };
    case "jobs_loaded": {
      // applyEvent の job と同じ updatedAt 比較をかける。無条件に上書きすると、
      // SSE で先に届いた新しい状態を、後から解決した一覧取得の古い行が巻き戻す。
      const jobs = new Map(state.jobs);
      for (const j of action.jobs) {
        const current = jobs.get(j.jobId);
        if (current !== undefined && current.updatedAt > j.updatedAt) continue;
        jobs.set(j.jobId, j);
      }
      return { ...state, jobs };
    }
    case "backend":
      return { ...state, backend: action.backend };
    case "toggle_rejected":
      return { ...state, showRejected: !state.showRejected };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: UiState, event: MeetingEvent): UiState {
  switch (event.type) {
    case "job": {
      const current = state.jobs.get(event.job.jobId);
      if (current !== undefined && current.updatedAt > event.job.updatedAt) return state; // 補完で古い行が来た
      const jobs = new Map(state.jobs);
      jobs.set(event.job.jobId, event.job);
      return { ...state, jobs };
    }
    case "meeting_status":
      return { ...state, status: event.status };
    case "transcript_version":
      return state.transcript !== null && state.transcript.transcriptVersion >= event.transcriptVersion
        ? state
        : { ...state, staleTranscriptVersion: event.transcriptVersion };
    case "summary_version":
      return state.summary !== null && state.summary.version >= event.version
        ? state
        : { ...state, staleSummaryVersion: event.version };
    case "progress":
      return { ...state, progress: { ...state.progress, [event.jobType]: { done: event.done, total: event.total } } };
  }
}

// ---- セレクタ ----

export function jobCounts(state: UiState): Record<JobType, Record<"done" | "failed" | "active" | "total", number>> {
  const out: Record<JobType, Record<"done" | "failed" | "active" | "total", number>> = {
    vad_chunk: { done: 0, failed: 0, active: 0, total: 0 },
    transcribe_chunk: { done: 0, failed: 0, active: 0, total: 0 },
    merge_transcript: { done: 0, failed: 0, active: 0, total: 0 },
    synthesize_minutes: { done: 0, failed: 0, active: 0, total: 0 },
  };
  for (const j of state.jobs.values()) {
    const c = out[j.jobType];
    c.total++;
    if (j.status === "completed") c.done++;
    else if (j.status === "failed") c.failed++;
    else if (j.status !== "cancelled") c.active++;
  }
  return out;
}

export function failedJobs(state: UiState): JobSummary[] {
  return [...state.jobs.values()].filter((j) => j.status === "failed");
}

/** confidence が閾値未満のセグメント ID（薄字表示、基本設計 §18）。 */
export function dimmedSegmentIds(state: UiState): ReadonlySet<string> {
  const ids = new Set<string>();
  if (state.transcript === null) return ids;
  for (const s of state.transcript.segments) {
    if (s.confidence !== null && s.confidence < state.confidenceDimBelow) ids.add(s.id);
  }
  return ids;
}

/** 折りたたみが開いているときだけ rejected を返す。 */
export function visibleRejected(state: UiState): ReadonlyArray<RejectedItem> {
  if (!state.showRejected || state.summary === null) return [];
  return state.summary.summary.rejected;
}

/** ヘッダ表示用。録音（Phase 1）とは独立した「保存・処理」の健全性。 */
export function backendBanner(state: UiState): string | null {
  const b = state.backend;
  if (b === null) return null;
  if (b.unauthorized) return "サーバーのトークンが無効です。設定を確認してください。";
  if (b.status === "UNREACHABLE") return "サーバー未接続 ── 録音は継続中。処理はサーバー起動後に再開します。";
  if (b.status === "DEGRADED") return "サーバーが高負荷です。処理は継続中です。";
  return null;
}
```

---

# 12. テストコード

Phase 1 §24 のハーネス（`test/harness.ts`）をそのまま使い、以下を追加する。実行環境は Phase 1 と同じ（Vitest、Node、fake-indexeddb）。`MediaStream` と `EventSource` は Node に存在しないため、テスト内で最小限の Fake を定義する。

## 12.1 System Audio

```typescript
// test/system-audio.test.ts
import { describe, expect, it } from "vitest";
import { acquireSystemAudio, type SystemAudioDeps } from "../src/recording/system-audio";
import { createInitialHealth } from "../src/recording/recording-health-monitor";

class FakeTrack extends EventTarget {
  stopped = false;
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
(globalThis as Record<string, unknown>).MediaStream = FakeMediaStream;

function deps(impl: () => Promise<unknown>, onEnded = () => undefined): SystemAudioDeps & { health: ReturnType<typeof createInitialHealth> } {
  const health = createInitialHealth("running");
  return { getDisplayMedia: impl as SystemAudioDeps["getDisplayMedia"], health, onEnded };
}

describe("System Audio 取得", () => {
  it("getDisplayMedia がなければ UNSUPPORTED", async () => {
    const r = await acquireSystemAudio(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("UNSUPPORTED");
  });

  it("利用者がキャンセルしたら DENIED、SYSTEM_UNAVAILABLE を記録し録音は続く", async () => {
    const d = deps(async () => {
      throw new DOMException("cancelled", "NotAllowedError");
    });
    const r = await acquireSystemAudio(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DENIED");
    expect(d.health.degradedReasons).toContain("SYSTEM_UNAVAILABLE");
    expect(d.health.degradedReasons).not.toContain("MIC_TRACK_ENDED");
  });

  it("音声トラックがなければ NO_AUDIO_TRACK", async () => {
    const d = deps(async () => new FakeMediaStream([new FakeTrack("video")]));
    const r = await acquireSystemAudio(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("NO_AUDIO_TRACK");
  });

  it("成功時は video を止め audio だけを返し、共有停止で SYSTEM_TRACK_ENDED", async () => {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    let ended = 0;
    const d = deps(async () => new FakeMediaStream([video, audio]), () => {
      ended++;
    });
    const r = await acquireSystemAudio(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
    expect((r.stream as unknown as FakeMediaStream).getAudioTracks()).toHaveLength(1);
    audio.end();
    expect(ended).toBe(1);
    expect(d.health.degradedReasons).toContain("SYSTEM_TRACK_ENDED");
    r.stop();
    expect(audio.stopped).toBe(true);
  });
});
```

## 12.2 複数ソース録音とドリフト集計

```typescript
// test/multi-source.test.ts
import { describe, expect, it } from "vitest";
import { MultiSourceRecorder, driftStats, percentile, type SourceController } from "../src/recording/multi-source-recorder";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import type { AudioSource, SessionClock } from "../src/types/recording";

class FakeController implements SourceController {
  sessionClock: SessionClock | null = null;
  chunkCount = 0;
  readonly calls: string[] = [];
  registerMeeting: boolean | null = null;
  constructor(readonly source: AudioSource, private readonly startPerf: number) {}
  async start(_m: string, _t: string, _c: number, options: { registerMeeting: boolean }): Promise<void> {
    this.registerMeeting = options.registerMeeting;
    this.sessionClock = { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: this.startPerf, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 };
    this.calls.push("start");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
  async flush(): Promise<void> {
    this.calls.push("flush");
  }
}

function build(systemAvailable: boolean) {
  const controllers: FakeController[] = [];
  const order: string[] = [];
  let now = 1000;
  const rec = new MultiSourceRecorder({
    createController: (source) => {
      const c = new FakeController(source, now);
      controllers.push(c);
      return c;
    },
    acquireMic: async () => ({}) as MediaStream,
    acquireSystem: async () => (systemAvailable ? ({}) as MediaStream : null),
    health: createInitialHealth("running"),
    now: () => now,
  });
  return { rec, controllers, order, setNow: (v: number) => (now = v) };
}

describe("MultiSourceRecorder", () => {
  it("System 取得不可なら Mic-only で開始し、Mic だけが会議を登録する", async () => {
    const { rec, controllers } = build(false);
    const r = await rec.start("m", "t", 1);
    expect(r.systemEnabled).toBe(false);
    expect(rec.hasSystem).toBe(false);
    expect(controllers).toHaveLength(1);
    expect(controllers[0].registerMeeting).toBe(true);
    expect(rec.sampleDrift()).toBeNull();
    const counts = await rec.stop();
    expect(counts).toEqual({ mic: 0, system: 0 });
  });

  it("System ありなら 2 Controller、System は registerMeeting=false、停止は System → Mic の順", async () => {
    const { rec, controllers } = build(true);
    await rec.start("m", "t", 1);
    expect(controllers.map((c) => [c.source, c.registerMeeting])).toEqual([["mic", true], ["system", false]]);
    controllers[0].chunkCount = 3;
    controllers[1].chunkCount = 2;
    const stopOrder: string[] = [];
    for (const c of controllers) {
      const orig = c.stop.bind(c);
      c.stop = async () => {
        stopOrder.push(c.source);
        await orig();
      };
    }
    expect(await rec.stop()).toEqual({ mic: 3, system: 2 });
    expect(stopOrder).toEqual(["system", "mic"]);
  });

  it("ドリフト差は mic − system で記録され、P95/P99 を返す", async () => {
    const { rec, controllers, setNow } = build(true);
    await rec.start("m", "t", 1);
    // 60 分ぶん、30 秒ごとに 120 サンプル。System の音声時計を少しずつ遅らせる。
    for (let i = 1; i <= 120; i++) {
      const t = 1000 + i * 30000;
      setNow(t);
      controllers[0].sessionClock!.audioFrameCount = i * 480000;                 // Mic はドリフトなし
      controllers[1].sessionClock!.audioFrameCount = i * 480000 - Math.round(i * 16 * 0.5); // System は 0.5ms/30s 遅れ
      rec.sampleDrift();
    }
    expect(rec.driftSamples).toHaveLength(120);
    const s = rec.stats();
    expect(s.count).toBe(120);
    expect(s.max).toBeLessThanOrEqual(61);
    expect(s.p95).toBeLessThan(100);   // v4.0 §123 の受入基準
    expect(s.p99).toBeLessThan(250);
  });

  it("percentile / driftStats の境界", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(driftStats([])).toEqual({ count: 0, p95: 0, p99: 0, max: 0 });
  });
});
```

## 12.3 2 系統の finalize

```typescript
// test/finalizer-two-sources.test.ts
import { describe, expect, it } from "vitest";
import { createHarness, makeChunkRecord, BASE_URL, TOKEN } from "./harness";
import { finalizeMeeting } from "../src/recording/finalizer";
import type { AudioChunkRecord, MeetingRecord } from "../src/types/recording";
import { makeChunkKey } from "../src/recording/recording-controller";

async function systemChunk(meetingId: string, seq: number): Promise<AudioChunkRecord> {
  const r = await makeChunkRecord(meetingId, seq);
  const meta = { ...r.meta, source: "system" as const };
  return { ...r, chunkKey: makeChunkKey(meetingId, "system", seq), meta };
}

describe("finalize（mic + system）", () => {
  it("両 source を検証し expectedChunkCounts に実数を入れる", async () => {
    const h = await createHarness();
    const meetingId = "m-two";
    const meeting: MeetingRecord = {
      meetingId, title: "t", status: "stop_requested",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 960000 },
      consentConfirmedAt: 1, createdAt: 1, updatedAt: 1, endedAt: null, finalChunkCount: null,
    };
    await h.meetingStore.put(meeting);
    const records = [await makeChunkRecord(meetingId, 0), await makeChunkRecord(meetingId, 1), await systemChunk(meetingId, 0)];
    for (const r of records) {
      await h.chunkStore.putChunk(r);
      await h.scheduler.enqueue(r.chunkKey);
    }
    for (let i = 0; i < 10; i++) await h.advance(100);

    let finalizeBody: unknown = null;
    const fetchSpy: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/finalize") && init?.body) finalizeBody = JSON.parse(String(init.body));
      return h.server.fetch(input, init);
    };
    const result = await finalizeMeeting({ chunkStore: h.chunkStore, meetingStore: h.meetingStore, scheduler: h.scheduler, baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchSpy, unpersistedChunkCount: () => 0 }, meetingId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts).toEqual({ mic: 2, system: 1 });
    expect((finalizeBody as { expectedChunkCounts: unknown }).expectedChunkCounts).toEqual({ mic: 2, system: 1 });
    expect((await h.meetingStore.get(meetingId))?.status).toBe("finalized");
  });

  it("system 側が未登録なら waiting_local_save で止まる", async () => {
    const h = await createHarness();
    const meetingId = "m-wait";
    await h.meetingStore.put({
      meetingId, title: "t", status: "stop_requested",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
      consentConfirmedAt: 1, createdAt: 1, updatedAt: 1, endedAt: null, finalChunkCount: null,
    });
    const mic = await makeChunkRecord(meetingId, 0);
    await h.chunkStore.putChunk(mic);
    await h.scheduler.enqueue(mic.chunkKey);
    for (let i = 0; i < 10; i++) await h.advance(100);
    h.backend.status = "UNREACHABLE";
    const sys = await systemChunk(meetingId, 0);
    await h.chunkStore.putChunk(sys);
    await h.scheduler.enqueue(sys.chunkKey);
    await h.advance(100);
    const result = await finalizeMeeting({ chunkStore: h.chunkStore, meetingStore: h.meetingStore, scheduler: h.scheduler, baseUrl: BASE_URL, token: TOKEN, fetchImpl: h.server.fetch, unpersistedChunkCount: () => 0 }, meetingId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("waiting_local_save");
  });

  it("finalize がタイムアウトしても会議を finalizing のまま残さない", async () => {
    const h = await createHarness();
    const meetingId = "m-fin-timeout";
    await h.meetingStore.put({
      meetingId, title: "t", status: "stop_requested",
      sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 960000 },
      consentConfirmedAt: 1, createdAt: 1, updatedAt: 1, endedAt: null, finalChunkCount: null,
    });
    const mic = await makeChunkRecord(meetingId, 0);
    await h.chunkStore.putChunk(mic);
    await h.scheduler.enqueue(mic.chunkKey);
    for (let i = 0; i < 10; i++) await h.advance(100);

    // finalize だけ応答しない fetch。abort シグナルを受けて初めて reject する。
    const hangingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/finalize")) return h.server.fetch(input, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };

    const result = await finalizeMeeting(
      { chunkStore: h.chunkStore, meetingStore: h.meetingStore, scheduler: h.scheduler, baseUrl: BASE_URL, token: TOKEN, timeoutMs: 20, fetchImpl: hangingFetch, unpersistedChunkCount: () => 0 },
      meetingId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("finalize");
      expect(result.detail).toMatch(/TIMEOUT/);
    }

    // finalizing 前の値へ戻っており、復帰後に再度 finalize を呼べる
    const after = await h.meetingStore.get(meetingId);
    expect(after?.status).toBe("stop_requested");
    expect(after?.endedAt).toBeNull();
    expect(after?.finalChunkCount).toBeNull();
  });
});
```

## 12.4 SSE クライアント

```typescript
// test/events.test.ts
import { describe, expect, it } from "vitest";
import { MeetingEventsClient, normalizeEvent, type EventSourceLike } from "../src/api/events";
import type { JobListResponse, MeetingDetailResponse, MeetingEvent } from "../src/api/contracts-phase2";

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  closed = false;
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data } as MessageEvent<string>);
  }
}

const serverJobRow = { id: "j1", meeting_id: "m", chunk_id: null, job_type: "merge_transcript", status: "completed", priority: 200, attempts: 1, max_attempts: 5, updated_at: 10, created_at: 1 };

const emptyJobs: JobListResponse = { meetingId: "m", jobs: [], counts: { pending: 0, leased: 0, processing: 0, retrying: 0, completed: 0, failed: 0, cancelled: 0 } };

const meetingDetail: MeetingDetailResponse = {
  meetingId: "m", title: "t", status: "transcribing",
  chunkCounts: { mic: 2, system: 0 },
  sttStatusCounts: { pending: 0, queued: 0, processing: 0, completed: 2, skipped: 0, failed: 0 },
  transcriptVersion: 3, latestSummaryVersion: 2,
  sttModelUsed: "small", llmModelUsed: null, syncDriftMs: null,
};

describe("MeetingEventsClient", () => {
  it("snake_case の job 行を camelCase に変換して通知する", () => {
    const ev = normalizeEvent({ type: "job", job: serverJobRow });
    expect(ev).toEqual({ type: "job", job: { jobId: "j1", jobType: "merge_transcript", status: "completed", chunkId: null, attempts: 1, errorClass: null, lastError: null, modelName: null, durationMs: null, updatedAt: 10 } });
    expect(normalizeEvent({ type: "nope" })).toBeNull();
    expect(normalizeEvent({ type: "transcript_version", transcriptVersion: 2 })).toEqual({ type: "transcript_version", transcriptVersion: 2 });
  });

  it("種別ごとの必須フィールドが欠けたペイロードは捨てる", () => {
    // job が無い job イベントを通すと applyEvent が event.job.jobId で落ちる
    expect(normalizeEvent({ type: "job" })).toBeNull();
    expect(normalizeEvent({ type: "job", job: { id: 1 } })).toBeNull();
    expect(normalizeEvent({ type: "transcript_version" })).toBeNull();
    expect(normalizeEvent({ type: "summary_version", version: "2" })).toBeNull();
    expect(normalizeEvent({ type: "meeting_status", status: "bogus" })).toBeNull();
    expect(normalizeEvent({ type: "progress", jobType: "nope", done: 1, total: 2 })).toBeNull();
    expect(normalizeEvent({ type: "progress", jobType: "vad_chunk", done: 1 })).toBeNull();
    // 正しいものは通る
    expect(normalizeEvent({ type: "meeting_status", status: "transcribing" })).toEqual({ type: "meeting_status", status: "transcribing" });
    expect(normalizeEvent({ type: "progress", jobType: "vad_chunk", done: 1, total: 2 })).toEqual({ type: "progress", jobType: "vad_chunk", done: 1, total: 2 });
  });

  it("再接続後に会議状態と jobs を補完し、初回接続では補完しない", async () => {
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    let jobsCount = 0;
    let meetingCount = 0;
    let passedToken: string | null = null;
    const jobs: JobListResponse = { meetingId: "m", jobs: [{ jobId: "j9", jobType: "vad_chunk", status: "completed", chunkId: "c", attempts: 1, errorClass: null, lastError: null, modelName: null, durationMs: 5, updatedAt: 99 }], counts: { pending: 0, leased: 0, processing: 0, retrying: 0, completed: 1, failed: 0, cancelled: 0 } };
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: (url, token) => {
        expect(url.pathname).toBe("/v1/meetings/m/events");
        passedToken = token;                      // transport が Bearer に載せる（EventSource ではヘッダを付けられない）
        es = new FakeEventSource();
        return es;
      },
      fetchJobs: async () => {
        jobsCount++;
        return jobs;
      },
      fetchMeeting: async () => {
        meetingCount++;
        return meetingDetail;
      },
      onEvent: (e) => received.push(e),
      onError: (e) => {
        throw e;
      },
    }, "m");
    client.connect();
    if (es === null) throw new Error("no es");
    const source: FakeEventSource = es;
    expect(passedToken).toBe("tok");
    source.emit("open");
    expect(jobsCount).toBe(0);
    expect(meetingCount).toBe(0);
    source.emit("job", JSON.stringify({ type: "job", job: serverJobRow }));
    source.emit("summary_version", JSON.stringify({ type: "summary_version", version: 1 }));
    expect(received.map((e) => e.type)).toEqual(["job", "summary_version"]);

    received.length = 0;
    source.emit("error");
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    expect(meetingCount).toBe(1);
    expect(jobsCount).toBe(1);
    // 切断中に落ちた status と各版が戻る。jobs だけでは status が古いままになる。
    expect(received).toEqual([
      { type: "meeting_status", status: "transcribing" },
      { type: "transcript_version", transcriptVersion: 3 },
      { type: "summary_version", version: 2 },
      { type: "job", job: jobs.jobs[0] },
    ]);
    client.close();
    expect(source.closed).toBe(true);
  });

  it("要約がまだ無い会議では summary_version を流さない", async () => {
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: async () => ({ ...meetingDetail, latestSummaryVersion: null }),
      onEvent: (e) => received.push(e),
      onError: (e) => {
        throw e;
      },
    }, "m");
    client.connect();
    const source = es as unknown as FakeEventSource;
    source.emit("open");
    source.emit("error");
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    expect(received.map((e) => e.type)).toEqual(["meeting_status", "transcript_version"]);
  });

  it("補完の失敗は onError に渡し、例外を漏らさない", async () => {
    let es: FakeEventSource | null = null;
    const errors: Error[] = [];
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: async () => {
        throw new Error("server down");
      },
      onEvent: () => undefined,
      onError: (e) => errors.push(e),
    }, "m");
    client.connect();
    const source = es as unknown as FakeEventSource;
    source.emit("open");
    source.emit("error");
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => e.message)).toEqual(["server down"]);
  });

  it("壊れた JSON は onError に渡し、例外にしない", () => {
    const errors: Error[] = [];
    const client = new MeetingEventsClient({ baseUrl: "http://127.0.0.1:43117", token: "tok", createEventSource: () => new FakeEventSource(), fetchJobs: async () => emptyJobs, fetchMeeting: async () => meetingDetail, onEvent: () => undefined, onError: (e) => errors.push(e) }, "m");
    client.handle("{broken");
    expect(errors).toHaveLength(1);
  });

  it("外部ホストの baseUrl は拒否する", () => {
    const client = new MeetingEventsClient({ baseUrl: "https://example.com", token: "tok", createEventSource: () => new FakeEventSource(), fetchJobs: async () => { throw new Error("x"); }, fetchMeeting: async () => { throw new Error("x"); }, onEvent: () => undefined, onError: () => undefined }, "m");
    expect(() => client.connect()).toThrow(/disallowed host/);
  });
});
```

## 12.5 ノートの Autosave

```typescript
// test/notes-store.test.ts
import { describe, expect, it } from "vitest";
import { NotesStore, type NotesState, type NotesStoreDeps } from "../src/notes/notes-store";
import type { ApiResult } from "../src/api/phase2-client";
import type { NotesResponse } from "../src/api/contracts-phase2";

function build(opts: { serverRevision?: number; offline?: boolean } = {}) {
  let revision = opts.serverRevision ?? 0;
  let serverJson: unknown = revision > 0 ? ["server"] : null;
  let offline = opts.offline ?? false;
  const drafts = new Map<string, unknown>();
  const timers: Array<{ fn: () => void; id: number }> = [];
  let nextId = 1;
  const states: NotesState[] = [];
  const puts: Array<{ json: unknown; revision: number }> = [];
  const deps: NotesStoreDeps = {
    getNotes: async (): Promise<ApiResult<NotesResponse>> =>
      offline ? { ok: false, status: 0, code: "NETWORK", message: "down" } : { ok: true, status: 200, value: { meetingId: "m", blocknoteJson: serverJson, revision, lastAppliedSummaryVersion: null } },
    putNotes: async (_m, json, rev): Promise<ApiResult<NotesResponse>> => {
      puts.push({ json, revision: rev });
      if (offline) return { ok: false, status: 0, code: "NETWORK", message: "down" };
      if (rev !== revision) return { ok: false, status: 409, code: "CONFLICT_HASH_MISMATCH", message: "revision mismatch" };
      revision++;
      serverJson = json;
      return { ok: true, status: 200, value: { meetingId: "m", blocknoteJson: json, revision, lastAppliedSummaryVersion: null } };
    },
    drafts: { get: async (k) => drafts.get(k), set: async (k, v) => void drafts.set(k, v) },
    debounceMs: 1000,
    setTimer: (fn) => {
      const id = nextId++;
      timers.push({ fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    onChange: (s) => states.push(s),
  };
  const fire = async () => {
    const t = timers.shift();
    if (t) t.fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { store: new NotesStore(deps, "m"), drafts, timers, states, puts, fire, setOffline: (v: boolean) => (offline = v), bumpServer: () => { revision++; serverJson = ["other-tab"]; } };
}

describe("NotesStore", () => {
  it("debounce 後に 1 回だけ PUT し、revision が進む", async () => {
    const b = build();
    await b.store.load();
    b.store.setDraft(["a"]);
    b.store.setDraft(["ab"]);
    b.store.setDraft(["abc"]);
    expect(b.timers).toHaveLength(1);
    expect(b.store.current.sync).toBe("dirty");
    await b.fire();
    expect(b.puts).toEqual([{ json: ["abc"], revision: 0 }]);
    expect(b.store.current.sync).toBe("saved");
    expect(b.store.current.revision).toBe(1);
    expect(b.drafts.get("notes:m")).toMatchObject({ json: ["abc"], revision: 1 });
  });

  it("別タブで進んだ revision は 409 → conflict になり、上書きしない", async () => {
    const b = build({ serverRevision: 1 });
    await b.store.load();
    b.bumpServer();
    b.store.setDraft(["mine"]);
    await b.fire();
    expect(b.store.current.sync).toBe("conflict");
    expect(b.store.current.serverNotes?.blocknoteJson).toEqual(["other-tab"]);
    b.store.overwriteServer();
    await b.fire();
    expect(b.store.current.sync).toBe("saved");
    expect(b.puts[b.puts.length - 1]).toEqual({ json: ["mine"], revision: 2 });
  });

  it("サーバー未起動でも IndexedDB に下書きが残り、復帰後に送られる", async () => {
    const b = build({ offline: true });
    await b.store.load();
    expect(b.store.current.sync).toBe("offline");
    b.store.setDraft(["offline-edit"]);
    await b.fire();
    expect(b.store.current.sync).toBe("offline");
    expect(b.drafts.get("notes:m")).toMatchObject({ json: ["offline-edit"], revision: 0 });
    b.setOffline(false);
    b.store.resume();
    await b.fire();
    expect(b.store.current.sync).toBe("saved");
    expect(b.puts[b.puts.length - 1]).toEqual({ json: ["offline-edit"], revision: 0 });
  });

  it("起動時：同じ revision の下書きは dirty として再送、進んでいれば conflict", async () => {
    const a = build({ serverRevision: 2 });
    await a.drafts.set("notes:m", { json: ["draft"], revision: 2, lastAppliedSummaryVersion: null, savedAt: 1 });
    await a.store.load();
    expect(a.store.current.sync).toBe("dirty");
    await a.fire();
    expect(a.store.current.sync).toBe("saved");

    const c = build({ serverRevision: 3 });
    await c.drafts.set("notes:m", { json: ["draft"], revision: 1, lastAppliedSummaryVersion: null, savedAt: 1 });
    await c.store.load();
    expect(c.store.current.sync).toBe("conflict");
    c.store.acceptServer();
    expect(c.store.current.json).toEqual(["server"]);
    expect(c.store.current.revision).toBe(3);
  });

  it("保存に成功した下書きは saved: true で控えられる", async () => {
    const b = build();
    await b.store.load();
    b.store.setDraft(["a"]);
    expect(b.drafts.get("notes:m")).toMatchObject({ json: ["a"], saved: false });
    await b.fire();
    expect(b.store.current.sync).toBe("saved");
    expect(b.drafts.get("notes:m")).toMatchObject({ json: ["a"], revision: 1, saved: true });
  });

  it("保存済みの控えはリロードで再送しない", async () => {
    const b = build({ serverRevision: 2 });
    await b.drafts.set("notes:m", { json: ["server"], revision: 2, lastAppliedSummaryVersion: null, savedAt: 1, saved: true });
    await b.store.load();
    expect(b.store.current.sync).toBe("saved");
    expect(b.timers).toHaveLength(0);      // 再送が予約されていない
    await b.fire();
    expect(b.puts).toHaveLength(0);
  });
});
```

## 12.6 UI 状態

```typescript
// test/ui-state.test.ts
import { describe, expect, it } from "vitest";
import { INITIAL_UI_STATE, backendBanner, dimmedSegmentIds, failedJobs, jobCounts, reduce, visibleRejected } from "../src/ui/state";
import type { JobSummary, SummaryResponse, TranscriptResponse } from "../src/api/contracts-phase2";

const job = (id: string, status: JobSummary["status"], updatedAt = 1): JobSummary =>
  ({ jobId: id, jobType: "transcribe_chunk", status, chunkId: "c", attempts: 1, errorClass: status === "failed" ? "INVALID_AUDIO" : null, lastError: null, modelName: "small", durationMs: null, updatedAt });

describe("UI reducer", () => {
  it("job イベントは updatedAt が新しいものだけ採用する", () => {
    let s = reduce(INITIAL_UI_STATE, { type: "jobs_loaded", jobs: [job("j1", "processing", 5)] });
    s = reduce(s, { type: "event", event: { type: "job", job: job("j1", "completed", 3) } });
    expect(s.jobs.get("j1")?.status).toBe("processing");
    s = reduce(s, { type: "event", event: { type: "job", job: job("j1", "completed", 6) } });
    expect(s.jobs.get("j1")?.status).toBe("completed");
    expect(jobCounts(s).transcribe_chunk).toEqual({ done: 1, failed: 0, active: 0, total: 1 });
  });

  it("jobs_loaded も updatedAt が古い行では上書きしない", () => {
    // SSE の completed が先に届き、遅れて解決した一覧取得が古い processing を運んでくる状況
    let s = reduce(INITIAL_UI_STATE, { type: "event", event: { type: "job", job: job("j1", "completed", 9) } });
    s = reduce(s, { type: "jobs_loaded", jobs: [job("j1", "processing", 4), job("j2", "pending", 1)] });
    expect(s.jobs.get("j1")?.status).toBe("completed");
    expect(s.jobs.get("j2")?.status).toBe("pending");
    // 新しい行なら採用する
    s = reduce(s, { type: "jobs_loaded", jobs: [job("j1", "failed", 12)] });
    expect(s.jobs.get("j1")?.status).toBe("failed");
  });

  it("新しい版の通知は stale に記録し、取得で解消する", () => {
    let s = reduce(INITIAL_UI_STATE, { type: "event", event: { type: "transcript_version", transcriptVersion: 2 } });
    expect(s.staleTranscriptVersion).toBe(2);
    const tr: TranscriptResponse = { meetingId: "m", transcriptVersion: 2, segments: [], gaps: [] };
    s = reduce(s, { type: "transcript_loaded", transcript: tr });
    expect(s.staleTranscriptVersion).toBeNull();
    s = reduce(s, { type: "event", event: { type: "transcript_version", transcriptVersion: 1 } });
    expect(s.staleTranscriptVersion).toBeNull();
  });

  it("confidence が閾値未満のセグメントだけ薄字にする", () => {
    const tr: TranscriptResponse = {
      meetingId: "m", transcriptVersion: 1, gaps: [],
      segments: [
        { id: "a", source: "mic", startMs: 0, endMs: 1, text: "x", confidence: 0.9, language: "ja", chunkSequenceNo: 0, speakerId: null },
        { id: "b", source: "mic", startMs: 1, endMs: 2, text: "y", confidence: 0.2, language: "ja", chunkSequenceNo: 0, speakerId: null },
        { id: "c", source: "mic", startMs: 2, endMs: 3, text: "z", confidence: null, language: "ja", chunkSequenceNo: 0, speakerId: null },
      ],
    };
    const s = reduce(INITIAL_UI_STATE, { type: "transcript_loaded", transcript: tr });
    expect([...dimmedSegmentIds(s)]).toEqual(["b"]);
  });

  it("rejected は折りたたみを開いたときだけ見える", () => {
    const summary: SummaryResponse = {
      meetingId: "m", version: 1,
      summary: { summary: "s", topics: [], decisions: [], actionItems: [], rejected: [{ kind: "topic", item: { title: "幻覚", description: "", sourceSegmentIds: [] }, reasons: ["SEGMENT_ID_EMPTY"] }], modelName: "llm", promptVersion: "v1", transcriptVersion: 1, generatedAt: 0, modelCaveats: ["注記"] },
      validation: { schemaValid: true, schemaRetries: 0, mapWindows: 1, totalItems: 1, rejectedItems: 1, unresolvedSegmentIds: [] },
    };
    let s = reduce(INITIAL_UI_STATE, { type: "summary_loaded", summary });
    expect(visibleRejected(s)).toEqual([]);
    s = reduce(s, { type: "toggle_rejected" });
    expect(visibleRejected(s)).toHaveLength(1);
  });

  it("失敗ジョブとバナー", () => {
    let s = reduce(INITIAL_UI_STATE, { type: "jobs_loaded", jobs: [job("j1", "failed"), job("j2", "completed")] });
    expect(failedJobs(s).map((j) => j.jobId)).toEqual(["j1"]);
    expect(backendBanner(s)).toBeNull();
    s = reduce(s, { type: "backend", backend: { status: "UNREACHABLE", lastCheckedAt: 0, lastHealthyAt: null, latencyMs: null, consecutiveFailures: 3, capabilities: null, unauthorized: false } });
    expect(backendBanner(s)).toMatch(/録音は継続中/);
    s = reduce(s, { type: "backend", backend: { ...s.backend!, unauthorized: true } });
    expect(backendBanner(s)).toMatch(/トークン/);
  });
});
```

## 12.7 テストと基本設計 §26.4 の対応（ブラウザ側）

| 基本設計の項目 | テスト |
| --- | --- |
| System Audio 取得不可でも録音継続 | `system-audio.test.ts`、`multi-source.test.ts`（Mic-only） |
| Mic/System 同期誤差 P95/P99 | `multi-source.test.ts`（集計ロジック。実測は実機） |
| finalize の 2 source | `finalizer-two-sources.test.ts` |
| SSE 切断中の取りこぼし補完 | `events.test.ts` |
| Manual Notes 保護・楽観ロック・オフライン下書き | `notes-store.test.ts` |
| Hallucination 除外項目の表示 | `ui-state.test.ts` |
| 外部通信ゼロ（allowlist） | `events.test.ts`（外部ホスト拒否）。`Phase2Client` と `finalizer` は `assertLocalHost` を通る |
| Phase 1 の回帰 | Phase 1 §24 の 11 テストを同じツリーで実行 |

---

# 13. Invariant 1〜10 の担保箇所（ブラウザ側）

| Invariant | ブラウザ側での担保 |
| --- | --- |
| 1 Live STT failure ≠ Recording failure | Phase 3。Phase 2 のブラウザ側は STT 結果を表示するだけで、録音経路（§4・§6）は SSE / fetch の失敗を参照しない |
| 2 AI failure ≠ Transcript loss | §11 `summary_loaded` は `transcript` を触らない。`staleSummaryVersion` は通知のみ |
| 3 STT failure ≠ Recording loss | §11 `TranscriptResponse.gaps` を失敗区間として表示するだけ。IndexedDB の Chunk は Phase 1 §26 の保持期間まで残る |
| 4 Queue failure ≠ Job metadata loss | §8 再接続補完は `GET /meetings/{id}`（status と各版）と `GET /jobs`（SQLite）から復元。ブラウザは進捗を SSE だけに依存しない |
| 5 Duplicate delivery ≠ Duplicate transcript | §11 `applyEvent` と `jobs_loaded` の両方が `updatedAt` で古い job 行を捨て、`jobs` は `jobId` キーの Map。SSE と一覧取得のどちらが先に解決しても巻き戻らない |
| 6 AI regeneration ≠ Manual note overwrite | §10 `NotesStore` は AI 出力を書かない。`409` は `conflict` にして自動上書きしない |
| 7 VAD false negative ≠ Original audio loss | §9 `transcribeSilentChunk` で無音判定 Chunk を手動 STT できる。Chunk は削除されない |
| 8 Browser tab hidden ≠ timer-based recording failure | §4 は Phase 1 と同じくフレーム基準。§6 `sampleDrift` はタイマーではなく Chunk 生成イベントで呼ぶ。§10 の debounce タイマーは保存の遅延にしか影響しない |
| 9 Speaker source ≠ Speaker identity | §3 `TranscriptSegmentView.source` は経路、`speakerId` は Phase 3 まで null。UI は `[mic]` / `[system]` 表示に留める |
| 10 Queue ≠ Source of Truth | §7 finalize 前の IndexedDB とサーバーの sha256 照合。処理進捗（jobs）が失われても録音と transcript は残る |

---

# 14. Definition of Done 対応（ブラウザ側）

| 項目 | 状況 | 担保箇所 |
| --- | --- | --- |
| 共有ダイアログのキャンセルで Mic-only 継続 | 設計済・テスト済 | §5、§6、§12.1〜§12.2 |
| 共有停止（`track.ended`）で System のみ停止 | 設計済・テスト済 | §5（`SYSTEM_TRACK_ENDED`）、§6 `dropSystem` |
| 同意文言に System Audio を追加 | 設計済（UI 文言） | 基本設計 §16.1。`consentConfirmedAt` は Phase 1 と同じ |
| Mic/System ドリフトの 30 秒ごとの記録と P95/P99 表示 | 設計済・テスト済（集計）・実機（実測） | §6、`frameClockDriftMs` を `X-Chunk-Meta` に載せる（§4） |
| SSE で進捗を反映し、再接続後に欠落を補完 | 設計済・テスト済 | §8（`fetchMeeting` で status と各版、`fetchJobs` で job）、§11 |
| transcript の薄字表示・失敗区間の表示・根拠リンク | 設計済（状態）・手動（描画） | §11 `dimmedSegmentIds`、`TranscriptResponse.gaps`、`sourceSegmentIds` |
| `rejected` の折りたたみ表示とモデル注記 | 設計済・テスト済 | §11 `visibleRejected`、`MeetingSummary.modelCaveats` |
| AI 再生成が手動ノートを上書きしない | 設計済・テスト済（サーバー側 §23.5）・本書 §10（クライアントは AI 出力をノートに書かない） | Invariant 6 |
| サーバー未起動時のノート編集を失わない | 設計済・テスト済 | §10、§12.5 |
| 外部ホストへの通信ゼロ | 設計済・テスト済（allowlist）・手動（DevTools） | Phase 1 §4.4 の CSP、`assertLocalHost` |
| Phase 1 テストの回帰 | テスト済 | §12 |

---

*本書のコードは Node 上の vitest で検証済みだが、`getDisplayMedia` の実際の可否、`FetchEventSource` の長時間接続とバックオフ再接続の挙動、2 系統同時録音時の AudioWorklet 負荷は対象ブラウザの実機でのみ確認できる。基本設計 §26.4 の実機項目を通過したものだけを Phase 2 ブラウザ側の完了とする。*
