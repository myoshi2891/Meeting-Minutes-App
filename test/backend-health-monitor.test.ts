import { describe, expect, it } from "vitest";
import { BackendHealthMonitor, type BackendHealthMonitorConfig } from "../src/api/backend-health-monitor";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import type { LocalBackendStatus } from "../src/types/recording";

const CONFIG: BackendHealthMonitorConfig = {
  baseUrl: "http://127.0.0.1:43117",
  token: () => "tok",
  healthyIntervalMs: 10_000,
  unreachableIntervalMs: 5_000,
  timeoutMs: 50,
  degradedLatencyMs: 1_000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("BackendHealthMonitor.checkOnce", () => {
  it("正しい service の ok 応答で HEALTHY、連続失敗はリセットされる", async () => {
    // Arrange
    const health = createInitialHealth("running");
    const m = new BackendHealthMonitor(CONFIG, health, async () => json({ status: "ok", service: "minutes-local" }));
    m.reportUnreachable();
    // Act
    const s = await m.checkOnce();
    // Assert
    expect(s.status).toBe("HEALTHY");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastHealthyAt).not.toBeNull();
    expect(health.lastBackendHealthCheckAt).toBeGreaterThan(0);
    expect(health.degradedReasons).toEqual([]);
  });

  it("サーバー自己申告の degraded は DEGRADED", async () => {
    const health = createInitialHealth("running");
    const m = new BackendHealthMonitor(CONFIG, health, async () => json({ status: "degraded", service: "minutes-local" }));
    expect((await m.checkOnce()).status).toBe("DEGRADED");
    expect(health.degradedReasons).toContain("BACKEND_DEGRADED");
  });

  it("応答が degradedLatencyMs を超えると DEGRADED", async () => {
    const m = new BackendHealthMonitor({ ...CONFIG, degradedLatencyMs: 5 }, createInitialHealth("running"), async () => {
      await new Promise((r) => setTimeout(r, 15));
      return json({ status: "ok", service: "minutes-local" });
    });
    expect((await m.checkOnce()).status).toBe("DEGRADED");
  });

  it("同じポートの別サービス（service 不一致）は UNREACHABLE", async () => {
    const health = createInitialHealth("running");
    const m = new BackendHealthMonitor(CONFIG, health, async () => json({ status: "ok", service: "someone-else" }));
    expect((await m.checkOnce()).status).toBe("UNREACHABLE");
    expect(health.degradedReasons).toContain("BACKEND_UNREACHABLE");
  });

  it("接続不能は UNREACHABLE、連続失敗回数が増える", async () => {
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), async () => {
      throw new TypeError("Failed to fetch");
    });
    await m.checkOnce();
    const s = await m.checkOnce();
    expect(s.status).toBe("UNREACHABLE");
    expect(s.consecutiveFailures).toBe(2);
  });

  it("timeoutMs 以内に応答しなければ UNREACHABLE", async () => {
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), (_i, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    expect((await m.checkOnce()).status).toBe("UNREACHABLE");
  });

  it("401 は unauthorized=true で BACKEND_UNAUTHORIZED、正しい応答で解除される", async () => {
    const health = createInitialHealth("running");
    let authorized = false;
    const m = new BackendHealthMonitor(CONFIG, health, async () =>
      authorized ? json({ status: "ok", service: "minutes-local" }) : json({ error: "x", code: "UNAUTHORIZED" }, 401),
    );
    const s1 = await m.checkOnce();
    expect(s1.unauthorized).toBe(true);
    expect(health.degradedReasons).toEqual(["BACKEND_UNAUTHORIZED"]);
    authorized = true;
    const s2 = await m.checkOnce();
    expect(s2.unauthorized).toBe(false);
    expect(health.degradedReasons).toEqual([]);
  });

  it("backend 以外の degradedReasons は保持される", async () => {
    const health = createInitialHealth("running");
    health.degradedReasons = ["MIC_TRACK_ENDED"];
    const m = new BackendHealthMonitor(CONFIG, health, async () => {
      throw new TypeError("x");
    });
    await m.checkOnce();
    expect(health.degradedReasons).toEqual(["MIC_TRACK_ENDED", "BACKEND_UNREACHABLE"]);
  });

  it("onChange は状態が変わったときだけ通知される", async () => {
    let up = true;
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), async () => {
      if (!up) throw new TypeError("x");
      return json({ status: "ok", service: "minutes-local" });
    });
    const seen: LocalBackendStatus[] = [];
    m.onChange((s) => seen.push(s.status));
    await m.checkOnce();
    await m.checkOnce();
    up = false;
    await m.checkOnce();
    up = true;
    await m.checkOnce();
    expect(seen).toEqual(["HEALTHY", "UNREACHABLE", "HEALTHY"]);
  });

  it("外部ホストの baseUrl では生成できない", () => {
    expect(() => new BackendHealthMonitor({ ...CONFIG, baseUrl: "https://example.com" }, createInitialHealth("running"))).toThrow();
  });
});
