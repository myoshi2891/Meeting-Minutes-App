// src/ui/recording-view.ts
import type { AppEvent } from "../app/app";
import type { FinalizeResult } from "../recording/finalizer";
import type { HealthAssessment } from "../recording/recording-health-monitor";
import type { DegradedReason, LocalBackendHealth, RecordingHealth } from "../types/recording";

/** §3.9：録音開始ボタン押下時に確認する。スキップするオプションは設けない */
export const CONSENT_QUESTION = "この会議の参加者に録音の同意を得ましたか？";

/** §3.9：通信設計では防げない持ち出し経路を、利用者の責任範囲として明示する */
export const LOCAL_DATA_NOTICE =
  "録音はこのパソコンの中（ブラウザと、ローカルで動くサーバーのデータフォルダ）にだけ保存され、外部へは送信しません。" +
  "ただし、パソコンの盗難・マルウェア・クラウドバックアップの同期などによって録音ファイルが外部に出る可能性があります。管理は利用者の責任で行ってください。";

/** §20：設定画面と録音画面のヘルプに記載する */
export const TAB_CLOSE_HELP = "タブを閉じる・リロードすると、直近最大 30 秒の音声が失われる可能性があります。録音停止ボタンで終了してください";

/** backend の状態（§3.6 / §18）。文言は phase2-client §11 の backendBanner と揃える */
export function backendBanner(backend: LocalBackendHealth, health: Pick<RecordingHealth, "pendingChunkCount">): string | null {
  if (backend.unauthorized) return "サーバーのトークンが無効です。設定を確認してください。";
  if (backend.status === "UNREACHABLE") return `サーバー未接続 ── 録音は継続中。${health.pendingChunkCount} 個の Chunk をブラウザ内に保持しています`;
  if (backend.status === "DEGRADED") return "サーバーが高負荷です。保存は継続中";
  return null;
}

/** 重大な順。backend の理由はバナーで出すのでここには含めない */
const WARNING_TEXT: ReadonlyArray<readonly [DegradedReason, string]> = [
  // §3.4 段階3：メモリ待機はクラッシュで失われるため最上位
  ["IDB_QUOTA_EXHAUSTED", "保存領域が不足しています。サーバーを起動するかエクスポートしてください"],
  ["IDB_WRITE_FAILED", "ブラウザ内に保存できない音声があります。サーバーを起動するか、WAV を書き出してください"],
  ["MIC_TRACK_ENDED", "マイクが切断されました。録音を止めて、マイクを確認してください"],
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
      const count = event.report.interruptedMeetings.length;
      return count === 0 ? null : `前回中断された会議が ${count} 件あります。サーバーへの保存と確定を再開します`;
    }
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
  if (result.stage === "waiting_local_save") return "確定待ち（サーバーへの保存が終わると自動で確定します）";
  if (result.stage === "finalize") return `確定できませんでした。再試行してください（${result.detail}）`;
  return `確定できませんでした（${result.detail}）`;
}

/** 録音の経過時間。1 時間未満は mm:ss、以上は h:mm:ss */
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
