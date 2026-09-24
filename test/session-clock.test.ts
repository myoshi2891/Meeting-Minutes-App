import { describe, expect, it } from "vitest";
import { computeFrameClockDriftMs, createSessionClock, frameToOffsetMs } from "../src/recording/session-clock";
import type { SessionClock } from "../src/types/recording";

function clockAt(sessionStartPerformanceMs: number, audioFrameCount: number): SessionClock {
  return {
    sessionStartEpochMs: 1_700_000_000_000,
    performanceTimeOrigin: 0,
    sessionStartPerformanceMs,
    audioContextStartTime: 0,
    nativeSampleRate: 48000,
    audioFrameCount,
  };
}

describe("frameToOffsetMs", () => {
  it("480,000 フレームは 30,000ms", () => {
    expect(frameToOffsetMs(480000)).toBe(30000);
  });

  it("0 フレームは 0ms", () => {
    expect(frameToOffsetMs(0)).toBe(0);
  });

  it("端数（部分 Chunk）は ms に丸める", () => {
    // 12345 / 16 = 771.5625
    expect(frameToOffsetMs(12345)).toBe(772);
  });
});

describe("computeFrameClockDriftMs", () => {
  it("音声時計と performance 時計が一致すればドリフト 0", () => {
    const clock = clockAt(1000, 16000);
    expect(computeFrameClockDriftMs(clock, 2000)).toBe(0);
  });

  it("フレームが進まない（suspended 等）と正のドリフトになる", () => {
    const clock = clockAt(1000, 16000);
    expect(computeFrameClockDriftMs(clock, 7000)).toBe(5000);
  });
});

describe("createSessionClock", () => {
  it("nativeSampleRate は AudioContext から実行時に取得する（16000 を仮定しない）", () => {
    const ctx = { currentTime: 1.5, sampleRate: 44100 } as unknown as AudioContext;
    const clock = createSessionClock(ctx);
    expect(clock.nativeSampleRate).toBe(44100);
    expect(clock.audioContextStartTime).toBe(1.5);
    expect(clock.audioFrameCount).toBe(0);
  });
});
