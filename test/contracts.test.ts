import { describe, expect, it } from "vitest";
import { encodeChunkMetaHeader, isChunkListResponse, isChunkResponse, isHealthResponse } from "../src/api/contracts";
import { makeChunkRecord } from "./harness";

describe("isChunkResponse", () => {
  it("sha256 / sizeBytes / registered が揃えば true", () => {
    expect(isChunkResponse({ sha256: "a", sizeBytes: 1, registered: true })).toBe(true);
  });

  it.each([null, "x", { sha256: "a", sizeBytes: "1", registered: true }, { sha256: "a", sizeBytes: 1 }])("%j は false", (v) => {
    expect(isChunkResponse(v)).toBe(false);
  });
});

describe("isHealthResponse", () => {
  it("service=minutes-local かつ status が ok/degraded なら true", () => {
    expect(isHealthResponse({ status: "ok", service: "minutes-local" })).toBe(true);
    expect(isHealthResponse({ status: "degraded", service: "minutes-local" })).toBe(true);
  });

  it("同じポートの別サービス（service 不一致）は false", () => {
    expect(isHealthResponse({ status: "ok", service: "other-app" })).toBe(false);
    expect(isHealthResponse({ status: "down", service: "minutes-local" })).toBe(false);
  });
});

describe("encodeChunkMetaHeader", () => {
  it("Base64URL（+ / = を含まない）で、デコードすると元の JSON に戻る（非 ASCII の meetingId を含む）", async () => {
    const { meta } = await makeChunkRecord("会議-ü", 3, 16);
    const encoded = encodeChunkMetaHeader(meta);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const json = new TextDecoder().decode(Buffer.from(encoded, "base64url"));
    expect(JSON.parse(json)).toEqual(meta);
  });
});

describe("isChunkListResponse", () => {
  const item = { source: "mic", sequenceNo: 0, sha256: "a", sizeBytes: 1, registered: true };

  it("chunks 配列の各要素が source / sequenceNo / sha256 / sizeBytes / registered を持てば true（空配列も可）", () => {
    expect(isChunkListResponse({ meetingId: "m", chunks: [item] })).toBe(true);
    expect(isChunkListResponse({ meetingId: "m", chunks: [] })).toBe(true);
  });

  it.each([
    null,
    { meetingId: "m" },
    { meetingId: "m", chunks: "x" },
    { meetingId: "m", chunks: [{ ...item, source: "speaker" }] },
    { meetingId: "m", chunks: [{ ...item, sequenceNo: "0" }] },
    { meetingId: "m", chunks: [{ ...item, registered: undefined }] },
  ])("%j は false", (v) => {
    expect(isChunkListResponse(v)).toBe(false);
  });
});
