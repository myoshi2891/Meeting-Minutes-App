# 進捗と次の作業

最終更新: 2026-09-25（ブランチ `dev`）

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

- 自動テスト: 17 ファイル / 177 件がすべて通過。`npm run typecheck` もエラーなし。
- 設計書と src の同期: `src/` の埋め込みコードはすべて一致。未実装の 2 ファイル（`page-lifecycle.ts`、`quota-monitor.ts`）だけが MISSING。確認手順は `design-doc-sync` スキルにある。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 未コミットの変更（2026-09-25 時点・4 回目のレビュー対応）

| 変更 | 内容 | 推奨コミット |
| --- | --- | --- |
| `src/**`、`test/**` | `resumeAll` が non-retryable の `LOCAL_SAVE_FAILED` を再投入しない（`isRetryableError` を `LocalSaver` と共有）。復旧が `recording` の会議の `audioFrameCount` を Chunk の最大 `endFrame` から復元。`openDatabase` が blocked 後の接続を閉じる。`listUnfinished` が索引の範囲で DB_REGISTERED を除く。Finalizer が不一致をすべて再投入。テスト 7 件追加（うち回帰 4 件） | `fix(recording): ...` |
| `test/**`（テストの同期方法） | health monitor のテストをフェイクタイマー・`performance.now` スタブに変更。Worklet テストを `startProcessor` / `nextFlushed` / `nthChunk`（`test/harness.ts` に移設）のイベント同期に変更 | `test(worklet): ...` |
| `.claude/skills/design-doc-sync/scripts/check_design_sync.py` | 前後の空白を削らずにファイル全体と比較する | `chore(claude): ...` |
| `design-local-phase1.md`、`design-local-phase2-client.md` | 上記を設計書に反映。phase2-client は `fetchWithTimeout` が本文をタイムアウト内で読み、Finalizer の不一致を一括再投入 | `docs(phase1): ...` |

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
- Worklet を配信するには開発サーバー / バンドラ（例: Vite）が要る。**依存の追加になるので、着手前に利用者に確認する。**

### T4. 手動確認（Step 1-c / 1-d / 1-e / 1-g）【T3 の後】

- 1-d・1-e には実サーバーが要る。Phase 2 サーバー設計（[design-local-phase2-server.md](design-local-phase2-server.md)、Python）から、`/v1/health`・`PUT chunk`・`GET chunks`・`POST finalize` だけの最小スタブを作るかを判断する。
- 結果は [design-local-phase1.md](design-local-phase1.md) §28 の「状況」列に反映する。

### T5. 録音中の会議を起動時復旧から守る【T3 の前に方針決定が必要】

- 2026-09-25 のレビュー指摘（3 回目）で有効と判定したが見送った。別タブで録音中に新しいタブが開くと、`recoverOnStartup` がその会議を `stop_requested` に落とし、Barrier の自動再試行で録音中に finalize されうる（§3.1 で複数タブの同時録音を許している）。
- 候補: 録音中は会議ごとの Web Lock（`navigator.locks.request("minutes:meeting:<id>")`）を保持し、復旧はロックを `ifAvailable` で取れた会議だけを処理する。ロック API は依存注入してテストで Fake にする。`RecordingControllerDeps` と `recoverOnStartup` の引数が増えるので、着手前に利用者に確認する。

### T6. stop() の Worklet 無応答をどう扱うか【方針決定が必要】

- 2026-09-25 のレビュー指摘（4 回目）で有効と判定したが見送った。`stop()` の `requestFlush` がタイムアウトすると、最終の部分 Chunk が届かないまま会議が `stop_requested` になり、Barrier は末尾が欠けたまま finalize できてしまう（`onError` の通知だけ）。
- 指摘の案は「専用の失敗状態（例: `stop_failed`）を追加し、Finalizer と復旧で進めない」。ただし `MeetingStatus` の追加は Phase 2 以降の設計とサーバー契約にも影響し、その会議を利用者が確定させる手段（手動 finalize）も要るため、着手前に利用者に確認する。

### T7. 起動時復旧が non-retryable の Chunk も再送する【小・T0 の後】

- `recoverOnStartup` は DB_REGISTERED 以外の Chunk をすべて `LOCAL_SAVE_PENDING` に戻すため、non-retryable の `LOCAL_SAVE_FAILED` も起動のたびに 1 回再送される（`resumeAll` 側は 4 回目のレビューで修正済み）。`isRetryableError` で除外するかを決める。

### 保留・メモ

- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

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
