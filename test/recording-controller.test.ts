import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWavHeader } from "../src/audio/wav";
import { makeChunkKey, RecordingController, sha256Hex } from "../src/recording/recording-controller";
import { ChunkStore, MeetingStore, openDatabase } from "../src/storage/idb";
import type { AudioChunkRecord, RecordingHealth, WorkletCommand } from "../src/types/recording";

function createHealth(): RecordingHealth {
  return {
    lastAudioFrameAt: 0,
    lastChunkAt: 0,
    lastSuccessfulLocalSaveAt: 0,
    lastBackendHealthCheckAt: 0,
    frameClockDriftMs: 0,
    storagePersisted: null,
    storageUsageRatio: null,
    pendingChunkCount: 0,
    audioContextState: "running",
    degradedReasons: [],
  };
}

async function flushMessages(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Worklet 側の端。受け取ったコマンドを記録し、stop / flush には部分 Chunk + flushed で応答する。 */
class FakeWorkletSide {
  readonly commands: WorkletCommand[] = [];
  private frame = 0;
  constructor(readonly port: MessagePort) {
    port.onmessage = (e: MessageEvent<WorkletCommand>) => {
      this.commands.push(e.data);
      if (e.data.type === "stop" || e.data.type === "flush") {
        this.sendChunk(1600, true);
        port.postMessage({ type: "flushed", audioFrameCount: this.frame });
      }
    };
  }

  sendChunk(sampleCount: number, partial = false): void {
    const pcm = new Int16Array(sampleCount).fill(100);
    const startFrame = this.frame;
    this.frame += sampleCount;
    this.port.postMessage(
      { type: "chunk", pcm: pcm.buffer, sampleCount, startFrame, endFrame: this.frame, vad: { score: 0.4, hasVoice: true, voicedSamples: sampleCount }, partial },
      [pcm.buffer],
    );
  }
}

interface Setup {
  controller: RecordingController;
  worklet: FakeWorkletSide;
  chunkStore: ChunkStore;
  meetingStore: MeetingStore;
  enqueued: string[];
  health: RecordingHealth;
  errors: Error[];
  track: EventTarget & { stop: ReturnType<typeof vi.fn> };
}

async function setup(chunkStoreOverride?: (db: IDBDatabase) => ChunkStore): Promise<Setup> {
  const db = await openDatabase(new IDBFactory());
  const chunkStore = chunkStoreOverride?.(db) ?? new ChunkStore(db);
  const meetingStore = new MeetingStore(db);
  const channel = new MessageChannel();
  const worklet = new FakeWorkletSide(channel.port2);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = channel.port1;
    },
  );
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const audioContext = {
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
  } as unknown as AudioContext;
  const mediaStream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const enqueued: string[] = [];
  const health = createHealth();
  const errors: Error[] = [];
  const controller = new RecordingController({
    audioContext,
    mediaStream,
    chunkStore,
    meetingStore,
    scheduler: { enqueue: async (key: string) => void enqueued.push(key) },
    health,
    workletModuleUrl: "/worklet.js",
    onError: (e) => errors.push(e),
  });
  return { controller, worklet, chunkStore, meetingStore, enqueued, health, errors, track };
}

describe("makeChunkKey / sha256Hex", () => {
  it("chunkKey は sequenceNo を 6 桁ゼロ埋めし文字列順 = 番号順になる", () => {
    expect(makeChunkKey("m", "mic", 7)).toBe("m:mic:000007");
    expect(makeChunkKey("m", "mic", 10) > makeChunkKey("m", "mic", 9)).toBe(true);
  });

  it("sha256Hex は小文字 hex 64 文字（既知ベクトル 'abc'）", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("abc").buffer as ArrayBuffer);
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("RecordingController", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start で会議を recording として保存し、Worklet に configure → start を送る", async () => {
    // Arrange
    const s = await setup();
    // Act
    await s.controller.start("m1", "定例", 123);
    await flushMessages();
    // Assert
    const meeting = await s.meetingStore.get("m1");
    expect(meeting?.status).toBe("recording");
    expect(meeting?.consentConfirmedAt).toBe(123);
    expect(meeting?.sessionClock.nativeSampleRate).toBe(48000);
    expect(s.worklet.commands.map((c) => c.type)).toEqual(["configure", "start"]);
  });

  it("chunk イベントは WAV 化・SHA-256 付与のうえ IDB_STORED で保存され、Scheduler に投入される", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(480000);
    s.worklet.sendChunk(480000);
    await flushMessages();

    expect(s.enqueued).toEqual(["m1:mic:000000", "m1:mic:000001"]);
    const rec = (await s.chunkStore.getChunk("m1:mic:000001")) as AudioChunkRecord;
    expect(rec.save.status).toBe("IDB_STORED");
    expect(rec.meta).toMatchObject({ sequenceNo: 1, startFrame: 480000, endFrame: 960000, startOffsetMs: 30000, endOffsetMs: 60000, durationMs: 30000, sampleCount: 480000, sizeBytes: 960044, hasVoice: true });
    const buf = await (rec.wav as Blob).arrayBuffer();
    expect(parseWavHeader(buf).ok).toBe(true);
    expect(await sha256Hex(buf)).toBe(rec.meta.sha256);
    expect(s.health.lastChunkAt).toBeGreaterThan(0);
    expect(s.controller.sessionClock?.audioFrameCount).toBe(960000);
  });

  it("stop は stop_requested を記録し、最終の部分 Chunk の保存完了まで待ってからトラックを止める", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(480000);
    await s.controller.stop();

    expect((await s.meetingStore.get("m1"))?.status).toBe("stop_requested");
    expect(s.enqueued).toEqual(["m1:mic:000000", "m1:mic:000001"]);
    const last = await s.chunkStore.getChunk("m1:mic:000001");
    expect(last?.meta.sampleCount).toBe(1600);
    expect(last?.meta.startFrame).toBe(480000);
    expect(s.track.stop).toHaveBeenCalled();
  });

  it("flush は録音を継続したまま部分 Chunk の IDB 書き込みまで待つ", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    await s.controller.flush();
    expect(s.enqueued).toEqual(["m1:mic:000000"]);
    expect((await s.meetingStore.get("m1"))?.status).toBe("recording");
  });

  it("QuotaExceededError ではメモリ待機に回し録音を止めず、回復後に drain できる", async () => {
    // Arrange：最初の put だけクォータ超過で失敗させる
    let failNext = true;
    const s = await setup(
      (db) =>
        new (class extends ChunkStore {
          override async putChunk(r: AudioChunkRecord): Promise<void> {
            if (failNext) {
              failNext = false;
              throw new DOMException("full", "QuotaExceededError");
            }
            return super.putChunk(r);
          }
        })(db),
    );
    await s.controller.start("m1", "定例", 1);
    // Act
    s.worklet.sendChunk(1600);
    await flushMessages();
    // Assert
    expect(s.controller.memoryBacklogCount).toBe(1);
    expect(s.health.degradedReasons).toContain("IDB_QUOTA_EXHAUSTED");
    expect(s.errors).toHaveLength(0);
    expect(s.enqueued).toHaveLength(0);

    s.worklet.sendChunk(1600); // 録音は継続し、次の Chunk は保存される
    await flushMessages();
    expect(s.enqueued).toEqual(["m1:mic:000001"]);

    expect(await s.controller.drainMemoryBacklog()).toBe(1);
    expect(s.controller.memoryBacklogCount).toBe(0);
    expect(s.enqueued).toContain("m1:mic:000000");
  });

  it("QuotaExceeded 以外の保存エラーは onError に通知される（握りつぶさない）", async () => {
    const s = await setup(
      (db) =>
        new (class extends ChunkStore {
          override async putChunk(): Promise<void> {
            throw new Error("disk exploded");
          }
        })(db),
    );
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(1600);
    await flushMessages();
    expect(s.errors.map((e) => e.message)).toEqual(["disk exploded"]);
  });

  it("Worklet の ready が報告するレートと AudioContext のレートが異なれば onError", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.port.postMessage({ type: "ready", nativeSampleRate: 44100, renderQuantum: 128 });
    await flushMessages();
    expect(s.errors[0]?.message).toContain("sampleRate mismatch");
  });

  it("Mic トラック終了で MIC_TRACK_ENDED が degradedReasons に入る", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.track.dispatchEvent(new Event("ended"));
    expect(s.health.degradedReasons).toContain("MIC_TRACK_ENDED");
  });
});
