import { describe, expect, it } from "vitest";
import { assertLocalHost, LocalSaver } from "../src/api/local-saver";
import type { AudioChunkRecord } from "../src/types/recording";
import { makeChunkRecord } from "./harness";

const BASE = "http://127.0.0.1:43117";

function okBody(r: AudioChunkRecord, override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    meetingId: r.meta.meetingId,
    source: r.meta.source,
    sequenceNo: r.meta.sequenceNo,
    sha256: r.meta.sha256,
    sizeBytes: r.meta.sizeBytes,
    path: "recordings/x.wav",
    registered: true,
    ...override,
  });
}

function saverWith(fetchImpl: typeof fetch, requestTimeoutMs = 1000): LocalSaver {
  return new LocalSaver({ baseUrl: BASE, token: "tok", requestTimeoutMs }, fetchImpl);
}

describe("assertLocalHost", () => {
  it.each(["http://127.0.0.1:43117/x", "http://localhost:43117", "http://[::1]:43117/"])("%s は許可", (u) => {
    expect(() => assertLocalHost(new URL(u))).not.toThrow();
  });

  it.each(["https://example.com/", "http://192.168.1.10:43117", "http://127.0.0.1.nip.io/"])("%s は外部ホストとして拒否", (u) => {
    expect(() => assertLocalHost(new URL(u))).toThrow("disallowed host");
  });

  it("http/https 以外のプロトコルは拒否", () => {
    expect(() => assertLocalHost(new URL("file:///tmp/x"))).toThrow("disallowed protocol");
  });

  it("LocalSaver は外部 baseUrl で生成できない", () => {
    expect(() => new LocalSaver({ baseUrl: "https://api.example.com", token: "t", requestTimeoutMs: 1 })).toThrow();
  });
});

describe("LocalSaver.put", () => {
  it("PUT は論理キー URL・Bearer・sha256/meta ヘッダ付きで送られ、201 は非冪等の成功", async () => {
    // Arrange
    const r = await makeChunkRecord("m1", 4, 160);
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const saver = saverWith(async (input, init) => {
      captured = { url: String(input), init };
      return new Response(okBody(r), { status: 201 });
    });
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(outcome).toEqual({ ok: true, registered: true, serverPath: "recordings/x.wav", idempotent: false });
    expect(captured).not.toBeNull();
    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe(`${BASE}/v1/meetings/m1/chunks/mic/4`);
    expect(c.init.method).toBe("PUT");
    const headers = new Headers(c.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("X-Chunk-SHA256")).toBe(r.meta.sha256);
    expect(headers.get("X-Chunk-Meta")).not.toBeNull();
    // リダイレクトに従うと録音データを外部ホストへ再送しうるので、追従せずエラーにする（§4.4）
    expect(c.init.redirect).toBe("error");
  });

  it("200 は冪等再送として成功扱い", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const outcome = await saverWith(async () => new Response(okBody(r), { status: 200 })).put(r);
    expect(outcome.ok && outcome.idempotent).toBe(true);
  });

  it("2xx でもサーバー側ハッシュが異なれば HASH_MISMATCH（retryable）", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const outcome = await saverWith(async () => new Response(okBody(r, { sha256: "0".repeat(64) }), { status: 201 })).put(r);
    expect(outcome).toMatchObject({ ok: false, retryable: true, error: { kind: "HASH_MISMATCH" } });
  });

  it("別 Chunk の応答（sequenceNo 不一致）は SERVER エラー", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const outcome = await saverWith(async () => new Response(okBody(r, { sequenceNo: 9 }), { status: 201 })).put(r);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "SERVER" } });
  });

  it("壊れた JSON 応答は SERVER エラー", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const outcome = await saverWith(async () => new Response("not json", { status: 201 })).put(r);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "SERVER" } });
  });

  it.each([
    [401, "UNAUTHORIZED", false],
    [403, "UNAUTHORIZED", false],
    [409, "CONFLICT", false],
    [422, "VALIDATION", false],
    [400, "VALIDATION", false],
    [507, "STORAGE_FULL", true],
    [500, "SERVER", true],
    [503, "SERVER", true],
    [418, "UNKNOWN", false],
    [404, "UNKNOWN", false],
    [413, "UNKNOWN", false],
    [408, "UNKNOWN", true],
    [429, "UNKNOWN", true],
  ] as const)("HTTP %i は %s（retryable=%s）", async (status, kind, retryable) => {
    const r = await makeChunkRecord("m1", 0, 160);
    const body = JSON.stringify({ error: "e", code: "INTERNAL" });
    const outcome = await saverWith(async () => new Response(body, { status })).put(r);
    expect(outcome).toMatchObject({ ok: false, retryable, error: { kind, httpStatus: status } });
  });

  it("接続不能（TypeError）は NETWORK", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const outcome = await saverWith(async () => {
      throw new TypeError("Failed to fetch");
    }).put(r);
    expect(outcome).toMatchObject({ ok: false, retryable: true, error: { kind: "NETWORK", httpStatus: null } });
  });

  it("応答しないサーバーは requestTimeoutMs で TIMEOUT", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const outcome = await saverWith(hanging, 20).put(r);
    expect(outcome).toMatchObject({ ok: false, retryable: true, error: { kind: "TIMEOUT" } });
  });

  it("Blob がクォータ縮退で削除済みなら送信せず VALIDATION", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    r.wav = null;
    let called = false;
    const outcome = await saverWith(async () => {
      called = true;
      return new Response(null, { status: 500 });
    }).put(r);
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ ok: false, retryable: false, error: { kind: "VALIDATION" } });
  });
});
