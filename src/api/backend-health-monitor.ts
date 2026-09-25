// src/api/backend-health-monitor.ts
import { isHealthResponse } from "./contracts";
import { assertLocalHost } from "./local-saver";
import type { DegradedReason, LocalBackendHealth, RecordingHealth } from "../types/recording";

export interface BackendHealthMonitorConfig {
  readonly baseUrl: string;
  readonly token: () => string | null;
  readonly healthyIntervalMs: number;     // 既定 10000
  readonly unreachableIntervalMs: number; // 既定 5000
  readonly timeoutMs: number;             // 既定 2000
  readonly degradedLatencyMs: number;     // 既定 1000。これを超える応答は DEGRADED
}

export class BackendHealthMonitor {
  readonly state: LocalBackendHealth = {
    status: "UNKNOWN",
    lastCheckedAt: 0,
    lastHealthyAt: null,
    latencyMs: null,
    consecutiveFailures: 0,
    capabilities: null,
    unauthorized: false,
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** start() 〜 stop() の間だけ true。実行中のチェックが stop() 後にポーリングを再開しないための判定に使う。 */
  private polling = false;
  /** start()/stop() ごとに進める世代番号。stop() → start() を挟んだ古いチェックが 2 本目のループを作らないために使う。 */
  private generation = 0;
  /** 最後に onChange で通知した (status, unauthorized)。どちらかが変わったら通知する。 */
  private notified: { status: LocalBackendHealth["status"]; unauthorized: boolean } = { status: "UNKNOWN", unauthorized: false };
  private readonly listeners = new Set<(state: LocalBackendHealth) => void>();
  private readonly healthUrl: URL;

  constructor(
    private readonly config: BackendHealthMonitorConfig,
    private readonly recordingHealth: RecordingHealth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.healthUrl = new URL("/v1/health", config.baseUrl);
    assertLocalHost(this.healthUrl);
  }

  onChange(listener: (state: LocalBackendHealth) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.generation++;
    void this.checkAndSchedule(this.generation);
  }

  stop(): void {
    this.polling = false;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** PUT 失敗時に Scheduler から呼ばれる。ポーリングを待たず UNREACHABLE にする。 */
  reportUnreachable(): void {
    this.transition("UNREACHABLE", null, null);
  }

  /** PUT が 401/403 を受けたときに Scheduler から呼ばれる。認証付きのヘルス応答が返るまで unauthorized を保持する。 */
  reportUnauthorized(): void {
    this.state.unauthorized = true;
    this.transition("UNREACHABLE", null, null);
  }

  async checkOnce(): Promise<LocalBackendHealth> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const token = this.config.token();
      const headers: Record<string, string> = {};
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(this.healthUrl, { method: "GET", headers, signal: controller.signal, credentials: "omit" });
      const latency = performance.now() - started;

      if (response.status === 401 || response.status === 403) {
        this.state.unauthorized = true;
        this.transition("UNREACHABLE", latency, null);
        return this.state;
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isHealthResponse(body)) {
        // 別プロセスが同じポートで HTTP を返しているケースは service 識別子で弾く
        this.transition("UNREACHABLE", latency, null);
        return this.state;
      }
      // capabilities は認証済みのときだけ返る（§12）。認証なしの応答ではトークンの正しさを判断できないので unauthorized を解除しない
      if (body.capabilities !== undefined) this.state.unauthorized = false;
      const status = body.status === "degraded" || latency > this.config.degradedLatencyMs ? "DEGRADED" : "HEALTHY";
      this.transition(status, latency, body.capabilities ?? null);
      return this.state;
    } catch {
      // AbortError（タイムアウト）/ TypeError（接続不能）いずれも UNREACHABLE
      this.transition("UNREACHABLE", null, null);
      return this.state;
    } finally {
      clearTimeout(timer);
      this.state.lastCheckedAt = performance.now();
      this.recordingHealth.lastBackendHealthCheckAt = this.state.lastCheckedAt;
    }
  }

  private transition(status: LocalBackendHealth["status"], latency: number | null, caps: LocalBackendHealth["capabilities"]): void {
    this.state.status = status;
    this.state.latencyMs = latency;
    this.state.capabilities = caps ?? this.state.capabilities;
    if (status === "HEALTHY" || status === "DEGRADED") {
      this.state.lastHealthyAt = performance.now();
      this.state.consecutiveFailures = 0;
    } else {
      this.state.consecutiveFailures += 1;
    }
    this.syncDegradedReasons();
    // unauthorized の解除は status が HEALTHY のまま起こりうる。保存再開の契機を逃さないよう両方の変化を通知する
    if (this.notified.status !== status || this.notified.unauthorized !== this.state.unauthorized) {
      this.notified = { status, unauthorized: this.state.unauthorized };
      for (const l of this.listeners) l(this.state);
    }
  }

  private syncDegradedReasons(): void {
    const reasons: DegradedReason[] = this.recordingHealth.degradedReasons.filter(
      (r) => r !== "BACKEND_UNREACHABLE" && r !== "BACKEND_DEGRADED" && r !== "BACKEND_UNAUTHORIZED",
    );
    if (this.state.unauthorized) reasons.push("BACKEND_UNAUTHORIZED");
    else if (this.state.status === "UNREACHABLE") reasons.push("BACKEND_UNREACHABLE");
    else if (this.state.status === "DEGRADED") reasons.push("BACKEND_DEGRADED");
    this.recordingHealth.degradedReasons = reasons;
  }

  private async checkAndSchedule(generation: number): Promise<void> {
    await this.checkOnce();
    if (!this.polling || generation !== this.generation) return;
    const interval = this.state.status === "UNREACHABLE" ? this.config.unreachableIntervalMs : this.config.healthyIntervalMs;
    // バックグラウンドタブで throttle されても可用性「表示」が遅れるだけで、録音には影響しない（Invariant 8 と同じ構造）。
    this.timer = setTimeout(() => void this.checkAndSchedule(generation), interval);
  }
}
