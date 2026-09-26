# 進捗と次の作業

最終更新: 2026-09-26（ブランチ `dev`）

新しいセッションはこのファイルから始める。作業を終えたら「現在地」「次の作業」「セッションログ」を更新する（ルールは [CLAUDE.md](CLAUDE.md)）。

---

## 現在地

Phase 1（ブラウザ録音 → IndexedDB → ローカル常駐サーバーへ PUT → finalize）のクライアント側を、[design-local-phase1.md](design-local-phase1.md) §30 の Step 順に実装している。

| Step | 内容（設計書の節） | 状態 | 完了判定 |
| --- | --- | --- | --- |
| 1-a | §16 WAV エンコーダ | ✅ 自動テスト済 | `chunk-standalone.test.ts` 通過 |
| 1-b | §14 Worklet（リサンプラ・VAD・蓄積） | ✅ 自動テスト済 | `long-recording.test.ts` / `resampler-aliasing.test.ts` 通過 |
| 1-c | §10 IndexedDB + §15 RecordingController | 🟡 コード・自動テストのみ | **未**：実マイクで 5 分録音 → IDB に 10 Chunk、`<audio>` で再生 |
| 1-d | §17 LocalSaver / Scheduler + §18 BackendHealthMonitor | 🟡 コード・自動テストのみ | **未**：実サーバー（最小スタブ）へ PUT が届く |
| 1-e | §22 Finalizer + §23 Recovery | 🟡 コード・自動テストのみ | **未**：タブ強制終了 → 再起動で再送 |
| 1-f | §19 ヘルス / §20 ページライフサイクル / §21 クォータ + UI | 🟡 §19 のみ実装 | §20・§21・UI・配線が未着手。§28.3 の手動項目 |
| 1-g | 60 分実録音 | ⬜ 未着手 | 120 Chunk・欠番なし・全件 `DB_REGISTERED`・外部通信なし |

- 自動テスト: 17 ファイル / 214 件がすべて通過。`npm run typecheck` もエラーなし。
- 設計書と src の同期: `src/` の埋め込みコードはすべて一致。未実装の 2 ファイル（`page-lifecycle.ts`、`quota-monitor.ts`）だけが MISSING。確認手順は `design-doc-sync` スキルにある。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 未コミットの変更（2026-09-26・14 回目：連番のリセット）

13 回目までの変更はコミット済み。

| 変更 | 内容 | 推奨コミット |
| --- | --- | --- |
| `src/recording/recording-controller.ts`、`test/recording-controller.test.ts` | `setUp` で会議を確定したときに `nextSequenceNo` を 0 に戻す（同じインスタンスで stop → 別会議の start をすると前の会議の続きから採番され、Finalizer の連番チェックが通らなかった）。テスト 1 件（修正前 Red を確認） | `fix(recording): reset chunk sequence number per meeting` |
| `design-local-phase1.md`、`design-local-phase2-client.md` | 上記を反映（phase1 §15 のコードと採番の本文。phase2-client §4 Controller にも同じ欠陥があったため同じ形で修正） | `docs(phase1): reset chunk sequence number per meeting` |

---

## 次の作業

依存関係と並行実行の可否を明記する。「並行可」のタスクは、別エージェントや別セッションに分けても衝突しない（触るファイルが重ならない）。

### T0. 未コミット変更のコミット【最優先・他タスクの前提】

- 上の表の単位でコミットを分ける。`design-local.md` の扱いは利用者に確認する。
- 前提確認: `npm run typecheck && npm test`

### T1. レビュー修正の回帰テスト追加【T0 の後／T1-a〜d は並行可】

2026-09-25 のレビュー修正のうち、テストがないもの。どれも「修正前のコードで Red になる」ことを確認してから Green にする。

| ID | 対象 | テストで再現する状況 | 触るファイル |
| --- | --- | --- | --- |
| T1-a | BackendHealthMonitor | `checkOnce` の応答待ち中に `stop()` → `start()` しても、ポーリングが 1 系統だけになる | `test/backend-health-monitor.test.ts` |
| T1-b | LocalSaveScheduler | backend 停止中に N 回 `enqueue` しても、各キーへの `BACKEND_UNAVAILABLE` 書き込みは 1 回だけ。復帰 → 再停止したら再び書く | `test/local-save-scheduler.test.ts` |
| T1-c | RecordingController | ~~`flush()` と `stop()` が重なっても、`stop()` は自分の `flushed` まで解決しない~~ → requestId 化の回帰テストで対応済み（2026-09-25） | — |
| T1-d | RecordingController | `meetingStore.put` が reject しても、トラック停止と `onmessage` の解除が行われる | `test/recording-controller.test.ts`（T1-c と同じファイルなので直列） |

### T1-f. IDB 書き込みの非クォータ失敗と versionchange からの回復 ✅ 完了（2026-09-26・利用者判断：直接送信＋書き出し）

- `drainMemoryBacklog()` はクォータ以外の失敗で `directSaver`（`LocalSaver`）からサーバーへ直接 PUT し、失敗したら例外を投げてメモリ待機に残す。`exportMemoryBacklog()` で WAV を書き出せる。
- Finalizer は IDB にない連番でもサーバーに登録済みなら揃っているとみなす。
- 残り：UI 配線は T3、書き出した WAV をサーバーへ取り込む経路は保留・メモへ。

### T1-e. stop タイムアウト時の扱い ✅ 完了（2026-09-26・利用者判断：検出して警告）

- 状態は増やさない。Finalizer が確定時に `totalAudioFrames` と最後の Chunk の `endFrame` を比べ、欠けがあれば `{ ok: true, missingTailMs }` を返す（`measureMissingTailMs()` を export）。警告表示は T3。
- phase2-client §22 の「finalizing から再試行して失敗しても stop_requested に戻る」テストは、Phase 2 実装時に追加する。

### T2. Step 1-f: §20 / §21 の実装【T0 の後／T2-a と T2-b は並行可】

設計書にコードがあるので、それを正として TDD で実装する（テストは設計書 §24 にないため新規に書く）。

| ID | 内容 | 触るファイル | 備考 |
| --- | --- | --- | --- |
| T2-a | §20 `src/recording/page-lifecycle.ts` | 新規 + `test/page-lifecycle.test.ts` | §24.1 のとおり、このファイルだけ DOM が必要。`// @vitest-environment` か EventTarget の Fake で済むか先に判断する |
| T2-b | §21 `src/storage/quota-monitor.ts` | 新規 + `test/quota-monitor.test.ts` | `drainMemoryBacklog()` との連携（§15）を含める |

### T3. アプリの配線と最小 UI【T2 の後／外部依存の追加を伴うため要確認】

- まだエントリポイントがない。未配線なのは次のとおり。
  - `monitor.onChange → scheduler.resumeAll`
  - Scheduler の `onBackendUnreachable` / `onBackendUnauthorized` → Monitor（§18）
  - `finalizeMeeting` の `unpersistedChunkCount: () => controller.memoryBacklogCount`（§22）
  - 起動時の `recoverOnStartup`（§23）
  - `RecordingController` の `directSaver: LocalSaver`、`IDB_WRITE_FAILED` のときの `drainMemoryBacklog()` 呼び出し、失敗時に `exportMemoryBacklog()` のダウンロードを促す表示（§15）
  - `finalizeMeeting` の `missingTailMs` を「末尾 約◯秒が保存されていません」と警告表示（§22）
- Worklet を配信するには開発サーバー / バンドラ（例: Vite）が要る。**依存の追加になるので、着手前に利用者に確認する。**

### T4. 手動確認（Step 1-c / 1-d / 1-e / 1-g）【T3 の後】

- 1-d・1-e には実サーバーが要る。Phase 2 サーバー設計（[design-local-phase2-server.md](design-local-phase2-server.md)、Python）から、`/v1/health`・`PUT chunk`・`GET chunks`・`POST finalize` だけの最小スタブを作るかを判断する。
- 結果は [design-local-phase1.md](design-local-phase1.md) §28 の「状況」列に反映する。

### T5. 録音中の会議を起動時復旧から守る ✅ 完了（9 回目のレビュー対応）

- 2026-09-25 のレビュー指摘（3 回目）。別タブで録音中に新しいタブが開くと、`recoverOnStartup` がその会議を `stop_requested` に落とし、Barrier の自動再試行で録音中に finalize されうる（§3.1 で複数タブの同時録音を許している）。
- 対応: 会議ごとの Web Lock（`src/recording/meeting-lock.ts`）。`start()` が recording を書く前に取得し `stop()` の finally で解放、`recoverOnStartup` はロック保持中の会議と Chunk に触らない。`RecordingControllerDeps.locks` と `recoverOnStartup` の第 4 引数 `locks` を追加し、テストはハーネスの `FakeLockManager` を使う。

### T6. stop() の Worklet 無応答をどう扱うか ✅ 完了（T1-e で対応）

- 専用の失敗状態は足さず、Finalizer の `missingTailMs` で検出・警告する方針に決定。クラッシュ復旧した会議は §23 が `audioFrameCount` を最大 `endFrame` から復元するので欠けとは判定されない。

### T7. 起動時復旧が non-retryable の Chunk も再送する ✅ 完了（5 回目のレビュー対応）

- `recoverOnStartup` は GENERATED / SAVING の Chunk だけを `LOCAL_SAVE_PENDING` に書き戻すようにした。non-retryable の `LOCAL_SAVE_FAILED` は `isResumable` で除外され、再送されない。

### 保留・メモ

- T1-f で書き出した WAV（`exportMemoryBacklog()`）をサーバーへ取り込む経路は未設計。必要になったら Phase 2 以降で API を検討する。
- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

### 2026-09-26（13 回目）

- 利用者判断により T1-e（末尾の欠けを検出して警告）と T1-f（IDB に書けない Chunk をサーバーへ直接送り、だめなら WAV 書き出し）を実装した。T6 は T1-e で解消。
- インターフェース変更: `FinalizeResult` の成功に `missingTailMs?`、`RecordingControllerDeps.directSaver?`、`RecordingController.exportMemoryBacklog()`、`measureMissingTailMs()` を export（すべて追加のみ）。

### 2026-09-26（12 回目）

- 指摘 4 件を検証し 3 件を修正（start 前半の失敗でのトラック解放、Finalizer / ヘルスチェックの `redirect: "error"`、タイムアウトテストの fake timers 化）。回帰テスト 4 件は修正前に Red を確認した。
- ended リスナーの AbortController 化はスキップ（stop / rollBack でトラックを止めるため、止めたトラックは ended を発火せず挙動が変わらない）。

### 2026-09-26（11 回目）

- 指摘 4 件を検証し、すべて修正した（Scheduler の保存済み Chunk の書き戻し、起動時復旧の resumeAll が録音中の会議に触れる問題、start 失敗時のトラック解放、ended リスナー）。回帰テスト 5 件は修正前に Red を確認した。
- インターフェース変更: `LocalSaveScheduler.resumeAll(skipMeetingIds?: ReadonlySet<string>)`（省略可・既存呼び出しは変更なし）。

### 2026-09-26（10 回目）

- 指摘 4 件を検証し、すべて修正した（Worklet の VAD 境界、LocalSaver の redirect、`start()` 失敗時の巻き戻し、設計書 §24.2 / §24.4）。回帰テスト 3 件は修正前に Red を確認した。
- 方針変更: 設計書の更新指摘は必ず対応する。7 回目に見送ったテストブロックの同期もここで対応した。
- PROGRESS の T5 を完了表記にし、T1-f の「degradedReasons に出ない」という古い記述を直した。

### 2026-09-25（9 回目）

- 指摘 3 件を検証した。会議ロック（Web Lock）で録音と復旧を協調させる指摘と、非クォータ書き込み失敗を degradedReasons に出す指摘は修正した（回帰テストは修正前に Red を確認）。
- ChunkStore の再オープン（アップグレード後は `VersionError` で直らない）と stop 未完了状態（抜け出す経路がない）は見送り、T1-f / T1-e に理由を追記した。

### 2026-09-25（7 回目）

- CodeRabbit の指摘 6 件を検証し、5 件を修正した。回帰テスト 2 件（Finalizer の重複呼び出し、`isMeetingRecord`）は修正前に Red を確認した。
- 設計書 §24.1 / §24.2 のテストブロックを実装のイベント同期に揃える指摘は、テストブロックは「最低限の集合」で差分を許容する方針のため見送った。

### 2026-09-25（6 回目）

- CodeRabbit の指摘 5 件を検証した。4 件（照合スクリプト 2・PROGRESS の T7・Finalizer の `endedAt`）を修正し、`finalChunkCount` を `stop()` で確定させる案は復旧経路に影響するため T6 に追記して見送った。`endedAt` の回帰テストは修正前に Red を確認した。

### 2026-09-25（4 回目）

- CodeRabbit の指摘 11 件（インライン 9・nitpick 2）を検証した。10 件を修正し、`stop()` タイムアウト時の専用状態は設計判断が要るため T6 に回した。回帰テスト 4 件（scheduler・recovery・finalizer・idb）は修正前のコードで Red になることを確認した。
- `listUnfinished` の索引化は振る舞いが変わらないため、既存テストで確認した。起動時復旧の non-retryable 再送は T7 に積んだ。

### 2026-09-25（3 回目）

- CodeRabbit の指摘 6 件（インライン 5・nitpick 1）を検証した。5 件を修正し、回帰テスト 6 件は修正前のコードで Red になることを確認した。Web Lock による復旧との排他は設計判断が要るため T5 に回した。

### 2026-09-25（2 回目）

- CodeRabbit の指摘 9 件（インライン 6・範囲外 2・nitpick 1）を検証し、すべて有効と判定して修正した。回帰テスト 8 件は、修正前のコードで Red になることを確認した。
- Worklet プロトコルを変更した: `flush` / `stop` / `flushed` に `requestId` が必須になった。`RecordingControllerDeps.setTimer` を省略可能な引数として追加した。
- Finalizer は `stop_requested` / `finalizing` の会議だけを進める（`finalizing` は POST 中のクラッシュからの再試行のため許可）。

### 2026-09-25

- CodeRabbit のレビュー指摘 6 件を検証し、全件修正した（詳細は「未コミットの変更」）。回帰テストは Finalizer の 2 件のみ追加し、残りは T1 に回した。
- `design-local-phase1.md` と `design-local-phase2-client.md` を実装に同期した。phase2-client にも同じ不具合があったため、同じ形で修正した。
- `CLAUDE.md`（開発ルール）、`PROGRESS.md`（本ファイル）、プロジェクトスキル 3 件を追加した。
