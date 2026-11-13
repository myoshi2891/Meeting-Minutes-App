# 進捗と次の作業

最終更新: 2026-11-13（設計書の厳しめレビュー 2 回目・未コミット、ブランチ `dev`。PR #13 までマージ済み）

新しいセッションはこのファイルから始める。作業を終えたら「現在地」「次の作業」「セッションログ」を更新する（ルールは [CLAUDE.md](CLAUDE.md)）。

---

## 現在地

Phase 1（ブラウザ録音 → IndexedDB → ローカル常駐サーバーへ PUT → finalize）のクライアント側を、[docs/design-local-phase1.md](docs/design-local-phase1.md) §30 の Step 順に実装している（基本設計書・詳細設計書 `design-local-phase*.md` は 2026-11-12 にリポジトリ直下から `docs/` 配下へ移行済み）。

| Step | 内容（設計書の節） | 状態 | 完了判定 |
| --- | --- | --- | --- |
| 1-a | §16 WAV エンコーダ | ✅ 自動テスト済 | `chunk-standalone.test.ts` 通過 |
| 1-b | §14 Worklet（リサンプラ・VAD・蓄積） | ✅ 自動テスト済 | `long-recording.test.ts` / `resampler-aliasing.test.ts` 通過 |
| 1-c | §10 IndexedDB + §15 RecordingController | ✅ 保存・全WAV音声確認済み（次Stepへ進む） | 30秒×10件＋16.115125秒×1件、全件valid。利用者が全11件の音声を確認。Chrome単体再生は未確認として残す |
| 1-d | §17 LocalSaver / Scheduler + §18 BackendHealthMonitor | ✅ 実ブラウザで確認（T4-A 合格 2026-10-01、T4-B サーバー停止5分 合格 2026-10-03） | — |
| 1-e | §22 Finalizer + §23 Recovery | 🟡 強制終了 → 復旧 → `finalized` を実機確認（T4-C、2026-10-03） | **未**：終了時に未送信 Chunk がある状態からの再送（任意の C2） |
| 1-f | §19 ヘルス / §20 ページライフサイクル / §21 クォータ + §31 配線 + UI | 🟡 T4-D〜G 合格（2026-10-03・10-07）、H は一部確認 | **未**：H の既存 Chunk の聴取確認（既存11件の Chrome 再生は 2026-11-08 に全件最後までメディアエラーなく確認済み。書き出した WAV の再生と外部通信なしも確認済み）。観察 4 件を T12 に起票（不合格扱いにはしない） |
| 1-g | 60 分実録音 | ⏸ 保留（2026-11-08 利用者指示・再開指示待ち） | 120 Chunk・欠番なし・全件 `DB_REGISTERED`・外部通信なし |

- 自動テスト（最新・62 回目の変更後）: TypeScript 24 ファイル / 479 件がすべて通過、`npm run typecheck` も通過（2026-11-10。Python は今回変更なし・未実行）。61 回目の変更後（回帰 3 件・新規 1 件を追加）は TypeScript 24 ファイル / 478 件・typecheck 通過（2026-11-10 にコミット 3a79126 の状態で実行して確認）。60 回目の変更後は TypeScript 24 ファイル / 474 件・typecheck 通過。59 回目の変更後は TypeScript 24 ファイル / 471 件・typecheck 通過。58 回目の変更後は TypeScript 24 ファイル / 466 件・typecheck 通過。57 回目の変更後は TypeScript 24 ファイル / 456 件・typecheck 通過。56 回目の変更後は TypeScript 23 ファイル / 446 件・Python 10 件・typecheck 通過。55 回目の変更後は TypeScript 444 件・typecheck 通過。53 回目の変更後は TypeScript 433 件・Python 10 件がすべて通過、`npm run typecheck` も通過（2026-11-09、build は未実行。Python は `PYTHONPATH=. uv run pytest server_tests`）。52 回目の変更後は TypeScript 427 件・typecheck 通過。51 回目の変更後は TypeScript 415 件・typecheck 通過。50 回目の変更後は TypeScript 410 件・typecheck 通過。49 回目の変更後は Python 10 件、TypeScript 403 件・typecheck 通過。48 回目の変更後は TypeScript 397 件・Python 10 件・typecheck 通過。45 回目の変更後は TypeScript 372 件・Python 10 件、typecheck・`npm run build` 通過。44 回目の変更後の記録は TypeScript 365 件・Python 10 件・typecheck 通過。それより前（停止理由の永続化以前）の記録は Python 7 件・TypeScript 352 件。`npm audit` は前回確認で 0 件（2026-11-06、vite 7.3.7・vitest 5.1.0・certifi 2026.10.23）。
- 設計書と src の同期: 変更した Phase 1 の埋め込みコードは `scripts/sync-design-code.mjs` で同期。後続 Phase 2 client の会議情報保持とバナー文言も反映。
- Phase 2 / 3 は設計書のみ（クライアント・サーバーとも未実装）。設計書のコードは `scripts/verify-design-docs.sh` で検証済み（2026-11-13 の設計書レビュー 2 回目の後：Phase 2 server 128 件・Phase 3 server 164 件・Phase 2 client 31 ファイル 557 件・Phase 3 client 35 ファイル 592 件、tsc・pyflakes も通過）。

### 今回の変更と残課題

- 2026-11-13（設計書の厳しめレビュー 2 回目・未コミット）：`docs/` の Phase 2 / 3 設計書を、展開したコードの**カバレッジ**（テストが一度も実行していない行）を起点にレビューした。前回までのレビューは「テストが通るか」で見ていたので、Fake Provider が通らない経路（実モデル・CLI・SSE・未テストのエンドポイント）が手つかずだった。見つけた欠陥は実験かテストの Red で確かめてから直した。製品コード（`src/`・`test/`・`minutes_local/`）は無変更。Phase 1 設計書も無変更（src と一致のまま）。
  - **Phase 2 server（SSE）**：`wait_for(gen.__anext__())` のタイムアウトで非同期ジェネレータごと終わり、**最初の keepalive（15 秒の無通信）の次の周回で接続が必ず落ちた**（実験で `RuntimeError: async generator raised StopAsyncIteration` を確認）。`EventBroker.attach()` / `detach()` を足し、SSE はキューを直接待つ。回帰 1 件。
  - **Phase 2 / 3 server（実行デバイス）**：Apple Silicon は区分が `gpu_*` になり `float16` → `device="cuda"` を選んでいた（基本設計 §7.2 は「Apple Silicon は int8」。**開発機の Mac では STT が必ず失敗する**）。`SttCandidate.device` / `STTRequest.device` を足し、CUDA 以外は CPU の int8 にする（`tiers.for_backend`）。`compute_type` から device を推測する箇所をなくした（`gpu_small` の int8 が CPU で走っていた点も直る）。Phase 3 の `FasterWhisperLanguageDetector` も同じ。
  - **Phase 2 / 3 server（モデルの選び直し）**：`ModelSelection` が起動時のままで、後から起動した Ollama・後から配置／取得したモデル・`PUT /settings` の変更が再起動まで反映されなかった。新規 `jobs/selection.py`（`select_models` を bootstrap から移動、`refresh_stt` / `refresh_llm`）。`list_models()` を `SummaryProvider` の Protocol に入れ、「届かない（None）」と「届くがモデルなし（[]）」を区別（後者は `MODEL_MISSING`）。Ollama の 404 は `ModelMissingError`。
  - **Phase 2 server（プロセスプール）**：タイムアウトしたワーカーが止まらずプールを塞ぎ、ワーカーが落ちると `BrokenProcessPool` のまま以後の STT が全滅した（基本設計 §5.1 の「プールの再生成」が未設計）。`PoolExecutor` がプールを作り直す。巻き込まれたジョブは `INTERNAL`、原因のジョブは `OOM`。実プロセスのテスト 2 件。
  - **Phase 2 / 3 server（ダウングレード）**：同じモデルで 2 件が OOM すると 2 段落ちた／未配置の段へ落とすと `MODEL_MISSING` で止まった／落としても前のモデルをワーカーが握ったままだった／`"cuda"` を含むだけで OOM 扱いにしていた。それぞれ修正（`is_oom_message`）。
  - **Phase 2 server（モデル取得）**：`large-v3` のファイル名が違う（`vocabulary.json`・`preprocessor_config.json`。2026-11-13 に配布元の一覧で確認）、リダイレクト先 `us.aws.cdn.hf.co` が allowlist 外で**全モデルの取得が失敗**、しかも失敗がバックグラウンドのタスクの例外として消えていた。リダイレクトは要求の前に検査、`model.bin` を最後に取得、結果は新規 `ModelDownloads` → `GET /v1/models` の `downloads`。
  - **Phase 2 / 3 server（操作系エンドポイント、すべて未テストだった）**：録音中の `transcript/rerun` が会議を `transcribing` に進め**以後の Chunk の PUT が 409**になった／無音 Chunk の手動 STT を `skipped` 以外に呼ぶと Chunk が `queued` で固まり、成功しても transcript に入らなかった／`PUT /settings` が無検証で、モデル指定を外す手段がなかった／存在しない会議の `exclude-failed` が 500。前提条件を §21.3 の表にし、回帰 7 件（すべて修正前に Red）。
  - **Phase 2 client**：`Phase2Client` が成功応答を `json as T` で通していた（CLAUDE.md「サーバー応答は型ガードを通す」に反する。Phase 3 はデコーダ方式で対処済みだった）。デコーダ 11 個を `contracts-phase2.ts` に足し、`meetingId` の一致まで見る。フィクスチャはサーバー設計書を展開して取得した実応答。新規 `test/phase2-client.test.ts` 5 件（3 件は修正前に Red）。
  - 確認：`verify-design-docs.sh all` 通過（Phase 2 server 128・Phase 3 server 164・Phase 2 client 557・Phase 3 client 592、pyflakes 指摘なし）。Phase 1 埋め込み同期 DIFF 0。`test_stt_runtime.py` の 17 件は新しい API を import するため、修正前の Red は収集エラーとして確認（1 件ずつの Red ではない）。
  - **残り（未対応・要判断）**：Phase 2 server §26 に R1〜R6 として記載（取得中の health `degraded`、`vad_sampling_ratio` を読むコードがない、LLM の OOM 時の縮退、SSE の job が snake_case、`If-Match` なしの上書き、要約実行中の STT の排他）。**Phase 3 固有の部分（pyannote・FLAC・LAN / TLS・scheduler・rebuild）は今回読んでいない**（カバレッジは `pyannote_provider.py` 0%・`codec.py` 52%・`scheduler.py` 59%・`__main__.py` 28%）。`__main__.py`（`serve` / `doctor`）は両フェーズともテストなし。Phase 2 / 3 の画面層は未決事項 D1・D2（Phase 2 client §15.2）の判断待ちのまま。Apple Silicon の実機で `doctor` と実モデルの STT を確かめる（Step 2-b）。

- 2026-11-12（PR #14 の 7 回目の指摘・未コミット）：CodeRabbit 6 件（nitpick 1 件を含む）を検証し、すべて有効として対応した（スキップなし）。新規テストは修正前の設計書で Red を確認（Phase 2 / 3 の両方）。製品コード（`src/`・`test/`）は無変更。
  - **Phase 2 client §11 `jobs_loaded`**：アクションに `meetingId`（`JobListResponse.meetingId` を渡す）を足し、表示中の会議と違えば捨てる（`transcript_loaded` と同じ）。会議の切り替え前の一覧取得の後着が新しい会議の jobs に混ざっていた。会議切り替えのテストに 2 段の確認を追加。Phase 3 client は `state.ts` を載せ直していないので対象外。
  - **Phase 2 / 3 client `backfill()`**：`failed` を `onError` より先に立て、`onError` の例外は `console.error` に記録して続ける。`onError` が投げると保留の解放と取り直しの予約が飛んでいた。回帰 1 件。
  - **Phase 2 / 3 client `FetchEventSource.run()`/`pump()`**：listener の例外で抜けたとき、`pump` がストリームを `reader.cancel()` し、`run` の catch で `controller.abort()` する（`this.controller = null` の前）。接続が開いたまま残っていた。回帰 1 件。
  - **Phase 2 server 修復（PUT 再送）**：照合を `pipeline.chunk_file_intact()`（`to_thread`）に替え、読めないファイルで 500 にせず書き戻す。未使用になった `sha256_file` の import を削除。Phase 3 は `_stored_chunk_intact` が `OSError` を受けていなかったので同じく欠損扱いにした。回帰 1 件（root では skip）。
  - **Phase 2 / 3 server finalize**：書き込みトランザクションで読み直した会議が `None`（照合中に削除）なら 404。従来は「finalized」の成功応答を返していた。回帰 1 件。
  - **nitpick `scripts/extract-design-code.py`**：argparse 化。不明なオプション・`--help` はファイルを開く前に終了コード 2 で止まる（従来は `--` で始まる未知の引数を黙って無視）。
  - 追加の指摘 2 件（同日・有効）：**Phase 2 / 3 client `FetchEventSource`** の再接続で出す error を `emitError()` で listener ごとに例外を受けて配る（`run()` の try の外なので、投げると `waitBeforeRetry()` に進まず再接続が止まり、残りの listener も呼ばれなかった）。回帰 1 件。**Phase 2 server** の修復テストの skip 条件を `not hasattr(os, "geteuid") or os.geteuid() == 0` にした（Windows で収集時に AttributeError。chmod(0) で読めなくもできない）。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過。`verify-design-docs.sh all`：Phase 2 server 102 件・Phase 3 server 138 件・Phase 2 client 552 件・Phase 3 client 587 件、pyflakes 指摘なし。

- 2026-11-12（PR #14 の 6 回目の指摘・244090c でコミット済み）：CodeRabbit 4 件を検証し、3 件を修正、1 件をスキップした。新規テストは修正前に Red を確認。製品コード（`src/`・`test/`）は無変更。
  - **スキップ：Phase 2 client `NotesStore.save()`**（送信の完了後に dirty なら schedule）：送信中の編集は `setDraft` がタイマーを予約し、`doSave` も `stillSame` が false なら `schedule()` を呼ぶので、dirty のまま予約なしで残る経路がない。
  - **Phase 2 / 3 server（`chunk_file_intact`）**：照合中のファイルシステムのエラー（権限・照合中の削除など）を `OSError` で受けて False（欠損）にする。存在確認も `is_file()` に変更。起動時の回収がサーバーの起動ごと止まらず、finalize も 500 ではなく 409 になる。回帰 1 件。
  - **Phase 2 / 3 server（`X-Chunk-Meta`）**：`vadScore` / `hasVoice` を必須にし、欠落を既定値（0 / True）で補わない（`hasVoice` を True で補うと無音の Chunk まで文字起こしに回る）。§21 の照合表も「どちらも必須」に更新。テストの `_meta` 2 か所に両フィールドを追加し、欠落の 2 ケースを追加（回帰 2 件）。
  - **Phase 2 / 3 server（finalize）**：`chunk_file_intact`（sha256 でファイル全体を読む）を `asyncio.to_thread` で実行し、イベントループを塞がない。書き込みトランザクションの前のまま。非ブロックを確かめるテストはなし（既存の finalize のテストで挙動が同じことを確認）。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過。`verify-design-docs.sh all`：Phase 2 server 100 件・Phase 3 server 136 件・Phase 2 client 549 件・Phase 3 client 584 件、pyflakes 指摘なし。
  - 残り：リポジトリの Phase 1 サーバー（`minutes_local/phase1.py`）は `vadScore` / `hasVoice` を既定値で補ったまま（Phase 2 で置き換える対象。§25 Step 2-a）。

- 2026-11-12（PR #14 の 5 回目の指摘・未コミット）：CodeRabbit 5 件（nitpick 1 件を含む）を検証し、すべて有効として対応した（スキップなし）。新規テストは修正前に Red を確認（nitpick のテスト強化は現行の挙動の確認）。製品コード（`src/`・`test/`）は無変更。
  - **Phase 2 client §15.1 W2**：テストの期待値を §4 の 1 に合わせた。ロックが `heldLocks` に入るのは、Mic か System のメモリ待機が残るときと Mic の最終保存に失敗したときだけ。Mic が保存しきり両方空なら Mic の `stop()` が解放済みで、System の失敗で reject しても `heldLocks` には入らない。
  - **Phase 2 client §10 NotesStore**：`doSave` は保存後の控え（新しい revision）の書き込みを `await` してから返す。`dispose()` はその完了まで待つ（`void` で投げていたので、作り直したインスタンスの `load()` が古い revision の控えを読んで conflict になった）。書き込みの失敗は新規の任意 dep `onError` に渡す（サーバーには保存済みなので状態は saved のまま。未処理の reject にしない）。回帰 2 件。
  - **Phase 2 / 3 client（`request`）**：成功応答の本文を `res.json().catch(() => null)` で読んでいた。読み取り中の中断・通信断は外の catch で TIMEOUT / NETWORK に、壊れた JSON（`SyntaxError`）は成功応答なら `MALFORMED`、エラー応答なら従来どおり status で返す。204 は本文なし。回帰 3 件（Phase 2 の 2 件は Phase 3 でも走る）。
  - **Phase 2 / 3 server（`resume_finalized`）**：始める前に finalize と同じ規則（source ごとの連番の連続、新規 `pipeline.chunk_file_intact()`）でファイルを照合し、欠損・破損があれば `finalized` のまま残す（直れば次の起動で拾う。件数は `resume_finalized_skipped` の metric）。`chunk_file_intact` は Phase 3 の pipeline（全文差し替え）で圧縮済みを存在だけで見る形にし、両 Phase の finalize もこれを使う。sha256 は書き込みロックの外で計算。引数に `data_dir` を追加（呼び出し元は両 Phase の `__main__`）。既存テストに破損と修復の場合を追加。
  - **Phase 3 client（nitpick）**：STORAGE の再同期テストで、積んだ 1 件がサーバーに 1 回だけ届くこと（`putCount`・`arrivalOrder`）まで確かめる。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過・Phase 1 埋め込み同期一致。`verify-design-docs.sh all`：Phase 2 server 97 件・Phase 3 server 133 件・Phase 2 client 549 件・Phase 3 client 584 件、pyflakes 指摘なし。
  - 残り：Phase 1 の `src/api/local-saver.ts`・`meeting-registrar.ts`・`backend-health-monitor.ts` も成功応答の本文を `json().catch(() => null)` で読む（読み取り中のタイムアウトが壊れた応答と区別されない）。今回の指摘範囲外。要否を判断する。`NotesStore.setDraft` / `acceptServer` の控えの書き込みも `void` のまま（失敗が未処理の reject になりうる）。

- 2026-11-12（PR #14 の 4 回目の指摘・未コミット）：CodeRabbit 8 件を検証し、すべて有効として修正した（スキップなし）。新規・変更テストは修正前に Red を確認（ルートの ACL 失敗時に配下へ触らないテストと Windows の st_mode のガードは、旧コードでも通る／mac では実行されない保存確認）。製品コード（`src/`・`test/`）は無変更。
  - **Phase 2 / 3 client（SSE の保留）**：補完の途中で再接続したら、前の接続の保留を捨てずに新しい補完を始める前に流す（「前の保留 → 新しい補完 → 新しい保留」の時間順）。捨てると補完に含まれない `progress` と、新しい補完も失敗したときの status を失った。既存テスト 1 件の期待値を更新、回帰 1 件。Phase 2 サーバーは `progress` を送らない（Phase 3 は Live の 1 種だけ）ので、切断中に落ちた `progress` を補完する経路はない。
  - **Phase 2 / 3 client（バックオフ）**：`FetchEventSource` は 200 を受けただけではバックオフを戻さない。`SSE_STABLE_MS`（30 秒、keep-alive 2 回分）切れずに続き、その間にデータを 1 回以上受け取った接続の後で戻す（判定タイマーは finally で止める）。回帰 1 件。
  - **Phase 2 client（reducer）**：`meeting_loaded` で別の会議を開いたら会議ごとの状態（transcript・summary・jobs・progress・stale の印）を捨て、表示設定（backend・showRejected・confidenceDimBelow）は残す。transcript / summary の応答は表示中の会議と違えば捨て、版の比較は同じ会議の中だけで行う。**前回入れた版の比較の退行**（会議 A の v3 を表示中に B を開くと B の v1 を捨てた）を直したもの。回帰 1 件。
  - **Phase 2 / 3 server（icacls）**：ルートを先に `/inheritance:r /grant:r *SID:(OI)(CI)F` で締め、既存の配下を名前順に 1 件ずつ `/reset`（ディレクトリは `/T`）。ルートには `/reset` も再帰もかけない（前回の「`/reset /T` を先に」は、再起動のたびに締めたルートを親の継承へ戻し、2 回目が失敗すると緩いまま残った）。**前回分を一部戻した**：ルート自身に付いた他の主体への明示 ACE は消えない（付けられるのは所有者か管理者だけで、ACL では防げない。docstring に記載）。テストを順序検証に変更、ルート失敗時に配下へ触らないテストを追加。
  - **Phase 2 / 3 server（トークン）**：新規 `acquire_data_dir_lock()`（`data_dir/serve.lock` を flock / msvcrt で排他）。`serve` は migrate より前に取り、取れなければトークンを作り直さずに終了（別ポートの 2 つ目の `serve` が動いているサーバーのトークンを壊さない）。回帰 1 件。
  - **Phase 2 / 3 server（移行した会議）**：新規 `sweeper.resume_finalized()`。`serve` の起動時に `finalized` のまま止まった会議（Phase 1 で確定した会議、Phase 3 の `doctor --rebuild` が復元した会議）へ `on_finalized` を呼ぶ（`transcribing` に進むので 2 回目は拾わない。`insert_job` は冪等）。Phase 3 では diarize が既定の False になる。回帰 1 件。
  - **Phase 2 server（テスト）**：トークンの st_mode の assert を Windows 以外に限定、Unix 用の restrict のテストは Windows で skip。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過・Phase 1 埋め込み同期一致。`verify-design-docs.sh all`：Phase 2 server 97 件・Phase 3 server 133 件・Phase 2 client 545 件・Phase 3 client 579 件、pyflakes 指摘なし。設計書冒頭の件数も実測値に更新。
  - 残り：icacls・msvcrt のロックは Windows 実機で未確認。SonarCloud の S8707 3 件は前回の判断待ちのまま。

- 2026-11-12（PR #14 の 3 回目の指摘・未コミット）：CodeRabbit 5 件を検証し、すべて有効として修正した（スキップなし）。新規・変更テスト 3 件はすべて修正前に Red を確認。製品コード（`src/`・`test/`）は無変更。
  - **Phase 2 client §15.3**：Step 2-d2 の W8 が `NotesStore` を生成するのに、§10 NotesStore は後の 2-g1 にあった。§10 と `notes-store.test.ts` を 2-d2 へ移し、2-g1 はノートの編集 UI（D2 の決定後）だけにした（§15.2「W1〜W8 は D2 を待たずに進められる」と一致）。
  - **Phase 2 client §11**：`transcript_loaded` / `summary_loaded` は、表示中より古い版の応答なら捨てる（後着した v2 が v3 を巻き戻し、stale の印は消えているので取り直されなかった）。同じ版は受け入れる。回帰 1 件。Phase 3 は `state.ts` 変更なしなので同期先なし。
  - **Phase 2 / 3 server**：`restrict_to_current_user()` の Windows 分岐は、先に `icacls <dir> /reset /T /Q` でツリー全体の明示 ACE を消して継承に戻し、その後で `/inheritance:r /grant:r *SID:(OI)(CI)F`（`/inheritance:r` だけでは他の主体への明示 ACE がルート・既存の配下に残った）。既存テストを 2 回の呼び出しの順序検証に変更。
  - **Phase 3 client**：`MeetingEventsClient.receive()` は補完中でも `live_segment` を保留せず即座に `onLiveSegment` へ渡す（ペイロードで判定。status などは従来どおり保留）。補完中の再接続で保留ごと捨てられ、次の poll まで出なかった。回帰 1 件。
  - **scripts**：`verify-design-docs.sh` は `VERIFY_DIR` 未指定時の一時ディレクトリを EXIT の trap で消す（INT / TERM も EXIT を通す）。`VERIFY_DIR` 指定時は残す。成功・失敗の両方で消えることを確認。
  - **SonarCloud（Quality Gate: Security Rating C）**：PR の脆弱性 5 件のうち `npx` の 2 件は既に CLOSED。残りは `scripts/extract-design-code.py` の S8707（コマンドライン引数による Path Traversal、27・44・45 行）の 3 件で、コードは変えていない。taint の経路を見ると、`commonpath` のガードは比較の基準 `out` 自体が `sys.argv` 由来なので、設計書の見出しのパスしか拘束しない（Sonar の判定は taint モデル上は正しい）。`open(doc)` は無検査。実害は、引数を操作されたエージェントが `<out>/{src,test,tests,minutes_local}/…`・`<out>/pyproject.toml` を書く、任意ファイルから見出し付きブロックを読む、の範囲。shell:S7679（`verify-design-docs.sh` の `init_packages` の `$1`）は `pkg_root` に代入して修正済み。**要判断**：SonarCloud で 3 件を Safe / Accept にする（推奨）か、信頼できる基準（`__file__` から求めたリポジトリの `docs/`、一時ディレクトリ）の内側に引数を限定する（`VERIFY_DIR` の置き場所が制限される。Sonar が認識するかは再解析まで不明）。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過。`verify-design-docs.sh all`：Phase 2 server 94 件・Phase 3 server 130 件・Phase 2 client 542 件・Phase 3 client 576 件、pyflakes 指摘なし。
  - 残り：`/reset /T` と `/inheritance:r` の間は親の ACL を一時的に継承する（docstring に記載）。icacls の実挙動は Windows 実機で未確認（前回の残りと合わせて確認する）。

- 2026-11-12（PR #14 の追加指摘・未コミット）：CodeRabbit 10 件を検証し、すべて有効として修正した（スキップなし）。新規テストはすべて修正前に Red を確認（JSON 破損の 1 件のみ、現行の挙動を固定する保存確認で修正前から Green）。
  - **Phase 1 src**：`finalizer.ts` の `GET /chunks` の本文読み取りで `null`（壊れた応答）にするのは `SyntaxError` だけにし、abort 以外の通信エラー（`TypeError` など）も `network` として返す（回帰 1 件・保存確認 1 件）。Phase 1・Phase 2 client の設計書に同じ差分を反映。
  - **Phase 2 / 3 client**：`MeetingEventsClient` の補完が失敗したら、同じ接続のまま 1・5・15 秒後に最大 3 回取り直す（新規 export `BACKFILL_RETRY_DELAYS_MS`。再接続・close で取り消し、取り直しも保留からやり直す）。`fetchJobs` / `fetchMeeting` のコメントに「期限までに必ず settle する」契約を明記（`Phase2Client` の `timeoutMs` が本文読み取りまで覆う）。`NotesStore.dispose()` を `Promise<void>` にし、送信中の PUT の完了を待つ（待たずに作り直すと、新しいインスタンスが確定前の revision を読み、保存中の編集が 409 の競合になった）。配線表 W8 に「`dispose()` の完了を待ってから `load()`」を追記。回帰 3 件。
  - **Phase 2 / 3 server**：finalize は件数・連番が合っていても、欠損・破損した登録済み Chunk が 1 件でもあれば 409（期待より多く登録され、余りが壊れたまま確定した）。§21 の照合表も更新。データディレクトリの権限は新規 `restrict_to_current_user()`：Unix は 0700、Windows は `icacls` で継承を外し、`whoami /user` で得た現在のユーザー SID にだけ付与（昇格の有無で付与先が変わらない。SID が取れなければ起動を止める）。回帰 4 件（Windows 分岐は `sys.platform` と `subprocess.run` を差し替えて確認）。
  - **Phase 3 server**：rebuild は `meeting.json` の `endedAtEpochMs` が 0 以上・SQLite INTEGER 内の整数でなければ `None` にして復元を続ける（`_stop_metadata` と同じ判定を `_is_sqlite_epoch_ms` に切り出し）。再 PUT の修復判定は圧縮済み Chunk も `read_pcm` で復号して WAV の sha256 と照合し、壊れていれば WAV に書き戻して `registered` にする。`FlacCodec.decode` は libsndfile の例外（RuntimeError 系）を `ValueError` に包み、`AudioCodec.decode` の約束（壊れた入力は ValueError）にそろえた（STT 側の `read_pcm` もクラッシュせず `InvalidWavError` になる。FLAC の分岐は soundfile 未導入の検証環境では未実行）。回帰 7 件。
  - **scripts**：`verify-design-docs.sh` は `server` / `client` / `all` 以外の対象を exit 2 で拒否（何も検査せずに OK と出していた）。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 498 件通過・Phase 1 埋め込み同期一致。`verify-design-docs.sh all`：Phase 2 server 94 件・Phase 3 server 130 件・Phase 2 client 541 件・Phase 3 client 574 件、pyflakes 指摘なし。設計書冒頭の検証件数も実測値に更新。
  - finalize の新しい 409 は、期待件数より多く登録され余りが壊れた場合だけに効く。Phase 1 の Finalizer は期待件数を「IDB とサーバー登録済みの連番の最大 + 1」で作るので余りも数に入り、壊れた余りは従来から件数不一致の 409 になる（既存クライアントに新しい再送ループは生じない）。
  - 残り：`restrict_to_current_user()` の Windows 分岐は実機（昇格・非昇格の両方で起動）で未確認。Phase 3 の finalize は圧縮済み Chunk を存在だけで数える（修復判定と違い復号しない）。確定 API の `endedAtEpochMs` に上限がなく、2**63 以上で 500 になりうる（今回の指摘範囲外。要否を判断）。

- 2026-11-12（PR #14 のレビュー指摘・SonarCloud・未コミット）：CodeRabbit 18 件と SonarCloud の Security 指摘 5 件を検証し、すべて有効として修正した（スキップなし）。
  - **Phase 1 src**：`finalizer.ts` の `GET /chunks` で、本文の読み取り中のタイムアウト（abort）を壊れた応答（`malformed`）ではなく `network` として返す（回帰テスト 1 件、修正前に Red を確認）。Phase 1・Phase 2 client の設計書にも同じ差分を反映。
  - **Phase 2 / 3 server**：finalize の `meeting_status` 通知を `meeting.json` の書き出し（507 になりうる）より先に行う。作成・再送の `meeting.json` を DB の会議行から書く（Phase 2 は `_meeting_json`、Phase 3 は `write_meeting_json`）。`serve` は待ち受けポートを確保（新規 `bind_listen_socket`）してからトークンを作り直す。確定・Live STT と Live 結果の再利用は lease を先に検査する（segments が空でも旧ワーカーが完了にしない）。`fchmod` がない環境（Windows の Python 3.12 以前）では `chmod`。Phase 3 の移行 012 は旧ディレクトリを `.migrate-012/` へ退避してから統合し、作業場所は 012 の記録のコミット後に片付ける（会議 ID `local` で他の会議の録音ごと消えた）。
  - **Phase 2 / 3 client**：SSE は初回接続でも補完し、補完中の live イベントは保留して補完の後に流す（世代番号で古い接続の補完を捨てる）。`FetchEventSource` に接続期限 10 秒と無通信 45 秒の監視（新規 export `SSE_CONNECT_TIMEOUT_MS` / `SSE_IDLE_TIMEOUT_MS`）。補完中の保留は接続ごとにやり直す（前の接続の古い status を流さない）。stale の版の印は大きい方を残す。`NotesStore.dispose()` を追加（送信中の保存が終わっても送り直しを予約しない）。配線表 W2（ロックは Mic の `RecordingController`、`finally` で受け取る）・W7・W8・W11 と 2-h1 を更新。
  - **scripts**：抽出の閉じフェンスを CommonMark どおり（同じ文字・開き以上の長さ）に、出力先の外へのパスを拒否（Sonar S8707）。verify は `VERIFY_DIR` を絶対パス化、抽出を関数化、pyflakes の指摘と失敗を NG に、`npx` をやめて `node_modules/.bin` を直接使う（Sonar S6505）。
  - 確認：`npm run typecheck` 通過・TypeScript 24 ファイル / 496 件通過。`verify-design-docs.sh all`：Phase 2 server 90 件・Phase 3 server 119 件・Phase 2 client 30 ファイル 536 件・Phase 3 client 34 ファイル 569 件、pyflakes 指摘なし。新規テストは `bind_listen_socket` 以外、修正前のコードで Red を確認。
  - 残り：SonarCloud の再解析で S8707（`open(doc)` の 26 行目）が残る場合は、CLI 引数の読み込みなので SonarCloud 上で「Safe」とするかを利用者が判断する。

- 2026-11-12（設計書レビュー・未コミット）：`docs/` の設計書を、コードブロックを実ファイルに展開して tsc・Vitest・pytest を回す方法でレビューし、見つけた不整合を修正した（製品コード `src/`・`minutes_local/`・`test/`・`server_tests/` は無変更。Phase 1 設計書も無変更で src と一致のまま）。
  - **Phase 3 server**：(1) マイグレーション番号が Phase 2 の 008（`sync_samples`）と衝突し、Phase 3 の列追加が丸ごと適用されなかった → 009〜012 に振り直し。(2) 全文差し替えの 14 ファイル＋テスト 2 ファイルが古い Phase 2 を元にしており、fencing token（`finish_job` / `insert_segments` の `attempts`）・`sync_samples`・要約の `quote` / `evidenceSpan`・docstring が巻き戻る状態だった → Phase 2 現行に Phase 3 の差分だけを載せ直した。(3) Live STT の書き込みにも fencing を適用。(4) `meeting.json` を `write_atomic`（一意な一時ファイル）で書き、終了時刻のキーを Phase 1/2 と同じ `endedAtEpochMs` に統一。(5) `on_finalized` に話者分離フラグを渡す。
  - **Phase 2 server**：Phase 1 互換ルートが実装済みの `minutes_local/phase1.py` より緩かった → 会議 ID の形式検査（`..` を登録できると `DELETE` の `rmtree` がデータディレクトリの外へ届いた）、PUT のヘッダ・`X-Chunk-Meta` の検証、破損ファイルの再送による修復、確定の連番検査・キー検査、作成時の `meeting.json`、CORS（`http://127.0.0.1:5173`）と preflight、422 / 500 の `ApiErrorBody`、起動ごとのトークン再生成を追加。確定の再送で `meeting_status: transcribing` を流し直す不具合、Chunk 0 件の会議が `transcribing` で止まる不具合も修正。`web_dir` によるアプリ配信を追加（基本設計 §15・Phase 3 LAN モードの前提だったがコードがなかった）。`server_tests` 10 件の内容を `tests/test_phase1_server_compat.py`（43 件）へ移植し、変更前の設計では失敗することを確認。移行手順を §1.2 に追加。
  - **Phase 2 client**：Finalizer が Phase 1 現行から離れた再実装で、Phase 1 のテスト 22 件を壊していた → 「Phase 1 現行 + 2 系統の差分」に作り直し、`FinalizeResult` は変えない（Phase 1 側の変更は `test/app.test.ts` の 1 か所）。SSE の復号を `TextDecoder` に変更（TS 7 の型エラー）。アプリへの組み込みが未記載だったので、配線表・未決事項・ブラウザ側の実装順序を §15 に追加。
  - **Phase 3 client**：`events.ts` が「全文」と言いながら `FetchEventSource` を省いていた → 全文に。非 loopback の http の拒否文言を `disallowed host` 始まりに（Phase 1 のテストが通る）。逆同期テストが Scheduler の内部状態に依存していた点を修正。
  - 追加：`scripts/extract-design-code.py`・`scripts/verify-design-docs.sh`。`CLAUDE.md` と `design-doc-sync` スキルに手順を追記。
  - **未決事項（利用者の判断待ち、Phase 2 client §15.2）**：画面の描画方式（素の DOM か UI フレームワークか）とノートのエディタ（BlockNote は React が必要）。外部依存の追加を伴う。決まるまでサーバー側の全 Step と、ブラウザ側の録音・確定・SSE の部分は進められる。
  - 残課題（設計書に未反映・次回のレビュー対象）：Phase 3 の `routes_jobs.exclude_failed` が話者分離フラグを渡さない（Phase 2 のファイルを変更禁止にしているため。除外後に話者分離を飛ばして merge へ進む）／Phase 3 の圧縮が `size_bytes` を圧縮後の値に書き換える（`GET /chunks` の `sizeBytes` が変わる）／Phase 2 `request_rerun_stt` の冗長な UPDATE と未使用変数／Phase 2・3 の画面層（DOM）のコードは設計書にない。

- 2026-11-12（ドキュメント整理・未コミット）：リポジトリ直下に配置していた基本設計書・詳細設計書 6 ファイル（`design-local-phase1.md` / `design-local-phase2.md` / `design-local-phase2-client.md` / `design-local-phase2-server.md` / `design-local-phase3-client.md` / `design-local-phase3-server.md`）を `docs/` 配下へ移行した。あわせて関連ドキュメント（`README.md`・`CLAUDE.md`・`PROGRESS.md`・`.claude/skills/design-doc-sync/SKILL.md`・`.claude/skills/implement-design-step/SKILL.md` および各設計書ヘッダ）へ移行した旨と新パスを反映し、同期スクリプト（`scripts/sync-design-code.mjs`・`.claude/skills/design-doc-sync/scripts/check_design_sync.py`）の既定パスを更新した（製品コードの変更なし）。
- 2026-11-10（63 回目・未コミット）：レビュー指摘 18 件を検証し 7 件を修正、11 件スキップ。(1) `pendingCountsText` の最大の連番・endFrame を Math.max への展開でなくループで求める（`hasSequenceGap` も。30 万件で RangeError になった）。(2) 直接送信の PUT が成功したら（DB 未登録でも）`health.lastSuccessfulLocalSaveAt` を `performance.now()` で更新（56 回目は読む箇所がないためスキップしたが、62 回目で Scheduler 側を performance 時計に揃えたので経路を揃えた）。(3) Controller は `createMediaStreamSource` が使うトラック（Web Audio の仕様どおり id 最小、新規 `selectSourceTrack()`）だけを切断監視する（53 回目のスキップを変更。1 本なら挙動は同じ）。(4) `BackendHealthMonitor.checkOnce()` の失敗応答・例外の経路にも、開始時と現在のトークンの比較を入れる（古いトークンの失敗が新しいトークンの HEALTHY・capabilities を消した）。(5) サーバーが受け付けない停止の検出時刻（NaN・小数・負数）は、Controller と App（`unsavedStops`）が記録せず未観測として停止を完了する。復旧は不正な観測（不明な理由も）を片方だけの行と同じく両方外して書き直し、Finalizer は不正な保存値を省いて確定する（新規 `isValidStopObservation()` / `isValidStopDetectedAt()`。55 回目の懸念どおり `put()` では拒否しない）。(6) ネットワーク失敗の再試行の予約が発火して会議ロックが使用中だったら、間隔を延ばして予約し直す（`MEETING_BUSY_IN_THIS_TAB` / `MEETING_LOCKED_BY_OTHER_TAB` を export。60 回目のスキップを変更：別タブの起動時復旧が一時的にロックを持つと、確定されないまま予約が消えた）。(7) `main.ts` の「書き出し」は `discardableMemoryBacklog()` の会議の分も同じ書き出しに入れ、破棄の確認は書き出しに含めた会議だけに出す（60 回目のスキップを変更。現状の経路では差が出ないが、保証をコードで閉じた）。スキップ：Stop ボタンの件（`releaseRecording` が解放時に有効化し、A の遅い完了は `recording` が B なので早期 return 済み）、手動再試行の通知（`manualRetryNeedsNotice()` が同じ理由の失敗も出す。57 回目に対応済み）、Phase 2 client の `stop()` の両方失敗（62 回目に `AggregateError` で対応済み）、`dispose()` 時のロック（src から呼ばれず、`heldLocks` も解放しない）、NETWORK 失敗後の中止済み Chunk の再投入（直後の pump の `markAllPendingUnavailable()` が中止を確かめて外すことをプローブで確認。pending は 0 に戻る）、`markAllPendingUnavailable()` の中止判定失敗（50 回目と同じ。再開可能な状態の間の書き換えだけで、次の pump で読み直す）、復旧の状態不一致時の `SAVING` 再送（44 回目と同じ。停止したタブのスケジューラが送り、確保の照合で二重送信に耐える。タブを閉じていれば次回起動で復旧）、読めなかった会議の同じ実行内での読み直し（56 回目と同じ）、`put()` の 401 とトークン確認の間の隙間（57 回目と同じ。間にタスク境界がない）、内訳の不完全表示をサーバー停止中に保つ件（50 回目と同じ）、drain で直接送った末尾のフレーム数の件（最終保存に成功していれば flush 後の値が IDB にあり、失敗時は `unsavedStops` が同じ `sessionClock` を持ち、離脱確認も続く。IDB に書けない状態でほかに残す先がない）。回帰テスト 14 件（内訳 1・Controller 5（時刻 1・トラック 1・検出時刻 3）・Monitor 2・Finalizer 4・復旧 1・App 1。修正前の Red を確認）。保存確認のテスト 2 件（トラックの「登録前に終了」・Monitor の「トークン不変なら従来どおり UNREACHABLE」。修正前から通る）。実機確認に追加：README「次の実機確認」6（確定中止後の書き出しに中止した会議の WAV が入り、破棄の確認がその会議だけに出る）。インターフェース変更：`selectSourceTrack()`・`isValidStopObservation()`・`isValidStopDetectedAt()`・`MEETING_BUSY_IN_THIS_TAB`・`MEETING_LOCKED_BY_OTHER_TAB` を export（既存の呼び出し元の変更なし）。`main.ts` は Vitest 対象外（typecheck のみ）。TypeScript 495 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文（§12 停止理由、§15 トラック監視・直接送信、§18 トークン差し替え、§31 ネットワーク再試行・書き出しと破棄）、Phase 2 client の RecordingController（トラック監視・検出時刻・直接送信）と Finalizer を更新。
- 2026-11-10（62 回目・未コミット）：レビュー指摘 4 件を検証し全件修正。(1) Phase 2 client の `MultiSourceRecorder.stop()`（設計書のみ）は Mic の停止も失敗したとき、Mic の失敗を先頭・System の失敗を 2 番目にした `AggregateError` を投げる（従来は Mic の例外が System の失敗を消していた。片方だけの失敗は従来どおりその例外を投げる）。設計書のテストに 1 件追加。(2) PROGRESS の見出しとテスト件数を更新（61 回目の 478 件は HEAD で実行して確認）。(3) 確定中止の確認文言から「確定済みにはなりません」を外し、「このブラウザからの自動再送・確定は再開しません。サーバーで確定済みになっていた場合は取り消しません」にする（タイムアウトした確定 POST をサーバーが処理済みのことがある。指摘箇所は app.ts だが文言は `pending-actions.ts`）。(4) `LocalSaveScheduler` の `health.lastSuccessfulLocalSaveAt` を任意の `perfNow`（既定 `performance.now()`）で記録する（型の契約は performance.now() だが、App が渡す `now` は Date.now だった。再試行の `now` は変更なし）。回帰テスト 1 件（(4)、修正前の Red を確認）。インターフェース変更：`SchedulerDeps.perfNow?` を追加（任意、呼び出し元の変更なし）。Phase 1 埋め込み同期（DIFF 0）。
- 2026-11-09（61 回目・コミット済み）：レビュー指摘 5 件を検証し全件修正。(1) Phase 2 client の RecordingController に `discardMemoryBacklog()` を戻す（`SessionController` が Phase 1 から引き継ぐ契約。drain と同じ `drainQueue` で直列化し、空にした後の処理を `onMemoryBacklogEmptied()` にまとめ、ロック解放は `otherSourceBacklogCount` も数える）。§4 の配線に「破棄は Mic と System の両方で呼び、App が合計 0 でロックを解放する」を追加。(2) README の報告項目に 5（ZIP）の結果を追加。(3) `measureMissingTailMs()` は Chunk が 1 件もない（`chunkCount === 0`）とき終わりを 0 とし、`audioFrameCount` 全体を欠けとして返す（従来は 0 を返し、最初の Chunk も届かずに確定した会議を警告しなかった）。(4) `RecordingController` は `start()` の準備中（`starting`。ロック取得後、Worklet ノード生成前で `node === null`）に drain・破棄が空で終わってもロックを解放しない（サーバー復帰の drain が準備中に走ると、録音を始める会議のロックが外れた）。(5) `finalizeResultText()` は `reason: "network"` に「サーバーが使えるようになれば自動で再試行します」と案内する（従来は「確定できませんでした」「再試行してください」で、App の自動再試行を伝えていなかった）。回帰テスト 3 件（(3) Finalizer 1・(4) Controller 1・(5) View 1。修正前の Red を確認）、新規テスト 1 件（(3) の欠けなし側）。既存テスト 1 件の fixture を修正（`recordAndSave(h, 0)` が Chunk 0 件で `audioFrameCount: 1600` を残しており、コメントの「最後の Chunk の終わりに揃える」と矛盾 → 0）。インターフェース変更なし（Phase 2 設計書の Controller に `discardMemoryBacklog()` を追加）。Phase 1 埋め込み同期（DIFF 0）・本文（§15 準備中のロック、§22 Chunk 0 件の欠けと network の文言）、Phase 2 client の RecordingController（破棄・準備中のロック）と Finalizer（Chunk 0 件の欠け）を更新。
- 2026-11-09（60 回目・未コミット）：レビュー指摘 7 件を検証し 4 件を修正、3 件スキップ。(1) README の残りの実機確認に 5（WAV 書き出しの ZIP 化）を追加。(2) 確定の会議登録が `tokenChanged` で失敗したら、現在のトークンが確定開始時と同じ（A → B → A）でも Barrier の後にやり直す（従来はトークンの不一致だけで判定し、`setToken` の確定は借用中のロックに弾かれるので、次の契機まで確定しなかった）。(3) 起動時復旧の書き直し（停止理由の補修・`audioFrameCount` の補い）に失敗した会議は `unreadMeetingIds` で報告して Chunk も再投入せず、起動と他の会議の復旧を続ける（従来は例外で `createApp` ごと止まった）。App は `unreadMeetingIds` の会議を再読み込みまで確定しない（`retryFinalize()` が `startup recovery not saved; reload to retry`。読み直しに失敗した会議も同じく確定しなくなった＝挙動変更。起動時の通知文言も「読み書きできませんでした」に）。(4) テスト「drain 後もメモリ待機が残っていれば確定を再試行しない」は drain の Promise の決着と後続の IDB 読み取りまで待つ（ガードを外すと Red になることを確認）。スキップ：ネットワーク再試行のタイマーがロック使用中で終わる件（ロックを持つ側＝このタブの確定・中止、または別タブがその会議の確定を自分で進め、ネットワーク失敗なら自分の再試行を予約する）、`main.ts` の書き出しと破棄の確認の対象がずれる件（停止後のメモリ待機は増えず、`recording_stopped` 時点で件数が確定し、残る controller はすべて `stoppedWithBacklog` に入るので、破棄の対象は必ず書き出し対象に含まれる）、`dispose()` 時のロックの持ち主の件（`dispose()` は src から呼ばれず、呼んでも `heldLocks` を解放しないのでロックはタブが閉じるまで残る＝安全側）。回帰テスト 3 件（(2) App 1・(3) recovery 1・App 1、修正前の Red を確認）。テスト強化 1 件（(4)）。インターフェース変更：`RecoveryReport.unreadMeetingIds` に書き直しの失敗も含める、`retryFinalize()` の失敗 detail に `startup recovery not saved; reload to retry` を追加。Phase 1 埋め込み同期（DIFF 0）・本文（§12 復旧の書き直し失敗、§31 登録の tokenChanged）を更新。後続フェーズに同じコードの写しはない。
- 2026-11-09（59 回目・コミット済み 8e5e10f まで）：レビュー指摘 8 件を検証し 7 件を修正、1 件スキップ。(1) App の drain は実行中に来た直接送信の drain 要求（サーバー復帰・`setToken`）を、実行中の drain が直接送信でも記録し、終わってからメモリ待機が残れば直接送信で送り直す（確定再試行の直接送信 PUT が接続失敗する間の `setToken` の復旧が捨てられ、借用中のロックで確定再試行も弾かれていた）。(2) `acquireMeetingLock()` は取れなかったとき、このタブの使用中（借用中の保持ロック・取得中の `acquiredLocks`）か別タブかを返し、`retryFinalize()` は前者を `meeting is busy in this tab` で返す。(3) Scheduler の NETWORK / TIMEOUT 失敗は自タブの確保が残るときだけ `onBackendUnreachable()` を呼ぶ（別タブが確保し直した古い試行の遅いタイムアウトで、このタブの送信を止めていた）。(4) 起動時復旧は停止理由と検出時刻の片方だけの行から両方を外して書き直す（`MeetingStore.put()` が拒否して起動ごと止まり、確定も 422 になる）。(5)〜(7) テスト：Scheduler の会議登録 POST を認証より前で数えて 1 回を確認（FakeLocalServer は認証で弾いた要求を記録しないため、従来の 0 件は何も確かめていなかった）、古いトークンの 401 を新しいチェックの完了後に届けて前後で HEALTHY を確認、drain の重なりテストで登録済み＋メモリ待機の連番集合を照合。スキップ：直接送信でメモリ待機から外した末尾のフレーム数（タブ内では `unsavedStops` の `sessionClock` と `directRegisteredEndFrames` が保持し、ロック・離脱確認・controller もそれが残る間は外れない。失われるのは再読み込み・クラッシュだけで、外さなくても音声ごと失われる。サーバーは `total_audio_frames` を保存するだけで拒否しない。再読み込み後の復元には一覧 API に `endFrame` が要る＝API 変更のため「保留・メモ」に記録）。回帰テスト 4 件（(1)(2)(3)(4)、修正前の Red を確認）。ガードのテスト 1 件（別タブ保持時の文言、修正前から通る）。テスト強化 3 件（(5)〜(7)、修正前から通る）。インターフェース変更：App 内部の `acquireMeetingLock()` の戻り値を `MeetingLockResult`（private）に、`retryFinalize()` の失敗 detail に `meeting is busy in this tab` を追加。`acquiredLocks` 経路（`tryAcquireMeetingLock` で取得中の同タブ競合）は専用テストなし。Phase 1 埋め込み同期（DIFF 0）・本文（§12 停止理由の復旧、§18 配線、§31 drain・ロック競合の文言）を更新。後続フェーズに同じコードの写しはない。
- 2026-11-09（58 回目・未コミット）：レビュー指摘 5 件を検証し全件修正。(1) `MeetingRegistrar` の登録 POST は試行ごとに `AbortController` とタイムアウトを持つ（トークン変更の送り直しが 1 回目の待ち時間の残りしか使えず、到達できるサーバーへの登録が `TIMEOUT` になった）。(2) 確定中止した会議のメモリ待機を、WAV の保存を確認した後に破棄できる（`App.discardMemoryBacklog()`・`discardableMemoryBacklog()`、`RecordingController.discardMemoryBacklog()`。破棄で離脱確認・保持ロック・バナーの件数・controller の控えを外す。`confirmAbandon()` は中止後に 3 つ目の確認を出し、断った場合は「書き出し」ボタンの後に同じ確認を出す）。(3) `main.ts` の確定中止のキャンセル・失敗時は、会議 ID（`data-meeting-id`）で今の行を探してボタンを戻す（書き出し・中止を待つ間の再描画で元のボタンが外れていた）。失敗の通知は維持。(4) Finalizer は接続失敗・タイムアウト（一覧・確定 POST・会議登録の `NETWORK` / `TIMEOUT`）に `reason: "network"` を付け、App は `backoffMs()` の間隔で確定の再試行を予約する（ポーリングの合間の瞬断ではヘルス状態が変わらず、再試行されなかった）。予約は世代で管理し、確定・中止・他の失敗で消す。発火時にサーバーが使えなければ復帰通知に任せる。(5) `RecordingController.stop()` は重なった呼び出しで実行中の停止を共有し、完了まで `start()` を拒否する（後から終わる stop の後始末が次の録音の入力・`onmessage`・ロックを外しえた）。回帰テスト 3 件（(1) Registrar 1・(4) App 1・(5) Controller 1。修正前の Red を確認）。新規テスト 7 件（(2) Controller 2・App 2・`confirmAbandon` 3。メソッドがなかったため Red は回帰の確認ではない）。既存テスト 1 件を変更（停止の重なりで Worklet への `stop` が 2 回送られるのを待っていた → 1 回）。インターフェース変更：`FinalizeResult.reason` に `"network"`、`SessionController` に `discardMemoryBacklog`、`AbandonActions.discardBacklog?`、`discardBacklogQuestion()`、`App.discardMemoryBacklog()` / `discardableMemoryBacklog()`、`RecordingController.discardMemoryBacklog()`。`main.ts`（(3) と破棄の配線）は Vitest 対象外で typecheck のみ。実機確認に追加：確定中止で破棄の確認が出て、OK 後にタブを閉じても確認が出ない・バナーが消える／書き出し待ちの間に一覧が更新されても、キャンセル後にボタンが押せる。Phase 1 埋め込み同期（DIFF 0）・本文（§15 stop の共有、§17.1 Registrar のタイムアウト、§22 network の再試行、§31 破棄と行の復元）、Phase 2 client の RecordingController（stop の共有）と Finalizer（`reason: "network"`）を更新。
- 2026-11-09（57 回目・未コミット）：レビュー指摘 9 件を検証し 8 件を修正、1 件スキップ。(1) `LocalSaver.put()` のタイムアウトを PUT ごとに張り直す（トークン変更の送り直しが会議確認を待つ間に最初の期限が切れると、中断済みの signal で送って即 `TIMEOUT` になった）。Phase 3 client の LocalSaver にも同じ修正。(2) Scheduler の送信前の確保と `markAllPendingUnavailable()` を `isResumable()` で判定し、non-retryable の `LOCAL_SAVE_FAILED`（`resumeAll` の再送が 409・422 になった後）を前の試行のリトライタイマーが再送・`BACKEND_UNAVAILABLE` に書き戻さない。(3) App は確定・確定中止した会議の controller・drain・`meetingFallbacks` を手放す（`releaseSettledMeeting`。メモリ待機・未保存の停止状態が残れば保つ）。(4) 手動「再試行」の失敗は前回と同じ理由でも通知欄に出す（`manualRetryNeedsNotice()`、理由が変わったときは `finalize_pending` に任せて重ねない）。(5) メモリ待機の WAV 書き出しを 1 回のダウンロードに（複数は新規 `src/export/zip.ts` の無圧縮 ZIP、外部依存なし。入れたファイル名を通知欄に表示）。(6) 確定中止の最初の確認に「キャンセルで中止も取りやめ」を明記、`exportWav` は Promise も受ける。(7) README の停止理由の確認に停止前後の時刻の控えと、検出時刻がその時間帯（±5秒）に入るかの確認を追加。(8) T4-H の状態を「Chrome 再生は全件確認済み・聴取のみ未確認」に統一し、2026-10-07 の再開点を履歴と明記（README も同様）。スキップ：`put()` が 401 を返す直前のトークン確認と Scheduler の処理の間にトークンが変わる件（確認から `return`・`runOne` の続きまでは同じマイクロタスク列で、`setToken` のトークン代入は IDB 保存完了という別タスクの後なので割り込めない）。回帰テスト 5 件（Scheduler 2・LocalSaver 1・App 1・確認文言のアサーション 1、修正前の Red を確認）。新規テスト 6 件（`manualRetryNeedsNotice` 3・ZIP 3。関数がなかったため Red は回帰の確認ではない。`main.ts` の配線は typecheck のみ）。インターフェース変更：`AbandonActions.exportWav` が `void | Promise<void>` を返せる、`manualRetryNeedsNotice()` を追加、新規 `src/export/zip.ts`。`main.ts` は Vitest 対象外（typecheck のみ）。ZIP は unzip -t・Python zipfile・ditto で展開でき、中身のハッシュ一致を確認。実ブラウザでの書き出しは未確認で、次の実機確認に追加（メモリ待機 2 件以上で「複数ファイルのダウンロード」確認なしに ZIP が 1 つ保存される、Finder で開ける、通知のファイル名と一致、各 WAV が再生できる）。Phase 1 埋め込み同期（DIFF 0）・本文（§9 遷移表、§17 二重送信防止・LocalSaver のタイムアウト、§31 controller の解放・書き出し・手動再試行）、Phase 3 client の LocalSaver を更新。
- 2026-11-09（56 回目・未コミット）：レビュー指摘 7 件を検証し 4 件を修正、3 件スキップ。(1) Phase 2 client の Mic `stop()` は最終の読み取りで会議がなければ、最初の読み書きが成功していても reject（`firstMissing` を削除）。(2) Python の旧スキーマ移行テストは `DROP COLUMN`（SQLite 3.35 以上）をやめ、停止理由列のない会議表を直接作ってから起動する（移行を無効にすると落ちることを確認）。(3) `onBackendAvailable()` の再投入と確定の再試行を別々の try に（`recording` の一覧が読めなければ再投入はせず、確定は続ける）。(4) `listPendingFinalize()` は `unsavedStops` と IDB の両方にある会議を、IDB の状態＋保持中の `sessionClock` で返す。スキップ：直接送信の成功で `lastSuccessfulLocalSaveAt` を更新する件（この値を読む箇所が src にない。設定しても挙動が変わらない）、起動時復旧で読めなかった会議を同じ実行内で読み直す件（主な原因の接続切断はページの寿命の間は直らず、既に `unreadMeetingIds` で再読み込みを案内している）、App テストで本物の Controller を使う nitpick（`recording-controller.test` が本物の Controller で drain の IDB 書き戻しを検証済み。49 回目と同じ判断）。回帰テスト 2 件（(3)(4)、修正前の Red を確認）。インターフェース変更なし。Phase 1 埋め込み同期（DIFF 0）・§31 本文、Phase 2 client §6 の `stop()` コードと本文を更新。
- 2026-11-09（55 回目・未コミット）：レビュー指摘 7 件を検証し 6 件を修正、1 件スキップ。(1) App は直接送信の件数と連番→endFrame（`directRegisteredEndFrames`。従来の `directRegisteredEndFrame`・`directRegisteredSeqs` を 1 つに統合）を確定成功時に消す（確定待ちの間は保つ）。(2) `listPendingFinalize()` は `stop_requested` と `finalizing` の取得を別々に試み、片方の失敗でも読めたほうを返す。(3) 両方に載った会議は会議 ID で 1 行にまとめ、`main.ts` の再試行・確定中止は同じ会議の操作中ならクリックを無視する。(4) 末尾を直接送信した会議でも末尾の欠けを測る：Finalizer に `offIdbEndFrame` を追加し、`measureMissingTailMs` は最後の連番が IDB になければその値を使う（指摘は Controller の配列を残す案だったが、App が既に endFrame を持つので Finalizer に渡す形にした）。(5)(6) IDB・確定中止テストの nitpick。スキップ：`MeetingStore.put()` の検出時刻をサーバーの制約（0 以上・SQLite 整数上限・整数）で検証する件（値は `Date.now()` 由来の整数だけで、put で拒否すると 422 の理論上の可能性が停止状態の保存失敗に変わり、かえって確定できなくなる）。回帰テスト 4 件（(1)+(4) の App 1・Finalizer 1・(2) 1・(3) 1、修正前の Red を確認）。インターフェース変更：`FinalizerDeps.offIdbEndFrame`（任意）、`measureMissingTailMs` の第 4 引数（任意）。`main.ts` は Vitest 対象外（typecheck のみ）。Phase 1 埋め込み同期（DIFF 0）・§22・§31 本文、Phase 2 client の Finalizer を更新。
- 2026-11-09（54 回目・未コミット）：レビュー指摘 9 件を検証し全件修正。(1) Phase 2 client の Finalizer に `onBackendUnauthorized` を追加し、`GET /chunks`・`POST /finalize` の 401/403 で Monitor へ伝える（Phase 1 と同じ）。(2) Phase 2 client の `stop()` は System の停止が失敗しても Mic を止め、その後で System の失敗を投げる。(3) App：停止状態を書けていない間も離脱確認を続け、書き直せてメモリ待機も空になったら外す（`releaseLifecycleIfSettled`）。(4) `listPendingFinalize()` は `finalizing` の取得だけ失敗しても `stop_requested` を返す。(5) `retryFinalize()` の停止状態書き直しの失敗も `finalizeIssues` に記録し `finalize_pending` を通知（`recordFinalizeIssue` に共通化、同じ stage/detail は重ねない）。(6) `App.whenBackendRecoverySettled()` を追加し、テストの `settleMonitor` が復帰時の復旧完了まで待つ。(7) crash-recovery テストの片付けを finally へ。(8) App テストの FakeController が `backlog` を WAV として書き出す。IDB 外の連番・endFrame・中止後の書き出しのテスト 2 件を追加。(9) Controller の停止が重なっても最初の停止理由を保つテストを追加。回帰テスト 3 件（(3)(4)(5)、修正前の Red を確認）。テスト追加 4 件（(8) 2 件・(9) 2 ケース。修正前から通る）。インターフェース変更：`App.whenBackendRecoverySettled()` を追加。Monitor 通知の復旧失敗は `AppEvent.error` で通知するようにした。TypeScript 440 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・§31 本文、Phase 2 client §6・§7 を更新。
- 2026-11-09（53 回目・未コミット）：レビュー指摘 11 件を検証し 10 件を修正、1 件スキップ。(1) Phase 2 client の `MultiSourceRecorder.stop()` の検出時刻の既定値を `Date.now()` に（`deps.now` はドリフト計測用の performance 時計）。(2) App：サーバー停止中の確定再試行の drain（IDB への書き戻しだけ）の実行中にサーバーが戻ったら、その要求を記録し、drain を終えた直後に直接送信で drain し直す（復帰時の drain と確定が実行中の drain・借用中のロックに弾かれ、次の復帰まで末尾が残る問題）。(3) `main.ts` の確定待ち一覧の更新を世代番号から単一実行＋後続 1 回の再実行に（読み込みが 5 秒より遅いと一度も描画されない問題）。(4) Scheduler：`RETRYING` の期限前に `runOne()` に来た Chunk は残り時間のタイマーで再投入（即時再投入で期限まで空回り）。(5) Scheduler：成功の書き戻しも自タブの確保が残るときだけ行い、`onChunkSaved` もそのときだけ（52 回目の「成功は確保に関係なく書く」を変更。古い `registered: false` が新しい `DB_REGISTERED` を `SAVED` に戻すため）。(6) Controller の `drainMemoryBacklog()` を直列化（Phase 2 client の Controller にも同じ修正）。(7) `MeetingStore.put()` は停止理由と検出時刻の片方だけの会議を拒否。(8) Controller テストのトラックを `stop()` で `ended` にし、録り直しは新しいトラックで行う。(9) サーバーテストで最初の確定後に `meeting.json` を消し、再試行が最初の値で作り直すことを確認。(10) 確定中止で WAV 書き出し後に最後の確認を断るテストを追加。スキップ：Controller の監視トラックを `createMediaStreamSource` の 1 本に絞る件（`getUserMedia({ audio: true })` の音声トラックは 1 本で、全トラックの監視と挙動が変わらない。複数トラックのストリームを受ける経路はない）。回帰テスト 5 件（修正前の Red を確認：Scheduler 2・Controller 1・IDB 1・App 1）、テスト強化 3 件（トラックの再現性・サーバー snapshot・中止キャンセル。いずれも修正前から通る）。インターフェース変更：`MeetingStore.put()` が片方だけの停止情報で reject（呼び出し元は常に組で書くため影響なし）。`main.ts` は Vitest 対象外（typecheck のみ）。Phase 1 埋め込み同期（DIFF 0）・本文（§9.2 確保の規則、§12 停止理由、§15 drain の直列化、§31 retryFinalize・一覧更新）、Phase 2 client（`stop()` の既定値、Controller の drain 直列化）を更新。
- 2026-11-08（52 回目・コミット済み 311c863 まで）：レビュー指摘 7 件をすべて有効と判定して修正。(1) `retryFinalize()` はサーバーが使えなくてもメモリ待機の drain を試す（IDB への書き戻しだけ。`directSaver` は送信前に失敗を返し、`memory_backlog_export_required` も重ねない）。(2) drain の直接送信が `tokenChanged` で送れなければ通知せず、drain を終えた直後に同じ引数で drain し直す（並行しない。`setToken` の drain が実行中の drain に弾かれて末尾が残る問題）。(3) Scheduler の `runOne()` は送信可否の確認と `SAVING` の確保を同じ `updateSaveState()` で行い、失敗の書き戻しは自タブの確保（`attempts` が確保時の値の `SAVING`）が残るときだけ行う（`updateClaimed()`・`recoverFailedRun()` も同じ）。(4) `tokenChanged` の回は確保時に足した `attempts` を戻す。(5) 起動時復旧はロック後に読み直した会議レコードで `audioFrameCount` を補う。(6) `FinalizeResult` の失敗に `reason: "unauthorized"` を追加（登録の `UNAUTHORIZED`・一覧／確定の 401/403・トークン未設定）、`finalizeResultText` は detail の正規表現をやめてこれで判定。(7) Registrar テストで `unauthorizedReported: true` を確認。回帰テスト 9 件（修正前の Red を確認）、ガードのテスト 3 件（オフライン時に直接送信しない・meetingId が "HTTP 403" で終わる一覧を認証エラーにしない・認証分類の UI 文言）を追加。インターフェース変更：`FinalizeResult` に任意の `reason`、App 内部の drain に `direct` 引数（private）。TypeScript 427 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文（§9.2 遷移表と確保の規則、§17 二重送信防止、§22 認証分類、§23 復旧、§31 retryFinalize・配線表）、Phase 2 client（Finalizer の `reason`、drain の記述）を更新。
- 2026-11-08（51 回目・コミット済み 3bff8f5 まで）：レビュー指摘 13 件を検証し 8 件を修正、5 件スキップ。(1) `LocalSaver.put()` の送り直しは `ensureMeeting` の確認後に最新トークンを読む。(2) 送り直し中もトークンが替わり続けた失敗に `tokenChanged: true` を付け（`MeetingRegistrar` も同じ）、Scheduler は試行上限に数えずすぐ再投入する（上限の回で `LOCAL_SAVE_FAILED` に残り、送信中で `setToken` の `resumeAll` に拾われなかった Chunk が止まる問題）。(3) `retryFinalize()` は停止状態の書き直しより前にメモリ待機を drain（書き直し失敗で確定は止めたまま）。(4) 起動時復旧は `stop_requested` の会議も `audioFrameCount` を保存済み Chunk の最大 endFrame まで補う（大きい値は維持）。(5) App テストの固定 50ms 待ちを、LIST 2 回と Scheduler の待機 0 件の待ちに置換。(6) Phase 2 client の Mic `stop()` は両方の読み取りで会議がなければ reject。(7) Phase 3 client の LocalSaver を Phase 1 現行全文（`ensureMeeting`・`unauthorizedReported`・`isRetryableError`・上記 1〜2）＋許可 origin に組み直し。(8) Phase 3 server に rebuild の停止理由の組（有効値の保持・不正値 6 通りの除去）のテストを追加。スキップ：Phase 3 client の 401 とトークンの対応付け（送り直しで既に古いトークンの 401 を報告しない）、トークン世代番号（A→B→A で A の 401 は現在のトークン A の失効を正しく示す）、ヘルスチェックの失敗経路のトークン照合（接続不能・5xx はトークンと無関係な到達性の観測で、次のポーリングで回復する）、Scheduler の中止後の NETWORK 再投入（`markAllPendingUnavailable` が中止会議のキーを外し、`runOne` が送信前に中止を確かめるので再送されない）、`pendingCountsText` の `Math.max` 展開（会議あたり数百件で引数上限に遠い）。回帰テスト 5 件追加・1 件強化（すべて修正前の Red を確認）。`fail()` の戻り型を失敗側に絞った（private）。TypeScript 415 件・typecheck 通過。Phase 1 埋め込み同期（DIFF 0）・本文（§9.2 遷移表、§17.1、§23、§31）を更新。
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

設計は [docs/design-local-phase1.md](docs/design-local-phase1.md) §31（アプリの組み立て）。利用者判断（2026-09-26）：Vite を追加し、配線は設計書に節を足してから実装する。

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
- 結果は [docs/design-local-phase1.md](docs/design-local-phase1.md) §28 の「状況」列に反映する。

### 次セッションの再開点：T4 実機再確認チェックリスト（2026-10-01 作成・A〜G 合格、H は一部確認）

- **履歴（2026-11-08・42 回目時点の T10 結果。最新の状態ではない）**：T10 は合格。利用者が手動再試行なしの確定を報告し、会議 `f4ea99b6…` の36.8080625秒・2 Chunk・サーバー確定済みの照合結果と一致。T12-b の案内後の会議 `bbd1a297…` は保存・確定済みまで43回目に照合した。まず物理切断で自動停止し通知が出たかを利用者へ確認する。その後、既存11 WAVの聴取（T4-H）を確認する。H の既存11件の Chrome 再生は全件最後までメディアエラーなく完了（2026-11-08・40 回目。消音・16倍速）、音が聞こえるかの聴取確認だけが未確認。**現在は通常 API・Vite とも停止中**（44 回目に利用者指示で停止）。テストとサーバーの再起動は利用者の指示があってから行う。

- **履歴：次セッションの再開点（2026-10-07 終了時。最新の状態ではない。T4-H の現状は上の項目と「現在地」の表を参照）**：
  1. 両サーバーは停止済み。T4 の必須項目 A〜G は合格。H は既存 Chunk の Chrome 再生が未確認で、結果を確認するまで合格としない（書き出した WAV の再生と外部通信なしは確認済み）。※その後 2026-11-08 に Chrome 再生は全件確認済み。残りは聴取確認のみ。
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
6. **記録と次段階**：各試験の会議ID、Chunk件数・連番、IDB状態、HTTPステータス、警告・エラー、外部通信の有無を [docs/design-local-phase1.md](docs/design-local-phase1.md) §28 と本ファイルへ反映する。失敗時は原因と再試験条件を記し、通過扱いにしない。必要な修正後は `.venv/bin/python -m pytest -q`、`npm run typecheck`、`npm test`、`npm run build`、`node scripts/sync-design-code.mjs --check`、`git diff --check` を実行する。1-g の60分実録音（120 Chunk、欠番なし、全件 `DB_REGISTERED`、外部通信なし）は別の試験として最後に実施する。コミットは利用者の指示・承認後のみ行う。

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
- 直接送信した末尾の `endFrame` は IDB に残らず、再読み込み・クラッシュ後の復旧は IDB の Chunk だけで `audioFrameCount` を補うため小さくなりうる（サーバーは保存するだけで確定は通る。末尾の欠けの計測が過小になる）。直すなら `ChunkListResponse` に `endFrame` を足して復旧・Finalizer で補う（API 変更・要確認、59 回目のスキップ）。
- `package.json` に lint スクリプトがない。コミット前の確認は現状 `typecheck` + `test` のみ。
- 設計書のテストコード（`test/harness.ts`、`test/crash-recovery.test.ts`、`test/chunk-standalone.test.ts`、`test/resampler-aliasing.test.ts`）は、実装側にテストを足したため設計書と一致しない。設計書側は「最低限のテスト集合」という扱いで許容している。

---

## セッションログ

新しい順。1 セッション 3〜5 行まで。

### 2026-11-13（レビュー指摘 3 件：補完の再生・エラー応答の本文・閉じていないブロック）

- `MeetingEventsClient.backfill()` の保留分の再生を `replay()` にまとめ、コールバックの例外を 1 件ごとに記録して続ける（次の補完・取り直しを飛ばさない）。`Phase2Client` / `Phase3Client` の `request()` は、エラー応答の本文の読み取り失敗を TIMEOUT / NETWORK にせず status で返す。Phase 2 client を直し、Phase 3 client の載せ直しにも同じ変更を当てた。
- `scripts/extract-design-code.py`：閉じていないコードブロックがあれば終了コード 1 で失敗させる（前フェーズのファイルのまま検証が通るのを防ぐ）。フェンスの 3 文字までのインデントも受け付け、本文から開きのインデント分を取り除く（CommonMark。インデントした差し替えブロックを黙って取りこぼさない）。全設計書の展開結果は変更前と同一。
- 検証：追加した回帰テスト 2 件が修正前のコードで Red になることを確認。`scripts/verify-design-docs.sh` 通過（Phase 2 server 128・Phase 3 server 164・Phase 2 client 558・Phase 3 client 593）。製品コードは無変更のため `npm test` は未実行。未コミット。

### 2026-11-13（設計書の厳しめレビュー 2 回目）

- 展開したコードのカバレッジを起点に、テストが通っていない経路をレビュー。SSE が最初の keepalive で落ちる、Apple Silicon で STT が cuda を選ぶ、モデルの選定が起動時のまま、プールが作り直されない、モデル取得が全滅、録音中の rerun が保存を止める、クライアントが応答を無検証で通す、を修正。詳細は「今回の変更と残課題」。
- 検証：`scripts/verify-design-docs.sh all` 通過（Phase 2 server 128・Phase 3 server 164・Phase 2 client 557・Phase 3 client 592）。製品コードは無変更のため `npm test` は未実行。未コミット。
- 次：Phase 3 固有部分のレビュー（未着手）と、Phase 2 server §26 の R1〜R6・未決事項 D1 / D2 の判断。

### 2026-11-12（Phase 2 / 3 設計書のレビューと修正）

- 設計書のコードブロックを展開して tsc・Vitest・pytest を回し、Phase 3 server の全面的な巻き戻り（古い Phase 2 が元）とマイグレーション番号の衝突、Phase 2 server の Phase 1 互換ルートの緩み（会議 ID 検査・CORS など）、Phase 2 client の Finalizer の乖離、Phase 3 client の欠落を修正した。詳細は「今回の変更と残課題」。
- 検証：`scripts/verify-design-docs.sh all` が通過（Phase 2 server 87・Phase 3 server 115・Phase 2 client 527・Phase 3 client 560）。Phase 1 は `sync-design-code.mjs --check` で一致。製品コードは無変更のため `npm test` は未実行。
- 次：Phase 2 client §15.2 の未決事項（描画方式・エディタ）を利用者に確認する。Phase 1 の残り（T4-H の聴取、T12-b、任意の C2、保留中の 1-g）は変わらず。

### 2026-11-12（設計書の `docs/` 移行）

- リポジトリ直下の `design-local-phase*.md`（6 ファイル）を新設した `docs/` 配下へ移動した。
- `README.md`・`CLAUDE.md`・`PROGRESS.md`・`.claude/skills/`・各設計書の参照パスを更新し、`docs/` へ移行した旨を記載した。
- `scripts/sync-design-code.mjs` と `check_design_sync.py` の参照先を `docs/design-local-phase1.md` に更新し、同期確認を通した。コミット未実施。

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
