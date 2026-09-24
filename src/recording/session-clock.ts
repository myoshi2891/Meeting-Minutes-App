// src/recording/session-clock.ts
import type { SessionClock } from "../types/recording";

const TARGET_RATE = 16000;

export function createSessionClock(audioContext: AudioContext): SessionClock {
  return {
    sessionStartEpochMs: Date.now(),
    performanceTimeOrigin: performance.timeOrigin,
    sessionStartPerformanceMs: performance.now(),
    audioContextStartTime: audioContext.currentTime,
    // 実行時に取得する。16000 と仮定しない（v4.0 §4）。
    nativeSampleRate: audioContext.sampleRate,
    audioFrameCount: 0,
  };
}

export function frameToOffsetMs(frame: number): number {
  // 480,000 サンプル = 30,000ms なので整数で割り切れる。端数は最終 Chunk のみ。
  return Math.round((frame / TARGET_RATE) * 1000);
}

/** 音声時計と performance 時計の差（ms）。正なら音声時計が遅れている。 */
export function computeFrameClockDriftMs(clock: SessionClock, nowPerformanceMs: number): number {
  const audioElapsedMs = frameToOffsetMs(clock.audioFrameCount);
  const wallElapsedMs = nowPerformanceMs - clock.sessionStartPerformanceMs;
  return wallElapsedMs - audioElapsedMs;
}
