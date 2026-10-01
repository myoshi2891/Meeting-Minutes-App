// src/api/meeting-registrar.ts
import type { CreateMeetingRequest, MeetingResponse } from "./contracts";
import { assertLocalHost, isRetryableError } from "./local-saver";
import type { MeetingRecord, LocalSaveError, LocalSaveErrorKind } from "../types/recording";

export type RegistrationOutcome = { readonly ok: true } | { readonly ok: false; readonly error: LocalSaveError; readonly retryable: boolean };

export interface MeetingRegistrarDeps {
  readonly baseUrl: string;
  readonly token: () => string | null;
  readonly getMeeting: (meetingId: string) => Promise<MeetingRecord | undefined>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** PUT とメモリからの直接送信が共用する会議登録。並行する同一会議の POST だけ束ねる。 */
export class MeetingRegistrar {
  private readonly inFlight = new Map<string, Promise<RegistrationOutcome>>();

  constructor(private readonly deps: MeetingRegistrarDeps) {
    assertLocalHost(new URL(deps.baseUrl));
  }

  ensure(meetingId: string): Promise<RegistrationOutcome> {
    const running = this.inFlight.get(meetingId);
    if (running !== undefined) return running;
    const promise = this.register(meetingId).finally(() => this.inFlight.delete(meetingId));
    this.inFlight.set(meetingId, promise);
    return promise;
  }

  private async register(meetingId: string): Promise<RegistrationOutcome> {
    let meeting: MeetingRecord | undefined;
    try {
      meeting = await this.deps.getMeeting(meetingId);
    } catch (error) {
      return this.fail("UNKNOWN", error instanceof Error ? error.message : "meeting lookup failed", null);
    }
    if (meeting === undefined) return this.fail("VALIDATION", "local meeting not found", 422);
    const body: CreateMeetingRequest = {
      meetingId: meeting.meetingId,
      title: meeting.title,
      sessionStartEpochMs: meeting.sessionClock.sessionStartEpochMs,
      nativeSampleRate: meeting.sessionClock.nativeSampleRate,
      consentConfirmedAt: meeting.consentConfirmedAt,
    };
    const url = new URL("/v1/meetings", this.deps.baseUrl);
    assertLocalHost(url);
    let token = this.deps.token();
    if (token === null) return this.fail("UNAUTHORIZED", "backend token is not set", null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    // ブラウザの fetch はメソッドとして呼ぶと Illegal invocation になるため、取り出してから呼ぶ
    const { fetchImpl } = this.deps;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 200 || response.status === 201) {
          const value: unknown = await response.json().catch(() => null);
          if (!isMeetingResponse(value) || value.meetingId !== meetingId) return this.fail("SERVER", "malformed MeetingResponse", response.status);
          return { ok: true };
        }
        const latestToken = this.deps.token();
        if ((response.status === 401 || response.status === 403) && latestToken !== null && latestToken !== token && attempt === 0) {
          token = latestToken;
          continue;
        }
        if (response.status === 401 || response.status === 403) return this.fail("UNAUTHORIZED", `meeting registration HTTP ${response.status}`, response.status);
        if (response.status === 409) return this.fail("CONFLICT", "meeting registration conflict", response.status);
        if (response.status === 400 || response.status === 422) return this.fail("VALIDATION", `meeting registration HTTP ${response.status}`, response.status);
        if (response.status === 507) return this.fail("STORAGE_FULL", "meeting registration disk full", response.status);
        return this.fail(response.status >= 500 ? "SERVER" : "UNKNOWN", `meeting registration HTTP ${response.status}`, response.status);
      }
      return this.fail("UNAUTHORIZED", "meeting registration token changed", 401);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return this.fail("TIMEOUT", "meeting registration timeout", null);
      if (error instanceof TypeError) return this.fail("NETWORK", error.message, null);
      return this.fail("UNKNOWN", error instanceof Error ? error.message : String(error), null);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(kind: LocalSaveErrorKind, message: string, httpStatus: number | null): RegistrationOutcome {
    const error: LocalSaveError = { kind, message, httpStatus, at: performance.now() };
    return { ok: false, error, retryable: isRetryableError(error) };
  }
}

function isMeetingResponse(value: unknown): value is MeetingResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.meetingId === "string" && typeof v.dataPath === "string" &&
    (v.status === "created" || v.status === "recording" || v.status === "finalizing" || v.status === "finalized");
}
