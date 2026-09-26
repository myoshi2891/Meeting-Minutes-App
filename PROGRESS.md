# 進捗と次の作業

最終更新: 2026-09-27（ブランチ `dev`）

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
| 1-f | §19 ヘルス / §20 ページライフサイクル / §21 クォータ + §31 配線 + UI | 🟡 §19〜§21・§31 はコード・自動テストのみ | UI が未着手（T3-c）。§28.3 の手動項目 |
| 1-g | 60 分実録音 | ⬜ 未着手 | 120 Chunk・欠番なし・全件 `DB_REGISTERED`・外部通信なし |

- 自動テスト: 20 ファイル / 254 件がすべて通過。`npm run typecheck` もエラーなし。`npm run build` も通る。
- 設計書と src の同期: `src/` の埋め込みコードはすべて一致（MISSING なし）。確認手順は `design-doc-sync` スキルにある。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 未コミットの変更

なし（すべてコミット済み）。

---

## 次の作業

依存関係と並行実行の可否を明記する。「並行可」のタスクは、別エージェントや別セッションに分けても衝突しない（触るファイルが重ならない）。

### T0. 未コミット変更のコミット ✅ 完了（2026-09-26 時点で作業ツリーは clean）

### T1. レビュー修正の回帰テスト追加 ✅ 完了（2026-09-26・19 回目）

2026-09-25 のレビュー修正のうち、テストがないもの。どれも修正箇所を一時的に外して Red になることを確認済み。src は無変更。

| ID | 対象 | テストで再現する状況 | 触るファイル |
| --- | --- | --- | --- |
| T1-a | BackendHealthMonitor | ✅ `checkOnce` の応答待ち中に `stop()` → `start()` しても、ポーリングが 1 系統だけになる | `test/backend-health-monitor.test.ts` |
| T1-b | LocalSaveScheduler | ✅ backend 停止中に N 回 `enqueue` しても、各キーへの `BACKEND_UNAVAILABLE` 書き込みは 1 回だけ。復帰 → 再停止したら再び書く | `test/local-save-scheduler.test.ts` |
| T1-c | RecordingController | ~~`flush()` と `stop()` が重なっても、`stop()` は自分の `flushed` まで解決しない~~ → requestId 化の回帰テストで対応済み（2026-09-25） | — |
| T1-d | RecordingController | ✅ `stop()` 中に `meetingStore.put` が reject しても、トラック停止・`onmessage` の解除・会議ロックの解放が行われる | `test/recording-controller.test.ts` |

### T1-f. IDB 書き込みの非クォータ失敗と versionchange からの回復 ✅ 完了（2026-09-26・利用者判断：直接送信＋書き出し）

- `drainMemoryBacklog()` はクォータ以外の失敗で `directSaver`（`LocalSaver`）からサーバーへ直接 PUT し、失敗したら例外を投げてメモリ待機に残す。`exportMemoryBacklog()` で WAV を書き出せる。
- Finalizer は IDB にない連番でもサーバーに登録済みなら揃っているとみなす。
- 残り：UI 配線は T3、書き出した WAV をサーバーへ取り込む経路は保留・メモへ。

### T1-e. stop タイムアウト時の扱い ✅ 完了（2026-09-26・利用者判断：検出して警告）

- 状態は増やさない。Finalizer が確定時に `totalAudioFrames` と最後の Chunk の `endFrame` を比べ、欠けがあれば `{ ok: true, missingTailMs }` を返す（`measureMissingTailMs()` を export）。警告表示は T3。
- phase2-client §22 の「finalizing から再試行して失敗しても stop_requested に戻る」テストは、Phase 2 実装時に追加する。

### T2. Step 1-f: §20 / §21 の実装 ✅ 完了（2026-09-26・20 回目）

- 設計書のコードをそのまま配置し、テストを新規に書いた（`test/page-lifecycle.test.ts` 6 件、`test/quota-monitor.test.ts` 11 件）。
- DOM ライブラリは追加していない。`window` / `document` / `navigator` は `vi.stubGlobal` で差し替える（§24.1 に追記）。Node の `Event.returnValue` は旧仕様のアクセサなので、beforeunload の Fake はデータプロパティで上書きしている。
- `drainMemoryBacklog()` との連携は、§21 のコードが `QuotaAction` を返すだけで呼び出し側の責務なので、T3 の配線に移した。

### T3. アプリの配線と最小 UI（T3-a・T3-b 完了／T3-c が次）

設計は [design-local-phase1.md](design-local-phase1.md) §31（アプリの組み立て）。利用者判断（2026-09-26）：Vite を追加し、配線は設計書に節を足してから実装する。

| ID | 内容 | 状態 |
| --- | --- | --- |
| T3-a | Vite 7.3.6（devDependency）、`vite.config.ts`（127.0.0.1・strictPort・worker は ES）、`index.html`（§4.4 の CSP を meta で）、`src/main.ts`（Worklet を `?worker&url` で解決） | ✅ `npm run build` で Worklet が独立した JS として出る。dev サーバーで配信を確認 |
| T3-b | `src/app/app.ts`（`createApp` / `App` / `RecordingSession`）。§31.2 の配線表どおりに、Monitor↔Scheduler、起動時復旧、backend 復帰時の resumeAll と finalize 再試行、`setToken`、クォータ、drain、ページライフサイクル、stop → finalize をつないだ | ✅ `test/app.test.ts` 15 件。配線を 1 本ずつ外すと Red になることを確認済み |
| T3-c | 最小 DOM UI（`src/main.ts` から `createApp` を呼ぶ） | ⬜ 次に着手 |

T3-c でやること:
- トークン入力（`app.setToken`）、録音開始（getUserMedia・同意確認）/ 停止ボタン
- 状態表示：backend の状態、`pendingChunkCount`、`degradedReasons`
- `AppEvent` の表示：`finalized` の `missingTailMs` →「末尾 約◯秒が保存されていません」、`export_required`、`memory_backlog_export_required` → `session.controller.exportMemoryBacklog()` の WAV ダウンロード
- `onHidden` で `assessHealth` の監視間隔を詰める（§19 / §20）
- §20 のヘルプ文言（直近最大 30 秒が失われる可能性）
- `waiting_local_save` で終わった会議を「確定待ち」と表示し、手動で再試行できるようにする（§31.2 の既知の制約）

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

### T8. テストハーネスの固定 tick 待ちを条件待ちにする【T0 の後／テストのみ・要方針確認】

- 背景（16 回目のレビュー指摘、今回は見送り）: `test/harness.ts` の `advance()` は `setTimeout(0)` を 10 回、`test/local-save-scheduler.test.ts` の `advance` は 20 回回して非同期処理の完了を待つ。`FakeServer` の `sha256Hex`（crypto.subtle）と `Blob.arrayBuffer()` は libuv のスレッドプールで完了するため、負荷が高いと tick 数が足りずに不安定になりうる。
- 見送った理由: 指摘の案（`advance()` から待ちを外し、最終状態を `vi.waitFor` でポーリングする）では、`for (…) await h.advance(600_000)` のように「1 回の advance で保存と再試行タイマーの登録まで済んでいる」ことを前提にしたループが崩れる（タイマー登録前に時計だけ進む）。`backend-outage.test.ts`（設計書と完全一致）も同じ前提に立っている。
- 案: `advance()` の中で「待つ条件」を固定 tick 数から条件にする（例: Scheduler の `pendingCount` と送信中の数がともに 0 になり、FakeServer に処理中の要求がなくなるまで待つ。上限つき）。Scheduler に送信中の数を読むゲッターを足すかは要確認。
- 対象: `test/harness.ts`、`test/local-save-scheduler.test.ts`、`test/crash-recovery.test.ts`、`test/finalizer.test.ts`、`test/backend-outage.test.ts`、および設計書の対応するテストのコードブロック。

### 保留・メモ

- T1-f で書き出した WAV（`exportMemoryBacklog()`）をサーバーへ取り込む経路は未設計。必要になったら Phase 2 以降で API を検討する。
- `npm audit` で vitest 3 系（`@vitest/mocker`）に moderate 2 件。修正には vitest 5 への破壊的更新が要るため保留（vite 追加とは無関係）。
- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`、`test/resampler-aliasing.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

### 2026-09-27（21 回目）

- T3-a：Vite を追加し、127.0.0.1 の開発サーバーと、Worklet を別エントリで出力するビルドを用意。§4.4 に「`frame-ancestors` は meta では無効」を追記。
- T3-b：設計書 §31 を追加し、`src/app/app.ts` を TDD で実装（15 件）。`attachPageLifecycle` の引数を `Pick<RecordingController, "flush">` に絞った（§20）。
- 次は T3-c（最小 DOM UI）。

### 2026-09-26（20 回目）

- T2-a（§20 `page-lifecycle.ts`）と T2-b（§21 `quota-monitor.ts`）を TDD で実装。テスト 17 件追加、設計書の MISSING が 0 件に。
- `design-local-phase1.md` §24.1 にテスト環境（DOM ライブラリなしで globals を差し替える）を追記。
- 次は T3（配線と最小 UI。Vite など依存の追加は要確認）。

### 2026-09-26（19 回目）

- T1-a / T1-b / T1-d の回帰テストを 4 件追加（src 無変更）。各テストは修正箇所を一時的に外して Red を確認済み。
- `test/recording-controller.test.ts` の `setup()` に `nodePort`（AudioWorkletNode 側のポート）を追加。
- 次は T2（§20 / §21）。

### 2026-09-26（18 回目）

- トラックの `ended` リスナーを `AbortController` の signal 付きで登録し、`stop()` で解除するように修正（回帰テスト 1 件追加）。
- `design-local-phase1.md` および `design-local-phase2-client.md` を実装と同期。

### 2026-09-26（17 回目）

- レビュー指摘 3 件を検証。有効は 1 件（implement-design-step の設計書参照が phase1 固定）で修正。
- スキップ: §24.2/§24.4 のテストブロック（long-recording は MATCH、crash-recovery は 7 件すべて掲載済みで `flushMessages` もない。差分は許容範囲の DIFF(i) のみ）。`ended` リスナーの AbortController 化（`mediaStream` はインスタンス固定で同じトラックを指し、理由の重複も排除済みのため観測できる不具合がない）。

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
