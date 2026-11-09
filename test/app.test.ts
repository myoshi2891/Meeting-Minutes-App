import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSaver } from "../src/api/local-saver";
import { BACKEND_TOKEN_KEY, createApp, type App, type AppEvent, type SessionController } from "../src/app/app";
import { tryAcquireMeetingLock } from "../src/recording/meeting-lock";
import type { MemoryBacklogFile, RecordingControllerDeps } from "../src/recording/recording-controller";
import { ChunkStore, MeetingStore, openDatabase, SettingsStore } from "../src/storage/idb";
import type { AudioChunkRecord, MeetingRecord, RecordingStopReason } from "../src/types/recording";
import { BASE_URL, FakeLocalServer, FakeLockManager, makeChunkRecord, TOKEN } from "./harness";

/** RecordingController の代わり。start / stop は本物と同じく会議レコードの状態だけを書く */
class FakeController implements SessionController {
  memoryBacklogCount = 0;
  drainCount = 0;
  drainError: Error | null = null;
  /** drainMemoryBacklog の成功時の副作用（直接送信でメモリ待機が空になる等） */
  drainEffect: (() => void) | null = null;
  /** 実データのメモリ待機。空でなければ drainMemoryBacklog は本物と同じく directSaver で直接送る */
  readonly backlog: AudioChunkRecord[] = [];
  audioFrameCount = 0;
  private heldLock: (() => void) | null = null;
  constructor(
    readonly deps: RecordingControllerDeps,
    private readonly log: string[],
  ) {}
  /** 本物と同じく、録音開始から停止まで会議ロックを持つ */
  private lock: (() => void) | null = null;
  /** 本物と同じく、開始時に作った会議レコードを持ち続け、App にも同じオブジェクトを渡す */
  private meeting: MeetingRecord | null = null;
  async start(meetingId: string, title: string, consentConfirmedAt: number): Promise<void> {
    this.lock = await tryAcquireMeetingLock(this.deps.locks, meetingId);
    if (this.lock === null) throw new Error(`meeting ${meetingId} is already being recorded`);
    const meeting: MeetingRecord = { ...makeMeeting(meetingId, "recording"), title, consentConfirmedAt };
    this.meeting = meeting;
    this.deps.onMeetingCreated?.(meeting);
    await this.deps.meetingStore.put(meeting);
    this.log.push("start");
  }
  /** 本物と同じ順序：stop_requested と停止理由を書く（失敗しても続ける）→ flush で audioFrameCount が進む → 最終保存（失敗は reject） */
  async stop(reason: RecordingStopReason = "manual", detectedAtEpochMs = 0): Promise<void> {
    let finalSaved = false;
    try {
      const meeting = this.meeting;
      if (meeting !== null) {
        if (meeting.stopReason === undefined) {
          meeting.stopReason = reason;
          meeting.stopDetectedAtEpochMs = detectedAtEpochMs;
        }
        meeting.status = "stop_requested";
        await this.deps.meetingStore.put(meeting).catch(() => undefined);
        meeting.sessionClock.audioFrameCount = this.audioFrameCount;
        meeting.updatedAt = Date.now();
        await this.deps.meetingStore.put(meeting);
      }
      finalSaved = true;
    } finally {
      // 本物と同じく、メモリ待機が残るか最終保存に失敗したら会議ロックを持ったまま止まり、そうでなければ解放する
      if (this.memoryBacklogCount > 0 || !finalSaved) this.heldLock = this.lock;
      else this.lock?.();
      this.lock = null;
      this.log.push("stop");
    }
  }
  takeMeetingLock(): (() => void) | null {
    const release = this.heldLock;
    this.heldLock = null;
    return release;
  }
  async flush(): Promise<void> {
    this.log.push("flush");
  }
  async drainMemoryBacklog(): Promise<number> {
    this.drainCount++;
    if (this.drainError !== null) throw this.drainError;
    while (this.backlog.length > 0) {
      const outcome = await this.deps.directSaver?.put(this.backlog[0]);
      if (outcome?.ok !== true || !outcome.registered) throw new Error("direct save failed");
      this.backlog.shift();
      this.memoryBacklogCount = this.backlog.length;
    }
    this.drainEffect?.();
    if (this.memoryBacklogCount === 0) this.takeMeetingLock()?.();
    return 0;
  }
  /** 本物と同じく、WAV のある Chunk を会議・source・連番のファイル名で書き出す（メモリ待機からは外さない） */
  exportMemoryBacklog(): MemoryBacklogFile[] {
    return this.backlog.flatMap((r) => {
      if (r.wav === null) return [];
      const { meetingId, source, sequenceNo } = r.meta;
      return [{ fileName: `${meetingId}_${source}_${sequenceNo.toString().padStart(6, "0")}.wav`, wav: r.wav, meta: r.meta }];
    });
  }
}

let meetingSeq = 0;
/** fake-indexeddb の共有対策で、会議 ID はテストごとに変える */
function nextMeetingId(): string {
  return `m-app-${meetingSeq++}`;
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

/** Monitor の初回 HEALTHY 通知を済ませる。遅れて届くと onBackendAvailable が別経路で確定を再試行し、検証対象の経路を隠す */
async function settleMonitor(s: Setup): Promise<void> {
  await s.app.monitor.checkOnce();
  // init の初回チェックの通知が checkOnce より後に届く場合に備えて 1 ターン待ち、始まった復旧の IDB 処理の完了まで待つ
  await new Promise((resolve) => setTimeout(resolve, 0));
  await s.app.whenBackendRecoverySettled();
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
    // 会議登録は古いトークンでも通し、一覧だけが %s で弾かれる（一覧の認証エラーを単独で確かめる）
    const staleLists: string[] = [];
    const s = await setup({ token: "stale", wrapFetch: (fetchImpl) => acceptStaleRegistration(async (input, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (String(input).endsWith("/chunks") && auth !== `Bearer ${TOKEN}`) {
        staleLists.push(String(input));
        return new Response(null, { status });
      }
      if (String(input).endsWith("/health") && auth === `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ status: "ok", service: "minutes-local", capabilities: { localSave: true, localTranscribe: false, localSummarize: false } }));
      }
      return fetchImpl(input, init);
    }) });
    // 実サーバーと同じく、未登録の会議の一覧・確定は 404 にする
    s.server.requireMeetingRegistration = true;
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    await session.stop();
    expect(staleLists).toHaveLength(1);
    expect(s.app.monitor.state.unauthorized).toBe(true);
    await s.app.setToken(TOKEN);
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(session.meetingId))?.status).toBe("finalized"));
    expect(s.app.monitor.state.unauthorized).toBe(false);
    const id = session.meetingId;
    expect(s.server.requests.indexOf(`POST:${id}`)).toBeLessThan(s.server.requests.indexOf(`LIST:${id}`));
    expect(s.server.requests.filter((r) => r === `LIST:${id}` || r === `FINALIZE:${id}`).length).toBeGreaterThan(0);
  });



  it("直接送信の会議登録 401 も Monitor に伝える", async () => {
    stubPageGlobals();
    const s = await setup({ token: "stale" });
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    await s.controllers[0].deps.directSaver!.put(await makeChunkRecord(id, 0, 160));
    expect(s.app.monitor.state.unauthorized).toBe(true);
  });

  /** 会議登録だけは古いトークンでも通す（登録後に失効した状況） */
  const acceptStaleRegistration = (fetchImpl: typeof fetch): typeof fetch => async (input, init) => {
    if (!(String(input).endsWith("/v1/meetings") && init?.method === "POST")) return fetchImpl(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    return fetchImpl(input, { ...init, headers });
  };

  it.each([401, 403])("直接送信の PUT が %s なら Monitor に伝える", async (status) => {
    // Arrange：会議登録は通り、PUT だけが失効で弾かれる
    stubPageGlobals();
    const s = await setup({ token: "stale", wrapFetch: (fetchImpl) => acceptStaleRegistration(async (input, init) => {
      if (init?.method === "PUT") return new Response(null, { status });
      return fetchImpl(input, init);
    }) });
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    // Act
    const outcome = await s.controllers[0].deps.directSaver?.put(await makeChunkRecord(id, 0, 160));
    // Assert
    expect(outcome).toMatchObject({ ok: false, error: { kind: "UNAUTHORIZED", httpStatus: status } });
    expect(s.app.monitor.state.unauthorized).toBe(true);
  });

  it("トークン未設定の直接送信は失効として Monitor に伝えない", async () => {
    stubPageGlobals();
    const s = await setup({ token: null });
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    const outcome = await s.controllers[0].deps.directSaver?.put(await makeChunkRecord(id, 0, 160));
    expect(outcome).toMatchObject({ ok: false, error: { kind: "UNAUTHORIZED" } });
    expect(s.app.monitor.state.unauthorized).toBe(false);
  });

  it("古いトークンの PUT が setToken 後に 401 を返しても失効扱いにせず、新しいトークンで送る", async () => {
    // Arrange：古いトークンの PUT の応答待ち中に正しいトークンへ差し替える
    const id = nextMeetingId();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = new Promise<void>((r) => { reached = r; });
    const s = await setup({
      token: "stale",
      seed: async (db) => {
        await seedMeeting(db, makeMeeting(id, "finalized"));
        await seedChunk(db, id, 0, "DB_REGISTERED");
      },
      wrapFetch: (fetchImpl) => acceptStaleRegistration(async (input, init) => {
        const auth = new Headers(init?.headers).get("Authorization");
        if (init?.method === "PUT" && auth === "Bearer stale") { reached(); await gate; }
        if (String(input).endsWith("/health") && auth === `Bearer ${TOKEN}`) {
          return new Response(JSON.stringify({ status: "ok", service: "minutes-local", capabilities: { localSave: true, localTranscribe: false, localSummarize: false } }));
        }
        return fetchImpl(input, init);
      }),
    });
    await settleMonitor(s);
    const key = `${id}:mic:000000`;
    await s.app.scheduler.enqueue(key);
    await held;
    await s.app.setToken(TOKEN);
    // Act
    release();
    // Assert
    await vi.waitFor(async () => expect(await s.status(key)).toBe("DB_REGISTERED"));
    expect(s.app.monitor.state.unauthorized).toBe(false);
  });

  it("ロックを持たない会議の中止判定が PUT 直前に読めなければ、PUT を始めず再試行にする", async () => {
    // Arrange：このタブで録音していない会議（別タブが中止しうる）
    const id = nextMeetingId();
    const s = await setup({ seed: async (db) => {
      await seedMeeting(db, makeMeeting(id, "finalized"));
      await seedChunk(db, id, 0, "DB_REGISTERED");
    } });
    await settleMonitor(s);
    const get = s.app.meetingStore.get.bind(s.app.meetingStore);
    let reads = 0;
    // 1: Scheduler の中止判定、2: 会議登録、3: PUT 直前の中止判定
    vi.spyOn(s.app.meetingStore, "get").mockImplementation(async (meetingId) => {
      if (++reads >= 3) throw new Error("IDB unavailable");
      return get(meetingId);
    });
    const key = `${id}:mic:000000`;
    // Act
    await s.app.scheduler.enqueue(key);
    // Assert
    await vi.waitFor(async () => expect(await s.status(key)).toBe("RETRYING"));
    expect(s.server.putCount).toBe(0);
  });

  it("起動時復旧でロック後の会議の読み取りに失敗しても、起動を止めず他の会議を復旧し、失敗を通知する", async () => {
    // Arrange：録音中のまま落ちた会議が 2 件。片方の読み直しだけ失敗する
    const [a, b] = [nextMeetingId(), nextMeetingId()];
    const get = MeetingStore.prototype.get;
    let failed: string | null = null;
    vi.spyOn(MeetingStore.prototype, "get").mockImplementation(async function (this: MeetingStore, meetingId) {
      if (failed === null && (meetingId === a || meetingId === b)) {
        failed = meetingId;
        throw new Error("IDB read failed");
      }
      return get.call(this, meetingId);
    });
    // Act
    const s = await setup({ seed: async (db) => {
      await seedMeeting(db, makeMeeting(a, "recording"));
      await seedMeeting(db, makeMeeting(b, "recording"));
    } });
    // Assert：読めた会議だけを復旧し、読めなかった会議は検証済みとして扱わない
    const recovered = s.events.find((e) => e.type === "recovered");
    const ok = failed === a ? b : a;
    expect(recovered?.type === "recovered" && recovered.report.interruptedMeetings.map((m) => m.meetingId)).toEqual([ok]);
    expect(recovered?.type === "recovered" && recovered.report.unreadMeetingIds).toEqual([failed]);
    expect((await s.app.meetingStore.get(failed!))?.status).toBe("recording");
    expect(s.events.some((e) => e.type === "error")).toBe(true);
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

  it("Scheduler の PUT 前の会議登録が 401 なら、失効の報告は 1 リクエストにつき 1 回だけ", async () => {
    // Arrange：保存済みのトークンが古く、会議登録で 401 になる
    const meetingId = nextMeetingId();
    const s = await setup({ token: "stale", seed: (db) => seedChunk(db, meetingId, 0, "LOCAL_SAVE_PENDING").then(() => undefined) });
    const report = vi.spyOn(s.app.monitor, "reportUnauthorized");
    // Act
    await vi.waitFor(() => expect(s.app.monitor.state.unauthorized).toBe(true));
    await vi.waitFor(async () => expect(await s.status(`${meetingId}:mic:000000`)).toBe("BACKEND_UNAVAILABLE"));
    // Assert
    expect(s.server.requests.filter((r) => r === `POST:${meetingId}`)).toHaveLength(0);
    expect(report).toHaveBeenCalledOnce();
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

  /** 指定した URL の応答を release まで止める fetch を用意する */
  function holdRequest(match: (url: string, init?: RequestInit) => boolean) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { reached = r; });
    const wrapFetch = (fetchImpl: typeof fetch): typeof fetch => async (input, init) => {
      if (match(String(input), init)) { reached(); await gate; }
      return fetchImpl(input, init);
    };
    return { wrapFetch, started, release };
  }
  const isRegistration = (url: string, init?: RequestInit) => url.endsWith("/v1/meetings") && init?.method === "POST";

  /** Scheduler の送信を match の応答待ちで止めたまま録音を止め、確定を中止する。release() で応答を返す */
  async function abandonWhileRequestHeld(match: (url: string, init?: RequestInit) => boolean) {
    stubPageGlobals();
    const hold = holdRequest(match);
    const s = await setup({ wrapFetch: hold.wrapFetch });
    await s.app.monitor.checkOnce();
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const r = await seedChunk(s.db, id, 0, "IDB_STORED");
    await s.app.scheduler.enqueue(r.chunkKey);
    await hold.started;
    await session.stop();
    await s.app.abandonFinalize(id, true);
    return { s, id, r, release: hold.release };
  }

  it("会議登録の待機中に中止が完了したら Scheduler の PUT を始めず、音声を残す", async () => {
    // Arrange・Act：SAVING に進み、会議登録の応答待ちの間に確定を中止する
    const { s, r, release } = await abandonWhileRequestHeld(isRegistration);
    release();
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("LOCAL_SAVE_FAILED"));
    // Assert
    expect(s.server.putCount).toBe(0);
    expect((await s.app.chunkStore.getChunk(r.chunkKey))?.wav).not.toBeNull();
    expect(s.app.monitor.state.unauthorized).toBe(false);
    expect(s.app.monitor.state.status).toBe("HEALTHY");
  });

  it("会議登録の待機中に中止が完了したら直接送信の PUT を始めない", async () => {
    // Arrange
    stubPageGlobals();
    const hold = holdRequest(isRegistration);
    const s = await setup({ wrapFetch: hold.wrapFetch });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    s.controllers[0].memoryBacklogCount = 1;
    const sending = s.controllers[0].deps.directSaver?.put(await makeChunkRecord(id, 0, 160));
    await hold.started;
    await session.stop();
    // Act
    await s.app.abandonFinalize(id, true);
    hold.release();
    const outcome = await sending;
    // Assert：失敗にするので drainMemoryBacklog は Chunk をメモリ待機に残す
    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(s.server.putCount).toBe(0);
  });

  it("サーバー停止中に確定中止した会議の Chunk は、送信待ちの件数から外す", async () => {
    // Arrange：サーバー停止中に Chunk が待機したまま止めた
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const r = await seedChunk(s.db, id, 0, "IDB_STORED");
    await s.app.scheduler.enqueue(r.chunkKey);
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("BACKEND_UNAVAILABLE"));
    await session.stop();
    expect(s.app.health.pendingChunkCount).toBe(1);
    // Act
    await s.app.abandonFinalize(id, true);
    // Assert：音声は IDB に残す
    expect(s.app.scheduler.pendingCount).toBe(0);
    expect(s.app.health.pendingChunkCount).toBe(0);
    expect((await s.app.chunkStore.getChunk(r.chunkKey))?.wav).not.toBeNull();
  });

  it("このタブで確定中止した会議は、IDB の読み取りに失敗しても直接送信の PUT を始めない", async () => {
    // Arrange：メモリ待機を残して止め、確定を中止した後に IDB が読めなくなる
    stubPageGlobals();
    const s = await setup();
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    s.controllers[0].memoryBacklogCount = 1;
    await session.stop();
    await s.app.abandonFinalize(id, true);
    const putsBefore = s.server.putCount;
    vi.spyOn(s.app.meetingStore, "get").mockRejectedValue(new Error("IDB unavailable"));
    // Act
    const outcome = await s.controllers[0].deps.directSaver?.put(await makeChunkRecord(id, 0, 160));
    // Assert
    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(s.server.putCount).toBe(putsBefore);
  });

  it("IDB の読み取りを待つ間にこのタブで確定中止されたら、ロックを保持していても直接送信の PUT を始めない", async () => {
    // Arrange：メモリ待機を残して止め（ロックを保持）、会議登録は済ませておく
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    s.controllers[0].memoryBacklogCount = 1;
    await session.stop();
    const put = s.controllers[0].deps.directSaver?.put;
    expect(await put?.(await makeChunkRecord(id, 0, 160))).toMatchObject({ ok: true });
    const putsBefore = s.server.putCount;
    // 次の送信で、会議登録の読み取り（1 回目）の後の中止判定の読み取りだけ、中止の完了まで待たせてから失敗させる
    const get = s.app.meetingStore.get.bind(s.app.meetingStore);
    let reads = 0;
    let reading!: () => void;
    const readStarted = new Promise<void>((r) => { reading = r; });
    let fail!: () => void;
    const gate = new Promise<void>((r) => { fail = r; });
    vi.spyOn(s.app.meetingStore, "get").mockImplementation(async (meetingId) => {
      if (++reads !== 2) return get(meetingId);
      reading();
      await gate;
      throw new Error("IDB unavailable");
    });
    const sending = put?.(await makeChunkRecord(id, 1, 160));
    await readStarted;
    // Act
    await s.app.abandonFinalize(id, true);
    fail();
    // Assert
    expect(await sending).toMatchObject({ ok: false, retryable: false });
    expect(s.server.putCount).toBe(putsBefore);
  });

  it("確定中止した会議のメモリ待機は、サーバー復帰時に自動で drain しない（書き出し用に残す）", async () => {
    // Arrange：サーバー停止中にメモリ待機を残して止め、確定を中止した
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 1;
    await session.stop();
    await s.app.abandonFinalize(id, true);
    const drainsBefore = controller.drainCount;
    const eventsBefore = s.events.length;
    // Act：サーバーが使えるようになる
    s.server.up = true;
    await s.app.setToken(TOKEN);
    // Assert
    expect(controller.drainCount).toBe(drainsBefore);
    expect(controller.memoryBacklogCount).toBe(1);
    expect(s.events.slice(eventsBefore).filter((e) => e.type === "memory_backlog_export_required")).toHaveLength(0);
  });

  it("開始済みの PUT は中止後も完了を記録する", async () => {
    // Arrange・Act：PUT の応答待ちの間に確定を中止する
    const { s, id, r, release } = await abandonWhileRequestHeld((url, init) => init?.method === "PUT" && url.includes("/chunks/"));
    release();
    // Assert
    await vi.waitFor(async () => expect(await s.status(r.chunkKey)).toBe("DB_REGISTERED"));
    expect((await s.app.meetingStore.get(id))?.status).toBe("abandoned");
  });

  it("古いトークンの確定が 401 で終わったら、現在のトークンで確定し直す", async () => {
    // Arrange：一覧取得の応答待ち中に setToken される
    stubPageGlobals();
    const hold = holdRequest((url, init) => url.endsWith("/chunks") && new Headers(init?.headers).get("Authorization") === "Bearer stale");
    // 会議登録までは古いトークンも通り、一覧の応答待ち中に失効した状況にする
    const s = await setup({ token: "stale", wrapFetch: (fetchImpl) => hold.wrapFetch(async (input, init) => {
      if (!isRegistration(String(input), init)) return fetchImpl(input, init);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      return fetchImpl(input, { ...init, headers });
    }) });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    const stopping = session.stop();
    await hold.started;
    await s.app.setToken(TOKEN);
    // Act
    hold.release();
    const result = await stopping;
    // Assert
    expect(result).toMatchObject({ ok: true });
    expect((await s.app.meetingStore.get(session.meetingId))?.status).toBe("finalized");
    expect(s.app.monitor.state.unauthorized).toBe(false);
    expect(s.events.filter((e) => e.type === "finalize_pending")).toEqual([]);
  });

  it("確定の会議登録が送り直し中のトークン変更で失敗したら、現在のトークンで確定し直す", async () => {
    // Arrange：会議登録の応答待ちのたびにトークンが変わる（stale → mid → 正しいトークン）
    stubPageGlobals();
    let app: App | undefined;
    const s = await setup({ token: "stale", wrapFetch: (fetchImpl) => async (input, init) => {
      if (isRegistration(String(input), init)) {
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer stale") await app?.setToken("mid");
        else if (auth === "Bearer mid") await app?.setToken(TOKEN);
      }
      return fetchImpl(input, init);
    } });
    app = s.app;
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    // Act
    const result = await session.stop();
    // Assert
    expect(result).toMatchObject({ ok: true });
    expect((await s.app.meetingStore.get(session.meetingId))?.status).toBe("finalized");
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

  /** IDB への会議の書き込みが失敗する間に録音を止める（停止状態を保存できない） */
  async function stopWhileMeetingWritesFail(s: Setup, id: string) {
    const session = await s.app.startRecording(startInput(id));
    const put = vi.spyOn(s.app.meetingStore, "put").mockRejectedValue(new Error("IDB write failed"));
    const result = await session.stop();
    put.mockRestore();
    return result;
  }

  it("停止状態を IDB に書けなかった会議は確定待ちに残し、書けるようになったら停止理由ごと書き直して確定する", async () => {
    // Arrange
    stubPageGlobals();
    // サーバー停止中に始め、Monitor の復帰通知による自動再試行が書き直しを先に済ませて検証対象の retryFinalize を隠さないようにする
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    // Act：停止は reject せず、確定できなかった結果を返す
    const result = await stopWhileMeetingWritesFail(s, id);
    // Assert
    expect(result).toMatchObject({ ok: false });
    expect((await s.app.meetingStore.get(id))?.status).toBe("recording");
    expect((await s.app.listPendingFinalize()).map((m) => m.meetingId)).toContain(id);
    s.server.up = true;
    expect(await s.app.retryFinalize(id)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
    const meeting = await s.app.meetingStore.get(id);
    expect(meeting?.status).toBe("finalized");
    expect(meeting?.stopReason).toBe("manual");
    expect(await s.app.listPendingFinalize()).toEqual([]);
  });

  it("停止状態を IDB に書けなくても、サーバーが使えればメモリ待機の末尾を先に直接送り、確定は書き直すまで止める", async () => {
    // Arrange：サーバーは使える。停止時にメモリ待機が残り、会議の書き込みは失敗し続ける
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 1;
    controller.drainEffect = () => { controller.memoryBacklogCount = 0; };
    // Act：stop は内部で retryFinalize を呼ぶ
    const put = vi.spyOn(s.app.meetingStore, "put").mockRejectedValue(new Error("IDB write failed"));
    const result = await session.stop();
    put.mockRestore();
    // Assert：音声は送り、停止状態を保存するまで確定しない（ロックも保持）
    expect(controller.drainCount).toBe(1);
    expect(s.app.memoryBacklogCount(id)).toBe(0);
    expect(result).toMatchObject({ ok: false, stage: "verify" });
    expect(s.server.requests.filter((r) => r === `FINALIZE:${id}`)).toHaveLength(0);
    expect(s.locks.held.size).toBe(1);
  });

  it("flush 後の最終保存だけに失敗したら、stop_requested の会議に最終の音声フレーム数を書き直してから確定する", async () => {
    // Arrange：stop_requested は書けたが、末尾の Chunk 化でクォータを使い切り、最終保存（audioFrameCount）に失敗した
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    s.controllers[0].audioFrameCount = 1_600;
    const put = s.app.meetingStore.put.bind(s.app.meetingStore);
    let puts = 0;
    const spy = vi.spyOn(s.app.meetingStore, "put").mockImplementation(async (meeting) => {
      if (++puts === 2) throw new DOMException("quota", "QuotaExceededError");
      return put(meeting);
    });
    await session.stop();
    spy.mockRestore();
    // Act
    const result = await s.app.retryFinalize(id);
    // Assert
    expect(result).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
    const meeting = await s.app.meetingStore.get(id);
    expect(meeting?.sessionClock.audioFrameCount).toBe(1_600);
    expect(meeting?.stopReason).toBe("manual");
  });

  it("最終の音声フレーム数を保存できないうちは、別タブから確定させず、自タブで書き直してからロックを解放する", async () => {
    // Arrange：stop_requested は書けたが、最終保存とその直後の書き直しにも失敗した
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    s.controllers[0].audioFrameCount = 1_600;
    const put = s.app.meetingStore.put.bind(s.app.meetingStore);
    let puts = 0;
    const spy = vi.spyOn(s.app.meetingStore, "put").mockImplementation(async (meeting) => {
      if (++puts >= 2) throw new DOMException("quota", "QuotaExceededError");
      return put(meeting);
    });
    expect(await session.stop()).toMatchObject({ ok: false });
    spy.mockRestore();
    const other = await createApp({ db: s.db, baseUrl: BASE_URL, workletModuleUrl: "/worklet.js", locks: s.locks,
      onEvent: () => undefined, setTimer: () => undefined,
      fetchImpl: async (input, init) => String(input).endsWith("/health") ? new Response(null, { status: 503 }) : s.server.fetch(input, init) });
    apps.push(other);
    // Act
    const fromOther = await other.retryFinalize(id);
    // Assert：古い audioFrameCount のまま別タブが確定しない
    expect(fromOther).toMatchObject({ ok: false, stage: "verify" });
    expect(await s.app.retryFinalize(id)).toMatchObject({ ok: true });
    expect((await s.app.meetingStore.get(id))?.sessionClock.audioFrameCount).toBe(1_600);
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
  });

  it("停止状態を書き直す前に別タブが会議を進めていたら、上書きしない", async () => {
    // Arrange：保存できないまま止めた後、別タブの起動時復旧などが会議を確定済みにした
    stubPageGlobals();
    // サーバー停止中にして、Monitor の復帰通知による自動再試行が先に stop_requested を書かないようにする
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    await stopWhileMeetingWritesFail(s, id);
    const meeting = await s.app.meetingStore.get(id);
    await s.app.meetingStore.put({ ...meeting!, status: "finalized" });
    // Act
    await s.app.retryFinalize(id);
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
    // Assert：stop_requested に戻して確定を送り直さない
    expect((await s.app.meetingStore.get(id))?.status).toBe("finalized");
    expect(s.server.requests.filter((r) => r === `FINALIZE:${id}`)).toHaveLength(0);
    expect(await s.app.listPendingFinalize()).toEqual([]);
  });

  it("確定待ちの一覧を IDB から読めなくても、停止状態を書けずに保持している会議は返し、失敗を通知する", async () => {
    // Arrange：サーバー停止中に、停止状態を IDB に書けないまま止めた
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    await stopWhileMeetingWritesFail(s, id);
    const error = new Error("IDB read failed");
    vi.spyOn(s.app.meetingStore, "listByStatus").mockRejectedValue(error);
    // Act
    const pending = await s.app.listPendingFinalize();
    // Assert：再試行ボタンを出せるよう、メモリに保持した会議は返す
    expect(pending.map((m) => m.meetingId)).toEqual([id]);
    expect(s.events).toContainEqual({ type: "error", error });
  });

  it("finalizing の一覧取得だけに失敗しても、読めた stop_requested の会議は確定待ちとして返す", async () => {
    // Arrange
    const stopped = nextMeetingId();
    const s = await setup({ serverUp: false, seed: async (db) => seedMeeting(db, makeMeeting(stopped, "stop_requested")) });
    const list = s.app.meetingStore.listByStatus.bind(s.app.meetingStore);
    const error = new Error("IDB read failed");
    vi.spyOn(s.app.meetingStore, "listByStatus").mockImplementation(async (status) => {
      if (status === "finalizing") throw error;
      return list(status);
    });
    // Act
    const pending = await s.app.listPendingFinalize();
    // Assert
    expect(pending.map((m) => m.meetingId)).toContain(stopped);
    expect(s.events).toContainEqual({ type: "error", error });
  });

  it("stop_requested の一覧取得だけに失敗しても、読めた finalizing の会議は確定待ちとして返す", async () => {
    // Arrange
    const finalizing = nextMeetingId();
    const s = await setup({ serverUp: false, seed: async (db) => seedMeeting(db, makeMeeting(finalizing, "finalizing")) });
    const list = s.app.meetingStore.listByStatus.bind(s.app.meetingStore);
    const error = new Error("IDB read failed");
    vi.spyOn(s.app.meetingStore, "listByStatus").mockImplementation(async (status) => {
      if (status === "stop_requested") throw error;
      return list(status);
    });
    // Act
    const pending = await s.app.listPendingFinalize();
    // Assert
    expect(pending.map((m) => m.meetingId)).toContain(finalizing);
    expect(s.events).toContainEqual({ type: "error", error });
  });

  it("2 つの一覧取得の間に状態が進んで両方に載った会議は、確定待ちに 1 行だけ返す", async () => {
    // Arrange：stop_requested の取得後、別タブが finalizing に進めた
    const id = nextMeetingId();
    const s = await setup({ serverUp: false });
    vi.spyOn(s.app.meetingStore, "listByStatus").mockImplementation(async (status) => [makeMeeting(id, status)]);
    // Act
    const pending = await s.app.listPendingFinalize();
    // Assert：同じ会議の行が 2 つあると、片方の操作中にもう片方のボタンが押せてしまう
    expect(pending.map((m) => m.meetingId)).toEqual([id]);
  });

  it("停止状態の書き直しに失敗したら確定待ちの理由に記録し、finalize_pending を 1 回だけ通知する", async () => {
    // Arrange：サーバー停止中に、停止状態を IDB に書けないまま止めた（停止時の再試行も書き直しに失敗する）
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    await stopWhileMeetingWritesFail(s, id);
    // Act：書き直しが失敗し続ける間に再試行を重ねる
    const put = vi.spyOn(s.app.meetingStore, "put").mockRejectedValue(new Error("IDB write failed"));
    await s.app.retryFinalize(id);
    put.mockRestore();
    // Assert
    expect(s.app.getFinalizeIssue(id)).toMatchObject({ ok: false, stage: "verify", detail: expect.stringContaining("stop state not saved") });
    expect(s.events.filter((e) => e.type === "finalize_pending" && e.meetingId === id)).toHaveLength(1);
  });

  it("メモリ待機が空でも停止状態を書けていない間はタブを閉じる前に確認を求め、書き直したら求めない", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // Act
    await stopWhileMeetingWritesFail(s, id);
    // Assert：閉じると停止理由と最終の音声フレーム数が失われる
    expect(leave()).toBe(true);
    await s.app.retryFinalize(id);
    expect(leave()).toBe(false);
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
  it.each(["manual", "mic_ended"] as const)("停止が競合しても最初の理由 %s と検出時刻をコントローラへ一度だけ渡す", async (reason) => {
    // Arrange
    stubPageGlobals();
    const s = await setup({ token: null });
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    const stop = vi.spyOn(s.controllers[0], "stop");
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    // Act: IDB 書き込み待ちの間にもう一方の停止要求が来る
    if (reason === "mic_ended") s.controllers[0].deps.onMicEnded?.();
    const result = session.stop();
    now.mockReturnValue(999999);
    s.controllers[0].deps.onMicEnded?.();
    await result;
    // Assert
    expect(stop).toHaveBeenCalledExactlyOnceWith(reason, 123456);
    expect(s.events.filter(e => e.type === "recording_stopped")).toEqual([
      { type: "recording_stopped", meetingId: session.meetingId, reason },
    ]);
  });
  it("開始処理の途中でマイクが切断されたら、開始完了後に一度だけ停止する", async () => {
    // Arrange：start の完了前に onMicEnded が届く
    stubPageGlobals();
    const s = await setup();
    const start = FakeController.prototype.start;
    vi.spyOn(FakeController.prototype, "start").mockImplementationOnce(async function (this: FakeController, ...args) {
      await start.apply(this, args);
      this.deps.onMicEnded?.();
    });
    // Act
    const session = await s.app.startRecording(startInput(nextMeetingId()));
    // Assert
    await vi.waitFor(() => expect(s.events.filter((e) => e.type === "recording_stopped")).toEqual([
      { type: "recording_stopped", meetingId: session.meetingId, reason: "mic_ended" },
    ]));
    expect(s.log.filter((x) => x === "stop")).toHaveLength(1);
    expect(s.app.currentSession).toBeNull();
  });

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
    // 送り直しの完了で 1 回だけ確認し直し、再び不一致なら止まる
    expect(reads).toBe(2);
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

  it("直接送信でメモリ待機が空になったら、停止後の確定を再試行する", async () => {
    // Arrange：末尾がメモリ待機のまま停止し、Barrier で止まっている
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 1;
    expect(await session.stop()).toMatchObject({ ok: false, stage: "waiting_local_save" });
    // Act：直接送信は Scheduler を通らないので onChunkSaved が来ない
    controller.drainEffect = () => { controller.memoryBacklogCount = 0; };
    s.app.health.degradedReasons = ["IDB_WRITE_FAILED"];
    controller.deps.onError(new Error("idb write failed"));
    // Assert
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(id))?.status).toBe("finalized"));
  });

  it("サーバー照合の不一致で送り直した Chunk の保存が終わったら、確定を再試行する", async () => {
    // Arrange：IDB では登録済みだが、サーバーには届いていない
    stubPageGlobals();
    const id = nextMeetingId();
    const s = await setup({ seed: async (db) => {
      await seedChunk(db, id, 0, "DB_REGISTERED");
      await seedMeeting(db, makeMeeting(id, "stop_requested", 160));
    } });
    // Act：起動時の確定が不一致で送り直す
    await settleMonitor(s);
    // Assert
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(id))?.status).toBe("finalized"));
  });

  it("送り直しても照合が一致しなければ、再確認は 1 回で止め、送信を繰り返さない", async () => {
    // Arrange：サーバー一覧が常に別のハッシュを返す
    stubPageGlobals();
    const id = nextMeetingId();
    const s = await setup({
      seed: async (db) => {
        await seedChunk(db, id, 0, "DB_REGISTERED");
        await seedMeeting(db, makeMeeting(id, "stop_requested", 160));
      },
      wrapFetch: (fetchImpl) => async (input, init) => {
        const res = await fetchImpl(input, init);
        if (!String(input).endsWith("/chunks") || init?.method !== undefined) return res;
        const body = (await res.json()) as { meetingId: string; chunks: Array<Record<string, unknown>> };
        return new Response(JSON.stringify({ ...body, chunks: body.chunks.map((c) => ({ ...c, sha256: "0".repeat(64) })) }), { status: 200 });
      },
    });
    // Act
    await settleMonitor(s);
    // 2 回目の送り直しの PUT と、その保存完了通知（onChunkSaved は Scheduler の送信枠を空ける前に同期で走る）が済むまで待つ
    await vi.waitFor(() => expect(s.server.putCount).toBe(2));
    await vi.waitFor(() => expect(s.server.requests.filter((r) => r === `LIST:${id}`)).toHaveLength(2));
    await vi.waitFor(() => expect(s.app.scheduler.pendingCount).toBe(0));
    // Assert：最初の照合 + 送り直し後の再確認 1 回
    expect(s.server.putCount).toBe(2);
    expect(s.server.requests.filter((r) => r === `LIST:${id}`)).toHaveLength(2);
    expect((await s.app.meetingStore.get(id))?.status).toBe("stop_requested");
  });

  it("停止処理（末尾の flush）が終わるまでは、別タブから確定も確定中止もできない", async () => {
    // Arrange：タブ A の stop が Worklet の応答待ちで止まっている（録音開始から会議ロックを保持）
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    let release!: () => void;
    const flushing = new Promise<void>((r) => { release = r; });
    const stop = controller.stop.bind(controller);
    vi.spyOn(controller, "stop").mockImplementation(async (...args) => {
      await flushing;
      return stop(...args);
    });
    const stopping = session.stop();
    const meeting = await s.app.meetingStore.get(id);
    await s.app.meetingStore.put({ ...meeting!, status: "stop_requested" });
    // タブ B はヘルスチェックだけ失敗させ、起動時の自動再試行で先にロックを取らせない（明示的な操作だけを検証する）
    const other = await createApp({ db: s.db, baseUrl: BASE_URL, workletModuleUrl: "/worklet.js", locks: s.locks,
      onEvent: () => undefined, setTimer: () => undefined,
      fetchImpl: async (input, init) => String(input).endsWith("/health") ? new Response(null, { status: 503 }) : s.server.fetch(input, init) });
    apps.push(other);
    // Act
    const fromOther = await other.retryFinalize(id);
    const abandoning = other.abandonFinalize(id, true);
    // Assert
    expect(fromOther).toMatchObject({ ok: false, stage: "verify" });
    await expect(abandoning).rejects.toThrow("使用中");
    release();
    expect(await stopping).toMatchObject({ ok: true });
  });

  it("メモリ待機を残して停止した会議は別タブから確定できず、自タブの drain で空になってから確定する", async () => {
    // Arrange：タブ A は末尾をメモリ待機に残して停止した
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 1;
    expect(await session.stop()).toMatchObject({ ok: false, stage: "waiting_local_save" });
    // Act：同じ DB・ロックを使う別タブ B
    const other = await createApp({ db: s.db, baseUrl: BASE_URL, workletModuleUrl: "/worklet.js", locks: s.locks,
      onEvent: () => undefined, fetchImpl: s.server.fetch, setTimer: () => undefined });
    apps.push(other);
    const fromOther = await other.retryFinalize(id);
    // Assert：B はメモリ待機を数えられないので、末尾が欠けたまま確定させない
    expect(fromOther).toMatchObject({ ok: false, stage: "verify" });
    expect((await s.app.meetingStore.get(id))?.status).toBe("stop_requested");
    // A の直接送信でメモリ待機が空になれば、ロックを手放して確定する
    controller.drainEffect = () => { controller.memoryBacklogCount = 0; };
    s.app.health.degradedReasons = ["IDB_WRITE_FAILED"];
    controller.deps.onError(new Error("idb write failed"));
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(id))?.status).toBe("finalized"));
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
  });

  /** 末尾 Chunk を IDB にもサーバーにもないメモリ待機に残したまま録音を止める。sentTail() はその末尾がサーバーに届いたか */
  async function stopWithMemoryTail(serverUp: boolean) {
    stubPageGlobals();
    const s = await setup({ serverUp });
    if (serverUp) await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    const tail = await makeChunkRecord(id, 0, 160);
    controller.backlog.push(tail);
    controller.memoryBacklogCount = 1;
    controller.audioFrameCount = tail.meta.endFrame;
    const result = await session.stop();
    const sentTail = () => expect(s.server.stored.get(`${id}:mic:0`)).toEqual({ sha256: tail.meta.sha256, sizeBytes: tail.meta.sizeBytes });
    return { s, id, controller, result, sentTail };
  }

  it("メモリ待機の末尾は IDB 外の連番・最大 endFrame に含まれ、WAV として書き出せる", async () => {
    // Arrange・Act：サーバー停止中に末尾をメモリ待機に残して止めた
    const { s, id, controller } = await stopWithMemoryTail(false);
    const tail = controller.backlog[0];
    // Assert
    expect(s.app.offIdbSequenceNos(id)).toEqual([0]);
    expect(s.app.offIdbEndFrame(id)).toBe(tail.meta.endFrame);
    expect(s.app.exportMemoryBacklog(id)).toEqual([{ fileName: `${id}_mic_000000.wav`, wav: tail.wav, meta: tail.meta }]);
  });

  it("確定を中止した会議も、メモリ待機の末尾を WAV として書き出せる", async () => {
    // Arrange：サーバー停止中に末尾をメモリ待機に残して止めた
    const { s, id, controller } = await stopWithMemoryTail(false);
    const tail = controller.backlog[0];
    // Act
    await s.app.abandonFinalize(id, true);
    // Assert：中止はデータを削除しないので、利用者の手元へ残せる
    expect(s.app.exportMemoryBacklog(id).map((f) => [f.fileName, f.wav])).toEqual([[`${id}_mic_000000.wav`, tail.wav]]);
  });

  it("サーバー停止中にメモリ待機を残して止めた会議は、サーバー復帰で末尾を直接送信してから一度だけ確定する", async () => {
    // Arrange：末尾 Chunk が IDB にもサーバーにもなく、メモリ待機に残ったまま停止した
    const { s, id, controller, result, sentTail } = await stopWithMemoryTail(false);
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
    // Act
    s.server.up = true;
    await s.app.monitor.checkOnce();
    // Assert：実際に PUT された内容がサーバーに残り、確定は 1 回だけ
    await vi.waitFor(async () => expect((await s.app.meetingStore.get(id))?.status).toBe("finalized"));
    sentTail();
    expect(s.events.filter((e) => e.type === "finalized" && e.meetingId === id)).toHaveLength(1);
    expect(s.events.filter((e) => e.type === "finalize_pending" && e.meetingId === id)).toHaveLength(1);
    expect(controller.memoryBacklogCount).toBe(0);
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
  });

  it("サーバーが使えるときの確定（停止・手動再試行）は、メモリ待機を先に直接送信してから Barrier を通す", async () => {
    // Arrange・Act：サーバーは HEALTHY。末尾がメモリ待機に残ったまま止める
    const { s, result, sentTail } = await stopWithMemoryTail(true);
    // Assert
    expect(result).toMatchObject({ ok: true });
    sentTail();
    await vi.waitFor(() => expect(s.locks.held.size).toBe(0));
  });

  it("サーバー停止中の停止でも、メモリ待機を IDB へ書き戻すことは試す", async () => {
    // Arrange：IDB は回復しており、drain すれば IDB へ書き戻せる（直接送信は不要）
    stubPageGlobals();
    const s = await setup({ serverUp: false });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 1;
    controller.drainEffect = () => { controller.memoryBacklogCount = 0; };
    // Act
    await session.stop();
    // Assert
    expect(controller.drainCount).toBe(1);
    expect(controller.memoryBacklogCount).toBe(0);
  });

  it("サーバー停止中の停止では直接送信を試さず、メモリ待機の書き出しも重ねて促さない", async () => {
    // Arrange：末尾は IDB にもサーバーにもない
    stubPageGlobals();
    const puts: string[] = [];
    const s = await setup({ serverUp: false, wrapFetch: (f) => async (input, init) => {
      if (init?.method === "PUT") puts.push(String(input));
      return f(input, init);
    } });
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.backlog.push(await makeChunkRecord(id, 0, 160));
    controller.memoryBacklogCount = 1;
    // Act
    const result = await session.stop();
    // Assert
    expect(result).toMatchObject({ ok: false, stage: "waiting_local_save" });
    expect(puts).toEqual([]);
    expect(s.events.filter((e) => e.type === "memory_backlog_export_required")).toHaveLength(1);
    expect(controller.memoryBacklogCount).toBe(1);
  });

  it("直接送信が送信中のトークン変更で送れなければ、drain を終えてから送り直して確定する", async () => {
    // Arrange：停止後の drain の 1 回目の PUT だけ、トークンが替わり続けて送れない
    vi.spyOn(LocalSaver.prototype, "put").mockImplementationOnce(async () => ({
      ok: false, retryable: true, tokenChanged: true,
      error: { kind: "UNKNOWN", message: "token changed during upload", httpStatus: null, at: 0 },
    }));
    // Act
    const { s, id, controller, result, sentTail } = await stopWithMemoryTail(true);
    // Assert：書き出しの催促は停止時の 1 回だけで、確定まで進む
    expect(result).toMatchObject({ ok: true });
    sentTail();
    expect(controller.memoryBacklogCount).toBe(0);
    expect(s.events.filter((e) => e.type === "memory_backlog_export_required" && e.meetingId === id)).toHaveLength(1);
  });

  it("サーバー停止中の確定再試行が IDB への書き戻しを試す間にサーバーが戻ったら、その再試行の中で直接送信して確定する", async () => {
    // Arrange：サーバー停止中にメモリ待機を残して止め、手動再試行の drain が IDB への書き戻しを試している
    const { s, id, controller, sentTail } = await stopWithMemoryTail(false);
    const original = controller.drainMemoryBacklog.bind(controller);
    let resumeDrain = (): void => undefined;
    const drainStarted = new Promise<void>((started) => {
      vi.spyOn(controller, "drainMemoryBacklog").mockImplementationOnce(async () => {
        started();
        await new Promise<void>((r) => { resumeDrain = r; });
        return original();
      });
    });
    const retry = s.app.retryFinalize(id);
    await drainStarted;
    // Act：その間にサーバーが戻る（復帰時の drain と確定は、実行中の drain と借用中のロックに弾かれる）
    s.server.up = true;
    await s.app.monitor.checkOnce();
    resumeDrain();
    // Assert：復帰のイベントや手動再試行を待たずに、この再試行が末尾を送って確定する
    expect(await retry).toMatchObject({ ok: true });
    sentTail();
    expect(controller.memoryBacklogCount).toBe(0);
  });

  it("サーバー復帰時に IDB の会議一覧が読めなくても、停止後のメモリ待機は直接送信する", async () => {
    // Arrange：末尾をメモリ待機に残してサーバー停止中に止め、その後 IDB の一覧取得が失敗するようになる
    const { s, controller, sentTail } = await stopWithMemoryTail(false);
    vi.spyOn(s.app.meetingStore, "listByStatus").mockRejectedValue(new Error("IDB unavailable"));
    // Act
    s.server.up = true;
    await s.app.monitor.checkOnce();
    // Assert：IDB に頼らない直接送信は進める
    await vi.waitFor(sentTail);
    expect(controller.memoryBacklogCount).toBe(0);
  });

  it("停止後もメモリ待機が残る間はタブを閉じる前に確認を求め、送り終えたら求めない", async () => {
    // Arrange：末尾をメモリ待機に残したまま止めた
    const { s, controller } = await stopWithMemoryTail(false);
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // Assert：失われうる音声があるので離脱確認を残す
    expect(leave()).toBe(true);
    // Act：サーバー復帰で末尾を送り終える
    s.server.up = true;
    await s.app.monitor.checkOnce();
    await vi.waitFor(() => expect(controller.memoryBacklogCount).toBe(0));
    // Assert
    expect(leave()).toBe(false);
  });

  it("drain 後もメモリ待機が残っていれば確定を再試行しない", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const controller = s.controllers[0];
    controller.memoryBacklogCount = 2;
    await session.stop();
    const retry = vi.spyOn(s.app, "retryFinalize");
    s.app.health.degradedReasons = ["IDB_WRITE_FAILED"];
    // 停止時の確定もサーバーが使えれば drain する。onError による drain はその次の 1 回
    const drainsBefore = controller.drainCount;
    // Act
    controller.deps.onError(new Error("idb write failed"));
    await vi.waitFor(() => expect(controller.drainCount).toBe(drainsBefore + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Assert
    expect(retry).not.toHaveBeenCalled();
  });

  it("直接送信で DB 登録まで済んだ件数を会議ごとに返す", async () => {
    // Arrange
    stubPageGlobals();
    const s = await setup();
    const id = nextMeetingId();
    await s.app.startRecording(startInput(id));
    const record = await makeChunkRecord(id, 0, 160);
    // Act
    await s.controllers[0].deps.directSaver?.put(record);
    // Assert
    expect(s.app.directRegisteredCount(id)).toBe(1);
    expect(s.app.directRegisteredCount("other")).toBe(0);
    expect(s.app.offIdbEndFrame(id)).toBe(record.meta.endFrame);
    expect(s.app.offIdbEndFrame("other")).toBe(0);
    expect(s.app.offIdbSequenceNos(id)).toEqual([0]);
    expect(s.app.offIdbSequenceNos("other")).toEqual([]);
  });

  it("直接送信した末尾の終わりの位置で末尾の欠けを通知し、確定待ちの間は件数を保ち、確定後に消す", async () => {
    // Arrange：末尾 seq 0 を直接送信した後にサーバーが止まり、録音は保存済みより 2 秒長い
    stubPageGlobals();
    const s = await setup();
    await settleMonitor(s);
    const id = nextMeetingId();
    const session = await s.app.startRecording(startInput(id));
    const record = await makeChunkRecord(id, 0, 160);
    await s.controllers[0].deps.directSaver?.put(record);
    s.controllers[0].audioFrameCount = record.meta.endFrame + 32_000;
    s.server.up = false;
    // Act
    expect((await session.stop()).ok).toBe(false);
    // Assert：確定待ちの間は内訳の表示に使うので消さない
    expect(s.app.directRegisteredCount(id)).toBe(1);
    expect(s.app.offIdbSequenceNos(id)).toEqual([0]);
    // Act
    s.server.up = true;
    expect(await s.app.retryFinalize(id)).toEqual({ ok: true, missingTailMs: 2_000 });
    // Assert
    expect(s.events).toContainEqual({ type: "finalized", meetingId: id, missingTailMs: 2_000 });
    expect(s.app.directRegisteredCount(id)).toBe(0);
    expect(s.app.offIdbEndFrame(id)).toBe(0);
    expect(s.app.offIdbSequenceNos(id)).toEqual([]);
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
