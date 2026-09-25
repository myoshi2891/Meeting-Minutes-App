// test/resampler-aliasing.test.ts
import { describe, expect, it } from "vitest";
import { loadWorkletProcessor, makeSine } from "./harness";

interface ChunkEvent {
  type: "chunk";
  pcm: ArrayBuffer;
  sampleCount: number;
}

function isChunkEvent(v: unknown): v is ChunkEvent {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "chunk";
}

/** port に条件を満たすメッセージが届くまで待つ（タイマーに頼らずメッセージ順序で同期する）。 */
function nextMessage<T>(port: MessagePort, match: (data: unknown) => data is T): Promise<T> {
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
async function startProcessor(processorPort: MessagePort, nodePort: MessagePort): Promise<void> {
  const handled = nextMessage(processorPort, (d): d is { type: "start" } => typeof d === "object" && d !== null && (d as { type?: unknown }).type === "start");
  nodePort.postMessage({ type: "start" });
  await handled;
}

/** 単一周波数の振幅を Goertzel で求める（dBFS）。 */
function toneLevelDb(pcm: Int16Array, freqHz: number, sampleRate: number): number {
  const n = pcm.length;
  const k = Math.round((n * freqHz) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const c = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = pcm[i] / 32768 + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  const amplitude = (2 * Math.sqrt(Math.max(power, 1e-30))) / n;
  return 20 * Math.log10(amplitude);
}

describe("リサンプラのアンチエイリアシング", () => {
  it("12kHz 入力（48kHz）は 16kHz 出力で 4kHz に折り返さず -40dB 以下に抑えられる", async () => {
    const native = 48000;
    const { processor, nodePort } = await loadWorkletProcessor(native);
    await startProcessor(processor.port, nodePort);
    const quantum = 128;
    // 12kHz は 16kHz のナイキスト 8kHz を超える。ナイーブ間引きなら 16k - 12k = 4kHz に折り返す。
    const sig = makeSine(12000, native, native * 40); // 40 秒
    const firstChunk = nextMessage(nodePort, isChunkEvent);
    for (let i = 0; i + quantum <= sig.length; i += quantum) processor.process([[sig.subarray(i, i + quantum)]]);
    const chunk = await firstChunk;
    const pcm = new Int16Array(chunk.pcm, 0, chunk.sampleCount);
    const aliasDb = toneLevelDb(pcm, 4000, 16000);
    expect(aliasDb).toBeLessThan(-40);
  }, 60_000);

  it("1kHz 入力は通過帯域として -1dB 以内で保持される", async () => {
    const native = 48000;
    const { processor, nodePort } = await loadWorkletProcessor(native);
    await startProcessor(processor.port, nodePort);
    const sig = makeSine(1000, native, native * 40, 0.5);
    const firstChunk = nextMessage(nodePort, isChunkEvent);
    for (let i = 0; i + 128 <= sig.length; i += 128) processor.process([[sig.subarray(i, i + 128)]]);
    const chunk = await firstChunk;
    const pcm = new Int16Array(chunk.pcm, 0, chunk.sampleCount);
    const level = toneLevelDb(pcm, 1000, 16000);
    expect(level).toBeGreaterThan(20 * Math.log10(0.5) - 1);
  }, 60_000);
});
