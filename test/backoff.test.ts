import { describe, expect, it } from "vitest";
import { backoffMs, MAX_SAVE_ATTEMPTS } from "../src/recording/backoff";

describe("backoffMs", () => {
  it("ジッター 0（random=0.5）なら基準値どおり 2s → 5s → 10s …", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((a) => backoffMs(a, mid))).toEqual([2000, 5000, 10000, 30000]);
  });

  it("上限は 600s で頭打ちになる", () => {
    expect(backoffMs(100, () => 0.5)).toBe(600_000);
  });

  it("attempts=0 以下は最初の段に丸める", () => {
    expect(backoffMs(0, () => 0.5)).toBe(2000);
    expect(backoffMs(-3, () => 0.5)).toBe(2000);
  });

  it("ジッターは ±20% の範囲に収まる", () => {
    expect(backoffMs(1, () => 0)).toBe(1600);
    expect(backoffMs(1, () => 0.999999)).toBeLessThanOrEqual(2400);
  });

  it("最大試行回数は 8", () => {
    expect(MAX_SAVE_ATTEMPTS).toBe(8);
  });
});
