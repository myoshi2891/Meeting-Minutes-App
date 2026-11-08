import { describe, expect, it, vi } from "vitest";
import { assertLocalHost, LocalSaver } from "../src/api/local-saver";
import type { AudioChunkRecord } from "../src/types/recording";
import { browserLikeFetch, makeChunkRecord } from "./harness";

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

  it("setToken 後の put は、生成時ではなく新しいトークンで Authorization を送る", async () => {
    // Arrange：Scheduler は送信前に saver を掴んでから IDB を待つので、その間に差し替わったトークンでも送れること
    const r = await makeChunkRecord("m1", 0, 160);
    const auths: (string | null)[] = [];
    const saver = saverWith(async (_input, init) => {
      auths.push(new Headers(init?.headers).get("Authorization"));
      return new Response(okBody(r), { status: 201 });
    });
    // Act
    saver.setToken("new-tok");
    await saver.put(r);
    // Assert
    expect(auths).toEqual(["Bearer new-tok"]);
  });

  it("送信中にトークンが変わって 401 になったら、失効として返さず新しいトークンで送り直す", async () => {
    // Arrange：古いトークンの PUT の応答待ち中に setToken される
    const r = await makeChunkRecord("m1", 0, 160);
    const auths: (string | null)[] = [];
    let saver: LocalSaver | undefined;
    saver = saverWith(async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      auths.push(auth);
      if (auth === "Bearer tok") {
        saver?.setToken("new-tok");
        return new Response(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }), { status: 401 });
      }
      return new Response(okBody(r), { status: 201 });
    });
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(outcome).toMatchObject({ ok: true, registered: true });
    expect(auths).toEqual(["Bearer tok", "Bearer new-tok"]);
  });

  it("401 の本文を読んでいる間にトークンが変わったら、失効として返さず新しいトークンで送り直す", async () => {
    // Arrange：本文の読み出し時に setToken される
    const r = await makeChunkRecord("m1", 0, 160);
    const auths: (string | null)[] = [];
    let saver: LocalSaver | undefined;
    saver = saverWith(async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      auths.push(auth);
      if (auth !== "Bearer tok") return new Response(okBody(r), { status: 201 });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          saver?.setToken("new-tok");
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" })));
          controller.close();
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: 401 });
    });
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(outcome).toMatchObject({ ok: true, registered: true });
    expect(auths).toEqual(["Bearer tok", "Bearer new-tok"]);
  });

  it("送り直し中にもトークンが変わったら、失効ではなく再試行できる失敗で返す", async () => {
    // Arrange：送るたびにトークンが差し替わる
    const r = await makeChunkRecord("m1", 0, 160);
    let n = 0;
    let saver: LocalSaver | undefined;
    saver = saverWith(async () => {
      saver?.setToken(`tok-${++n}`);
      return new Response("{}", { status: 403 });
    });
    // Act
    const outcome = await saver.put(r);
    // Assert：送り直しは 1 回だけ。Scheduler が上限に数えず送り直せるよう、トークン変更による失敗と分かる印を付ける
    expect(outcome).toMatchObject({ ok: false, retryable: true, tokenChanged: true, error: { kind: "UNKNOWN" } });
    expect(n).toBe(2);
  });

  it("送り直し前の会議確認を待つ間にトークンが変わったら、確認後の最新トークンで送る", async () => {
    // Arrange：最初の PUT 中に tok → tok-2、送り直し前の ensureMeeting 中に tok-2 → tok-3。サーバーは tok-3 だけ受け付ける
    const r = await makeChunkRecord("m1", 0, 160);
    const sent: string[] = [];
    let ensures = 0;
    let saver: LocalSaver | undefined;
    const ensure = async () => {
      if (++ensures === 2) saver?.setToken("tok-3");
      return { ok: true as const };
    };
    saver = new LocalSaver({ baseUrl: BASE, token: "tok", requestTimeoutMs: 1000 }, async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      sent.push(auth);
      if (sent.length === 1) saver?.setToken("tok-2");
      return auth === "Bearer tok-3" ? new Response(okBody(r), { status: 201 }) : new Response("{}", { status: 401 });
    }, ensure);
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(sent).toEqual(["Bearer tok", "Bearer tok-3"]);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("トークン変更で送り直す前に会議の送信可否を確かめ、確定中止されていれば PUT しない", async () => {
    // Arrange：最初の PUT の応答待ち中にトークンが変わり、同時に会議が確定中止された
    const r = await makeChunkRecord("m1", 0, 160);
    let puts = 0;
    let abandoned = false;
    let saver: LocalSaver | undefined;
    const ensure = async () => abandoned
      ? { ok: false as const, retryable: false, error: { kind: "VALIDATION" as const, message: "meeting abandoned", httpStatus: null, at: 0 } }
      : { ok: true as const };
    saver = new LocalSaver({ baseUrl: BASE, token: "tok", requestTimeoutMs: 1000 }, async () => {
      puts++;
      saver?.setToken("new-tok");
      abandoned = true;
      return new Response("{}", { status: 401 });
    }, ensure);
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(puts).toBe(1);
    expect(outcome).toMatchObject({ ok: false, retryable: false, error: { kind: "VALIDATION", message: "meeting abandoned" } });
  });

  it("トークンが変わっていない 401 は UNAUTHORIZED で返す", async () => {
    const r = await makeChunkRecord("m1", 0, 160);
    const saver = saverWith(async () => new Response("{}", { status: 401 }));
    expect(await saver.put(r)).toMatchObject({ ok: false, retryable: false, error: { kind: "UNAUTHORIZED", httpStatus: 401 } });
  });

  it("ブラウザの fetch を渡してもメソッド呼び出しにせず PUT を送る（Illegal invocation にならない）", async () => {
    // Arrange
    const r = await makeChunkRecord("m1", 0, 160);
    const saver = saverWith(browserLikeFetch(async () => new Response(okBody(r), { status: 201 })));
    // Act
    const outcome = await saver.put(r);
    // Assert
    expect(outcome).toEqual({ ok: true, registered: true, serverPath: "recordings/x.wav", idempotent: false });
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
    // 実時間を待たない。タイマーだけ偽装し、fetch の abort を requestTimeoutMs 経過で発火させる
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = saverWith(hanging, 20).put(r);
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ ok: false, retryable: true, error: { kind: "TIMEOUT" } });
    } finally {
      vi.useRealTimers();
    }
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
