// src/recording/finalizer.ts
import type { ChunkStore, MeetingStore } from "../storage/idb";
import type { LocalSaveScheduler } from "./local-save-scheduler";
import { isChunkListResponse, type FinalizeRequest } from "../api/contracts";
import { assertLocalHost } from "../api/local-saver";
import type { AudioChunkRecord } from "../types/recording";
import { frameToOffsetMs } from "./session-clock";

export interface FinalizerDeps {
  readonly chunkStore: ChunkStore;
  readonly meetingStore: MeetingStore;
  readonly scheduler: LocalSaveScheduler;
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** GET /chunks と POST /finalize それぞれのタイムアウト。既定 30000ms */
  readonly timeoutMs?: number;
  /** IDB に書けずメモリ待機中の Chunk 数（RecordingController.memoryBacklogCount）。0 でない限り Barrier を通さない。 */
  readonly unpersistedChunkCount: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export type FinalizeResult =
  /** missingTailMs：末尾の Chunk が欠けたまま確定した長さ（ms）。欠けがなければ省く（T1-e） */
  | { readonly ok: true; readonly missingTailMs?: number }
  | { readonly ok: false; readonly stage: "waiting_local_save" | "verify" | "finalize"; readonly detail: string };

/**
 * Finalization Barrier：
 *   1. 最終 Chunk が IDB にある（呼び出し前提：RecordingController.stop() 完了）かつメモリ待機中の Chunk がない
 *   2. IDB 上の全 Chunk が DB_REGISTERED（SAVED はサーバー一覧で登録確認できれば DB_REGISTERED に進める）
 *   3. サーバーの一覧と件数・sha256 が一致（IDB にない連番は、サーバーに登録済みなら揃っているとみなす）
 *   4. POST /finalize
 * 1〜3 を満たさない限り finalizing へ遷移しない。
 */
export function finalizeMeeting(deps: FinalizerDeps, meetingId: string): Promise<FinalizeResult> {
  // 同じ会議への呼び出しが重なると、両方が stop_requested を読んで二重に POST し、
  // 後から失敗した側が finalized を stop_requested で上書きしうる。実行中の Promise を共有して 1 本にする
  const running = inProgress.get(meetingId);
  if (running !== undefined) return running;
  const promise = finalizeMeetingOnce(deps, meetingId).finally(() => inProgress.delete(meetingId));
  inProgress.set(meetingId, promise);
  return promise;
}

/** meetingId → 実行中の finalize。同じタブ内の重複呼び出しだけを束ねる */
const inProgress = new Map<string, Promise<FinalizeResult>>();

async function finalizeMeetingOnce(deps: FinalizerDeps, meetingId: string): Promise<FinalizeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const meeting = await deps.meetingStore.get(meetingId);
  if (meeting === undefined) return { ok: false, stage: "verify", detail: "meeting not found" };
  // 二重に POST /finalize して endedAt を書き換えない
  if (meeting.status === "finalized") return { ok: true };
  // recording 中は最終 Chunk が IDB にある前提（stop() 完了）を満たさない。finalizing は POST 中に中断された会議の再試行
  if (meeting.status !== "stop_requested" && meeting.status !== "finalizing") {
    return { ok: false, stage: "verify", detail: `meeting status is ${meeting.status}` };
  }

  // 末尾の Chunk がメモリ待機中だと IDB 上は欠番なしに見えるため、件数不足のまま finalize しないよう先に弾く
  const unpersisted = deps.unpersistedChunkCount();
  if (unpersisted > 0) {
    return { ok: false, stage: "waiting_local_save", detail: `${unpersisted} chunks not persisted to IDB` };
  }

  const chunks = await deps.chunkStore.listByMeeting(meetingId, "mic");
  // SAVED（ファイル保存済み・DB 未登録）は再送しても registered: false が続きうるため、サーバー一覧で確認する
  const notRegistered = chunks.filter((c) => c.save.status !== "DB_REGISTERED" && c.save.status !== "SAVED");
  if (notRegistered.length > 0) {
    await deps.scheduler.resumeAll();
    return { ok: false, stage: "waiting_local_save", detail: `${notRegistered.length} chunks not registered` };
  }

  const listUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/chunks`, deps.baseUrl);
  assertLocalHost(listUrl);
  // タイムアウトで abort すると fetch / json() が reject し、既存のエラー経路で Result になる
  const listAbort = new AbortController();
  const listTimer = setTimeout(() => listAbort.abort(), timeoutMs);
  let listRes: Response;
  let list: unknown;
  try {
    listRes = await fetchImpl(listUrl, { headers: { Authorization: `Bearer ${deps.token}` }, credentials: "omit", redirect: "error", signal: listAbort.signal });
    // サーバー応答は外部入力。型ガードを通してから使う（壊れた JSON も Result で返す）
    list = listRes.ok ? await listRes.json().catch(() => null) : null;
  } catch (error) {
    return { ok: false, stage: "verify", detail: `list request failed: ${errorMessage(error)}` };
  } finally {
    clearTimeout(listTimer);
  }
  if (!listRes.ok) return { ok: false, stage: "verify", detail: `list HTTP ${listRes.status}` };
  if (!isChunkListResponse(list)) return { ok: false, stage: "verify", detail: "malformed ChunkListResponse" };
  // 別会議の一覧で照合すると、同一内容（無音など）の Chunk を誤って DB_REGISTERED にしうる
  if (list.meetingId !== meetingId) return { ok: false, stage: "verify", detail: `list meetingId mismatch: ${list.meetingId}` };

  // sequenceNo の連続性（欠番なし）。IDB に書けずサーバーへ直接送った Chunk（§15 drainMemoryBacklog）は IDB に残らないので、
  // IDB にない連番はサーバーに登録済みなら揃っているとみなす。IDB の件数で送ると、サーバーは件数不一致の 409 を返し続ける
  const localSeqs = new Set(chunks.map((c) => c.meta.sequenceNo));
  const serverOnlySeqs = new Set(
    list.chunks.filter((c) => c.source === "mic" && c.registered && !localSeqs.has(c.sequenceNo)).map((c) => c.sequenceNo),
  );
  const chunkCount = Math.max(-1, ...localSeqs, ...serverOnlySeqs) + 1;
  for (let i = 0; i < chunkCount; i++) {
    if (!localSeqs.has(i) && !serverOnlySeqs.has(i)) {
      return { ok: false, stage: "verify", detail: `sequence gap at ${i}` };
    }
  }

  const serverByKey = new Map(list.chunks.map((c) => [`${c.source}:${c.sequenceNo}`, c]));
  // 不一致を 1 件ずつ直すと Barrier の再試行が件数分かかるため、すべて洗い出してから一度に再投入する
  const mismatched: number[] = [];
  for (const c of chunks) {
    const s = serverByKey.get(`${c.meta.source}:${c.meta.sequenceNo}`);
    if (s === undefined || s.sha256 !== c.meta.sha256 || !s.registered) {
      await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
        r.save.status = "LOCAL_SAVE_PENDING";
      });
      mismatched.push(c.meta.sequenceNo);
      continue;
    }
    if (c.save.status === "SAVED") {
      await deps.chunkStore.updateSaveState(c.chunkKey, (r) => {
        r.save.status = "DB_REGISTERED";
      });
    }
  }
  if (mismatched.length > 0) {
    await deps.scheduler.resumeAll();
    return { ok: false, stage: "verify", detail: `server mismatch at seq ${mismatched.join(", ")}` };
  }

  // finalizing へ進める前の値を控える。POST が失敗・タイムアウトしたら status と一緒にここへ戻す
  const before = { finalChunkCount: meeting.finalChunkCount };
  const restore = async (): Promise<void> => {
    meeting.status = "stop_requested";
    meeting.finalChunkCount = before.finalChunkCount;
    await deps.meetingStore.put(meeting);
  };

  meeting.status = "finalizing";
  meeting.finalChunkCount = chunkCount;
  // 再試行で終了時刻を書き換えない（前回の POST がサーバーに届いていた場合と値を揃える）
  meeting.endedAt ??= Date.now();
  await deps.meetingStore.put(meeting);

  const body: FinalizeRequest = {
    expectedChunkCounts: { mic: chunkCount, system: 0 },
    endedAtEpochMs: meeting.endedAt,
    totalAudioFrames: meeting.sessionClock.audioFrameCount,
  };
  const finUrl = new URL(`/v1/meetings/${encodeURIComponent(meetingId)}/finalize`, deps.baseUrl);
  assertLocalHost(finUrl);
  const finAbort = new AbortController();
  const finTimer = setTimeout(() => finAbort.abort(), timeoutMs);
  let finRes: Response;
  try {
    finRes = await fetchImpl(finUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      // リダイレクト先は assertLocalHost を通らないため追従しない（§4.4）
      redirect: "error",
      signal: finAbort.signal,
    });
  } catch (error) {
    // finalizing のまま残さない。次回の Barrier 再試行は stop_requested から行う
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize request failed: ${errorMessage(error)}` };
  } finally {
    clearTimeout(finTimer);
  }
  if (!finRes.ok) {
    await restore();
    return { ok: false, stage: "finalize", detail: `finalize HTTP ${finRes.status}` };
  }
  meeting.status = "finalized";
  await deps.meetingStore.put(meeting);
  // 欠けた音声は取り戻せないので確定は止めず、UI が警告できるよう長さを返す（T1-e）
  const missingTailMs = measureMissingTailMs(meeting.sessionClock.audioFrameCount, chunks, chunkCount);
  return missingTailMs > 0 ? { ok: true, missingTailMs } : { ok: true };
}

/**
 * 末尾の欠け（ms）。stop() が Worklet の応答を待てずに打ち切ると、最終の部分 Chunk がないまま会議が確定する。
 * audioFrameCount は heartbeat（1 秒ごと）でも進むので、最後の Chunk の endFrame より大きければ末尾が欠けている
 * （最後の heartbeat より後の 1 秒未満の欠けは検出できない）。
 * 最後の連番が IDB にない（サーバーへ直接送った）ときは endFrame が分からないので 0 を返す。
 */
export function measureMissingTailMs(audioFrameCount: number, chunks: ReadonlyArray<AudioChunkRecord>, chunkCount: number): number {
  const last = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
  if (last === undefined || last.meta.sequenceNo !== chunkCount - 1) return 0;
  return frameToOffsetMs(Math.max(0, audioFrameCount - last.meta.endFrame));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
