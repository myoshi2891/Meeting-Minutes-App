import { describe, expect, it, vi } from "vitest";
import { confirmAbandon } from "../src/ui/pending-actions";

const meeting = { meetingId: "meeting-1", title: "定例" };
describe("確定中止の確認", () => {
  it("キャンセルでは会議を変更しない", async () => {
    const abandon = vi.fn();
    await confirmAbandon(meeting, 0, { confirm: () => false, exportWav: vi.fn(), abandon });
    expect(abandon).not.toHaveBeenCalled();
  });
  it("メモリ待機があれば書き出し後に対象とデータ保持を確認して中止する", async () => {
    const order: string[] = [];
    const confirm = vi.fn((text: string) => { order.push("confirm"); return true; });
    const abandon = vi.fn(async () => { order.push("abandon"); });
    await confirmAbandon(meeting, 2, { confirm, exportWav: () => { order.push("export"); }, abandon });
    expect(order).toEqual(["confirm", "export", "confirm", "abandon"]);
    expect(confirm.mock.calls[1][0]).toContain(meeting.meetingId);
    expect(confirm.mock.calls[1][0]).toContain("削除しません");
    expect(abandon).toHaveBeenCalledWith(meeting.meetingId, true);
  });
  it("書き出しを断った場合や書き出し失敗では中止しない", async () => {
    const abandon = vi.fn();
    await confirmAbandon(meeting, 1, { confirm: () => false, exportWav: vi.fn(), abandon });
    expect(abandon).not.toHaveBeenCalled();
    await expect(confirmAbandon(meeting, 1, { confirm: () => true, exportWav: () => { throw new Error("export failed"); }, abandon })).rejects.toThrow();
    expect(abandon).not.toHaveBeenCalled();
  });
});
