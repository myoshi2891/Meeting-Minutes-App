// test/harness.ts
// 設計書 §24.1 の共通ハーネス。差分：scheduler に onBackendUnreachable / onBackendUnauthorized を配線（Monitor への即時通知の代替）。
import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { ChunkListResponse, ChunkResponse, HealthResponse } from "../src/api/contracts";
import type { AudioChunkRecord, LocalBackendHealth, RecordingHealth } from "../src/types/recording";
import { ChunkStore, MeetingStore, openDatabase } from "../src/storage/idb";
import { LocalSaveScheduler } from "../src/recording/local-save-scheduler";
import { LocalSaver } from "../src/api/local-saver";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import { buildStandaloneWav } from "../src/audio/wav";
import { makeChunkKey, sha256Hex } from "../src/recording/recording-controller";

export const BASE_URL = "http://127.0.0.1:43117";
export const TOKEN = "test-token";

/** 常駐サーバーの振る舞いを最小限で模倣する fetch 実装。 */
export class FakeLocalServer {
  up = true;
  readonly stored = new Map<string, { sha256: string; sizeBytes: number }>();
  /** PUT がサーバーに到達した順（sequenceNo 順序保証の検証用） */
  readonly arrivalOrder: string[] = [];
  putCount = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!this.up) throw new TypeError("Failed to fetch");
    if (url.pathname === "/v1/health") {
      const body: HealthResponse = { status: "ok", service: "minutes-local" };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }), { status: 401 });

    const putMatch = url.pathname.match(/^\/v1\/meetings\/([^/]+)\/chunks\/(mic|system)\/(\d+)$/);
    if (putMatch !== null && init?.method === "PUT") {
      this.putCount++;
      this.arrivalOrder.push(`${putMatch[1]}:${putMatch[2]}:${putMatch[3]}`);
      const body = init.body;
      const bytes = body instanceof Blob ? await body.arrayBuffer() : new ArrayBuffer(0);
      const sha = await sha256Hex(bytes);
      const key = `${putMatch[1]}:${putMatch[2]}:${putMatch[3]}`;
      const existing = this.stored.get(key);
      if (existing !== undefined && existing.sha256 !== sha) {
        return new Response(JSON.stringify({ error: "hash mismatch", code: "CONFLICT_HASH_MISMATCH" }), { status: 409 });
      }
      this.stored.set(key, { sha256: sha, sizeBytes: bytes.byteLength });
      const res: ChunkResponse = {
        meetingId: putMatch[1],
        source: putMatch[2] as "mic" | "system",
        sequenceNo: Number(putMatch[3]),
        sha256: sha,
        sizeBytes: bytes.byteLength,
        path: `recordings/${putMatch[1]}/${putMatch[2]}/${putMatch[3].padStart(6, "0")}.wav`,
        registered: true,
      };
      return new Response(JSON.stringify(res), { status: existing === undefined ? 201 : 200 });
    }

    const listMatch = url.pathname.match(/^\/v1\/meetings\/([^/]+)\/chunks$/);
    if (listMatch !== null) {
      const chunks = [...this.stored.entries()]
        .filter(([k]) => k.startsWith(`${listMatch[1]}:`))
        .map(([k, v]) => {
          const [, source, seq] = k.split(":");
          return { source: source as "mic" | "system", sequenceNo: Number(seq), sha256: v.sha256, sizeBytes: v.sizeBytes, registered: true };
        });
      const res: ChunkListResponse = { meetingId: listMatch[1], chunks };
      return new Response(JSON.stringify(res), { status: 200 });
    }

    if (url.pathname.endsWith("/finalize") && init?.method === "POST") {
      return new Response(JSON.stringify({ meetingId: "x", status: "finalized", registeredChunkCounts: { mic: this.stored.size, system: 0 } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

export interface Harness {
  readonly db: IDBDatabase;
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly server: FakeLocalServer;
  readonly backend: LocalBackendHealth;
  readonly health: RecordingHealth;
  readonly scheduler: LocalSaveScheduler;
  readonly timers: Array<{ fn: () => void; at: number }>;
  now: number;
  readonly advance: (ms: number) => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const db = await openDatabase();
  const server = new FakeLocalServer();
  const backend: LocalBackendHealth = { status: "HEALTHY", lastCheckedAt: 0, lastHealthyAt: 0, latencyMs: 5, consecutiveFailures: 0, capabilities: null, unauthorized: false };
  const health = createInitialHealth("running");
  const timers: Array<{ fn: () => void; at: number }> = [];
  const h: Harness = {
    db,
    chunkStore: new ChunkStore(db),
    meetingStore: new MeetingStore(db),
    server,
    backend,
    health,
    timers,
    now: 0,
    scheduler: new LocalSaveScheduler({
      chunkStore: new ChunkStore(db),
      saver: () => new LocalSaver({ baseUrl: BASE_URL, token: TOKEN, requestTimeoutMs: 1000 }, server.fetch),
      backend: () => backend,
      health,
      maxConcurrency: 2,
      now: () => h.now,
      setTimer: (fn, ms) => timers.push({ fn, at: h.now + ms }),
      onBackendUnreachable: () => {
        backend.status = "UNREACHABLE";
      },
      onBackendUnauthorized: () => {
        backend.unauthorized = true;
      },
    }),
    advance: async (ms) => {
      h.now += ms;
      const due = timers.filter((t) => t.at <= h.now);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      // fake-indexeddb と crypto.subtle はマクロタスクで完了するため、setTimeout(0) で数周回す
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
  return h;
}

export function makeSine(freqHz: number, sampleRate: number, samples: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

export async function makeChunkRecord(meetingId: string, sequenceNo: number, sampleCount = 480000): Promise<AudioChunkRecord> {
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)) + sequenceNo; // seq でハッシュを変える
  const wav = buildStandaloneWav(pcm);
  const sha256 = await sha256Hex(wav);
  const startFrame = sequenceNo * 480000;
  return {
    chunkKey: makeChunkKey(meetingId, "mic", sequenceNo),
    meta: {
      meetingId,
      source: "mic",
      sequenceNo,
      startFrame,
      endFrame: startFrame + sampleCount,
      startOffsetMs: sequenceNo * 30000,
      endOffsetMs: sequenceNo * 30000 + Math.round((sampleCount / 16000) * 1000),
      wallClockStartEpochMs: 1_700_000_000_000 + sequenceNo * 30000,
      sampleRate: 16000,
      channels: 1,
      durationMs: Math.round((sampleCount / 16000) * 1000),
      sampleCount,
      vadScore: 0.5,
      hasVoice: true,
      sha256,
      sizeBytes: wav.byteLength,
    },
    save: { status: "GENERATED", savedVia: null, attempts: 0, nextRetryAt: null, lastError: null, serverPath: null, updatedAt: 0 },
    wav: new Blob([wav], { type: "audio/wav" }),
    createdAt: Date.now(),
  };
}

/**
 * AudioWorkletGlobalScope をスタブして Processor クラスを取り出す。
 * processor.port は Worklet 側の端なので、テストは nodePort（AudioWorkletNode 側に相当）から送る。
 */
export async function loadWorkletProcessor(nativeSampleRate: number): Promise<{
  processor: { process(inputs: Float32Array[][]): boolean; port: MessagePort };
  nodePort: MessagePort;
  received: unknown[];
}> {
  const received: unknown[] = [];
  type ProcessorCtor = new () => { process(inputs: Float32Array[][]): boolean; port: MessagePort };
  const holder: { ctor: ProcessorCtor | null } = { ctor: null };
  const channel = new MessageChannel();
  channel.port2.onmessage = (e) => received.push(e.data);

  const g = globalThis as Record<string, unknown>;
  g.sampleRate = nativeSampleRate;
  g.currentTime = 0;
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
    holder.ctor = ctor;
  };
  g.AudioWorkletProcessor = class {
    readonly port = channel.port1;
  };
  vi.resetModules();
  await import("../src/worklet/pcm-chunker.worklet");
  if (holder.ctor === null) throw new Error("registerProcessor not called");
  const processor = new holder.ctor();
  return { processor, nodePort: channel.port2, received };
}

/** port に条件を満たすメッセージが届くまで待つ（タイマーに頼らずメッセージ順序で同期する）。 */
export function nextMessage<T>(port: MessagePort, match: (data: unknown) => data is T): Promise<T> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      if (!match(e.data)) return;
      port.removeEventListener("message", onMessage);
      resolve(e.data);
    };
    port.addEventListener("message", onMessage);
  });
}

/** start を送り、Processor 側の onmessage が処理し終えるまで待つ。Processor は ack を返さないため、後から登録したリスナーの発火で完了を知る。 */
export async function startProcessor(processorPort: MessagePort, nodePort: MessagePort): Promise<void> {
  const handled = nextMessage(processorPort, (d): d is { type: "start" } => typeof d === "object" && d !== null && (d as { type?: unknown }).type === "start");
  nodePort.postMessage({ type: "start" });
  await handled;
}

/** 指定 requestId の flushed を待つ。同一 port は順序保証なので、これより前に送られた chunk はすべて届いている。 */
export function nextFlushed(nodePort: MessagePort, requestId: number): Promise<{ type: "flushed"; requestId: number }> {
  return nextMessage(nodePort, (d): d is { type: "flushed"; requestId: number } =>
    typeof d === "object" && d !== null && (d as { type?: unknown }).type === "flushed" && (d as { requestId?: unknown }).requestId === requestId,
  );
}

/** n 個目の chunk が届くまで待つ。 */
export function nthChunk(nodePort: MessagePort, n: number): Promise<unknown> {
  let seen = 0;
  return nextMessage(nodePort, (d): d is unknown => typeof d === "object" && d !== null && (d as { type?: unknown }).type === "chunk" && ++seen === n);
}
