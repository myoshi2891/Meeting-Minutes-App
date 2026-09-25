import { describe, expect, it } from "vitest";
import { loadWorkletProcessor, makeSine } from "./harness";

interface ChunkEvent {
  type: "chunk";
  sampleCount: number;
  startFrame: number;
  endFrame: number;
  partial: boolean;
  vad: { score: number; hasVoice: boolean; voicedSamples: number };
}

function isEvent<T extends { type: string }>(type: T["type"]) {
  return (v: unknown): v is T => typeof v === "object" && v !== null && (v as { type?: unknown }).type === type;
}
const isChunk = isEvent<ChunkEvent>("chunk");

async function flushMessages(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** native=16kHz で seconds 秒分の信号を 128 フレームずつ流す */
function feed(processor: { process(inputs: Float32Array[][]): boolean }, signal: Float32Array): void {
  for (let i = 0; i + 128 <= signal.length; i += 128) processor.process([[signal.subarray(i, i + 128)]]);
}

describe("PcmChunkerProcessor", () => {
  it("起動時に ready で実行時のネイティブレートを通知する", async () => {
    // Arrange / Act
    const { received } = await loadWorkletProcessor(44100);
    await flushMessages();
    // Assert
    expect(received[0]).toMatchObject({ type: "ready", nativeSampleRate: 44100 });
  });

  it("start 前の process() は PCM を蓄積しない", async () => {
    const { processor, nodePort, received } = await loadWorkletProcessor(16000);
    feed(processor, makeSine(440, 16000, 16000));
    nodePort.postMessage({ type: "flush", requestId: 1 });
    await flushMessages();
    expect(received.filter(isChunk)).toHaveLength(0);
  });

  it("入力が空（Mic 切断）でも Processor は維持される", async () => {
    const { processor, nodePort } = await loadWorkletProcessor(16000);
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
  });

  it("flush は録音を継続したまま部分 Chunk を吐き、次 Chunk のフレームが連続する", async () => {
    const { processor, nodePort, received } = await loadWorkletProcessor(16000);
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    feed(processor, makeSine(440, 16000, 16000 * 5));
    nodePort.postMessage({ type: "flush", requestId: 1 });
    await flushMessages();
    feed(processor, makeSine(440, 16000, 16000 * 31));
    await flushMessages();

    const chunks = received.filter(isChunk);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].partial).toBe(true);
    expect(chunks[0].sampleCount).toBeLessThan(480000);
    expect(chunks[1].partial).toBe(false);
    expect(chunks[1].sampleCount).toBe(480000);
    expect(chunks[1].startFrame).toBe(chunks[0].endFrame);
    // flushed は要求の requestId をそのまま返す（Controller が応答と要求を対応付ける）
    expect(received.filter(isEvent<{ type: "flushed"; requestId: number }>("flushed")).map((e) => e.requestId)).toEqual([1]);
  });

  it("stop 後の process() は false を返し Processor が破棄される", async () => {
    const { processor, nodePort, received } = await loadWorkletProcessor(16000);
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    feed(processor, makeSine(440, 16000, 16000));
    nodePort.postMessage({ type: "stop", requestId: 1 });
    await flushMessages();
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
    expect(received.filter(isChunk)).toHaveLength(1);
  });

  it("音声 Chunk は hasVoice=true、直後の無音 Chunk は hangover を持ち越さず hasVoice=false", async () => {
    const { processor, nodePort, received } = await loadWorkletProcessor(16000);
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    feed(processor, makeSine(440, 16000, 480000, 0.3)); // 30 秒の音声（Chunk 境界ちょうどで終わる）
    feed(processor, new Float32Array(480000 + 16000)); // 無音
    await flushMessages();

    const chunks = received.filter(isChunk);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].vad.hasVoice).toBe(true);
    expect(chunks[0].vad.score).toBeGreaterThan(0.15);
    expect(chunks[1].vad.hasVoice).toBe(false);
  });

  it("configure で VAD しきい値を変更できる（しきい値は設定値であり固定仕様ではない）", async () => {
    const { processor, nodePort, received } = await loadWorkletProcessor(16000);
    nodePort.postMessage({ type: "configure", vad: { threshold: 0.99, minSpeechMs: 200, hangoverMs: 300, floorDbfs: -60 } });
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    feed(processor, makeSine(440, 16000, 16000 * 2, 0.3));
    nodePort.postMessage({ type: "flush", requestId: 1 });
    await flushMessages();
    const chunk = received.find(isChunk);
    expect(chunk?.vad.hasVoice).toBe(false);
  });
});
