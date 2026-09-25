// src/api/local-saver.ts
import { encodeChunkMetaHeader, isChunkResponse, type ApiErrorBody } from "./contracts";
import type { AudioChunkRecord, LocalSaveError, LocalSaveErrorKind } from "../types/recording";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 外部ホストへの通信を実装レベルで遮断する（CSP の二重防御、§4.4）。 */
export function assertLocalHost(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`disallowed protocol: ${url.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`disallowed host: ${url.hostname}`);
  }
}

export interface LocalSaverConfig {
  readonly baseUrl: string;      // 例: "http://127.0.0.1:43117"
  readonly token: string;
  readonly requestTimeoutMs: number; // 既定 30000。1MB のローカル書き込みには十分
}

export type SaveOutcome =
  | { readonly ok: true; readonly registered: boolean; readonly serverPath: string; readonly idempotent: boolean }
  | { readonly ok: false; readonly error: LocalSaveError; readonly retryable: boolean };

const RETRYABLE: ReadonlySet<LocalSaveErrorKind> = new Set(["NETWORK", "TIMEOUT", "SERVER", "STORAGE_FULL", "HASH_MISMATCH", "UNKNOWN"]);

export class LocalSaver {
  private readonly base: URL;

  constructor(private readonly config: LocalSaverConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = new URL(config.baseUrl);
    assertLocalHost(this.base);
  }

  async put(record: AudioChunkRecord): Promise<SaveOutcome> {
    if (record.wav === null) {
      return this.fail("VALIDATION", "wav blob already dropped", null);
    }
    const { meetingId, source, sequenceNo } = record.meta;
    const url = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/chunks/${source}/${sequenceNo}`, this.base);
    assertLocalHost(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "audio/wav",
          "X-Chunk-SHA256": record.meta.sha256,
          "X-Chunk-Meta": encodeChunkMetaHeader(record.meta),
        },
        body: record.wav,
        signal: controller.signal,
        // ローカルサーバーなので credentials は不要。Cookie 方式（§4.3）の場合のみ "include"。
        credentials: "omit",
      });
      return await this.interpret(response, record);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return this.fail("TIMEOUT", `timeout after ${this.config.requestTimeoutMs}ms`, null);
      }
      // fetch の接続失敗は TypeError。サーバー未起動・ポート閉塞・CSP 拒否がここに来る。
      if (error instanceof TypeError) {
        return this.fail("NETWORK", error.message, null);
      }
      return this.fail("UNKNOWN", error instanceof Error ? error.message : String(error), null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async interpret(response: Response, record: AudioChunkRecord): Promise<SaveOutcome> {
    const status = response.status;
    const { meetingId, source, sequenceNo } = record.meta;
    if (status === 200 || status === 201) {
      const body: unknown = await response.json().catch(() => null);
      if (!isChunkResponse(body)) {
        return this.fail("SERVER", "malformed ChunkResponse", status);
      }
      // 応答が「いま送った Chunk のもの」であることを先に確かめる。別の会議・別トラック・別 seq の
      // 応答を受けると、他 Chunk の path を registered として記録することになる。
      // isChunkResponse は 3 フィールドしか見ないので、serverPath に使う path の型もここで確定させる
      if (body.meetingId !== meetingId || body.source !== source || body.sequenceNo !== sequenceNo || typeof body.path !== "string") {
        return this.fail("SERVER", `ChunkResponse mismatch: server=${body.meetingId}/${body.source}/${body.sequenceNo} local=${meetingId}/${source}/${sequenceNo}`, status);
      }
      // v4.0 §93 相当：2xx だけでなくハッシュとサイズを照合する
      if (body.sha256 !== record.meta.sha256 || body.sizeBytes !== record.meta.sizeBytes) {
        return this.fail("HASH_MISMATCH", `server=${body.sha256}/${body.sizeBytes} local=${record.meta.sha256}/${record.meta.sizeBytes}`, status);
      }
      return { ok: true, registered: body.registered, serverPath: body.path, idempotent: status === 200 };
    }
    const errBody: unknown = await response.json().catch(() => null);
    const detail = isApiErrorBody(errBody) ? `${errBody.code}: ${errBody.error}` : `HTTP ${status}`;
    if (status === 401 || status === 403) return this.fail("UNAUTHORIZED", detail, status);
    if (status === 409) return this.fail("CONFLICT", detail, status);
    if (status === 400 || status === 422) return this.fail("VALIDATION", detail, status);
    if (status === 507) return this.fail("STORAGE_FULL", detail, status);
    if (status >= 500) return this.fail("SERVER", detail, status);
    return this.fail("UNKNOWN", detail, status);
  }

  private fail(kind: LocalSaveErrorKind, message: string, httpStatus: number | null): SaveOutcome {
    return {
      ok: false,
      error: { kind, message, httpStatus, at: performance.now() },
      retryable: isRetryableError({ kind, httpStatus }),
    };
  }
}

/** 同じリクエストを送り直せば結果が変わりうる失敗か。LocalSaver.fail と Scheduler の再投入判定（resumeAll）で共有する。 */
export function isRetryableError(error: Pick<LocalSaveError, "kind" | "httpStatus">): boolean {
  return RETRYABLE.has(error.kind) && !isNonRetryableClientError(error.httpStatus);
}

/** 408 / 429 を除く 4xx は同じリクエストを送り直しても結果が変わらない（kind が UNKNOWN でも再試行しない）。 */
function isNonRetryableClientError(httpStatus: number | null): boolean {
  if (httpStatus === null || httpStatus < 400 || httpStatus >= 500) return false;
  return httpStatus !== 408 && httpStatus !== 429;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.error === "string" && typeof v.code === "string";
}
