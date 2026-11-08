// src/ui/recording-view.ts
import type { AppEvent } from "../app/app";
import type { FinalizeResult } from "../recording/finalizer";
import type { HealthAssessment } from "../recording/recording-health-monitor";
import type { ChunkTimingMetadata, DegradedReason, LocalBackendHealth, LocalSaveStatus, RecordingHealth } from "../types/recording";

/** §3.9：録音開始ボタン押下時に確認する。スキップするオプションは設けない */
export const CONSENT_QUESTION = "この会議の参加者に録音の同意を得ましたか？";

/** §3.9：通信設計では防げない持ち出し経路を、利用者の責任範囲として明示する */
export const LOCAL_DATA_NOTICE =
  "録音はこのパソコンの中（ブラウザと、ローカルで動くサーバーのデータフォルダ）にだけ保存され、外部へは送信しません。" +
  "ただし、パソコンの盗難・マルウェア・クラウドバックアップの同期などによって録音ファイルが外部に出る可能性があります。管理は利用者の責任で行ってください。";

/** §20：設定画面と録音画面のヘルプに記載する */
export const TAB_CLOSE_HELP = "タブを閉じる・リロードすると、直近最大 30 秒の音声が失われる可能性があります。録音停止ボタンで終了してください";

/** backend の状態（§3.6 / §18）。文言は phase2-client §11 の backendBanner と揃える */
export function backendBanner(backend: LocalBackendHealth, health: Pick<RecordingHealth, "pendingChunkCount">, recordingActive = true, memoryCount = 0): string | null {
  if (backend.unauthorized) return "サーバーのトークンが無効です。設定を確認してください。";
  if (backend.status === "UNREACHABLE") return recordingActive
    ? `サーバー未接続 ── 録音は継続中。ブラウザ保存済み・未送信 ${health.pendingChunkCount} 件／メモリ内未保存 ${memoryCount} 件`
    : `サーバー未接続 ── ブラウザ保存済み・未送信 ${health.pendingChunkCount} 件／メモリ内未保存 ${memoryCount} 件`;
  if (backend.status === "DEGRADED") return "サーバーが高負荷です。保存は継続中";
  return null;
}

/** 重大な順。backend の理由はバナーで出すのでここには含めない */
const WARNING_TEXT: ReadonlyArray<readonly [DegradedReason, string]> = [
  // §3.4 段階3：メモリ待機はクラッシュで失われるため最上位
  ["IDB_QUOTA_EXHAUSTED", "保存領域が不足しています。サーバーを起動するかエクスポートしてください"],
  ["IDB_WRITE_FAILED", "ブラウザ内に保存できない音声があります。サーバーを起動するか、WAV を書き出してください"],
  ["MIC_TRACK_ENDED", "マイクが切断されたため録音を停止します。保存状況は「確定待ちの会議」で確認し、マイクを確かめてから新しい録音を開始してください"],
  ["NO_AUDIO_FRAMES", "音声が届いていません（5 秒以上）"],
  ["AUDIO_CONTEXT_CLOSED", "音声処理が停止しました。録音を止めてやり直してください"],
  ["AUDIO_CONTEXT_SUSPENDED", "音声処理が一時停止しています（画面ロックなど）"],
  ["IDB_QUOTA_WARNING", "ブラウザ内の保存領域が残り少なくなっています"],
  ["STORAGE_NOT_PERSISTED", "ブラウザが保存領域の永続化を許可していません。容量が逼迫すると録音データが消える可能性があります"],
];

/** 録音の健全性（§19 assessHealth の reasons）を利用者向けの文言にする */
export function warningsFor(assessment: Pick<HealthAssessment, "reasons">): string[] {
  return WARNING_TEXT.filter(([reason]) => assessment.reasons.includes(reason)).map(([, text]) => text);
}

export function storageUsageText(ratio: number | null): string {
  return `ブラウザ内の保存領域 使用率 ${ratio === null ? "不明" : `${Math.round(ratio * 100)}%`}`;
}

/** §22：stop が Worklet の応答を待てずに打ち切った場合の欠け。1 秒未満でも欠けはあるので 0 秒とは言わない */
export function missingTailText(missingTailMs: number): string {
  return `末尾 約${Math.max(1, Math.round(missingTailMs / 1000))}秒が保存されていません`;
}

export function noticeFor(event: AppEvent): string | null {
  switch (event.type) {
    case "recovered": {
      const meetings = event.report.interruptedMeetings;
      if (meetings.length === 0) return null;
      const interrupted = meetings.filter((m) => m.status === "recording").length;
      const pending = meetings.length - interrupted;
      const parts: string[] = [];
      if (interrupted > 0) parts.push(`前回中断された会議が ${interrupted} 件あります`);
      if (pending > 0) parts.push(`確定待ちの会議が ${pending} 件あります`);
      return `${parts.join("。")}。サーバーへの保存と確定を再開します。「確定待ちの会議」で状況を確認してください`;
    }
    case "finalize_pending":
      return `会議 ${event.meetingId}: ${finalizeResultText(event.result)}`;
    case "finalize_abandoned":
      return `会議 ${event.meetingId} の確定を中止しました。保存済みの音声は削除していません`;
    case "recording_stopped":
      return event.reason === "mic_ended" ? "マイクが切断されたため録音を停止しました。保存状況は「確定待ちの会議」で確認し、マイクを選び直して新しい録音を開始してください" : null;
    case "finalized":
      return event.missingTailMs === undefined ? "録音を確定しました" : `録音を確定しました。${missingTailText(event.missingTailMs)}`;
    case "export_required":
      return "ブラウザ内の保存領域がほぼ一杯です。サーバーを起動するか、録音をエクスポートしてください";
    case "memory_backlog_export_required":
      return "保存できていない音声があります。「WAV を書き出す」で手元に保存してください";
    case "error":
      return `エラー: ${errorMessage(event.error)}`;
  }
}

export function finalizeResultText(result: FinalizeResult): string {
  if (result.ok) return result.missingTailMs === undefined ? "録音を確定しました" : `録音を確定しました。${missingTailText(result.missingTailMs)}`;
  if (/HTTP (401|403)$/.test(result.detail) || result.detail === "backend token is not set") return "サーバーのトークンを設定で確認・保存してください。保存済みの音声は保持しています";
  if (result.stage === "waiting_local_save") {
    const memory = result.detail.match(/^(\d+) chunks not persisted to IDB$/);
    if (memory) return `確定待ち：メモリ内に未保存の音声が ${memory[1]} 件あります。WAV を書き出してから、サーバーの状態を確認してください`;
    const pending = result.detail.match(/^(\d+) chunks not registered$/);
    return `確定待ち：${pending ? `サーバー未登録の音声が ${pending[1]} 件あります` : result.detail}。保存完了時に自動で再試行します。進まない場合は「再試行」を押してください`;
  }
  if (result.stage === "finalize") return `確定できませんでした。再試行してください（${result.detail}）`;
  return `確定できませんでした（${result.detail}）`;
}

/** 録音の経過時間。1 時間未満は mm:ss、以上は h:mm:ss */
export const INCOMPLETE_COUNT_NOTE = "（ブラウザに記録のない音声があり、実際はこれより多い可能性があります）";

export interface PendingCounts {
  readonly chunks: ReadonlyArray<{ readonly meta: Pick<ChunkTimingMetadata, "sequenceNo" | "endFrame">; readonly save: { readonly status: LocalSaveStatus } }>;
  readonly audioFrameCount: number;
  /** このタブの直接送信で登録した件数（IDB に残らない）。再読み込みすると 0 に戻る */
  readonly directRegistered: number;
  readonly memoryCount: number;
  /** IDB に残らない Chunk（このタブの直接送信・メモリ待機）の最大 endFrame。なければ 0 */
  readonly offIdbEndFrame?: number;
  /** IDB に残らない Chunk（このタブの直接送信・メモリ待機）の連番。あれば件数でなく連番で欠けを判定する（再読み込み後は空） */
  readonly offIdbSequenceNos?: ReadonlyArray<number>;
}

/**
 * 確定待ちの内訳。IDB の Chunk・直接送信・メモリ待機で説明できない音声があれば、登録件数を不完全と明示する
 * （再読み込み後の直接送信はサーバーに問い合わせないと数えられない）。
 */
export function pendingCountsText({ chunks, audioFrameCount, directRegistered, memoryCount, offIdbEndFrame = 0, offIdbSequenceNos }: PendingCounts): string {
  const registered = chunks.filter((c) => c.save.status === "DB_REGISTERED").length;
  const saved = chunks.filter((c) => c.save.status === "SAVED").length;
  const hasGap = offIdbSequenceNos === undefined
    ? Math.max(-1, ...chunks.map((c) => c.meta.sequenceNo)) + 1 > chunks.length + directRegistered + memoryCount
    : hasSequenceGap([...chunks.map((c) => c.meta.sequenceNo), ...offIdbSequenceNos]);
  // 件数が合っていても末尾まで届いているとは限らない。把握している Chunk の最大 endFrame で網羅を確かめる
  const hasUnknownTail = audioFrameCount > Math.max(0, offIdbEndFrame, ...chunks.map((c) => c.meta.endFrame));
  const note = hasGap || hasUnknownTail ? INCOMPLETE_COUNT_NOTE : "";
  return `サーバー登録確認済み ${registered + directRegistered} 件${note}／サーバー保存済み・登録未確認 ${saved} 件／ブラウザ保存済み・未送信 ${chunks.length - registered - saved} 件／メモリ内未保存 ${memoryCount} 件`;
}

/** 0 から最大の連番までに抜けがあるか。件数で比べると、メモリ待機の連番が IDB の最大より後ろにあるとき欠番を見逃す */
function hasSequenceGap(sequenceNos: ReadonlyArray<number>): boolean {
  const known = new Set(sequenceNos);
  const max = Math.max(-1, ...known);
  for (let i = 0; i <= max; i++) if (!known.has(i)) return true;
  return false;
}

export function elapsedText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** error は unknown。任意のオブジェクトの中身（トークンなど）を画面に出さない */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "不明なエラー";
}
