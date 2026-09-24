// test/harness.ts
// 設計書 §24.1 の共通ハーネス。実装 Step の進行に合わせて段階的に追記する。
import { vi } from "vitest";

export function makeSine(freqHz: number, sampleRate: number, samples: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
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
