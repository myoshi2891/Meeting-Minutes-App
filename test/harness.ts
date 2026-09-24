// test/harness.ts
// 設計書 §24.1 の共通ハーネス。実装 Step の進行に合わせて段階的に追記する。
import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { AudioChunkRecord } from "../src/types/recording";
import { buildStandaloneWav } from "../src/audio/wav";
import { makeChunkKey, sha256Hex } from "../src/recording/recording-controller";

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
