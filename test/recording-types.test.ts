import { describe, expect, it } from "vitest";
import { AUDIO_PIPELINE_CONFIG, isWorkletEvent } from "../src/types/recording";

describe("isWorkletEvent", () => {
  const valid = {
    ready: { type: "ready", nativeSampleRate: 48000, renderQuantum: 128 },
    chunk: { type: "chunk", pcm: new ArrayBuffer(4), sampleCount: 2, startFrame: 0, endFrame: 2, vad: { score: 0.5, hasVoice: true, voicedSamples: 2 }, partial: false },
    heartbeat: { type: "heartbeat", audioFrameCount: 16000, currentTime: 1 },
    flushed: { type: "flushed", requestId: 1, audioFrameCount: 16000 },
  };

  it.each(Object.entries(valid))("type=%s で必須フィールドが揃っていれば WorkletEvent と判定する", (_type, value) => {
    // Arrange / Act
    const result = isWorkletEvent(value);
    // Assert
    expect(result).toBe(true);
  });

  it.each([null, undefined, 42, "chunk", {}, { type: "start" }, { type: 1 }])("%j は WorkletEvent ではない", (value) => {
    expect(isWorkletEvent(value)).toBe(false);
  });

  it.each(["ready", "chunk", "heartbeat", "flushed"])("type=%s だけで必須フィールドがなければ WorkletEvent ではない", (type) => {
    expect(isWorkletEvent({ type })).toBe(false);
  });

  it.each([
    ["ready の nativeSampleRate が文字列", { ...valid.ready, nativeSampleRate: "48000" }],
    ["chunk の pcm が ArrayBuffer でない", { ...valid.chunk, pcm: [0, 0] }],
    ["chunk の vad が null", { ...valid.chunk, vad: null }],
    ["chunk の vad.hasVoice が欠落", { ...valid.chunk, vad: { score: 0.5, voicedSamples: 2 } }],
    ["chunk の partial が欠落", { ...valid.chunk, partial: undefined }],
    ["heartbeat の currentTime が欠落", { type: "heartbeat", audioFrameCount: 16000 }],
    ["flushed の requestId が文字列", { ...valid.flushed, requestId: "1" }],
  ])("%s なら WorkletEvent ではない", (_label, value) => {
    expect(isWorkletEvent(value)).toBe(false);
  });
});

describe("AUDIO_PIPELINE_CONFIG", () => {
  it("samplesPerChunk は targetSampleRate × chunkDurationMs / 1000 と一致する", () => {
    const { targetSampleRate, chunkDurationMs, samplesPerChunk } = AUDIO_PIPELINE_CONFIG;
    expect((targetSampleRate * chunkDurationMs) / 1000).toBe(samplesPerChunk);
  });
});
