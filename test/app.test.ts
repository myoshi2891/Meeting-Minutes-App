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
  wrapFetch?: (fetchImpl: typeof fetch) => typeof fetch;
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
    fetchImpl: options.wrapFetch?.(server.fetch) ?? server.fetch,
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
  if (await new MeetingStore(db).get(meetingId) === undefined) await new MeetingStore(db).put(makeMeeting(meetingId, "recording"));
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
  vi.restoreAllMocks();
});

describe("createApp（起動時の配線）", () => {
  it.each([401, 403])("Chunk がなくても一覧の %s を認証エラーとして表示し、トークン修正後に回復する", async (status) => {
    stubPageGlobals();
    const s = await setup({ token: "stale", wrapFetch: (fetchImpl) => async (input, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (String(input).endsWith("/chunks") && auth !== `Bearer ${TOKEN}`) return new Response(null, { status });
      if (String(input).endsWith("/health") && auth === `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ status: "ok", service: "minutes-local", capabilities: { localSave: true, localTranscribe: false, localSummarize: false } }));
      }
      return fetchImpl(input, init);
    } });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    await session.stop();
    expect(s.app.monitor.state.unauthorized).toBe(true);
    await s.app.setToken(TOKEN);
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(session.meetingId))?.status).toBe("finalized"));
    expect(s.app.monitor.state.unauthorized).toBe(false);
  });

  it("直接送信の会議登録 401 も Monitor に伝える", async () => {
    stubPageGlobals();
    const s = await setup({ token: "stale" });
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    await s.controllers[0].deps.directSaver!.put(await makeChunkRecord(id, 0, 160));
    expect(s.app.monitor.state.unauthorized).toBe(true);
  });

  it("未登録会議は登録してから PUT し、起動時復旧にも同じ順序を使う", async () => {
    const meetingId = nextMeetingId();
    const s = await setup({ seed: (db) => seedChunk(db, meetingId, 0, "SAVING").then(() => undefined) });
    s.server.requireMeetingRegistration = true;
    await vi.waitFor(async () => expect(await s.status(`${meetingId}:mic:000000`)).toBe("DB_REGISTERED"));
    expect(s.server.requests.indexOf(`POST:${meetingId}`)).toBeLessThan(s.server.requests.indexOf(`PUT:${meetingId}`));
  });
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

  it.each(["サーバーのトークン", "abc\u200bdef", "abc def"])("ヘッダーに使えない文字を含むトークン（%j）は保存せず、保存済みの値も変えない", async (bad) => {
    // Arrange
    const s = await setup();
    // Act
    const saving = s.app.setToken(bad);
    // Assert
    await expect(saving).rejects.toThrow("トークンの形式が正しくありません");
    expect(await new SettingsStore(s.db).get(BACKEND_TOKEN_KEY)).toBe(TOKEN);
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
  it("並行する直接送信は会議登録を1回だけ共有し、登録後に両ChunkをPUTする", async () => {
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    s.server.requireMeetingRegistration = true;
    const [a, b] = await Promise.all([makeChunkRecord(meetingId, 0, 160), makeChunkRecord(meetingId, 1, 160)]);
    const saver = s.controllers[0].deps.directSaver;
    expect(saver).toBeDefined();
    const outcomes = await Promise.all([saver!.put(a), saver!.put(b)]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(s.server.createCount).toBe(1);
    expect(s.server.requests.slice(0, 3)).toEqual([`POST:${meetingId}`, `PUT:${meetingId}`, `PUT:${meetingId}`]);
  });

  it("会議登録の接続失敗後は再試行でき、IDB読取失敗時も開始時の会議情報で直接送信する", async () => {
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const record = await makeChunkRecord(meetingId, 0, 160);
    s.server.requireMeetingRegistration = true;
    const saver = s.controllers[0].deps.directSaver!;
    s.server.up = false;
    expect(await saver.put(record)).toMatchObject({ ok: false, retryable: true, error: { kind: "NETWORK" } });
    s.server.up = true;
    vi.spyOn(s.app.meetingStore, "get").mockRejectedValue(new Error("IDB unavailable"));
    expect(await saver.put(record)).toMatchObject({ ok: true, registered: true });
  });
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

  it("開始処理の完了前に別会議の録音を始めようとしたら拒否する", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    // Act：1 本目の await 中に 2 本目を呼ぶ
    const first = s.app.startRecording(startInput(nextMeetingId()));
    const second = s.app.startRecording(startInput(nextMeetingId()));
    // Assert
    await expect(second).rejects.toThrow("already recording");
    await expect(first).resolves.toBeDefined();
    expect(s.controllers).toHaveLength(1);
  });

  it("開始に失敗しても、次の録音は始められる", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    vi.spyOn(FakeController.prototype, "start").mockRejectedValueOnce(new Error("mic denied"));
    await expect(s.app.startRecording(startInput(nextMeetingId()))).rejects.toThrow("mic denied");
    // Act
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    // Assert
    expect(s.app.currentSession).toBe(session);
  });
});

describe("確定待ちの会議（listPendingFinalize / retryFinalize）", () => {
  it("停止からの確定 POST 実行中は中止できず、完了状態を上書きしない", async () => {
    stubPageGlobals();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const postStarted = new Promise<void>((r) => { reached = r; });
    const s = await setup({ wrapFetch: (fetchImpl) => async (input, init) => {
      if (String(input).endsWith("/finalize")) { reached(); await gate; }
      return fetchImpl(input, init);
    } });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    const stopping = session.stop();
    await postStarted;
    await expect(s.app.abandonFinalize(session.meetingId, true)).rejects.toThrow("使用中");
    release();
    expect(await stopping).toMatchObject({ ok: true });
    await expect(s.app.abandonFinalize(session.meetingId, true)).rejects.toThrow("確定待ち");
    expect((await s.app.meetingStore.get(session.meetingId))?.status).toBe("finalized");
  });

  it("確定中止はデータを残し、再起動・復帰後の再送と確定から除外する", async () => {
    const id = nextMeetingId();
    const s = await setup({ serverUp: false, seed: async (db) => {
      await seedChunk(db, id, 0, "SAVING");
      await seedMeeting(db, makeMeeting(id, "stop_requested"));
    } });
    await s.app.abandonFinalize(id, true);
    expect((await s.app.meetingStore.get(id))?.status).toBe("abandoned");
    expect((await s.app.chunkStore.getChunk(`${id}:mic:000000`))?.wav).not.toBeNull();
    expect(await s.app.listPendingFinalize()).toEqual([]);
    // 同じ DB で再起動する。中止会議を復旧・自動再送に含めない。
    s.app.dispose();
    const restarted = await createApp({ db: s.db, baseUrl: BASE_URL, workletModuleUrl: "/worklet.js", locks: s.locks,
      onEvent: (e) => s.events.push(e), fetchImpl: s.server.fetch, setTimer: () => undefined });
    apps.push(restarted);
    s.server.up = true;
    await restarted.setToken(TOKEN);
    expect(s.server.putCount).toBe(0);
    expect(await restarted.listPendingFinalize()).toEqual([]);
    expect((await restarted.meetingStore.get(id))?.status).toBe("abandoned");
    expect(await restarted.retryFinalize(id)).toMatchObject({ ok: false, stage: "verify" });
  });

  it("確認なし・録音中・別タブロック中は確定中止しない", async () => {
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    await expect(s.app.abandonFinalize(id, true)).rejects.toThrow();
    await session.stop();
    await expect(s.app.abandonFinalize(id, false)).rejects.toThrow();
    const release = await tryAcquireMeetingLock(s.locks, id);
    await expect(s.app.abandonFinalize(id, true)).rejects.toThrow();
    release?.();
    expect((await s.app.meetingStore.get(id))?.status).toBe("stop_requested");
  });

  it("自動確定の失敗を会議ごとに通知し、同じ失敗を重複通知しない", async () => {
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    s.controllers[0].memoryBacklogCount = 1;
    await session.stop();
    await s.app.retryFinalize(session.meetingId);
    expect(s.events.filter((e) => e.type === "finalize_pending")).toHaveLength(1);
    expect(s.app.getFinalizeIssue(session.meetingId)).toMatchObject({ stage: "waiting_local_save" });
  });

  it("stop_requested と finalizing の会議だけを確定待ちとして返す", async () => {
    // Arrange
    const [stopped, finalizing, done] = [nextMeetingId(), nextMeetingId(), nextMeetingId()];
    const s = await setup({
      serverUp: false,
      seed: async (db) => {
        await seedMeeting(db, makeMeeting(stopped, "stop_requested"));
        await seedMeeting(db, makeMeeting(finalizing, "finalizing"));
        await seedMeeting(db, makeMeeting(done, "finalized"));
      },
    });
    // Act
    const pending = await s.app.listPendingFinalize();
    // Assert
    expect(pending.map((m) => m.meetingId).sort()).toEqual([stopped, finalizing].sort());
  });

  it("retryFinalize はサーバーに揃っていれば会議を確定し、finalized を通知する", async () => {
    // Arrange：サーバー停止中に止めた会議。後からサーバーが起動した
    const meetingId = nextMeetingId();
    const s = await setup({
      serverUp: false,
      seed: async (db, server) => {
        const r = await seedChunk(db, meetingId, 0, "DB_REGISTERED");
        registerOnServer(server, r);
        await seedMeeting(db, makeMeeting(meetingId, "stop_requested", r.meta.endFrame));
      },
    });
    s.server.up = true;
    // Act
    const result = await s.app.retryFinalize(meetingId);
    // Assert
    expect(result.ok).toBe(true);
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("finalized");
    expect(s.events).toContainEqual({ type: "finalized", meetingId });
  });

  it("retryFinalize は別タブがロックを持つ会議に触らない", async () => {
    // Arrange
    const meetingId = nextMeetingId();
    const s = await setup({
      serverUp: false,
      seed: async (db, server, locks) => {
        const r = await seedChunk(db, meetingId, 0, "DB_REGISTERED");
        registerOnServer(server, r);
        await seedMeeting(db, makeMeeting(meetingId, "stop_requested", r.meta.endFrame));
        await tryAcquireMeetingLock(locks, meetingId);
      },
    });
    s.server.up = true;
    // Act
    const result = await s.app.retryFinalize(meetingId);
    // Assert
    expect(result).toMatchObject({ ok: false, stage: "verify" });
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("stop_requested");
  });
});

describe("RecordingSession.stop", () => {
  it("マイク切断だけで停止し、取得済み音声を確定する", async () => {
    stubPageGlobals();
    const s = await setup();
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    const r = await seedChunk(s.db, id, 0, "DB_REGISTERED");
    registerOnServer(s.server, r);
    s.controllers[0].audioFrameCount = r.meta.endFrame;
    s.controllers[0].deps.onMicEnded?.();
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(id))?.status).toBe("finalized"));
    expect(s.log.filter((x) => x === "stop")).toHaveLength(1);
    expect(s.app.currentSession).toBeNull();
  });

  it("マイク切断と手動停止が重なっても一度だけ停止し、保存不能なら書き出しを通知する", async () => {
    stubPageGlobals();
    const s = await setup();
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    s.controllers[0].memoryBacklogCount = 1;
    s.controllers[0].deps.onMicEnded?.();
    s.controllers[0].deps.onMicEnded?.();
    await session.stop();
    expect(s.log.filter((x) => x === "stop")).toHaveLength(1);
    expect(s.app.currentSession).toBeNull();
    expect(s.events.filter((e) => e.type === "recording_stopped")).toEqual([{ type: "recording_stopped", meetingId: session.meetingId, reason: "mic_ended" }]);
    expect(s.events.some((e) => e.type === "memory_backlog_export_required")).toBe(true);
  });

  it("照合不一致による再送完了で確定と再送を繰り返さない", async () => {
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    const session = await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "DB_REGISTERED");
    registerOnServer(s.server, r);
    const list = s.app.chunkStore.listByMeeting.bind(s.app.chunkStore);
    let reads = 0;
    vi.spyOn(s.app.chunkStore, "listByMeeting").mockImplementation(async (...args) => {
      const chunks = await list(...args);
      // バグがあっても無限に回さず、3 回目以降は通常応答に戻す。
      return ++reads <= 2 ? chunks.map((c) => ({ ...c, meta: { ...c.meta, sha256: "0".repeat(64) } })) : chunks;
    });
    await session.stop();
    await vi.waitFor(() => {
      expect(s.server.putCount).toBeGreaterThan(0);
      expect(s.app.scheduler.pendingCount).toBe(0);
    });
    expect(reads).toBe(1);
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("stop_requested");
  });

  it.each([false, true])("末尾 PUT 完了で自動確定する（Barrier 実行中の完了: %s）", async (duringBarrier) => {
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    const session = await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "IDB_STORED");
    s.controllers[0].audioFrameCount = r.meta.endFrame;
    // PUT の完了を制御し、停止時には必ず未登録の Chunk を残す。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const update = s.app.chunkStore.updateSaveState.bind(s.app.chunkStore);
    vi.spyOn(s.app.chunkStore, "updateSaveState").mockImplementation(async (key, change) => {
      const probe = await s.app.chunkStore.getChunk(key);
      if (probe) {
        change(probe);
        if (probe.save.status === "DB_REGISTERED") await gate;
      }
      return update(key, change);
    });
    await s.app.scheduler.enqueue(r.chunkKey);
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("SAVING"));
    if (duringBarrier) {
      const resume = s.app.scheduler.resumeAll.bind(s.app.scheduler);
      vi.spyOn(s.app.scheduler, "resumeAll").mockImplementationOnce(async () => {
        release();
        await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("DB_REGISTERED"));
        await resume();
      });
    }
    const result = await session.stop();
    if (!duringBarrier) {
      expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
      release();
    }
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(meetingId))?.status).toBe("finalized"));
    expect(s.events.filter((e) => e.type === "finalized" && e.meetingId === meetingId)).toHaveLength(1);
    expect(await s.app.listPendingFinalize()).toEqual([]);
  });

  it("録音中の Chunk 保存完了では自動確定しない", async () => {
    stubPageGlobals();
    const s = await setup();
    const meetingId = nextMeetingId();
    await s.app.startRecording(startInput(meetingId));
    const r = await seedChunk(s.db, meetingId, 0, "IDB_STORED");
    await s.app.scheduler.enqueue(r.chunkKey);
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("DB_REGISTERED"));
    expect((await s.app.meetingStore.get(meetingId))?.status).toBe("recording");
    expect(s.events.filter((e) => e.type === "finalized")).toEqual([]);
  });

  it.each(["normal", "locked", "memory"])("サーバー復帰後の複数 Chunk 保存は Barrier とロックを守る（%s）", async (mode) => {
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const meetingId = nextMeetingId();
    const session = await s.app.startRecording(startInput(meetingId));
    for (let seq = 0; seq < 2; seq++) {
      const r = await seedChunk(s.db, meetingId, seq, "IDB_STORED");
      await s.app.scheduler.enqueue(r.chunkKey);
      s.controllers[0].audioFrameCount = r.meta.endFrame;
    }
    if (mode === "memory") s.controllers[0].memoryBacklogCount = 1;
    expect(await session.stop()).toMatchObject({ ok: false, stage: "waiting_local_save" });
    const release = mode === "locked" ? await tryAcquireMeetingLock(s.locks, meetingId) : null;
    s.server.up = true;
    await s.app.monitor.checkOnce();
    await vi.waitFor(async () => {
      for (const r of await s.app.chunkStore.listByMeeting(meetingId, "mic")) expect(r.save.status).toBe("DB_REGISTERED");
      expect(s.app.scheduler.pendingCount).toBe(0);
    });
    if (mode === "normal") {
      await vi.waitFor(async () => expect((await s.app.meetingStore.get(meetingId))?.status).toBe("finalized"));
      expect(s.events.filter((e) => e.type === "finalized")).toHaveLength(1);
    } else {
      expect((await s.app.meetingStore.get(meetingId))?.status).toBe("stop_requested");
      expect(s.events.filter((e) => e.type === "finalized")).toEqual([]);
    }
    release?.();
  });

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
