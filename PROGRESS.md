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

- 自動テスト: 17 ファイル / 164 件がすべて通過。`npm run typecheck` もエラーなし。
- 設計書と src の同期: `src/` の埋め込みコードはすべて一致。未実装の 2 ファイル（`page-lifecycle.ts`、`quota-monitor.ts`）だけが MISSING。確認手順は `design-doc-sync` スキルにある。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 未コミットの変更（2026-09-25 時点・2 回目のレビュー対応）

| 変更 | 内容 | 推奨コミット |
| --- | --- | --- |
| `src/**`、`test/**` | レビュー指摘の修正（Finalizer の状態の前提条件、Scheduler の runOne 例外からの復旧、HealthMonitor の UNREACHABLE 時の null 化、flush/stop の requestId＋タイムアウト）と回帰テスト。HealthMonitor のポーリングテストをフェイクタイマー化 | `fix(recording): ...` |
| `design-local-phase1.md`、`design-local-phase2-client.md` | 上記を設計書に反映。phase2-client は stop の最終フレーム数の永続化、persistChunk の全エラーでのメモリ待機、Finalizer の型ガードも修正 | `docs(phase1): ...` |
| `.gitignore` | `.env`、`*.wav`、`recordings/` を除外 | `chore(setup): ...` |

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

### 保留・メモ

- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

### 2026-09-25（2 回目）

- CodeRabbit の指摘 9 件（インライン 6・範囲外 2・nitpick 1）を検証し、すべて有効と判定して修正した。回帰テスト 8 件は、修正前のコードで Red になることを確認した。
- Worklet プロトコルを変更した: `flush` / `stop` / `flushed` に `requestId` が必須になった。`RecordingControllerDeps.setTimer` を省略可能な引数として追加した。
- Finalizer は `stop_requested` / `finalizing` の会議だけを進める（`finalizing` は POST 中のクラッシュからの再試行のため許可）。

### 2026-09-25

- CodeRabbit のレビュー指摘 6 件を検証し、全件修正した（詳細は「未コミットの変更」）。回帰テストは Finalizer の 2 件のみ追加し、残りは T1 に回した。
- `design-local-phase1.md` と `design-local-phase2-client.md` を実装に同期した。phase2-client にも同じ不具合があったため、同じ形で修正した。
- `CLAUDE.md`（開発ルール）、`PROGRESS.md`（本ファイル）、プロジェクトスキル 3 件を追加した。
