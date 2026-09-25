// test/long-recording.test.ts
import { describe, expect, it } from "vitest";
import { loadWorkletProcessor, makeSine } from "./harness";
import { buildStandaloneWav, parseWavHeader } from "../src/audio/wav";

interface ChunkEvent {
  type: "chunk";
  pcm: ArrayBuffer;
  sampleCount: number;
  startFrame: number;
  endFrame: number;
  partial: boolean;
}

function isChunkEvent(v: unknown): v is ChunkEvent {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "chunk";
}

describe("60 分連続録音（48kHz ネイティブ → 16kHz、120 Chunk）", () => {
  it("120 個の完全な Chunk が連番・連続フレームで生成される", async () => {
    const native = 48000;
    const { processor, nodePort, received } = await loadWorkletProcessor(native);
    nodePort.postMessage({ type: "start" });
    await flushMessages();

    const quantum = 128;
    // 60 分 + 1 秒。FIR の群遅延ぶん末尾が不足するので、120 個目を完全 Chunk にするため 1 秒余分に流す
    const totalNativeSamples = native * (60 * 60 + 1);
    const signal = makeSine(440, native, quantum);
    for (let done = 0; done < totalNativeSamples; done += quantum) {
      processor.process([[signal, signal]]); // ステレオ入力 → モノミックス
    }
    await flushMessages();

    const chunks = received.filter(isChunkEvent);
    expect(chunks.length).toBeGreaterThanOrEqual(120);
    for (let i = 0; i < 120; i++) {
      const c = chunks[i];
      expect(c.sampleCount).toBe(480000);
      expect(c.partial).toBe(false);
      expect(c.startFrame).toBe(i * 480000);
      expect(c.endFrame).toBe((i + 1) * 480000);
      const wav = buildStandaloneWav(new Int16Array(c.pcm, 0, c.sampleCount));
      const parsed = parseWavHeader(wav);
      expect(parsed.ok).toBe(true);
      expect(wav.byteLength).toBe(960044);
    }
  }, 120_000);

  it("44.1kHz（非整数比）でも出力サンプル数が理論値と群遅延分（64 サンプル）以内で一致する", async () => {
    const native = 44100;
    const { processor, nodePort, received } = await loadWorkletProcessor(native);
    nodePort.postMessage({ type: "start" });
    await flushMessages();
    const quantum = 128;
    const seconds = 600; // 10 分
    const signal = makeSine(300, native, quantum);
    let fed = 0;
    while (fed < native * seconds) {
      processor.process([[signal]]);
      fed += quantum;
    }
    nodePort.postMessage({ type: "flush", requestId: 1 });
    await flushMessages();
    const total = received.filter(isChunkEvent).reduce((acc, c) => acc + c.sampleCount, 0);
    const expected = Math.floor((fed / native) * 16000);
    // FIR の群遅延ぶん（halfTaps）だけ末尾が未出力になる。それ以外の累積誤差は 1 以内。
    expect(Math.abs(total - expected)).toBeLessThanOrEqual(64);
  }, 60_000);
});

async function flushMessages(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}
