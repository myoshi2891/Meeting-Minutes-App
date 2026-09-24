import { describe, expect, it } from "vitest";
import { assessHealth, createInitialHealth, NO_AUDIO_FRAMES_THRESHOLD_MS } from "../src/recording/recording-health-monitor";
import type { SessionClock } from "../src/types/recording";

describe("assessHealth", () => {
  it("フレームが進んでいれば健全", () => {
    const h = createInitialHealth("running");
    h.lastAudioFrameAt = 1000;
    const a = assessHealth(h, null, 1500);
    expect(a.healthy).toBe(true);
    expect(a.msSinceLastAudioFrame).toBe(500);
  });

  it("フレームが閾値を超えて途絶えると NO_AUDIO_FRAMES で不健全", () => {
    const h = createInitialHealth("running");
    h.lastAudioFrameAt = 0;
    const a = assessHealth(h, null, NO_AUDIO_FRAMES_THRESHOLD_MS + 1);
    expect(a.healthy).toBe(false);
    expect(a.reasons).toContain("NO_AUDIO_FRAMES");
  });

  it("サーバー未接続は保存の問題であり、録音の健全性を損なわない", () => {
    const h = createInitialHealth("running");
    h.degradedReasons = ["BACKEND_UNREACHABLE", "BACKEND_UNAUTHORIZED"];
    expect(assessHealth(h, null, h.lastAudioFrameAt).healthy).toBe(true);
  });

  it("closed / MIC_TRACK_ENDED は不健全、suspended は警告のみ", () => {
    const closed = createInitialHealth("closed");
    expect(assessHealth(closed, null, closed.lastAudioFrameAt).healthy).toBe(false);
    const suspended = createInitialHealth("suspended");
    const a = assessHealth(suspended, null, suspended.lastAudioFrameAt);
    expect(a.healthy).toBe(true);
    expect(a.reasons).toContain("AUDIO_CONTEXT_SUSPENDED");
    const mic = createInitialHealth("running");
    mic.degradedReasons = ["MIC_TRACK_ENDED"];
    expect(assessHealth(mic, null, mic.lastAudioFrameAt).healthy).toBe(false);
  });

  it("persist() が false なら STORAGE_NOT_PERSISTED を付ける", () => {
    const h = createInitialHealth("running");
    h.storagePersisted = false;
    expect(assessHealth(h, null, h.lastAudioFrameAt).reasons).toContain("STORAGE_NOT_PERSISTED");
  });

  it("clock があれば frameClockDriftMs を更新する", () => {
    const h = createInitialHealth("running");
    const clock: SessionClock = { sessionStartEpochMs: 0, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0, audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 16000 };
    assessHealth(h, clock, 1250);
    expect(h.frameClockDriftMs).toBe(250);
  });
});
