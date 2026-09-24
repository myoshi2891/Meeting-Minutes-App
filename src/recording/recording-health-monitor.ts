// src/recording/recording-health-monitor.ts
import type { RecordingHealth, SessionClock, DegradedReason } from "../types/recording";
import { computeFrameClockDriftMs } from "./session-clock";

export interface HealthAssessment {
  readonly healthy: boolean;
  readonly reasons: ReadonlyArray<DegradedReason>;
  readonly msSinceLastAudioFrame: number;
  readonly msSinceLastChunk: number;
}

export const NO_AUDIO_FRAMES_THRESHOLD_MS = 5_000;

export function createInitialHealth(audioContextState: AudioContextState): RecordingHealth {
  const now = performance.now();
  return {
    lastAudioFrameAt: now,
    lastChunkAt: now,
    lastSuccessfulLocalSaveAt: 0,
    lastBackendHealthCheckAt: 0,
    frameClockDriftMs: 0,
    storagePersisted: null,
    storageUsageRatio: null,
    pendingChunkCount: 0,
    audioContextState,
    degradedReasons: [],
  };
}

/** 純関数。UI と監視はこれを任意のタイミングで呼ぶ。 */
export function assessHealth(health: RecordingHealth, clock: SessionClock | null, now: number): HealthAssessment {
  const msSinceLastAudioFrame = now - health.lastAudioFrameAt;
  const msSinceLastChunk = now - health.lastChunkAt;
  const reasons: DegradedReason[] = [...health.degradedReasons];

  if (health.audioContextState === "suspended" && !reasons.includes("AUDIO_CONTEXT_SUSPENDED")) reasons.push("AUDIO_CONTEXT_SUSPENDED");
  if (health.audioContextState === "closed" && !reasons.includes("AUDIO_CONTEXT_CLOSED")) reasons.push("AUDIO_CONTEXT_CLOSED");
  if (msSinceLastAudioFrame > NO_AUDIO_FRAMES_THRESHOLD_MS && !reasons.includes("NO_AUDIO_FRAMES")) reasons.push("NO_AUDIO_FRAMES");
  if (health.storagePersisted === false && !reasons.includes("STORAGE_NOT_PERSISTED")) reasons.push("STORAGE_NOT_PERSISTED");

  if (clock !== null) {
    health.frameClockDriftMs = computeFrameClockDriftMs(clock, now);
  }

  // 録音の健全性は音声フレームが進んでいることだけで判定する。backend の状態は「保存」の健全性であり、録音とは分ける。
  const recordingCritical: ReadonlySet<DegradedReason> = new Set(["AUDIO_CONTEXT_CLOSED", "NO_AUDIO_FRAMES", "MIC_TRACK_ENDED"]);
  const healthy = !reasons.some((r) => recordingCritical.has(r));
  return { healthy, reasons, msSinceLastAudioFrame, msSinceLastChunk };
}

export function attachAudioContextMonitor(audioContext: AudioContext, health: RecordingHealth): () => void {
  const handler = () => {
    health.audioContextState = audioContext.state;
    if (audioContext.state === "suspended") {
      // ユーザー操作起点でなければ resume は拒否されうる。試みるが結果に依存しない。
      void audioContext.resume().catch(() => undefined);
    }
  };
  audioContext.addEventListener("statechange", handler);
  return () => audioContext.removeEventListener("statechange", handler);
}
