# 議事録Webアプリケーション Phase 2 詳細設計書 ── ブラウザ側（TypeScript）

**対象:** Phase 1 詳細設計書（`docs/design-local-phase1.md`）のブラウザ側コードを前提に、Phase 2 で追加・変更するファイルの実装コードとテストコード。
**上位文書:** Phase 2 基本設計書（`docs/design-local-phase2.md`）§14・§16〜§19。
**対となる文書:** Phase 2 詳細設計書 ── サーバー側（`docs/design-local-phase2-server.md`）。API 契約はそちらの §21 と 1 対 1。
**配置:** `docs/design-local-phase2-client.md`（2026-11-12 にリポジトリ直下から `docs/` 配下へ移行）。
**制約:** ブラウザ標準 API（`MediaStream` / `AudioContext` / `AudioWorklet` / `IndexedDB` / `fetch` / `EventSource`）と TypeScript のみ。UI フレームワークは本書で選定せず、状態モデル（§11）をフレームワーク非依存の reducer として定義する。
**検証状態:** 本書の全 `typescript` コードブロック（18 ファイル）を Phase 1 の現行ソースへ上書き・追加した状態で、`tsc --noEmit`（strict）と Vitest 31 ファイル 557 件が全件通過することを確認している（2026-11-13）。詳細と再現手順は §1.2。**アプリへの組み込み（`app.ts`・`main.ts`）のコードは本書に含まない**（§15）。

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
| `src/worklet/pcm-chunker.worklet.ts`、`src/audio/wav.ts`、`src/storage/idb.ts`、`src/api/local-saver.ts`、`src/api/meeting-registrar.ts`、`src/recording/local-save-scheduler.ts`、`src/api/backend-health-monitor.ts` | 変更なし | Phase 1 の会議登録を Mic/System の双方で共用 | — |

変更禁止の根拠は基本設計 §2（WAV 生成・IndexedDB スキーマ・Phase 1 API 契約の不変）である。`src/storage/idb.ts` の `DB_VERSION` は 1 のままとする。

上の表は「単体でテストできる部品」の一覧である。部品をアプリに組み込む作業（`src/app/app.ts`・`src/main.ts`・`index.html`・`src/ui/recording-view.ts` の変更）は §15 にまとめる。§15 には、実装着手前に利用者の判断が要る未決事項（画面の描画方式とノートのエディタ）がある。

## 1.2 検証状態

本書の `// src/...` と `// test/...` のコードブロックを Phase 1 の現行ソース（2026-11-13 時点）へ上書き・追加した状態で、`npm run typecheck` が通り、Vitest 31 ファイル 557 件が全件通過することを確認している（Phase 1 の 24 ファイルを含む。Phase 1 側の変更は §7 に記した `test/app.test.ts` の 1 か所）。確認の手順は `scripts/verify-design-docs.sh`。実ブラウザ（`getDisplayMedia`・SSE の実接続）では実行していない。

Phase 1 のファイルを全文で載せているブロック（`recording-controller.ts`・`finalizer.ts`・`types/recording.ts`）は、**Phase 1 の現行ソースに Phase 2 の差分を当てたもの**である。Phase 1 側を直したら、同じ修正を本書のブロックにも当てて上の検証をやり直す（CLAUDE.md ルール 3）。

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
  | "IDB_WRITE_FAILED"
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

export type MeetingStatus = "created" | "recording" | "stop_requested" | "finalizing" | "finalized" | "abandoned";

export type RecordingStopReason = "manual" | "mic_ended";

export interface MeetingRecord {
  readonly meetingId: string;
  title: string;
  status: MeetingStatus;
  readonly sessionClock: SessionClock;
  readonly consentConfirmedAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  stopReason?: RecordingStopReason;
  stopDetectedAtEpochMs?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVADResult(value: unknown): value is VADResult {
  return (
    isRecord(value) &&
    typeof value.score === "number" &&
    typeof value.hasVoice === "boolean" &&
    typeof value.voicedSamples === "number"
  );
}

/** type だけでなく各バリアントの必須フィールドまで確かめる。欠けたイベントを通すと handler 側で例外になる。 */
export function isWorkletEvent(value: unknown): value is WorkletEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "ready":
      return typeof value.nativeSampleRate === "number" && typeof value.renderQuantum === "number";
    case "chunk":
      return (
        value.pcm instanceof ArrayBuffer &&
        typeof value.sampleCount === "number" &&
        typeof value.startFrame === "number" &&
        typeof value.endFrame === "number" &&
        isVADResult(value.vad) &&
        typeof value.partial === "boolean"
      );
    case "heartbeat":
      return typeof value.audioFrameCount === "number" && typeof value.currentTime === "number";
    case "flushed":
      return typeof value.requestId === "number" && typeof value.audioFrameCount === "number";
    default:
      return false;
  }
}
```

---

# 3. Phase 2 契約型 `src/api/contracts-phase2.ts` / `src/api/contracts-summary.ts`

基本設計 §7.1・§12.4・§14 を統合した確定版。サーバー側 §21 のレスポンスと 1 対 1。

**型だけでなく、エンドポイントごとのデコーダ（`decodeMeetingDetail` など）をここに置く。** サーバー応答は外部入力なので、`Phase2Client`（§9）は成功応答を `as T` で通さず、必ずデコーダに通す（形が違えば `MALFORMED`）。デコーダは、会議に属する応答について `meetingId` が要求と一致することまで確かめる。応答の型を足す・変えるときは、デコーダと §12.4.1 のテスト（サーバーの実応答をフィクスチャにしている）を同じ作業の中で直す。

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
  // 描画と reducer が .map / .filter / .length で触る配列は、すべて配列であることまで確かめる
  return typeof v.summary === "string" && typeof v.modelName === "string" && typeof v.transcriptVersion === "number"
    && Array.isArray(v.topics) && Array.isArray(v.decisions) && Array.isArray(v.actionItems)
    && Array.isArray(v.rejected) && Array.isArray(v.modelCaveats);
}
```

```typescript
// src/api/contracts-phase2.ts
import type { LocalBackendCapabilities } from "../types/recording";
import { isMeetingSummary, type MeetingSummary, type SummaryValidationReport } from "./contracts-summary";

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

/** モデル取得（POST /v1/models/download）の状態。サーバー側 §10.2 `ModelDownloads`。結果は GET /v1/models を取り直して見る */
export interface ModelDownload {
  readonly name: string;
  readonly status: "running" | "completed" | "failed";
  readonly error: string | null;
}

export interface ModelsResponse {
  readonly stt: ReadonlyArray<{ readonly name: string; readonly installed: boolean; readonly selected: boolean; readonly recommended: boolean }>;
  readonly llm: ReadonlyArray<{ readonly name: string; readonly selected: boolean; readonly recommended: boolean }>;
  readonly ollamaReachable: boolean;
  readonly downloads: ReadonlyArray<ModelDownload>;
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

/**
 * エンドポイント別のデコーダ。Phase2Client.request() は成功応答を `as T` で通さず、必ずここを経由する（§9）。
 * サーバー応答は外部入力（CLAUDE.md「既知の落とし穴」）。形の違う応答を値として返すと、失敗が reducer や描画の
 * .map / .filter まで先送りされて TypeError になる。検証するのは後段が触るフィールドで、失敗は null（呼び出し側が MALFORMED）。
 * meetingId は「要求した会議のものであること」まで確かめる（会議の切り替え中に遅れて届いた前の会議の応答を通さない）。
 * jobType は列挙で絞らない（Phase 3 のサーバーはジョブ種別を増やす）。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isForMeeting(value: Record<string, unknown>, expectedMeetingId: string): boolean {
  return typeof value.meetingId === "string" && value.meetingId === expectedMeetingId;
}

function isNullOr(value: unknown, type: "string" | "number"): boolean {
  return value === null || typeof value === type;
}

const JOB_STATUSES: ReadonlyArray<string> = ["pending", "leased", "processing", "retrying", "completed", "failed", "cancelled"];
const STT_STATUSES: ReadonlyArray<string> = ["pending", "queued", "processing", "completed", "skipped", "failed"];

function hasCounts(value: unknown, keys: ReadonlyArray<string>): boolean {
  return isRecord(value) && keys.every((k) => typeof value[k] === "number");
}

function isSource(value: unknown): value is "mic" | "system" {
  return value === "mic" || value === "system";
}

export function isJobSummary(value: unknown): value is JobSummary {
  if (!isRecord(value)) return false;
  return typeof value.jobId === "string" && typeof value.jobType === "string"
    && typeof value.status === "string" && JOB_STATUSES.includes(value.status)
    && isNullOr(value.chunkId, "string") && typeof value.attempts === "number"
    && isNullOr(value.errorClass, "string") && isNullOr(value.lastError, "string") && isNullOr(value.modelName, "string")
    && isNullOr(value.durationMs, "number") && typeof value.updatedAt === "number";
}

function isTranscriptSegmentView(value: unknown): value is TranscriptSegmentView {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && isSource(value.source)
    && typeof value.startMs === "number" && typeof value.endMs === "number" && typeof value.text === "string"
    && isNullOr(value.confidence, "number") && isNullOr(value.language, "string")
    && typeof value.chunkSequenceNo === "number" && isNullOr(value.speakerId, "string");
}

function isTranscriptGap(value: unknown): value is TranscriptGap {
  return isRecord(value) && isSource(value.source) && typeof value.startMs === "number" && typeof value.endMs === "number";
}

export function decodeMeetingDetail(value: unknown, expectedMeetingId: string): MeetingDetailResponse | null {
  if (!isRecord(value) || !isForMeeting(value, expectedMeetingId)) return null;
  if (typeof value.title !== "string" || typeof value.status !== "string" || !MEETING_STATUSES.includes(value.status)) return null;
  if (!hasCounts(value.chunkCounts, ["mic", "system"]) || !hasCounts(value.sttStatusCounts, STT_STATUSES)) return null;
  if (typeof value.transcriptVersion !== "number" || !isNullOr(value.latestSummaryVersion, "number")) return null;
  if (!isNullOr(value.sttModelUsed, "string") || !isNullOr(value.llmModelUsed, "string")) return null;
  if (!(value.syncDriftMs === null || hasCounts(value.syncDriftMs, ["p95", "p99"]))) return null;
  return value as unknown as MeetingDetailResponse;
}

export function decodeTranscript(value: unknown, expectedMeetingId: string): TranscriptResponse | null {
  if (!isRecord(value) || !isForMeeting(value, expectedMeetingId) || typeof value.transcriptVersion !== "number") return null;
  if (!Array.isArray(value.segments) || !value.segments.every(isTranscriptSegmentView)) return null;
  if (!Array.isArray(value.gaps) || !value.gaps.every(isTranscriptGap)) return null;
  return value as unknown as TranscriptResponse;
}

export function decodeSummary(value: unknown, expectedMeetingId: string): SummaryResponse | null {
  if (!isRecord(value) || !isForMeeting(value, expectedMeetingId) || typeof value.version !== "number") return null;
  if (!isMeetingSummary(value.summary)) return null;
  const report = value.validation;
  if (!isRecord(report) || typeof report.schemaValid !== "boolean" || !Array.isArray(report.unresolvedSegmentIds)) return null;
  if (!hasCounts(report, ["schemaRetries", "mapWindows", "totalItems", "rejectedItems"])) return null;
  return value as unknown as SummaryResponse;
}

export function decodeJobList(value: unknown, expectedMeetingId: string): JobListResponse | null {
  if (!isRecord(value) || !isForMeeting(value, expectedMeetingId)) return null;
  if (!Array.isArray(value.jobs) || !value.jobs.every(isJobSummary) || !hasCounts(value.counts, JOB_STATUSES)) return null;
  return value as unknown as JobListResponse;
}

/** blocknoteJson は不透明な値（§10）。キーがあることだけを確かめる */
export function decodeNotes(value: unknown, expectedMeetingId: string): NotesResponse | null {
  if (!isRecord(value) || !isForMeeting(value, expectedMeetingId) || !("blocknoteJson" in value)) return null;
  if (typeof value.revision !== "number" || !isNullOr(value.lastAppliedSummaryVersion, "number")) return null;
  return value as unknown as NotesResponse;
}

function isModelDownload(value: unknown): value is ModelDownload {
  return isRecord(value) && typeof value.name === "string" && isNullOr(value.error, "string")
    && (value.status === "running" || value.status === "completed" || value.status === "failed");
}

/** downloads は後から足したフィールド。ない応答は空の一覧として読む */
export function decodeModels(value: unknown): ModelsResponse | null {
  if (!isRecord(value) || typeof value.ollamaReachable !== "boolean") return null;
  const flags = (item: unknown, keys: ReadonlyArray<string>): boolean =>
    isRecord(item) && typeof item.name === "string" && keys.every((k) => typeof item[k] === "boolean");
  if (!Array.isArray(value.stt) || !value.stt.every((m) => flags(m, ["installed", "selected", "recommended"]))) return null;
  if (!Array.isArray(value.llm) || !value.llm.every((m) => flags(m, ["selected", "recommended"]))) return null;
  const downloads = value.downloads === undefined ? [] : value.downloads;
  if (!Array.isArray(downloads) || !downloads.every(isModelDownload)) return null;
  return { ...(value as unknown as ModelsResponse), downloads };
}

export function decodeJobRetry(value: unknown): { jobId: string; status: string } | null {
  if (!isRecord(value) || typeof value.jobId !== "string" || typeof value.status !== "string") return null;
  return { jobId: value.jobId, status: value.status };
}

export function decodeExcluded(value: unknown): { excluded: number } | null {
  return isRecord(value) && typeof value.excluded === "number" ? { excluded: value.excluded } : null;
}

export function decodeJobId(value: unknown): { jobId: string | null } | null {
  if (!isRecord(value) || !(typeof value.jobId === "string" || value.jobId === null)) return null;
  return { jobId: value.jobId };
}

export function decodeJobsCreated(value: unknown): { jobsCreated: number } | null {
  return isRecord(value) && typeof value.jobsCreated === "number" ? { jobsCreated: value.jobsCreated } : null;
}

export function decodeUpdated(value: unknown): { updated: string[] } | null {
  if (!isRecord(value) || !Array.isArray(value.updated)) return null;
  const updated = value.updated.filter((k): k is string => typeof k === "string");
  return updated.length === value.updated.length ? { updated } : null;
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

変更点は 4 つ。(1) `source` をコンストラクタ引数に、(2) `start()` に `registerMeeting` を追加（System 側は会議レコードを作らない）、(3) `start()` に `timelineOriginEpochMs` を追加し、`startOffsetMs` / `endOffsetMs` を会議タイムライン（Mic の `sessionStartEpochMs`）基準へ正規化する（基本設計 §16.2）、(4) `frameClockDriftMs` をメタデータに載せる。それ以外は Phase 1 §15 と同一（`requestId` による `flushed` の対応付けとタイムアウト、書き込み失敗時のメモリ待機、`drainMemoryBacklog()` のサーバーへの直接送信、`exportMemoryBacklog()` による WAV の書き出し、確定を中止した会議の `discardMemoryBacklog()`（drain と直列、録音中は拒否。App の `SessionController` が使う）、`start()` の準備中は drain・破棄が空で終わってもロックを解放しないこと、`stop_requested` の保存に失敗しても末尾を Chunk にしてから Worklet を切り離すこと、メモリ待機が残る間と Mic の最終保存に失敗したときは stop 後も会議ロックを保持し `takeMeetingLock()` で App へ渡すこと（最終保存の失敗で保持したロックは drain で空になっても解放せず、渡すまで同じインスタンスの `start()` を拒否する）を含む）。会議ロックは Mic の Controller だけが持つ。そこで Mic または System のどちらかのメモリ待機が残る間は、Mic の stop 後もロックを持ち続け、両方が空になってから解放する。Mic のメモリ待機だけを見ると、Mic が空で System に末尾が残るときに Mic の `stop()` がロックを手放し、別タブの Barrier が System の末尾を数えられないまま確定しうるためである。配線は次のとおり。

1. Mic の Controller にだけ `otherSourceBacklogCount: () => systemController.memoryBacklogCount` を渡す。Mic の `stop()` の最後と、`drainMemoryBacklog()`・`discardMemoryBacklog()` が空にしたときの解放は、自身のメモリ待機に加えてこの値も 0 のときだけロックを解放する。
2. 停止は `DualRecorder.stop()`（§6）のとおり System を先に止め、完了してから Mic を止める。System の末尾 Chunk がメモリ待機に入るか確定した後で、Mic がロックを手放すか決めるためである。System の停止が失敗しても Mic は止めて停止理由を永続化し、その後で System の失敗を投げる。Mic の停止も失敗したときは、Mic の失敗を先頭（停止状態の復旧に使う主たる失敗）、System の失敗を 2 番目にした `AggregateError` で両方を投げる。録音中に `dropSystem()` で System だけ止めた場合も、App はその System Controller を保持し続け、`otherSourceBacklogCount` と合計件数に数える（null にした後もメモリ待機は残りうる）。
3. App は Mic の `stop()` の直後に `takeMeetingLock()` でロックを受け取り（Phase 1 §31 の `heldLocks`）、`memoryBacklogCount(meetingId)` と `releaseHeldLockIfDrained()` は Mic と System の件数の合計で判定する。合計が 0 になるまでロックを解放しない。
4. 確定中止後の破棄（`App.discardMemoryBacklog()`、Phase 1 §31）は Mic と System の両方の Controller で `discardMemoryBacklog()` を呼ぶ。ロックは 3. で App が受け取っているので、両方を空にした後の `releaseHeldLockIfDrained()`（合計 0 で解放）で手放す。Controller 側の解放判定も `otherSourceBacklogCount` を数えるので、片方だけ空にしてもロックは外れない。
5. System 側の drain も Mic 側と同じく App の drain 関数で包む。空になったら `releaseHeldLockIfDrained()` を呼び、確定の再試行（`onChunkSaved`）を起こす。サーバー復帰時（`onBackendAvailable`）は Mic と System の両方を drain してから確定を再試行する。Finalizer の `unpersistedChunkCount` も両方の合計を渡す（§7）。`retryFinalize()` が Barrier の前に行う drain（サーバーが使えなければ IDB への書き戻しだけ。送信中のトークン変更で送れなければ drain を終えてから送り直す。Phase 1 §31）も、Mic と System の両方を対象にする。共有の IDB 保存警告を外す判定（`otherMeetingsBacklogCount`）には、他の会議に加えて同じ会議のもう一方の source の Controller も数える。Phase 1 で追加した `onMeetingCreated` は Mic 側で維持し、IDB 障害時の直接送信用の会議情報を保持する。System 側は既存の Mic 会議を使う。

`stop()` の最後の会議レコード保存だけは Phase 1 と形が違う。Phase 1 は Controller が会議レコードを保持し、その `sessionClock` が Controller の時計と同じオブジェクトなので、保存し直すだけで最終 `audioFrameCount` が残る。Phase 2 は `registerMeeting` のため会議レコードを IndexedDB から読み直すので、別オブジェクトになる。そこで Mic 側は、最終 Chunk の書き込み完了後に会議レコードを読み直し、Controller の `SessionClock` を写した新しいオブジェクトとして保存する。`sessionClock` は `readonly` なので、書き換えずに置き換える。最初の読み取り（`meetingStore.get`）に失敗した場合も書き込み失敗と同じく扱い、`requestFlush("stop")` で末尾を Chunk にしてから Worklet を切り離す。最後の保存では `status: "stop_requested"` と、未記録なら最初の停止理由・検出時刻も書く。最初の読み書きに失敗したまま会議が `recording` で残り、停止が完了したことにならないようにするためである。最後の読み取りがエラーなしで会議を見つけられなかった場合は、最初の読み書きが成功していても、最終の `audioFrameCount` と停止状態を書く先がないので `stop()` を reject する（読み書きの失敗は従来どおり `statusError` で扱い、会議の欠落とは区別する）。完了として返すと、App が最終の停止状態のないまま確定へ進むためである。System 側は会議レコードを持たないので何もしない。

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
  type RecordingStopReason,
  type SessionClock,
  type WorkletCommand,
  type WorkletEvent,
} from "../types/recording";
import { computeFrameClockDriftMs, createSessionClock, frameToOffsetMs } from "./session-clock";
import { buildStandaloneWav } from "../audio/wav";
import { ChunkStore, MeetingStore, isQuotaExceeded, isValidStopDetectedAt } from "../storage/idb";
import { tryAcquireMeetingLock, type MeetingLockManager } from "./meeting-lock";
import type { SaveOutcome } from "../api/local-saver";

/** Chunk を保存 State Machine に投入する口。LocalSaveScheduler が構造的に満たす（テストでは差し替える）。Phase 1 §15 と同じ */
export interface ChunkEnqueuer {
  enqueue(chunkKey: string): Promise<void>;
}

/** IDB を経由せずサーバーへ Chunk を送る口。LocalSaver が構造的に満たす（Phase 1 §15 と同じ） */
export interface DirectChunkSaver {
  put(record: AudioChunkRecord): Promise<SaveOutcome>;
}

/** メモリ待機中の Chunk を利用者の手元へ書き出すためのファイル（Phase 1 §15 と同じ） */
export interface MemoryBacklogFile {
  readonly fileName: string;
  readonly wav: Blob;
  readonly meta: ChunkTimingMetadata;
}

export interface RecordingControllerDeps {
  readonly audioContext: AudioContext;
  readonly mediaStream: MediaStream;
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly scheduler: ChunkEnqueuer;
  readonly health: RecordingHealth;
  readonly workletModuleUrl: string;
  readonly onError: (error: Error) => void;
  /** mic の ended だけを上位へ通知する（Phase 1 T12-b）。system 終了では mic を止めない。 */
  readonly onMicEnded?: () => void;
  /** flush / stop の応答待ちタイムアウト用。既定は setTimeout（Phase 1 §15 と同じ） */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  /** 録音中の会議ロック（本番は navigator.locks、Phase 1 §15 と同じ）。会議レコードを作る側（Mic）だけが取る */
  readonly locks: MeetingLockManager;
  /** IDB に書けない Chunk をサーバーへ直接送る（Phase 1 §15 と同じ）。省略時は直接送らない */
  readonly directSaver?: DirectChunkSaver;
  /** Phase 1: IDB 障害時の直接送信用に開始時の会議情報を保持する。Mic 側だけが通知する。 */
  readonly onMeetingCreated?: (meeting: MeetingRecord) => void;
  /** Mic 側だけに渡す System Controller の memoryBacklogCount。0 でない間は stop 後も会議ロックを解放しない（§4） */
  readonly otherSourceBacklogCount?: () => number;
  /** このタブの他の Controller（他の会議と、同じ会議のもう一方の source）のメモリ待機件数。0 になるまで共有の IDB 保存警告を外さない（Phase 1 §15） */
  readonly otherMeetingsBacklogCount?: () => number;
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

/**
 * createMediaStreamSource が使う音声トラック（Phase 1 §15 と同じ）。Web Audio の仕様では、id をコード単位順に並べて最初のトラックだけを使う。
 * 監視するトラックをこれと揃える（別のトラックの終了を、録音中のトラックの切断と取り違えない）
 */
export function selectSourceTrack(mediaStream: Pick<MediaStream, "getAudioTracks">): MediaStreamTrack | undefined {
  let selected: MediaStreamTrack | undefined;
  for (const track of mediaStream.getAudioTracks()) {
    if (selected === undefined || track.id < selected.id) selected = track;
  }
  return selected;
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
  /** 会議ロックの解放。registerMeeting の start で取得し、stop の完了で解放する（Phase 1 §15 と同じ） */
  private releaseLock: (() => void) | null = null;
  /** Mic の stop の最終保存に失敗したか。drain で空になってもロックを解放せず、takeMeetingLock で渡すまで持つ（Phase 1 §15 と同じ） */
  private finalStopUnsaved = false;
  /** この録音で切断を処理済みか。health は録音をまたいで共有されるので、degradedReasons では判定しない（Phase 1 §15 と同じ） */
  private trackEndedHandled = false;
  /** drainMemoryBacklog の直列化 */
  private drainQueue: Promise<unknown> = Promise.resolve();
  /** 実行中の stop。重なった stop はこれを待ち、完了までは次の録音を始めない（Phase 1 §15 と同じ） */
  private stopping: Promise<void> | null = null;
  /** start の準備中か。node はまだ null なので、この間に drain・破棄が空で終わっても会議ロックを解放しない（Phase 1 §15 と同じ） */
  private starting = false;
  /** トラックの ended リスナーの解除用。stop で abort する（Phase 1 §15 と同じ） */
  private trackListeners: AbortController | null = null;

  constructor(private readonly deps: RecordingControllerDeps, readonly source: AudioSource = "mic") {}

  get sessionClock(): SessionClock | null {
    return this.clock;
  }

  get chunkCount(): number {
    return this.nextSequenceNo;
  }

  async start(meetingId: string, title: string, consentConfirmedAt: number, options: StartOptions = {}): Promise<void> {
    if (this.stopping !== null) throw new Error("previous recording is still stopping");
    // 前の録音のメモリ待機が残るうちは始めない（Phase 1 §15。保持中のロックの解放手段を上書きし、別会議の Chunk も混ざる）
    if (this.memoryBacklog.length > 0) throw new Error("memory backlog from the previous recording remains");
    // 最終保存の失敗で保持したロックも、呼び出し元が takeMeetingLock で受け取るまでは上書きしない（Phase 1 §15）
    if (this.releaseLock !== null) throw new Error("meeting lock from the previous recording is still held");
    if (options.registerMeeting !== false) {
      // recording を書く前にロックを取る（Phase 1 §15）。System 側は Mic のロックに乗る
      const release = await tryAcquireMeetingLock(this.deps.locks, meetingId);
      if (release === null) throw new Error(`meeting ${meetingId} is already being recorded`);
      this.releaseLock = release;
    }
    this.starting = true;
    try {
      await this.setUp(meetingId, title, consentConfirmedAt, options);
    } catch (error) {
      this.unlock();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async setUp(meetingId: string, title: string, consentConfirmedAt: number, options: StartOptions): Promise<void> {
    const { audioContext, mediaStream, workletModuleUrl } = this.deps;
    try {
      await audioContext.audioWorklet.addModule(workletModuleUrl);
      this.clock = createSessionClock(audioContext);
      this.meetingId = meetingId;
      // 連番は会議ごと（Phase 1 §15 と同じ）。chunkCount も会議ごとの数になる
      this.nextSequenceNo = 0;
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
        this.deps.onMeetingCreated?.(meeting);
        await this.deps.meetingStore.put(meeting);
      }
    } catch (error) {
      // recording はまだ保存されていないので会議は巻き戻さない。stop() は Worklet がないと何もしないため、
      // マイク／画面共有トラックだけここで止める（Phase 1 §15 と同じ）。ロックは start() の catch が解放する
      for (const track of mediaStream.getAudioTracks()) track.stop();
      this.meetingId = null;
      this.clock = null;
      throw error;
    }

    /** 録音に使うトラック。切断の監視はこのトラックだけにする（使っていないトラックの終了で録音を止めない） */
    let sourceTrack: MediaStreamTrack | undefined;
    try {
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
      this.node = node;
      sourceTrack = selectSourceTrack(mediaStream);
      this.sourceNode = audioContext.createMediaStreamSource(mediaStream);
      this.sourceNode.connect(node);

      this.post({ type: "configure", vad: DEFAULT_VAD_CONFIG });
      this.post({ type: "start" });
    } catch (error) {
      await this.rollBackStart(meetingId, options);
      throw error;
    }

    this.trackEndedHandled = false;
    // 前の録音の切断を、この録音の不健全として表示しない（Phase 1 §15 と同じ）
    this.deps.health.degradedReasons = this.deps.health.degradedReasons.filter((r) => r !== this.endedReason);
    this.trackListeners = new AbortController();
    if (sourceTrack !== undefined) {
      sourceTrack.addEventListener("ended", () => this.handleTrackEnded(), { signal: this.trackListeners.signal });
      // 登録前に終了したトラックには ended が届かない（Phase 1 §15 と同じ）
      if (sourceTrack.readyState === "ended") this.handleTrackEnded();
    }
  }

  private get endedReason(): "MIC_TRACK_ENDED" | "SYSTEM_TRACK_ENDED" {
    return this.source === "mic" ? "MIC_TRACK_ENDED" : "SYSTEM_TRACK_ENDED";
  }

  /** トラックの切断を録音ごとに 1 回だけ処理する。 */
  private handleTrackEnded(): void {
    // stop 後（node === null）に届いた ended は次の録音の健全性判定を汚すため無視する（Phase 1 §15 と同じ）
    if (this.node === null || this.trackEndedHandled) return;
    this.trackEndedHandled = true;
    // SYSTEM_TRACK_ENDED は SystemCapture 側の addReason でも追加されるので重複させない
    if (!this.deps.health.degradedReasons.includes(this.endedReason)) {
      this.deps.health.degradedReasons = [...this.deps.health.degradedReasons, this.endedReason];
    }
    if (this.source === "mic") this.deps.onMicEnded?.();
  }

  /**
   * recording を保存した後の start 失敗を巻き戻す（Phase 1 §15 と同じ）。Worklet を切り離し、
   * このインスタンスが登録した会議だけを created に戻す。巻き戻しの保存失敗は onError に通知する。
   * stop() は Worklet がないと何もしないため、マイク／画面共有トラックもここで止める。
   */
  private async rollBackStart(meetingId: string, options: StartOptions): Promise<void> {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    if (this.node !== null) this.node.port.onmessage = null;
    this.node = null;
    for (const track of this.deps.mediaStream.getAudioTracks()) track.stop();
    this.meetingId = null;
    this.clock = null;
    if (options.registerMeeting === false) return;
    try {
      const meeting = await this.deps.meetingStore.get(meetingId);
      if (meeting !== undefined) await this.deps.meetingStore.put({ ...meeting, status: "created", updatedAt: Date.now() });
    } catch (rollbackError) {
      this.deps.onError(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
    }
  }

  async flush(): Promise<void> {
    if (this.node === null) return;
    await this.requestFlush("flush");
    await this.chunkQueue;
  }

  /** 重なった呼び出しは実行中の停止を共有する（Phase 1 §15 と同じ） */
  stop(reason: RecordingStopReason = "manual", detectedAtEpochMs = Date.now()): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    if (this.node === null || this.meetingId === null) return Promise.resolve();
    const run = this.stopOnce(reason, detectedAtEpochMs).finally(() => {
      this.stopping = null;
    });
    this.stopping = run;
    return run;
  }

  private async stopOnce(reason: RecordingStopReason, detectedAtEpochMs: number): Promise<void> {
    if (this.node === null || this.meetingId === null) return;
    let statusError: unknown = null;
    let finalSaved = false;
    /** 最終の読み取りがエラーなしで会議を見つけられなかった（最終の audioFrameCount と stop_requested を書く先がない） */
    let finalMissing = false;
    try {
      if (this.source === "mic") {
        // 読み取りに失敗しても下の requestFlush まで進み、末尾を Chunk にしてから Worklet を切り離す（書き込み失敗と同じ扱い）
        let meeting: MeetingRecord | undefined;
        try {
          meeting = await this.deps.meetingStore.get(this.meetingId);
        } catch (error) {
          statusError = error;
        }
        if (meeting !== undefined) {
          // サーバーが受け付けない検出時刻は記録せず、未観測として扱う（Phase 1 §15 と同じ）
          if (meeting.stopReason === undefined && isValidStopDetectedAt(detectedAtEpochMs)) {
            meeting.stopReason = reason;
            meeting.stopDetectedAtEpochMs = detectedAtEpochMs;
          }
          meeting.status = "stop_requested";
          // 保存に失敗しても Worklet を切り離す前に末尾を Chunk にする（Phase 1 §15 と同じ）
          try {
            await this.deps.meetingStore.put(meeting);
          } catch (error) {
            statusError = error;
          }
        }
      }
      await this.requestFlush("stop");
      await this.chunkQueue;
      if (this.source === "mic" && this.clock !== null) {
        // flush 後の最終 audioFrameCount を永続化する（Finalizer が totalAudioFrames として送る値、Phase 1 §15）。
        // 会議レコードは IDB から読み直した別オブジェクトなので、Controller の SessionClock を写して保存し直す
        const meeting = await this.deps.meetingStore.get(this.meetingId);
        if (meeting !== undefined) {
          // 最初の読み書きに失敗していても、ここで stop_requested と最初の停止理由を書く（recording のまま停止を完了させない）
          const firstStop = meeting.stopReason === undefined && isValidStopDetectedAt(detectedAtEpochMs) ? { stopReason: reason, stopDetectedAtEpochMs: detectedAtEpochMs } : {};
          await this.deps.meetingStore.put({ ...meeting, ...firstStop, status: "stop_requested", sessionClock: { ...this.clock }, updatedAt: Date.now() });
          finalSaved = true;
        } else finalMissing = true;
      }
      // 最終保存で stop_requested も書けていれば停止は完了。最初の失敗は通知だけにし、App を確定へ進める（Phase 1 §15）
      if (statusError !== null && finalSaved) this.deps.onError(statusError instanceof Error ? statusError : new Error(String(statusError)));
      else if (statusError !== null) throw statusError;
      // 最終の読み取りで会議がない。最初の保存が済んでいても最終の停止状態は保存できていないので、完了として App を確定へ進めない
      // （読み取り・書き込みの失敗は上の statusError で扱い、ここでは会議の欠落だけを判定する）
      else if (finalMissing) throw new Error(`meeting ${this.meetingId} not found; stop state not saved`);
    } finally {
      // 途中で reject してもマイク／画面共有トラックと Worklet を解放する（Phase 1 §15 と同じ）
      this.sourceNode?.disconnect();
      if (this.node !== null) this.node.port.onmessage = null;
      this.node = null;
      this.trackListeners?.abort();
      this.trackListeners = null;
      for (const track of this.deps.mediaStream.getAudioTracks()) track.stop();
      // メモリ待機が残るうちはロックを持ち続ける（Phase 1 §15。別タブの Barrier はこのタブのメモリ待機を数えられない）。System 側の分も数える
      // Mic の最終保存（最終の audioFrameCount）に失敗したときも、別タブが古い値で確定しないよう保持する（Phase 1 §15）
      this.finalStopUnsaved = this.source === "mic" && !finalSaved;
      if (this.memoryBacklog.length === 0 && (this.deps.otherSourceBacklogCount?.() ?? 0) === 0 && !this.finalStopUnsaved) this.unlock();
    }
  }

  /** stop 後もメモリ待機のために保持しているロックを呼び出し元へ渡す（Phase 1 §15 と同じ）。保持していなければ null */
  takeMeetingLock(): (() => void) | null {
    if (this.node !== null) return null;
    const release = this.releaseLock;
    this.releaseLock = null;
    this.finalStopUnsaved = false;
    return release;
  }

  private unlock(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /** クォータ以外の失敗はサーバーへ直接送る。直接送信も失敗したら元の例外を投げ、メモリ待機に残す（Phase 1 §15 と同じ） */
  drainMemoryBacklog(): Promise<number> {
    // 並行させない。先頭を読んでから外すまでに別の drain が先頭を外すと、送っていない Chunk を外してしまう（Phase 1 §15 と同じ）
    const run = this.drainQueue.then(() => this.drainSerially());
    this.drainQueue = run.catch(() => undefined);
    return run;
  }

  private async drainSerially(): Promise<number> {
    let drained = 0;
    while (this.memoryBacklog.length > 0) {
      const record = this.memoryBacklog[0];
      try {
        await this.deps.chunkStore.putChunk(record);
      } catch (error) {
        // クォータ超過は空きを待つ。ただし停止後は空きを作る保存が続かないので、サーバーに登録できれば直接送る（Phase 1 §15）
        if (isQuotaExceeded(error)) {
          if (!(await this.sendDirect(record))) break;
          this.memoryBacklog.shift();
          drained++;
          continue;
        }
        if (!(await this.sendDirect(record))) throw error;
        this.memoryBacklog.shift();
        drained++;
        continue;
      }
      this.memoryBacklog.shift();
      record.save.status = "IDB_STORED";
      await this.deps.scheduler.enqueue(record.chunkKey);
      drained++;
    }
    if (this.memoryBacklog.length === 0) this.onMemoryBacklogEmptied();
    return drained;
  }

  /**
   * 停止後のメモリ待機を捨てる。確定を中止した会議で、利用者が書き出した WAV の保存を確かめた後だけ呼ぶ（Phase 1 §15・§31 と同じ）。
   * drain と並行させない。録音中は捨てない（採番済みの Chunk を捨てると欠番になる）。App は Mic と System の両方の Controller で呼ぶ
   */
  discardMemoryBacklog(): Promise<number> {
    const run = this.drainQueue.then(() => {
      if (this.node !== null) throw new Error("cannot discard memory backlog while recording");
      const discarded = this.memoryBacklog.length;
      this.memoryBacklog.length = 0;
      this.onMemoryBacklogEmptied();
      return discarded;
    });
    this.drainQueue = run.catch(() => undefined);
    return run;
  }

  private onMemoryBacklogEmptied(): void {
    // IDB の劣化理由は「メモリ待機がクラッシュで失われうる」ことの警告。このタブの全 Controller のメモリ待機が空になったら外す（Phase 1 §15）
    if ((this.deps.otherMeetingsBacklogCount?.() ?? 0) === 0) {
      this.deps.health.degradedReasons = this.deps.health.degradedReasons.filter(
        (r) => r !== "IDB_QUOTA_EXHAUSTED" && r !== "IDB_WRITE_FAILED",
      );
    }
    // stop 後に保持していたロック（takeMeetingLock で渡していなければ）を解放する。System 側のメモリ待機が残るうち、
    // Mic の最終保存に失敗したとき、start の準備中は持ち続ける（Phase 1 §15）
    if (this.node === null && !this.starting && (this.deps.otherSourceBacklogCount?.() ?? 0) === 0 && !this.finalStopUnsaved) this.unlock();
  }

  get memoryBacklogCount(): number {
    return this.memoryBacklog.length;
  }

  /** メモリ待機中の Chunk を WAV として書き出す。書き出してもメモリ待機からは外さない（Phase 1 §15 と同じ） */
  exportMemoryBacklog(): MemoryBacklogFile[] {
    const files: MemoryBacklogFile[] = [];
    for (const record of this.memoryBacklog) {
      if (record.wav === null) continue;
      const { meetingId, source, sequenceNo } = record.meta;
      // chunkKey の ":" はファイル名に使えない OS があるため、"_" で区切る
      files.push({ fileName: `${meetingId}_${source}_${sequenceNo.toString().padStart(6, "0")}.wav`, wav: record.wav, meta: record.meta });
    }
    return files;
  }

  private async sendDirect(record: AudioChunkRecord): Promise<boolean> {
    if (this.deps.directSaver === undefined) return false;
    const outcome = await this.deps.directSaver.put(record);
    // Scheduler の PUT 成功と同じく、サーバーに書けたら（DB 未登録でも）保存の成功時刻を進める（Phase 1 §15 と同じ）
    if (outcome.ok) this.deps.health.lastSuccessfulLocalSaveAt = performance.now();
    // DB 未登録（registered: false）は成功にしない。IDB にもないので外すと Finalizer が埋められない欠番になる
    return outcome.ok && outcome.registered;
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
      // メモリ待機はクラッシュで失われるため、理由を問わず UI に出す（Phase 1 §15）
      const reason = isQuotaExceeded(error) ? "IDB_QUOTA_EXHAUSTED" : "IDB_WRITE_FAILED";
      if (!this.deps.health.degradedReasons.includes(reason)) {
        this.deps.health.degradedReasons = [...this.deps.health.degradedReasons, reason];
      }
      if (reason === "IDB_QUOTA_EXHAUSTED") return;
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

停止理由・検出時刻の永続化は Phase 1 §12 を継承する。組み立て層は最初の停止要求の理由と epoch ms を確定して `MultiSourceRecorder.stop(reason, detectedAtEpochMs)` に渡し、System の終了を待っている間にも上書きしない。System単独の共有終了は会議の停止理由にしない。

T12-b の mic 切断通知を組み立て層へ接続するときは、このコーディネータ全体の停止を一度だけ呼び、system 終了とは区別する。T12-d の `abandoned` はブラウザ内だけの状態であり、サーバーの `MeetingStatusV2` へ追加しない。

Mic と System の 2 つの `RecordingController` を束ね、共有 `LocalSaveScheduler` に流し、ドリフト差を計測する。Controller の生成は依存として注入し、テストでは Fake を使う。

```typescript
// src/recording/multi-source-recorder.ts
import type { AudioSource, RecordingHealth, RecordingStopReason, SessionClock } from "../types/recording";
import { computeFrameClockDriftMs } from "./session-clock";

/** RecordingController のうち本クラスが使う面だけを切り出した契約。テストで Fake に差し替える。 */
export interface SourceController {
  readonly source: AudioSource;
  readonly sessionClock: SessionClock | null;
  readonly chunkCount: number;
  start(meetingId: string, title: string, consentConfirmedAt: number, options: { registerMeeting: boolean; timelineOriginEpochMs?: number }): Promise<void>;
  stop(reason?: RecordingStopReason, detectedAtEpochMs?: number): Promise<void>;
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

  /**
   * System を先に止め、最後に Mic を止める（Mic 側が meeting.status を stop_requested にする）。
   * 検出時刻の既定値は epoch ms（Date.now）。deps.now はドリフト計測用の performance 時計なので使わない。
   * System の停止が失敗しても Mic は止め、停止理由を永続化してから System の失敗を投げる（マイクを取得したまま残さない）。
   * 両方失敗したら、Mic の失敗を errors[0]（停止状態の復旧に使う主たる失敗）、System の失敗を errors[1] にした AggregateError を投げる。
   */
  async stop(reason: RecordingStopReason = "manual", detectedAtEpochMs = Date.now()): Promise<{ readonly mic: number; readonly system: number }> {
    let systemError: unknown = null;
    try {
      if (this.system !== null) await this.system.stop();
    } catch (error) {
      systemError = error;
    }
    try {
      if (this.mic !== null) await this.mic.stop(reason, detectedAtEpochMs);
    } catch (micError) {
      // Mic の失敗だけを投げると System の失敗が報告されずに消える
      if (systemError === null) throw micError;
      throw new AggregateError([micError, systemError], "mic and system stop failed");
    }
    if (systemError !== null) throw systemError;
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

mic / system の両方を検証する。System なしの会議は `expectedChunkCounts.system = 0`。会議の状態の検査（`finalized` なら POST せず成功を返す、`stop_requested` / `finalizing` 以外は `verify` で失敗させる）と、`GET /chunks` の応答を `isChunkListResponse` に通し `meetingId` の一致を確かめる検査は Phase 1 §22 と同じ。連続性検査をサーバー一覧の取得後に行い、IndexedDB にない連番でもサーバーに登録済みなら揃っているとみなす点（source ごとに判定）、確定に成功したら末尾の欠けを `missingTailMs` で返す点も Phase 1 §22 と同じ。会議登録の後の `GET /chunks`・`POST /finalize` が 401/403 を返したら、`unauthorized` で返す前に `onBackendUnauthorized` で Monitor へ伝える点も Phase 1 §22 と同じ。末尾の欠けは Mic だけで判定する。`totalAudioFrames` は Mic の時計で、System の `audioFrameCount` は会議レコードに残らないためである。

**このファイルは「Phase 1 の現行 `src/recording/finalizer.ts` に、下表の差分だけを当てたもの」である。** 実装時は Phase 1 のファイルを書き直さず、差分を当てる。Phase 1 の Finalizer はレビュー修正を重ねており（会議登録、認証・ネットワークの分類、停止理由、直接送信した Chunk）、書き直すとそれらが抜ける。

| 差分 | Phase 1 | Phase 2 |
| --- | --- | --- |
| IDB から読む Chunk | `listByMeeting(id, "mic")` | mic と system を別々に読み、未登録の検査・サーバー照合は両方に行う |
| 連番の連続性 | mic の 1 系列 | source ごとに判定（連番は source ごとに 0 から振る） |
| `expectedChunkCounts` | `{ mic: n, system: 0 }` | `{ mic: n, system: m }` |
| `finalChunkCount` | mic の件数 | mic と system の合計 |
| 失敗の文言 | `sequence gap at 3` / `server mismatch at seq 3, 5` | mic は同じ。system だけ `system: sequence gap at 3` / `server mismatch at seq system/3` |
| `unpersistedChunkCount` | Mic の Controller の件数 | 呼び出し側が Mic と System の合計を渡す（§4） |
| `FinalizeResult` | 変更なし | **変更なし**（型・`reason`・既定タイムアウト 30 秒も Phase 1 のまま） |

`FinalizeResult` を変えないので、Phase 1 の `test/finalizer.test.ts`・`test/pending-actions.test.ts`・`test/recording-view.test.ts` はそのまま通る。Phase 1 のテストで直す必要があるのは 1 か所だけである：`test/app.test.ts` の「照合不一致による再送完了で確定と再送を繰り返さない」は `chunkStore.listByMeeting` の呼び出し回数を数えているので、`source === "mic"` の呼び出しだけを数えるようにする（Phase 2 は 1 回の確定で mic と system の 2 回読む）。

```typescript
// src/recording/finalizer.ts
import { isValidStopObservation, type ChunkStore, type MeetingStore } from "../storage/idb";
import type { LocalSaveScheduler } from "./local-save-scheduler";
import { isChunkListResponse, type FinalizeRequest } from "../api/contracts";
import { assertLocalHost } from "../api/local-saver";
import type { RegistrationOutcome } from "../api/meeting-registrar";
import type { AudioChunkRecord, AudioSource } from "../types/recording";
import { frameToOffsetMs } from "./session-clock";

export interface FinalizerDeps {
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly scheduler: LocalSaveScheduler;
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** GET /chunks と POST /finalize それぞれのタイムアウト。既定 30000ms */
  readonly timeoutMs?: number;
  readonly onBackendUnauthorized?: () => void;
  /** IDB に書けずメモリ待機中の Chunk 数。mic / system 両 Controller の memoryBacklogCount の合計を渡す。0 でない限り Barrier を通さない。 */
  readonly unpersistedChunkCount: () => number;
  /** 照合の前に会議をサーバーへ登録する（MeetingRegistrar.ensure）。Chunk を 1 件も PUT できていない会議は一覧・確定が 404 になるため */
  readonly ensureMeeting?: (meetingId: string) => Promise<RegistrationOutcome>;
  /** IDB にない Mic の Chunk（このタブが直接送信した分）の endFrame。末尾を直接送ったときも末尾の欠けを測るために使う */
  readonly offIdbEndFrame?: (sequenceNo: number) => number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export type FinalizeResult =
  /** missingTailMs：Mic の末尾の Chunk が欠けたまま確定した長さ（ms）。欠けがなければ省く（T1-e）。System は録音の長さの正を持たないので測らない */
  | { readonly ok: true; readonly missingTailMs?: number }
  /**
   * reason：失敗の分類。"unauthorized" はトークン未設定・サーバーの 401/403 で、UI はトークンの確認を案内する。
   * "network" はサーバーへの要求が応答を得られなかった（接続失敗・タイムアウト）。ヘルス状態が変わらないこともあるので、呼び出し元が時間をおいて再試行する。
   * detail はサーバー由来の文字列を含みうるので、分類には使わない
   */
  | { readonly ok: false; readonly stage: "waiting_local_save" | "verify" | "finalize"; readonly detail: string; readonly reason?: "unauthorized" | "network" };

/**
 * Finalization Barrier：
 *   1. 最終 Chunk が IDB にある（呼び出し前提：RecordingController.stop() 完了）かつメモリ待機中の Chunk がない
 *   2. IDB 上の全 Chunk が DB_REGISTERED（SAVED はサーバー一覧で登録確認できれば DB_REGISTERED に進める）
 *   3. 会議がサーバーに登録済み（ensureMeeting。再試行のたびに通し、失敗したら一覧を取らない）
 *   4. サーバーの一覧と件数・sha256 が一致（IDB にない連番は、サーバーに登録済みなら揃っているとみなす）
 *   5. POST /finalize
 * 1〜4 を満たさない限り finalizing へ遷移しない。
 * Phase 2：2・4 は mic / system の両方に対して行う。System を録っていない会議は system が 0 件で、Phase 1 と同じ結果になる。
 */
const SOURCES: ReadonlyArray<AudioSource> = ["mic", "system"];

export function finalizeMeeting(deps: FinalizerDeps, meetingId: string): Promise<FinalizeResult> {
  // 同じ会議への呼び出しが重なると、両方が stop_requested を読んで二重に POST し、
  // 後から失敗した側が finalized を stop_requested で上書きしうる。実行中の Promise を共有して 1 本にする
  const running = inProgress.get(meetingId);
  if (running !== undefined) return running;
  const promise = finalizeMeetingOnce(deps, meetingId).finally(() => inProgress.delete(meetingId));
  inProgress.set(meetingId, promise);
  return promise;
}

/** meetingId → 実行中の finalize。同じタブ内の重複呼び出しだけを束ねる */
const inProgress = new Map<string, Promise<FinalizeResult>>();

async function finalizeMeetingOnce(deps: FinalizerDeps, meetingId: string): Promise<FinalizeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const meeting = await deps.meetingStore.get(meetingId);
  if (meeting === undefined) return { ok: false, stage: "verify", detail: "meeting not found" };
  // 二重に POST /finalize して endedAt を書き換えない
  if (meeting.status === "finalized") return { ok: true };
  // recording 中は最終 Chunk が IDB にある前提（stop() 完了）を満たさない。finalizing は POST 中に中断された会議の再試行
  if (meeting.status !== "stop_requested" && meeting.status !== "finalizing") {
    return { ok: false, stage: "verify", detail: `meeting status is ${meeting.status}` };
  }

  // 末尾の Chunk がメモリ待機中だと IDB 上は欠番なしに見えるため、件数不足のまま finalize しないよう先に弾く
  const unpersisted = deps.unpersistedChunkCount();
  if (unpersisted > 0) {
    return { ok: false, stage: "waiting_local_save", detail: `${unpersisted} chunks not persisted to IDB` };
  }

  const bySource: Record<AudioSource, AudioChunkRecord[]> = {
    mic: await deps.chunkStore.listByMeeting(meetingId, "mic"),
    system: await deps.chunkStore.listByMeeting(meetingId, "system"),
  };
  const chunks = [...bySource.mic, ...bySource.system];
  // SAVED（ファイル保存済み・DB 未登録）は再送しても registered: false が続きうるため、サーバー一覧で確認する
  const notRegistered = chunks.filter((c) => c.save.status !== "DB_REGISTERED" && c.save.status !== "SAVED");
  if (notRegistered.length > 0) {
    await deps.scheduler.resumeAll();
    return { ok: false, stage: "waiting_local_save", detail: `${notRegistered.length} chunks not registered` };
  }

  // 再試行でも毎回通す。登録に失敗したら一覧を取らない（401/403 は MeetingRegistrar が Monitor へ報告済み）
  if (deps.ensureMeeting !== undefined) {
    const registration = await deps.ensureMeeting(meetingId);
    if (!registration.ok) {
      const kind = registration.error.kind;
      const reason = kind === "UNAUTHORIZED" ? { reason: "unauthorized" as const } : kind === "NETWORK" || kind === "TIMEOUT" ? { reason: "network" as const } : {};
      return { ok: false, stage: "verify", detail: `meeting registration failed: ${registration.error.message}`, ...reason };
    }
  }

  const listUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/chunks`, deps.baseUrl);
  assertLocalHost(listUrl);
  // タイムアウトで abort すると fetch / json() が reject し、既存のエラー経路で Result になる
  const listAbort = new AbortController();
  const listTimer = setTimeout(() => listAbort.abort(), timeoutMs);
  let listRes: Response;
  let list: unknown;
  try {
    listRes = await fetchImpl(listUrl, { headers: { Authorization: `Bearer ${deps.token}` }, credentials: "omit", redirect: "error", signal: listAbort.signal });
    // サーバー応答は外部入力。型ガードを通してから使う（壊れた JSON も Result で返す）
    // null（壊れた応答）にするのは JSON の構文エラーだけ。本文の読み取り中の abort（タイムアウト）や
    // 通信エラーは network として下の catch へ流す
    list = listRes.ok
      ? await listRes.json().catch((error: unknown) => {
        if (error instanceof SyntaxError && !listAbort.signal.aborted) return null;
        throw error;
      })
      : null;
  } catch (error) {
    return { ok: false, stage: "verify", detail: `list request failed: ${errorMessage(error)}`, reason: "network" };
  } finally {
    clearTimeout(listTimer);
  }
  if (listRes.status === 401 || listRes.status === 403) {
    deps.onBackendUnauthorized?.();
    return { ok: false, stage: "verify", detail: `list HTTP ${listRes.status}`, reason: "unauthorized" };
  }
  if (!listRes.ok) return { ok: false, stage: "verify", detail: `list HTTP ${listRes.status}` };
  if (!isChunkListResponse(list)) return { ok: false, stage: "verify", detail: "malformed ChunkListResponse" };
  // 別会議の一覧で照合すると、同一内容（無音など）の Chunk を誤って DB_REGISTERED にしうる
  if (list.meetingId !== meetingId) return { ok: false, stage: "verify", detail: `list meetingId mismatch: ${list.meetingId}` };

  // sequenceNo の連続性（欠番なし）。IDB に書けずサーバーへ直接送った Chunk（§15 drainMemoryBacklog）は IDB に残らないので、
  // IDB にない連番はサーバーに登録済みなら揃っているとみなす。IDB の件数で送ると、サーバーは件数不一致の 409 を返し続ける
  // 連番は source ごとに 0 から振られるので、source ごとに判定する
  const counts: Record<AudioSource, number> = { mic: 0, system: 0 };
  for (const source of SOURCES) {
    const localSeqs = new Set(bySource[source].map((c) => c.meta.sequenceNo));
    const serverOnlySeqs = new Set(
      list.chunks.filter((c) => c.source === source && c.registered && !localSeqs.has(c.sequenceNo)).map((c) => c.sequenceNo),
    );
    counts[source] = Math.max(-1, ...localSeqs, ...serverOnlySeqs) + 1;
    for (let i = 0; i < counts[source]; i++) {
      if (!localSeqs.has(i) && !serverOnlySeqs.has(i)) {
        // mic の文言は Phase 1 と同じ（Phase 1 のテストと UI がそのまま通る）。system だけ接頭辞を付ける
        return { ok: false, stage: "verify", detail: `${source === "mic" ? "" : "system: "}sequence gap at ${i}` };
      }
    }
  }

  const serverByKey = new Map(list.chunks.map((c) => [`${c.source}:${c.sequenceNo}`, c]));
  // 不一致を 1 件ずつ直すと Barrier の再試行が件数分かかるため、すべて洗い出してから一度に再投入する
  const mismatched: string[] = [];
  for (const c of chunks) {
    const s = serverByKey.get(`${c.meta.source}:${c.meta.sequenceNo}`);
    if (s === undefined || s.sha256 !== c.meta.sha256 || !s.registered) {
      await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
        r.save.status = "LOCAL_SAVE_PENDING";
      });
      mismatched.push(c.meta.source === "mic" ? String(c.meta.sequenceNo) : `system/${c.meta.sequenceNo}`);
      continue;
    }
    if (c.save.status === "SAVED") {
      await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
        r.save.status = "DB_REGISTERED";
      });
    }
  }
  if (mismatched.length > 0) {
    await deps.scheduler.resumeAll();
    return { ok: false, stage: "verify", detail: `server mismatch at seq ${mismatched.join(", ")}` };
  }

  // finalizing へ進める前の値を控える。POST が失敗・タイムアウトしたら status と一緒にここへ戻す
  const before = { finalChunkCount: meeting.finalChunkCount };
  const restore = async (): Promise<void> => {
    meeting.status = "stop_requested";
    meeting.finalChunkCount = before.finalChunkCount;
    await deps.meetingStore.put(meeting);
  };

  meeting.status = "finalizing";
  // mic と system の合計。件数の内訳は確定要求の expectedChunkCounts が持つ
  meeting.finalChunkCount = counts.mic + counts.system;
  // 再試行で終了時刻を書き換えない（前回の POST がサーバーに届いていた場合と値を揃える）
  meeting.endedAt ??= Date.now();
  await deps.meetingStore.put(meeting);

  const body: FinalizeRequest = {
    expectedChunkCounts: { mic: counts.mic, system: counts.system },
    endedAtEpochMs: meeting.endedAt,
    totalAudioFrames: meeting.sessionClock.audioFrameCount,
    // 保存済みの値がサーバーの制約を満たさなければ両方省略する（未観測）。422 で確定が止まり続けないようにし、録音は残す
    ...(isValidStopObservation(meeting) ? { stopReason: meeting.stopReason, stopDetectedAtEpochMs: meeting.stopDetectedAtEpochMs } : {}),
  };
  const finUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/finalize`, deps.baseUrl);
  assertLocalHost(finUrl);
  const finAbort = new AbortController();
  const finTimer = setTimeout(() => finAbort.abort(), timeoutMs);
  let finRes: Response;
  try {
    finRes = await fetchImpl(finUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      // リダイレクト先は assertLocalHost を通らないため追従しない（§4.4）
      redirect: "error",
      signal: finAbort.signal,
    });
  } catch (error) {
    // finalizing のまま残さない。次回の Barrier 再試行は stop_requested から行う
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize request failed: ${errorMessage(error)}`, reason: "network" };
  } finally {
    clearTimeout(finTimer);
  }
  const finUnauthorized = finRes.status === 401 || finRes.status === 403;
  if (finUnauthorized) deps.onBackendUnauthorized?.();
  if (!finRes.ok) {
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize HTTP ${finRes.status}`, ...(finUnauthorized ? { reason: "unauthorized" as const } : {}) };
  }
  meeting.status = "finalized";
  await deps.meetingStore.put(meeting);
  // 欠けた音声は取り戻せないので確定は止めず、UI が警告できるよう長さを返す（T1-e）
  // 録音の長さ（audioFrameCount）は Mic の Worklet が数えた値なので、Mic の Chunk とだけ比べる
  const missingTailMs = measureMissingTailMs(meeting.sessionClock.audioFrameCount, bySource.mic, counts.mic, deps.offIdbEndFrame);
  return missingTailMs > 0 ? { ok: true, missingTailMs } : { ok: true };
}

/**
 * 末尾の欠け（ms）。stop() が Worklet の応答を待てずに打ち切ると、最終の部分 Chunk がないまま会議が確定する。
 * audioFrameCount は heartbeat（1 秒ごと）でも進むので、最後の Chunk の endFrame より大きければ末尾が欠けている
 * （最後の heartbeat より後の 1 秒未満の欠けは検出できない）。
 * 最後の連番が IDB にない（サーバーへ直接送った）ときは offIdbEndFrame の値を使い、それも分からなければ 0 を返す。
 * Chunk が 1 件もなければ（chunkCount === 0）終わりを 0 とし、audioFrameCount 全体を欠けとして返す。
 */
export function measureMissingTailMs(
  audioFrameCount: number,
  chunks: ReadonlyArray<AudioChunkRecord>,
  chunkCount: number,
  offIdbEndFrame?: (sequenceNo: number) => number | undefined,
): number {
  const lastSeq = chunkCount - 1;
  const last = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
  // Chunk が 1 件もなければ録音した長さ全体が欠けている
  const endFrame = chunkCount === 0 ? 0 : last?.meta.sequenceNo === lastSeq ? last.meta.endFrame : offIdbEndFrame?.(lastSeq);
  if (endFrame === undefined) return 0;
  return frameToOffsetMs(Math.max(0, audioFrameCount - endFrame));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

---

# 8. SSE クライアント `src/api/events.ts`

SSE は `fetch` + `ReadableStream` で読む。`EventSource` はリクエストヘッダを付けられず、トークンが IndexedDB にある本設計（Phase 1 §4.3）では認証できないためである。自動再接続は失われるので指数バックオフで自前に持ち、接続（応答ヘッダ）の期限と無通信の監視（サーバーの keep-alive 15 秒の 3 回分）を持ち、止まった接続は中断して再接続する。購読前と切断中に取りこぼしたイベントは、初回接続と再接続の `open` のたびに `GET /meetings/{id}` と `GET /jobs` で補完する（基本設計 §14）。補完中に届いた live イベントは保留し、補完の後に届いた順で流す（接続時点の補完の値が、新しい live の値を上書きしないため）。補完が終わらないうちに再接続したら、前の接続の保留は新しい補完を始める前に流す（捨てると補完に含まれない `progress` や、新しい補完も失敗したときの status を失う）。バックオフは応答ヘッダ（200）だけでは初期値へ戻さず、`SSE_STABLE_MS`（30 秒）切れずに続き、その間にデータ（keep-alive を含む）を 1 回以上受け取った接続の後で戻す（200 を返してすぐ切れるサーバーに 1 秒間隔で再接続し続けない）。

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
  /**
   * 再接続後の補完用。失敗は無視せず onError に渡す。
   * 期限（Phase2Client の timeoutMs）までに必ず resolve か reject すること。終わらないと補完中に保留したイベントが流れない
   */
  readonly fetchJobs: () => Promise<JobListResponse>;
  /** 再接続後の補完用。会議の status と各版を取り戻す。fetchJobs と同じく期限までに必ず resolve か reject すること */
  readonly fetchMeeting: () => Promise<MeetingDetailResponse>;
  readonly onEvent: (event: MeetingEvent) => void;
  readonly onError: (error: Error) => void;
}

const EVENT_TYPES = ["job", "meeting_status", "transcript_version", "summary_version", "progress"] as const;

export class MeetingEventsClient {
  private source: EventSourceLike | null = null;
  /** 補完中に届いたイベント。補完の後に、届いた順で流す。null は補完中でない */
  private held: string[] | null = null;
  /** 補完の世代。補完の開始と close のたびに進め、古い補完の結果を捨てる */
  private generation = 0;
  /** 補完に失敗した後の取り直しの予約。補完を始め直すときと close で取り消す */
  private backfillRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: EventsClientDeps, private readonly meetingId: string) {}

  connect(): void {
    if (this.source !== null) return;
    const url = new URL(`/v1/meetings/${encodeURIComponent(this.meetingId)}/events`, this.deps.baseUrl);
    assertLocalHost(url);
    const es = this.deps.createEventSource(url, this.deps.token);
    this.source = es;

    // 初回接続も補完する。確定から購読開始までに出たイベントは SSE に乗らない。
    // 再接続は transport 側に任せ、再接続の open で同じ補完を行う
    es.addEventListener("open", () => void this.backfill());
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (event: MessageEvent<string>) => this.receive(event.data));
    }
  }

  close(): void {
    this.source?.close();
    this.source = null;
    this.generation++;
    this.held = null;
    this.cancelBackfillRetry();
  }

  /**
   * 補完中は保留し、補完の後に流す。補完は接続時点の状態なので、先に届いた live の値（新しい status・版）の後に
   * 流すと古い値で上書きしてしまう。購読は補完の要求より先に始まっているので、保留分を後から流せば最新に追いつく。
   */
  private receive(data: string): void {
    if (this.held !== null) {
      this.held.push(data);
      return;
    }
    this.handle(data);
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
  private async backfill(attempt = 0): Promise<void> {
    this.cancelBackfillRetry();
    const generation = ++this.generation;
    // 前の接続の補完が終わらないうちに再接続した。前の接続で保留した分は、この補完を始める前に流す。
    // 捨てると、補完に含まれない progress と、この補完も失敗したときの status・job を失う。
    // 新しい補完の後に流すと古い status で巻き戻すが、前に流せば「前の保留 → 新しい補完 → 新しい保留」と時間の順に並ぶ
    const previous = this.held ?? [];
    this.held = null;
    this.replay(previous);
    this.held = [];
    let failed = false;
    try {
      const meeting = await this.deps.fetchMeeting();
      // 補完中に再接続・close した。保留分は新しい接続の補完が始める前に流す（close なら捨てる）
      if (generation !== this.generation) return;
      this.deps.onEvent({ type: "meeting_status", status: meeting.status });
      this.deps.onEvent({ type: "transcript_version", transcriptVersion: meeting.transcriptVersion });
      if (meeting.latestSummaryVersion !== null) {
        this.deps.onEvent({ type: "summary_version", version: meeting.latestSummaryVersion });
      }
      const list = await this.deps.fetchJobs();
      if (generation !== this.generation) return;
      for (const job of list.jobs) this.deps.onEvent({ type: "job", job });
    } catch (error) {
      if (generation !== this.generation) return;
      // 先に失敗を記録する。onError 自体が投げても、下の保留の解放と取り直しの予約を飛ばさない
      failed = true;
      try {
        this.deps.onError(error instanceof Error ? error : new Error(String(error)));
      } catch (callbackError) {
        // 呼び出し側の不具合。投げ直すと void で呼ばれた補完の未処理の reject になるだけなので、記録して続ける
        console.error("[MeetingEventsClient] onError threw:", callbackError);
      }
    }
    // 補完に失敗しても保留分は流す（live を失わない）
    const held = this.held ?? [];
    this.held = null;
    this.replay(held);
    // 接続が開いたままだと次の open は来ず、切断中の変化（確定した status など）が戻らない。
    // 同じ接続のまま有限回だけ取り直す。取り直しも保留からやり直すので、先に流した live を古い値で巻き戻さない
    const delay = BACKFILL_RETRY_DELAYS_MS[attempt];
    if (!failed || delay === undefined) return;
    this.backfillRetry = setTimeout(() => {
      this.backfillRetry = null;
      if (generation === this.generation) void this.backfill(attempt + 1);
    }, delay);
  }

  /**
   * 保留したイベントを順に流す。onEvent などのコールバックが 1 件で投げても、残りのイベントと、
   * その後の補完の要求・取り直しの予約を飛ばさない（void で呼ばれた補完の未処理の reject になるだけなので、記録して続ける）
   */
  private replay(items: readonly string[]): void {
    for (const data of items) {
      try {
        this.handle(data);
      } catch (callbackError) {
        console.error("[MeetingEventsClient] event callback threw:", callbackError);
      }
    }
  }

  private cancelBackfillRetry(): void {
    if (this.backfillRetry !== null) clearTimeout(this.backfillRetry);
    this.backfillRetry = null;
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
/** 補完に失敗した後、同じ接続のまま取り直すまでの間隔。要素数が取り直しの上限回数 */
export const BACKFILL_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];
/** 応答ヘッダが届くまでの期限 */
export const SSE_CONNECT_TIMEOUT_MS = 10_000;
/** 無通信の許容時間。サーバーは無通信が 15 秒続くと keep-alive コメントを送る（サーバー側 api/sse.py の KEEPALIVE_S）ので、3 回分待つ */
export const SSE_IDLE_TIMEOUT_MS = 45_000;
/**
 * バックオフを初期値へ戻すまでの接続の継続時間。応答ヘッダ（200）だけでは戻さない。200 を返してすぐ切れるサーバー・
 * 経路で 1 秒間隔の再接続を繰り返さないためである。この時間（keep-alive 2 回分）切れずに続き、かつその間にデータ
 * （keep-alive を含む）を 1 回以上受け取った接続だけを健全とみなして戻す
 */
export const SSE_STABLE_MS = 30_000;

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

  /**
   * 再接続の途中で error を出す。ここは run() の try の外なので、listener の例外を通すと run() が reject して
   * waitBeforeRetry() に進まず、再接続が止まる。listener ごとに例外を受け、残りの listener も呼ぶ
   */
  private emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) {
      try {
        listener({ data: "" } as MessageEvent<string>);
      } catch (error) {
        console.error("[FetchEventSource] error listener threw:", error);
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      const controller = new AbortController();
      this.controller = controller;
      // 接続やストリームが止まったまま（スリープ復帰・経路の切断）だと read() が返らず再接続しない。
      // 期限を過ぎたら abort して下の catch → error → 再接続（MeetingEventsClient の補完）へ流す
      let watchdog = setTimeout(() => controller.abort(), SSE_CONNECT_TIMEOUT_MS);
      const kick = (): void => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), SSE_IDLE_TIMEOUT_MS);
      };
      // 健全さの判定（SSE_STABLE_MS）。タイマーは finally で必ず止め、切れた接続が後からバックオフを戻さないようにする
      let stableTimer: ReturnType<typeof setTimeout> | null = null;
      let stable = false;
      let received = false;
      const resetBackoffIfHealthy = (): void => {
        if (stable && received) this.retryMs = INITIAL_RETRY_MS;
      };
      try {
        // ブラウザの fetch はメソッドとして呼ぶと Illegal invocation になるため、取り出してから呼ぶ
        const fetchImpl = this.fetchImpl;
        const res = await fetchImpl(this.url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) throw new Error(`SSE HTTP ${res.status}`);
        kick();
        stableTimer = setTimeout(() => {
          stable = true;
          resetBackoffIfHealthy();
        }, SSE_STABLE_MS);
        this.emit("open", "");
        await this.pump(res.body, () => {
          kick();
          received = true;
          resetBackoffIfHealthy();
        });
      } catch {
        // 中断も切断も同じ扱い。close() 済みならこの下で抜ける。
        // listener の例外で抜けた場合は接続が開いたまま残るので中断する（pump は読み取り中のストリームを取り消して抜ける）。
        // 中断・切断の後の abort は何もしない
        controller.abort();
      } finally {
        clearTimeout(watchdog);
        if (stableTimer !== null) clearTimeout(stableTimer);
      }
      this.controller = null;
      if (this.closed) return;
      this.emitError();
      await this.waitBeforeRetry();
    }
  }

  /** onData は読み取りのたびに呼ぶ（keep-alive コメントも含めて無通信の監視を延ばす） */
  private async pump(body: ReadableStream<Uint8Array>, onData: () => void): Promise<void> {
    // TextDecoderStream を pipeThrough で繋ぐと、DOM 型定義の writable（BufferSource）と Uint8Array の不一致で型が通らない。
    // 同じ結果になる TextDecoder の stream モードで、マルチバイト文字が読み取り単位をまたいでも壊れないように復号する
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onData();
        buffer += decoder.decode(value, { stream: true });
        // イベントは空行区切り。LF / CRLF の両方を受ける。
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (match === null) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          this.dispatchBlock(block);
        }
      }
    } catch (error) {
      // listener の例外・読み取りの失敗で途中でやめる。ストリームを取り消して読み取りを止め、元の例外を run() へ返す
      // （中断・切断で既に壊れたストリームの取り消しは reject しうるが、伝えるべきは元の例外なので待つだけにする）
      await reader.cancel(error).then(() => undefined, () => undefined);
      throw error;
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
import {
  decodeExcluded, decodeJobId, decodeJobList, decodeJobRetry, decodeJobsCreated, decodeMeetingDetail, decodeModels,
  decodeNotes, decodeSummary, decodeTranscript, decodeUpdated,
} from "./contracts-phase2";
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

  // デコーダには要求した meetingId を束ねて渡す。応答の meetingId が要求と違えば、形が正しくても MALFORMED（§3）
  getMeeting(meetingId: string): Promise<ApiResult<MeetingDetailResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}`, (v) => decodeMeetingDetail(v, meetingId));
  }

  getTranscript(meetingId: string, version?: number): Promise<ApiResult<TranscriptResponse>> {
    const q = version === undefined ? "" : `?version=${version}`;
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/transcript${q}`, (v) => decodeTranscript(v, meetingId));
  }

  getSummary(meetingId: string, version?: number): Promise<ApiResult<SummaryResponse>> {
    const q = version === undefined ? "" : `?version=${version}`;
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/summary${q}`, (v) => decodeSummary(v, meetingId));
  }

  getJobs(meetingId: string): Promise<ApiResult<JobListResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/jobs`, (v) => decodeJobList(v, meetingId));
  }

  retryJob(jobId: string): Promise<ApiResult<{ jobId: string; status: string }>> {
    return this.request("POST", `/v1/jobs/${enc(jobId)}/retry`, decodeJobRetry);
  }

  excludeFailed(meetingId: string): Promise<ApiResult<{ excluded: number }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/jobs/exclude-failed`, decodeExcluded);
  }

  regenerateSummary(meetingId: string): Promise<ApiResult<{ jobId: string | null }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/summary/regenerate`, decodeJobId);
  }

  /** 確定前の会議・未配置のモデルは 422（サーバー側 §21.3）。 */
  rerunTranscript(meetingId: string, sttModel: string | null): Promise<ApiResult<{ jobsCreated: number }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/transcript/rerun`, decodeJobsCreated, { sttModel });
  }

  /** 対象は無音判定（skipped）の Chunk だけ。それ以外と merge 前の会議は 422（サーバー側 §21.3）。 */
  transcribeSilentChunk(meetingId: string, source: "mic" | "system", seq: number): Promise<ApiResult<{ jobId: string | null }>> {
    return this.request("POST", `/v1/meetings/${enc(meetingId)}/chunks/${source}/${seq}/transcribe`, decodeJobId);
  }

  getNotes(meetingId: string): Promise<ApiResult<NotesResponse>> {
    return this.request("GET", `/v1/meetings/${enc(meetingId)}/notes`, (v) => decodeNotes(v, meetingId));
  }

  /** If-Match に revision を載せる。不一致は status 409 の失敗として返る。 */
  putNotes(meetingId: string, blocknoteJson: unknown, revision: number, lastAppliedSummaryVersion: number | null): Promise<ApiResult<NotesResponse>> {
    return this.request("PUT", `/v1/meetings/${enc(meetingId)}/notes`, (v) => decodeNotes(v, meetingId),
      { blocknoteJson, lastAppliedSummaryVersion }, { "If-Match": String(revision) });
  }

  /** 取得（POST /v1/models/download）の進行と結果も `downloads` に入る。設定画面はこれを取り直して見る。 */
  getModels(): Promise<ApiResult<ModelsResponse>> {
    return this.request("GET", "/v1/models", decodeModels);
  }

  /** sttModel / llmModel の空文字は「指定を外して自動選定に戻す」。値の検査に通らなければ 422（サーバー側 §21.1）。 */
  putSettings(values: { language?: string; sttModel?: string; llmModel?: string }): Promise<ApiResult<{ updated: string[] }>> {
    return this.request("PUT", "/v1/settings", decodeUpdated, values);
  }

  /**
   * 成功応答は `json as T` で通さず、エンドポイントごとのデコーダ（必須引数）に通す。形が違えば MALFORMED。
   * エラー応答の本文は検証しない（code と error を文字列のときだけ使う）。
   */
  private async request<T>(method: string, path: string, decode: (value: unknown) => T | null, body?: unknown,
    extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
    const url = new URL(path, this.base);
    assertLocalHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}`, ...extraHeaders };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      // ブラウザの fetch はメソッドとして呼ぶと Illegal invocation になるため、取り出してから呼ぶ
      const fetchImpl = this.fetchImpl;
      const res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      });
      let json: unknown = null;
      if (res.status !== 204) {
        try {
          json = await res.json();
        } catch (error) {
          // エラー応答の本文は補足にすぎない。壊れていても読み取りが中断・通信断で失敗しても、本文なしとして status で返す
          // （401 / 503 などの status を TIMEOUT / NETWORK に変えると、呼び出し側の判断が変わる）
          if (res.ok) {
            // 成功応答の本文の読み取り中の中断（タイムアウト）・通信断は外の catch で TIMEOUT / NETWORK にする（成功扱いにしない）
            if (!(error instanceof SyntaxError)) throw error;
            // 壊れた本文。null を値として返さず MALFORMED
            return { ok: false, status: res.status, code: "MALFORMED", message: `malformed body for ${method} ${path}` };
          }
        }
      }
      if (res.ok) {
        const value = decode(json);
        if (value === null) return { ok: false, status: res.status, code: "MALFORMED", message: `malformed body for ${method} ${path}` };
        return { ok: true, value, status: res.status };
      }
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

基本設計 §19。debounce 1〜2 秒で `PUT /notes`、同時に IndexedDB `settings` ストアへ一時保存し、サーバー未起動時の編集を失わない。`409` は上書きせず差分 UI に委ねる。IndexedDB への書き込み（編集の下書き・保存後の控え）は発行順に 1 本ずつ流す。`DraftStore` は完了順を保証しないので、並行に書くと、後から終わった保存後の控え（古い内容）がその間の編集の下書きを上書きし、作り直したインスタンスの `load()` が編集を黙って失う。

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
  /**
   * 下書き・保存後の控え（IndexedDB）の書き込みの失敗。状態は変えない（保存後の控えならサーバーには保存済み。
   * 編集の下書きなら、メモリ上の編集はこのインスタンスの debounce の保存でサーバーへ送る）。
   * 保存の前に dispose() すると debounce の保存は止まるので、書けなかった下書きは dispose() の戻り値で
   * 新しいインスタンスの load() へ渡す（§15.1 W8）
   */
  readonly onError?: (error: Error) => void;
}

export interface Draft {
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
  /**
   * 下書き・控えの書き込みを発行順に 1 本ずつ流す鎖。DraftStore は書き込みの完了順を保証しないので、
   * 保存後の控え（古い json）が後から終わって、その間に入った編集の下書きを上書きしないようにする。
   * 失敗は writeDraft の中で onError に渡すので、この鎖は reject しない
   */
  private draftWrites: Promise<void> = Promise.resolve();
  /** 鎖に残っている書き込みの数。0 のときは同期的に書き始める */
  private pendingDraftWrites = 0;
  /**
   * 最後に流した書き込みが失敗していれば、その下書き・控え（IndexedDB に入るはずだった内容）。成功すれば null に戻す。
   * 書き込みは発行順に流し、最後の書き込みは常にメモリ上の最新の状態を書くので、鎖が空になった時点で
   * 「IndexedDB に無い最新の内容」を表す。dispose() が返し、作り直したインスタンスの load() が引き継ぐ。
   * load(carry) で引き継いだ内容も、このインスタンスの書き込みが成功するまでここに持つ（その前にもう一度作り直されても失わない）
   */
  private unwrittenDraft: Draft | null = null;
  private disposed = false;
  /** dispose() の開始後に入った編集がある。鎖に書き込みを足さず、dispose() の戻り値で引き継ぐ */
  private editedWhileDisposing = false;
  /** dispose() が戻り値を返した。以後の編集は誰にも引き継がれないので、受け付けずに onError へ知らせる */
  private handedOff = false;

  constructor(private readonly deps: NotesStoreDeps, meetingId: string) {
    this.state = { meetingId, json: null, revision: 0, lastAppliedSummaryVersion: null, sync: "idle", serverNotes: null };
  }

  get current(): NotesState {
    return this.state;
  }

  private draftKey(): string {
    return `notes:${this.state.meetingId}`;
  }

  /**
   * 起動時：IndexedDB の下書きとサーバーの両方を見て、新しい方を採用する。
   * carry は作り直す前のインスタンスの dispose() の戻り値。IndexedDB に書けなかった最新の内容なので、IndexedDB の下書きより優先する
   */
  async load(carry: Draft | null = null): Promise<void> {
    // 引き継いだ内容は IndexedDB に無い。下書き・控えの書き込みが成功するまで持ち、その前の dispose() が返せるようにする。
    // 最初の await より前に入れる（load の途中で dispose() されても返す）。carry が null なら触らない。
    // 同じく最初の await より前に IndexedDB へ書き始める。書かないと、編集もサーバーへの保存もないまま閉じたとき
    // 引き継いだ内容がどこにも残らない。成功すれば writeDraft が unwrittenDraft を null に戻し、失敗すれば carry のまま onError に渡す
    if (carry !== null) {
      this.unwrittenDraft = carry;
      void this.writeDraft(carry);
    }
    const draftRaw = carry ?? await this.deps.drafts.get(this.draftKey());
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
    // 呼んだ時点の内容に固定する。エディタが同じオブジェクトを後から書き換えても、並んだ書き込みと doSave の snapshot は変わらない。
    // 呼び出しごとに別のオブジェクトになるので、doSave の stillSame（参照の比較）も編集の有無を見分けられる
    const content = structuredClone(json);
    if (this.handedOff) {
      this.reportError(new Error("NotesStore is disposed; the edit was not saved"));
      return;
    }
    this.set({ json: content, lastAppliedSummaryVersion, sync: this.state.sync === "conflict" ? "conflict" : "dirty" });
    if (this.disposed) {
      // dispose() が鎖の末尾を待ち始めた後に書き込みを足すと、待たれないまま新しいインスタンスの load() と競合する。
      // 書かずに、dispose() が最新の状態を戻り値で引き継ぐ
      this.editedWhileDisposing = true;
      return;
    }
    void this.writeDraft({ json: content, revision: this.state.revision, lastAppliedSummaryVersion, savedAt: Date.now(), saved: false });
    if (this.state.sync !== "conflict") this.schedule();
  }

  /** 差分 UI で「サーバー版を採用」を選んだとき。 */
  acceptServer(): void {
    const s = this.state.serverNotes;
    if (s === null) return;
    // dispose() が戻り値を返した後は、控えを書くと新しいインスタンスの下書きを後から上書きする。setDraft と同じく受け付けない。
    // dispose() の待機中（handedOff の前）は受け付ける。dispose() は鎖が空になるまで待つので、この書き込みも待たれる
    if (this.handedOff) {
      this.reportError(new Error("NotesStore is disposed; the server version was not accepted"));
      return;
    }
    this.set({ json: s.blocknoteJson, revision: s.revision, lastAppliedSummaryVersion: s.lastAppliedSummaryVersion, sync: "saved", serverNotes: null });
    void this.writeDraft({ json: s.blocknoteJson, revision: s.revision, lastAppliedSummaryVersion: s.lastAppliedSummaryVersion, savedAt: Date.now(), saved: true });
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

  /**
   * setToken で作り直す前に呼ぶ。保留中の debounce を止め、古いトークンの PUT が新しいインスタンスと競合しないようにする。
   * 未送信の編集は IndexedDB の下書き（saved: false）に残っており、新しいインスタンスの load() が dirty として拾い直す。
   * 下書きの書き込みが失敗していれば IndexedDB には無いので、書けなかった最新の内容を返す（書けていれば null）。
   * load(carry) で引き継いだ内容を、まだ一度も書けていなければ、それも返す。
   * 呼んだ後の setDraft は書き込みを鎖に足さず、返すまでに入った編集は最新の状態として戻り値で引き継ぐ。返した後の setDraft は受け付けない。
   * 呼び出し側は戻り値を新しいインスタンスの load(carry) に渡す。渡さないと、debounce の保存は止めたので最新の編集を失う。
   * 送信中の PUT と、発行済みの下書き・控えの書き込みの完了を待って返る。新しいインスタンスの load() はこの完了を待ってから呼ぶ。
   * 待たずに load() すると、古い PUT が確定する前の revision と下書きを読み、確定後に送った編集が 409 で競合になる。
   */
  async dispose(): Promise<Draft | null> {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    // doSave は失敗を Result で扱い reject しない。控え（新しい revision）の書き込みの完了まで待つ
    if (this.inflight !== null) await this.inflight;
    // 編集の下書きの書き込みは doSave の控えの後ろに並ぶことがあるので、鎖が空になるまで待つ（reject しない）。
    // 待っている間に足された書き込み（acceptServer など）も待つ。1 回の await だと、その時点の末尾までしか待たない
    while (this.pendingDraftWrites > 0) await this.draftWrites;
    const carry: Draft | null = this.editedWhileDisposing
      ? { json: this.state.json, revision: this.state.revision, lastAppliedSummaryVersion: this.state.lastAppliedSummaryVersion, savedAt: Date.now(), saved: false }
      : this.unwrittenDraft;
    this.handedOff = true;
    return carry;
  }

  /**
   * 下書き・控えを書く。内容は呼んだ時点で確定させ、書き込みは発行順に 1 本ずつ流す。
   * 前の書き込みがなければ、この呼び出しの中で書き始める（IndexedDB のトランザクションを直後の load() より先に作る。
   * then で 1 回遅らせると、待たずに作り直したインスタンスの load() が書き込み前の下書きを読む）
   */
  private writeDraft(draft: Draft): Promise<void> {
    const key = this.draftKey();
    const run = async (): Promise<void> => {
      try {
        await this.deps.drafts.set(key, draft);
        this.unwrittenDraft = null;
      } catch (error) {
        // dispose() が返して新しいインスタンスへ引き継ぐ。後ろの書き込みが成功すれば null に戻る
        this.unwrittenDraft = draft;
        this.reportError(error);
      }
    };
    const next = this.pendingDraftWrites === 0 ? run() : this.draftWrites.then(run);
    this.pendingDraftWrites++;
    this.draftWrites = next.finally(() => {
      this.pendingDraftWrites--;
    });
    return next;
  }

  private reportError(error: unknown): void {
    try {
      this.deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch (callbackError) {
      // onError が投げても鎖を止めない（後ろの書き込みと dispose が進まなくなる）
      console.error("NotesStore onError threw", callbackError);
    }
  }

  private schedule(): void {
    // 送信中の保存が dispose の後に終わり、保存中の編集を送り直そうとしても予約しない（新しいインスタンスが下書きから送る）
    if (this.disposed) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.save();
    }, this.deps.debounceMs);
  }

  private async save(): Promise<void> {
    if (this.inflight !== null) {
      await this.inflight;
      // doSave の stillSame 判定の後（保存後の控えの書き込み中）に入った編集は doSave が予約しない。
      // ここで予約し直さないと dirty のまま取り残される（dispose 後は schedule が予約しない）
      if (this.state.sync === "dirty") this.schedule();
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
      if (!stillSame) this.schedule();
      // stillSame が false なら保存中に編集が入っている＝控えの内容はまだ未送信。
      // 書き込みの完了を待ってから返す。dispose() はこの完了を待つので、作り直したインスタンスの load() が
      // 古い revision の控えを読んで競合にしない（§15.1 W8）。失敗は writeDraft が onError に渡す。サーバーには保存済みで、
      // 控えが古いまま残っても次の load() は差分 UI（conflict）になるだけで編集は失われない
      await this.writeDraft({ json: this.state.json, revision: res.value.revision, lastAppliedSummaryVersion: this.state.lastAppliedSummaryVersion, savedAt: Date.now(), saved: stillSame });
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
  /** meetingId は一覧を取得した会議（JobListResponse.meetingId）。表示中の会議と違えば捨てる */
  | { readonly type: "jobs_loaded"; readonly meetingId: string; readonly jobs: ReadonlyArray<JobSummary> }
  | { readonly type: "backend"; readonly backend: LocalBackendHealth }
  | { readonly type: "event"; readonly event: MeetingEvent }
  | { readonly type: "toggle_rejected" };

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "meeting_loaded":
      // 別の会議を開いたら会議ごとの状態を捨てる（前の会議の transcript・jobs を表示しない。版の比較も持ち越さない）。
      // 表示設定（backend・showRejected・confidenceDimBelow）は残す。同じ会議の読み直しは会議ごとの状態を保つ
      if (state.meeting !== null && state.meeting.meetingId !== action.meeting.meetingId) {
        return {
          ...INITIAL_UI_STATE,
          backend: state.backend, showRejected: state.showRejected, confidenceDimBelow: state.confidenceDimBelow,
          meeting: action.meeting, status: action.meeting.status,
        };
      }
      return { ...state, meeting: action.meeting, status: action.meeting.status };
    // 取得の応答は要求順に解決するとは限らない。後着した古い版で新しい版を巻き戻さない
    // （stale の印は新しい版の取得で消えているので、巻き戻ると取り直されずに古い表示が残る）。同じ版の再取得は受け入れる。
    // 版の比較は同じ会議の中だけで行い、表示中の会議と違う会議の応答（切り替え前の要求の後着）は捨てる
    case "transcript_loaded":
      if (state.meeting !== null && action.transcript.meetingId !== state.meeting.meetingId) return state;
      if (state.transcript !== null && state.transcript.meetingId === action.transcript.meetingId
          && action.transcript.transcriptVersion < state.transcript.transcriptVersion) return state;
      return {
        ...state,
        transcript: action.transcript,
        staleTranscriptVersion: state.staleTranscriptVersion !== null && state.staleTranscriptVersion <= action.transcript.transcriptVersion ? null : state.staleTranscriptVersion,
      };
    case "summary_loaded":
      if (state.meeting !== null && action.summary.meetingId !== state.meeting.meetingId) return state;
      if (state.summary !== null && state.summary.meetingId === action.summary.meetingId
          && action.summary.version < state.summary.version) return state;
      return {
        ...state,
        summary: action.summary,
        staleSummaryVersion: state.staleSummaryVersion !== null && state.staleSummaryVersion <= action.summary.version ? null : state.staleSummaryVersion,
      };
    case "jobs_loaded": {
      // transcript_loaded と同じく、会議の切り替え前に出した要求の後着は捨てる（前の会議の jobs を混ぜない）
      if (state.meeting !== null && action.meetingId !== state.meeting.meetingId) return state;
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
    // 版の印は大きい方を残す。補完（接続時点の版）が live の新しい版の後に届いても、印を古い版へ戻さない
    case "transcript_version":
      return state.transcript !== null && state.transcript.transcriptVersion >= event.transcriptVersion
        ? state
        : { ...state, staleTranscriptVersion: Math.max(state.staleTranscriptVersion ?? 0, event.transcriptVersion) };
    case "summary_version":
      return state.summary !== null && state.summary.version >= event.version
        ? state
        : { ...state, staleSummaryVersion: Math.max(state.staleSummaryVersion ?? 0, event.version) };
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
  if (b.status === "UNREACHABLE") return state.status === "recording"
    ? "サーバー未接続 ── 録音は継続中。処理はサーバー起動後に再開します。"
    : "サーバー未接続 ── 処理はサーバー起動後に再開します。";
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
  /** stop に渡された引数。省略時は空配列のまま記録する */
  readonly stopArgs: unknown[][] = [];
  constructor(readonly source: AudioSource, private readonly startPerf: number) {}
  async start(_m: string, _t: string, _c: number, options: { registerMeeting: boolean }): Promise<void> {
    this.registerMeeting = options.registerMeeting;
    this.sessionClock = { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: this.startPerf, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 };
    this.calls.push("start");
  }
  async stop(...args: unknown[]): Promise<void> {
    this.stopArgs.push(args);
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

  it("停止理由と検出時刻を Mic の Controller へそのまま渡し、System には渡さない", async () => {
    // Arrange
    const { rec, controllers } = build(true);
    await rec.start("m", "t", 1);
    // Act
    await rec.stop("mic_ended", 123456);
    // Assert
    expect(controllers[0].stopArgs).toEqual([["mic_ended", 123456]]);
    expect(controllers[1].stopArgs).toEqual([[]]);
  });

  it("Mic と System の停止が両方失敗したら、Mic の失敗を先頭にした AggregateError で両方を報告する", async () => {
    // Arrange
    const { rec, controllers } = build(true);
    await rec.start("m", "t", 1);
    const micError = new Error("mic stop failed");
    const systemError = new Error("system stop failed");
    controllers[0].stop = async () => { throw micError; };
    controllers[1].stop = async () => { throw systemError; };
    // Act
    const error = await rec.stop().catch((e: unknown) => e);
    // Assert
    if (!(error instanceof AggregateError)) throw new Error("AggregateError expected");
    expect(error.errors).toEqual([micError, systemError]);
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
      // 分類は detail の文字列でなく reason で行う（Phase 1 §22）。App はこれを見て時間をおいて再試行する
      expect(result.reason).toBe("network");
    }

    // finalizing 前の値へ戻っており、復帰後に再度 finalize を呼べる。endedAt は再試行で同じ値を送るため残す
    const after = await h.meetingStore.get(meetingId);
    expect(after?.status).toBe("stop_requested");
    expect(after?.endedAt).not.toBeNull();
    expect(after?.finalChunkCount).toBeNull();
  });
});
```

## 12.4 SSE クライアント

```typescript
// test/events.test.ts
import { describe, expect, it, vi } from "vitest";
import { BACKFILL_RETRY_DELAYS_MS, FetchEventSource, MeetingEventsClient, SSE_CONNECT_TIMEOUT_MS, SSE_IDLE_TIMEOUT_MS, SSE_STABLE_MS, normalizeEvent, type EventSourceLike } from "../src/api/events";
import type { JobListResponse, MeetingDetailResponse, MeetingEvent } from "../src/api/contracts-phase2";
import { Phase2Client } from "../src/api/phase2-client";

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

  it("初回接続と再接続のたびに会議状態と jobs を補完する", async () => {
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
    // 初回：確定から購読開始までに出たイベントは SSE に乗らないので、初回も補完する
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    expect(meetingCount).toBe(1);
    expect(jobsCount).toBe(1);
    received.length = 0;
    source.emit("job", JSON.stringify({ type: "job", job: serverJobRow }));
    source.emit("summary_version", JSON.stringify({ type: "summary_version", version: 1 }));
    expect(received.map((e) => e.type)).toEqual(["job", "summary_version"]);

    received.length = 0;
    source.emit("error");
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    expect(meetingCount).toBe(2);
    expect(jobsCount).toBe(2);
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

  it("補完中に届いた live イベントは補完の後に流し、古い補完の値で上書きしない", async () => {
    // Arrange: 補完の GET /meetings を止めておく
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    let resolveMeeting: (m: MeetingDetailResponse) => void = () => undefined;
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: () => new Promise((resolve) => (resolveMeeting = resolve)),
      onEvent: (e) => received.push(e),
      onError: (e) => {
        throw e;
      },
    }, "m");
    client.connect();
    const source = es as unknown as FakeEventSource;
    source.emit("open");
    // Act: 補完の応答より先に、新しい live の値が届く
    source.emit("meeting_status", JSON.stringify({ type: "meeting_status", status: "completed" }));
    source.emit("transcript_version", JSON.stringify({ type: "transcript_version", transcriptVersion: 4 }));
    expect(received).toEqual([]);
    resolveMeeting(meetingDetail);                       // 補完は接続時点の transcribing / 版 3
    await new Promise((r) => setTimeout(r, 0));
    // Assert: 補完の後に live を流すので、最後に残るのは live の値
    expect(received).toEqual([
      { type: "meeting_status", status: "transcribing" },
      { type: "transcript_version", transcriptVersion: 3 },
      { type: "summary_version", version: 2 },
      { type: "meeting_status", status: "completed" },
      { type: "transcript_version", transcriptVersion: 4 },
    ]);
    // 補完の後は保留しない
    source.emit("summary_version", JSON.stringify({ type: "summary_version", version: 3 }));
    expect(received.at(-1)).toEqual({ type: "summary_version", version: 3 });
  });

  it("補完中に再接続したら、古い接続の補完の結果は捨てる", async () => {
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    const pending: Array<(m: MeetingDetailResponse) => void> = [];
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: () => new Promise((resolve) => pending.push(resolve)),
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
    pending[1]({ ...meetingDetail, status: "completed", latestSummaryVersion: null });
    await new Promise((r) => setTimeout(r, 0));
    pending[0]({ ...meetingDetail, latestSummaryVersion: null });   // 古い接続の補完が遅れて返る
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([
      { type: "meeting_status", status: "completed" },
      { type: "transcript_version", transcriptVersion: 3 },
    ]);
  });

  it("前の接続の補完中に保留した live イベントは、再接続後の補完の前に流し、後には流さない", async () => {
    // Arrange
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    const pending: Array<(m: MeetingDetailResponse) => void> = [];
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: () => new Promise((resolve) => pending.push(resolve)),
      onEvent: (e) => received.push(e),
      onError: (e) => {
        throw e;
      },
    }, "m");
    client.connect();
    const source = es as unknown as FakeEventSource;
    source.emit("open");
    source.emit("meeting_status", JSON.stringify({ type: "meeting_status", status: "transcribing" }));   // 保留される
    // Act: 補完が返る前に切れて再接続し、再接続後の補完は completed
    source.emit("error");
    source.emit("open");
    pending[1]({ ...meetingDetail, status: "completed", latestSummaryVersion: null });
    await new Promise((r) => setTimeout(r, 0));
    // Assert: 保留分は再接続後の補完より前に流れ、最後に残るのは補完の値
    expect(received.filter((e) => e.type === "meeting_status")).toEqual([
      { type: "meeting_status", status: "transcribing" },
      { type: "meeting_status", status: "completed" },
    ]);
  });

  it("再接続後の補完も失敗しても、前の接続で保留した status と progress を失わない", async () => {
    // Arrange: 1 回目の補完は返らず、2 回目の補完は失敗する
    let es: FakeEventSource | null = null;
    const received: MeetingEvent[] = [];
    const errors: Error[] = [];
    const pending: Array<(m: MeetingDetailResponse) => void> = [];
    let calls = 0;
    const client = new MeetingEventsClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "tok",
      createEventSource: () => (es = new FakeEventSource()),
      fetchJobs: async () => emptyJobs,
      fetchMeeting: () => (++calls === 1 ? new Promise((resolve) => pending.push(resolve)) : Promise.reject(new Error("offline"))),
      onEvent: (e) => received.push(e),
      onError: (e) => errors.push(e),
    }, "m");
    client.connect();
    const source = es as unknown as FakeEventSource;
    source.emit("open");
    source.emit("meeting_status", JSON.stringify({ type: "meeting_status", status: "transcribing" }));
    source.emit("progress", JSON.stringify({ type: "progress", jobType: "transcribe_chunk", done: 10, total: 10 }));
    // Act
    source.emit("error");
    source.emit("open");
    await new Promise((r) => setTimeout(r, 0));
    // Assert: 補完に含まれない progress も、補完が失敗した status も届いている
    expect(received).toEqual([
      { type: "meeting_status", status: "transcribing" },
      { type: "progress", jobType: "transcribe_chunk", done: 10, total: 10 },
    ]);
    expect(errors.map((e) => e.message)).toEqual(["offline"]);
    client.close();
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
    client.close();
  });

  it("補完に失敗したら同じ接続のまま間隔を空けて取り直し、成功した状態を流す", async () => {
    vi.useFakeTimers();
    try {
      // Arrange: 1 回目の補完だけ失敗する
      let es: FakeEventSource | null = null;
      let calls = 0;
      const received: MeetingEvent[] = [];
      const errors: Error[] = [];
      const client = new MeetingEventsClient({
        baseUrl: "http://127.0.0.1:43117",
        token: "tok",
        createEventSource: () => (es = new FakeEventSource()),
        fetchJobs: async () => emptyJobs,
        fetchMeeting: async () => {
          if (++calls === 1) throw new Error("server down");
          return meetingDetail;
        },
        onEvent: (e) => received.push(e),
        onError: (e) => errors.push(e),
      }, "m");
      client.connect();
      (es as unknown as FakeEventSource).emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(errors.map((e) => e.message)).toEqual(["server down"]);
      expect(received).toEqual([]);
      // Act: 再接続（open）を待たずに取り直す
      await vi.advanceTimersByTimeAsync(BACKFILL_RETRY_DELAYS_MS[0]);
      // Assert
      expect(calls).toBe(2);
      expect(received).toContainEqual({ type: "meeting_status", status: "transcribing" });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("onError が例外を投げても、補完中に保留した live イベントを流し、補完の取り直しを予約する", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Arrange: 1 回目の補完は失敗し、onError も投げる
      let es: FakeEventSource | null = null;
      let calls = 0;
      let rejectFirst: (error: Error) => void = () => undefined;
      const received: MeetingEvent[] = [];
      const client = new MeetingEventsClient({
        baseUrl: "http://127.0.0.1:43117",
        token: "tok",
        createEventSource: () => (es = new FakeEventSource()),
        fetchJobs: async () => emptyJobs,
        fetchMeeting: () => {
          if (++calls === 1) return new Promise<MeetingDetailResponse>((_, reject) => { rejectFirst = reject; });
          return Promise.resolve(meetingDetail);
        },
        onEvent: (e) => received.push(e),
        onError: () => { throw new Error("callback bug"); },
      }, "m");
      client.connect();
      const source = es as unknown as FakeEventSource;
      source.emit("open");
      source.emit("meeting_status", JSON.stringify({ type: "meeting_status", status: "completed" }));
      // Act
      rejectFirst(new Error("server down"));
      await vi.advanceTimersByTimeAsync(0);
      // Assert: 保留分は流れ、onError の例外は記録され、取り直しが予約されている
      expect(received).toEqual([{ type: "meeting_status", status: "completed" }]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(BACKFILL_RETRY_DELAYS_MS[0]);
      expect(calls).toBe(2);
      expect(received).toContainEqual({ type: "meeting_status", status: "transcribing" });
      client.close();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("保留分を流す onEvent が例外を投げても、残りの保留分を流し、次の補完と取り直しの予約を続ける", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Arrange: 1 回目の補完は再接続まで返らず、2 回目は失敗する。onEvent は completed で投げる
      let es: FakeEventSource | null = null;
      let calls = 0;
      const received: MeetingEvent[] = [];
      const client = new MeetingEventsClient({
        baseUrl: "http://127.0.0.1:43117",
        token: "tok",
        createEventSource: () => (es = new FakeEventSource()),
        fetchJobs: async () => emptyJobs,
        fetchMeeting: () => {
          calls++;
          if (calls === 1) return new Promise<MeetingDetailResponse>(() => undefined);
          if (calls === 2) return Promise.reject(new Error("server down"));
          return Promise.resolve(meetingDetail);
        },
        onEvent: (e) => {
          if (e.type === "meeting_status" && e.status === "completed") throw new Error("callback bug");
          received.push(e);
        },
        onError: () => undefined,
      }, "m");
      client.connect();
      const source = es as unknown as FakeEventSource;
      source.emit("open");
      const failed = JSON.stringify({ type: "meeting_status", status: "completed" });
      const transcribing = JSON.stringify({ type: "meeting_status", status: "transcribing" });
      source.emit("meeting_status", failed);
      source.emit("meeting_status", transcribing);
      // Act 1: 1 回目の補完が終わらないうちに再接続する（前の接続の保留分を流す経路）
      source.emit("open");
      source.emit("meeting_status", failed);
      source.emit("meeting_status", transcribing);
      await vi.advanceTimersByTimeAsync(0);
      // Assert 1: 2 回目の補完が走り、どちらの保留分も投げた 1 件の後ろが流れている
      expect(calls).toBe(2);
      expect(received).toEqual([
        { type: "meeting_status", status: "transcribing" },
        { type: "meeting_status", status: "transcribing" },
      ]);
      expect(consoleError).toHaveBeenCalledTimes(2);
      // Act 2 / Assert 2: 補完の失敗後の取り直しも予約されている
      await vi.advanceTimersByTimeAsync(BACKFILL_RETRY_DELAYS_MS[0]);
      expect(calls).toBe(3);
      client.close();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("補完の取り直しは上限回数で止まり、close や再接続の後は古い接続の分を取り直さない", async () => {
    vi.useFakeTimers();
    try {
      // Arrange: 補完が常に失敗する
      let es: FakeEventSource | null = null;
      let calls = 0;
      const client = new MeetingEventsClient({
        baseUrl: "http://127.0.0.1:43117",
        token: "tok",
        createEventSource: () => (es = new FakeEventSource()),
        fetchJobs: async () => emptyJobs,
        fetchMeeting: async () => {
          calls++;
          throw new Error("server down");
        },
        onEvent: () => undefined,
        onError: () => undefined,
      }, "m");
      client.connect();
      const source = es as unknown as FakeEventSource;
      const total = BACKFILL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
      // Act 1: 上限まで取り直させる
      source.emit("open");
      await vi.advanceTimersByTimeAsync(total * 2);
      // Assert 1: 初回 + 取り直しの回数だけ
      expect(calls).toBe(1 + BACKFILL_RETRY_DELAYS_MS.length);
      // Act 2: 再接続の補完が失敗した直後に、もう一度再接続する（取り直しの予約は 1 つだけ残る）
      calls = 0;
      source.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      source.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(BACKFILL_RETRY_DELAYS_MS[0]);
      // Assert 2: 2 回の open と、最後の接続の取り直し 1 回だけ
      expect(calls).toBe(3);
      // Act 3: close の後は取り直さない
      client.close();
      await vi.advanceTimersByTimeAsync(total * 2);
      // Assert 3
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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

/**
 * 止まったままの SSE。headers が false なら応答ヘッダも返さない。true なら keep-alive を 1 つ送った後に止まる。
 * 実際の fetch と同じく、signal の abort で fetch も本文の読み取りも失敗する。
 */
function stalledFetch(calls: { count: number }, headers: boolean): typeof fetch {
  return (_input, init) => {
    calls.count++;
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      if (!headers) {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        return;
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      resolve(new Response(body, { status: 200 }));
    });
  };
}

describe("FetchEventSource の停止検知", () => {
  const url = new URL("http://127.0.0.1:43117/v1/meetings/m/events");

  it("応答ヘッダが期限内に届かなければ中断し、error を出して再接続する", async () => {
    vi.useFakeTimers();
    try {
      // Arrange
      const calls = { count: 0 };
      const es = new FetchEventSource(url, "tok", stalledFetch(calls, false));
      const seen: string[] = [];
      es.addEventListener("open", () => seen.push("open"));
      es.addEventListener("error", () => seen.push("error"));
      // Act / Assert
      await vi.advanceTimersByTimeAsync(SSE_CONNECT_TIMEOUT_MS - 1);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(["error"]);
      await vi.advanceTimersByTimeAsync(1_000);            // 初回のバックオフの後に再接続
      expect(calls.count).toBe(2);
      es.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("接続後に keep-alive も届かないまま許容時間を過ぎたら中断し、再接続する", async () => {
    vi.useFakeTimers();
    try {
      const calls = { count: 0 };
      const es = new FetchEventSource(url, "tok", stalledFetch(calls, true));
      const seen: string[] = [];
      es.addEventListener("open", () => seen.push("open"));
      es.addEventListener("error", () => seen.push("error"));
      await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS - 1);
      expect(seen).toEqual(["open"]);                      // 許容時間内は切らない
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(["open", "error"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.count).toBe(2);
      es.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("200 を返してすぐ切れる接続ではバックオフを戻さず、続いてデータを受けた接続の後で戻す", async () => {
    vi.useFakeTimers();
    try {
      // Arrange: 2 回はヘッダの直後に終わり、3 回目は keep-alive を送った後に止まる
      const calls = { count: 0 };
      const stalled = stalledFetch({ count: 0 }, true);
      const fetchImpl: typeof fetch = (input, init) => {
        calls.count++;
        if (calls.count <= 2) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), { status: 200 }));
        return stalled(input, init);
      };
      const es = new FetchEventSource(url, "tok", fetchImpl);
      // Act / Assert: 1 回目の後は 1 秒、2 回目の後は 2 秒待つ（200 だけでは初期値へ戻さない）
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.count).toBe(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls.count).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.count).toBe(3);
      // 3 回目は SSE_STABLE_MS を超えて続き、データも受けたので健全。無通信で切れた後は 1 秒で再接続する
      await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS);
      expect(calls.count).toBe(3);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.count).toBe(4);
      expect(SSE_STABLE_MS).toBeLessThan(SSE_IDLE_TIMEOUT_MS);
      es.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("error の listener が例外を投げても、残りの listener を呼び、再接続を続ける", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Arrange: 接続は毎回 503。1 つ目の error listener が投げる
      const calls = { count: 0 };
      const fetchImpl: typeof fetch = () => {
        calls.count++;
        return Promise.resolve(new Response(null, { status: 503 }));
      };
      const es = new FetchEventSource(url, "tok", fetchImpl);
      const seen: string[] = [];
      es.addEventListener("error", () => { throw new Error("listener bug"); });
      es.addEventListener("error", () => seen.push("error"));
      // Act
      await vi.advanceTimersByTimeAsync(0);
      // Assert: 2 つ目の listener も呼ばれ、例外は記録され、バックオフの後に再接続する
      expect(seen).toEqual(["error"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.count).toBe(2);
      expect(seen).toEqual(["error", "error"]);
      es.close();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("listener が例外を投げたら接続を中断してストリームを取り消し、再接続する", async () => {
    vi.useFakeTimers();
    try {
      // Arrange: 応答は 1 イベントを送った後も開いたまま。job の listener が投げる
      const signals: AbortSignal[] = [];
      let cancelled = 0;
      const fetchImpl: typeof fetch = (_input, init) => {
        if (init?.signal) signals.push(init.signal);
        const body = new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(new TextEncoder().encode("event: job\ndata: {}\n\n")),
          cancel: () => { cancelled++; },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      };
      const es = new FetchEventSource(url, "tok", fetchImpl);
      const seen: string[] = [];
      es.addEventListener("job", () => { throw new Error("listener bug"); });
      es.addEventListener("error", () => seen.push("error"));
      // Act
      await vi.advanceTimersByTimeAsync(0);
      // Assert: 開いたままの接続を残さない
      expect(seen).toEqual(["error"]);
      expect(cancelled).toBe(1);
      expect(signals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toHaveLength(2);
      es.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Phase2Client の本文の読み取り", () => {
  const config = { baseUrl: "http://127.0.0.1:43117", token: "t", timeoutMs: 50 };

  it("成功応答の本文が壊れていたら成功扱いにせず MALFORMED、エラー応答の壊れた本文は status で返す", async () => {
    // Arrange
    const reply = (status: number) => new Phase2Client(config, async () => new Response("{broken", { status }));
    // Act
    const ok = await reply(200).getModels();
    const ng = await reply(500).getModels();
    // Assert
    expect(ok).toEqual({ ok: false, status: 200, code: "MALFORMED", message: "malformed body for GET /v1/models" });
    expect(ng).toEqual({ ok: false, status: 500, code: "UNKNOWN", message: "HTTP 500" });
  });

  it("本文の読み取り中に期限を過ぎたら TIMEOUT、読み取り中の通信断は NETWORK", async () => {
    // Arrange: ヘッダの後で本文が止まる（abort で読み取りが失敗する）応答と、本文の途中で切れる応答
    const stalled: typeof fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 200 });
    const broken: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
        c.error(new TypeError("network error"));
      },
    }), { status: 200 });
    const brokenError: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
        c.error(new TypeError("network error"));
      },
    }), { status: 503 });
    // Act
    const timeout = await new Phase2Client(config, stalled).getModels();
    const network = await new Phase2Client(config, broken).getModels();
    const errorStatus = await new Phase2Client(config, brokenError).getModels();
    // Assert: エラー応答は本文を読めなくても status を保って返す
    expect(timeout).toMatchObject({ ok: false, status: 0, code: "TIMEOUT" });
    expect(network).toMatchObject({ ok: false, status: 0, code: "NETWORK" });
    expect(errorStatus).toEqual({ ok: false, status: 503, code: "UNKNOWN", message: "HTTP 503" });
  });
});
```

### 12.4.1 型付き fetch の応答の検証

`fixtures` は、サーバー側設計書（§21）のコードを展開して起動し、各エンドポイントから実際に取得した応答である（2026-11-13。値は短くしてある）。サーバー側の応答の形を変えたら、ここも取り直す。

```typescript
// test/phase2-client.test.ts
import { describe, expect, it } from "vitest";
import { Phase2Client } from "../src/api/phase2-client";

const config = { baseUrl: "http://127.0.0.1:43117", token: "t", timeoutMs: 1000 };
const reply = (body: unknown, status = 200) => new Phase2Client(config, async () => new Response(JSON.stringify(body), { status }));

const fixtures = {
  meeting: {
    meetingId: "m-1", title: "t", status: "completed", chunkCounts: { mic: 1, system: 0 },
    sttStatusCounts: { pending: 0, queued: 0, processing: 0, completed: 1, skipped: 0, failed: 0 },
    transcriptVersion: 1, latestSummaryVersion: 1, sttModelUsed: "small", llmModelUsed: "fake-llm", syncDriftMs: null,
  },
  transcript: {
    meetingId: "m-1", transcriptVersion: 1,
    segments: [{ id: "13488271-c19b", source: "mic", startMs: 0, endMs: 5000, text: "small-seg0", confidence: 0.7778, language: "ja", chunkSequenceNo: 0, speakerId: null }],
    gaps: [],
  },
  summary: {
    meetingId: "m-1", version: 1,
    summary: {
      summary: "テスト会議の要約",
      topics: [{ title: "話題A", description: "説明", sourceSegmentIds: ["13488271-c19b"] }],
      decisions: [{ text: "small-seg0", sourceSegmentIds: ["13488271-c19b"], quote: "small-seg0", evidenceSpan: { segmentId: "13488271", start: 0, end: 10 } }],
      actionItems: [{ task: "small-seg0", assignee: null, deadline: null, sourceSegmentIds: ["13488271-c19b"], quote: "small-seg0", evidenceSpan: { segmentId: "13488271", start: 0, end: 10 } }],
      rejected: [], modelName: "fake-llm", promptVersion: "v1", transcriptVersion: 1, generatedAt: 1794500378275,
      modelCaveats: ["各項目の根拠（sourceSegmentIds）を必ず確認してください。"],
    },
    validation: { schemaValid: true, schemaRetries: 0, mapWindows: 1, totalItems: 3, rejectedItems: 0, unresolvedSegmentIds: [] },
  },
  jobs: {
    meetingId: "m-1",
    jobs: [{ jobId: "5914360f", jobType: "vad_chunk", status: "completed", chunkId: "3c999eb0", attempts: 1, errorClass: null, lastError: null, modelName: null, durationMs: 6, updatedAt: 1794500378262 }],
    counts: { pending: 0, leased: 0, processing: 0, retrying: 0, completed: 4, failed: 0, cancelled: 0 },
  },
  notes: { meetingId: "m-1", blocknoteJson: [{ type: "paragraph" }], revision: 1, lastAppliedSummaryVersion: null },
  models: {
    stt: [{ name: "tiny", installed: false, selected: false, recommended: false }],
    llm: [{ name: "fake-llm", selected: true, recommended: true }],
    ollamaReachable: true,
    downloads: [{ name: "base", status: "failed", error: "download url not allowed: https://evil.example" }],
  },
};

describe("Phase2Client の応答の検証", () => {
  it("サーバーの実応答は、どのエンドポイントも検証を通る", async () => {
    // Act
    const results = [
      await reply(fixtures.meeting).getMeeting("m-1"),
      await reply(fixtures.transcript).getTranscript("m-1"),
      await reply(fixtures.summary).getSummary("m-1"),
      await reply(fixtures.jobs).getJobs("m-1"),
      await reply(fixtures.notes).getNotes("m-1"),
      await reply(fixtures.notes).putNotes("m-1", [], 0, null),
      await reply(fixtures.models).getModels(),
      await reply({ jobId: "j", status: "pending" }).retryJob("j"),
      await reply({ meetingId: "m-1", excluded: 0 }).excludeFailed("m-1"),
      await reply({ jobId: "8eddc5bf" }).regenerateSummary("m-1"),
      await reply({ jobsCreated: 1 }).rerunTranscript("m-1", null),
      await reply({ jobId: "j" }).transcribeSilentChunk("m-1", "mic", 0),
      await reply({ updated: ["language"] }).putSettings({ language: "ja" }),
    ];
    // Assert
    expect(results.map((r) => r.ok)).toEqual(results.map(() => true));
    expect(results[0]).toEqual({ ok: true, status: 200, value: fixtures.meeting });
  });

  it("形の違う成功応答は値として返さず MALFORMED にする", async () => {
    // Arrange: それぞれ、後段（reducer・描画）が .map / .filter / Map のキーに使うフィールドが壊れた応答
    const cases: ReadonlyArray<[string, () => Promise<{ ok: boolean }>]> = [
      ["会議の status が未知", () => reply({ ...fixtures.meeting, status: "weird" }).getMeeting("m-1")],
      ["segments が配列でない", () => reply({ ...fixtures.transcript, segments: null }).getTranscript("m-1")],
      ["segment の startMs が文字列", () => reply({ ...fixtures.transcript, segments: [{ ...fixtures.transcript.segments[0], startMs: "0" }] }).getTranscript("m-1")],
      ["summary の本体が欠落", () => reply({ meetingId: "m-1", version: 1, validation: fixtures.summary.validation }).getSummary("m-1")],
      ["summary.rejected が配列でない", () => reply({ ...fixtures.summary, summary: { ...fixtures.summary.summary, rejected: {} } }).getSummary("m-1")],
      ["job の status が未知", () => reply({ ...fixtures.jobs, jobs: [{ ...fixtures.jobs.jobs[0], status: "weird" }] }).getJobs("m-1")],
      ["notes の revision が文字列", () => reply({ ...fixtures.notes, revision: "1" }).getNotes("m-1")],
      ["models.stt が配列でない", () => reply({ ...fixtures.models, stt: {} }).getModels()],
      ["jobsCreated が欠落", () => reply({}).rerunTranscript("m-1", null)],
      ["本文が null", () => reply(null).getMeeting("m-1")],
    ];
    for (const [name, call] of cases) {
      // Act
      const result = await call();
      // Assert
      expect(result, name).toMatchObject({ ok: false, status: 200, code: "MALFORMED" });
    }
  });

  it("要求した会議と違う meetingId の応答は MALFORMED にする", async () => {
    // Arrange: 会議の切り替え中に遅れて届いた前の会議の応答・取り違えた応答
    const other = { meetingId: "m-2" };
    // Act
    const results = [
      await reply({ ...fixtures.meeting, ...other }).getMeeting("m-1"),
      await reply({ ...fixtures.transcript, ...other }).getTranscript("m-1"),
      await reply({ ...fixtures.summary, ...other }).getSummary("m-1"),
      await reply({ ...fixtures.jobs, ...other }).getJobs("m-1"),
      await reply({ ...fixtures.notes, ...other }).getNotes("m-1"),
    ];
    // Assert
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  it("エラー応答は本文の形を検証せず、code と status で返す", async () => {
    // Act
    const result = await reply({ error: "revision mismatch", code: "CONFLICT_HASH_MISMATCH" }, 409).putNotes("m-1", [], 3, null);
    // Assert
    expect(result).toEqual({ ok: false, status: 409, code: "CONFLICT_HASH_MISMATCH", message: "revision mismatch" });
  });

  it("downloads のない古い応答でも models は通る", async () => {
    // Arrange
    const { downloads: _unused, ...legacy } = fixtures.models;
    // Act
    const result = await reply(legacy).getModels();
    // Assert
    expect(result.ok && result.value.downloads).toEqual([]);
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
  return { deps, store: new NotesStore(deps, "m"), drafts, timers, states, puts, fire, setOffline: (v: boolean) => (offline = v), bumpServer: () => { revision++; serverJson = ["other-tab"]; } };
}

describe("NotesStore", () => {
  it("dispose で保留中の保存を止め、作り直したインスタンスが load で未送信の編集を引き継いで 1 回だけ送る", async () => {
    // Arrange: 編集して debounce 待ちのまま、トークン変更で作り直す（§15.1 W8）
    const b = build();
    await b.store.load();
    b.store.setDraft(["edited"]);
    expect(b.timers).toHaveLength(1);
    // Act
    b.store.dispose();
    const next = new NotesStore(b.deps, "m");
    await next.load();
    while (b.timers.length > 0) await b.fire();
    // Assert: 古いインスタンスは送らず（送ると同じ revision の PUT が 2 回になり、後の方が 409）、新しいインスタンスが下書きから送る
    expect(b.puts).toEqual([{ json: ["edited"], revision: 0 }]);
    expect(next.current.sync).toBe("saved");
  });

  it("送信中に dispose したら送信の完了を待ってから作り直し、保存中の編集を競合にせず 1 回だけ送る", async () => {
    // Arrange: 古いインスタンスの PUT を応答前で止め、その間に編集する
    const b = build();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const deps: NotesStoreDeps = { ...b.deps, putNotes: async (...args) => { await gate; return b.deps.putNotes(...args); } };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    b.timers.shift()?.fn();
    store.setDraft(["ab"]);
    // Act: 作り直す。古い PUT は新しいインスタンスの load の前に確定する
    const disposed = store.dispose();
    release();
    await disposed;
    const next = new NotesStore(deps, "m");
    await next.load();
    while (b.timers.length > 0) await b.fire();
    // Assert: 古い PUT で進んだ revision から編集を送り、競合にしない
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }, { json: ["ab"], revision: 1 }]);
    expect(next.current.sync).toBe("saved");
  });

  it("dispose は保存後の控え（新しい revision）の書き込みの完了まで待ち、作り直したインスタンスは競合にしない", async () => {
    // Arrange: 控えの書き込みを止めておく（実際の IndexedDB は PUT の応答より遅れて完了しうる）
    const b = build();
    let releaseDrafts: () => void = () => undefined;
    const draftGate = new Promise<void>((r) => (releaseDrafts = r));
    const deps: NotesStoreDeps = { ...b.deps, drafts: { get: b.deps.drafts.get, set: async (k, v) => { await draftGate; await b.deps.drafts.set(k, v); } } };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    await b.fire();                                      // PUT は成功し、控えの書き込みが止まっている
    // Act
    let disposed = false;
    const disposing = store.dispose().then(() => (disposed = true));
    await new Promise((r) => setTimeout(r, 0));
    // Assert: 控えを書き終えるまで dispose は終わらない
    expect(disposed).toBe(false);
    releaseDrafts();
    await disposing;
    const next = new NotesStore(b.deps, "m");
    await next.load();
    expect(next.current.sync).toBe("saved");
    expect(b.puts).toHaveLength(1);
  });

  it("保存後の控えの書き込みに失敗したら onError に渡し、dispose は reject しない", async () => {
    // Arrange: 保存済みの控え（saved: true）の書き込みだけが失敗する
    const b = build();
    const errors: Error[] = [];
    const deps: NotesStoreDeps = {
      ...b.deps,
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { if ((v as { saved?: unknown }).saved === true) throw new Error("idb full"); await b.deps.drafts.set(k, v); } },
      onError: (e) => errors.push(e),
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    await b.fire();
    // Act
    await store.dispose();
    // Assert: サーバーには保存済みなので状態は saved のまま。失敗は呼び出し側へ知らせる
    expect(store.current.sync).toBe("saved");
    expect(errors.map((e) => e.message)).toEqual(["idb full"]);
  });

  it("編集の下書きの書き込みに失敗した後、保存前に作り直しても、dispose の戻り値を load に渡せば最新の編集を 1 回だけ送る", async () => {
    // Arrange: 1 回目の編集の下書きは書け、2 回目（最新）の編集の下書きだけが失敗する
    const b = build();
    const errors: Error[] = [];
    const deps: NotesStoreDeps = {
      ...b.deps,
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { if (JSON.stringify((v as { json?: unknown }).json) === JSON.stringify(["ab"])) throw new Error("idb full"); await b.deps.drafts.set(k, v); } },
      onError: (e) => errors.push(e),
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    store.setDraft(["ab"]);
    // Act: debounce の保存の前にトークン変更で作り直す（§15.1 W8）
    const carry = await store.dispose();
    const next = new NotesStore(b.deps, "m");
    await next.load(carry);
    while (b.timers.length > 0) await b.fire();
    // Assert: IndexedDB には古い ["a"] しかないが、引き継いだ最新の編集を送る。失敗は呼び出し側へ知らせる
    expect(carry?.json).toEqual(["ab"]);
    expect(b.puts).toEqual([{ json: ["ab"], revision: 0 }]);
    expect(next.current.sync).toBe("saved");
    expect(errors.map((e) => e.message)).toEqual(["idb full"]);
  });

  it("引き継いだ編集を一度も書かないうちにもう一度作り直しても、dispose が引き継いだ内容を返し、最新の編集を 1 回だけ送る", async () => {
    // Arrange: 最新の編集の下書きだけが書けず、作り直したインスタンスに carry で引き継ぐ
    const b = build();
    const deps: NotesStoreDeps = {
      ...b.deps,
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { if (JSON.stringify((v as { json?: unknown }).json) === JSON.stringify(["ab"])) throw new Error("idb full"); await b.deps.drafts.set(k, v); } },
      onError: () => undefined,
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    store.setDraft(["ab"]);
    const first = await store.dispose();
    // 引き継いだインスタンスも ["ab"] を書けない（load(carry) は最初の await より前に書き始めるので、書ければ IndexedDB に残る）
    const middle = new NotesStore(deps, "m");
    await middle.load(first);
    // Act: 引き継いだインスタンスが保存（と控えの書き込み）をする前に、もう一度作り直す（§15.1 W8）
    const second = await middle.dispose();
    const last = new NotesStore(b.deps, "m");
    await last.load(second);
    while (b.timers.length > 0) await b.fire();
    // Assert: IndexedDB には古い ["a"] しかないが、2 回目の dispose も引き継いだ内容を返し、最新の編集を 1 回だけ送る
    expect(second?.json).toEqual(["ab"]);
    expect(b.puts).toEqual([{ json: ["ab"], revision: 0 }]);
    expect(last.current.sync).toBe("saved");
  });

  it("dispose の待機中に入った編集は書き込みを足さず、dispose の戻り値で引き継いで 1 回だけ送る。返した後の編集は受け付けない", async () => {
    // Arrange: 保存を始め、応答を止めたまま作り直しを始める
    const b = build();
    let releasePut: () => void = () => undefined;
    const putGate = new Promise<void>((r) => (releasePut = r));
    const writes: unknown[] = [];
    const errors: Error[] = [];
    const deps: NotesStoreDeps = {
      ...b.deps,
      putNotes: async (...args) => { await putGate; return b.deps.putNotes(...args); },
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { writes.push((v as { json?: unknown }).json); await b.deps.drafts.set(k, v); } },
      onError: (e) => errors.push(e),
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    b.timers.shift()?.fn();
    const disposing = store.dispose();
    // Act: dispose が送信の完了を待っている間に編集し、送信を終わらせる
    store.setDraft(["ab"]);
    releasePut();
    const carry = await disposing;
    store.setDraft(["abc"]);
    const next = new NotesStore(b.deps, "m");
    await next.load(carry);
    while (b.timers.length > 0) await b.fire();
    // Assert: 待機中の編集は鎖に足さず（控えの書き込みは doSave の 1 回だけ）、最新の版で引き継いで送る
    expect(writes).toEqual([["a"], ["ab"]]);
    expect(carry).toMatchObject({ json: ["ab"], revision: 1, saved: false });
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }, { json: ["ab"], revision: 1 }]);
    expect(errors.map((e) => e.message)).toEqual(["NotesStore is disposed; the edit was not saved"]);
  });

  it("setDraft は呼んだ時点の内容を写し取り、後からエディタが同じオブジェクトを書き換えても下書きと送信は変わらない", async () => {
    // Arrange
    const b = build();
    await b.store.load();
    const doc: string[] = ["a"];
    // Act: 渡した配列を、保存の前にその場で書き換える
    b.store.setDraft(doc);
    doc.push("mutated");
    while (b.timers.length > 0) await b.fire();
    // Assert
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }]);
    expect((b.drafts.get("notes:m") as { json?: unknown }).json).toEqual(["a"]);
  });

  it("送信中に編集して dispose したら、送信の完了後も古いインスタンスは送り直しを予約しない", async () => {
    // Arrange: 保存を始め、応答前に編集する
    const b = build();
    await b.store.load();
    b.store.setDraft(["a"]);
    b.timers.shift()?.fn();
    b.store.setDraft(["ab"]);
    // Act
    b.store.dispose();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    // Assert: 保存中の編集（stillSame=false）でも予約しない
    expect(b.timers).toHaveLength(0);
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }]);
  });

  it("保存後の控えの書き込み中に入った編集は、送信中の保存の完了を待った後に予約し直して送る", async () => {
    // Arrange: PUT は成功（stillSame=true で予約しない）し、保存済みの控えの書き込みだけを止める
    const b = build();
    let releaseDrafts: () => void = () => undefined;
    const draftGate = new Promise<void>((r) => (releaseDrafts = r));
    const deps: NotesStoreDeps = {
      ...b.deps,
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { if ((v as { saved?: unknown }).saved === true) await draftGate; await b.deps.drafts.set(k, v); } },
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    await b.fire();
    store.setDraft(["ab"]);                              // 控えの書き込み中＝送信中の保存の完了前に編集する
    await b.fire();                                      // debounce が切れても送信中の保存を待つだけで返る
    // Act
    releaseDrafts();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    // Assert: 編集が dirty のまま取り残されず、送り直しが予約されて送られる
    expect(b.timers).toHaveLength(1);
    await b.fire();
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }, { json: ["ab"], revision: 1 }]);
    expect(store.current.sync).toBe("saved");
  });

  it("保存後の控えの書き込みが編集の下書きより遅く終わっても、古い控えで上書きしない（作り直したインスタンスが編集を拾う）", async () => {
    // Arrange: 保存済みの控えの書き込みだけを止め、その間に編集する（DraftStore は書き込みの順序を保証しない）
    const b = build();
    let releaseDrafts: () => void = () => undefined;
    const draftGate = new Promise<void>((r) => (releaseDrafts = r));
    const deps: NotesStoreDeps = {
      ...b.deps,
      drafts: { get: b.deps.drafts.get, set: async (k, v) => { if ((v as { saved?: unknown }).saved === true) await draftGate; await b.deps.drafts.set(k, v); } },
    };
    const store = new NotesStore(deps, "m");
    await store.load();
    store.setDraft(["a"]);
    await b.fire();
    store.setDraft(["ab"]);
    // Act: 控えの書き込みが終わった直後に作り直す（setToken、§15.1 W8）
    releaseDrafts();
    await store.dispose();
    const next = new NotesStore(b.deps, "m");
    await next.load();
    // Assert: 編集は未送信の下書きとして残り、送り直す
    expect(next.current.json).toEqual(["ab"]);
    expect(next.current.sync).toBe("dirty");
    while (b.timers.length > 0) await b.fire();
    expect(b.puts).toEqual([{ json: ["a"], revision: 0 }, { json: ["ab"], revision: 1 }]);
  });

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

  it("load(carry) は引き継いだ内容を最初の await より前に IndexedDB へ書き、書ければ dispose は null を返す", async () => {
    // Arrange: 前のインスタンスが IndexedDB に書けなかった最新の編集
    const b = build();
    const carry = { json: ["carried"], revision: 0, lastAppliedSummaryVersion: null, savedAt: 1, saved: false };
    const store = new NotesStore(b.deps, "m");
    // Act: load の完了を待たずに IndexedDB を見る
    const loading = store.load(carry);
    const writtenBeforeAwait = b.drafts.get("notes:m");
    await loading;
    const handed = await store.dispose();
    // Assert: 編集も保存もせずに閉じても、引き継いだ内容は IndexedDB に残る
    expect(writtenBeforeAwait).toMatchObject({ json: ["carried"], saved: false });
    expect(handed).toBeNull();
  });

  it("dispose が戻り値を返した後の acceptServer は控えを書かず、onError に知らせる", async () => {
    // Arrange: conflict の状態で作り直しを終える
    const errors: Error[] = [];
    const c = build({ serverRevision: 3 });
    await c.drafts.set("notes:m", { json: ["draft"], revision: 1, lastAppliedSummaryVersion: null, savedAt: 1 });
    const store = new NotesStore({ ...c.deps, onError: (e) => errors.push(e) }, "m");
    await store.load();
    await store.dispose();
    // Act
    store.acceptServer();
    await Promise.resolve();
    // Assert: 新しいインスタンスが読む下書きを古いインスタンスが上書きしない
    expect(c.drafts.get("notes:m")).toMatchObject({ json: ["draft"], revision: 1 });
    expect(store.current.sync).toBe("conflict");
    expect(errors.map((e) => e.message)).toEqual(["NotesStore is disposed; the server version was not accepted"]);
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
import type { JobSummary, MeetingDetailResponse, SummaryResponse, TranscriptResponse } from "../src/api/contracts-phase2";

const job = (id: string, status: JobSummary["status"], updatedAt = 1): JobSummary =>
  ({ jobId: id, jobType: "transcribe_chunk", status, chunkId: "c", attempts: 1, errorClass: status === "failed" ? "INVALID_AUDIO" : null, lastError: null, modelName: "small", durationMs: null, updatedAt });

describe("UI reducer", () => {
  it("job イベントは updatedAt が新しいものだけ採用する", () => {
    let s = reduce(INITIAL_UI_STATE, { type: "jobs_loaded", meetingId: "m", jobs: [job("j1", "processing", 5)] });
    s = reduce(s, { type: "event", event: { type: "job", job: job("j1", "completed", 3) } });
    expect(s.jobs.get("j1")?.status).toBe("processing");
    s = reduce(s, { type: "event", event: { type: "job", job: job("j1", "completed", 6) } });
    expect(s.jobs.get("j1")?.status).toBe("completed");
    expect(jobCounts(s).transcribe_chunk).toEqual({ done: 1, failed: 0, active: 0, total: 1 });
  });

  it("jobs_loaded も updatedAt が古い行では上書きしない", () => {
    // SSE の completed が先に届き、遅れて解決した一覧取得が古い processing を運んでくる状況
    let s = reduce(INITIAL_UI_STATE, { type: "event", event: { type: "job", job: job("j1", "completed", 9) } });
    s = reduce(s, { type: "jobs_loaded", meetingId: "m", jobs: [job("j1", "processing", 4), job("j2", "pending", 1)] });
    expect(s.jobs.get("j1")?.status).toBe("completed");
    expect(s.jobs.get("j2")?.status).toBe("pending");
    // 新しい行なら採用する
    s = reduce(s, { type: "jobs_loaded", meetingId: "m", jobs: [job("j1", "failed", 12)] });
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

  it("後着した古い版の transcript / summary で新しい版を巻き戻さない", () => {
    // Arrange: v3 を表示済み（stale の印は消えている）
    const tr = (v: number): TranscriptResponse => ({ meetingId: "m", transcriptVersion: v, segments: [], gaps: [] });
    const sum = (v: number): SummaryResponse => ({
      meetingId: "m", version: v,
      summary: { summary: `v${v}`, topics: [], decisions: [], actionItems: [], rejected: [], modelName: "llm", promptVersion: "v1", transcriptVersion: 1, generatedAt: 0, modelCaveats: [] },
      validation: { schemaValid: true, schemaRetries: 0, mapWindows: 1, totalItems: 0, rejectedItems: 0, unresolvedSegmentIds: [] },
    });
    let s = reduce(INITIAL_UI_STATE, { type: "transcript_loaded", transcript: tr(3) });
    s = reduce(s, { type: "summary_loaded", summary: sum(3) });
    // Act: 先に投げた v2 の応答が後から届く
    s = reduce(s, { type: "transcript_loaded", transcript: tr(2) });
    s = reduce(s, { type: "summary_loaded", summary: sum(2) });
    // Assert
    expect(s.transcript?.transcriptVersion).toBe(3);
    expect(s.summary?.version).toBe(3);
    // 同じ版・新しい版は受け入れる
    s = reduce(s, { type: "transcript_loaded", transcript: tr(4) });
    expect(s.transcript?.transcriptVersion).toBe(4);
  });

  it("別の会議を開いたら会議ごとの状態を捨て、前の会議の後着した応答は採らない", () => {
    // Arrange: 会議 A の v3 を表示中
    const meetingOf = (id: string): MeetingDetailResponse => ({
      meetingId: id, title: "t", status: "transcribed", chunkCounts: { mic: 1, system: 0 },
      sttStatusCounts: { pending: 0, queued: 0, processing: 0, completed: 1, skipped: 0, failed: 0 },
      transcriptVersion: 1, latestSummaryVersion: null, sttModelUsed: null, llmModelUsed: null, syncDriftMs: null,
    });
    const trOf = (id: string, v: number): TranscriptResponse => ({ meetingId: id, transcriptVersion: v, segments: [], gaps: [] });
    let s = reduce(INITIAL_UI_STATE, { type: "meeting_loaded", meeting: meetingOf("a") });
    s = reduce(s, { type: "transcript_loaded", transcript: trOf("a", 3) });
    s = reduce(s, { type: "jobs_loaded", meetingId: "a", jobs: [job("j1", "completed")] });
    s = reduce(s, { type: "event", event: { type: "summary_version", version: 2 } });
    s = reduce(s, { type: "toggle_rejected" });
    // 同じ会議の読み直しは会議ごとの状態を保つ
    s = reduce(s, { type: "meeting_loaded", meeting: meetingOf("a") });
    expect(s.transcript?.transcriptVersion).toBe(3);
    // Act: 会議 B を開く
    s = reduce(s, { type: "meeting_loaded", meeting: meetingOf("b") });
    // Assert: A の状態は消え、表示設定は残る
    expect(s.transcript).toBeNull();
    expect(s.jobs.size).toBe(0);
    expect(s.staleSummaryVersion).toBeNull();
    expect(s.showRejected).toBe(true);
    // B の v1 は A の v3 と比べずに採る。A の応答が後から届いても採らない
    s = reduce(s, { type: "transcript_loaded", transcript: trOf("b", 1) });
    expect(s.transcript).toEqual(trOf("b", 1));
    s = reduce(s, { type: "transcript_loaded", transcript: trOf("a", 4) });
    expect(s.transcript).toEqual(trOf("b", 1));
    // jobs も同じ。切り替え前に出した A の一覧取得の後着は混ぜず、B の一覧は採る
    s = reduce(s, { type: "jobs_loaded", meetingId: "a", jobs: [job("j1", "completed")] });
    expect(s.jobs.size).toBe(0);
    s = reduce(s, { type: "jobs_loaded", meetingId: "b", jobs: [job("j2", "pending")] });
    expect([...s.jobs.keys()]).toEqual(["j2"]);
  });

  it("未取得のまま古い版の通知が後から届いても、stale の印を戻さない", () => {
    let s = reduce(INITIAL_UI_STATE, { type: "event", event: { type: "transcript_version", transcriptVersion: 4 } });
    s = reduce(s, { type: "event", event: { type: "transcript_version", transcriptVersion: 3 } });
    expect(s.staleTranscriptVersion).toBe(4);
    s = reduce(s, { type: "event", event: { type: "summary_version", version: 2 } });
    s = reduce(s, { type: "event", event: { type: "summary_version", version: 1 } });
    expect(s.staleSummaryVersion).toBe(2);
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
    let s = reduce(INITIAL_UI_STATE, { type: "jobs_loaded", meetingId: "m", jobs: [job("j1", "failed"), job("j2", "completed")] });
    expect(failedJobs(s).map((j) => j.jobId)).toEqual(["j1"]);
    expect(backendBanner(s)).toBeNull();
    s = reduce(s, { type: "backend", backend: { status: "UNREACHABLE", lastCheckedAt: 0, lastHealthyAt: null, latencyMs: null, consecutiveFailures: 3, capabilities: null, unauthorized: false } });
    expect(backendBanner(s)).not.toMatch(/録音は継続中/);
    expect(backendBanner({ ...s, status: "recording" })).toMatch(/録音は継続中/);
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
| SSE 購読前・切断中の取りこぼし補完、補完中の live の保留、止まった接続の再接続 | `events.test.ts` |
| Manual Notes 保護・楽観ロック・オフライン下書き | `notes-store.test.ts` |
| Hallucination 除外項目の表示 | `ui-state.test.ts` |
| サーバー応答の検証（形の違う応答・別の会議の応答を値として返さない） | `phase2-client.test.ts` |
| 外部通信ゼロ（allowlist） | `events.test.ts`（外部ホスト拒否）。`Phase2Client` と `finalizer` は `assertLocalHost` を通る |
| Phase 1 の回帰 | Phase 1 §24 の 11 テストを同じツリーで実行 |

---

# 13. Invariant 1〜10 の担保箇所（ブラウザ側）

| Invariant | ブラウザ側での担保 |
| --- | --- |
| 1 Live STT failure ≠ Recording failure | Phase 3。Phase 2 のブラウザ側は STT 結果を表示するだけで、録音経路（§4・§6）は SSE / fetch の失敗を参照しない |
| 2 AI failure ≠ Transcript loss | §11 `summary_loaded` は `transcript` を触らない。`staleSummaryVersion` は通知のみ |
| 3 STT failure ≠ Recording loss | §11 `TranscriptResponse.gaps` を失敗区間として表示するだけ。IndexedDB の Chunk は Phase 1 §26 の保持期間まで残る |
| 4 Queue failure ≠ Job metadata loss | §8 接続・再接続時の補完は `GET /meetings/{id}`（status と各版）と `GET /jobs`（SQLite）から復元。ブラウザは進捗を SSE だけに依存しない |
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
| SSE で進捗を反映し、接続・再接続のたびに欠落を補完 | 設計済・テスト済 | §8（`fetchMeeting` で status と各版、`fetchJobs` で job）、§11 |
| transcript の薄字表示・失敗区間の表示・根拠リンク | 設計済（状態）・手動（描画） | §11 `dimmedSegmentIds`、`TranscriptResponse.gaps`、`sourceSegmentIds` |
| `rejected` の折りたたみ表示とモデル注記 | 設計済・テスト済 | §11 `visibleRejected`、`MeetingSummary.modelCaveats` |
| AI 再生成が手動ノートを上書きしない | 設計済・テスト済（サーバー側 §23.5）・本書 §10（クライアントは AI 出力をノートに書かない） | Invariant 6 |
| サーバー未起動時のノート編集を失わない | 設計済・テスト済 | §10、§12.5 |
| 外部ホストへの通信ゼロ | 設計済・テスト済（allowlist）・手動（DevTools） | Phase 1 §4.4 の CSP、`assertLocalHost` |
| Phase 1 テストの回帰 | テスト済 | §12 |

---

*本書のコードは Node 上の vitest で検証済みだが、`getDisplayMedia` の実際の可否、`FetchEventSource` の長時間接続とバックオフ再接続の挙動、2 系統同時録音時の AudioWorklet 負荷は対象ブラウザの実機でのみ確認できる。基本設計 §26.4 の実機項目を通過したものだけを Phase 2 ブラウザ側の完了とする。*

---

# 15. アプリへの組み込み（配線）と未決事項

§2〜§11 は単体でテストできる部品である。Phase 1 のアプリ（`src/app/app.ts` の `createApp` / `RecordingSession`、`src/main.ts` の DOM 層、Phase 1 §31）へ組み込む作業をここにまとめる。**コードは本書に載せていない。** Phase 1 §31 と同じく、配線表を先に確定し、テスト（`test/app.test.ts` に追加）→ 実装の順で 1 行ずつ進める。

## 15.1 配線表

| # | 配線 | 変更するファイル | 根拠 | テストで確かめること |
| --- | --- | --- | --- | --- |
| W1 | 録音の開始・停止を `MultiSourceRecorder` 経由にする。System を使わない会議は Mic の Controller だけを持ち、Phase 1 と同じ経路になる | `app.ts` | §6 | System なしで Phase 1 の `app.test.ts` が通る。System ありで `PUT …/chunks/system/0` が届く |
| W2 | 停止は System → Mic の順。ロックを持つのは Mic の `RecordingController`（App が `MultiSourceDeps.createController("mic", …)` で生成したもの。`MultiSourceRecorder` と `SourceController` はロックを公開しない）。App は生成時にその参照を保持し、`recorder.stop()` を `try/finally` で囲んで `finally` で Mic Controller の `takeMeetingLock()` を呼ぶ。`stop()` が reject（System・Mic・両方の失敗）しても受け渡しを飛ばさない。Mic の `stop()` は失敗しても `finally` で Worklet を切り離すので、`takeMeetingLock()` は保持中のロックを返せる | `app.ts` | §4 の 2・3 | System の停止が失敗しても Mic が止まり、停止理由が IDB に残る。Mic か System のメモリ待機が残るとき、または Mic の最終保存に失敗したときは、`stop()` が reject（System の失敗・Mic の失敗のどちらでも）しても `takeMeetingLock()` が返したロックが App の `heldLocks` に入る。Mic が最終保存まで終え、両方のメモリ待機が空なら、Mic の `stop()` がロックを解放済みで `takeMeetingLock()` は `null` を返し、System の失敗で reject しても `heldLocks` には入らない（§4 の 1） |
| W3 | `memoryBacklogCount(meetingId)`・`releaseHeldLockIfDrained()`・離脱確認（`releaseLifecycleIfSettled`）は Mic と System の件数の合計で判定する | `app.ts` | §4 の 3 | System だけにメモリ待機が残る間、ロックと離脱確認が外れない |
| W4 | `finalizeMeeting` の `unpersistedChunkCount` に Mic と System の合計を渡す | `app.ts` | §7 | System のメモリ待機が残っていれば `waiting_local_save` |
| W5 | drain（サーバー復帰・`setToken`・確定再試行）と破棄・WAV 書き出しを Mic と System の両方の Controller に行う | `app.ts`・`main.ts` | §4 の 4、Phase 1 §31 | 確定中止後の書き出しに System の WAV も入る。破棄で両方が空になりロックが外れる |
| W6 | 起動時復旧（Phase 1 §23）。`recovery.ts` が `listByMeeting(id, "mic")` で読むのは `audioFrameCount` を補うためで、Mic の時計の値なので **mic のままでよい**。未送信 Chunk の再投入は保存状態の索引で拾うので source を問わない | 変更なし（テストを追加） | Phase 1 §23 | System の未送信 Chunk も再送される。`audioFrameCount` は System の Chunk の `endFrame` では補われない |
| W7 | 確定に成功した会議で `MeetingEvents`（§8）を開始し、`UiAction` に変換して `reduce`（§11）へ渡す。画面を離れたら `stop()` | `app.ts` | §8・§11 | `transcript_version` を受けて `GET /transcript` を取り直す。初回接続でも `GET /meetings/{id}` と `GET /jobs` で状態を補完し（確定から購読開始までのイベントを失わない）、再接続でも同じく補完する |
| W8 | `Phase2Client`（§9）と `NotesStore`（§10）を、トークン・`baseUrl` を共有して生成する。`setToken` で作り直す。作り直す前に古い `NotesStore` の `dispose()` で保留中の debounce を `deps.clearTimer` で止め（古いトークンの PUT を新しいインスタンスと競合させない）、`dispose()` の完了（送信中の PUT と、発行済みの下書き・控えの書き込みの完了）を待ってから新しいインスタンスの `load()` を呼ぶ（待たないと古い PUT の確定前の revision を読み、保存中の編集が競合になる）。`dispose()` の戻り値（IndexedDB に書けなかった最新の下書き。書けていれば `null`）を `load(carry)` に渡す（渡さないと、下書きの書き込みが失敗した編集は止めた debounce の保存でも送られず失われる）。新しいインスタンスは `load()` を終えてから編集を受け付ける（未送信の編集は IndexedDB の下書き、または `carry` から引き継ぐ）。`setToken` の作り直しは直列に行い、前の作り直し（`dispose()` → 生成 → `load()`）が終わってから次を始める。作り直しの間に届いたトークンは最新の 1 つだけを持ち（新しいものが勝つ）、前の作り直しが終わったら最新のトークンで作り直す。途中のトークンではインスタンスを作らない。要求を送れるのは最新の `NotesStore` だけで、古いインスタンスは `dispose()` 済みで送らない（重ねて作り直すと、2 つのインスタンスが同じ `carry` を `load()` して送る） | `app.ts` | §9・§10 | トークン変更後の要求が新しいトークンで出る。変更前の未送信の編集が 1 回だけ送られる。`setToken` が続けて呼ばれても、引き継いだ編集は最新のトークンで 1 回だけ送られる |
| W9 | 同期誤差（`MultiSourceRecorder` の集計と `GET /meetings/{id}` の `syncDriftMs`）をヘッダに出す | `main.ts` | 基本設計 §16.3・§18 | 表示文言の純関数をテストする（Phase 1 の `recording-view.ts` と同じ方式） |
| W10 | System Audio の取得ボタンと、取得できなかったとき（拒否・音声トラックなし）の Mic のみへの切り替え表示 | `main.ts`・`index.html` | §5、基本設計 §16.1 | `DegradedReason` の 2 値（§2）ごとの文言 |
| W11 | 確定待ちの内訳（`main.ts` の `listByMeeting(id, "mic")` → `pendingCountsText`）に System の Chunk も含める | `main.ts`・`recording-view.ts` | Phase 1 §31.4 | System の未送信が残る会議で件数に出る。欠番・末尾の判定は source ごと |

Phase 1 のソースで source を `"mic"` に固定している箇所は、`recording-controller.ts` のメタデータ（§4 で引数化）、`finalizer.ts`（§7）、`recovery.ts`（W6。変更不要）、`main.ts`（W11）の 4 つである。実装の最後に `grep -rn '"mic"' src` で、これ以外に増えていないことを確かめる。

Phase 1 から変えない規則：ローカル以外へ通信しない（URL は `assertLocalHost()` を通す）、サーバー応答は型ガードを通す、タイマーは依存注入、非同期の完了通知は要求と対応付ける（CLAUDE.md「既知の落とし穴」）。

## 15.2 未決事項（実装着手前に利用者の判断が要る）

次の 2 点は外部依存の追加を伴うため、本書では確定しない。決まるまで、依存しない部分（§15.1 の W1〜W8、サーバー側の全 Step）を先に進められる。

| # | 論点 | 選択肢 | 影響 |
| --- | --- | --- | --- |
| D1 | 画面の描画方式 | (a) Phase 1 と同じ素の DOM（`main.ts` が `UiState` を見て描く）／(b) UI フレームワークを導入 | (a) は依存を増やさず CSP（`script-src 'self'`）もそのまま。transcript が数千行になる会議では差分描画を自前で持つ必要がある。(b) は D2 で BlockNote を選ぶなら事実上必要 |
| D2 | ノートのエディタ | (a) BlockNote（基本設計 §19 の前提。React が必要）／(b) 素の `textarea`（Markdown）で始め、保存形式だけ BlockNote JSON と互換にする | (a) は React と BlockNote を devDependency ではなく実行時依存として追加する。バンドルは `'self'` から配信するので Zero External Data Egress は保てる。(b) は依存なしで §10 の Autosave・楽観ロックをそのまま検証できるが、リッチテキスト編集がない |

本書の推奨は **D1 (a)・D2 (b) で Step 2-g を通し、BlockNote は別 Step で差し替える**。§10 の `NotesStore` は `blocknoteJson: string` を不透明な文字列として扱うので、エディタを差し替えても保存経路は変わらない。

## 15.3 実装順序（ブラウザ側）

基本設計 §29 の Step 2-d〜2-h のブラウザ側を、Phase 1 §30 と同じ粒度に分ける。前の Step のテストが通ってから次に進む。

| Step | 内容 | 完了判定 |
| --- | --- | --- |
| 2-c1 | §2 型の追加、§3 契約型とデコーダ | 既存テストが通る。`isMeetingEvent` のテスト（正常・欠落・型違い）を追加。デコーダは 2-d1 の `phase2-client.test.ts` が通す |
| 2-c2 | §4 RecordingController の変更 | Phase 1 の `recording-controller.test.ts` が無変更で通る |
| 2-c3 | §7 Finalizer の差分 | `finalizer-two-sources.test.ts`。Phase 1 のテストは §7 の 1 か所だけ直して通る |
| 2-d1 | §8 SSE クライアント、§9 型付き fetch | `events.test.ts`、`phase2-client.test.ts`（§12.4.1）。Phase 2 サーバー（Step 2-d）に対する実接続で `job` / `progress` を受ける |
| 2-d2 | §10 NotesStore、§11 UI 状態、§15.1 W7・W8、transcript の表示 | `notes-store.test.ts`（別タブ編集で `409` → 上書きしない、W8 のトークン変更）・`ui-state.test.ts`。1 時間会議の transcript が画面に出る（基本設計 Step 2-d）。W8 が `NotesStore` を生成するので §10 をここで入れる。`blocknoteJson` は不透明な文字列なので D2 に依存しない（§15.2） |
| 2-f1 | 要約と `rejected` の表示、再生成 | 偽 ID を返すモックで `rejected` が折りたたみ表示される |
| 2-g1 | ノートの編集 UI（§15.2 D2 の決定後。保存経路は 2-d2 の `NotesStore`） | 編集が autosave で保存される。別タブ編集の `409` で上書きせず競合を表示する |
| 2-h1 | §5 System Audio、§6 MultiSourceRecorder、§15.1 W1〜W6・W9〜W11 | `system-audio.test.ts`・`multi-source.test.ts`、W11 の確定待ちの内訳（System の未送信が件数に出る）。Mic のみへのフォールバック、P95/P99 の表示 |
