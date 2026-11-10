import { describe, expect, it } from "vitest";
import type { DegradedReason, LocalBackendHealth, LocalSaveStatus } from "../src/types/recording";
import {
  backendBanner,
  elapsedText,
  finalizeResultText,
  INCOMPLETE_COUNT_NOTE,
  missingTailText,
  noticeFor,
  pendingCountsText,
  storageUsageText,
  TAB_CLOSE_HELP,
  warningsFor,
} from "../src/ui/recording-view";

function backend(status: LocalBackendHealth["status"], unauthorized = false): LocalBackendHealth {
  return { status, lastCheckedAt: 0, lastHealthyAt: null, latencyMs: null, consecutiveFailures: 0, capabilities: null, unauthorized };
}

describe("backendBanner", () => {
  it("IDB 側が 0 件でもメモリ内の未保存音声を区別する", () => {
    expect(backendBanner(backend("UNREACHABLE"), { pendingChunkCount: 0 }, false, 2)).toContain("ブラウザ保存済み・未送信 0 件／メモリ内未保存 2 件");
  });

  it("サーバー未接続なら、録音が継続中であることとブラウザ内の滞留数を出す（§3.6）", () => {
    expect(backendBanner(backend("UNREACHABLE"), { pendingChunkCount: 3 })).toBe("サーバー未接続 ── 録音は継続中。ブラウザ保存済み・未送信 3 件／メモリ内未保存 0 件");
  });

  it("録音停止後は継続中と表示しない", () => {
    expect(backendBanner(backend("UNREACHABLE"), { pendingChunkCount: 3 }, false)).toBe("サーバー未接続 ── ブラウザ保存済み・未送信 3 件／メモリ内未保存 0 件");
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

  it("マイク切断の警告は保存を約束せず、確定待ちの会議で保存状況を確かめるよう案内する", () => {
    // 保存できない音声がメモリ待機に残ることもあるため、「保存します」とは言い切らない
    const [text] = warningsFor({ reasons: ["MIC_TRACK_ENDED"] });
    expect(text).not.toContain("保存して");
    expect(text).toContain("確定待ちの会議");
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
  it("通常停止の確定待ちは中断と呼ばず、混在時は件数を分ける", () => {
    const stopped = { meetingId: "a", status: "stop_requested" as const, chunkCount: 1 };
    const notice = noticeFor({ type: "recovered", report: { interruptedMeetings: [stopped], requeuedChunks: 0, unreadMeetingIds: [] } });
    expect(notice).toContain("確定待ちの会議が 1 件");
    expect(notice).not.toContain("中断");
    const mixed = noticeFor({ type: "recovered", report: { interruptedMeetings: [stopped, { ...stopped, meetingId: "b", status: "recording" }], requeuedChunks: 0, unreadMeetingIds: [] } });
    expect(mixed).toContain("中断された会議が 1 件");
    expect(mixed).toContain("確定待ちの会議が 1 件");
    expect(mixed).toContain("確定待ちの会議」");
  });

  it("中断された会議が 0 件なら何も知らせない", () => {
    expect(noticeFor({ type: "recovered", report: { interruptedMeetings: [], requeuedChunks: 0, unreadMeetingIds: [] } })).toBeNull();
  });

  it("中断された会議があれば件数を知らせる", () => {
    const notice = noticeFor({ type: "recovered", report: { interruptedMeetings: [{ meetingId: "a", status: "stop_requested", chunkCount: 2 }], requeuedChunks: 2, unreadMeetingIds: [] } });
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
  it("保存待ちには具体的な失敗理由を添える", () => {
    const text = finalizeResultText({ ok: false, stage: "waiting_local_save", detail: "2 chunks not persisted to IDB" });
    expect(text).toContain("メモリ内に未保存の音声が 2 件");
    expect(text).toContain("WAV");
  });

  it("サーバーへの保存待ちは確定待ちと出す", () => {
    expect(finalizeResultText({ ok: false, stage: "waiting_local_save", detail: "2 chunks not registered" })).toBe("確定待ち：サーバー未登録の音声が 2 件あります。保存完了時に自動で再試行します。進まない場合は「再試行」を押してください");
  });

  it("finalize の失敗は再試行を促す", () => {
    expect(finalizeResultText({ ok: false, stage: "finalize", detail: "HTTP 500" })).toBe("確定できませんでした。再試行してください（HTTP 500）");
  });

  it("認証エラーに分類された失敗はトークンの確認を案内する", () => {
    expect(finalizeResultText({ ok: false, stage: "verify", detail: "list HTTP 401", reason: "unauthorized" })).toBe("サーバーのトークンを設定で確認・保存してください。保存済みの音声は保持しています");
  });

  it("接続失敗・タイムアウトに分類された失敗は、サーバーが使えるようになれば自動で再試行すると案内する", () => {
    // Arrange
    const verify = { ok: false, stage: "verify", detail: "list request failed: aborted", reason: "network" } as const;
    const finalize = { ok: false, stage: "finalize", detail: "finalize request failed: Failed to fetch", reason: "network" } as const;
    // Act / Assert
    for (const result of [verify, finalize]) {
      expect(finalizeResultText(result)).toBe(`確定待ち：サーバーに接続できませんでした。サーバーが使えるようになれば自動で再試行します。保存済みの音声は保持しています（${result.detail}）`);
    }
  });

  it("detail が HTTP 403 で終わっても、認証エラーに分類されていなければエラーとして出す", () => {
    expect(finalizeResultText({ ok: false, stage: "verify", detail: "list meetingId mismatch: x HTTP 403" })).toBe("確定できませんでした（list meetingId mismatch: x HTTP 403）");
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

describe("pendingCountsText", () => {
  const chunk = (sequenceNo: number, status: LocalSaveStatus): Parameters<typeof pendingCountsText>[0]["chunks"][number] => ({
    meta: { sequenceNo, endFrame: (sequenceNo + 1) * 100 },
    save: { status },
  });

  it("SAVED は未送信に数えず、サーバー保存済み・登録未確認として分ける", () => {
    // Arrange
    const chunks = [chunk(0, "DB_REGISTERED"), chunk(1, "SAVED"), chunk(2, "BACKEND_UNAVAILABLE")];
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount: 300, directRegistered: 0, memoryCount: 1 });
    // Assert
    expect(text).toBe("サーバー登録確認済み 1 件／サーバー保存済み・登録未確認 1 件／ブラウザ保存済み・未送信 1 件／メモリ内未保存 1 件");
  });

  it("直接送信で登録済みの Chunk を登録確認済みに含める", () => {
    // Arrange：seq 0 は IDB に残らずサーバーへ直接送った
    const chunks = [chunk(1, "DB_REGISTERED")];
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount: 200, directRegistered: 1, memoryCount: 0 });
    // Assert
    expect(text).toBe("サーバー登録確認済み 2 件／サーバー保存済み・登録未確認 0 件／ブラウザ保存済み・未送信 0 件／メモリ内未保存 0 件");
  });

  it.each([
    ["連番に説明のつかない欠けがある", [chunk(1, "DB_REGISTERED")], 200],
    ["Chunk が 1 件もないのに音声が進んでいる（再読み込み後の直接送信など）", [], 100],
    ["末尾の Chunk より音声が進んでいる", [chunk(0, "DB_REGISTERED")], 200],
  ])("%s場合は登録件数が不完全だと示す", (_name, chunks, audioFrameCount) => {
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount, directRegistered: 0, memoryCount: 0 });
    // Assert
    expect(text).toContain(`サーバー登録確認済み ${chunks.length} 件${INCOMPLETE_COUNT_NOTE}／`);
  });

  it("メモリ待機で説明できる欠番は不完全として扱わない", () => {
    // Arrange
    const chunks = [chunk(1, "DB_REGISTERED")];
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount: 200, directRegistered: 0, memoryCount: 1 });
    // Assert
    expect(text).not.toContain(INCOMPLETE_COUNT_NOTE);
  });

  it.each([
    ["IDB 外の連番が欠番を埋めていない（IDB に 0・2、メモリに 3）", [3], 1, 0, true],
    ["IDB 外の連番が欠番を埋めている（IDB に 0・2、直接送信 1・メモリ 3）", [1, 3], 1, 1, false],
  ])("IDB 外の連番が分かるときは件数でなく連番で欠けを判定する（%s）", (_name, offIdbSequenceNos, memoryCount, directRegistered, incomplete) => {
    // Arrange：末尾は 400 フレームまで届いているので、末尾の網羅では欠けを検出できない
    const chunks = [chunk(0, "DB_REGISTERED"), chunk(2, "DB_REGISTERED")];
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount: 400, directRegistered, memoryCount, offIdbEndFrame: 400, offIdbSequenceNos });
    // Assert
    expect(text.includes(INCOMPLETE_COUNT_NOTE)).toBe(incomplete);
  });

  it.each([
    ["直接送信・メモリ待機の Chunk が末尾まで届いていない", 200, true],
    ["直接送信・メモリ待機の Chunk が末尾まで届いている", 300, false],
  ])("IDB 外の Chunk があっても末尾の網羅を確かめる（%s）", (_name, offIdbEndFrame, incomplete) => {
    // Arrange：IDB には seq 0 だけ。seq 1 は直接送信済みだが、音声は 300 フレームまで進んでいる
    const chunks = [chunk(0, "DB_REGISTERED")];
    // Act
    const text = pendingCountsText({ chunks, audioFrameCount: 300, directRegistered: 1, memoryCount: 0, offIdbEndFrame });
    // Assert
    expect(text.includes(INCOMPLETE_COUNT_NOTE)).toBe(incomplete);
  });

  it("Chunk が引数の上限を超える件数でも、最大値の展開で落ちずに内訳を返す", () => {
    // Arrange：Math.max(...list) は V8 の引数上限（十数万件）を超えると RangeError になる
    const chunks = Array.from({ length: 300_000 }, (_, i) => chunk(i, "DB_REGISTERED"));
    // Act
    const withSeq = pendingCountsText({ chunks, audioFrameCount: 300_000 * 100, directRegistered: 0, memoryCount: 0, offIdbSequenceNos: [] });
    const withoutSeq = pendingCountsText({ chunks, audioFrameCount: 300_000 * 100 + 1, directRegistered: 0, memoryCount: 0 });
    // Assert：欠番・末尾の判定も変わらない
    expect(withSeq).toBe("サーバー登録確認済み 300000 件／サーバー保存済み・登録未確認 0 件／ブラウザ保存済み・未送信 0 件／メモリ内未保存 0 件");
    expect(withoutSeq).toContain(INCOMPLETE_COUNT_NOTE);
  });
});
