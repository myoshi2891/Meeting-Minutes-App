import { describe, expect, it } from "vitest";
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
