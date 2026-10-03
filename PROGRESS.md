# 進捗と次の作業

最終更新: 2026-10-03 終了時（ブランチ `dev`）

新しいセッションはこのファイルから始める。作業を終えたら「現在地」「次の作業」「セッションログ」を更新する（ルールは [CLAUDE.md](CLAUDE.md)）。

---

## 現在地

Phase 1（ブラウザ録音 → IndexedDB → ローカル常駐サーバーへ PUT → finalize）のクライアント側を、[design-local-phase1.md](design-local-phase1.md) §30 の Step 順に実装している。

| Step | 内容（設計書の節） | 状態 | 完了判定 |
| --- | --- | --- | --- |
| 1-a | §16 WAV エンコーダ | ✅ 自動テスト済 | `chunk-standalone.test.ts` 通過 |
| 1-b | §14 Worklet（リサンプラ・VAD・蓄積） | ✅ 自動テスト済 | `long-recording.test.ts` / `resampler-aliasing.test.ts` 通過 |
| 1-c | §10 IndexedDB + §15 RecordingController | ✅ 保存・全WAV音声確認済み（次Stepへ進む） | 30秒×10件＋16.115125秒×1件、全件valid。利用者が全11件の音声を確認。Chrome単体再生は未確認として残す |
| 1-d | §17 LocalSaver / Scheduler + §18 BackendHealthMonitor | ✅ 実ブラウザで確認（T4-A 合格 2026-10-01、T4-B サーバー停止5分 合格 2026-10-03） | — |
| 1-e | §22 Finalizer + §23 Recovery | 🟡 強制終了 → 復旧 → `finalized` を実機確認（T4-C、2026-10-03） | **未**：終了時に未送信 Chunk がある状態からの再送（任意の C2） |
| 1-f | §19 ヘルス / §20 ページライフサイクル / §21 クォータ + §31 配線 + UI | 🟡 コード・自動テスト・最小 UI あり | **未**：§28.3 の手動項目（実マイク・実サーバー、T4） |
| 1-g | 60 分実録音 | ⬜ 未着手 | 120 Chunk・欠番なし・全件 `DB_REGISTERED`・外部通信なし |

- 自動テスト: Python 6 件、TypeScript 22 ファイル / 306 件がすべて通過。`npm run typecheck` も通過（2026-10-03）。`npm run build` は 2026-09-28 に通過。
- 設計書と src の同期: 変更した Phase 1 の埋め込みコードは `scripts/sync-design-code.mjs` で同期。後続 Phase 2 client の会議情報保持とバナー文言も反映。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 今回の変更と残課題

- 着手時の作業ツリーは clean。2026-09-27 の「文書3件が未コミット」という引き継ぎ記述は現状と異なっていた。
- Python / FastAPI / SQLite の最小サーバー、5 API、トークン更新、CORS、原子的Chunk保存、冪等PUT、finalize検証を実装。ローカルループバックの health 応答を確認。サーバー用テスト4件が通過。
- クライアントの PUT 前会議登録を `MeetingRegistrar` に共通化。起動時復旧と直接送信も登録後に送る。並行登録、登録失敗からの再試行、IDB読取障害、トークン更新中の401をテスト。停止後バナーの誤表示も修正。
- 28 回目のレビュー対応（コミット済み 0a9f364・9178e96）：サーバーの finalize を先勝ちにし（`BEGIN IMMEDIATE` で PUT と直列化、コミット後に確定値から `meeting.json` を書く）、確定済み会議への新しい Chunk の PUT を `409 CONFLICT_MEETING_FINALIZED` で拒否。`ApiErrorBody.code` に同コードを追加。Phase 1 §12・Phase 2/3 server 設計書にも反映。変更は `minutes_local/phase1.py`・`server_tests/test_phase1_api.py`・`src/api/contracts.ts`・設計書3件。
- 29 回目のレビュー対応（コミット済み e44341d・13d2e84・6263d40、PR #8 で main へマージ済み）：`_write_atomic` を書き込みごとに一意な `.part`（`mkstemp`）へ変更し、同時 finalize の `meeting.json` 書き込みで一時ファイルを奪い合う問題を修正（Python 回帰テスト1件、修正前に Red を確認）。Phase 1 §12.1・Phase 2/3 server の `write_atomic` とテストに反映。README の強制終了手順をタスクマネージャー経由に、停止後の「録音は継続中」を不具合報告対象に修正。変更は `minutes_local/phase1.py`・`server_tests/test_phase1_api.py`・`README.md`・設計書3件・本ファイル。
- 31 回目（コミット済み ed90d84・ecd198a・53199a4）：実ブラウザで `/v1/health`・会議登録・PUT が**送信前に** `TypeError: Illegal invocation` で失敗していた（`this.fetchImpl(...)` のメソッド呼び出し。Node の fetch は this を検査しないため自動テストで検出できず）。`BackendHealthMonitor`・`LocalSaver`・`MeetingRegistrar` で fetch をローカル変数に取り出して呼ぶよう修正。回帰テスト3件（`test/harness.ts` の `browserLikeFetch`、修正前に Red を確認）。Phase 1 §17/§18 の埋め込みコードと Phase 2/3 client の同型4か所も修正。Playwright の Chromium で health 200・バナー解消を確認。
- README に Step 1-c の起動・読み取り専用のChunk検証・WAV再生手順を追加。実機画像で11件のIDB保存と `stop_requested` を確認。タイトル固定の検証スクリプトが「無題の会議」を見つけられなかったため、最新会議を検証する手順に修正。その後、全件の整合性と全11件の音声再生を確認済み（Chrome再生は未確認）。
- 実機画像で判明した停止後の「録音は継続中」バナーはコードと表示文言テストで修正済み。実ブラウザでの表示確認は残す。
- 残課題（1201352 から継続）: `src/main.ts` の停止後書き出しは Node の Vitest 対象外のため回帰テストなし。§28.3 の手動確認で「サーバー停止＋IDB 書き込み失敗 → 停止 → 書き出し」を確認する
- 残課題（前回から継続）: `enforceQuota` の `meetingId` 引数は未使用（API 維持のため残置）／Scheduler が saver を掴んだ後の `setToken` 競合の app レベルテストは未追加

---

## 次の作業

依存関係と並行実行の可否を明記する。「並行可」のタスクは、別エージェントや別セッションに分けても衝突しない（触るファイルが重ならない）。

### T0. 2026-09-26 までの未コミット変更のコミット ✅ 完了（今回の差分は別途未コミット）

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

### T3. アプリの配線と最小 UI ✅ 完了（2026-09-27）

設計は [design-local-phase1.md](design-local-phase1.md) §31（アプリの組み立て）。利用者判断（2026-09-26）：Vite を追加し、配線は設計書に節を足してから実装する。

| ID | 内容 | 状態 |
| --- | --- | --- |
| T3-a | Vite 7.3.6（devDependency）、`vite.config.ts`（127.0.0.1・strictPort・worker は ES）、`index.html`（§4.4 の CSP を meta で）、`src/main.ts`（Worklet を `?worker&url` で解決） | ✅ `npm run build` で Worklet が独立した JS として出る。dev サーバーで配信を確認 |
| T3-b | `src/app/app.ts`（`createApp` / `App` / `RecordingSession`）。§31.2 の配線表どおりに、Monitor↔Scheduler、起動時復旧、backend 復帰時の resumeAll と finalize 再試行、`setToken`、クォータ、drain、ページライフサイクル、stop → finalize をつないだ | ✅ `test/app.test.ts` 20 件。配線を 1 本ずつ外すと Red になることを確認済み |
| T3-c | 最小 DOM UI（§31.4） | ✅ 表示文言は Vitest、画面は Playwright で確認 |

T3-c の内容（§31.4）:
- `src/ui/recording-view.ts`（表示文言を作る純関数。28 件）と `src/main.ts`（DOM の薄い層）、`index.html`（画面と最小スタイル）
- `app.ts` に `listPendingFinalize()` / `retryFinalize()` を追加（「確定待ち」の手動再試行。backend 復帰時の自動再試行も同じ経路）
- Playwright で dev サーバーの画面を確認済み：サーバー未接続のバナー、ヘルプ文言が出る。コンソールのエラーなし（favicon は `data:,`）、通信先は 127.0.0.1 のみ
- 実マイクでの録音・同意ダイアログ・getUserMedia 拒否・タブの切り替えは未確認（T4）

### T4. 手動確認（Step 1-c / 1-d / 1-e / 1-f / 1-g）【A〜E 合格・F は途中（タブ切替・最小化のみ合格）】

- 1-c 結果：会議 `68c2f545-ff0a-4741-8f43-3b2fd46711c2`（無題の会議）。seq 0〜9 は各480,000サンプル、seq 10 は257,842サンプル。計316.115125秒、欠番なし、`fullChunks: 10` / `partialChunks: 1` / `allValid: true`。全11件の音声を利用者が確認した。Chromeでの単体再生は未確認（再生アプリ・OS・Chrome版も未取得）。外部通信ゼロの実機確認も未完了。録り直しは求めず、Chromeの確認を残して1-dへ進むと案内済み。

- 起動は `npm run dev` → http://127.0.0.1:5173/ 。1-c（実マイク → IDB）はサーバーなしでも確認できる（DevTools の Application → IndexedDB `minutes-local`）。
- 利用者承認済みの順序：1-c の5分実録音を利用者が操作して結果報告 → Python / FastAPI / SQLite の最小サーバーを実装 → 1-d〜1-f を結合確認。1-g の60分実録音は次回。詳細な1-cの手順は [README.md](README.md)。
- 最小サーバーは §12 の5 APIを実装済み。保存先は `private/phase1-data/`、127.0.0.1:43117。Pythonテストでトークン更新、CORS、原子的保存、冪等性、破損・容量不足・不完全な確定を検証済み。実ブラウザのPUTは未確認。
- 会議作成APIの配線漏れは修正済み。通常送信・復旧・直接送信は共通の登録を通り、録音開始はサーバーを待たない。
- 結果は [design-local-phase1.md](design-local-phase1.md) §28 の「状況」列に反映する。

### 次セッションの再開点：T4 実機再確認チェックリスト（2026-10-01 作成・未実施）

- **次セッションの再開点（2026-10-03 終了時）**：
  1. 両サーバーは停止済み。`npm run dev` と `.venv/bin/python -m minutes_local` を起動し、トークンをクリップボードへ（一致を `pbpaste` で確認）→ 利用者が保存。
  2. 会議 `73f09961…`（F-1 用、14 Chunk・seq 0〜13 登録済み、サーバーでは `recording`）を確定する。ブラウザで録音中のまま残っていれば停止、確定待ちなら「再試行」。
  3. **F-1 の画面ロックをやり直す**：新規会議で 30 秒録音 → **Control + Command + Q**（または Apple メニュー →「画面をロック」）→ 20 秒 → 解除。ロック・解除の時刻を控える。
  4. **F-2（マイク切断）**：新規会議で録音中にアドレスバー左のアイコン → Microphone をオフ →「マイクが切断されました…」を確認 → 停止 → Allow に戻して再読み込み。
  5. 余裕があれば G・H、任意で C2（サーバー停止中の強制終了）。
- **項目 F 途中（2026-10-03）**：会議 `73f09961…`（17:36:22 開始）。タブ切替（17:38:06〜17:38:21）・最小化（17:38:34〜17:39:08）とも、その間の seq 3・4 が予定どおり登録され警告なし → **合格**。画面ロックは未実施：利用者が記号「⌃」を Control と読めず別のキーを押し、何かのダイアログが出たまま約 1 分待った（文言・消え方は未確認）。その間 seq 5・6 の保存/送信が約 51 秒・21 秒遅れ、17:40:13 に同時登録。音声は欠けていない（全 Chunk 480,000 サンプル・offset 連続、seq 7 以降は通常の遅れ約 0.5 秒）。→ T11。
- **項目 E 合格（2026-10-03）**：同意キャンセルは何も表示せず録音・マイク要求・`POST /v1/meetings` なし（§3.9 はエラー表示を要求しないので、表の「エラー表示」はキャンセル時は不要と読む）。マイク Block では「マイクの使用が許可されていません…」を表示し録音せず、開始ボタンは再び有効。サーバーの会議数は 6 件のまま。**次は項目 F**（マイク権限を Allow に戻してから）。
- **項目 D 合格（2026-10-03）**：会議 `5bf17d06…`。録音中に別タブを開いても、新タブのお知らせ・確定待ちとも空で、元タブの seq 0〜3 は 30 秒間隔のまま登録。停止（17:23:31）で末尾 seq 4 の登録と同時刻に確定待ち（T10 と同じ）。停止後は両タブの確定待ちに表示され、新タブ側の「再試行」で `finalized`（5 Chunk・2,158,041 サンプル一致）。**次は項目 E**。
- **項目 C 合格（2026-10-03）**：会議 `d250e47c…`。seq 0〜8 登録後、録音 4:30〜5:00 の間にタスクマネージャーでタブを終了（時刻は控え損ね、サーバーの登録時刻から推定）。再読み込みで「前回中断された会議が 1 件」→ 手動操作なしで `finalized`（17:15:19）。`totalAudioFrames` 4,320,000 = 9 Chunk 分で一致、WAV 9 件。未送信 Chunk がなかったので再送経路は未検証。必要なら C2：サーバー停止中に強制終了 → サーバー再起動・トークン保存 → 開き直して再送を確認。**次は項目 D**。
- **項目 B 合格（2026-10-03）**：会議 `fb47e917…`。seq 0〜4 登録後にサーバーを 16:49:55〜16:55:15 停止。停止中はバナーの保持件数が増え、health は約5秒ごとに失敗、PUT なし、`[BackendHealthMonitor]` 警告は1回のみ。再起動直後は旧トークンで `POST /v1/meetings` 401 → 新トークン保存（16:55:42）で滞留 seq 5〜16 の12件が連番順に登録。停止後 26 Chunk（12,380,951 サンプル）全件 `registered`・WAV 26件・`meeting.json` 一致・`finalized`。確定は `waiting_local_save` から手動「再試行」（→ T10）。**次は項目 C**。
  - 途中経過：最初の会議 `c8512a13…`（7 Chunk）は旧トークンで 401 → 保存で seq 0〜5 を一括再送（401 復帰の実機確認）。利用者が誤って録音停止したため B には使わず、「再試行」で `finalized`。DevTools Network のフィルタに `health` が残っていて PUT が見えなかった点に注意。
- **項目 A 合格（2026-10-01）**：`68c2f545…` 11 Chunk・`e8328b9e…` 1 Chunk とも SQLite `finalized`・全件 `registered`・WAV と `meeting.json` あり。サンプル合計も 1-c の記録と一致。2 件目は `waiting_local_save` で止まり手動「再試行」で確定（§31.2 の既知の制約）。**次は項目 B**。
- 項目 A 中に見つかった別問題：保存済みトークンが 17 文字の非 ASCII（クリップボードの取り違え）で、全 fetch がヘッダー生成時に `non ISO-8859-1 code point` で失敗し「サーバー未接続」と表示されていた。再保存で解消。
- **2026-10-01 31 回目**：項目 A の最中に、ブラウザから 43117 への要求が1件も出ない不具合を発見・修正（上記「今回の変更」）。これ以前の「実ブラウザ確認済み」報告でサーバーにデータが無かったのはこれが原因。修正後、利用者のタブを再読み込みして A から再開する。

- 利用者は一度実ブラウザで確認したと報告したが、2026-10-01 にサーバー側を読み取り専用で照会すると、`private/phase1-data/minutes.sqlite` は meetings 0 件・audio_chunks 0 件、`recordings/` なし（最終更新 2026-09-28 11:44）。**実ブラウザの PUT が既定データ領域に届いた証拠はない**。1-d は通過扱いにしない。
- 利用者の依頼で、確認項目を下表にまとめた。利用者が再確認して結果を報告 → Claude がサーバー側を照合（SQLite・`recordings/<id>/` の WAV 件数と `meeting.json`・`GET /v1/meetings/<id>/chunks`・サーバーログ）→ §28 と本ファイルへ記録、の順。報告は途中の項目まででよい。
- 再開時の Claude 側：`npm run dev` と `.venv/bin/python -m minutes_local` をバックグラウンドで起動し `/v1/health` 200 を確認。起動のたびトークンが変わるので `pbcopy < private/phase1-data/token` でクリップボードへ渡す（値は表示しない）。2026-10-01 のセッションでは両サーバーを起動したが、終了時に停止した。
- 共通：Chrome で **http://127.0.0.1:5173/**（localhost 不可）。DevTools の Network（Preserve log）と Application → IndexedDB `minutes-local` を開く。項目ごとに会議ID・OK/NG、NG なら HTTP ステータス・画面表示・Console を報告。

| # | 項目 | 操作 | 合格条件 |
| --- | --- | --- | --- |
| A | 1-d 既存会議の送信・確定 | トークン保存 → 確定待ちの `68c2f545…` で「再試行」 | `POST /v1/meetings` 200/201、`PUT …/chunks/mic/0〜10` 200/201、`GET …/chunks`・`POST …/finalize` 200。IDB で会議 `finalized`・11件 `DB_REGISTERED`。停止後に「録音は継続中」が出ない。**サーバー側照合**：SQLite に会議1件・Chunk 11件、`recordings/68c2…/` に WAV 11件と `meeting.json`、GET 一覧 seq 0〜10 全件 registered |
| B | 1-d/1-e サーバー停止5分 | 新規会議で録音 → サーバー停止（Claude に依頼可）→ 5分継続 → 再起動・新トークン入力 | 停止中「サーバー未接続」表示と IDB 滞留。復帰後に連番順で再送・全件 `DB_REGISTERED`。録音停止後 `finalized` |
| C | 1-e 強制終了 | 別の新規会議で Chunk が1件以上入ったら Chrome タスクマネージャーでタブのプロセスを終了 → 同じ URL を開き直す | 保存済み Chunk が再送され `finalized` まで進む（直近最大30秒の欠落は仕様） |
| D | 1-f 別タブ | 録音中に同じ URL を別タブで開く | 録音中の会議が勝手に `stop_requested` / `finalized` へ移らない |
| E | 1-f 同意・権限 | 同意キャンセル／マイク権限拒否 | 録音が始まらずエラー表示 |
| F | 1-f 録音中の異常 | マイク切断・タブ切替・最小化・画面ロックを個別に | 警告表示。録音状態と Chunk 連番を記録（画面ロックは観測のみ） |
| G | 1-f WAV 書き出し | 下の手順5のとおり（サーバー停止＋putChunk 失敗注入 → 停止 → 書き出し → 再生 → 注入解除） | 警告表示、書き出した WAV が再生できる |
| H | 横断 | Chrome で既存 Chunk を1件再生、全試験で Network を監視 | 再生できる。127.0.0.1 以外への通信なし |

1-g（60分実録音）は別試験として最後。以下は各項目の詳細手順（旧版、内容は上表と同じ）。

### 実機確認の詳細手順

以下は順番に実施する。自動テストとループバックの `/v1/health` は通過したが、**2026-09-28 時点で既存会議の実サーバー登録は未確認**。最後の読み取り専用API確認では会議 `68c2f545-ff0a-4741-8f43-3b2fd46711c2` に404が返った。ブラウザの録音データと `private/phase1-data/` は削除せず、Step 1-c の5分録音もやり直さない。

1. **起動・準備**：2026-09-28 の作業終了時にVite（5173）とAPI（43117）は利用者の依頼で停止済み。リポジトリで `git status --short` を確認し、今回の未コミット差分を保持する。`lsof -nP -iTCP:5173 -sTCP:LISTEN` と `lsof -nP -iTCP:43117 -sTCP:LISTEN` で待受を確認し、停止していれば別ターミナルで `npm run dev`、`.venv/bin/python -m minutes_local` を起動する（依存がなければ先に `npm ci` / `uv sync --extra test`）。サンドボックス内で bind が `EPERM` ならサンドボックス外の起動を申請する。サーバー起動のたびトークンは再生成されるので、現行の `private/phase1-data/token`（0600）の内容をブラウザのトークン欄に入力する。トークン値はログ・報告・コミットに載せない。Chromeでは `localhost` ではなく **http://127.0.0.1:5173/** を使う（既存IndexedDBと同じオリジン）。
2. **1-d：既存11 Chunkの送信・確定**：Chromeで上記URLを開き、DevTools の Network（Preserve log）と Application → IndexedDB → `minutes-local` を表示する。トークンを保存し、画面に「確定待ち」が残れば対象会議の「再試行」を押す。Networkで `POST /v1/meetings` が200/201、同会議の `PUT /chunks/mic/0`〜`10` が200/201、`GET /chunks` と `POST /finalize` が200であることを確認する。OPTIONSはCORSプリフライトなので正常。IDBの対象会議が `finalized`、11件のChunkが `DB_REGISTERED`、GET一覧で seq 0〜10・全件 `registered: true` なら1-dの実機判定を通す。停止後バナーに「録音は継続中」が出ないことと、Networkに外部ホストがないことも記録する。失敗時はHTTPステータス・画面通知・Consoleを記録し、データ削除や録り直しをせず原因を調べる。
3. **1-d/1-e：停止・復旧**：別の新規会議で録音を始め、サーバーをCtrl+Cで止めて5分間録音を続ける。録音中はタブを維持し、IDBの滞留Chunkと「サーバー未接続」表示を確認する。録音を続けたままサーバーを再起動して新しいトークンを入力し、連番順に再送され全件 `DB_REGISTERED` になることを確認してから録音停止し、`finalized` を確認する。強制終了の試験はさらに別の新規会議で、Chunkが1件以上IDBに入った後、Chromeのタスクマネージャーから録音タブのプロセスを終了して再度同じURLを開く（通常のタブ閉じはpagehideを通るため代用しない）。保存済みChunkが再送され、会議が確定待ちから復旧することを確認する。直近最大30秒が失われうることは仕様として記録する。
4. **1-f：ブラウザの手動項目**：新規会議で一方のタブが録音中に同じURLを別タブで開き、前者が勝手に `stop_requested` / `finalized` へ移らないことを確認する。同意キャンセル、マイク権限拒否、録音中のマイク切断、タブ切替、最小化、画面ロックを個別に試し、画面の警告・録音状態・Chunk連番を記録する。画面ロック時のAudioContext動作はOS依存として観測結果のみ記す。Chrome単体での11 WAV再生と外部通信ゼロも、この機会に確認する。
5. **1-f：IDB障害＋サーバー停止時のWAV書き出し**：既存会議に触らず短い新規会議を開始し、サーバーを停止する。DevTools Consoleで `const { ChunkStore } = await import('/src/storage/idb.ts'); window.__minutesOriginalPutChunk = ChunkStore.prototype.putChunk; ChunkStore.prototype.putChunk = async function () { throw new Error('T4 injected IDB write failure'); };` を実行する。30秒以上録音して1件以上のChunk生成を待ち、録音停止後、警告と「WAVを書き出す」ボタンからファイルを保存して再生確認する。最後に `ChunkStore.prototype.putChunk = window.__minutesOriginalPutChunk; delete window.__minutesOriginalPutChunk;` で注入を解除する（ページ再読み込みでも解除されるが、書き出し完了前は再読み込みしない）。この試験で書き出したWAVのサーバー取込経路は未設計なので、ファイルを手元に保持する。
6. **記録と次段階**：各試験の会議ID、Chunk件数・連番、IDB状態、HTTPステータス、警告・エラー、外部通信の有無を [design-local-phase1.md](design-local-phase1.md) §28 と本ファイルへ反映する。失敗時は原因と再試験条件を記し、通過扱いにしない。必要な修正後は `.venv/bin/python -m pytest -q`、`npm run typecheck`、`npm test`、`npm run build`、`node scripts/sync-design-code.mjs --check`、`git diff --check` を実行する。1-g の60分実録音（120 Chunk、欠番なし、全件 `DB_REGISTERED`、外部通信なし）は別の試験として最後に実施する。コミットは利用者の指示・承認後のみ行う。

### T11. ダイアログ表示中に Chunk の保存・送信が止まる疑い【要調査・T4-F の後】

- T4-F で、何らかのダイアログ（⌘Q による「Chrome を終了しますか」や、ページの離脱確認の可能性）が出ている約 1 分間、seq 5・6 の登録が遅れた。ページのメインスレッドが止まるダイアログ（beforeunload の確認など）であれば、Worklet が作った Chunk の IDB 書き込みも待たされ、その間のクラッシュで「直近最大 30 秒」を超えて失われうる。
- 次回、利用者にダイアログの文言を確認するか、録音中に Command + Q を押して再現する。原因がページのダイアログなら、§20 に「確認ダイアログ中は保存が止まる」旨を書くか、警告の出し方を見直す。

### T10. 録音停止のたびに「確定待ち」になる【T4 の後／要方針確認】

- T4-A・`c8512a13`・T4-B・T4-D の 4 回とも、停止直後は末尾 Chunk が PUT 中のため Barrier が `waiting_local_save` で止まり、手動の「再試行」が要った。§31.2 の「既知の制約」は実際には毎回起こる。
- 案：Chunk の登録完了（Scheduler の成功通知）で、その会議が確定待ちなら Barrier を自動で再試行する。1-g（60分録音）の前に入れるかを利用者と決める。
- 付随の観察：`MeetingRegistrar` は成功結果を覚えないため、PUT 2 件ごとに冪等な `POST /v1/meetings` が出る。実害はないが、要求数を減らすなら登録済み会議をメモする。

### T9. T4-A で見つかった UI/診断の改善 ✅ 完了（a・c 2026-10-01、b 2026-10-03）

- a. ✅ 完了（2026-10-01・32 回目）：`App.setToken` が空白を含まない印字可能 ASCII 以外を保存せずエラーにする。テスト3件（修正前に Red を確認）。§4.3・§31.2 に反映。
  - 元の課題：トークン保存時に形式を検証する（ISO-8859-1 外・空白混入を拒否して通知）。現状は `trim()` のみで、不正な値を保存すると全通信が送信前に例外になり「サーバー未接続」とだけ出る。
- b. ✅ 完了（2026-10-03・33 回目）：`BackendHealthMonitor.checkOnce` の例外で UNREACHABLE にしたとき、`<name>: <message>` を `console.warn` に残す。同じ理由は連続して出さず、到達できたらリセット。テスト2件（修正前に Red を確認）。§18 の本文に追記。`LocalSaver`・`MeetingRegistrar` は元から理由を `fail()` に残しているため対象外。`App` の `getMeeting` フォールバックの `catch {}` は代替値を返す設計なので据え置き。
  - 元の課題：`BackendHealthMonitor.checkOnce` などの `catch {}` で UNREACHABLE とした理由を `console.warn` に残す（原因特定に時間を要した）。
- c. ✅ 完了（2026-10-01・32 回目、文言修正を採用）：「確定待ち（サーバーへの保存が終わったら、確定待ちの会議の「再試行」を押してください）」に変更。Chunk 登録完了時の自動再試行は未着手（必要になったら別タスク）。
  - 元の課題：`finalizeResultText` の `waiting_local_save` 文言「サーバーへの保存が終わると自動で確定します」が §31.2 の既知の制約（自動再試行されない）と食い違う。文言を直すか、Chunk 登録完了時に Barrier を再試行する配線を足すかを決める。

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

### 2026-10-03（34 回目・T4 項目 B〜E 合格、F 途中）

- T9-b は利用者がコミット済み（4dc9d5f・9dfc146・1bbbe81）。B の記録も 2eac422・6de6df7 でコミット済み。
- T4-C 合格（会議 `d250e47c…`、強制終了後の復旧で自動 `finalized`）。手順説明で「終了時刻を控える」を事前に伝えず、時刻はサーバー記録から推定した。
- T4-B を実施し合格（会議 `fb47e917…`、26 Chunk、停止中12件を連番順に再送）。401 からの復帰も実機で確認。§28.2・§28.4 と本ファイルに記録。
- 停止のたびに手動「再試行」が要る点を T10 として起票。C では末尾 Chunk が送信中でなかったため再試行は不要だった（T10 の仮説と整合）。D・E も合格。F はタブ切替・最小化のみ合格、画面ロックは未実施（T11 の観測あり）。両サーバー停止済み。
- 案内の反省：キー操作は記号（⌃⌘）でなく「Control + Command + Q」と書く。時刻の記録など「後で必要になる操作」は試験前に伝える。

### 2026-10-03（33 回目・T9-b）

- 着手時の作業ツリーは clean（32 回目の変更はコミット済み 1e57bd6・2cd0d4b・8df9be4）。
- T9-b（ヘルスチェック失敗理由の `console.warn`）を TDD で実装し、Phase 1 §18 を同期。typecheck・306 件通過。未コミット。
- 次は T4 項目 B（サーバー停止5分）。Console の `[BackendHealthMonitor] health check failed:` で停止中の理由を確認できる。

### 2026-10-01（32 回目・T9 a/c）

- 31 回目の変更は利用者がコミット済み（ed90d84・ecd198a・53199a4）。
- T9-a（トークン形式の検証）と T9-c（確定待ち文言）を TDD で実装し、Phase 1 設計書を同期。typecheck・304 件通過。未コミット。
- 項目 B と T9-b は利用者の指示で次回以降。サーバー2つは30分の制限で停止済み（再開時に起動し直し、トークンを再保存する）。

### 2026-10-01（31 回目・T4 項目 A で fetch 不具合を発見）

- 両サーバーを起動しトークンを渡したが、トークン保存後も「サーバー未接続」。curl・CORS は正常で、ブラウザから要求が出ていなかった。
- 原因は `this.fetchImpl(...)` による Illegal invocation（health・会議登録・PUT の3経路）。TDD で修正し、Phase 1/2/3 client 設計書も同期。typecheck・301 件通過。未コミット。
- 保存済みトークンが非 ASCII だったことも判明し再保存で解消。項目 A 合格（2 会議・12 Chunk が finalized）。改善 3 件を T9 に記録。次は項目 B。

### 2026-10-01（30 回目・T4 再確認の準備）

- 利用者は実ブラウザ確認済みと報告したが、サーバーの SQLite は会議0件・Chunk0件で `recordings/` もなく、1-d の通過を裏付けられなかった。
- 利用者の依頼で確認項目 A〜H を「次セッションの再開点」にまとめた。両サーバーを起動しトークンを渡したが、利用者の時間の都合で中断し、サーバーは停止。
- PROGRESS の「29 回目は未コミット」という古い記述を訂正（PR #8 でマージ済み）。src・設計書は無変更。

### 2026-09-28（29 回目・レビュー対応）

- 指摘 3 件を検証し全件有効。一時ファイル共有による同時 finalize の `FileNotFoundError` を一意な `.part` で修正（回帰テストは修正前に Red を確認）。
- README：強制終了試験をChromeタスクマネージャーでのプロセス終了に、停止後の「録音は継続中」を既知の表示不整合から不具合報告対象に変更。
- 28 回目の残課題（`meeting.json.part` の共有）は解消。

### 2026-09-28（28 回目・レビュー対応）

- 指摘 3 件を検証。有効 2 件：同時 finalize で DB と `meeting.json` の確定値が食い違う／確定後の会議に新しい Chunk が登録される → 修正（Python 回帰テスト 2 件、修正前に Red を確認）。
- スキップ 1 件：`MeetingRegistrar` の成功キャッシュ（毎 PUT の POST は冪等でループバック内のため観測できる不具合がなく、キャッシュすると 404 時の無効化経路が新たに必要になる）。
- 残課題：同じ会議への同時 finalize は `meeting.json.part` を共有するため、まれに後発側の `os.replace` が失敗しうる（再送で回復）。

### 2026-09-28（27 回目・Step 1-d 実装）

- FastAPI / SQLite の最小サーバーと5 APIを実装。Pythonテスト4件、ループバックの health 応答を確認。録音データとトークンは `private/phase1-data/` に保持。
- PUT 前の会議登録を通常送信・復旧・直接送信に共通化し、並行登録とIDB障害時のフォールバックを追加。停止後バナーの文言も修正。
- TypeScript 22ファイル / 298件、型チェック、ビルドが通過。README・Phase 1/2 設計を更新。次は利用者のブラウザで既存11Chunkの実サーバー送信を確認する。
- 残る1-d〜1-gの実機確認手順を本ファイルへ集約。利用者依頼により終了時に5173と43117の両待受を停止し、`lsof` で待受なしを確認。

### 2026-09-27（26 回目・引き継ぎ）

- 利用者の追加画像で完全Chunk10件＋端数1件、全件valid・欠番なしを確認。利用者から全11件の音声確認済みとの報告を受領。
- 1-cは次Stepへ進める状態として記録。Chrome単体再生・外部通信の実機確認は未確認のまま残す。
- 利用者のusage残量により実装は次セッションへ。最小サーバー・会議登録配線・検証順序を本ファイルに集約。未コミットは文書3件のみ。

### 2026-09-27（25 回目・実機画像の確認）

- 画像から11件のChunk保持、会議の停止・確定待ちを確認。完全Chunk数・ハッシュ・音声再生は画像から判断できないため未確認。
- Consoleのエラーは検証手順のタイトル固定が原因。READMEを最新会議の選択に修正し、録り直し不要と案内。
- 停止後の「録音は継続中」は表示不整合として記録。Step 1-c は合格扱いにせず追加結果を待つ。

### 2026-09-27（24 回目・T4 着手）

- 承認済み計画に従い、Step 1-c の開発サーバーを起動し、利用者に5分録音の操作を案内。
- README に会議を限定したChunk検証・個別WAV保存／ブラウザ再生手順を追加。実機確認は未実施扱いを維持。
- 前回の未コミット変更の記述とテスト件数を訂正。次は利用者の実機結果を確認してから1-dへ進む。

### 2026-09-27（23 回目）

- レビュー指摘 1 件（有効）：`startRecording` の二重開始ガードが `session` だけを見ており、await 中の同時開始（別会議 ID）を通していた → 開始中フラグを `finally` で下ろす形で追加（回帰テスト 2 件、並行開始は修正前に Red を確認）。

### 2026-09-27（22 回目）

- T3-c：設計書 §31.4 を追加し、表示文言の純関数 `recording-view.ts`（28 件）と DOM 層 `main.ts`・`index.html` を実装。`app.ts` に確定待ちの一覧と手動再試行を追加（3 件）。
- `recovered` が `createApp` の中で届くため、そのときまだない `app` を参照して起動が失敗する不具合を、実装中に見つけて回避した。
- Playwright で画面・コンソール・通信先を確認。次は T4（実マイク・実サーバーでの手動確認）。

### 2026-09-27（21 回目）

- T3-a：Vite を追加し、127.0.0.1 の開発サーバーと、Worklet を別エントリで出力するビルドを用意。§4.4 に「`frame-ancestors` は meta では無効」を追記。
- T3-b：設計書 §31 を追加し、`src/app/app.ts` を TDD で実装（15 件）。`attachPageLifecycle` の引数を `Pick<RecordingController, "flush">` に絞った（§20）。
- レビュー指摘 2 件を検証。有効 1 件：`directSaver` が録音開始時の LocalSaver を固定していた → 送るたびに現在の saver を引く口に変更（回帰テスト 2 件）。スキップ 1 件：`enforceQuota` の「削除後も 95% 以上」は次の Chunk の確認で `export_required` になり、停止後は守る IDB 書き込みがないため（§21 の API も変えない）。
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
