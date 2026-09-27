import { describe, expect, it } from "vitest";
import type { DegradedReason, LocalBackendHealth } from "../src/types/recording";
import {
  backendBanner,
  elapsedText,
  finalizeResultText,
  missingTailText,
  noticeFor,
  storageUsageText,
  TAB_CLOSE_HELP,
  warningsFor,
} from "../src/ui/recording-view";

function backend(status: LocalBackendHealth["status"], unauthorized = false): LocalBackendHealth {
  return { status, lastCheckedAt: 0, lastHealthyAt: null, latencyMs: null, consecutiveFailures: 0, capabilities: null, unauthorized };
}

describe("backendBanner", () => {
  it("サーバー未接続なら、録音が継続中であることとブラウザ内の滞留数を出す（§3.6）", () => {
    expect(backendBanner(backend("UNREACHABLE"), { pendingChunkCount: 3 })).toBe("サーバー未接続 ── 録音は継続中。3 個の Chunk をブラウザ内に保持しています");
  });

  it("トークンが無効なら、状態より優先して設定を促す", () => {
    expect(backendBanner(backend("UNREACHABLE", true), { pendingChunkCount: 3 })).toBe("サーバーのトークンが無効です。設定を確認してください。");
  });

  it("高負荷（DEGRADED）なら保存は継続中と出す（§18）", () => {
    expect(backendBanner(backend("DEGRADED"), { pendingChunkCount: 0 })).toBe("サーバーが高負荷です。保存は継続中");
  });

  it.each(["HEALTHY", "UNKNOWN"] as const)("%s ならバナーを出さない", (status) => {
    expect(backendBanner(backend(status), { pendingChunkCount: 0 })).toBeNull();
  });
});

describe("warningsFor", () => {
  it("重大な順に並べ、保存領域の不足を先頭に出す（§3.4 段階3）", () => {
    // Arrange：わざと重大度と逆の順で渡す
    const reasons: DegradedReason[] = ["STORAGE_NOT_PERSISTED", "NO_AUDIO_FRAMES", "IDB_QUOTA_EXHAUSTED"];
    // Act
    const warnings = warningsFor({ reasons });
    // Assert
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe("保存領域が不足しています。サーバーを起動するかエクスポートしてください");
    expect(warnings[1]).toContain("音声が届いていません");
    expect(warnings[2]).toContain("永続化");
  });

  it("backend の理由はバナーと重複するので出さない", () => {
    expect(warningsFor({ reasons: ["BACKEND_UNREACHABLE", "BACKEND_DEGRADED", "BACKEND_UNAUTHORIZED"] })).toEqual([]);
  });

  it("同じ理由が重なっても 1 回だけ出す", () => {
    expect(warningsFor({ reasons: ["MIC_TRACK_ENDED", "MIC_TRACK_ENDED"] })).toHaveLength(1);
  });
});

describe("storageUsageText", () => {
  it("使用率を百分率で出す", () => {
    expect(storageUsageText(0.834)).toBe("ブラウザ内の保存領域 使用率 83%");
  });

  it("見積もりが取れない（null）なら不明と出す", () => {
    expect(storageUsageText(null)).toBe("ブラウザ内の保存領域 使用率 不明");
  });
});

describe("missingTailText", () => {
  it("秒に丸めて出す（§22）", () => {
    expect(missingTailText(2_400)).toBe("末尾 約2秒が保存されていません");
  });

  it("1 秒未満でも 0 秒とは言わない", () => {
    expect(missingTailText(300)).toBe("末尾 約1秒が保存されていません");
  });
});

describe("noticeFor", () => {
  it("中断された会議が 0 件なら何も知らせない", () => {
    expect(noticeFor({ type: "recovered", report: { interruptedMeetings: [], requeuedChunks: 0 } })).toBeNull();
  });

  it("中断された会議があれば件数を知らせる", () => {
    const notice = noticeFor({ type: "recovered", report: { interruptedMeetings: [{ meetingId: "a", status: "stop_requested", chunkCount: 2 }], requeuedChunks: 2 } });
    expect(notice).toContain("1 件");
  });

  it("確定時に末尾が欠けていたら警告を添える", () => {
    expect(noticeFor({ type: "finalized", meetingId: "a", missingTailMs: 2_000 })).toBe("録音を確定しました。末尾 約2秒が保存されていません");
  });

  it("欠けがなければ確定したことだけを知らせる", () => {
    expect(noticeFor({ type: "finalized", meetingId: "a" })).toBe("録音を確定しました");
  });

  it("メモリ待機が残っていれば書き出しを促す", () => {
    expect(noticeFor({ type: "memory_backlog_export_required", meetingId: "a", error: new Error("x") })).toContain("WAV を書き出す");
  });

  it("保存領域がほぼ一杯ならエクスポートを促す（§3.4 段階2）", () => {
    expect(noticeFor({ type: "export_required", meetingId: "a" })).toContain("エクスポート");
  });

  it("Error のエラーはメッセージを出す", () => {
    expect(noticeFor({ type: "error", error: new Error("boom") })).toBe("エラー: boom");
  });

  it("Error でも文字列でもないエラーは中身を出さない", () => {
    expect(noticeFor({ type: "error", error: { secret: "token" } })).toBe("エラー: 不明なエラー");
  });
});

describe("finalizeResultText", () => {
  it("サーバーへの保存待ちは確定待ちと出す", () => {
    expect(finalizeResultText({ ok: false, stage: "waiting_local_save", detail: "2 chunks not registered" })).toBe("確定待ち（サーバーへの保存が終わると自動で確定します）");
  });

  it("finalize の失敗は再試行を促す", () => {
    expect(finalizeResultText({ ok: false, stage: "finalize", detail: "HTTP 500" })).toBe("確定できませんでした。再試行してください（HTTP 500）");
  });

  it("検証の失敗は理由を出す", () => {
    expect(finalizeResultText({ ok: false, stage: "verify", detail: "sha256 mismatch" })).toBe("確定できませんでした（sha256 mismatch）");
  });

  it("成功で末尾が欠けていれば警告を添える", () => {
    expect(finalizeResultText({ ok: true, missingTailMs: 1_000 })).toBe("録音を確定しました。末尾 約1秒が保存されていません");
  });
});

describe("elapsedText", () => {
  it.each([
    [0, "00:00"],
    [65_900, "01:05"],
    [3_725_000, "1:02:05"],
  ])("%i ms は %s", (ms, text) => {
    expect(elapsedText(ms)).toBe(text);
  });
});

describe("固定文言", () => {
  it("タブを閉じたときの損失上限は §20 の文言どおり", () => {
    expect(TAB_CLOSE_HELP).toBe("タブを閉じる・リロードすると、直近最大 30 秒の音声が失われる可能性があります。録音停止ボタンで終了してください");
  });
});
