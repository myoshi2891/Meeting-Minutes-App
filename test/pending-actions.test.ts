import { describe, expect, it, vi } from "vitest";
import { confirmAbandon, manualRetryNeedsNotice } from "../src/ui/pending-actions";
import type { FinalizeResult } from "../src/recording/finalizer";

const meeting = { meetingId: "meeting-1", title: "定例" };
describe("確定中止の確認", () => {
  it("キャンセルでは会議を変更せず、キャンセルしたことを返す", async () => {
    const abandon = vi.fn();
    const result = await confirmAbandon(meeting, 0, { confirm: () => false, exportWav: vi.fn(), abandon });
    expect(result).toBe("cancelled");
    expect(abandon).not.toHaveBeenCalled();
  });
  it("メモリ待機があれば書き出し後に対象とデータ保持を確認して中止する", async () => {
    const order: string[] = [];
    const confirm = vi.fn((text: string) => { order.push("confirm"); return true; });
    const abandon = vi.fn(async () => { order.push("abandon"); });
    const result = await confirmAbandon(meeting, 2, { confirm, exportWav: () => { order.push("export"); }, abandon });
    expect(result).toBe("abandoned");
    expect(order).toEqual(["confirm", "export", "confirm", "abandon"]);
    // 最初の確認：対象と未保存件数を示して書き出しを促す
    expect(confirm.mock.calls[0][0]).toContain(meeting.title);
    expect(confirm.mock.calls[0][0]).toContain("2 件");
    // 書き出しを断ると中止も取りやめになることを伝える
    expect(confirm.mock.calls[0][0]).toContain("確定の中止も取りやめます");
    // 最後の確認：対象を ID まで示し、書き出しの確認とデータを消さないことを伝える
    expect(confirm.mock.calls[1][0]).toContain(meeting.title);
    expect(confirm.mock.calls[1][0]).toContain(meeting.meetingId);
    expect(confirm.mock.calls[1][0]).toContain("書き出した WAV");
    expect(confirm.mock.calls[1][0]).toContain("削除しません");
    expect(abandon).toHaveBeenCalledWith(meeting.meetingId, true);
  });
  it("メモリ待機を書き出した後に最後の確認を断ったら中止しない", async () => {
    // Arrange：書き出しの確認は受け、最後の確認は断る
    const abandon = vi.fn();
    const exportWav = vi.fn();
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    // Act
    const result = await confirmAbandon(meeting, 1, { confirm, exportWav, abandon });
    // Assert
    expect(result).toBe("cancelled");
    expect(exportWav).toHaveBeenCalledOnce();
    expect(abandon).not.toHaveBeenCalled();
  });
  it("書き出しを断った場合や書き出し失敗では中止しない", async () => {
    const abandon = vi.fn();
    const exportWav = vi.fn();
    expect(await confirmAbandon(meeting, 1, { confirm: () => false, exportWav, abandon })).toBe("cancelled");
    expect(exportWav).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    await expect(confirmAbandon(meeting, 1, { confirm: () => true, exportWav: () => { throw new Error("export failed"); }, abandon })).rejects.toThrow();
    expect(abandon).not.toHaveBeenCalled();
  });
});

describe("手動再試行の通知", () => {
  type Failure = Extract<FinalizeResult, { ok: false }>;
  const failure = (detail: string): Failure => ({ ok: false, stage: "verify", detail });
  it("前回と同じ理由で失敗したら（自動通知が出ないので）手動の結果として通知する", () => {
    // Arrange：前回の理由と同じ失敗が記録された
    const before = failure("server unreachable");
    const result = failure("server unreachable");
    // Act / Assert
    expect(manualRetryNeedsNotice(before, result, result)).toBe(true);
  });
  it("理由が変わった失敗は自動通知（finalize_pending）が出るので重ねない", () => {
    const result = failure("new reason");
    expect(manualRetryNeedsNotice(failure("old reason"), result, result)).toBe(false);
    expect(manualRetryNeedsNotice(undefined, result, result)).toBe(false);
  });
  it("記録されない失敗（別タブがロック中など）は通知し、成功は通知しない", () => {
    expect(manualRetryNeedsNotice(undefined, undefined, failure("meeting is locked by another tab"))).toBe(true);
    expect(manualRetryNeedsNotice(failure("x"), undefined, { ok: true })).toBe(false);
  });
});
