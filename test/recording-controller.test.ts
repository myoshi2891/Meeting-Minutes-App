import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWavHeader } from "../src/audio/wav";
import { makeChunkKey, RecordingController, sha256Hex, type DirectChunkSaver } from "../src/recording/recording-controller";
import { ChunkStore, MeetingStore, openDatabase } from "../src/storage/idb";
import type { AudioChunkRecord, RecordingHealth, WorkletCommand } from "../src/types/recording";
import { meetingLockName, tryAcquireMeetingLock } from "../src/recording/meeting-lock";
import { FakeLockManager } from "./harness";

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

/** 観測できる変化（Worklet へのコマンド・enqueue・onError）のたびに条件を再評価する。固定回数のタイマー待ちはしない */
class Signal {
  private waiters: Array<() => void> = [];
  notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  async until(condition: () => boolean): Promise<void> {
    while (!condition()) await new Promise<void>((r) => this.waiters.push(r));
  }
}

/** Worklet 側の端。受け取ったコマンドを記録し、stop / flush には部分 Chunk + flushed（同じ requestId）で応答する。 */
class FakeWorkletSide {
  readonly commands: WorkletCommand[] = [];
  /** true の間は flush / stop に応答しない（AudioContext が閉じられた Worklet を模す） */
  silent = false;
  private frame = 0;
  constructor(
    readonly port: MessagePort,
    private readonly signal: Signal,
  ) {
    port.onmessage = (e: MessageEvent<WorkletCommand>) => {
      this.commands.push(e.data);
      this.signal.notify();
      if (this.silent) return;
      if (e.data.type === "stop" || e.data.type === "flush") {
        this.sendChunk(1600, true);
        this.sendFlushed(e.data.requestId);
      }
    };
  }

  sendFlushed(requestId: number): void {
    this.port.postMessage({ type: "flushed", requestId, audioFrameCount: this.frame });
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
  locks: FakeLockManager;
  track: EventTarget & { stop: ReturnType<typeof vi.fn> };
  audioContext: AudioContext;
  /** 注入したタイマー。fireTimers() で期限を待たずに発火させる */
  fireTimers: () => void;
  /** Worklet へのコマンド・enqueue・onError のいずれかで condition が真になるまで待つ */
  until: (condition: () => boolean) => Promise<void>;
  /** 指定した種類のコマンドを Worklet が受け取るまで待つ */
  untilCommand: (type: WorkletCommand["type"]) => Promise<void>;
}

async function setup(chunkStoreOverride?: (db: IDBDatabase) => ChunkStore, directSaver?: DirectChunkSaver): Promise<Setup> {
  const db = await openDatabase(new IDBFactory());
  const chunkStore = chunkStoreOverride?.(db) ?? new ChunkStore(db);
  const meetingStore = new MeetingStore(db);
  const channel = new MessageChannel();
  const signal = new Signal();
  const worklet = new FakeWorkletSide(channel.port2, signal);
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
  const timers: Array<() => void> = [];
  const locks = new FakeLockManager();
  const controller = new RecordingController({
    audioContext,
    mediaStream,
    chunkStore,
    meetingStore,
    scheduler: {
      enqueue: async (key: string) => {
        enqueued.push(key);
        signal.notify();
      },
    },
    health,
    workletModuleUrl: "/worklet.js",
    onError: (e) => {
      errors.push(e);
      signal.notify();
    },
    setTimer: (fn) => timers.push(fn),
    locks,
    directSaver,
  });
  const fireTimers = () => {
    for (const fn of timers.splice(0)) fn();
  };
  const until = (condition: () => boolean) => signal.until(condition);
  const untilCommand = (type: WorkletCommand["type"]) => until(() => worklet.commands.some((c) => c.type === type));
  return { controller, worklet, chunkStore, meetingStore, enqueued, health, errors, locks, track, audioContext, fireTimers, until, untilCommand };
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
    await s.untilCommand("start");
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
    await s.until(() => s.enqueued.length >= 2);

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

  it("録音中は会議ロックを保持し、stop の完了で解放する", async () => {
    // Arrange
    const s = await setup();
    // Act
    await s.controller.start("m1", "定例", 1);
    const heldWhileRecording = s.locks.held.has(meetingLockName("m1"));
    await s.controller.stop();
    // Assert
    expect(heldWhileRecording).toBe(true);
    expect(s.locks.held.has(meetingLockName("m1"))).toBe(false);
  });

  it("同じ会議のロックを他が保持していれば start は失敗し、会議を保存しない", async () => {
    // Arrange
    const s = await setup();
    const release = await tryAcquireMeetingLock(s.locks, "m1");
    // Act / Assert
    await expect(s.controller.start("m1", "定例", 1)).rejects.toThrow("already being recorded");
    expect(await s.meetingStore.get("m1")).toBeUndefined();
    release?.();
  });

  it("start が途中で失敗したら会議ロックを解放する", async () => {
    // Arrange：Worklet モジュールの読み込みに失敗する
    const s = await setup();
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new Error("node failed");
        }
      },
    );
    // Act / Assert
    await expect(s.controller.start("m1", "定例", 1)).rejects.toThrow("node failed");
    expect(s.locks.held.size).toBe(0);
  });

  it("会議を recording で保存した後に start が失敗したら、会議を created に戻して起動時復旧の対象から外す", async () => {
    // Arrange：会議の保存後に Worklet ノードの生成が失敗する
    const s = await setup();
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new Error("node failed");
        }
      },
    );
    // Act
    await expect(s.controller.start("m1", "定例", 1)).rejects.toThrow("node failed");
    // Assert：recording のまま残すと、次回起動の復旧が stop_requested に落として空の会議を finalize しうる
    const meeting = await s.meetingStore.get("m1");
    expect(meeting?.status).toBe("created");
    expect(s.controller.sessionClock).toBeNull();
    // stop() は Worklet がないと何もしないため、ここでマイクを解放しないと取得したままになる
    expect(s.track.stop).toHaveBeenCalled();
  });

  it("Worklet モジュールの読み込みに失敗したら、マイクを解放して会議ロックも解放する", async () => {
    // Arrange
    const s = await setup();
    vi.mocked(s.audioContext.audioWorklet.addModule).mockRejectedValueOnce(new Error("addModule failed"));
    // Act
    await expect(s.controller.start("m1", "定例", 1)).rejects.toThrow("addModule failed");
    // Assert：stop() は Worklet がないと何もしないため、ここで止めないとマイクを取得したままになる
    expect(s.track.stop).toHaveBeenCalled();
    expect(s.controller.sessionClock).toBeNull();
    expect(s.locks.held.size).toBe(0);
    expect(await s.meetingStore.get("m1")).toBeUndefined();
  });

  it("会議の保存に失敗したら、マイクを解放して会議ロックも解放する", async () => {
    // Arrange
    const s = await setup();
    vi.spyOn(s.meetingStore, "put").mockRejectedValueOnce(new Error("put failed"));
    // Act
    await expect(s.controller.start("m1", "定例", 1)).rejects.toThrow("put failed");
    // Assert
    expect(s.track.stop).toHaveBeenCalled();
    expect(s.controller.sessionClock).toBeNull();
    expect(s.locks.held.size).toBe(0);
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
    // flush 後の最終フレーム数が IDB の会議レコードに反映されている（Finalizer の totalAudioFrames の元）
    expect((await s.meetingStore.get("m1"))?.sessionClock.audioFrameCount).toBe(481600);
  });

  it("同じインスタンスで stop 後に別の会議を start すると、Chunk の連番は 0 から始まる", async () => {
    // Arrange：1 件目の会議で Chunk を 1 つ保存して止める
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    await s.controller.stop();
    // Act
    await s.controller.start("m2", "定例2", 2);
    await s.controller.stop();
    // Assert
    expect(s.enqueued).toEqual(["m1:mic:000000", "m2:mic:000000"]);
  });

  it("Worklet が stop に応答しなくてもタイムアウトで onError を通知し、トラックを解放して stop が終わる", async () => {
    // Arrange
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.silent = true;
    // Act
    const stopped = s.controller.stop().then(() => "done");
    // stop の送信より前にタイムアウトのタイマーが登録されている
    await s.untilCommand("stop");
    s.fireTimers();
    // Assert
    expect(await stopped).toBe("done");
    expect(s.errors.map((e) => e.message)).toEqual([expect.stringContaining("stop")]);
    expect(s.track.stop).toHaveBeenCalled();
  });

  it("タイムアウトした flush への遅れた flushed で、後続の stop の待機を解放しない", async () => {
    // Arrange：flush がタイムアウトした後で Worklet が応答を再開する
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.silent = true;
    const flushed = s.controller.flush();
    await s.untilCommand("flush");
    s.fireTimers();
    await flushed;
    const flushCmd = s.worklet.commands.find((c) => c.type === "flush");
    if (flushCmd?.type !== "flush") throw new Error("flush command not sent");
    // Act：stop を送った直後に、flush への遅れた応答だけが届く
    const stopped = s.controller.stop().then(() => "done");
    await s.untilCommand("stop");
    s.worklet.sendFlushed(flushCmd.requestId);
    // flushed の待機解放と Chunk の保存は同じ chunkQueue に順に積まれるので、後続 Chunk の enqueue で遅れた flushed の処理済みを確認できる
    s.worklet.sendChunk(1600, true);
    await s.until(() => s.enqueued.length >= 1);
    s.fireTimers();
    // Assert：遅れた flushed で stop の待機は外れておらず、stop のタイムアウトが発火してから完了する
    expect(await stopped).toBe("done");
    expect(s.errors.map((e) => e.message)).toEqual([expect.stringContaining("flush"), expect.stringContaining("stop")]);
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
    // Act：Chunk は直列に処理されるので、2 件目の enqueue で 1 件目の処理完了を確認できる
    s.worklet.sendChunk(1600);
    s.worklet.sendChunk(1600); // 録音は継続し、次の Chunk は保存される
    await s.until(() => s.enqueued.length >= 1);
    // Assert
    expect(s.controller.memoryBacklogCount).toBe(1);
    expect(s.health.degradedReasons).toContain("IDB_QUOTA_EXHAUSTED");
    expect(s.errors).toHaveLength(0);
    expect(s.enqueued).toEqual(["m1:mic:000001"]);

    expect(await s.controller.drainMemoryBacklog()).toBe(1);
    expect(s.controller.memoryBacklogCount).toBe(0);
    expect(s.enqueued).toContain("m1:mic:000000");
  });

  it("QuotaExceeded 以外の保存エラーは onError に通知しつつ、Chunk をメモリ待機に残して欠番を作らない", async () => {
    // Arrange：最初の put だけ一般エラーで失敗させる
    let failNext = true;
    const s = await setup(
      (db) =>
        new (class extends ChunkStore {
          override async putChunk(r: AudioChunkRecord): Promise<void> {
            if (failNext) {
              failNext = false;
              throw new Error("disk exploded");
            }
            return super.putChunk(r);
          }
        })(db),
    );
    await s.controller.start("m1", "定例", 1);
    // Act
    s.worklet.sendChunk(1600);
    await s.until(() => s.errors.length >= 1);
    // Assert
    expect(s.errors.map((e) => e.message)).toEqual(["disk exploded"]);
    expect(s.controller.memoryBacklogCount).toBe(1);
    expect(s.health.degradedReasons).not.toContain("IDB_QUOTA_EXHAUSTED");
    // メモリ待機はクラッシュで失われるので、クォータ以外の失敗も UI に出す
    expect(s.health.degradedReasons).toContain("IDB_WRITE_FAILED");

    expect(await s.controller.drainMemoryBacklog()).toBe(1);
    expect((await s.chunkStore.getChunk("m1:mic:000000"))?.meta.sequenceNo).toBe(0);
  });

  /** IDB への書き込みが常に失敗する ChunkStore（別タブの versionchange で接続が閉じた状態） */
  const closedStore = (db: IDBDatabase): ChunkStore =>
    new (class extends ChunkStore {
      override async putChunk(): Promise<void> {
        throw new DOMException("The database connection is closing.", "InvalidStateError");
      }
    })(db);

  it("IDB に書けない Chunk は drain でサーバーへ直接送り、メモリ待機から外す", async () => {
    // Arrange
    const sent: string[] = [];
    const s = await setup(closedStore, {
      put: async (r) => {
        sent.push(r.chunkKey);
        return { ok: true, registered: true, serverPath: "recordings/x.wav", idempotent: false };
      },
    });
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(1600);
    await s.until(() => s.errors.length >= 1);
    // Act
    const drained = await s.controller.drainMemoryBacklog();
    // Assert：再オープンしても直らない（VersionError）ので IDB を待たずにサーバーへ逃がす
    expect(drained).toBe(1);
    expect(sent).toEqual(["m1:mic:000000"]);
    expect(s.controller.memoryBacklogCount).toBe(0);
  });

  it("サーバーへの直接送信も失敗したら IDB の例外を投げ、メモリ待機に残す", async () => {
    // Arrange
    const s = await setup(closedStore, {
      put: async () => ({ ok: false, retryable: true, error: { kind: "NETWORK", message: "down", httpStatus: null, at: 0 } }),
    });
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(1600);
    await s.until(() => s.errors.length >= 1);
    // Act / Assert
    await expect(s.controller.drainMemoryBacklog()).rejects.toThrow("The database connection is closing.");
    expect(s.controller.memoryBacklogCount).toBe(1);
  });

  it("メモリ待機中の Chunk を WAV として書き出せる（書き出してもメモリ待機からは外さない）", async () => {
    // Arrange
    const s = await setup(closedStore);
    await s.controller.start("m1", "定例", 1);
    s.worklet.sendChunk(1600);
    await s.until(() => s.errors.length >= 1);
    // Act
    const files = s.controller.exportMemoryBacklog();
    // Assert：ファイル名に使えない ":" を含む chunkKey ではなく、会議・source・連番から名前を作る
    expect(files.map((f) => f.fileName)).toEqual(["m1_mic_000000.wav"]);
    expect(files[0]?.meta.sequenceNo).toBe(0);
    expect(files[0]?.wav.type).toBe("audio/wav");
    expect(s.controller.memoryBacklogCount).toBe(1);
  });

  it("Worklet の ready が報告するレートと AudioContext のレートが異なれば onError", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.worklet.port.postMessage({ type: "ready", nativeSampleRate: 44100, renderQuantum: 128 });
    await s.until(() => s.errors.length >= 1);
    expect(s.errors[0]?.message).toContain("sampleRate mismatch");
  });

  it("Mic トラック終了で MIC_TRACK_ENDED が degradedReasons に入る", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.track.dispatchEvent(new Event("ended"));
    expect(s.health.degradedReasons).toContain("MIC_TRACK_ENDED");
  });

  it("stop 後に届いた ended は MIC_TRACK_ENDED を入れない", async () => {
    // Arrange：停止済みの会議。health は次の録音に引き継がれうる
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    await s.controller.stop();
    // Act
    s.track.dispatchEvent(new Event("ended"));
    // Assert
    expect(s.health.degradedReasons).toEqual([]);
  });

  it("ended が複数回届いても MIC_TRACK_ENDED は 1 件だけ", async () => {
    const s = await setup();
    await s.controller.start("m1", "定例", 1);
    s.track.dispatchEvent(new Event("ended"));
    s.track.dispatchEvent(new Event("ended"));
    expect(s.health.degradedReasons).toEqual(["MIC_TRACK_ENDED"]);
  });
});
