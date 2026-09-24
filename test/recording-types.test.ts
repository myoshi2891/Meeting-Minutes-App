import { describe, expect, it } from "vitest";
import { AUDIO_PIPELINE_CONFIG, isWorkletEvent } from "../src/types/recording";

describe("isWorkletEvent", () => {
  it.each(["ready", "chunk", "heartbeat", "flushed"])("type=%s を WorkletEvent と判定する", (type) => {
    // Arrange
    const value = { type };
    // Act
    const result = isWorkletEvent(value);
    // Assert
    expect(result).toBe(true);
  });

  it.each([null, undefined, 42, "chunk", {}, { type: "start" }, { type: 1 }])("%j は WorkletEvent ではない", (value) => {
    expect(isWorkletEvent(value)).toBe(false);
  });
});

describe("AUDIO_PIPELINE_CONFIG", () => {
  it("samplesPerChunk は targetSampleRate × chunkDurationMs / 1000 と一致する", () => {
    const { targetSampleRate, chunkDurationMs, samplesPerChunk } = AUDIO_PIPELINE_CONFIG;
    expect((targetSampleRate * chunkDurationMs) / 1000).toBe(samplesPerChunk);
  });
});
