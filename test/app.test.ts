import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_TOKEN_KEY, createApp, type App, type AppEvent, type SessionController } from "../src/app/app";
import { tryAcquireMeetingLock } from "../src/recording/meeting-lock";
import type { MemoryBacklogFile, RecordingControllerDeps } from "../src/recording/recording-controller";
import { ChunkStore, MeetingStore, openDatabase, SettingsStore } from "../src/storage/idb";
import type { AudioChunkRecord, MeetingRecord } from "../src/types/recording";
import { BASE_URL, FakeLocalServer, FakeLockManager, makeChunkRecord, TOKEN } from "./harness";

/** RecordingController の代わり。start / stop は本物と同じく会議レコードの状態だけを書く */
class FakeController implements SessionController {
  memoryBacklogCount = 0;
  drainCount = 0;
  drainError: Error | null = null;
  audioFrameCount = 0;
  constructor(
    readonly deps: RecordingControllerDeps,
    private readonly log: string[],
  ) {}
  async start(meetingId: string, title: string, consentConfirmedAt: number): Promise<void> {
    await this.deps.meetingStore.put({ ...makeMeeting(meetingId, "recording"), title, consentConfirmedAt });
    this.log.push("start");
  }
  async stop(): Promise<void> {
    const meeting = this.meetingId === null ? undefined : await this.deps.meetingStore.get(this.meetingId);
    if (meeting !== undefined) {
      meeting.status = "stop_requested";
      meeting.sessionClock.audioFrameCount = this.audioFrameCount;
      await this.deps.meetingStore.put(meeting);
    }
    this.log.push("stop");
  }
  async flush(): Promise<void> {
    this.log.push("flush");
  }
  async drainMemoryBacklog(): Promise<number> {
    this.drainCount++;
    if (this.drainError !== null) throw this.drainError;
    return 0;
  }
  exportMemoryBacklog(): MemoryBacklogFile[] {
    return [];
  }
  private get meetingId(): string | null {
    return this.log.includes("start") ? currentMeetingId : null;
  }
}

let currentMeetingId = "";
let meetingSeq = 0;
/** fake-indexeddb の共有対策で、会議 ID はテストごとに変える */
function nextMeetingId(): string {
  currentMeetingId = `m-app-${meetingSeq++}`;
  return currentMeetingId;
}

function makeMeeting(meetingId: string, status: MeetingRecord["status"], audioFrameCount = 0): MeetingRecord {
  return {
    meetingId,
    title: "t",
    status,
    sessionClock: { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount },
    consentConfirmedAt: 1,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    finalChunkCount: null,
  };
}

interface Setup {
  app: App;
  db: IDBDatabase;
  server: FakeLocalServer;
  locks: FakeLockManager;
  events: AppEvent[];
  log: string[];
  controllers: FakeController[];
  status: (chunkKey: string) => Promise<AudioChunkRecord["save"]["status"] | undefined>;
}

let apps: App[] = [];

interface SetupOptions {
  token?: string | null;
  serverUp?: boolean;
  seed?: (db: IDBDatabase, server: FakeLocalServer, locks: FakeLockManager) => Promise<void>;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const db = await openDatabase(new IDBFactory());
  const server = new FakeLocalServer();
  server.up = options.serverUp ?? true;
  const locks = new FakeLockManager();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) await new SettingsStore(db).set(BACKEND_TOKEN_KEY, token);
  await options.seed?.(db, server, locks);
  const events: AppEvent[] = [];
  const log: string[] = [];
  const controllers: FakeController[] = [];
  const app = await createApp({
    db,
    baseUrl: BASE_URL,
    workletModuleUrl: "/worklet.js",
    locks,
    onEvent: (e) => events.push(e),
    fetchImpl: server.fetch,
    setTimer: () => undefined,
    createController: (deps) => {
      const c = new FakeController(deps, log);
      controllers.push(c);
      return c;
    },
  });
  apps.push(app);
  const status = async (chunkKey: string) => (await app.chunkStore.getChunk(chunkKey))?.save.status;
  return { app, db, server, locks, events, log, controllers, status };
}

/** Chunk を指定した保存状態で IDB に置く */
async function seedChunk(db: IDBDatabase, meetingId: string, seq: number, status: AudioChunkRecord["save"]["status"]): Promise<AudioChunkRecord> {
  const r = await makeChunkRecord(meetingId, seq, 160);
  r.save.status = status;
  await new ChunkStore(db).putChunk(r);
  return r;
}

async function seedMeeting(db: IDBDatabase, meeting: MeetingRecord): Promise<void> {
  await new MeetingStore(db).put(meeting);
}

/** サーバーに登録済みの状態を作る（FakeLocalServer が PUT で記録するのと同じ形） */
function registerOnServer(server: FakeLocalServer, r: AudioChunkRecord): void {
  server.stored.set(r.chunkKey, { sha256: r.meta.sha256, sizeBytes: r.meta.sizeBytes });
}

function startInput(meetingId: string) {
  return { audioContext: {} as AudioContext, mediaStream: {} as MediaStream, meetingId, title: "定例", consentConfirmedAt: 1 };
}

function stubPageGlobals(): EventTarget & { hide: () => void } {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  return Object.assign(win, {
    hide: () => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  });
}

afterEach(() => {
  for (const app of apps) app.dispose();
  apps = [];
  vi.unstubAllGlobals();
});

describe("createApp（起動時の配線）", () => {
  it("起動時に中断された会議の未保存 Chunk を再送し、recovered を通知する", async () => {
    // Arrange：録音中のまま落ちた会議と、PUT 中に落ちた Chunk
    const meetingId = nextMeetingId();
    const s = await setup({
      seed: async (db) => {
        await seedMeeting(db, makeMeeting(meetingId, "recording"));
        await seedChunk(db, meetingId, 0, "SAVING");
      },
    });
    // Assert
    const recovered = s.events.find((e) => e.type === "recovered");
    expect(recovered?.type === "recovered" && recovered.report.interruptedMeetings.map((m) => m.meetingId)).toEqual([meetingId]);
    await vi.waitFor(async () => expect(await s.status(`${meetingId}:mic:000000`)).toBe("DB_REGISTERED"));
  });

  it("トークン未設定なら BACKEND_UNAVAILABLE で待機し、setToken 後に保存する", async () => {
    // Arrange
    const meetingId = nextMeetingId();
    const s = await setup({ token: null, seed: (db) => seedChunk(db, meetingId, 0, "LOCAL_SAVE_PENDING").then(() => undefined) });
    const key = `${meetingId}:mic:000000`;
    await vi.waitFor(async () => expect(await s.status(key)).toBe("BACKEND_UNAVAILABLE"));
    expect(s.server.putCount).toBe(0);
    // Act
    await s.app.setToken(TOKEN);
    // Assert
    await vi.waitFor(async () => expect(await s.status(key)).toBe("DB_REGISTERED"));
  });

  it("空のトークンは保存しない", async () => {
    const s = await setup({ token: null });
    await expect(s.app.setToken("")).rejects.toThrow("token is empty");
  });

  it("PUT の接続不能で Monitor が UNREACHABLE になり、ヘルス復帰で待機中の Chunk を送り直す", async () => {
    // Arrange：起動時は HEALTHY。録音中にサーバーが落ちる
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "IDB_STORED");
    s.server.up = false;
    // Act
    await s.controllers[0].deps.scheduler.enqueue(r.chunkKey);
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("BACKEND_UNAVAILABLE"));
    // Assert
    expect(s.app.monitor.state.status).toBe("UNREACHABLE");
    s.server.up = true;
    await s.app.monitor.checkOnce();
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("DB_REGISTERED"));
  });

  it("PUT が 401 なら Monitor を unauthorized にする", async () => {
    // Arrange：保存済みのトークンが古い
    const meetingId = nextMeetingId();
    const s = await setup({ token: "stale", seed: (db) => seedChunk(db, meetingId, 0, "LOCAL_SAVE_PENDING").then(() => undefined) });
    // Assert
    await vi.waitFor(() => expect(s.app.monitor.state.unauthorized).toBe(true));
    expect(s.app.health.degradedReasons).toContain("BACKEND_UNAUTHORIZED");
  });

  it("ヘルス復帰時に stop_requested の会議の finalize を再試行し、別タブがロックを持つ会議には触らない", async () => {
    // Arrange：サーバー停止中に止めた会議 2 件。片方は別タブが保持している
    const free = nextMeetingId();
    const locked = nextMeetingId();
    const s = await setup({
      serverUp: false,
      seed: async (db, server, locks) => {
        for (const id of [free, locked]) {
          const r = await seedChunk(db, id, 0, "DB_REGISTERED");
          registerOnServer(server, r);
          await seedMeeting(db, makeMeeting(id, "stop_requested", r.meta.endFrame));
        }
        await tryAcquireMeetingLock(locks, locked);
      },
    });
    expect(s.app.monitor.state.status).toBe("UNREACHABLE");
    // Act
    s.server.up = true;
    await s.app.monitor.checkOnce();
    // Assert
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(free))?.status).toBe("finalized"));
    expect(s.events).toContainEqual({ type: "finalized", meetingId: free });
    expect((await s.app.meetingStore.get(locked))?.status).toBe("stop_requested");
  });
});

describe("startRecording（録音ごとの配線）", () => {
  it("Chunk の enqueue ごとにクォータを確認し、95% 以上で削除できる Blob がなければ export_required を通知する", async () => {
    // Arrange：サーバー停止中で Chunk は DB_REGISTERED にならない
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 970, quota: 1_000 }) } });
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "IDB_STORED");
    // Act
    await s.controllers[0].deps.scheduler.enqueue(r.chunkKey);
    // Assert
    await vi.waitFor(() => expect(s.events).toContainEqual({ type: "export_required", meetingId }));
    expect(s.app.health.degradedReasons).toContain("IDB_QUOTA_WARNING");
  });

  it("クォータ縮退で Blob を消したとき、メモリ待機があれば drain する", async () => {
    // Arrange：1 回目の見積もりは 90%、Blob を 1 件消すと 70%
    const ratios = [0.9, 0.7];
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: (ratios.length > 1 ? (ratios.shift() as number) : ratios[0]) * 1_000, quota: 1_000 }) } });
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    await seedChunk(s.db, meetingId, 0, "DB_REGISTERED");
    const r = await seedChunk(s.db, meetingId, 1, "IDB_STORED");
    s.controllers[0].memoryBacklogCount = 1;
    // Act
    await s.controllers[0].deps.scheduler.enqueue(r.chunkKey);
    // Assert
    await vi.waitFor(() => expect(s.controllers[0].drainCount).toBe(1));
    expect((await s.app.chunkStore.getChunk(`${meetingId}:mic:000000`))?.wav).toBeNull();
  });

  it("IDB_WRITE_FAILED の onError で drain し、失敗したら memory_backlog_export_required を通知する", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const c = s.controllers[0];
    const error = new Error("server down");
    c.drainError = error;
    s.app.health.degradedReasons = [...s.app.health.degradedReasons, "IDB_WRITE_FAILED"];
    // Act
    c.deps.onError(new Error("InvalidStateError"));
    // Assert
    await vi.waitFor(() => expect(s.events).toContainEqual({ type: "memory_backlog_export_required", meetingId, error }));
    expect(c.drainCount).toBe(1);
  });

  it.each([null, "stale"])("録音中に setToken したら、直接送信（directSaver）も新しいトークンで送る（開始時のトークン: %s）", async (initial) => {
    // Arrange：トークン未設定・古いトークンのまま録音を始める
    stubPageGlobals();
    const s = await setup({ token: initial });
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const r = await makeChunkRecord(meetingId, 0, 160);
    // Act
    await s.app.setToken(TOKEN);
    const outcome = await s.controllers[0].deps.directSaver?.put(r);
    // Assert
    expect(outcome).toMatchObject({ ok: true, registered: true });
  });

  it("IDB_WRITE_FAILED でない onError では drain しない", async () => {
    stubPageGlobals();
    const s = await setup();
    await s.app.startRecording(startInput(nextMeetingId()));
    const c = s.controllers[0];
    c.deps.onError(new Error("worklet sample rate mismatch"));
    expect(s.events.some((e) => e.type === "error")).toBe(true);
    expect(c.drainCount).toBe(0);
  });

  it("録音中に 2 本目の録音は始められない", async () => {
    stubPageGlobals();
    const s = await setup();
    await s.app.startRecording(startInput(nextMeetingId()));
    await expect(s.app.startRecording(startInput(nextMeetingId()))).rejects.toThrow("already recording");
  });
});

describe("RecordingSession.stop", () => {
  it("stop → ページライフサイクルの解除 → finalize の順に進み、末尾の欠けを finalized で通知する", async () => {
    // Arrange：保存済みの Chunk より 2 秒ぶん長く録音していた（Worklet の stop 無応答など）
    const win = stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    const onHidden = vi.fn();
    const session = await s.app.startRecording({ ...startInput(meetingId), onHidden });
    const r = await seedChunk(s.db, meetingId, 0, "DB_REGISTERED");
    registerOnServer(s.server, r);
    s.controllers[0].audioFrameCount = r.meta.endFrame + 32_000;
    // Act
    const result = await session.stop();
    win.dispatchEvent(new Event("pagehide"));
    win.hide();
    // Assert：解除後は pagehide で flush せず、hidden も通知しない
    expect(result.ok).toBe(true);
    expect(s.log).toEqual(["start", "stop"]);
    expect(onHidden).not.toHaveBeenCalled();
    expect(s.app.currentSession).toBeNull();
    const finalized = s.events.find((e) => e.type === "finalized");
    expect(finalized?.type === "finalized" && finalized.missingTailMs).toBeGreaterThan(0);
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("finalized");
  });

  it("録音中は pagehide で flush し、hidden を onHidden に通知する", async () => {
    const win = stubPageGlobals();
    const s = await setup();
    const onHidden = vi.fn();
    await s.app.startRecording({ ...startInput(nextMeetingId()), onHidden });
    win.dispatchEvent(new Event("pagehide"));
    win.hide();
    expect(s.log).toEqual(["start", "flush"]);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("メモリ待機が残っていれば Barrier を通さず waiting_local_save を返す", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    const session = await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "DB_REGISTERED");
    registerOnServer(s.server, r);
    s.controllers[0].audioFrameCount = r.meta.endFrame;
    s.controllers[0].memoryBacklogCount = 1;
    // Act
    const result = await session.stop();
    // Assert
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("stop_requested");
  });

  it("トークン未設定なら finalize せず waiting_local_save を返す", async () => {
    stubPageGlobals();
    const s = await setup({ token: null });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    const result = await session.stop();
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
  });
});
