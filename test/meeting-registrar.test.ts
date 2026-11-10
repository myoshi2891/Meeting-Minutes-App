import { describe, expect, it, vi } from "vitest";
import { MeetingRegistrar } from "../src/api/meeting-registrar";
import type { MeetingRecord } from "../src/types/recording";
import { browserLikeFetch } from "./harness";

const meeting: MeetingRecord = {
  meetingId: "m-registration", title: "定例", status: "recording",
  sessionClock: { sessionStartEpochMs: 123, performanceTimeOrigin: 0, sessionStartPerformanceMs: 0,
    audioContextStartTime: 0, nativeSampleRate: 48000, audioFrameCount: 0 },
  consentConfirmedAt: 100, createdAt: 123, updatedAt: 123, endedAt: null, finalChunkCount: null,
};

describe("MeetingRegistrar", () => {
  it("登録中にトークンが変わって401になったら、新トークンで登録をやり直す", async () => {
    let token = "old";
    const auths: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      auths.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (auths.length === 1) {
        token = "new";
        return new Response(null, { status: 401 });
      }
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ meetingId: meeting.meetingId, sessionStartEpochMs: 123, nativeSampleRate: 48000 });
      return new Response(JSON.stringify({ meetingId: meeting.meetingId, status: "recording", dataPath: "recordings/m-registration" }), { status: 201 });
    };
    const registrar = new MeetingRegistrar({ baseUrl: "http://127.0.0.1:43117", token: () => token,
      getMeeting: async () => meeting, fetchImpl, timeoutMs: 1000 });
    expect(await registrar.ensure(meeting.meetingId)).toEqual({ ok: true });
    expect(auths).toEqual(["Bearer old", "Bearer new"]);
  });

  it("再送の 401 でもトークンがさらに変わっていれば、認証エラーにせず再試行できる失敗にする", async () => {
    // Arrange：応答が返るたびに設定画面でトークンが更新される
    let generation = 0;
    const auths: string[] = [];
    const onBackendUnauthorized = vi.fn();
    const fetchImpl: typeof fetch = async (_input, init) => {
      auths.push(new Headers(init?.headers).get("Authorization") ?? "");
      generation++;
      return new Response(null, { status: 401 });
    };
    const registrar = new MeetingRegistrar({ baseUrl: "http://127.0.0.1:43117", token: () => `token-${generation}`,
      getMeeting: async () => meeting, fetchImpl, timeoutMs: 1000, onBackendUnauthorized });
    // Act
    const outcome = await registrar.ensure(meeting.meetingId);
    // Assert
    expect(auths).toEqual(["Bearer token-0", "Bearer token-1"]);
    expect(onBackendUnauthorized).not.toHaveBeenCalled();
    // Scheduler が試行上限に数えず送り直せるよう、トークン変更による失敗と分かる印を付ける
    expect(outcome).toMatchObject({ ok: false, retryable: true, tokenChanged: true });
    expect(outcome.ok === false && outcome.error.kind).not.toBe("UNAUTHORIZED");
  });

  it.each([401, 403])("現在のトークンへの %s は認証エラーとして通知する", async (status) => {
    // Arrange
    const onBackendUnauthorized = vi.fn();
    const registrar = new MeetingRegistrar({ baseUrl: "http://127.0.0.1:43117", token: () => "tok",
      getMeeting: async () => meeting, fetchImpl: async () => new Response(null, { status }), timeoutMs: 1000, onBackendUnauthorized });
    // Act
    const outcome = await registrar.ensure(meeting.meetingId);
    // Assert
    expect(onBackendUnauthorized).toHaveBeenCalledOnce();
    // Scheduler・直接送信が同じ 401/403 を Monitor へ二重に報告しないよう、報告済みの印を付ける
    expect(outcome).toMatchObject({ ok: false, retryable: false, unauthorizedReported: true, error: { kind: "UNAUTHORIZED" } });
  });

  it("トークン変更で送り直す POST は、前の POST の待ち時間に関係なく自分のタイムアウトを持つ", async () => {
    // Arrange：1 回目は 800ms 後に 401（その間にトークン変更）、2 回目は 500ms 後に 201。どちらも単独ではタイムアウト 1000ms 内
    vi.useFakeTimers();
    try {
      let token = "old";
      let calls = 0;
      const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((resolve, reject) => {
        calls++;
        const first = calls === 1;
        const timer = setTimeout(() => {
          if (first) {
            token = "new";
            resolve(new Response(null, { status: 401 }));
          } else {
            resolve(new Response(JSON.stringify({ meetingId: meeting.meetingId, status: "recording", dataPath: "recordings/m-registration" }), { status: 201 }));
          }
        }, first ? 800 : 500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      const registrar = new MeetingRegistrar({ baseUrl: "http://127.0.0.1:43117", token: () => token,
        getMeeting: async () => meeting, fetchImpl, timeoutMs: 1000 });
      // Act
      const pending = registrar.ensure(meeting.meetingId);
      await vi.advanceTimersByTimeAsync(2000);
      // Assert
      expect(await pending).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ブラウザの fetch を渡してもメソッド呼び出しにせず POST を送る（Illegal invocation にならない）", async () => {
    // Arrange
    const fetchImpl = browserLikeFetch(async () =>
      new Response(JSON.stringify({ meetingId: meeting.meetingId, status: "recording", dataPath: "recordings/m-registration" }), { status: 201 }));
    const registrar = new MeetingRegistrar({ baseUrl: "http://127.0.0.1:43117", token: () => "tok",
      getMeeting: async () => meeting, fetchImpl, timeoutMs: 1000 });
    // Act
    const outcome = await registrar.ensure(meeting.meetingId);
    // Assert
    expect(outcome).toEqual({ ok: true });
  });
});
