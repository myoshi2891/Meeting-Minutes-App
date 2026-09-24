// src/recording/backoff.ts
const BASE_DELAYS_MS: ReadonlyArray<number> = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** attempts 回目の失敗後に待つ時間。±20% のジッターを加える。 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const idx = Math.min(Math.max(attempts - 1, 0), BASE_DELAYS_MS.length - 1);
  const base = BASE_DELAYS_MS[idx];
  const jitter = (random() * 2 - 1) * 0.2 * base;
  return Math.round(base + jitter);
}

export const MAX_SAVE_ATTEMPTS = 8;
