// src/recording/recording-controller.ts
import {
  AUDIO_PIPELINE_CONFIG,
  DEFAULT_VAD_CONFIG,
  isWorkletEvent,
  type AudioChunkRecord,
  type ChunkTimingMetadata,
  type MeetingRecord,
  type RecordingHealth,
  type SessionClock,
  type WorkletCommand,
  type WorkletEvent,
} from "../types/recording";
import { createSessionClock, frameToOffsetMs } from "./session-clock";
import { buildStandaloneWav } from "../audio/wav";
import { ChunkStore, MeetingStore, isQuotaExceeded } from "../storage/idb";

/** Chunk を保存 State Machine に投入する口。LocalSaveScheduler が構造的に満たす（テストでは差し替える）。 */
export interface ChunkEnqueuer {
  enqueue(chunkKey: string): Promise<void>;
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
  /** flush / stop の応答待ちタイムアウト用。既定は setTimeout（テストでは差し替える） */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

/** Worklet が flush / stop に応答しない（AudioContext が閉じられた等）ときに待機を打ち切るまでの時間 */
const FLUSH_TIMEOUT_MS = 5_000;

export function makeChunkKey(meetingId: string, source: "mic" | "system", sequenceNo: number): string {
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
  private meeting: MeetingRecord | null = null;
  private nextSequenceNo = 0;
  /** QuotaExceededError で IDB に書けなかった Chunk（§3.4 段階3） */
  private readonly memoryBacklog: AudioChunkRecord[] = [];
  /** Chunk 処理の直列化。Worklet からの chunk イベントは順序どおりに IDB へ書く。 */
  private chunkQueue: Promise<void> = Promise.resolve();
  /** requestId → flushed 待機。応答は要求 ID で対応付ける（タイムアウト後の遅れた応答が別の要求を解放しないように） */
  private readonly flushWaiters = new Map<number, () => void>();
  private nextRequestId = 0;

  constructor(private readonly deps: RecordingControllerDeps) {}

  get sessionClock(): SessionClock | null {
    return this.clock;
  }

  async start(meetingId: string, title: string, consentConfirmedAt: number): Promise<void> {
    const { audioContext, mediaStream, workletModuleUrl } = this.deps;

    // AudioContext は sampleRate を指定せずに生成されている前提。実際の値はここで取得する。
    await audioContext.audioWorklet.addModule(workletModuleUrl);
    this.clock = createSessionClock(audioContext);

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
    this.meeting = meeting;

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

    for (const track of mediaStream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        this.deps.health.degradedReasons = [...this.deps.health.degradedReasons, "MIC_TRACK_ENDED"];
      });
    }

    this.post({ type: "configure", vad: DEFAULT_VAD_CONFIG });
    this.post({ type: "start" });
  }

  /** pagehide 用。Worklet に flush を要求し、部分 Chunk の IDB 書き込みまで待つ。 */
  async flush(): Promise<void> {
    if (this.node === null) return;
    await this.requestFlush("flush");
    await this.chunkQueue;
  }

  /** stop_requested → 最終 Chunk 生成 → IDB 書き込み完了まで待つ。Finalization Barrier は §22。 */
  async stop(): Promise<void> {
    if (this.node === null || this.meeting === null) return;
    const meeting = this.meeting;
    try {
      meeting.status = "stop_requested";
      await this.deps.meetingStore.put(meeting);

      await this.requestFlush("stop");
      await this.chunkQueue;
      // flush 後の最終 audioFrameCount を永続化する（Finalizer が totalAudioFrames として送る値）
      meeting.updatedAt = Date.now();
      await this.deps.meetingStore.put(meeting);
    } finally {
      // 途中で reject してもマイクと Worklet を解放する
      this.sourceNode?.disconnect();
      if (this.node !== null) this.node.port.onmessage = null;
      this.node = null;
      for (const track of this.deps.mediaStream.getAudioTracks()) track.stop();
    }
  }

  /** IDB クォータが回復したときに UI / QuotaMonitor から呼ぶ。 */
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

  /** flush / stop を送り、同じ requestId の flushed を待つ。応答がなければタイムアウトで onError を通知して待機を打ち切る。 */
  private requestFlush(type: "flush" | "stop"): Promise<void> {
    const requestId = ++this.nextRequestId;
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    return new Promise<void>((resolve) => {
      this.flushWaiters.set(requestId, resolve);
      setTimer(() => {
        // 応答済みなら何もしない。自分の待機だけを外し、遅れて届いた flushed は対応する待機がないので無視される
        if (!this.flushWaiters.delete(requestId)) return;
        this.deps.onError(new Error(`worklet did not respond to ${type} within ${FLUSH_TIMEOUT_MS}ms`));
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
        // nativeSampleRate は createSessionClock で取得済み。ここでは一致確認のみ。
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
        // chunk イベントは flushed より先に届く（同一 MessagePort は順序保証）。
        // 要求した requestId の待機だけを解放する。後続コマンドの待機は自分の flushed まで残す。
        this.chunkQueue = this.chunkQueue.then(() => {
          const resolve = this.flushWaiters.get(event.requestId);
          this.flushWaiters.delete(event.requestId);
          resolve?.();
        });
        break;
    }
  }

  private async persistChunk(event: Extract<WorkletEvent, { type: "chunk" }>): Promise<void> {
    if (this.meeting === null || this.clock === null) throw new Error("recording not started");

    const sequenceNo = this.nextSequenceNo++;
    const pcm = new Int16Array(event.pcm, 0, event.sampleCount);
    const wavBuffer = buildStandaloneWav(pcm);
    const sha256 = await sha256Hex(wavBuffer);

    const startOffsetMs = frameToOffsetMs(event.startFrame);
    const endOffsetMs = frameToOffsetMs(event.endFrame);
    const meta: ChunkTimingMetadata = {
      meetingId: this.meeting.meetingId,
      source: "mic",
      sequenceNo,
      startFrame: event.startFrame,
      endFrame: event.endFrame,
      startOffsetMs,
      endOffsetMs,
      wallClockStartEpochMs: this.clock.sessionStartEpochMs + startOffsetMs,
      sampleRate: AUDIO_PIPELINE_CONFIG.targetSampleRate,
      channels: AUDIO_PIPELINE_CONFIG.channels,
      durationMs: endOffsetMs - startOffsetMs,
      sampleCount: event.sampleCount,
      vadScore: event.vad.score,
      hasVoice: event.vad.hasVoice,
      sha256,
      sizeBytes: wavBuffer.byteLength,
    };

    const record: AudioChunkRecord = {
      chunkKey: makeChunkKey(meta.meetingId, meta.source, sequenceNo),
      meta,
      save: {
        status: "GENERATED",
        savedVia: null,
        attempts: 0,
        nextRetryAt: null,
        lastError: null,
        serverPath: null,
        updatedAt: performance.now(),
      },
      wav: new Blob([wavBuffer], { type: "audio/wav" }),
      createdAt: Date.now(),
    };

    try {
      await this.deps.chunkStore.putChunk(record);
    } catch (error) {
      // 失敗理由を問わずメモリ待機に残す。sequenceNo は採番済みなので、捨てると欠番になり Finalizer が進めなくなる
      this.memoryBacklog.push(record);
      if (isQuotaExceeded(error)) {
        // §3.4 段階3：メモリ待機。録音は止めない。
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
