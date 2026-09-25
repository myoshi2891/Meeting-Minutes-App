import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendHealthMonitor, type BackendHealthMonitorConfig } from "../src/api/backend-health-monitor";
import { createInitialHealth } from "../src/recording/recording-health-monitor";
import type { LocalBackendCapabilities, LocalBackendStatus } from "../src/types/recording";

const CONFIG: BackendHealthMonitorConfig = {
  baseUrl: "http://127.0.0.1:43117",
  token: () => "tok",
  healthyIntervalMs: 10_000,
  unreachableIntervalMs: 5_000,
  timeoutMs: 50,
  degradedLatencyMs: 1_000,
};

const CAPS: LocalBackendCapabilities = {
  service: "minutes-local",
  version: "0.1.0",
  dataDir: "/data",
  freeDiskBytes: 1,
  gpu: { available: false, name: null, vramBytes: null },
  cpuCores: 8,
  totalMemoryBytes: 1,
  sttModel: null,
  llmModel: null,
  maxConcurrentStt: 1,
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
    // Arrange：実時間を待たず、performance.now() の進みで応答時間を決める
    let clock = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const m = new BackendHealthMonitor({ ...CONFIG, degradedLatencyMs: 5 }, createInitialHealth("running"), async () => {
      clock += 6;
      return json({ status: "ok", service: "minutes-local" });
    });
    try {
      // Act / Assert
      expect((await m.checkOnce()).status).toBe("DEGRADED");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("応答が degradedLatencyMs ちょうどなら DEGRADED にしない", async () => {
    let clock = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const m = new BackendHealthMonitor({ ...CONFIG, degradedLatencyMs: 5 }, createInitialHealth("running"), async () => {
      clock += 5;
      return json({ status: "ok", service: "minutes-local" });
    });
    try {
      expect((await m.checkOnce()).status).toBe("HEALTHY");
    } finally {
      nowSpy.mockRestore();
    }
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
    // Arrange：タイムアウトはフェイクタイマーで進める
    vi.useFakeTimers();
    try {
      const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), (_i, init) =>
        new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      );
      // Act
      const result = m.checkOnce();
      await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
      // Assert
      expect((await result).status).toBe("UNREACHABLE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("401 は unauthorized=true で BACKEND_UNAUTHORIZED、正しい応答で解除される", async () => {
    const health = createInitialHealth("running");
    let authorized = false;
    const m = new BackendHealthMonitor(CONFIG, health, async () =>
      authorized ? json({ status: "ok", service: "minutes-local", capabilities: CAPS }) : json({ error: "x", code: "UNAUTHORIZED" }, 401),
    );
    const s1 = await m.checkOnce();
    expect(s1.unauthorized).toBe(true);
    expect(health.degradedReasons).toEqual(["BACKEND_UNAUTHORIZED"]);
    authorized = true;
    const s2 = await m.checkOnce();
    expect(s2.unauthorized).toBe(false);
    expect(health.degradedReasons).toEqual([]);
  });

  it("401 応答で UNREACHABLE になったときは latencyMs と capabilities を持たない", async () => {
    // Arrange：認証済みで HEALTHY（capabilities あり）にしてから 401 を返す
    let authorized = true;
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), async () =>
      authorized ? json({ status: "ok", service: "minutes-local", capabilities: CAPS }) : json({ error: "x", code: "UNAUTHORIZED" }, 401),
    );
    await m.checkOnce();
    expect(m.state.capabilities).toEqual(CAPS);
    authorized = false;
    // Act
    const s = await m.checkOnce();
    // Assert
    expect(s.status).toBe("UNREACHABLE");
    expect(s.latencyMs).toBeNull();
    expect(s.capabilities).toBeNull();
  });

  it("接続不能で UNREACHABLE になったら、直前の capabilities を残さない", async () => {
    let up = true;
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), async () => {
      if (!up) throw new TypeError("x");
      return json({ status: "ok", service: "minutes-local", capabilities: CAPS });
    });
    await m.checkOnce();
    up = false;
    const s = await m.checkOnce();
    expect(s.capabilities).toBeNull();
    expect(s.latencyMs).toBeNull();
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

  it("認証なしのヘルス応答（capabilities なし）では unauthorized を解除しない", async () => {
    // Arrange：トークン不一致でも /v1/health は status と service だけを 200 で返す（§12）
    const health = createInitialHealth("running");
    const m = new BackendHealthMonitor(CONFIG, health, async () => json({ status: "ok", service: "minutes-local" }));
    m.reportUnauthorized();
    // Act
    const s = await m.checkOnce();
    // Assert
    expect(s.unauthorized).toBe(true);
    expect(health.degradedReasons).toContain("BACKEND_UNAUTHORIZED");
  });

  it("capabilities が null のヘルス応答では unauthorized を解除しない", async () => {
    // Arrange
    const health = createInitialHealth("running");
    const m = new BackendHealthMonitor(CONFIG, health, async () => json({ status: "ok", service: "minutes-local", capabilities: null }));
    m.reportUnauthorized();
    // Act
    const s = await m.checkOnce();
    // Assert
    expect(s.unauthorized).toBe(true);
  });

  it("unauthorized の解除は status が変わらなくても onChange で通知される（保存再開の契機）", async () => {
    let authorized = false;
    const m = new BackendHealthMonitor(CONFIG, createInitialHealth("running"), async () =>
      json(authorized ? { status: "ok", service: "minutes-local", capabilities: CAPS } : { status: "ok", service: "minutes-local" }),
    );
    await m.checkOnce(); // HEALTHY
    m.reportUnauthorized();
    await m.checkOnce(); // HEALTHY のまま unauthorized
    const seen: boolean[] = [];
    m.onChange((s) => seen.push(s.unauthorized));
    authorized = true;
    await m.checkOnce();
    expect(m.state.status).toBe("HEALTHY");
    expect(seen).toEqual([false]);
  });
});

describe("BackendHealthMonitor の定期ポーリング", () => {
  // 実時間を待たず、ポーリング間隔をフェイクタイマーで決定的に進める
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("実行中のチェックがある間に stop() しても、完了後にポーリングを再開しない", async () => {
    // Arrange
    let calls = 0;
    let release: () => void = () => undefined;
    const m = new BackendHealthMonitor({ ...CONFIG, healthyIntervalMs: 5, unreachableIntervalMs: 5 }, createInitialHealth("running"), async () => {
      calls++;
      await new Promise<void>((r) => {
        release = r;
      });
      return json({ status: "ok", service: "minutes-local" });
    });
    // Act
    m.start();
    m.stop();
    release();
    await vi.advanceTimersByTimeAsync(40);
    // Assert
    expect(calls).toBe(1);
  });

  it("start() を重ねて呼んでもポーリングは 1 系統だけ", async () => {
    let calls = 0;
    const m = new BackendHealthMonitor({ ...CONFIG, healthyIntervalMs: 1_000 }, createInitialHealth("running"), async () => {
      calls++;
      return json({ status: "ok", service: "minutes-local" });
    });
    m.start();
    m.start();
    await vi.advanceTimersByTimeAsync(20);
    m.stop();
    expect(calls).toBe(1);
  });
});
