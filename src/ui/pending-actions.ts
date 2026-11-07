// src/ui/pending-actions.ts
import type { MeetingRecord } from "../types/recording";

interface AbandonActions {
  confirm(message: string): boolean;
  exportWav(): void;
  abandon(meetingId: string, confirmed: boolean): Promise<void>;
}

/** 未保存音声を先に退避し、対象会議を明示して確認する。キャンセル時は状態を変えない。 */
export async function confirmAbandon(meeting: Pick<MeetingRecord, "meetingId" | "title">, memoryCount: number, actions: AbandonActions): Promise<void> {
  if (memoryCount > 0) {
    if (!actions.confirm(`「${meeting.title}」にはメモリ内に未保存の音声が ${memoryCount} 件あります。先に WAV を書き出しますか？`)) return;
    actions.exportWav();
  }
  const exportNotice = memoryCount > 0 ? "書き出した WAV を保存できたことを確認してください。\n" : "";
  if (!actions.confirm(`${exportNotice}「${meeting.title}」（${meeting.meetingId}）の確定を中止し、一覧から外しますか？\n音声が欠けている可能性があります。確定済みにはなりません。保存済みの音声と会議情報は削除しません。自動再送・確定は再開しません。`)) return;
  await actions.abandon(meeting.meetingId, true);
}
