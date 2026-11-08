# 進捗と次の作業

最終更新: 2026-11-08（利用者指示でテスト・サーバー停止、ブランチ `dev`）

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
| 1-f | §19 ヘルス / §20 ページライフサイクル / §21 クォータ + §31 配線 + UI | 🟡 T4-D〜G 合格（2026-10-03・10-07）、H は一部確認 | **未**：H の既存 Chunk の Chrome 再生（書き出した WAV の再生と外部通信なしは確認済み）。観察 4 件を T12 に起票（不合格扱いにはしない） |
| 1-g | 60 分実録音 | ⏸ 保留（2026-11-08 利用者指示・再開指示待ち） | 120 Chunk・欠番なし・全件 `DB_REGISTERED`・外部通信なし |

- 自動テスト（最新・51 回目の変更後）: TypeScript 23 ファイル / 415 件がすべて通過、`npm run typecheck` も通過（2026-11-08、Python・build は未実行）。50 回目の変更後は TypeScript 410 件・typecheck 通過。49 回目の変更後は Python 10 件、TypeScript 403 件・typecheck 通過。48 回目の変更後は TypeScript 397 件・Python 10 件・typecheck 通過。45 回目の変更後は TypeScript 372 件・Python 10 件、typecheck・`npm run build` 通過。44 回目の変更後の記録は TypeScript 365 件・Python 10 件・typecheck 通過。それより前（停止理由の永続化以前）の記録は Python 7 件・TypeScript 352 件。`npm audit` は前回確認で 0 件（2026-11-06、vite 7.3.7・vitest 5.1.0・certifi 2026.10.23）。
- 設計書と src の同期: 変更した Phase 1 の埋め込みコードは `scripts/sync-design-code.mjs` で同期。後続 Phase 2 client の会議情報保持とバナー文言も反映。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。

### 今回の変更と残課題

- 2026-11-08（51 回目・未コミット）：レビュー指摘 13 件を検証し 8 件を修正、5 件スキップ。(1) `LocalSaver.put()` の送り直しは `ensureMeeting` の確認後に最新トークンを読む。(2) 送り直し中もトークンが替わり続けた失敗に `tokenChanged: true` を付け（`MeetingRegistrar` も同じ）、Scheduler は試行上限に数えずすぐ再投入する（上限の回で `LOCAL_SAVE_FAILED` に残り、送信中で `setToken` の `resumeAll` に拾われなかった Chunk が止まる問題）。(3) `retryFinalize()` は停止状態の書き直しより前にメモリ待機を drain（書き直し失敗で確定は止めたまま）。(4) 起動時復旧は `stop_requested` の会議も `audioFrameCount` を保存済み Chunk の最大 endFrame まで補う（大きい値は維持）。(5) App テストの固定 50ms 待ちを、LIST 2 回と Scheduler の待機 0 件の待ちに置換。(6) Phase 2 client の Mic `stop()` は両方の読み取りで会議がなければ reject。(7) Phase 3 client の LocalSaver を Phase 1 現行全文（`ensureMeeting`・`unauthorizedReported`・`isRetryableError`・上記 1〜2）＋許可 origin に組み直し。(8) Phase 3 server に rebuild の停止理由の組（有効値の保持・不正値 6 通りの除去）のテストを追加。スキップ：Phase 3 client の 401 とトークンの対応付け（送り直しで既に古いトークンの 401 を報告しない）、トークン世代番号（A→B→A で A の 401 は現在のトークン A の失効を正しく示す）、ヘルスチェックの失敗経路のトークン照合（接続不能・5xx はトークンと無関係な到達性の観測で、次のポーリングで回復する）、Scheduler の中止後の NETWORK 再投入（`markAllPendingUnavailable` が中止会議のキーを外し、`runOne` が送信前に中止を確かめるので再送されない）、`pendingCountsText` の `Math.max` 展開（会議あたり数百件で引数上限に遠い）。回帰テスト 5 件追加・1 件強化（すべて修正前の Red を確認）。`fail()` の戻り型を失敗側に絞った（private）。TypeScript 415 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文（§9.2 遷移表、§17.1、§23、§31）を更新。
- 2026-11-08（50 回目・未コミット）：レビュー指摘 15 件を検証し 13 件を修正、2 件スキップ。(1) サーバー照合の不一致で送り直した Chunk の保存完了で 1 回だけ確定を確認し直す（`mismatchRechecked`、再び不一致なら止める）。(2) `listPendingFinalize()` は IDB の一覧取得に失敗しても `error` を通知して `unsavedStops` の会議を返す。(3) サーバー復帰時、確定中止した会議のメモリ待機は drain しない。(4) `prepareChunkPut()` は IDB 読み取り失敗時に `abandoned` を確かめ直してから送る。(5) 再試行ボタンで確定中止ボタンも無効化。(6) 確定待ちの内訳が読めなくても行とボタンを出す（`main.ts`）。(7) Controller は最終保存に失敗したら drain で空になってもロックを解放しない（`finalStopUnsaved`）。(8) 保持中のロックを渡すまで `start()` を拒否。(9) `LocalSaver` はトークン変更で送り直す前に `ensureMeeting` を再確認。(10) テスト：送り直し回数の固定、最終保存失敗後の drain でのロック保持、停止状態書き直しのテストをサーバー停止で始めて自動再試行の競合を除去（flaky を確認して修正）。(11) Phase 2 client の MultiSourceRecorder テストに停止引数の受け渡しを追加。既存テスト「照合不一致による再送完了で確定と再送を繰り返さない」の読み取り回数を 1→2 に更新（1 回の再確認を許す仕様変更）。スキップ：Scheduler の `markAllPendingUnavailable` の中止判定失敗（`LOCAL_SAVE_PENDING` と `BACKEND_UNAVAILABLE` はどちらも再開可能で、送信前に `runOne`／`resumeAll` が中止を再確認するため挙動が変わらない）、確定待ちの不完全表示をサーバー停止中に常時付ける件（末尾の直接送信は `audioFrameCount` との比較 `hasUnknownTail` で既に不完全と表示される。最終保存も失敗して再読み込みした場合はサーバー照合なしには判定できず、サーバー状態では解決しない）。`main.ts` の変更は Vitest 対象外（typecheck のみ）。TypeScript 410 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文（§15 ロック、§17 LocalSaver、§31 T10・中止・確定待ち表示）、Phase 2 client の Controller とテストを更新。Phase 3 client の LocalSaver は `ensureMeeting` を持たないので対象外。
- 2026-11-08（49 回目・コミット済み 0bd53e7 まで）：レビュー指摘 10 件を検証し 9 件を修正、1 件スキップ。(1) ヘルスチェックの成功も応答待ち中にトークンが替わったら捨てる。(2) Controller の drain はクォータ超過でもサーバーに登録できれば直接送る（停止後に末尾が永久に残らない）。(3) 最終保存に失敗した Controller はロックを保持し、App は停止状態を書き直すまでロックを解放しない（別タブが古い audioFrameCount で確定しない）。(4) 停止後もメモリ待機が残る間はページライフサイクルを外さず離脱確認を続ける。(5) 起動時復旧でロック後の読み直しに失敗した会議は触らず `unreadMeetingIds` で報告し、起動を続ける。(6) 一覧の認証エラーのテストを、会議登録は通して一覧だけ弾く形に組み直す。(7) 確定中止の確認文言のテストを強化。(8) Phase 3 rebuild は `endedAt` がなければ `endedAtEpochMs` を読む（テストを設計書に追加）。(9) 本ファイルの最新テスト集計を更新。スキップ：App テストで本物の Controller のクォータ経路を通す nitpick（`recording-controller.test` の既存テストが本物で同じ経路を検証済み）。TypeScript 403 件・Python 10 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文、Phase 2 client、Phase 3 server を更新。
- 2026-11-08（48 回目・コミット済み 5e05dd9 まで）：レビュー指摘 15 件を全件有効と判定して修正。(1) ヘルスチェックの 401/403 も失効回数に数える（応答待ち中にトークンが変わった 401 は無視）。(2) `LocalSaver` は 401 の本文読み取り後にトークン変化を確かめる。(3) 確定の会議登録がトークン変更中に失敗したら `finalizeTokenChanged` でやり直す。(4) 停止状態を IDB に書けなかった会議は `unsavedStops` で確定待ちに残し、会議ロック下で書き直す（`recording` なら丸ごと、`stop_requested` なら最終の `audioFrameCount` と未記録の停止理由だけ。それ以外は上書きしない。`session.stop()` は reject せず結果を返す）。(5) `retryFinalize` はサーバーが使えればメモリ待機を先に drain。(6) サーバー復帰時の drain を IDB の一覧取得より前へ。(7) 共有の IDB 保存警告は他の会議のメモリ待機が空になるまで外さない（Controller の `otherMeetingsBacklogCount`）。(8) 確定待ちの欠番判定を IDB 外の連番（`App.offIdbSequenceNos()`）で行う。(9) マイク切断の警告文言から保存の約束を外す。(10) pydantic v2 を依存に明記し lock 更新。(11) README の SQLite 確認を会議 ID 指定に。(12) Phase 2 client の `stop()` で最初の読み取り失敗でも flush し、最後に stop_requested と停止理由を書く。(13) テストの FakeController を本物と同じく開始時からロック保持にし、停止処理中の別タブ確定・中止の拒否をテスト。TypeScript 397 件・Python 10 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文、Phase 2 client、Phase 3 client を更新。
- 2026-11-08（47 回目・コミット済み f836da1 まで）：PR #12 の SonarCloud 品質ゲート失敗（新規コードの重複 3.3% > 3%）に対応。重複は `test/app.test.ts`（中止テスト 2 件の Arrange、25 行）と `test/recording-controller.test.ts`（メモリ待機のロック保持テスト 3 件の Arrange、37 行）のみで、それぞれ `abandonWhileRequestHeld()` / `startWithUnsavableBacklog()` に切り出した。テストの振る舞いは不変、TypeScript 383 件・typecheck 通過。
- 2026-11-08（46 回目・コミット済み 218e72e まで）：レビュー指摘 10 件を全件有効と判定して修正。(1) `LocalSaver.put()` は送信中にトークンが変わった 401/403 を新しいトークンで送り直し、それでも変われば再試行できる `UNKNOWN` で返す（古いトークンの 401 で失効報告・新トークンのヘルス成功の打ち消しをしない。Monitor は無変更）。(2) 直接送信の PUT の 401/403 を App が Monitor へ報告。(3) `prepareChunkPut()` は会議ロックを持たない会議の中止判定が読めなければ retryable で PUT を始めない。(4) Finalizer に `ensureMeeting` を追加し、一覧取得前に毎回会議を登録（Chunk 0 件の会議が 404 で止まらない）。(5) Scheduler：`runOne()` の中止判定の読み取り失敗は状態に触れず再投入、`resumeAll()` は会議ごとに判定して失敗した会議だけ次回へ、`markAllPendingUnavailable()` の settled 除去に index 確認。テストハーネスは `requireMeetingRegistration` 時に一覧・確定も 404 にし、`LIST:` / `FINALIZE:` を記録。テスト 11 件追加（うち 9 件と、既存の認証回復テスト 2 件の強化は修正前の Red を確認。残り 2 件は報告しない側のガード）。Phase 1 埋め込み同期（DIFF 0）・本文、Phase 2 client（Finalizer の登録、Mic/System のメモリ待機両方でのロック保持）、Phase 3 client LocalSaver、Phase 3 server rebuild の停止理由の組検証を更新。TypeScript 383 件・typecheck 通過。
- 2026-11-08（45 回目・コミット済み 8e550a0 まで）：CodeRabbit 指摘対応。(1) サーバーの `stopDetectedAtEpochMs` を SQLite 整数上限で検証（範囲外は 422）。(2) 会議登録の 401/403 を Scheduler が二重に Monitor へ報告しない（`unauthorizedReported`）。(3) 失効報告より前に始めたヘルスチェックの成功で `unauthorized` を解除しない。(4) `stop()` の最初の状態保存失敗が最終保存で回復したら停止を完了して確定へ進む（失敗は `onError`）。(5) メモリ待機が残る Controller の `start()` を拒否。(6) サーバー復帰時、確定の前に停止後のメモリ待機を drain（従来の残課題を解消）。(7) IDB が読めなくてもこのタブで中止した会議へ PUT しない。(8) 中止した会議の Chunk を待機件数から外す（`discardMeeting()`）。(9) 中止確認のキャンセルでボタンを即時復帰。テスト追加・Red確認済み。Phase 2 server の finalize にコミット後の `meeting.json` 書き出しを追加。ドキュメント網羅率（docstring）はスキップ。Python 10件・TypeScript 372件・typecheck・build 通過。テスト以外のサーバー起動はしていない。

- **最新：利用者指示で停止中。** 本作業のテスト・API・Viteを停止。5173・5188・43117・43118に待ち受けなし、関連テストプロセスも残っていないことを確認した。以下の過去ログの「起動中」は現在の状態ではない。
- 停止理由の永続化は作業途中・未コミット。`manual` / `mic_ended` と検出時刻をIDB→確定API→SQLite／`meeting.json`へ保存し、既存DBの列追加と旧データの未記録扱いを実装。追加テストのRedを確認後、TypeScript 358件・Python 10件、typecheck・buildが通過。Phase 1の埋め込みコード同期も確認済み。
- 2026-11-08（44 回目・未コミット）：レビュー指摘対応。(1) `stop()` は `stop_requested` の保存に失敗しても Worklet の末尾を Chunk にしてから切り離す。(2) メモリ待機が残る会議は stop 後も会議ロックを保持し、`takeMeetingLock()` で App が受け取って確定・中止に借用、空になったら解放（別タブが末尾欠けのまま確定しない）。(3) 確定待ちの不完全表示を件数でなく末尾フレームの網羅で判定（`App.offIdbEndFrame()`、`PendingCounts.offIdbEndFrame`）。(4) 開始処理中のマイク切断のテストを追加。復旧の状態不一致時の `SAVING` 再送とドキュメント網羅率はスキップ。TypeScript 365件・typecheck 通過。Phase 1 §15・App 配線表、Phase 2 client の Controller を同期。
- 残課題（44 回目から）：~~stop 後にメモリ待機が残ったまま、サーバー復帰で自動 drain する経路がない~~（45 回目で解消。ただし IDB にもサーバーにも送れない間はタブを閉じるまでロックを保持）。Phase 2 の System 側メモリ待機のロック保持は 46 回目で設計済み（Mic・System 両方のメモリ待機が空になるまで保持）、実装は未着手。
- 再開時の残り：後続フェーズ設計書の変更レビュー、専用Chromeによる停止理由保存の結合検証、READMEの確認手順更新。ブラウザ検証は利用者の中断で実行完了していない。通常APIは旧コードのまま停止したため、通常データへの列追加は次回起動時になる。テスト・サーバーの再開は利用者の指示を待つ。

- 2026-11-08（43 回目）：マイク切断試験の案内後に作られた最新会議 `bbd1a297-f448-42b6-8c08-c69839d01d1d`（無題の会議、10:11:21〜10:11:34 JST）を照合。13.25725秒・212,116サンプル・seq 0の1 Chunkが登録済み、サーバー状態は `finalized`。WAVのヘッダ・バイト数・SHA-256・サンプル数と、SQLite／`meeting.json`の確定値が一致。証跡は `private/next-action-2026-11-08/mic-disconnect-result.json`。サーバーに停止理由は記録されないため、T12-b は物理切断による自動停止・通知の利用者報告待ち。

- 2026-11-08（41 回目）：利用者の確認依頼を受け、最新の「無題の会議」`f4ea99b6-a1f7-4804-a9c2-126a4e2130f5`（09:58:56〜09:59:33 JST）を読み取り照合。実サーバーで `finalized`、seq 0・1 の2件が登録済み。30秒＋6.8080625秒＝36.8080625秒、計588,929サンプル。連番・offsetの連続性、WAVヘッダ（16 kHz / 16 bit / mono）、バイト数、SHA-256、SQLiteと `meeting.json` の確定フレーム数が一致。両WAVはゼロ振幅ではない（音の内容・聴取は未確認）。証跡は `private/next-action-2026-11-08/manual-recording-result.json`。
- 2026-11-08（42 回目）：利用者が「再試行ボタンは押さずに確定した」と報告。前回の実サーバー照合と合わせ、T10（停止後の自動確定）の実機確認を合格とした。ブラウザIDBの直接確認は今回の証跡に含めない。残りは T12-b の物理切断と T4-H の聴取。通常 API と Vite は引き続き起動中。

- 2026-11-08（40 回目）：通常の保存先 `private/phase1-data/` で API と Vite を起動し、Chrome でアプリを表示。更新したトークンをローカルのクリップボードにコピーした。実マイクの35秒録音・停止を利用者へ依頼し、結果待ち。今回の終了時点では実機確認用の両サーバーを起動したままにしている。
- T4-H の追加証跡：既存会議 `68c2f545…` の11 WAVを SQLite の SHA-256・サンプル数と照合。専用 Chrome 156.0.8078.80 のネイティブプレーヤーで各ファイルを最後まで再生し、全件 `ended: true`・メディアエラーなし。消音・16倍速のため聴取確認は代替しない。pageerror・HTTP(S) リクエストなし。`private/next-action-2026-11-08/existing-playback-result.json` と再生用 `existing-playback.html` に保存。H は利用者の聴取報告待ちとして維持。

- 2026-11-08（39 回目）：専用の実 FastAPI サーバーと Chrome 156.0.8078.80（使い捨てプロファイル・合成マイク）で T10/T12 を結合確認。A の末尾 PUT を保留して B を開始し、A の自動確定前後とも B の停止ボタンが有効なこと、B の停止・確定まで確認。実 HTTP 401 の表示、通常停止会議の復旧文言、トークン修正後の再送・自動確定、合成 ended による停止・末尾保存、中止のキャンセル／確定・再読み込み・WAV 保持も通過。
- 確定した 4 会議は各 1 Chunk、全件 `DB_REGISTERED`。IDB のフレーム総数と実 SQLite の確定値、WAV の 16 kHz / 16 bit / mono ヘッダ・サンプル数・SHA-256 が一致。pageerror・アプリの外部ホスト宛て要求は 0 件。検証記録・スクリプト・画像は `private/next-action-2026-11-08/`（Git 対象外）。検証 API の保存先は `/private/tmp/minutes-next-verification`。既存会議は変更していない。
- 残りは実マイクでの短時間録音・物理切断と T4-H の既存 Chunk の Chrome 再生。手順は README「次の実機確認」。60 分録音は保留継続。今回のコード修正はなし。

- 2026-11-08（ddf41e1〜6a240d0 でコミット済み）：T10/T12 差分のレビュー指摘を対応。トークン更新中の会議登録・確定の 401 の扱い、確定中止と PUT の競合（`prepareChunkPut()`）、直接送信完了後の確定再試行、マイク切断の録音ごとの判定と登録前終了の検出、復旧中に別タブが状態を進めた会議の除外、確定待ちの内訳（`SAVED`・直接送信・不完全表示）、次の録音の停止ボタンを修正。変更は `src/api/meeting-registrar.ts`・`src/app/app.ts`・`src/main.ts`・`src/recording/recording-controller.ts`・`src/recording/recovery.ts`・`src/ui/recording-view.ts`、対応テスト、設計書 Phase 1 / Phase 2 client。
- 残課題（2026-11-08 レビュー対応から）: `src/main.ts` の停止ボタンは Vitest 対象外。「録音 A を停止 → 確定待ちの間に録音 B を開始 → B の停止ボタンが押せる」は39回目の実サーバー＋合成マイクによる Chrome 検証で確認済み。停止後の Scheduler は会議ロックを持たないため、別タブの送信中 `SAVING` を復旧が重複再送しうる（冪等 PUT で吸収）。再読み込み後の直接送信件数は復元できず、不完全表示にとどまる。

- 2026-11-08：T10 を TDD で修正。T12-a〜d と共通通知・件数表示を TDD で実装済み。専用 Chrome プロファイルでの模擬 API・合成マイクによる画面検証も通過。実マイクと既存会議での確認は未実施。1-g は利用者指示で保留。着手時からあった本ファイルの T4-H などの訂正は保持した。

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

### T0. 2026-09-26 までの未コミット変更のコミット ✅ 完了（T10/T12 レビュー修正も 6a240d0 までコミット済み）

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

### T4. 手動確認（Step 1-c / 1-d / 1-e / 1-f / 1-g）【A〜G 合格（2026-10-07）・H は既存 Chunk の再生待ち・任意の C2 と 1-g が残り】

- 1-c 結果：会議 `68c2f545-ff0a-4741-8f43-3b2fd46711c2`（無題の会議）。seq 0〜9 は各480,000サンプル、seq 10 は257,842サンプル。計316.115125秒、欠番なし、`fullChunks: 10` / `partialChunks: 1` / `allValid: true`。全11件の音声を利用者が確認した。Chromeでの単体再生は未確認（再生アプリ・OS・Chrome版も未取得）。外部通信ゼロの実機確認も未完了。録り直しは求めず、Chromeの確認を残して1-dへ進むと案内済み。

- 起動は `npm run dev` → http://127.0.0.1:5173/ 。1-c（実マイク → IDB）はサーバーなしでも確認できる（DevTools の Application → IndexedDB `minutes-local`）。
- 利用者承認済みの順序：1-c の5分実録音を利用者が操作して結果報告 → Python / FastAPI / SQLite の最小サーバーを実装 → 1-d〜1-f を結合確認。1-g の60分実録音は次回。詳細な1-cの手順は [README.md](README.md)。
- 最小サーバーは §12 の5 APIを実装済み。保存先は `private/phase1-data/`、127.0.0.1:43117。Pythonテストでトークン更新、CORS、原子的保存、冪等性、破損・容量不足・不完全な確定を検証済み。実ブラウザのPUTは未確認。
- 会議作成APIの配線漏れは修正済み。通常送信・復旧・直接送信は共通の登録を通り、録音開始はサーバーを待たない。
- 結果は [design-local-phase1.md](design-local-phase1.md) §28 の「状況」列に反映する。

### 次セッションの再開点：T4 実機再確認チェックリスト（2026-10-01 作成・A〜G 合格、H は一部確認）

- **履歴（2026-11-08・42 回目時点の T10 結果。最新の状態ではない）**：T10 は合格。利用者が手動再試行なしの確定を報告し、会議 `f4ea99b6…` の36.8080625秒・2 Chunk・サーバー確定済みの照合結果と一致。T12-b の案内後の会議 `bbd1a297…` は保存・確定済みまで43回目に照合した。まず物理切断で自動停止し通知が出たかを利用者へ確認する。その後、既存11 WAVの聴取（T4-H）を確認する。H のChrome再生処理は全件通過、音が聞こえるかは未確認。**現在は通常 API・Vite とも停止中**（44 回目に利用者指示で停止）。テストとサーバーの再起動は利用者の指示があってから行う。

- **次セッションの再開点（2026-10-07 終了時）**：
  1. 両サーバーは停止済み。T4 の必須項目 A〜G は合格。H は既存 Chunk の Chrome 再生が未確認で、結果を確認するまで合格としない（書き出した WAV の再生と外部通信なしは確認済み）。
  2. **2026-11-08・39 回目更新**：T10/T12 は実装・自動テストに加え、実サーバー＋合成マイクの Chrome 結合確認済み。次は README「次の実機確認」に沿った実マイクでの短時間録音・物理切断と T4-H の既存 Chunk 再生確認。1-g（60 分実録音）は利用者指示で保留し、明示的な再開指示まで実施しない。
  3. 任意：C2（サーバー停止中に強制終了 → 再起動・トークン保存 → 開き直して再送）。
  4. ブラウザの IDB に会議 `6a108d86…`（G 書き出し）が確定待ちで残っている（Chunk は書き出した WAV にしかない）。再読み込み後の扱いは未確認。T12-d を参照。
  5. 書き出した WAV 2 件のコピーが `private/g-export/`（git 対象外）にある。不要なら削除してよい。
- **項目 F・G 合格、H は一部確認（2026-10-07）**：Chrome は利用者の**別プロファイル**で最初に開いてしまい、IDB が空だった（プロファイルごとに IDB が別）。前回と同じプロファイルで再開。
  - 前回の会議 `73f09961…` は、誤ったトークンで照合が 401 → 正しいトークンの保存（10:04:18）と同時に自動で `finalized`（14 Chunk・6,291,936 サンプル一致）。
  - F-1 画面ロック：会議 `da231ba0…`。Shift + Command + Q（ログアウト確認）→ すぐ Control + Command + Q でロック、約 20 秒後に解除。seq 0〜5 は欠番なく 0.07〜0.12 秒で登録、警告なし → **合格**（観測のみ）。
  - F-2 マイク切断：会議 `9a7c2188…`。「マイクが切断されました…」を表示。切断後は WAV がすべて 0 のまま停止まで続く（約 27 秒）。3 Chunk・`finalized` → **合格**。
  - G 書き出し：会議 `6a108d86…`。サーバー停止＋putChunk 失敗注入で、エラー通知・赤い警告・書き出しボタンが表示。書き出した 2 件（30.000 秒・20.218 秒、16 kHz/16 bit/mono、雑音 RMS 約 10）を確認 → **合格**。会議は確定待ちから抜けられない（T12-d）。
  - H：G で書き出した WAV を Chrome のタブで再生（0:20/0:20）。全試験で通信先は 127.0.0.1 のみ。合格条件の既存 Chunk の再生は未実施 → **保留**（書き出した WAV は既存 Chunk の代わりにしない）。
  - 記録は §28.1・§28.3・§28.4 に反映。
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

### T11. ダイアログ表示中に Chunk の保存・送信が止まる疑い【2026-10-07 再現せず・保留】

- T4-F で、何らかのダイアログ（⌘Q による「Chrome を終了しますか」や、ページの離脱確認の可能性）が出ている約 1 分間、seq 5・6 の登録が遅れた。ページのメインスレッドが止まるダイアログ（beforeunload の確認など）であれば、Worklet が作った Chunk の IDB 書き込みも待たされ、その間のクラッシュで「直近最大 30 秒」を超えて失われうる。
- 次回、利用者にダイアログの文言を確認するか、録音中に Command + Q を押して再現する。原因がページのダイアログなら、§20 に「確認ダイアログ中は保存が止まる」旨を書くか、警告の出し方を見直す。
- 2026-10-07：ダイアログは macOS のログアウト確認（Shift + Command + Q、56 秒のカウントダウン付き）と判明。今回はその表示中・画面ロック中とも遅れなし（0.07〜0.12 秒）。前回の 51 秒の遅れは再現せず原因不明のまま。ダイアログを出していた時間が前回より短かった可能性がある。

### T12. T4（2026-10-07）で見つかった観察【2026-11-08 実サーバー結合確認済み・実マイク確認待ち】

- a. **誤ったトークンが画面に出ない**：`/v1/health` は認証なしでも 200 を返し、`unauthorized` は PUT の 401 でしか立たない（`src/api/backend-health-monitor.ts`）。送る Chunk がないと、Finalizer の `list HTTP 401` だけが通知に出る。案：Finalizer・Registrar の 401 も Monitor に知らせる、または health の `capabilities` 欠落を「トークン不一致の疑い」として表示する。
- b. **マイク切断後も無音のまま録音が続く**：警告で停止を促す設計（§15）どおりだが、長い会議で見落とすと無音の Chunk がたまる。自動停止や無音の継続時間の表示を検討する。
- c. **「前回中断された会議」の文言**：通常停止で確定待ち（`stop_requested`）だった会議も、再読み込み時に「前回中断された会議が 1 件あります」と出る（起動時復旧が `stop_requested` も数える）。文言を「確定待ちの会議」と分けるか検討する。
- d. **Chunk を失った会議を確定待ちから外せない**：G のように IDB にもサーバーにも Chunk がない会議は、再試行しても `waiting_local_save` のまま。トークン保存時の自動再試行では通知も出なかった。利用者が「確定を諦める」操作（または書き出した WAV の取り込み）が Phase 1 にない。
- 付随：「サーバー未接続 —— 0 個の Chunk を…」の件数は IDB の Chunk だけを数え、メモリ待機の Chunk は赤い警告で別に示す。2 本の帯の数字が食い違って見える。

#### 共通方針と受入条件（2026-11-08）

次アクションの依頼により a → c → b → d の順に実装済み。各不具合の回帰テストで修正前の Red → 修正後の Green を確認した。過去の T4 合格項目の判定は変更しない。39 回目に実サーバー＋合成マイクで再確認済み。実マイク・既存会議での再確認は未実施。

- a：Registrar／Finalizer の 401/403 を Monitor に通知。送信 Chunk がない場合、直接送信、認証修正後の復帰を検証。
- c：復旧前の状態を保存し、中断と確定待ちの件数を分ける。別タブの状態変更はロック取得後に再確認。
- b：mic の ended で通常停止を一度だけ実行。手動停止との競合、mute では停止しないこと、メモリ未保存時の書き出し案内を検証。
- d：確認付き「確定を中止」でローカルの `abandoned` に永続化。データは削除せず、復旧・再送・確定から除外。確定 POST 中の中止拒否、キャンセル、書き出し失敗時の中止防止、再起動後の保持を検証。中止前から送信中の PUT は取り消さない。既存会議 `6a108d86…` は変更していない。
- 共通：会議ごとの失敗理由・保存先別件数、同じ失敗通知の重複抑止を実装。画面検証は `/tmp/minutes-t12-browser.cjs`、画像は `/tmp/minutes-t12-ui.png`（専用 origin 127.0.0.1:5188・使い捨てプロファイル・模擬 API・合成マイク、アプリの外部ホスト宛てリクエストなし／pageerror なし）。

- **共通**：「何が失敗したか」「音声がどこまで保存されているか」「次にできる操作」を同じ画面に示す。再試行で回復可能な状態と、操作が必要な状態を分け、成功通知で失敗を隠さない。自動再試行の失敗も会議ごとに表示し、同じ通知を連打しない。
- **a／認証**：Registrar・Finalizer の 401/403 も Monitor に伝える。health 200 や capabilities 欠落だけで認証の成否を推測しない。トークン修正への導線を表示し、正しいトークン保存後に送信・確定を再試行する。受入条件：送信 Chunk がゼロでも一覧／確定／会議登録の認証失敗を表示でき、修正後に回復する。トークン自体は通知・ログに出さない。
- **b／マイク切断**：トラックの ended（切断確定）で通常の停止処理を一度だけ呼び、取得済み音声を保存する。単なる無音・一時的 mute は自動停止の根拠にしない。切断で停止したことと、マイクを選び直して新しい録音を始める操作を示す。受入条件：手動停止との競合でも二重停止せず、切断後に無音 Chunk を作り続けない。保存不能なら書き出しを促す。
- **c／起動時文言**：復旧前の status に基づき、recording の中断と stop_requested／finalizing の確定待ちを分けて通知する。受入条件：通常停止の再読み込みでは「前回中断」と表示せず、混在時はそれぞれの件数と確定待ち一覧への導線を示す。別タブで録音中の会議は対象外。
- **d／回復不能**：「確定を中止して一覧から外す」を追加する方針。確定成功とは扱わず、専用の中止状態で永続化する。音声・メタデータ・サーバー側データは削除しない。操作時に対象会議と未保存音声の可能性を説明し、メモリ待機があれば先に WAV 書き出しを案内したうえで明示確認を取る。受入条件：会議ロック下で録音／確定処理との競合を防ぎ、再読み込み後も中止状態が残り、自動再試行対象から外れる。書き出し済み WAV の取り込みは今回の範囲外。既存の `6a108d86…` を現時点で変更しない。
- **件数表示**：IDB 内の未送信件数と、メモリ内の未保存件数を保存先名付きで区別し、0 件でも未保存音声がないと誤認させない。
- a → c → b → d の順で TDD 実装済み。d は永続状態・復旧・UI を合わせて検証した。1-g の保留解除はこれらの完了から自動判断せず、利用者の再開指示を待つ。

### T10. 録音停止のたびに「確定待ち」になる ✅ 完了（2026-11-08 実機確認合格）

- 実機結果：会議 `f4ea99b6…`、36.8080625秒・2 Chunk、サーバーで登録・確定済み。利用者が手動の「再試行」を押さずに確定したと報告。WAVのサンプル数・ハッシュ・連番・offsetの連続性は41回目に照合済み。

- T4-A・`c8512a13`・T4-B・T4-D の 4 回に加え、2026-10-07 の F-1・F-2・G でも（計 7 回）、停止直後は末尾 Chunk が PUT 中のため Barrier が `waiting_local_save` で止まり、手動の「再試行」が要った。§31.2 の「既知の制約」は実際には毎回起こる。
- 対応：Scheduler が成功状態を IDB に書き終えた後に App へ通知し、停止済みの会議をロック付きで自動再試行する。実行中の Barrier と通知が重なった場合は再判定を予約する。自動再試行は保存待ちからの復帰に限定し、照合不一致からの再送ループは回帰テストで防ぐ。録音中・別タブのロック保持中・メモリ未保存時は確定しない。停止後／Barrier 実行中の完了の 2 件で Red → Green を確認。復帰時の複数 Chunk と保護条件も回帰テストに追加。UI 文言も自動再試行に合わせた。60 分実録音は実施していない。
- 付随の観察：`MeetingRegistrar` は成功結果を覚えないため、PUT 2 件ごとに冪等な `POST /v1/meetings` が出る。実害はないが、要求数を減らすなら登録済み会議をメモする。

### T9. T4-A で見つかった UI/診断の改善 ✅ 完了（a・c 2026-10-01、b 2026-10-03）

- a. ✅ 完了（2026-10-01・32 回目）：`App.setToken` が空白を含まない印字可能 ASCII 以外を保存せずエラーにする。テスト3件（修正前に Red を確認）。§4.3・§31.2 に反映。
  - 元の課題：トークン保存時に形式を検証する（ISO-8859-1 外・空白混入を拒否して通知）。現状は `trim()` のみで、不正な値を保存すると全通信が送信前に例外になり「サーバー未接続」とだけ出る。
- b. ✅ 完了（2026-10-03・33 回目）：`BackendHealthMonitor.checkOnce` の例外で UNREACHABLE にしたとき、`<name>: <message>` を `console.warn` に残す。同じ理由は連続して出さず、到達できたらリセット。テスト2件（修正前に Red を確認）。§18 の本文に追記。`LocalSaver`・`MeetingRegistrar` は元から理由を `fail()` に残しているため対象外。`App` の `getMeeting` フォールバックの `catch {}` は代替値を返す設計なので据え置き。
  - 元の課題：`BackendHealthMonitor.checkOnce` などの `catch {}` で UNREACHABLE とした理由を `console.warn` に残す（原因特定に時間を要した）。
- c. ✅ 完了（2026-10-01・32 回目、文言修正を採用）：「確定待ち（サーバーへの保存が終わったら、確定待ちの会議の「再試行」を押してください）」に変更。Chunk 登録完了時の自動再試行は後日 T10（2026-11-08）で実装。
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
- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`、`test/resampler-aliasing.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

### 2026-11-08（49 回目・レビュー指摘 10 件）

- 9 件を修正、1 件スキップ（既存テストで同じ経路を検証済み）。新規テストは修正前の Red を確認（文言・テスト組み直しの 2 件を除く）。
- Phase 1 同期（DIFF 0）、Phase 2 client・Phase 3 server に波及。コミット未実施。

### 2026-11-08（48 回目・レビュー指摘 15 件）

- 15 件すべて有効と判定し修正（コード 9・テスト 1・文書 5）。修正前の Red を確認したテストを中心に追加。flush 後の最終保存だけ失敗する経路も追加で修正。
- Phase 1 同期（DIFF 0）、Phase 2 client・Phase 3 client に波及。重複は前回のヘルパーへ寄せ直した。コミット未実施。

### 2026-11-08（47 回目・SonarCloud 重複率）

- PR #12 の品質ゲート（新規コードの重複 3.3%）をテストのヘルパー抽出で解消。f836da1 までコミット済み。

### 2026-11-08（46 回目・レビュー指摘 10 件）

- 10 件すべて有効と判定し修正（コード 6・テスト 1・文書 3）。テスト 11 件追加（Red 確認 9 件＋既存 2 件強化）。
- Phase 1 同期（DIFF 0）、Phase 2 client・Phase 3 client/server に波及。コミット未実施。

### 2026-11-08（45 回目・CodeRabbit 指摘対応）

- 指摘 19 件を照合し、18 件を修正（コード 9・テスト 3・文書 6）、docstring 網羅率はスキップ。回帰テストは修正前の Red を確認。
- Phase 1 埋め込みコード同期（チェッカー DIFF 0）、Phase 1 本文、Phase 2 client の Controller、Phase 2/3 server の確定 API を更新。README に停止理由の3か所確認と、サーバー側 WAV の読取専用再生手順を追加。
- コミット未実施。API・Vite は停止のまま。

### 2026-11-08（43 回目・マイク切断試験の保存結果を照合）

- 最新会議 `bbd1a297…` は13.25725秒・1 Chunk、サーバー登録・確定済み。WAVの形式・サンプル数・サイズ・ハッシュとSQLite／`meeting.json`の確定値を読み取り照合し一致。
- サーバーの記録だけでは停止理由を判定できないため、物理切断による自動停止と通知表示の報告を待ち、T12-bはまだ合格にしない。
- 証跡を `private/next-action-2026-11-08/mic-disconnect-result.json` に保存。製品コード変更なし、コミット未実施。T10合格・H聴取待ち・60分録音保留を維持。

### 2026-11-08（42 回目・T10 実機確認合格）

- 利用者が「再試行」ボタンを押さずに確定したと報告。会議 `f4ea99b6…` の前回のサーバー・WAV照合と合わせ、T10の実機確認を合格に更新。
- 次は T12-b の物理切断と T4-H の既存音声の聴取。60分録音は保留を維持。
- 進捗・README・Phase 1設計書を更新。製品コード変更なし、コミット未実施。

### 2026-11-08（41 回目・利用者の録音結果を確認）

- 最新の「無題の会議」`f4ea99b6…` を確認。36.8080625秒、seq 0・1、サーバーで全件登録済み・`finalized`。
- WAVのヘッダ・サンプル数・SHA-256・ファイルサイズ・offset連続性、SQLiteと `meeting.json` の確定値を照合して一致。音声はゼロ振幅ではない。証跡を `private/next-action-2026-11-08/manual-recording-result.json` に保存。
- 手動再試行の有無とIDB状態はサーバーから断定できないため、T10自動確定の実機合格は操作報告待ち。T12物理切断・H聴取・60分録音の保留は維持。
- 製品コード変更なし。API・Viteは起動継続、文書差分は未コミット。

### 2026-11-08（40 回目・実機確認の開始と既存 WAV 再生）

- 通常の API と Vite を起動、Chrome にアプリを開き、トークンをクリップボードへコピー。利用者へ実マイクでの35秒録音・停止を依頼し、結果待ち。
- 既存会議 `68c2f545…` の11 WAVの連番・ヘッダ・サンプル数・SHA-256を読み取り検証。Chromeのネイティブプレーヤーで全件を最後までエラーなく再生（消音・16倍速）。外部HTTP(S)通信・pageerrorなし。
- 結果と聴取用ページを `private/next-action-2026-11-08/` に保存。T4-H は聴取待ち、T10実マイク・T12物理切断も結果待ち。60分録音は保留。
- 製品コード変更なし。前回の文書差分を保持。実機確認用サーバーは起動中、コミット未実施。

### 2026-11-08（39 回目・Next アクションの結合確認）

- 実サーバー＋専用 Chrome＋合成マイクで T10/T12 を確認。A の末尾 PUT 待ち中に B を録音し、停止ボタン・両会議の自動確定、401 復帰、復旧文言、合成切断停止、中止と WAV 保持が通過。
- 4 会議の IDB・SQLite・実 WAV を照合し、サンプル数・ハッシュ・確定状態が一致。pageerror・外部ホスト宛てアプリ通信なし。証跡は `private/next-action-2026-11-08/`。
- 初回検証の照合失敗は Playwright の非同期条件待ちが原因。明示的な状態ポーリングへ修正して再実行し通過。製品コードの変更なし。
- TypeScript 352 件・Python 7 件、typecheck・build 通過。実マイク／既存音声の確認手順を README に用意。60 分録音は保留、既存データは未変更。検証用 API と Vite は停止済み。今回の文書差分は未コミット。

### 2026-11-08（38 回目・T12 実装）

- T12-a/c/b/d を TDD で実装。認証失敗の伝達、復旧前の状態別通知、mic ended による一度だけの停止、確認付き確定中止（データ保持・再開除外）を追加。
- 確定待ち一覧に失敗理由・保存先別件数を表示。同じ失敗通知を抑止し、マイク停止時の UI 解放と WAV 書き出しを接続。
- TypeScript 23 ファイル／331 件・Python 7 件、typecheck・build・設計コード同期・diff check 通過。専用 Chrome で認証復帰・中止／再読み込み・合成マイク切断と末尾 1 Chunk 保存を確認、pageerror と外部ホストへのアプリ通信なし。
- 1-g は引き続き保留。T4-H と実マイク／実サーバーでの短時間再確認は残す。既存録音データには触れていない。コミット未実施。

### 2026-11-08（37 回目・T10 修正／T12 方針整理）

- T10：停止後の末尾保存完了と Barrier 実行中の完了で Red を確認し、成功通知と再判定の配線で Green。録音中・別タブロック・メモリ待機の保護、復帰時の複数 Chunk も検証。照合不一致の再送ループも Red → Green で防止。UI の文言テストも Red → Green。
- T12：4 件を共通の失敗通知・保存状況・復帰操作の方針にまとめ、各項目の受入条件と実装順を記録。実装は次回。
- 1-g は利用者指示で保留。60 分実録音・T10 の実機検証は未実施。T4-H の保留も維持。
- 検証：TypeScript 313 件・Python 7 件、typecheck・build・設計コード同期・差分チェック。コミットはしていない。

### 2026-11-06（36 回目・依存脆弱性の対応）

- Dependabot 9 件に加え、npm audit のみで出る tinypool（Critical 2）・source-map-js（High）を精査。実害のある経路はなかったが全件更新で解消。
- vite 7.3.7・vitest 5.1.0・source-map-js 1.2.2・certifi 2026.10.23 へ更新。vitest は 3.2.x では tinypool が残り、4.1.x は npm 10.9.8 の依存解決がクラッシュするため 5 系を採用。`vi.fn` の型が厳密になったので `test/page-lifecycle.test.ts` の宣言を `Mock<...>` に変更。
- certifi は 2026.10.18 に固定しない（emSign ルートを全削除した版。アドバイザリは 10.19 以降を推奨）。Windows で使う場合、launch-editor 系の修正が vite 7.3.7 に含まれることが前提。
- PR #11 のマージで Dependabot の 9 件はすべて `fixed`（open 0 を確認）。src・設計書は無変更。
- レビュー指摘 2 件を検証し修正：T4-H は再生対象が書き出した WAV で合格条件の既存 Chunk と異なるため保留に訂正（35 回目のログは当時の記録として残す）／古い `npm audit` の保留メモを削除。

### 2026-10-07（35 回目・T4 項目 F〜H 合格）

- 着手時の作業ツリーは clean。両サーバーを起動しトークンを渡したが、利用者が Chrome の別プロファイルで開いており IDB が空 → 元のプロファイルで再開。
- 前回の `73f09961…` を確定。F-1 画面ロック・F-2 マイク切断・G WAV 書き出し・H 再生／外部通信なしがすべて合格。結果を §28 と本ファイルに記録。src は無変更。
- 観察 4 件を T12 に起票。T10 は今日だけで 3 回再現。T11 のダイアログは macOS のログアウト確認と判明（遅れは再現せず）。
- 反省：Console 用コードのコピーでクリップボードのトークンが上書きされ、誤ったトークンを保存させた。トークンの保存は、ほかのコピーを挟まないよう手順の直前に案内する。両サーバー停止済み。

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
