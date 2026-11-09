// src/ui/pending-actions.ts
import type { FinalizeResult } from "../recording/finalizer";
import type { MeetingRecord } from "../types/recording";

interface AbandonActions {
  confirm(message: string): boolean;
  /** 書き出しの完了（ダウンロードの開始）まで待てるよう Promise も受ける。失敗したら中止しない */
  exportWav(): void | Promise<void>;
  abandon(meetingId: string, confirmed: boolean): Promise<void>;
  /** 中止後、WAV を保存できたと確認されたらメモリ待機を捨てる（App.discardMemoryBacklog）。省略時は確認を出さない */
  discardBacklog?(meetingId: string): Promise<void>;
}

/** 中止した会議のメモリ待機を捨てる前の確認。キャンセルなら残す（書き出し欄からもう一度書き出し・破棄できる） */
export function discardBacklogQuestion(title: string, count: number): string {
  return `「${title}」のメモリ内の音声 ${count} 件を破棄しますか？\n書き出した WAV を保存できた場合だけ「OK」を押してください。破棄すると、タブを閉じるときの確認も出なくなります。\n「キャンセル」なら、保存を確かめるまでメモリに残します。`;
}

/** 未保存音声を先に退避し、対象会議を明示して確認する。キャンセル時は状態を変えず "cancelled" を返す（UI はボタンをすぐ戻す）。 */
export async function confirmAbandon(meeting: Pick<MeetingRecord, "meetingId" | "title">, memoryCount: number, actions: AbandonActions): Promise<"cancelled" | "abandoned"> {
  if (memoryCount > 0) {
    if (!actions.confirm(`「${meeting.title}」にはメモリ内に未保存の音声が ${memoryCount} 件あります。先に WAV を書き出しますか？\n「OK」で書き出してから中止の確認に進みます。「キャンセル」を選ぶと確定の中止も取りやめます。`)) return "cancelled";
    await actions.exportWav();
  }
  const exportNotice = memoryCount > 0 ? "書き出した WAV を保存できたことを確認してください。\n" : "";
  if (!actions.confirm(`${exportNotice}「${meeting.title}」（${meeting.meetingId}）の確定を中止し、一覧から外しますか？\n音声が欠けている可能性があります。確定済みにはなりません。保存済みの音声と会議情報は削除しません。自動再送・確定は再開しません。`)) return "cancelled";
  await actions.abandon(meeting.meetingId, true);
  // 中止した会議のメモリ待機は送られないので、保存を確かめたら捨てられるようにする（捨てるまで離脱確認が残る）
  if (memoryCount > 0 && actions.discardBacklog !== undefined && actions.confirm(discardBacklogQuestion(meeting.title, memoryCount))) {
    await actions.discardBacklog(meeting.meetingId);
  }
  return "abandoned";
}

type FinalizeFailure = Extract<FinalizeResult, { ok: false }>;

/**
 * 手動再試行の失敗を通知欄に出すか。before は再試行前、recorded は再試行後の App.getFinalizeIssue()。
 * 自動通知（finalize_pending）は記録された理由が前回と変わったときだけ出るので、出なかった失敗は手動の結果として出す
 */
export function manualRetryNeedsNotice(before: FinalizeFailure | undefined, recorded: FinalizeFailure | undefined, result: FinalizeResult): boolean {
  if (result.ok) return false;
  const notifiedAutomatically = recorded === result && (before?.stage !== result.stage || before.detail !== result.detail);
  return !notifiedAutomatically;
}
