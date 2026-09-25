// src/types/recording.ts
// Phase 1 の型定義一式。v4.0 §4.1 / §6 / §7 / §11 / §89 を継承し、ローカル保存向けに拡張する。

/** 音声パイプラインの固定仕様。値はリテラル型で固定し、実行時に変更できない。 */
export interface AudioPipelineConfig {
  /** 出力サンプルレート。AudioContext のネイティブレートとは独立に固定する。 */
  readonly targetSampleRate: 16000;
  readonly channels: 1;
  readonly bitDepth: 16;
  readonly chunkDurationMs: 30000;
  /** targetSampleRate * chunkDurationMs / 1000 = 480,000 */
  readonly samplesPerChunk: 480000;
}

export const AUDIO_PIPELINE_CONFIG: AudioPipelineConfig = {
  targetSampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  chunkDurationMs: 30000,
  samplesPerChunk: 480000,
};

/** 録音セッションの時刻基準。audioFrameCount を正とし、他は対応付けと表示のために保持する。 */
export interface SessionClock {
  /** 録音開始時の Date.now() */
  readonly sessionStartEpochMs: number;
  /** performance.timeOrigin */
  readonly performanceTimeOrigin: number;
  /** 録音開始時の performance.now() */
  readonly sessionStartPerformanceMs: number;
  /** 録音開始時の audioContext.currentTime（秒） */
  readonly audioContextStartTime: number;
  /** AudioContext のネイティブ sample rate。実行時に取得した値で、16000 とは限らない。 */
  readonly nativeSampleRate: number;
  /** Worklet が出力した 16kHz サンプルの累計。録音時間の唯一の正。 */
  audioFrameCount: number;
}

export type AudioSource = "mic" | "system";

/** 各 Chunk に付与するメタデータ。v4.0 §7 を継承し、sha256 を必須にする。 */
export interface ChunkTimingMetadata {
  readonly meetingId: string;
  readonly source: AudioSource;
  readonly sequenceNo: number;
  /** 16kHz サンプル単位の Session Clock 上の開始・終了位置 */
  readonly startFrame: number;
  readonly endFrame: number;
  /** startFrame / 16000 * 1000 */
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  /** sessionStartEpochMs + startOffsetMs（表示用。時刻の正ではない） */
  readonly wallClockStartEpochMs: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
  /** 通常 30000。最終 Chunk のみ短くなりうる。 */
  readonly durationMs: number;
  /** この Chunk に含まれる実サンプル数。通常 480000。最終 Chunk のみ少なくなりうる。 */
  readonly sampleCount: number;
  readonly vadScore: number;
  readonly hasVoice: boolean;
  /** WAV ファイル全体（ヘッダ含む）の SHA-256（小文字 hex 64 文字） */
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** VAD の設定値。v4.0 §11 を継承。threshold は固定仕様ではなく設定値。 */
export interface VADConfig {
  /** vadScore がこの値以上のフレームを音声候補とみなす。初期値 0.15 */
  readonly threshold: number;
  /** 音声候補がこの時間以上続いたら hasVoice=true。初期値 200 */
  readonly minSpeechMs: number;
  /** 音声候補が途切れてからこの時間は音声とみなし続ける。初期値 300 */
  readonly hangoverMs: number;
  /** RMS を正規化する際の下限（dBFS）。初期値 -60 */
  readonly floorDbfs: number;
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  threshold: 0.15,
  minSpeechMs: 200,
  hangoverMs: 300,
  floorDbfs: -60,
};

/** Chunk 単位の VAD 結果。score は 0..1 の正規化値。 */
export interface VADResult {
  readonly score: number;
  readonly hasVoice: boolean;
  /** Chunk 内で音声と判定されたサンプル数 */
  readonly voicedSamples: number;
}

/** 録音の健全性。タイマーではなくイベント発生時刻を保持し、UI と監視が差分を評価する。 */
export interface RecordingHealth {
  /** Worklet から最後に PCM を受信した performance.now() */
  lastAudioFrameAt: number;
  /** 最後に Chunk を IndexedDB へ書き込んだ performance.now() */
  lastChunkAt: number;
  /** 最後にローカル保存（PUT または FSA）が成功した performance.now() */
  lastSuccessfulLocalSaveAt: number;
  /** 最後にサーバーのヘルスチェックを実施した performance.now() */
  lastBackendHealthCheckAt: number;
  /** audioFrameCount から算出した経過時間と performance.now() 経過時間の差（ms）。正なら音声時計が遅れている。 */
  frameClockDriftMs: number;
  /** navigator.storage.persist() の結果。未要求は null */
  storagePersisted: boolean | null;
  /** IndexedDB 使用率（0..1）。estimate() 未対応は null */
  storageUsageRatio: number | null;
  /** サーバーへ未送信のまま IndexedDB に滞留している Chunk 数 */
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
  | "MIC_TRACK_ENDED";

/** ローカル保存 State Machine の状態。§9 の遷移図と 1 対 1 に対応する。 */
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

/** Chunk ごとの保存状態。IndexedDB の audio_chunks レコードに埋め込む。 */
export interface LocalSaveState {
  status: LocalSaveStatus;
  /** 保存経路。SAVED 以降で確定 */
  savedVia: SavedVia | null;
  attempts: number;
  /** 次回リトライ予定の performance.now()。RETRYING 以外は null */
  nextRetryAt: number | null;
  /** 最後のエラー分類。成功時は null */
  lastError: LocalSaveError | null;
  /** サーバーが返した保存先パス。DB_REGISTERED で確定 */
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
  | "NETWORK"        // fetch が TypeError（接続不能）
  | "TIMEOUT"        // AbortController によるタイムアウト
  | "UNAUTHORIZED"   // 401 / 403
  | "CONFLICT"       // 409（同一キー・異なるハッシュ）
  | "HASH_MISMATCH"  // サーバーが計算した sha256 が一致しない
  | "SERVER"         // 5xx
  | "STORAGE_FULL"   // 507 Insufficient Storage
  | "VALIDATION"     // 400 / 422
  | "UNKNOWN";

/** ローカル常駐サーバーの可用性。§3.6 */
export type LocalBackendStatus = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNREACHABLE";

export interface LocalBackendHealth {
  status: LocalBackendStatus;
  /** 最後にヘルスチェックを試みた performance.now() */
  lastCheckedAt: number;
  /** 最後に HEALTHY だった performance.now()。一度も成功していなければ null */
  lastHealthyAt: number | null;
  /** 直近のヘルスチェック応答時間（ms）。UNREACHABLE のときは null */
  latencyMs: number | null;
  /** 連続失敗回数 */
  consecutiveFailures: number;
  /** サーバーが自己申告する能力。UNREACHABLE のときは null */
  capabilities: LocalBackendCapabilities | null;
  /** 401 を受けた場合 true。UI は設定画面へ誘導する */
  unauthorized: boolean;
}

/** GET /v1/health のレスポンス。ハードウェア検出はサーバー側の責務（§3.7）。 */
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

/** IndexedDB クォータの観測値。§21 */
export interface LocalStorageQuota {
  readonly usageBytes: number;
  readonly quotaBytes: number;
  readonly ratio: number;
  readonly checkedAt: number;
}

/** Meeting の Phase 1 状態。v4.0 §42 の Phase 1 部分のみ。 */
export type MeetingStatus = "created" | "recording" | "stop_requested" | "finalizing" | "finalized";

/** IndexedDB の meetings レコード */
export interface MeetingRecord {
  readonly meetingId: string;
  title: string;
  status: MeetingStatus;
  readonly sessionClock: SessionClock;
  readonly consentConfirmedAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** Finalization Barrier 通過時に確定する Chunk 総数 */
  finalChunkCount: number | null;
}

/** IndexedDB の audio_chunks レコード。メタデータと WAV 本体を同一レコードに置く（§10.3）。 */
export interface AudioChunkRecord {
  /** `${meetingId}:${source}:${sequenceNo.toString().padStart(6, "0")}` */
  readonly chunkKey: string;
  readonly meta: ChunkTimingMetadata;
  save: LocalSaveState;
  /** WAV 本体。DB_REGISTERED 後にクォータ縮退で null になりうる（§3.4）。 */
  wav: Blob | null;
  readonly createdAt: number;
}

// ---- AudioWorklet ↔ Main Thread メッセージ（discriminated union） ----

/** Main → Worklet */
export type WorkletCommand =
  | { readonly type: "configure"; readonly vad: VADConfig }
  | { readonly type: "start" }
  /** requestId は flushed で同じ値が返る。応答と要求を対応付け、タイムアウトした要求への遅れた応答を捨てるために使う。 */
  | { readonly type: "flush"; readonly requestId: number }
  | { readonly type: "stop"; readonly requestId: number };

/** Worklet → Main */
export type WorkletEvent =
  | {
      readonly type: "ready";
      readonly nativeSampleRate: number;
      readonly renderQuantum: number;
    }
  | {
      readonly type: "chunk";
      /** 16kHz PCM16 mono。Transferable として所有権を移す。 */
      readonly pcm: ArrayBuffer;
      readonly sampleCount: number;
      readonly startFrame: number;
      readonly endFrame: number;
      readonly vad: VADResult;
      /** flush / stop によって生成された部分 Chunk なら true */
      readonly partial: boolean;
    }
  | {
      /** 生存確認。process() が呼ばれるたびではなく、16kHz 換算で 1 秒ごとに送る。 */
      readonly type: "heartbeat";
      readonly audioFrameCount: number;
      readonly currentTime: number;
    }
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
