# 議事録Webアプリケーション Phase 3 詳細設計書 ── サーバー側（Python）

**対象:** Phase 2 詳細設計（`docs/design-local-phase2-server.md`）の `minutes_local` パッケージに対する Phase 3 の追加・変更。Live STT（準リアルタイム）／話者分離／日英言語認識／FLAC 事後圧縮と高度な復旧／LAN 共有。
**上位文書:** Phase 2 基本設計書 §20〜§24（Phase 3 概要）。Phase 3 には基本設計が存在しないため、本書 §2 で基本設計相当の判断を先に確定する。
**対となる文書:** Phase 3 詳細設計書 ── ブラウザ側（`docs/design-local-phase3-client.md`）。
**配置:** `docs/design-local-phase3-server.md`（2026-11-12 にリポジトリ直下から `docs/` 配下へ移行）。
**設計方針:** Local-First / Zero External Data Egress / Recording-First / Fault-Tolerant / At-Least-Once / Hardware-Aware Degradation。v4.0 の Recording is Source of Truth と Invariant 1〜10 を継承する。LAN 共有は「利用者自身が管理する LAN 内」に限定し、インターネット公開は対象外。
**検証状態:** 本書の全 `python` コードブロック（37 ファイル。うち 14 は Phase 2 ファイルの全文差し替え、2 は Phase 2 テストの差し替え）は Phase 2 のパッケージに上書き・追加され、Phase 2 の 131 件と本書の 62 件（計 20 ファイル 193 件）が Fake Provider による pytest で全件通過することを確認している（2026-11-13、§23）。`pyproject.toml` も本書で差し替える（§1.1）。再現は `scripts/verify-design-docs.sh server`。**全文差し替えのファイルは「Phase 2 の現行ファイルに Phase 3 の差分を当てたもの」である。** Phase 2 側を直したら同じ変更を本書のブロックにも当てる（当て忘れると、Phase 3 の実装で Phase 2 の修正が巻き戻る）。FLAC は実コーデックで往復と破損入力を確かめた（soundfile 0.14.0 / libsndfile 1.2.2、macOS arm64。検証スクリプトが `soundfile` を入れて §23.6 の `test_flac_codec_roundtrip_is_bit_exact` を走らせる）。pyannote の実 Provider は Pipeline だけを差し替えて、時刻の組み立て・引数・一時ファイルの扱いを確かめている（§23.4）。pyannote 本体・faster-whisper の言語判定・実 TLS 接続は設計時点では実行していない（Step 3-h）。

---

停止理由の追加契約（Phase 1 §12）を継承する。`stopReason` / `stopDetectedAtEpochMs` は対で省略可能、既存会議は未記録のまま保持し、最初の確定値を上書きしない。`mic_ended` は音声トラック終了の観測であり物理切断の断定ではない。

# 1. 目的と範囲、Phase 2 からの変更一覧

| 区分 | ファイル | 内容 |
| --- | --- | --- |
| 変更禁止 | `api/routes_jobs.py`、`api/routes_models.py`、`api/sse.py`、`api/common.py`、`db/connection.py`、`db/migrate.py`、`db/repo.py`、`jobs/retry.py`、`jobs/sweeper.py`、`jobs/events.py`、`jobs/context.py` 以外の `jobs/*`、`stt/provider.py`、`stt/fake_provider.py`、`stt/executor.py`、`stt/worker.py`、`stt/faster_whisper_provider.py`、`stt/overlap.py`、`stt/confidence.py`、`vad/*`、`merge/normalize.py`、`merge/dedupe.py`、`llm/*`（`prompts.py` 以外）、`hw/*`、`storage/models_dir.py` | Phase 2 のまま。Phase 1 §12・Phase 2 §14 の API 契約はレスポンス形状を変えない（追加のみ） |
| 変更（全文再掲） | `pyproject.toml`（§1.1）、`config.py`、`db/models.py`、`jobs/context.py`、`jobs/pipeline.py`、`jobs/runner.py`、`jobs/handlers.py`、`merge/merger.py`、`llm/prompts.py`、`storage/files.py`、`api/app.py`、`api/routes_phase1.py`、`api/routes_meetings.py`、`bootstrap.py`、`__main__.py` | §4〜§22 で全文を示す |
| 新規 | `db/migrations_phase3.py`、`db/repo_phase3.py`、`jobs/live.py`、`jobs/scheduler.py`、`diarization/*`、`merge/echo.py`、`stt/language.py`、`storage/codec.py`、`storage/backup.py`、`storage/rebuild.py`、`auth/users.py`、`auth/tls.py`、`api/routes_phase3.py` | — |

## 1.1 依存の追加 `pyproject.toml`（変更）

Phase 3 の機能はどれも任意の依存（extras）で有効になる。入っていなければその機能だけが無効になり、サーバーは Phase 2 と同じに動く。

```toml
# pyproject.toml
[project]
name = "minutes-local"
version = "0.3.0"
description = "議事録アプリ ローカル常駐サーバー（Phase 3）"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "httpx>=0.27",
  "pydantic>=2.7",
  "psutil>=5.9",
]

[project.optional-dependencies]
stt = ["faster-whisper>=1.0", "onnxruntime>=1.17"]
cuda = ["faster-whisper>=1.0", "onnxruntime-gpu>=1.17"]
flac = ["soundfile>=0.12", "numpy>=1.26"]
lan = ["cryptography>=42"]
diarization = ["pyannote.audio>=3.1"]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "anyio>=4", "cryptography>=42", "soundfile>=0.12", "numpy>=1.26"]

[project.scripts]
minutes-local = "minutes_local.__main__:main"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

| extras | 入れると有効になるもの | 入っていないとき |
| --- | --- | --- |
| `flac` | `compress_chunk`（§16 `FlacCodec`）。`numpy` は `faster-whisper` も使うが、STT を入れない構成でも圧縮できるよう明示する | `ctx.codec is None`。圧縮ジョブを作らない。既に FLAC になった Chunk は読めない（`InvalidWavError`）ので、圧縮を使い始めたら外さない |
| `lan` | `doctor --init-tls`（§19 `auth/tls.py`） | `--init-tls` が ImportError で終わる。証明書を別の手段で用意すれば `serve --tls` は動く |
| `diarization` | 話者分離（§12 `PyannoteDiarizationProvider`）。PyTorch を連れてくるので大きい | モデルを配置していても `ModelMissingError` → 話者分離なしで merge へ進む |
| `dev` | テスト。`cryptography` と `soundfile` は §23.7 の証明書のテストと §23.6 の実コーデックのテストが使う（`soundfile` がなければ後者は skip） | — |

---

# 2. Phase 3 の設計判断（基本設計相当）

## 2.1 Live STT（準リアルタイム）

| 候補 | 内容 | 採否 |
| --- | --- | --- |
| A. 準リアルタイム | 録音中に PUT された Chunk を finalize を待たず STT し、未マージの生セグメントを Live Transcript ペインに出す。遅延 = 30 秒（Chunk 長）+ STT 時間 | **採用** |
| B. 真のストリーミング | 数百 ms 単位で音声を送りサーバーで逐次 STT | 不採用。録音中の AudioWorklet と GPU/CPU を奪い合い、`NO_AUDIO_FRAMES` を誘発しうる（Invariant 8 の観点）。ブラウザ側の Zero External Data Egress を保ったまま実装するには WebSocket が必要で CSP が広がる |
| C. Web Speech API | ブラウザ組み込み | 不採用。実装がクラウド STT に音声を送る場合があり Zero External Data Egress に反する |

確定事項：

* Live は **Experimental Preview**（v4.0 §81・§100）。Live の失敗・遅延は録音にも確定 STT にも影響しない（Invariant 1）
* `meetings.live_stt_enabled`（作成時に `settings.live_stt_enabled` を写し、`PUT /v1/meetings/{id}/live` で会議単位に切替）
* ジョブ種別 `live_transcribe_chunk`（`priority=80`：`vad_chunk`(50) より後、`transcribe_chunk`(100) より先）。VAD は掛けず、ブラウザ側 `has_voice` を使う（プレビューなので false negative は許容。確定 STT が後から救う）
* 確定 STT（`transcribe_chunk`）は、同一 Chunk の Live セグメントが既にあれば STT を**再利用**（`stt_provider` を呼ばず `completed` にする）。同一モデル・同一入力なので結果は同じ。ただし Live は Overlap を付けないため境界品質が僅かに劣る。利用者が「STT 再実行」を選べば Overlap 付きで撮り直せる
* Live State Machine（v4.0 §82）はサーバー側で算出して `GET /meetings/{id}` の `liveState` に載せる。判定：未有効 `DISABLED`／有効だが Chunk なし `STARTING`／最古の未完了 Live ジョブの経過 < 90 秒 `RUNNING`／90〜300 秒 `DEGRADED`／300 秒超または STT モデルなし `STOPPED`
* ハードウェア区分 `gpu_small` / `cpu_only` では `settings.live_stt_enabled` の既定を false にし、有効化時に警告を返す（強制はしない）

## 2.2 話者分離

| 候補 | 内容 | 採否 |
| --- | --- | --- |
| A. 会議単位のダイアライゼーション（pyannote 系） | finalize 後、確定 STT 完了後に会議全体を処理し、セグメントにラベルを付ける | **採用** |
| B. Chunk 単位 | Chunk ごとに独立処理 | 不採用。Chunk をまたぐ同一話者のラベルが一致しない |
| C. 話者埋め込みのオンライン更新（Live 中） | Live 中に話者を出す | 不採用（Phase 3 でも対象外）。精度・負荷とも実測なしに設計できない |

確定事項：

* ジョブ種別 `diarize_meeting`（`priority=150`：全 `transcribe_chunk` 完了後、`merge_transcript`(200) の前）。依存関係は `transcribe 完了 → diarize → merge → summary` に変わる
* `DiarizationProvider` 抽象 + pyannote 実 Provider（遅延 import）+ Fake。モデルは利用者が `{dataDir}/models/diarization/` に配置する。Phase 2 §7.4 のような取得の経路は用意しない（配置の規約と理由は §12）
* 実 Provider に渡す音声は、source ごとに Chunk を絶対時刻の位置へ置いて連続させる（`assemble_timeline()`）。話者分離に渡すのは STT が完了した Chunk だけなので、無音で STT を省いた Chunk の区間は無音で埋める。単純に連結すると、省いた Chunk 1 つにつき後ろの話者区間が 30 秒ずつ前へずれ、別の人の発言にラベルが付く
* 話者分離はサーバーのプロセス内（`asyncio.to_thread`）で走らせる。STT のようなプロセスプールには入れない（1 会議 1 回で、ワーカーにモデルを持たせておく利点がない）。その代わり、メモリ不足で OS に止められるとサーバーごと落ちる。この場合も、lease 切れの回数上限（Phase 2 §14）で `failed` になり、話者分離なしで merge へ進む（落ち続けて会議が止まったままにはならない）
* mic と system は**別々に**ダイアライズし、ラベルに source 接頭辞を付けない代わりに `meeting_speakers` で `(label → 名前)` を利用者が割り当てる。mic 側は通常 1 話者（利用者本人）だが、会議室のマイクで複数人が話す場合もあるため固定しない
* ラベルは `S1..Sn`。名前は AI に推定させない（v4.0 §63、Invariant 9）
* 分離失敗（モデル未配置・OOM 上限到達・プロセスごと落ちる失敗の繰り返し）は `merge` を止めない。`speaker_id=NULL` のまま続行し、UI に「話者分離なし」を表示
* エコー（system の音声を mic が拾う）は、mic/system 間で時間重なり ≥ 0.5 かつ正規化テキスト類似度 ≥ 0.8 のとき mic 側を `merge_reason='echo_of:<system_id>'` で除外する。話者埋め込みの類似は使わない（Provider 依存を避ける。Phase 2 基本設計 §21 からの変更）

## 2.3 日英の言語認識

Phase 2 では `settings.language` が `ja` / `en` / `auto` で、`auto` は「最初の Chunk で判定し会議単位で固定」だった（Phase 2 基本設計 §10.2）。Phase 3 では次に拡張する。

| 候補 | 内容 | 採否 |
| --- | --- | --- |
| A. Chunk 単位判定 | Chunk ごとに `detect_language` を掛け、その言語で `transcribe` | **採用** |
| B. セグメント単位判定 | Whisper の出力後にテキストから言語を判定 | 補助として採用（Whisper は 1 回の `transcribe` で 1 言語を仮定するため、Chunk 内のコードスイッチは Chunk 主言語で認識される。これは Whisper の制約として明記し、セグメントの `language` 列には Chunk 判定結果を入れる） |
| C. 2 言語で 2 回 STT して良い方を採る | — | 不採用。処理時間が倍になり、選択基準（logprob）も言語間で比較可能でない |

確定事項：

* `LanguageDetector` 抽象（`detect(pcm) -> (language, probability)`）。faster-whisper の `detect_language` を使う実 Provider + Fake
* `settings.language == "auto"` のとき Chunk ごとに判定。確信度 < 0.6（設定値）なら会議の主言語（`meetings.language_ratio_json` の最大）にフォールバック、主言語未確定なら `ja`
* `meetings.language_ratio_json`：セグメントの `language` 列の時間加重比率 `{"ja": 0.7, "en": 0.3}`。STT 完了ごとに更新
* 要約の言語：主言語比率 ≥ 0.6 なら主言語で system prompt を選ぶ。混在（< 0.6）なら `settings.summary_language`（既定 `ja`）に従い、プロンプトに「他言語の発言は原文のまま引用する」注記を加える
* Merger の類似度は既に言語別（文字 / 単語）。エコー検出も同じ関数を使う
* 実測項目：短い Chunk（部分 Chunk）での判定精度、混在 Chunk の認識品質

## 2.4 FLAC 事後圧縮と高度な復旧

確定事項：

* ブラウザ側 WAV 生成は変えない。`compress_chunk` ジョブ（`priority=400`、最低優先）が `completed` から `compress_after_days`（既定 7 日）経過した会議の Chunk を FLAC 化する
* `AudioCodec` 抽象（`encode` / `decode`）。実 Provider は `soundfile`（libsndfile、extras）。Fake は「マジック + 無圧縮 PCM」の自前コンテナで、検証ロジック（復元一致・不一致時の保持）をテストする
* 圧縮の原子性：メモリ上で符号化 → 復元して `build_wav(pcm)` の sha256 が `audio_chunks.sha256`（WAV 値、不変）と一致することを確かめる → `write_atomic` で `.flac` を書く → `local_path` / `codec='flac'` / `sha256_flac` 更新 → WAV 削除。不一致は `.flac` を書かずに `INVALID_AUDIO`（non-retryable）。WAV は残る
* 圧縮と他の処理の競合：(a) 切り替えの更新は lease の現行の所有者だけが行い、Chunk の `local_path` / `sha256` が読んだ時のままであることも確かめる。STT の再実行（ジョブを行ごと消す）や再 PUT の修復（WAV に書き戻す）が先に起きていたら、WAV のまま残して作った `.flac` を消す。(b) 音声を読む側（VAD・STT・話者分離）は、読み取りに失敗したら Chunk の行を読み直し、パスが変わっていれば新しいパスから読む（`read_chunk_pcm()`）。読み直さないと、置き換わった直後の読み取りが「ファイルなし」になり、正常な Chunk を `missing` にしてしまう。(c) 更新のコミット後・WAV の削除前に落ちたら、やり直しのジョブが残った WAV を消す
* `read_pcm` は拡張子で分岐し、FLAC の場合も WAV sha256 で照合する（`sha256` 列の意味を変えない）
* バックアップ：`VACUUM INTO {dataDir}/backups/minutes-{epoch ms}.sqlite`。**直近のバックアップから 24 時間たっていたら作る**（起動時と 1 時間ごとに判定。基準はファイル名の時刻で、プロセスの起動からの経過ではない）。世代数 `backup_generations`（既定 7）。起動のたびに作ると、短時間に再起動を 7 回くり返しただけで古い世代がすべて押し出される。使うたびにサーバーを起動する使い方でも 1 日 1 世代になる。`completed` 遷移ごとのバックアップは行わない（DB 全体の複製なので会議 1 件ごとには重く、世代もその分早く回る。失われるのは最長 24 時間分の要約とノートで、録音と transcript は録音ファイルから作り直せる）
* バックアップは `.part` に書いてから名前を付け替える。書きかけ・失敗したファイルは正規の名前では残らず、復元元にも世代管理の対象にもならない
* 起動時 `PRAGMA integrity_check`。`ok` 以外なら、壊れたファイルを `minutes.sqlite.corrupt-{epoch}` に退避し、**検査に通る最も新しいバックアップ**を復元して開く（最新が壊れていれば 1 つ古いものへ下がる）。使えるバックアップが 1 つもなければ**空の DB で起動する**（起動を止めない。サーバーが動いていなければブラウザは Chunk を送れない）
* 復元の直後に、録音ファイルから DB にない会議と Chunk を作り直す（下の rebuild と同じ処理を `build_context` が自動で行う）。バックアップより後に録音した会議は DB にないが、ファイルは残っているためである。作り直した会議は transcript から処理し直す。バックアップより後の要約とノートは失われる。起動時に、復元元と作り直した件数を標準エラーに警告として出す（黙って古い状態に戻さない）
* `doctor --rebuild`：`recordings/` を走査し、`meeting.json`（finalize 時に書く。Phase 1 §13 の規約を Phase 3 で実装）と WAV/FLAC ヘッダから `meetings` / `audio_chunks` の欠損行を再構築する。既存行は上書きしない。**serve が動いているデータディレクトリには実行しない**（ロックが取れなければ終了コード 1。同じ Chunk の行を 2 つのプロセスが作り合う）
* 再構築した会議の状態：`meeting.json` に終了時刻（`endedAtEpochMs`）があれば `finalized`（確定済み。serve の起動時にジョブを作る）、作成時の控えのまま（終了時刻なし）なら **`recording`** に戻す。確定前の会議を `finalized` にすると、ブラウザが持っている未送信の Chunk の PUT を 409 で断ってしまう（Recording-First）。`recording` に戻せば、Phase 1 の Recovery が残りを送って確定する。`meeting.json` が読めない会議は `finalized` にする
* 逆同期：`GET /chunks` は `save_status='missing'` の Chunk を `registered=false` で返す（Phase 1 契約の `registered` フィールドの意味の範囲内）。ブラウザ側が IndexedDB の Blob から再 PUT する（client 文書 §6）

## 2.5 LAN 共有

確定事項：

* 既定は Phase 1〜2 と同じ `127.0.0.1` 単一利用者。`serve --bind 0.0.0.0 --tls` を明示したときだけ LAN モード。`--tls` なしの非 loopback bind は拒否する（トークンが平文で LAN を流れるため）
* TLS：`doctor --init-tls --host <hostname or IP>` で自己署名証明書（`cryptography`、extras `lan`）。ブラウザは初回に証明書の受け入れが必要（断定しない事項 §3）
* 認証：`users` テーブル（`id`, `name`, `token_hash`, `created_at`）。`minutes-local user add <name>` がトークンを 1 回だけ表示する（同名は拒否）。`user remove <id>` で失効させる（トークンを漏らした・利用者が抜けた。会議と録音は消さない）。`user list` で一覧。`users` が空なら従来の `token` ファイルで `local` ユーザーとして動作（後方互換）
* 単一利用者と複数利用者の切り替えは**起動時に決まる**（`AppContext.multi_user`）。最初の利用者を追加した後・最後の利用者を削除した後は、サーバーの再起動で反映する。複数利用者の間の追加・削除は再起動なしで効く（トークンは要求ごとに `users` を引く）。複数利用者に切り替えると `token` ファイルは使えなくなり、それまでに録音した会議（所有者 `local`）は誰からも見えなくなる（利用者を全員削除して単一利用者に戻すと見える）。既存の会議を特定の利用者へ引き継ぐ手段は本書の範囲外（§3）
* 認可：認証ミドルウェアが `/v1/meetings/{id}/...` と `/v1/jobs/{id}/...` の所有者を照合し、他人の会議は `404`（存在を漏らさない）。`GET /v1/meetings` は自分の会議のみ
* ファイル階層：`recordings/{userId}/{meetingId}/{source}/{seq}.wav`。マイグレーション 012 が既存の `recordings/{meetingId}/` を `recordings/local/{meetingId}/` へ移動し `local_path` を更新する。旧ディレクトリは新しい階層を作る前に `{dataDir}/.migrate-012/` へ退避してから統合する（会議 ID が `local` だと旧ディレクトリと新しい階層の親が重なるため）
* ジョブの公平性：`lease_job` を「利用者ごとの実行中ジョブ数が少ない利用者を優先」に変更（`ORDER BY running_per_user, priority, created_at`）。GPU は依然 1 台なので、同時実行数の上限は Phase 2 と同じ
* CSP と origin：**API origin はページ origin と同一とする**（前提契約）。サーバーが `/` でアプリ自身を配信するので `connect-src 'self'` で吸収され変更不要、同一 origin なので CORS 設定も不要。LAN モードとは「ページ自体を LAN の https origin から開く」ことであり、loopback から開いたページが別ホストの API を叩く構成ではない。**別オリジン配信は対象外**で、ブラウザ側 `validateConnection()` がページ origin 以外を `NOT_PAGE_ORIGIN` で拒否して実装レベルでも強制する（クライアント側 §7.3）。将来対象化する場合は CSP `connect-src` への対象 origin 追加と、`Authorization` ヘッダを伴う preflight に対応した CORS 設定の両方が必要になる
* インターネット公開・リバースプロキシ・OS ログイン連携は対象外

---

# 3. 断定してはいけない箇所と実測・監視で担保する箇所

| 事項 | 断定しない理由 | 担保 |
| --- | --- | --- |
| pyannote の話者数推定と精度、必要 VRAM | 会議の話者数・音質・重なり発話で大きく変わる。VRAM は 2〜4 GiB 程度が報告されるが環境依存 | `usage_metrics(diarize_duration_ms, diarize_speakers)` を記録。VRAM 予算は STT と同じ排他規則（Phase 2 §5.2）で `diarize_meeting` を STT 完了後にのみ lease |
| pyannote のモデルの配置と API（版による違い） | 配布形態・`config.yaml` の書式・Pipeline の戻り値は pyannote.audio の版で変わる。本書は pyannote 本体を実行していない | 本書が固定するのは Provider の外側の契約だけ（§12：`config.yaml` の場所、通信させない、連続した WAV を渡す、区間を絶対時刻で返す）。実物の配置手順と戻り値の形は Step 3-h で確かめ、§12 の表を実測で更新する |
| 話者分離の所要時間とメモリ（CPU） | 会議の長さに比例し、CPU では実時間に近い時間がかかりうる。全 Chunk の PCM をメモリに載せる（60 分で 1 source あたり約 115 MB、WAV 化でその倍） | 実行中は heartbeat が lease を延ばす（Phase 2 §13）。タイムアウトは設けない。プロセスごと落ちた場合は lease 切れの回数上限で `failed` → 話者分離なしで続行（§2.2） |
| 複数利用者への切り替え時の既存会議 | 所有者 `local` の会議をどの利用者に引き継ぐかは運用の判断 | 引き継ぎの手段は設けない。`user add` が切り替えの影響を表示する（§22） |
| Whisper の言語判定精度（短い Chunk・混在） | `detect_language` は先頭 30 秒の特徴量で判定し、確信度が低いことがある | 確信度をセグメントごとに `usage_metrics(language_prob)` に記録。< 0.6 のフォールバック率を監視 |
| Live STT が録音に影響しない | 同一マシンで STT が走ると CPU/GPU が競合する | ブラウザ側 `NO_AUDIO_FRAMES` 発生時に Live を自動停止（client 文書 §8）。`usage_metrics(live_lag_ms)` を記録 |
| FLAC ライブラリ（libsndfile）の可用性 | OS ごとに配布形態が異なる | extras 未導入なら `compress_chunk` を生成しない（`ctx.codec is None`） |
| 自己署名証明書のブラウザ受け入れ | ブラウザ・OS の証明書ストア設定に依存 | `doctor --init-tls` が受け入れが必要なことを表示する。受け入れ前は `/v1/health` に到達できないため `UNREACHABLE` として扱われる。`--host` には LAN の端末がアドレスバーに入れる名前か IP を渡す（省略時は `127.0.0.1` だけの証明書になり、LAN からは名前の不一致になる） |
| LAN 内の遅延・帯域 | Wi-Fi 品質に依存。1 Chunk 約 1 MB / 30 秒なので帯域は小さいが、遅延はある | ブラウザ側の `LocalSaver` タイムアウト（30 秒）で吸収。`BACKEND_UNAVAILABLE` の頻度を監視 |
| `VACUUM INTO` の所要時間 | DB サイズに比例 | `asyncio.to_thread` で実行し API をブロックしない。所要時間を `usage_metrics(backup_duration_ms)` に記録 |
| `INSERT ... SELECT *` によるテーブル再作成の列順一致 | 手作業のマイグレーションで列順がずれると壊れる | §23.1 のマイグレーションテストで Phase 2 DB からの適用を検証 |

---

# 4. SQLite マイグレーション 009〜012 `db/migrations_phase3.py`

Phase 2 の `db/migrate.py` は変更せず、Phase 3 のマイグレーションを別モジュールに置く。`bootstrap.build_context` が `migrate(db)` の直後に `apply_phase3(db, data_dir)` を呼ぶ。012 はファイル移動を伴うため Python で実装する。

```python
# minutes_local/db/migrations_phase3.py
"""Phase 3 のマイグレーション（009〜012）。Phase 2 の migrate.py は変更しない。"""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from .connection import Database, now_ms
from .migrate import _exec_multi, current_version

# 009: 会議・Chunk の列追加、話者テーブル
M009 = """
ALTER TABLE meetings ADD COLUMN language_ratio_json TEXT;
ALTER TABLE meetings ADD COLUMN live_stt_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN summary_language TEXT;
ALTER TABLE audio_chunks ADD COLUMN codec TEXT NOT NULL DEFAULT 'wav';
ALTER TABLE audio_chunks ADD COLUMN sha256_flac TEXT;
CREATE TABLE IF NOT EXISTS meeting_speakers (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  name       TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, label)
);
"""

# 010: processing_jobs の job_type CHECK 拡張（SQLite は CHECK を ALTER できないため再作成）
M010 = """
CREATE TABLE processing_jobs_new (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_id      TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
  job_type      TEXT NOT NULL
                  CHECK (job_type IN ('vad_chunk','transcribe_chunk','merge_transcript','synthesize_minutes',
                                      'live_transcribe_chunk','diarize_meeting','compress_chunk')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','leased','processing','retrying','completed','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 100,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  lease_until   INTEGER,
  lease_owner   TEXT,
  next_run_at   INTEGER NOT NULL DEFAULT 0,
  model_name    TEXT,
  error_class   TEXT
                  CHECK (error_class IS NULL OR error_class IN
                    ('OOM','MODEL_MISSING','INVALID_AUDIO','PROVIDER_UNREACHABLE',
                     'SCHEMA_VALIDATION','BUSINESS_VALIDATION','TIMEOUT','INTERNAL')),
  last_error    TEXT,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO processing_jobs_new SELECT * FROM processing_jobs;
DROP TABLE processing_jobs;
ALTER TABLE processing_jobs_new RENAME TO processing_jobs;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transcribe_job
  ON processing_jobs(meeting_id, chunk_id) WHERE job_type = 'transcribe_chunk';
CREATE UNIQUE INDEX IF NOT EXISTS uq_vad_job
  ON processing_jobs(meeting_id, chunk_id) WHERE job_type = 'vad_chunk';
CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_job
  ON processing_jobs(meeting_id) WHERE job_type = 'merge_transcript';
CREATE UNIQUE INDEX IF NOT EXISTS uq_summary_job
  ON processing_jobs(meeting_id) WHERE job_type = 'synthesize_minutes';
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_job
  ON processing_jobs(meeting_id, chunk_id) WHERE job_type = 'live_transcribe_chunk';
CREATE UNIQUE INDEX IF NOT EXISTS uq_diarize_job
  ON processing_jobs(meeting_id) WHERE job_type = 'diarize_meeting';
CREATE UNIQUE INDEX IF NOT EXISTS uq_compress_job
  ON processing_jobs(meeting_id, chunk_id) WHERE job_type = 'compress_chunk';
CREATE INDEX IF NOT EXISTS idx_jobs_runnable
  ON processing_jobs(status, next_run_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON processing_jobs(status, lease_until);
"""

# 011: 利用者
M011 = """
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(local_user_id, created_at);
"""

PHASE3_SQL: list[tuple[int, str]] = [(9, M009), (10, M010), (11, M011)]


MIGRATE_012_STAGING = ".migrate-012"


def _merge_tree(src: Path, dst: Path) -> None:
    """src の中身を dst へ移し、src を消す。dst に同じパスのファイルがあれば dst を残す。src は作業場所の中だけを渡す。"""
    for p in sorted(src.rglob("*")):
        if p.is_file():
            target = dst / p.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.move(str(p), str(target))
    shutil.rmtree(src)


def _migrate_012_move_recordings(conn: sqlite3.Connection, data_dir: Path) -> int:
    """recordings/{meetingId}/ → recordings/{userId}/{meetingId}/。local_path を書き換える。戻り値は書き換えた Chunk 数。

    旧ディレクトリは、新しい階層を作る前にすべて recordings/ の外の作業場所（{dataDir}/.migrate-012/）へ退避する。
    会議 ID は利用者 ID（既定 "local"）と同じ値を取りうる（SAFE_ID）。その場で移すと旧ディレクトリ recordings/local/ が
    新しい階層の親と重なり、旧ディレクトリの片付けが他の会議の録音ごと消す。
    途中で落ちたら apply_phase3 が 012 を記録しないので再実行される。退避を終えた印（.staged）があれば退避を飛ばし、
    新しい階層を旧ディレクトリと取り違えない。local_path の書き換えは 012 の記録と同じトランザクションで行い、
    作業場所（印を含む）は apply_phase3 が 012 の記録をコミットした後に片付ける。
    """
    staging = data_dir / MIGRATE_012_STAGING
    staged = staging / ".staged"
    recordings = data_dir / "recordings"
    meetings = conn.execute("SELECT id, local_user_id FROM meetings").fetchall()
    if not staged.exists():
        staging.mkdir(parents=True, exist_ok=True)
        for m in meetings:
            old_dir = recordings / m["id"]
            if old_dir.is_dir() and not (staging / m["id"]).exists():
                shutil.move(str(old_dir), str(staging / m["id"]))
        staged.touch()
    for m in meetings:
        src = staging / m["id"]
        if src.is_dir():
            _merge_tree(src, recordings / m["local_user_id"] / m["id"])
    rows = conn.execute(
        "SELECT c.id, c.local_path, m.local_user_id FROM audio_chunks c JOIN meetings m ON m.id = c.meeting_id "
        "WHERE c.local_path LIKE 'recordings/%'").fetchall()
    moved = 0
    for r in rows:
        parts = r["local_path"].split("/")
        if len(parts) != 4:  # recordings/{meetingId}/{source}/{file} 以外は移行の対象外
            continue
        new_rel = f"recordings/{r['local_user_id']}/{parts[1]}/{parts[2]}/{parts[3]}"
        conn.execute("UPDATE audio_chunks SET local_path = ? WHERE id = ?", (new_rel, r["id"]))
        moved += 1
    return moved


def apply_phase3(db: Database, data_dir: Path) -> int:
    """未適用の 009〜012 を順に適用する。戻り値は適用数。"""
    applied = 0
    for version, ddl in PHASE3_SQL:
        with db.write_sync() as conn:
            if current_version(conn) >= version:
                continue
            _exec_multi(conn, ddl)
            conn.execute("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)", (version, now_ms()))
            applied += 1
    with db.write_sync() as conn:
        if current_version(conn) < 12:
            _migrate_012_move_recordings(conn, data_dir)
            conn.execute("INSERT INTO schema_version(version, applied_at) VALUES (12, ?)", (now_ms(),))
            applied += 1
    # 012 の記録がコミットされてから片付ける。先に印を消すと、記録前に落ちた再実行が新しい階層を旧ディレクトリと取り違える
    staging = data_dir / MIGRATE_012_STAGING
    if staging.exists():
        (staging / ".staged").unlink(missing_ok=True)
        staging.rmdir()      # 統合で空になっている。残っていれば想定外なので OSError で止める
    return applied
```

010 で `foreign_keys = ON` のまま `DROP TABLE processing_jobs` を実行できるのは、`processing_jobs` が親テーブルではないためである。`INSERT ... SELECT *` は列順が Phase 2 §7 の DDL と同一であることに依存する（§3 の断定しない事項。§23.1 で検証）。

---

# 5. 設定 `config.py`（変更）

Phase 2 §5 に Phase 3 の設定値を追加した全文。

```python
# minutes_local/config.py
"""サーバー設定。既定値 → 環境変数 → settings テーブル の順で上書きする。Phase 3 で LAN / Live / 圧縮 / 言語の項目を追加。"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


def default_data_dir() -> Path:
    """OS 別の利用者データディレクトリ（Phase 1 §13）。クラウド同期対象になりやすい場所は避ける。"""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "minutes-local"
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) / "minutes-local" if base else Path.home() / "minutes-local"
    xdg = os.environ.get("XDG_DATA_HOME")
    return Path(xdg) / "minutes-local" if xdg else Path.home() / ".local" / "share" / "minutes-local"


@dataclass(frozen=True)
class Thresholds:
    """基本設計 §11〜§13 のしきい値。固定仕様ではなく設定値。"""
    vad_threshold: float = 0.5
    vad_min_speech_ms: int = 250
    vad_min_voiced_ms: int = 500
    overlap_ms: int = 3000
    merge_window_ms: int = 3500
    merge_time_overlap_ratio: float = 0.5
    merge_text_similarity: float = 0.8
    merge_containment_min_ratio: float = 0.3
    merge_containment_max_ratio: float = 0.95
    confidence_dim_below: float = 0.4
    stt_timeout_factor_gpu: int = 10
    stt_timeout_factor_cpu: int = 60
    llm_connect_timeout_s: float = 10.0
    llm_read_timeout_s: float = 600.0
    llm_ctx_fill_ratio: float = 0.6
    # Phase 3
    language_min_prob: float = 0.6          # これ未満は会議の主言語にフォールバック
    language_dominant_ratio: float = 0.6    # これ以上なら主言語で要約
    echo_time_overlap_ratio: float = 0.5
    echo_text_similarity: float = 0.8
    live_degraded_after_s: int = 90
    live_stopped_after_s: int = 300


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=default_data_dir)
    bind_host: str = "127.0.0.1"
    port: int = 43117
    ollama_base_url: str = "http://127.0.0.1:11434"
    language: str = "ja"              # "ja" | "en" | "auto"
    stt_model: str | None = None      # None = ハードウェア検出の推奨
    llm_model: str | None = None
    max_concurrent_stt: int | None = None
    live_stt_enabled: bool = False    # Phase 3 §2.1（gpu_small / cpu_only は bootstrap が既定 False を保つ）
    vad_sampling_ratio: float = 0.0   # §13.2 無音 Chunk のサンプリング STT（既定オフ）
    web_dir: Path | None = None       # ブラウザアプリのビルド出力（index.html を含む）。None なら配信しない（Phase 2 §21.1）
    # Phase 3
    summary_language: str = "ja"      # 混在会議の要約言語
    diarization_enabled: bool = True  # Provider があれば有効
    compress_after_days: int = 7
    backup_generations: int = 7
    tls_enabled: bool = False
    thresholds: Thresholds = field(default_factory=Thresholds)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "minutes.sqlite"

    @property
    def recordings_dir(self) -> Path:
        return self.data_dir / "recordings"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def token_path(self) -> Path:
        return self.data_dir / "token"

    @property
    def tmp_dir(self) -> Path:
        """処理中だけ使う一時ファイル（話者分離に渡す WAV）。serve が起動時に空にする（§22）。"""
        return self.data_dir / "tmp"

    @property
    def tls_cert_path(self) -> Path:
        return self.data_dir / "tls" / "cert.pem"

    @property
    def tls_key_path(self) -> Path:
        return self.data_dir / "tls" / "key.pem"

    def with_overrides(self, values: dict[str, Any]) -> "Settings":
        """settings テーブルの値で上書きする。未知キーは無視し、型が合わないものは捨てる。"""
        allowed = {
            "language": str, "stt_model": (str, type(None)), "llm_model": (str, type(None)),
            "max_concurrent_stt": (int, type(None)), "live_stt_enabled": bool,
            "vad_sampling_ratio": float, "ollama_base_url": str,
            "summary_language": str, "diarization_enabled": bool, "compress_after_days": int, "backup_generations": int,
        }
        kwargs: dict[str, Any] = {}
        for key, expected in allowed.items():
            if key in values and isinstance(values[key], expected) and not (expected is float and isinstance(values[key], bool)):
                kwargs[key] = values[key]
        return replace(self, **kwargs)


def settings_from_env(base: Settings | None = None) -> Settings:
    s = base or Settings()
    data_dir = os.environ.get("MINUTES_DATA_DIR")
    port = os.environ.get("MINUTES_PORT")
    kwargs: dict[str, Any] = {}
    if data_dir:
        kwargs["data_dir"] = Path(data_dir)
    if port and port.isdigit():
        kwargs["port"] = int(port)
    web_dir = os.environ.get("MINUTES_WEB_DIR")
    if web_dir:
        kwargs["web_dir"] = Path(web_dir)
    return replace(s, **kwargs)
```

---

# 6. モデル `db/models.py`（変更）と `db/repo_phase3.py`（新規）

```python
# minutes_local/db/models.py
"""SQLite 行に対応する pydantic モデル。Phase 3 でジョブ種別・列・テーブルを追加。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Source = Literal["mic", "system"]
MeetingStatus = Literal[
    "created", "recording", "finalizing", "finalized",
    "transcribing", "transcribed", "summarizing", "completed", "failed",
]
SttStatus = Literal["pending", "queued", "processing", "completed", "skipped", "failed"]
JobType = Literal[
    "vad_chunk", "transcribe_chunk", "merge_transcript", "synthesize_minutes",
    "live_transcribe_chunk", "diarize_meeting", "compress_chunk",
]
JobStatus = Literal["pending", "leased", "processing", "retrying", "completed", "failed", "cancelled"]
ErrorClass = Literal[
    "OOM", "MODEL_MISSING", "INVALID_AUDIO", "PROVIDER_UNREACHABLE",
    "SCHEMA_VALIDATION", "BUSINESS_VALIDATION", "TIMEOUT", "INTERNAL",
]
Codec = Literal["wav", "flac", "fake"]
LiveState = Literal["DISABLED", "STARTING", "RUNNING", "DEGRADED", "STOPPED"]

JOB_PRIORITY: dict[str, int] = {
    "vad_chunk": 50, "live_transcribe_chunk": 80, "transcribe_chunk": 100, "diarize_meeting": 150,
    "merge_transcript": 200, "synthesize_minutes": 300, "compress_chunk": 400,
}


class Meeting(BaseModel):
    id: str
    local_user_id: str = "local"
    title: str
    status: MeetingStatus
    session_start_epoch_ms: int
    native_sample_rate: int
    consent_confirmed_at: int
    ended_at: int | None = None
    total_audio_frames: int | None = None
    stop_reason: Literal["manual", "mic_ended"] | None = None
    stop_detected_at: int | None = None
    transcript_version: int = 0
    stt_model_used: str | None = None
    llm_model_used: str | None = None
    created_at: int
    updated_at: int
    # Phase 3
    language_ratio_json: str | None = None
    live_stt_enabled: bool = False
    summary_language: str | None = None


class AudioChunk(BaseModel):
    id: str
    meeting_id: str
    source: Source
    sequence_no: int
    start_offset_ms: int
    end_offset_ms: int
    duration_ms: int
    sample_count: int
    local_path: str
    size_bytes: int
    sha256: str
    vad_score: float = 0.0
    has_voice: bool = True
    vad_source: Literal["browser_rms", "server_silero"] = "browser_rms"
    server_vad_score: float | None = None
    save_status: Literal["registered", "verified", "missing"] = "registered"
    stt_status: SttStatus = "pending"
    created_at: int
    # Phase 3
    codec: Codec = "wav"
    sha256_flac: str | None = None


class Job(BaseModel):
    id: str
    meeting_id: str
    chunk_id: str | None
    job_type: JobType
    status: JobStatus
    priority: int
    attempts: int
    max_attempts: int
    lease_until: int | None = None
    lease_owner: str | None = None
    next_run_at: int = 0
    model_name: str | None = None
    error_class: ErrorClass | None = None
    last_error: str | None = None
    duration_ms: int | None = None
    created_at: int
    updated_at: int


class Segment(BaseModel):
    id: str
    meeting_id: str
    chunk_id: str
    source: Source
    segment_index: int
    start_ms: int
    end_ms: int
    text: str
    normalized_text: str | None = None
    language: str | None = None
    confidence: float | None = None
    no_speech_prob: float | None = None
    merged_version: int | None = None
    merge_reason: str | None = None
    speaker_id: str | None = None
    speaker_confidence: float | None = None
    created_at: int


class SummaryVersion(BaseModel):
    id: str
    meeting_id: str
    version: int
    transcript_version: int
    model_name: str
    prompt_version: str
    result_json: str
    raw_response_json: str | None = None
    validation_json: str
    generated_at: int


class Notes(BaseModel):
    meeting_id: str
    blocknote_json: str
    revision: int
    last_applied_summary_version: int | None = None
    updated_at: int


class Speaker(BaseModel):
    meeting_id: str
    label: str
    name: str | None = None
    updated_at: int


class User(BaseModel):
    id: str
    name: str
    token_hash: str
    created_at: int
```

```python
# minutes_local/db/repo_phase3.py
"""Phase 3 で追加するクエリ。Phase 2 の repo.py は変更しない。"""
from __future__ import annotations

import json
import sqlite3

from .connection import now_ms
from .models import Job, Meeting, Segment, Speaker
from .repo import _row


# ---- 利用者スコープ ----

def list_meetings_for_user(conn: sqlite3.Connection, user_id: str) -> list[Meeting]:
    rows = conn.execute("SELECT * FROM meetings WHERE local_user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
    return [_row(Meeting, r) for r in rows]


def meeting_owner(conn: sqlite3.Connection, meeting_id: str) -> str | None:
    row = conn.execute("SELECT local_user_id FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    return None if row is None else str(row["local_user_id"])


def job_owner(conn: sqlite3.Connection, job_id: str) -> str | None:
    row = conn.execute(
        "SELECT m.local_user_id AS u FROM processing_jobs j JOIN meetings m ON m.id = j.meeting_id WHERE j.id = ?", (job_id,)
    ).fetchone()
    return None if row is None else str(row["u"])


# ---- 公平 lease（§2.5） ----

def lease_job_fair(conn: sqlite3.Connection, owner: str, allowed_types: list[str], now: int,
                   lease_ms: int = 300_000) -> Job | None:
    """利用者ごとの実行中ジョブ数が少ない利用者を優先する。単一利用者では Phase 2 の lease_job と同じ順序になる。"""
    if not allowed_types:
        return None
    ph = ",".join("?" for _ in allowed_types)
    row = conn.execute(
        f"""UPDATE processing_jobs
            SET status = 'leased', lease_until = ?, lease_owner = ?, attempts = attempts + 1, updated_at = ?
            WHERE id = (
              SELECT j.id FROM processing_jobs j
              JOIN meetings m ON m.id = j.meeting_id
              LEFT JOIN (
                SELECT m2.local_user_id AS uid, COUNT(*) AS running
                FROM processing_jobs j2 JOIN meetings m2 ON m2.id = j2.meeting_id
                WHERE j2.status IN ('leased','processing') GROUP BY m2.local_user_id
              ) r ON r.uid = m.local_user_id
              WHERE j.status IN ('pending','retrying') AND j.next_run_at <= ? AND j.job_type IN ({ph})
              ORDER BY COALESCE(r.running, 0) ASC, j.priority ASC, j.created_at ASC LIMIT 1
            )
            RETURNING *""",
        (now + lease_ms, owner, now, now, *allowed_types),
    ).fetchone()
    return _row(Job, row)


# ---- 話者 ----

def list_speakers(conn: sqlite3.Connection, meeting_id: str) -> list[Speaker]:
    rows = conn.execute("SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY label", (meeting_id,)).fetchall()
    return [_row(Speaker, r) for r in rows]


def upsert_speaker(conn: sqlite3.Connection, meeting_id: str, label: str, name: str | None) -> None:
    conn.execute(
        "INSERT INTO meeting_speakers (meeting_id, label, name, updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(meeting_id, label) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
        (meeting_id, label, name, now_ms()),
    )


def set_segment_speaker(conn: sqlite3.Connection, segment_id: str, label: str | None, confidence: float | None) -> None:
    conn.execute("UPDATE transcript_segments SET speaker_id = ?, speaker_confidence = ? WHERE id = ?", (label, confidence, segment_id))


# ---- 言語 ----

def language_ratio(conn: sqlite3.Connection, meeting_id: str) -> dict[str, float]:
    """セグメントの時間加重比率。"""
    rows = conn.execute(
        "SELECT language, SUM(end_ms - start_ms) AS d FROM transcript_segments WHERE meeting_id = ? AND language IS NOT NULL GROUP BY language",
        (meeting_id,),
    ).fetchall()
    total = sum(float(r["d"]) for r in rows)
    if total <= 0:
        return {}
    return {str(r["language"]): round(float(r["d"]) / total, 4) for r in rows}


def save_language_ratio(conn: sqlite3.Connection, meeting_id: str, ratio: dict[str, float]) -> None:
    conn.execute("UPDATE meetings SET language_ratio_json = ?, updated_at = ? WHERE id = ?", (json.dumps(ratio), now_ms(), meeting_id))


def primary_language(ratio: dict[str, float]) -> tuple[str | None, float]:
    if not ratio:
        return None, 0.0
    lang = max(ratio, key=lambda k: ratio[k])
    return lang, ratio[lang]


# ---- Live ----

def segments_of_chunk(conn: sqlite3.Connection, chunk_id: str) -> list[Segment]:
    rows = conn.execute("SELECT * FROM transcript_segments WHERE chunk_id = ? ORDER BY segment_index", (chunk_id,)).fetchall()
    return [_row(Segment, r) for r in rows]


def live_segments_since(conn: sqlite3.Connection, meeting_id: str, since_created_at: int) -> list[Segment]:
    """since_created_at を**含む**境界で返す（クライアント側 §2.1・§3.2）。

    created_at は epoch ms で一意でも単調増加でもない。handle_live_transcribe は 1 チャンク分の
    セグメントを同じ now_ms() の値で書き込むため、同一ミリ秒に複数行が並ぶのは常態である。
    排他境界（created_at > ?）にすると、cursor と同じミリ秒に後から挿入された行が次回以降の
    検索条件から永久に外れる。境界ミリ秒の再送は受信側が id で重複排除する契約になっている。
    並びは (created_at, id) で決める。start_ms は一意でなく、同点時の順序が安定しない。
    """
    rows = conn.execute(
        "SELECT * FROM transcript_segments WHERE meeting_id = ? AND created_at >= ? ORDER BY created_at, id",
        (meeting_id, since_created_at),
    ).fetchall()
    return [_row(Segment, r) for r in rows]


def oldest_open_job_age_ms(conn: sqlite3.Connection, meeting_id: str, job_type: str, now: int) -> int | None:
    row = conn.execute(
        "SELECT MIN(created_at) AS c FROM processing_jobs WHERE meeting_id = ? AND job_type = ? AND status IN ('pending','leased','processing','retrying')",
        (meeting_id, job_type),
    ).fetchone()
    if row is None or row["c"] is None:
        return None
    return now - int(row["c"])


# ---- 圧縮 ----

def chunks_to_compress(conn: sqlite3.Connection, completed_before: int) -> list[tuple[str, str]]:
    """(meeting_id, chunk_id)。completed かつ ended_at が閾値より前で codec='wav' の Chunk。"""
    rows = conn.execute(
        """SELECT c.meeting_id AS m, c.id AS c FROM audio_chunks c JOIN meetings mt ON mt.id = c.meeting_id
           WHERE mt.status = 'completed' AND mt.ended_at IS NOT NULL AND mt.ended_at < ? AND c.codec = 'wav' AND c.save_status != 'missing'""",
        (completed_before,),
    ).fetchall()
    return [(str(r["m"]), str(r["c"])) for r in rows]
```

---

# 7. 実行コンテキスト `jobs/context.py`（変更）

Phase 3 の Provider（話者分離・言語判定・コーデック）と LAN モードのフラグを追加した全文。

```python
# minutes_local/jobs/context.py
"""ジョブハンドラと API が共有する依存。Phase 3 で diarization / language / codec / 利用者モードを追加。"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..config import Settings
from ..db.connection import Database
from ..diarization.provider import DiarizationProvider
from ..hw.detect import Hardware
from ..hw.tiers import SttCandidate, Tier
from ..llm.provider import SummaryProvider
from ..storage.backup import Recovery
from ..storage.codec import AudioCodec
from ..stt.executor import STTExecutor
from ..stt.language import LanguageDetector
from ..storage.models_dir import ModelDownloads
from ..vad.provider import VADProvider
from .events import EventBroker


@dataclass
class ModelSelection:
    tier: Tier
    stt: SttCandidate | None
    llm: str | None
    installed_stt: set[str]
    available_llm: list[str]
    ollama_reachable: bool
    max_concurrent_stt: int
    allow_concurrent_stt_and_llm: bool


@dataclass
class AppContext:
    settings: Settings
    db: Database
    hardware: Hardware
    models: ModelSelection
    stt: STTExecutor
    vad: VADProvider | None
    llm: SummaryProvider
    events: EventBroker = field(default_factory=lambda: EventBroker())
    downloads: ModelDownloads = field(default_factory=lambda: ModelDownloads())   # モデル取得の状態（§10.2）
    server_version: str = "0.3.0"
    # Phase 3
    diarization: DiarizationProvider | None = None
    language: LanguageDetector | None = None
    codec: AudioCodec | None = None
    multi_user: bool = False       # users テーブルが空でなければ True（起動時に決める。切り替えは再起動で反映。§2.5）
    tls_enabled: bool = False
    recovery: Recovery | None = None   # 起動時に壊れた DB を作り直したときの記録（§2.4）。正常な起動では None

    @property
    def diarization_active(self) -> bool:
        return self.diarization is not None and self.settings.diarization_enabled
```

---

# 8. ジョブ生成規則 `jobs/pipeline.py`（変更）

依存関係を `transcribe 完了 → diarize（任意）→ merge → summary` に変える。`ensure_merge_job` は `diarize` フラグを必須引数に取り、話者分離が有効なら `diarize_meeting` を先に生成する。

```mermaid
flowchart LR
    F[POST /finalize] --> V[vad_chunk × N]
    V --> T[transcribe_chunk × N]
    T -->|全 chunk 終端| D{diarization_active?}
    D -->|yes| DI[diarize_meeting]
    D -->|no| M[merge_transcript]
    DI -->|completed / failed| M
    M --> S[synthesize_minutes]
    S --> C[completed]
    C -.->|N 日後・日次| CP[compress_chunk × N]
    L[PUT chunk 中 live_stt_enabled] -.-> LT[live_transcribe_chunk]
    LT -.->|segments 再利用| T
```

```python
# minutes_local/jobs/pipeline.py
"""ジョブ生成規則。Phase 3 で diarize と live を追加。"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from ..db import repo
from ..db.models import AudioChunk, Job
from ..storage.files import sha256_file

BLOCKING_STT = ("pending", "queued", "processing")


def chunk_file_intact(data_dir: Path, chunk: AudioChunk) -> bool:
    """登録済み Chunk のファイルが存在し、WAV なら sha256 が登録時と一致するか（圧縮済みは存在だけを見る）。
    finalize と起動時の回収（Phase 2 の sweeper.resume_finalized）が同じ規則で照合する。"""
    path = data_dir / chunk.local_path
    # ファイルシステムのエラーは「欠損」として False（起動時の回収で起動ごと止めず、finalize を 500 にしない。Phase 2 §12）
    try:
        return path.is_file() and (chunk.codec != "wav" or sha256_file(path) == chunk.sha256)
    except OSError:
        return False


def on_finalized(conn: sqlite3.Connection, meeting_id: str, diarize: bool = False) -> int:
    """全 Chunk に vad_chunk を生成し、meeting を transcribing にする。戻り値は新規ジョブ数。"""
    created = 0
    for chunk in repo.list_chunks(conn, meeting_id):
        if repo.insert_job(conn, meeting_id, "vad_chunk", chunk_id=chunk.id) is not None:
            created += 1
    repo.set_meeting_status(conn, meeting_id, "transcribing")
    if created == 0:
        # Chunk が 1 件もない会議（開始直後の停止など。Phase 1 のクライアントは 0 件でも確定する）は、
        # 完了を契機に merge を起こす vad ジョブがない。ここで判定しないと transcribing のまま止まる
        ensure_merge_job(conn, meeting_id, diarize)
    return created


def on_vad_completed(conn: sqlite3.Connection, chunk: AudioChunk, has_voice: bool, model_name: str | None, diarize: bool) -> None:
    if has_voice:
        repo.update_chunk(conn, chunk.id, stt_status="queued")
        repo.insert_job(conn, chunk.meeting_id, "transcribe_chunk", chunk_id=chunk.id, model_name=model_name)
    else:
        repo.update_chunk(conn, chunk.id, stt_status="skipped")
    ensure_merge_job(conn, chunk.meeting_id, diarize)


def on_transcribe_completed(conn: sqlite3.Connection, chunk: AudioChunk, diarize: bool) -> None:
    repo.update_chunk(conn, chunk.id, stt_status="completed")
    ensure_merge_job(conn, chunk.meeting_id, diarize)


def on_transcribe_failed(conn: sqlite3.Connection, chunk: AudioChunk) -> None:
    """failed は merge をブロックする。利用者が retry か exclude_failed を選ぶまで待つ（v4.0 §97〜§98）。"""
    repo.update_chunk(conn, chunk.id, stt_status="failed")


def on_job_failed(conn: sqlite3.Connection, job: Job) -> None:
    """ジョブが failed で確定した後の後続処理。Runner（ハンドラの失敗）と Sweeper（lease 切れで回数切れ）が同じ規則を使う。"""
    if job.job_type == "transcribe_chunk":
        on_transcribe_failed(conn, job_of_chunk(conn, job))
    elif job.job_type == "synthesize_minutes":
        on_summary_failed(conn, job.meeting_id)
    elif job.job_type == "diarize_meeting":
        # 話者分離の失敗は transcript を止めない（§2.2）
        on_diarize_finished(conn, job.meeting_id)
    # live_transcribe_chunk / compress_chunk の失敗は後続に影響しない


def _all_chunks_terminal(conn: sqlite3.Connection, meeting_id: str) -> bool:
    counts = repo.count_chunks_by_stt(conn, meeting_id)
    if any(counts[s] > 0 for s in BLOCKING_STT):
        return False
    if repo.count_jobs(conn, meeting_id, "vad_chunk", ["pending", "leased", "processing", "retrying"]) > 0:
        return False
    # 未承認の failed transcribe ジョブがあれば待つ
    if repo.count_jobs(conn, meeting_id, "transcribe_chunk", ["failed"]) > 0:
        return False
    return True


def ensure_merge_job(conn: sqlite3.Connection, meeting_id: str, diarize: bool) -> bool:
    """全 Chunk が終端なら、話者分離が有効なら diarize_meeting、無効なら merge_transcript を生成する。"""
    if not _all_chunks_terminal(conn, meeting_id):
        return False
    if diarize:
        # diarize が既に終端（completed/failed/cancelled）なら merge へ
        if repo.count_jobs(conn, meeting_id, "diarize_meeting", ["completed", "failed", "cancelled"]) > 0:
            return repo.insert_job(conn, meeting_id, "merge_transcript") is not None
        return repo.insert_job(conn, meeting_id, "diarize_meeting") is not None
    return repo.insert_job(conn, meeting_id, "merge_transcript") is not None


def on_diarize_finished(conn: sqlite3.Connection, meeting_id: str) -> None:
    """成功・失敗いずれでも merge へ進む（分離失敗は transcript を止めない）。"""
    repo.insert_job(conn, meeting_id, "merge_transcript")


def exclude_failed(conn: sqlite3.Connection, meeting_id: str, diarize: bool = False) -> int:
    rows = conn.execute(
        "SELECT id FROM processing_jobs WHERE meeting_id = ? AND job_type = 'transcribe_chunk' AND status = 'failed'",
        (meeting_id,),
    ).fetchall()
    for r in rows:
        conn.execute("UPDATE processing_jobs SET status = 'cancelled' WHERE id = ?", (r["id"],))
    ensure_merge_job(conn, meeting_id, diarize)
    return len(rows)


def on_merge_completed(conn: sqlite3.Connection, meeting_id: str) -> None:
    """基本設計 §12.1：transcribed にし、summary ジョブを生成（INSERT OR IGNORE）。"""
    repo.set_meeting_status(conn, meeting_id, "transcribed")
    repo.insert_job(conn, meeting_id, "synthesize_minutes")


def on_summary_started(conn: sqlite3.Connection, meeting_id: str) -> None:
    repo.set_meeting_status(conn, meeting_id, "summarizing")


def on_summary_completed(conn: sqlite3.Connection, meeting_id: str) -> None:
    repo.set_meeting_status(conn, meeting_id, "completed")


def on_summary_deferred(conn: sqlite3.Connection, meeting_id: str) -> None:
    """要約が retrying に戻った：transcribed に戻し、transcript の閲覧を妨げない。"""
    repo.set_meeting_status(conn, meeting_id, "transcribed")


def on_summary_failed(conn: sqlite3.Connection, meeting_id: str) -> None:
    """transcript は残る（Invariant 2）。meeting は failed だが transcribed 版の閲覧は可能。"""
    repo.set_meeting_status(conn, meeting_id, "failed")


def request_regenerate_summary(conn: sqlite3.Connection, meeting_id: str) -> None:
    repo.reset_job_for_rerun(conn, meeting_id, "synthesize_minutes")
    repo.insert_job(conn, meeting_id, "synthesize_minutes")


def request_rerun_stt(conn: sqlite3.Connection, meeting_id: str, stt_model: str | None) -> int:
    """STT 再実行：segments を消し、chunk を pending に戻し、vad からやり直す（基本設計 §10.5）。"""
    # ジョブは行ごと消す。実行中のハンドラは lease の検査（行がない）で結果を書けなくなる（§8 lease_is_current）
    conn.execute("DELETE FROM processing_jobs WHERE meeting_id = ?", (meeting_id,))
    for chunk in repo.list_chunks(conn, meeting_id):
        repo.delete_segments_of_chunk(conn, chunk.id)
        repo.update_chunk(conn, chunk.id, stt_status="pending")
    conn.execute("DELETE FROM meeting_speakers WHERE meeting_id = ?", (meeting_id,))
    repo.update_meeting(conn, meeting_id, stt_model_used=stt_model, status="transcribing", language_ratio_json=None)
    return on_finalized(conn, meeting_id)


def job_of_chunk(conn: sqlite3.Connection, job: Job) -> AudioChunk:
    if job.chunk_id is None:
        raise ValueError(f"job {job.id} has no chunk")
    chunk = repo.get_chunk(conn, job.chunk_id)
    if chunk is None:
        raise ValueError(f"chunk {job.chunk_id} not found")
    return chunk
```

---

# 9. Runner `jobs/runner.py`（変更）

変更点：(1) 公平 lease（`repo_phase3.lease_job_fair`）、(2) `allowed_types` に Phase 3 のジョブ種別、(3) `diarize_meeting` は STT と同じ GPU 排他規則、(4) `diarize_meeting` の失敗時に merge へ進む、(5) 完了後フックが `diarize` フラグを渡す。

```python
# minutes_local/jobs/runner.py
"""lease 取得 → ハンドラ実行 → 完了/retry/failed の記録。Phase 3 で公平 lease と新ジョブ種別に対応。"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable

from ..db import repo, repo_phase3
from ..db.connection import now_ms
from ..db.models import Job
from . import pipeline
from .context import AppContext
from .retry import JobError, RetryDecision, decide, normalize_exception

log = logging.getLogger(__name__)

Handler = Callable[[AppContext, Job], Awaitable[str | None]]
"""ハンドラは成功時に None（または使用モデル名）を返し、失敗時に JobError を送出する。"""

HEARTBEAT_INTERVAL_S = 60.0
LEASE_MS = 300_000
GPU_HEAVY = ("transcribe_chunk", "live_transcribe_chunk", "diarize_meeting")


class JobRunner:
    def __init__(self, ctx: AppContext, handlers: dict[str, Handler], worker_index: int = 0) -> None:
        self.ctx = ctx
        self.handlers = handlers
        self.owner = f"{os.getpid()}:{worker_index}"
        self._stop = asyncio.Event()

    # ---- 排他規則（基本設計 §5.2） ----

    def allowed_types(self) -> list[str]:
        types = ["vad_chunk", "live_transcribe_chunk", "transcribe_chunk", "merge_transcript", "compress_chunk"]
        with self.ctx.db.read() as conn:
            stt_running = sum(repo.count_jobs(conn, None, t, ["leased", "processing"]) for t in ("transcribe_chunk", "live_transcribe_chunk"))
            diarize_running = repo.count_jobs(conn, None, "diarize_meeting", ["leased", "processing"])
        # diarize は STT 実行中には lease しない（GPU 排他）。STT は diarize 実行中でも動く（diarize は 1 会議 1 ジョブで短い）
        if stt_running == 0:
            types.append("diarize_meeting")
        if (stt_running == 0 and diarize_running == 0) or self.ctx.models.allow_concurrent_stt_and_llm:
            types.append("synthesize_minutes")
        return types

    # ---- 1 件実行 ----

    async def run_once(self) -> bool:
        """1 件 lease して実行する。実行したら True、対象なしなら False。"""
        now = now_ms()
        async with self.ctx.db.write() as conn:
            job = repo_phase3.lease_job_fair(conn, self.owner, self.allowed_types(), now, LEASE_MS)
        if job is None:
            return False
        await self._execute(job)
        return True

    async def run_until_idle(self, max_jobs: int = 10_000) -> int:
        """テストと finalize 直後の同期実行用。対象がなくなるまで回す。"""
        n = 0
        while n < max_jobs and await self.run_once():
            n += 1
        return n

    async def run_forever(self, idle_sleep_s: float = 1.0) -> None:
        while not self._stop.is_set():
            try:
                ran = await self.run_once()
            except Exception:  # noqa: BLE001
                # ハンドラの例外は _execute が JobError にして記録する。ここへ来るのは lease や結果の記録そのものの失敗
                # （DB のロック・ディスク満杯）。ループを終わらせると、サーバーは Chunk を受け取り続けるのに以後のジョブが
                # 1 件も動かない。lease したままのジョブは Sweeper が期限切れで回収する
                log.exception("job runner iteration failed; retrying")
                ran = False
            if not ran:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=idle_sleep_s)
                except asyncio.TimeoutError:
                    pass

    def stop(self) -> None:
        self._stop.set()

    # ---- 内部 ----

    async def _execute(self, job: Job) -> None:
        handler = self.handlers.get(job.job_type)
        if handler is None:
            async with self.ctx.db.write() as conn:
                repo.finish_job(conn, job.id, self.owner, job.attempts, "failed", error_class="INTERNAL",
                                last_error=f"no handler for {job.job_type}")
            return

        async with self.ctx.db.write() as conn:
            if not repo.mark_processing(conn, job.id, self.owner, job.model_name):
                return  # Sweeper に回収済み
            if job.job_type == "synthesize_minutes":
                pipeline.on_summary_started(conn, job.meeting_id)
        self._publish_job(job.id)

        hb = asyncio.create_task(self._heartbeat(job.id))
        started = time.monotonic()
        try:
            model_used = await handler(self.ctx, job)
        except BaseException as exc:  # noqa: BLE001 - JobError に正規化して記録する
            hb.cancel()
            if isinstance(exc, asyncio.CancelledError):
                raise
            await self._on_failure(job, normalize_exception(exc), int((time.monotonic() - started) * 1000))
            return
        hb.cancel()
        duration = int((time.monotonic() - started) * 1000)
        async with self.ctx.db.write() as conn:
            ok = repo.finish_job(conn, job.id, self.owner, job.attempts, "completed", duration_ms=duration)
            if ok and model_used is not None:
                conn.execute("UPDATE processing_jobs SET model_name = ? WHERE id = ?", (model_used, job.id))
            if ok and job.job_type in ("vad_chunk", "transcribe_chunk"):
                # 自分自身が processing のままではハンドラ内の ensure_merge_job が成立しないため、完了確定後に再判定する
                pipeline.ensure_merge_job(conn, job.meeting_id, self.ctx.diarization_active)
            if ok and job.job_type == "diarize_meeting":
                pipeline.on_diarize_finished(conn, job.meeting_id)
        self._publish_job(job.id)

    async def _on_failure(self, job: Job, err: JobError, duration_ms: int) -> None:
        now = now_ms()
        d = decide(err, job.attempts, job.max_attempts, now)
        if job.job_type == "diarize_meeting" and not err.counts_attempt:
            # モデル未配置等の無期限 retry では待たず failed にし、merge へ進める（§2.2）
            d = RetryDecision("failed", None, True)
        async with self.ctx.db.write() as conn:
            ok = repo.finish_job(conn, job.id, self.owner, job.attempts, d.next_status, error_class=err.error_class,
                                 last_error=err.message[:2000], next_run_at=d.next_run_at, duration_ms=duration_ms)
            if not ok:
                return  # 旧ワーカーの報告は無視（基本設計 §9.3）
            if not d.consume_attempt:
                conn.execute("UPDATE processing_jobs SET attempts = attempts - 1 WHERE id = ?", (job.id,))
            if err.error_class == "OOM" and job.job_type in GPU_HEAVY and job.job_type != "diarize_meeting":
                self._downgrade_stt(conn, job.meeting_id, job.model_name)
            if d.next_status == "failed":
                pipeline.on_job_failed(conn, job)
            elif job.job_type == "synthesize_minutes":
                # Ollama 未起動等で待機に戻る：transcript は閲覧可能な transcribed に戻す（基本設計 §26.4）
                pipeline.on_summary_deferred(conn, job.meeting_id)
            repo.record_metric(conn, f"job_error_{err.error_class.lower()}", 1, meeting_id=job.meeting_id)
        self._publish_job(job.id)

    def _downgrade_stt(self, conn, meeting_id: str, ran_with: str | None) -> None:  # type: ignore[no-untyped-def]
        """会議単位でモデルを 1 段落とす（基本設計 §7.3）。ran_with は失敗したジョブが使ったモデル（lease 時点の model_name）。

        落とすのは「モデル 1 つにつき 1 段」。同じモデルで並行して走っていた 2 件がどちらも OOM になっても、
        2 件目は既に落とした後なので何もしない（失敗 1 件につき 1 段にすると small → tiny まで落ちる）。
        落とす先は配置済みのモデルに限る（未配置の段を選ぶと MODEL_MISSING で待ち続ける）。
        """
        from ..hw.tiers import downgrade_stt
        m = repo.get_meeting(conn, meeting_id)
        current = (m.stt_model_used if m and m.stt_model_used else (self.ctx.models.stt.name if self.ctx.models.stt else None))
        if current is None:
            return
        if ran_with is not None and ran_with != current:
            return
        nxt = downgrade_stt(current)
        while nxt is not None and nxt not in self.ctx.models.installed_stt:
            nxt = downgrade_stt(nxt)
        if nxt is None:
            return
        repo.update_meeting(conn, meeting_id, stt_model_used=nxt)
        conn.execute(
            "UPDATE processing_jobs SET model_name = ? WHERE meeting_id = ? AND job_type IN ('transcribe_chunk','live_transcribe_chunk') AND status IN ('pending','retrying')",
            (nxt, meeting_id),
        )
        repo.record_metric(conn, "stt_downgrade", 1, model_name=nxt, meeting_id=meeting_id)

    async def _heartbeat(self, job_id: str) -> None:
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL_S)
                async with self.ctx.db.write() as conn:
                    repo.heartbeat_job(conn, job_id, self.owner, now_ms(), LEASE_MS)
        except asyncio.CancelledError:
            return

    def _publish_job(self, job_id: str) -> None:
        with self.ctx.db.read() as conn:
            job = repo.get_job(conn, job_id)
            meeting = repo.get_meeting(conn, job.meeting_id) if job else None
        if job is None:
            return
        self.ctx.events.publish(job.meeting_id, {"type": "job", "job": job.model_dump()})
        if meeting is not None:
            self.ctx.events.publish(job.meeting_id, {"type": "meeting_status", "status": meeting.status})
```

`diarize_meeting` が `MODEL_MISSING` / `PROVIDER_UNREACHABLE` で無期限 retry になる場合、Phase 2 の規則では 5 分ごとに待ち続け、その間 merge も summary も進まない。話者分離はプレビュー性の機能なので、`_on_failure` の冒頭で `RetryDecision("failed")` に置き換え、merge へ進める（§2.2「分離失敗は merge を止めない」の具体化）。

---

# 10. Live STT `jobs/live.py`

```python
# minutes_local/jobs/live.py
"""録音中の Chunk を finalize を待たず STT する準リアルタイム経路。§2.1。"""
from __future__ import annotations

import sqlite3

from ..db import repo, repo_phase3
from ..db.models import AudioChunk, LiveState, Meeting
from .context import AppContext


def live_allowed(ctx: AppContext) -> bool:
    return ctx.models.stt is not None


def default_live_enabled(ctx: AppContext) -> bool:
    """会議作成時の既定値。gpu_small / cpu_only では settings に関わらず false（§2.1）。"""
    if ctx.models.tier in ("gpu_small", "cpu_only"):
        return False
    return ctx.settings.live_stt_enabled and live_allowed(ctx)


def on_chunk_registered(conn: sqlite3.Connection, ctx: AppContext, meeting: Meeting, chunk: AudioChunk) -> str | None:
    """PUT chunk 直後に呼ぶ。Live 有効かつ has_voice なら live_transcribe_chunk を生成。VAD は掛けない。"""
    if not meeting.live_stt_enabled or meeting.status != "recording" or not live_allowed(ctx):
        return None
    if not chunk.has_voice:
        return None
    model = meeting.stt_model_used or (ctx.models.stt.name if ctx.models.stt else None)
    return repo.insert_job(conn, meeting.id, "live_transcribe_chunk", chunk_id=chunk.id, model_name=model)


def compute_live_state(conn: sqlite3.Connection, ctx: AppContext, meeting: Meeting, now: int) -> LiveState:
    if not meeting.live_stt_enabled:
        return "DISABLED"
    if not live_allowed(ctx):
        return "STOPPED"
    if meeting.status != "recording":
        return "STOPPED"
    chunks = repo.list_chunks(conn, meeting.id)
    if not chunks:
        return "STARTING"
    age = repo_phase3.oldest_open_job_age_ms(conn, meeting.id, "live_transcribe_chunk", now)
    th = ctx.settings.thresholds
    if age is None:
        return "RUNNING"
    if age > th.live_stopped_after_s * 1000:
        return "STOPPED"
    if age > th.live_degraded_after_s * 1000:
        return "DEGRADED"
    return "RUNNING"


def set_live_enabled(conn: sqlite3.Connection, meeting_id: str, enabled: bool) -> None:
    repo.update_meeting(conn, meeting_id, live_stt_enabled=int(enabled))
```

Live で生成されたセグメントは `transcript_segments` に通常どおり挿入され（`merged_version=NULL`）、finalize 後の `transcribe_chunk` が同一 Chunk のセグメント有無を見て STT を省略する（§21 `handle_transcribe`）。Live は Overlap を付けないため、境界品質は確定 STT より僅かに劣る（§2.1）。

---

# 11. 日次スケジューラ `jobs/scheduler.py`

`compress_chunk` の生成と、バックアップ・世代管理を行う。起動時と 1 時間ごとに `run_once()` を呼ぶ。

| 処理 | 頻度 | 判定 |
| --- | --- | --- |
| `compress_chunk` の生成 | 毎回（冪等。同じ Chunk のジョブは 1 件。`uq_compress_job`） | `completed` から `compress_after_days` 経過した会議の WAV の Chunk。`ctx.codec is None` なら何もしない |
| バックアップ + 世代管理 | 直近のバックアップから 24 時間以上たっていたとき | `backup_due()`。基準はバックアップのファイル名の時刻（§2.4） |

ループは 1 回の失敗（ディスク満杯、DB のロック）を記録して次の回へ進む（Phase 2 §14 の常駐ループと同じ）。`run_once(ctx, now=...)` の `now` は期日の判定とバックアップのファイル名に使う時刻で、テストが差し替える（実時間を待たない）。

```python
# minutes_local/jobs/scheduler.py
"""定期処理：compress_chunk の生成、バックアップと世代管理。§2.4。"""
from __future__ import annotations

import asyncio
import logging
import time

from ..db import repo, repo_phase3
from ..db.connection import now_ms
from ..storage import backup
from .context import AppContext

log = logging.getLogger(__name__)

CHECK_INTERVAL_S = 3600.0                  # 起動時と 1 時間ごとに、やることがあるかを見る
BACKUP_INTERVAL_MS = 24 * 3600 * 1000      # 直近のバックアップからこれだけ経っていたら作る


async def schedule_compression(ctx: AppContext) -> int:
    """codec が使えるときだけ。戻り値は生成したジョブ数。"""
    if ctx.codec is None:
        return 0
    threshold = now_ms() - ctx.settings.compress_after_days * 24 * 3600 * 1000
    created = 0
    async with ctx.db.write() as conn:
        for meeting_id, chunk_id in repo_phase3.chunks_to_compress(conn, threshold):
            if repo.insert_job(conn, meeting_id, "compress_chunk", chunk_id=chunk_id, max_attempts=2) is not None:
                created += 1
    return created


def backup_due(ctx: AppContext, now: int) -> bool:
    """直近のバックアップから BACKUP_INTERVAL_MS 経っているか。1 つもなければ True。

    プロセスの起動からの経過ではなく、ファイル名の時刻で決める。使うたびにサーバーを起動しても 1 日 1 世代になり、
    短時間に再起動を繰り返しても古い世代を押し出さない。時計が戻って直近が未来になっていたら作る（作らないまま待ち続けない）。
    """
    files = backup.list_backups(ctx.settings.backups_dir)
    latest = backup.backup_time_ms(files[-1]) if files else None
    return latest is None or latest > now or now - latest >= BACKUP_INTERVAL_MS


async def run_once(ctx: AppContext, now: int | None = None) -> dict[str, int]:
    """1 回分。圧縮ジョブの生成（冪等）と、期日が来ていればバックアップと世代管理。

    now は期日の判定とバックアップのファイル名に使う時刻（テストが差し替える。省略時は現在）。
    """
    t = now_ms() if now is None else now
    compressed = await schedule_compression(ctx)
    if not backup_due(ctx, t):
        return {"compress_jobs": compressed, "backup": 0, "pruned": 0}
    started = time.monotonic()
    await asyncio.to_thread(backup.create_backup, ctx.db, ctx.settings.backups_dir, t)
    pruned = backup.prune_backups(ctx.settings.backups_dir, ctx.settings.backup_generations)
    async with ctx.db.write() as conn:
        repo.record_metric(conn, "backup_created", 1)
        repo.record_metric(conn, "backup_duration_ms", int((time.monotonic() - started) * 1000))
    return {"compress_jobs": compressed, "backup": 1, "pruned": pruned}


async def run_forever(ctx: AppContext, stop: asyncio.Event, interval_s: float = CHECK_INTERVAL_S) -> None:
    while not stop.is_set():
        try:
            await run_once(ctx)
        except Exception:  # noqa: BLE001
            # ディスク満杯・DB のロックで 1 回失敗しても、ループを終わらせない（終わると再起動までバックアップも圧縮も止まる）
            log.exception("scheduled maintenance failed; retrying at the next check")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass
```

---

# 12. 話者分離 `diarization/`

実 Provider（`pyannote_provider.py`）が守る契約を先に示す。pyannote 本体は設計時点で実行していないので、本書が固定するのは Provider の**外側**（何を渡し、何を受け取り、どこに何を置くか）である。内側（配布物の書式・Pipeline の戻り値の形）は版で変わりうるので、Step 3-h で実物に合わせてこの表を更新する（§3）。

| 項目 | 規約 | 確かめ方 |
| --- | --- | --- |
| モデルの場所 | `{dataDir}/models/diarization/config.yaml`（Pipeline の設定）。このファイルがあれば `build_context` が実 Provider を作る。設定が参照するモデル（セグメンテーション・話者埋め込み）のファイルも同じディレクトリの下に置き、設定からは**絶対パス**で指す（相対パスの基準は pyannote の版に依存する） | 3-h |
| 取得 | サーバーは取得しない。利用者が配布元から取得して配置する（設計時点の理解では、配布元が利用条件への同意を求める配布形態で、サーバーが代わりに取得できない） | 3-h |
| 通信 | ロードの前に `HF_HUB_OFFLINE=1` を設定する。設定が Hub 上のモデル名を指していても取りに行かず、ロードの失敗として現れる（Zero External Data Egress） | 3-h（ネットワークを切らずにロードし、外向きの接続がないことを見る） |
| 入力 | source ごとに `assemble_timeline()` で連続させた 16 kHz・mono・PCM16 の WAV を `{dataDir}/tmp/` に書き、そのパスを渡す。終わったら消す。OS の一時ディレクトリは使わない（録音がデータディレクトリの外に出る） | `test_pyannote_provider_keeps_absolute_time_across_skipped_chunk` |
| 引数 | 話者数の上限があれば `max_speakers`。`num_speakers`（人数の指定）には渡さない。`handle_diarize` は上限を渡さない（推定に任せる） | 同上 |
| 戻り値 | `itertracks(yield_label=True)` で `(区間, _, 話者)` を列挙できるもの。区間の `start` / `end` は渡した WAV の先頭からの秒。結果のオブジェクトが `speaker_diarization` 属性を持つ版では、その属性を使う | 3-h |
| 時刻 | 区間の秒に、その source の先頭 Chunk の絶対開始 ms を足して `SpeakerTurn` にする | `test_speaker_after_silent_chunk_is_not_shifted` |
| ラベル | `(source, Pipeline の話者)` の出現順に `S1, S2, …`。mic と system で同じ人が話していても別のラベルになる（§2.2） | `test_diarize_assigns_labels_and_names_are_user_assigned` |
| 実行デバイス | `Hardware.gpu.backend == "cuda"` のときだけ `cuda`。Apple Silicon・GPU なしは `cpu`（STT と同じ。Phase 2 §9） | 3-h |
| 失敗 | 設定なし・`pyannote.audio` なしは `ModelMissingError`（待たずに話者分離なしで続行。§9）。メモリ不足は `OOMError`。それ以外は Runner が `INTERNAL` として回数つきで再試行する | `test_diarize_model_missing_does_not_wait`、`test_diarize_failure_does_not_block_merge` |

`PyannoteDiarizationProvider(pipeline=...)` で Pipeline を差し替えられる。テストは pyannote を入れずに、Provider の本物のコード（時刻の組み立て・一時ファイル・引数・ラベル付け）を通す。`FakeDiarizationProvider` は Chunk ごとに絶対時刻で区間を作るので、「連結すると時刻がずれる」種類の不具合を検出できない。実 Provider の経路を確かめるテストでは Fake ではなくこの差し替えを使う。

```python
# minutes_local/diarization/provider.py
"""話者分離 Provider 抽象。会議単位・source 別に SpeakerTurn 列を返す。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SpeakerTurn:
    source: str          # "mic" | "system"
    start_ms: int        # Session Clock 上の絶対 ms
    end_ms: int
    label: str           # "S1", "S2", ...
    confidence: float


@dataclass(frozen=True)
class DiarizationRequest:
    meeting_id: str
    # source ごとの (絶対開始 ms, PCM16 16kHz) の列。STT を省いた無音 Chunk・読めなかった Chunk は入らない（間が空く）。
    # 連続した音声が要る Provider は assemble_timeline() で組み立てる
    pcm_by_source: dict[str, list[tuple[int, bytes]]]
    models_dir: str
    work_dir: str                       # 一時ファイルの置き場所（{dataDir}/tmp）。音声をデータディレクトリの外に書かない
    max_speakers: int | None = None     # 話者数の上限。None は Provider の推定に任せる


@dataclass(frozen=True)
class DiarizationResult:
    turns: tuple[SpeakerTurn, ...]
    speaker_count: int
    duration_ms: int = 0


class DiarizationProvider(Protocol):
    def diarize(self, req: DiarizationRequest) -> DiarizationResult: ...


def assemble_timeline(chunks: list[tuple[int, bytes]]) -> tuple[int, bytes]:
    """(先頭の絶対開始 ms, 連続した PCM)。各 Chunk を絶対時刻の位置に置き、渡されなかった区間を無音で埋める。

    単純に連結すると、間の Chunk が 1 つ抜けるたびに後ろの音声が Chunk 長（30 秒）ずつ前へ詰まり、Provider が返す区間が
    会議の時刻とずれて、別の人の発言に話者ラベルが付く。16 kHz では 1 ms = 16 サンプルなので、位置は誤差なく決まる。
    """
    if not chunks:
        return 0, b""
    ordered = sorted(chunks, key=lambda c: c[0])
    base_ms = ordered[0][0]
    even = [(start_ms, pcm[: len(pcm) - len(pcm) % 2]) for start_ms, pcm in ordered]     # PCM16 の半端な 1 バイトは捨てる
    total = max((start_ms - base_ms) * 32 + len(pcm) for start_ms, pcm in even)
    buf = bytearray(total)
    for start_ms, pcm in even:
        offset = (start_ms - base_ms) * 32
        buf[offset:offset + len(pcm)] = pcm
    return base_ms, bytes(buf)
```

```python
# minutes_local/diarization/fake_provider.py
"""テスト用。mic は S1 固定、system は 30 秒ごとに S2 / S3 を交互に割り当てる（決定的）。"""
from __future__ import annotations

from ..jobs.retry import JobError
from .provider import DiarizationProvider, DiarizationRequest, DiarizationResult, SpeakerTurn


class FakeDiarizationProvider(DiarizationProvider):
    def __init__(self, fail_with: JobError | None = None) -> None:
        self.fail_with = fail_with
        self.calls: list[DiarizationRequest] = []

    def diarize(self, req: DiarizationRequest) -> DiarizationResult:
        self.calls.append(req)
        if self.fail_with is not None:
            raise self.fail_with
        turns: list[SpeakerTurn] = []
        labels: set[str] = set()
        for source, chunks in req.pcm_by_source.items():
            for i, (start_ms, pcm) in enumerate(chunks):
                dur = len(pcm) // 32
                label = "S1" if source == "mic" else ("S2" if i % 2 == 0 else "S3")
                labels.add(label)
                turns.append(SpeakerTurn(source, start_ms, start_ms + dur, label, 0.9))
        return DiarizationResult(tuple(turns), len(labels))
```

```python
# minutes_local/diarization/pyannote_provider.py
"""pyannote.audio の実 Provider。遅延 import。モデルは {models_dir}/diarization/ に利用者が配置する（Zero External Data Egress）。"""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Any

from ..jobs.retry import ModelMissingError, OOMError, is_oom_message
from ..storage.files import build_wav
from .provider import DiarizationProvider, DiarizationRequest, DiarizationResult, SpeakerTurn, assemble_timeline


class PyannoteDiarizationProvider(DiarizationProvider):
    def __init__(self, device: str = "cpu", pipeline: Any = None) -> None:
        """device は "cuda" か "cpu"（bootstrap が Hardware.gpu.backend から決める。Apple Silicon は cpu）。

        pipeline はテスト用の差し替え（`pipeline(wav のパス, **kwargs)` で itertracks() を持つ結果を返すもの）。
        pyannote 本体なしで、時刻の組み立て・引数・一時ファイルの扱いを確かめられる（§23.4）。
        """
        self.device = device
        self._pipeline: Any = pipeline

    def _load(self, models_dir: Path) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        config = models_dir / "diarization" / "config.yaml"
        if not config.exists():
            raise ModelMissingError("diarization model not installed (models/diarization/config.yaml)")
        # config.yaml が Hugging Face Hub 上のモデル名を指していても、取りに行かせない（Zero External Data Egress）。
        # 配置が足りなければ通信せず、ロードの失敗として現れる。import より前に設定する（huggingface_hub は import 時に読む）
        os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            from pyannote.audio import Pipeline  # type: ignore[import-not-found]
        except ImportError as e:
            raise ModelMissingError(f"pyannote.audio not installed: {e}") from e
        try:
            pipeline = Pipeline.from_pretrained(str(config))
            if self.device != "cpu":
                import torch  # type: ignore[import-not-found]
                pipeline.to(torch.device(self.device))      # 既定は CPU。移さないと GPU があっても CPU で走る
        except Exception as e:  # noqa: BLE001
            if is_oom_message(str(e)):
                raise OOMError(str(e)) from e
            raise
        self._pipeline = pipeline
        return pipeline

    def _run(self, pipeline: Any, pcm: bytes, work_dir: Path, max_speakers: int | None) -> Any:
        """1 source 分を一時 WAV にして Pipeline に渡し、話者区間（Annotation）を返す。

        一時ファイルはデータディレクトリの中（work_dir）に作る。OS の一時ディレクトリは、他の OS ユーザーから読める設定がありうる。
        Windows は開いたままのファイルを別のハンドルで開けないので、閉じてから渡し、終わったら自分で消す
        （強制終了で残った分は serve が起動時に work_dir ごと消す。§22）。
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=work_dir, prefix="diarize-", suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(build_wav(pcm))
            # max_speakers は上限。num_speakers（人数の指定）に渡すと、その人数ちょうどに分けられてしまう
            kwargs = {"max_speakers": max_speakers} if max_speakers else {}
            try:
                output = pipeline(name, **kwargs)
            except Exception as e:  # noqa: BLE001
                if is_oom_message(str(e)):
                    raise OOMError(str(e)) from e
                raise
        finally:
            Path(name).unlink(missing_ok=True)
        # pyannote.audio 4 系は結果のオブジェクト（speaker_diarization に Annotation）を返し、3 系は Annotation そのものを返す
        return getattr(output, "speaker_diarization", output)

    def diarize(self, req: DiarizationRequest) -> DiarizationResult:
        pipeline = self._load(Path(req.models_dir))
        started = time.monotonic()
        turns: list[SpeakerTurn] = []
        labels: set[str] = set()
        next_label = 1
        label_map: dict[tuple[str, str], str] = {}
        for source, chunks in req.pcm_by_source.items():
            if not chunks:
                continue
            # Chunk の間（無音で STT を省いた Chunk・欠損）を無音で埋めて、区間の時刻を会議の時刻に合わせる
            base_ms, pcm = assemble_timeline(chunks)
            annotation = self._run(pipeline, pcm, Path(req.work_dir), req.max_speakers)
            for turn, _, speaker in annotation.itertracks(yield_label=True):
                key = (source, str(speaker))
                if key not in label_map:
                    label_map[key] = f"S{next_label}"
                    next_label += 1
                label = label_map[key]
                labels.add(label)
                turns.append(SpeakerTurn(source, base_ms + int(turn.start * 1000), base_ms + int(turn.end * 1000), label, 1.0))
        return DiarizationResult(tuple(turns), len(labels), int((time.monotonic() - started) * 1000))
```

セグメントへの割当は `handle_diarize`（§21）で行う。各セグメントに対して同一 source の `SpeakerTurn` のうち時間重なりが最大のものを選び、重なりがなければ `NULL` のままにする。

---

# 13. 言語判定 `stt/language.py`

```python
# minutes_local/stt/language.py
"""Chunk 単位の言語判定。§2.3。"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class LanguageGuess:
    language: str      # "ja" | "en" | ...
    probability: float


class LanguageDetector(Protocol):
    def detect(self, pcm: bytes) -> LanguageGuess: ...


class FakeLanguageDetector(LanguageDetector):
    """テスト用。script(pcm) で決める。既定は ja / 0.95。"""

    def __init__(self, script: Callable[[bytes], LanguageGuess] | None = None) -> None:
        self.script = script
        self.calls = 0

    def detect(self, pcm: bytes) -> LanguageGuess:
        self.calls += 1
        return self.script(pcm) if self.script is not None else LanguageGuess("ja", 0.95)


class FasterWhisperLanguageDetector(LanguageDetector):
    """faster-whisper の detect_language。先頭 30 秒の特徴量で判定するため短い Chunk では確信度が下がる（§3）。"""

    def __init__(self, models_dir: Path, model_name: str, compute_type: str, device: str = "cpu") -> None:
        self.models_dir = models_dir
        self.model_name = model_name
        self.compute_type = compute_type
        self.device = device           # SttCandidate.device。compute_type から推測しない（Phase 2 §9）
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        self._model = WhisperModel(str(self.models_dir / "whisper" / self.model_name), device=self.device, compute_type=self.compute_type)
        return self._model

    def detect(self, pcm: bytes) -> LanguageGuess:
        import numpy as np  # type: ignore[import-not-found]
        model = self._load()
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        lang, prob, _ = model.detect_language(audio)
        return LanguageGuess(str(lang), float(prob))


def resolve_chunk_language(setting: str, guess: LanguageGuess | None, primary: str | None, min_prob: float) -> tuple[str | None, str]:
    """(transcribe に渡す language, 判定理由)。setting が ja/en なら固定。"""
    if setting != "auto":
        return setting, "fixed"
    if guess is not None and guess.probability >= min_prob:
        return guess.language, "detected"
    if primary is not None:
        return primary, "fallback_primary"
    return "ja", "fallback_default"
```

---

# 14. エコー除去 `merge/echo.py` と Merger（変更）

```python
# minutes_local/merge/echo.py
"""mic が system の音声を拾ったセグメントを検出する。§2.2。"""
from __future__ import annotations

from ..db.models import Segment
from .dedupe import Candidate, similarity, time_overlap_ratio
from .normalize import normalize


def _cand(s: Segment) -> Candidate:
    return Candidate(s.id, s.chunk_id, s.start_ms, s.end_ms, s.normalized_text or normalize(s.text), s.confidence or 0.0)


def detect_echo(mic: list[Segment], system: list[Segment], *, overlap_ratio: float, text_similarity: float) -> dict[str, str]:
    """戻り値は mic セグメント id → system セグメント id。時間重なりと正規化テキスト類似度で判定する。"""
    out: dict[str, str] = {}
    sys_c = sorted((_cand(s) for s in system), key=lambda c: c.start_ms)
    for m in mic:
        mc = _cand(m)
        best: tuple[float, str] | None = None
        for sc in sys_c:
            if sc.start_ms > mc.end_ms:
                break
            if sc.end_ms < mc.start_ms:
                continue
            if time_overlap_ratio(mc, sc) < overlap_ratio:
                continue
            sim = similarity(mc.norm, sc.norm)
            if sim >= text_similarity and (best is None or sim > best[0]):
                best = (sim, sc.id)
        if best is not None:
            out[m.id] = best[1]
    return out
```

```python
# minutes_local/merge/merger.py
"""同一 source 内の重複解決 + mic/system 間のエコー除去。決定的・冪等。Phase 3 でエコーと話者名を追加。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from ..config import Thresholds
from ..db import repo, repo_phase3
from ..db.models import Segment
from .dedupe import Candidate, decide_pair
from .echo import detect_echo
from .normalize import normalize


@dataclass(frozen=True)
class MergeReport:
    transcript_version: int
    kept: int
    dropped: int
    echo: int


def _candidates(segments: list[Segment]) -> list[Candidate]:
    return [
        Candidate(s.id, s.chunk_id, s.start_ms, s.end_ms, s.normalized_text or normalize(s.text), s.confidence or 0.0)
        for s in segments
    ]


def resolve_source(segments: list[Segment], th: Thresholds) -> dict[str, str]:
    """1 source 分。戻り値は segment_id → merge_reason（'kept' または 'dup_of:<id>'）。"""
    cands = sorted(_candidates(segments), key=lambda c: (c.start_ms, c.end_ms, c.id))
    reason: dict[str, str] = {c.id: "kept" for c in cands}
    for i, a in enumerate(cands):
        if reason[a.id] != "kept":
            continue
        for b in cands[i + 1:]:
            if b.start_ms > a.end_ms + th.merge_window_ms:
                break
            if reason[b.id] != "kept":
                continue
            d = decide_pair(a, b, overlap_ratio=th.merge_time_overlap_ratio, text_similarity=th.merge_text_similarity,
                            containment_min=th.merge_containment_min_ratio, containment_max=th.merge_containment_max_ratio)
            if d == "keep_a":
                reason[b.id] = f"dup_of:{a.id}"
            elif d == "keep_b":
                reason[a.id] = f"dup_of:{b.id}"
                break
    return reason


def run_merge(conn: sqlite3.Connection, meeting_id: str, th: Thresholds) -> MergeReport:
    meeting = repo.get_meeting(conn, meeting_id)
    if meeting is None:
        raise ValueError(f"meeting not found: {meeting_id}")
    new_version = meeting.transcript_version + 1
    all_segments = repo.list_segments(conn, meeting_id)
    for s in all_segments:
        if s.normalized_text is None:
            s.normalized_text = normalize(s.text)
            conn.execute("UPDATE transcript_segments SET normalized_text = ? WHERE id = ?", (s.normalized_text, s.id))
    kept_by_source: dict[str, list[Segment]] = {"mic": [], "system": []}
    reasons: dict[str, str] = {}
    for source in ("mic", "system"):
        segs = [s for s in all_segments if s.source == source]
        r = resolve_source(segs, th)
        reasons.update(r)
        kept_by_source[source] = [s for s in segs if r[s.id] == "kept"]
    echo = detect_echo(kept_by_source["mic"], kept_by_source["system"], overlap_ratio=th.echo_time_overlap_ratio, text_similarity=th.echo_text_similarity)
    for mic_id, sys_id in echo.items():
        reasons[mic_id] = f"echo_of:{sys_id}"
    kept = dropped = 0
    for sid, reason in reasons.items():
        if reason == "kept":
            repo.set_merge_result(conn, sid, new_version, "kept")
            kept += 1
        else:
            repo.set_merge_result(conn, sid, None, reason)
            dropped += 1
    repo.update_meeting(conn, meeting_id, transcript_version=new_version)
    return MergeReport(new_version, kept, dropped, len(echo))


@dataclass(frozen=True)
class TranscriptLine:
    segment_id: str
    source: str
    start_ms: int
    end_ms: int
    text: str
    speaker_id: str | None = None
    speaker_name: str | None = None
    language: str | None = None


@dataclass(frozen=True)
class Gap:
    source: str
    start_ms: int
    end_ms: int


def render_lines(conn: sqlite3.Connection, meeting_id: str, version: int) -> tuple[list[TranscriptLine], list[Gap]]:
    """確定 transcript を時系列に並べ、stt_status='failed' の Chunk を gap として返す。"""
    segs = repo.list_segments(conn, meeting_id, merged_version=version)
    names = {sp.label: sp.name for sp in repo_phase3.list_speakers(conn, meeting_id)}
    lines = [TranscriptLine(s.id, s.source, s.start_ms, s.end_ms, s.text, s.speaker_id,
                            names.get(s.speaker_id) if s.speaker_id else None, s.language) for s in segs]
    gaps = [Gap(c.source, c.start_offset_ms, c.end_offset_ms) for c in repo.list_chunks(conn, meeting_id) if c.stt_status == "failed"]
    return lines, gaps


def format_for_llm(lines: list[TranscriptLine], gaps: list[Gap], id_len: int = 8) -> str:
    """[mm:ss] [source] [S1:名前] [seg:id] text。話者は割当済みのときだけ付ける（Invariant 9）。"""
    rows: list[tuple[int, str]] = []
    for ln in lines:
        speaker = ""
        if ln.speaker_id:
            speaker = f" [{ln.speaker_id}:{ln.speaker_name}]" if ln.speaker_name else f" [{ln.speaker_id}]"
        rows.append((ln.start_ms, f"[{_mmss(ln.start_ms)}] [{ln.source}]{speaker} [seg:{ln.segment_id[:id_len]}] {ln.text}"))
    for g in gaps:
        rows.append((g.start_ms, f"[{_mmss(g.start_ms)}] [{g.source}] [seg:—] （この区間は文字起こしに失敗しました）"))
    rows.sort(key=lambda r: r[0])
    return "\n".join(r[1] for r in rows)


def _mmss(ms: int) -> str:
    s = ms // 1000
    return f"{s // 60:02d}:{s % 60:02d}"
```

---

# 15. プロンプト `llm/prompts.py`（変更）

混在会議と話者ラベルの扱いを追加。`PROMPT_VERSION` を `v2` に上げる（`meeting_summary_versions.prompt_version` で追跡できる）。

```python
# minutes_local/llm/prompts.py
"""prompt_version v2：混在言語と話者ラベルの注記を追加。"""
from __future__ import annotations

PROMPT_VERSION = "v2"

SYSTEM_JA = (
    "あなたは会議の文字起こしから議事録を作成するアシスタントです。"
    "出力は必ず指定された JSON スキーマに従ってください。"
    "文字起こしに書かれていない決定事項・担当者・期限を作ってはいけません。"
    "各項目の sourceSegmentIds には、根拠となる行の [seg:XXXXXXXX] の XXXXXXXX を必ず 1 つ以上入れてください。"
    "話者名を推測してはいけません。行頭の [S1:名前] のように名前が明示されている場合のみ、その名前を担当者に使ってよいです。"
    "名前のないラベル（[S2] など）は担当者として使わず null にしてください。"
)

SYSTEM_EN = (
    "You create meeting minutes from a transcript. Output must follow the given JSON schema. "
    "Never invent decisions, assignees, or deadlines that are not in the transcript. "
    "Every item must cite at least one [seg:XXXXXXXX] id in sourceSegmentIds. "
    "Do not guess speaker names; use a name as assignee only when it appears explicitly as [S1:Name]. "
    "Labels without a name (e.g. [S2]) must not be used as assignees; set assignee to null."
)

MIXED_NOTE_JA = "この会議には日本語と英語が混在しています。議事録は日本語で書き、他言語の発言を引用する場合は原文のまま引用してください。"
MIXED_NOTE_EN = "This meeting mixes Japanese and English. Write the minutes in English; quote utterances in other languages verbatim."


def system_prompt(language: str, mixed: bool = False) -> str:
    base = SYSTEM_EN if language == "en" else SYSTEM_JA
    if not mixed:
        return base
    return base + " " + (MIXED_NOTE_EN if language == "en" else MIXED_NOTE_JA)


def map_prompt(transcript_text: str, window_index: int, window_total: int) -> str:
    head = "" if window_total == 1 else f"（これは会議の {window_index + 1}/{window_total} 番目の区間です）\n"
    return f"{head}以下の文字起こしから議事録 JSON を作成してください。\n\n{transcript_text}"


def reduce_prompt(partials_json: list[str]) -> str:
    joined = "\n\n".join(f"--- 区間 {i + 1} ---\n{p}" for i, p in enumerate(partials_json))
    return (
        "以下は同じ会議を区間ごとに要約した JSON です。重複を統合し、会議全体の議事録 JSON を 1 つ作成してください。"
        "sourceSegmentIds は元の値をそのまま引き継いでください。\n\n" + joined
    )
```

`llm/map_reduce.py` の `synthesize` は `system_prompt(language)` を内部で呼んでいるため、混在注記を渡すには `synthesize` の引数を増やす必要がある。`map_reduce.py` は変更禁止としたので、`handle_summary` は `language` に `"ja"` / `"en"` を渡し、混在注記は `synthesize` の `transcript_text` 先頭に 1 行として前置する（§21）。`system_prompt(language, mixed)` の `mixed` はブラウザ側の表示用と将来の `map_reduce` 改修に備えた拡張点である。

---

# 16. コーデック `storage/codec.py` とファイル入出力 `storage/files.py`（変更）

```python
# minutes_local/storage/codec.py
"""音声コーデック抽象。FLAC は soundfile（libsndfile）を遅延 import。Fake は検証ロジックのテスト用。"""
from __future__ import annotations

import io
import struct
from typing import Protocol


class AudioCodec(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def extension(self) -> str: ...
    def encode(self, pcm: bytes) -> bytes: ...
    # 壊れた入力は ValueError で返す（read_pcm が InvalidWavError に包む）
    def decode(self, data: bytes) -> bytes: ...


class FakeCodec:
    """マジック + サンプル数 + 無圧縮 PCM。corrupt=True で復元不一致を再現する。"""
    name = "fake"
    extension = ".fake"
    MAGIC = b"MLFK"

    def __init__(self, corrupt: bool = False) -> None:
        self.corrupt = corrupt

    def encode(self, pcm: bytes) -> bytes:
        return self.MAGIC + struct.pack("<I", len(pcm)) + pcm

    def decode(self, data: bytes) -> bytes:
        if len(data) < 8 or data[:4] != self.MAGIC:
            raise ValueError("not a fake container")
        n, = struct.unpack_from("<I", data, 4)
        pcm = data[8:8 + n]
        if self.corrupt and pcm:
            return pcm[:-2] + b"\x00\x00"
        return pcm


class FlacCodec:
    name = "flac"
    extension = ".flac"

    def encode(self, pcm: bytes) -> bytes:
        import numpy as np  # type: ignore[import-not-found]
        import soundfile as sf  # type: ignore[import-not-found]
        buf = io.BytesIO()
        sf.write(buf, np.frombuffer(pcm, dtype=np.int16), 16000, format="FLAC", subtype="PCM_16")
        return buf.getvalue()

    def decode(self, data: bytes) -> bytes:
        import numpy as np  # type: ignore[import-not-found]
        import soundfile as sf  # type: ignore[import-not-found]
        try:
            audio, sr = sf.read(io.BytesIO(data), dtype="int16")
        except RuntimeError as e:
            # 壊れたファイルの libsndfile の例外（RuntimeError 系）を、AudioCodec.decode の約束どおり ValueError にそろえる。
            # read_pcm はこれを InvalidWavError に変えるので、呼び出し側（修復判定・STT）は 1 種類の例外だけを扱えばよい
            raise ValueError(f"flac decode failed: {e}") from e
        if sr != 16000:
            raise ValueError(f"unexpected sample rate {sr}")
        if audio.ndim > 1:
            audio = audio[:, 0]
        return np.asarray(audio, dtype=np.int16).tobytes()


def codec_for_extension(ext: str, codec: AudioCodec | None) -> AudioCodec | None:
    if ext == ".wav":
        return None
    if codec is not None and codec.extension == ext:
        return codec
    return None
```

```python
# minutes_local/storage/files.py
"""録音ファイルの原子的書き込み、sha256、WAV ヘッダ検証。Phase 3 で利用者階層とコーデック分岐を追加。"""
from __future__ import annotations

import hashlib
import os
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .codec import AudioCodec

WAV_HEADER_BYTES = 44
WAV_SAMPLE_RATE = 16000
WAV_CHANNELS = 1
WAV_BITS = 16


class InvalidWavError(ValueError):
    pass


@dataclass(frozen=True)
class WavHeader:
    data_bytes: int
    sample_count: int


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def parse_wav_header(data: bytes) -> WavHeader:
    """PCM16 / mono / 16kHz 固定仕様に準拠していなければ InvalidWavError。"""
    if len(data) < WAV_HEADER_BYTES:
        raise InvalidWavError(f"too short: {len(data)} bytes")
    if data[0:4] != b"RIFF" or data[8:12] != b"WAVE" or data[12:16] != b"fmt " or data[36:40] != b"data":
        raise InvalidWavError("missing RIFF/WAVE/fmt/data markers")
    riff_size, = struct.unpack_from("<I", data, 4)
    fmt_size, audio_format, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from("<IHHIIHH", data, 16)
    data_bytes, = struct.unpack_from("<I", data, 40)
    if fmt_size != 16 or audio_format != 1:
        raise InvalidWavError(f"not PCM (fmt_size={fmt_size}, format={audio_format})")
    if channels != WAV_CHANNELS or sample_rate != WAV_SAMPLE_RATE or bits != WAV_BITS:
        raise InvalidWavError(f"unexpected format ch={channels} sr={sample_rate} bits={bits}")
    if block_align != 2 or byte_rate != 32000:
        raise InvalidWavError("blockAlign/byteRate mismatch")
    if riff_size != 36 + data_bytes:
        raise InvalidWavError("riff size mismatch")
    if WAV_HEADER_BYTES + data_bytes != len(data):
        raise InvalidWavError(f"data size {data_bytes} != actual {len(data) - WAV_HEADER_BYTES}")
    if data_bytes == 0 or data_bytes % 2:
        raise InvalidWavError(f"empty or odd-sized PCM16 data: {data_bytes} bytes")
    return WavHeader(data_bytes=data_bytes, sample_count=data_bytes // 2)


def build_wav(pcm: bytes) -> bytes:
    """テストと FLAC 復元用。PCM16 LE バイト列に 44 バイトヘッダを付ける。"""
    data_bytes = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVE" + b"fmt " + struct.pack(
        "<IHHIIHH", 16, 1, WAV_CHANNELS, WAV_SAMPLE_RATE, 32000, 2, WAV_BITS
    ) + b"data" + struct.pack("<I", data_bytes)
    return header + pcm


def chunk_relative_path(meeting_id: str, source: str, sequence_no: int, user_id: str = "local") -> str:
    """Phase 3：recordings/{userId}/{meetingId}/{source}/{seq}.wav（§2.5）。"""
    return f"recordings/{user_id}/{meeting_id}/{source}/{sequence_no:06d}.wav"


def meeting_dir(meeting_id: str, user_id: str = "local") -> str:
    return f"recordings/{user_id}/{meeting_id}"


def write_atomic(data_dir: Path, relative_path: str, data: bytes) -> Path:
    """書き込みごとに一意な {path}.{ランダム}.part に書き、fsync 後に rename する（Phase 1 §12.1）。"""
    final = data_dir / relative_path
    final.parent.mkdir(parents=True, exist_ok=True)
    # 同時書き込みで一時ファイルを奪い合わないよう、書き込みごとに一意な .part を使う
    fd, part = tempfile.mkstemp(dir=final.parent, prefix=final.name + ".", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(part, final)
    except BaseException:
        Path(part).unlink(missing_ok=True)
        raise
    return final


def read_pcm(data_dir: Path, relative_path: str, expected_sha256: str | None = None, codec: AudioCodec | None = None) -> bytes:
    """WAV または圧縮ファイルを読み、PCM を返す。expected_sha256 は常に WAV 形式での値（§2.4）。"""
    path = data_dir / relative_path
    if not path.exists():
        raise InvalidWavError(f"file missing: {relative_path}")
    data = path.read_bytes()
    if path.suffix == ".wav":
        if expected_sha256 is not None and sha256_hex(data) != expected_sha256:
            raise InvalidWavError(f"sha256 mismatch: {relative_path}")
        parse_wav_header(data)
        return data[WAV_HEADER_BYTES:]
    if codec is None or codec.extension != path.suffix:
        raise InvalidWavError(f"no codec for {path.suffix}: {relative_path}")
    try:
        pcm = codec.decode(data)
    except ValueError as e:
        raise InvalidWavError(f"decode failed: {relative_path}: {e}") from e
    if expected_sha256 is not None and sha256_hex(build_wav(pcm)) != expected_sha256:
        raise InvalidWavError(f"sha256 mismatch after decode: {relative_path}")
    return pcm
```

---

# 17. バックアップと整合性検査 `storage/backup.py`

| 関数 | 役割 | 落とし穴への対処 |
| --- | --- | --- |
| `create_backup` | `VACUUM INTO` で `minutes-{epoch ms}.sqlite` を作る | `.part` に書いてから名前を付け替える。書きかけを正規の名前で残さない。同じミリ秒の 2 回目は時刻を 1 進める（前の世代を上書きしない） |
| `list_backups` | 完成したバックアップを古い順に返す | ファイル名の時刻（数値）で並べる。`.part` と規約外の名前は含めない |
| `prune_backups` | 新しい方から `keep` 世代を残す | 中断で残った `.part` も消す |
| `restore_latest` | 壊れた DB を退避し、復元元にできる最も新しいバックアップを置く | 候補ごとに `integrity_check` をかけ、壊れていれば 1 つ古いものへ下がる。空のファイルは検査に通るので、大きさも見る。使えるものがなければ DB を置かない（空で起動し、§18 が作り直す） |
| `Recovery` | 起動時に DB を作り直した記録（復元元・作り直した件数） | `AppContext.recovery` に載せ、`serve` / `doctor` が警告として出す（§22） |

```python
# minutes_local/storage/backup.py
"""VACUUM INTO によるバックアップ、世代管理、起動時の integrity_check と復元。§2.4。"""
from __future__ import annotations

import os
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..db.connection import Database
from .rebuild import RebuildReport

PREFIX = "minutes-"
SUFFIX = ".sqlite"
PART_SUFFIX = ".part"


@dataclass
class Recovery:
    """起動時に壊れた DB を作り直した記録（§2.4）。serve と doctor が利用者に知らせる。"""
    restored_from: Path | None                                       # 復元元。None は使えるバックアップがなく、空の DB から始めた
    rebuilt: RebuildReport = field(default_factory=RebuildReport)    # 録音ファイルから作り直した件数（build_context が埋める）


def create_backup(db: Database, backups_dir: Path, now: int | None = None) -> Path:
    """`minutes-{epoch ms}.sqlite` を作る。now は名前に入れる時刻（省略時は現在。定期処理は期日の判定に使った時刻を渡す）。

    書きかけを正規の名前で残さない。`.part` に書き、終わってから名前を付け替える。途中で失敗・強制終了しても、
    list_backups()（復元元と世代管理の対象）には完成したファイルしか現れない。
    """
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time() * 1000) if now is None else now
    while (backups_dir / f"{PREFIX}{stamp}{SUFFIX}").exists():
        stamp += 1                               # 同じミリ秒の 2 回目が前の世代を上書きしない
    target = backups_dir / f"{PREFIX}{stamp}{SUFFIX}"
    part = target.with_name(target.name + PART_SUFFIX)
    part.unlink(missing_ok=True)                 # VACUUM INTO は既存のファイルへ書けない
    try:
        # VACUUM INTO はトランザクション外で実行する。読み取り接続でよい。
        with db.read() as conn:
            conn.execute("VACUUM INTO ?", (str(part),))
        os.replace(part, target)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return target


def backup_time_ms(path: Path) -> int | None:
    """ファイル名に入っている作成時刻（epoch ms）。規約外の名前は None。"""
    stamp = path.name[len(PREFIX):-len(SUFFIX)]
    return int(stamp) if stamp.isdigit() else None


def list_backups(backups_dir: Path) -> list[Path]:
    """完成したバックアップを古い順に返す。書きかけ（.part）と規約外の名前は含めない。"""
    if not backups_dir.exists():
        return []
    stamped = [(backup_time_ms(p), p) for p in backups_dir.glob(f"{PREFIX}*{SUFFIX}") if p.is_file()]
    return [p for _, p in sorted((t, p) for t, p in stamped if t is not None)]


def prune_backups(backups_dir: Path, keep: int) -> int:
    """新しい方から keep 世代を残して消す。前回の中断で残った書きかけ（.part）も消す。戻り値は消した世代数。"""
    files = list_backups(backups_dir)
    removed = 0
    for p in files[:-keep] if keep > 0 else files:
        p.unlink(missing_ok=True)
        removed += 1
    if backups_dir.exists():
        for part in backups_dir.glob(f"{PREFIX}*{SUFFIX}{PART_SUFFIX}"):
            part.unlink(missing_ok=True)
    return removed


def integrity_ok(db_path: Path) -> bool:
    if not db_path.exists():
        return True
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("PRAGMA integrity_check").fetchone()
            return row is not None and row[0] == "ok"
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return False


def usable_backup(path: Path) -> bool:
    """復元元にできるか。空のファイルは integrity_check には通るが、会議が 1 件も入っていない。"""
    try:
        return path.stat().st_size > 0 and integrity_ok(path)
    except OSError:
        return False


def restore_latest(db_path: Path, backups_dir: Path) -> Path | None:
    """壊れた DB を退避し、復元元にできる最も新しいバックアップをコピーする。戻り値は復元元。

    最新のものが壊れていれば 1 つ古いものへ下がる。使えるものが 1 つもなければ None を返し、DB のファイルは置かない
    （呼び出し側が空の DB として開き、録音ファイルから作り直す。§18）。壊れたファイルはどちらの場合も
    `minutes.sqlite.corrupt-{epoch}` に残す。
    """
    source = next((p for p in reversed(list_backups(backups_dir)) if usable_backup(p)), None)
    if db_path.exists():
        shutil.move(str(db_path), str(db_path.with_name(f"{db_path.name}.corrupt-{int(time.time())}")))
    for extra in (db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        extra.unlink(missing_ok=True)
    if source is not None:
        shutil.copy2(source, db_path)
    return source
```

---

# 18. 再構築 `storage/rebuild.py` と `meeting.json`

finalize 時に `meeting.json` を書き出し（§20.2）、`doctor --rebuild` がそれと音声ファイルから欠損行を復元する。終了時刻のキーは Phase 1/2 の確定 API と同じ `endedAtEpochMs` で書く（移行 012 が `recordings/local/` へ移すだけの Phase 1/2 の `meeting.json` と同じキーで読める）。会議の作成時に書く控え（Phase 2 §21.2）には終了時刻がなく、その場合 rebuild は `ended_at` を NULL にする（終了時刻を失わない）。`meeting.json` は手で編集・破損しうる外部入力なので、停止理由（`stopReason`）と検出時刻（`stopDetectedAtEpochMs`）は `Meeting` を組み立てる前に組で検証する（`_stop_metadata()`）。未知の停止理由で `Meeting` の検証が失敗したり、範囲外の時刻で SQLite への挿入が `OverflowError` になったりすると、rebuild 全体が止まって他の会議も復元できなくなるためである。停止理由が `manual` / `mic_ended` のどちらかで、検出時刻が確定 API と同じ範囲（0〜2⁶³−1、SQLite INTEGER の上限）の整数（`bool` を除く）のときだけ両方を残し、どちらかが不正なら両方を `None` にする。

停止理由と終了時刻だけでなく、**控えのすべての項目**を同じ方針で扱う。型や範囲が合わない項目は既定値に置き換え、例外にしない。

| 項目 | 合わないときの値 | 判定 |
| --- | --- | --- |
| 最上位 | 控えなし（`{}`）として扱う | JSON として読めない、オブジェクトでない、ファイルが読めない |
| `title` | `"復元された会議"` | 空でない文字列でない |
| `sessionStartEpochMs` / `nativeSampleRate` / `consentConfirmedAt` | `0` | 0 以上・SQLite INTEGER 内の整数でない（`_int_or`） |
| `endedAtEpochMs` / `totalAudioFrames` | `NULL` | 同上 |
| `stopReason` と `stopDetectedAtEpochMs` | 組ごと `NULL` | `_stop_metadata()` |
| `chunks` | 空（時刻は下の仮定で補う） | 配列でない。要素がオブジェクトでない・`source` が `mic` / `system` でない・`sequenceNo` が整数でない要素は、その要素だけ捨てる |
| `chunks[].startOffsetMs` | `sequenceNo × 30000` | 整数でない。30 秒の Chunk が隙間なく並んでいたと仮定する（一時停止があった会議では時刻がずれる。控えがあれば起きない） |
| `chunks[].endOffsetMs` | `start + 実際の長さ` | 整数でない |
| `chunks[].vadScore` / `hasVoice` | `0.0` / `True` | 0〜1 の数値でない / 真偽値でない。有音かどうか分からなければ有音として扱う（Invariant 7） |
| `chunks[].sha256` | — | 文字列で、ファイルの値と違えばそのファイルを復元しない（`skipped_files`） |

利用者（`local_user_id`）は控えの `localUserId` ではなく**ディレクトリの階層**（`recordings/{userId}/…`）で決める。ファイルの置き場所と所有者が食い違うと、以後の Chunk が別の階層に書かれる。

復元する会議の状態は `_restored_status()` が決める（§2.4）。確定時の控えには終了時刻が入るので、終了時刻があれば（値が不正でも）`finalized`、作成時の控えのままなら `recording`、控えが読めなければ `finalized`。

rebuild を呼ぶのは 2 か所だけである。`doctor --rebuild`（データディレクトリのロックを取ってから。§22）と、`build_context` の起動時の復旧（壊れた DB を復元した直後。§22）。動いているサーバーと並行して呼ばない。

```python
# minutes_local/storage/rebuild.py
"""recordings/ の走査による meetings / audio_chunks の再構築。既存行は上書きしない。§2.4。"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeGuard

from ..db import repo
from ..db.connection import now_ms
from ..db.models import AudioChunk, Meeting
from .codec import AudioCodec
from .files import WAV_HEADER_BYTES, build_wav, parse_wav_header, sha256_hex, write_atomic
from .files import meeting_dir as meeting_rel_dir


@dataclass
class RebuildReport:
    meetings_created: int = 0
    chunks_created: int = 0
    chunks_marked_missing: int = 0
    skipped_files: list[str] | None = None


def write_meeting_json(data_dir: Path, meeting: Meeting, chunks: list[AudioChunk]) -> Path:
    """finalize 時のスナップショット。Phase 1 §13 の規約。キーは Phase 1/2 の meeting.json に Chunk 一覧と利用者を足したもの。

    write_atomic で書く（書き込みごとに一意な一時ファイル + fsync、Phase 1 §12.1）。同時 finalize が同じ一時ファイルを奪い合わない。
    """
    payload: dict[str, Any] = {
        "meetingId": meeting.id, "localUserId": meeting.local_user_id, "title": meeting.title,
        "sessionStartEpochMs": meeting.session_start_epoch_ms, "nativeSampleRate": meeting.native_sample_rate,
        "consentConfirmedAt": meeting.consent_confirmed_at, "endedAtEpochMs": meeting.ended_at,
        "totalAudioFrames": meeting.total_audio_frames,
        "stopReason": meeting.stop_reason, "stopDetectedAtEpochMs": meeting.stop_detected_at,
        "chunks": [{"source": c.source, "sequenceNo": c.sequence_no, "startOffsetMs": c.start_offset_ms,
                    "endOffsetMs": c.end_offset_ms, "sampleCount": c.sample_count, "sha256": c.sha256,
                    "vadScore": c.vad_score, "hasVoice": c.has_voice} for c in chunks],
    }
    rel = f"{meeting_rel_dir(meeting.id, meeting.local_user_id)}/meeting.json"
    return write_atomic(data_dir, rel, json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8"))


def _chunk_from_file(path: Path, codec: AudioCodec | None) -> tuple[int, str, bytes] | None:
    """(sample_count, wav_sha256, pcm) をファイルから復元。読めなければ None。"""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if path.suffix == ".wav":
        try:
            h = parse_wav_header(data)
        except ValueError:
            return None
        return h.sample_count, sha256_hex(data), data[WAV_HEADER_BYTES:]
    if codec is not None and codec.extension == path.suffix:
        try:
            pcm = codec.decode(data)
        except ValueError:
            return None
        if not pcm:
            return None
        return len(pcm) // 2, sha256_hex(build_wav(pcm)), pcm
    return None


# ---- meeting.json の読み取り ----
# 控えは利用者のディスク上のファイルで、壊れている・手で書き換えられている・別の版が書いたものでありうる。
# 項目ごとに型と範囲を確かめ、合わなければ既定値に置き換える。1 つの会議の壊れた控えで rebuild 全体（1 トランザクション）を止めない

def _load_snapshot(path: Path) -> dict[str, Any]:
    """meeting.json を読む。ない・読めない・最上位がオブジェクトでないときは空（控えなしとして復元する）。"""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _is_sqlite_epoch_ms(value: object) -> TypeGuard[int]:
    """確定 API と同じく 0 以上の整数で、SQLite INTEGER に収まるか（範囲外は insert で OverflowError）。"""
    # bool は int のサブクラスなので明示的に除く
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**63 - 1


def _int_or(value: object, default: int) -> int:
    """0 以上で SQLite INTEGER に収まる整数ならその値、そうでなければ default。"""
    return value if _is_sqlite_epoch_ms(value) else default


def _stop_metadata(meta: dict[str, Any]) -> tuple[str | None, int | None]:
    """meeting.json の停止理由と検出時刻を組で検証する。片方でも不正なら両方 None（Meeting の検証で rebuild 全体を止めない）。"""
    reason, detected = meta.get("stopReason"), meta.get("stopDetectedAtEpochMs")
    if reason in ("manual", "mic_ended") and _is_sqlite_epoch_ms(detected):
        return reason, detected
    return None, None


def _restored_status(meta: dict[str, Any]) -> str:
    """復元する会議の状態。確定時の控えには終了時刻が入る（値が不正でも、確定したことは分かる）。

    控えが作成時のまま（終了時刻なし）なら recording に戻す。ブラウザは未送信の Chunk と確定の要求をまだ持っていて、
    finalized にすると Chunk の PUT を 409 で断ってしまう（Recording-First）。確定は Phase 1 の Recovery がやり直す。
    控えそのものが読めない会議は、止まったままにしないよう finalized にする（serve が起動時にジョブを作る。Phase 2 §14）。
    """
    if meta and meta.get("endedAtEpochMs") is None:
        return "recording"
    return "finalized"


def _snapshot_chunks(meta: dict[str, Any]) -> dict[tuple[str, int], dict[str, Any]]:
    """控えの Chunk 一覧を (source, sequenceNo) で引けるようにする。形の合わない要素は捨てる。"""
    raw = meta.get("chunks")
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for c in raw if isinstance(raw, list) else []:
        if isinstance(c, dict) and c.get("source") in ("mic", "system") and _is_sqlite_epoch_ms(c.get("sequenceNo")):
            out[(c["source"], c["sequenceNo"])] = c
    return out


def _vad_score(value: object) -> float:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1
    return float(value) if ok else 0.0      # type: ignore[arg-type]


def rebuild(conn: sqlite3.Connection, data_dir: Path, codec: AudioCodec | None) -> RebuildReport:
    """recordings/{userId}/{meetingId}/ を走査し、DB にない会議と Chunk の行を作る。既存の行は上書きしない。

    呼び出すのは、そのデータディレクトリを使う serve がいないとき（`doctor --rebuild` はロックを取る。§22）か、
    serve 自身の起動時（DB の復元の直後。§22 build_context）だけ。動いているサーバーと並行すると、同じ Chunk の行を取り合う。
    """
    report = RebuildReport(skipped_files=[])
    recordings = data_dir / "recordings"
    if not recordings.exists():
        return report
    for meeting_dir in sorted(p for p in recordings.glob("*/*") if p.is_dir()):
        # 利用者はディレクトリの階層で決める（ファイルの置き場所と local_user_id を食い違わせない）
        user_id, meeting_id = meeting_dir.parent.name, meeting_dir.name
        meta = _load_snapshot(meeting_dir / "meeting.json")
        t = now_ms()
        if repo.get_meeting(conn, meeting_id) is None:
            stop_reason, stop_detected_at = _stop_metadata(meta)
            title, ended, frames = meta.get("title"), meta.get("endedAtEpochMs"), meta.get("totalAudioFrames")
            repo.insert_meeting(conn, Meeting(
                id=meeting_id, local_user_id=user_id, title=title if isinstance(title, str) and title else "復元された会議",
                status=_restored_status(meta),  # type: ignore[arg-type]
                session_start_epoch_ms=_int_or(meta.get("sessionStartEpochMs"), 0),
                native_sample_rate=_int_or(meta.get("nativeSampleRate"), 0), consent_confirmed_at=_int_or(meta.get("consentConfirmedAt"), 0),
                # 終了時刻のキーは全フェーズで endedAtEpochMs。不正な値（範囲外・整数でない）は None にする
                ended_at=ended if _is_sqlite_epoch_ms(ended) else None,
                total_audio_frames=frames if _is_sqlite_epoch_ms(frames) else None, created_at=t, updated_at=t,
                stop_reason=stop_reason, stop_detected_at=stop_detected_at,
            ))
            report.meetings_created += 1
        meta_chunks = _snapshot_chunks(meta)
        for source in ("mic", "system"):
            sdir = meeting_dir / source
            if not sdir.is_dir():
                continue
            for f in sorted(sdir.iterdir()):
                if f.suffix not in (".wav", ".flac", ".fake") or not f.stem.isdigit():
                    continue
                seq = int(f.stem)
                if repo.get_chunk_by_key(conn, meeting_id, source, seq) is not None:
                    continue
                restored = _chunk_from_file(f, codec)
                if restored is None:
                    report.skipped_files.append(str(f.relative_to(data_dir)))
                    continue
                sample_count, wav_sha, _ = restored
                mc = meta_chunks.get((source, seq), {})
                if isinstance(mc.get("sha256"), str) and mc["sha256"] != wav_sha:
                    report.skipped_files.append(str(f.relative_to(data_dir)))
                    continue
                # 控えに Chunk の時刻がなければ、30 秒の Chunk が隙間なく並んでいたと仮定する（Phase 1 §14 の Chunk 長）
                start = _int_or(mc.get("startOffsetMs"), seq * 30000)
                duration = int(sample_count / 16)
                has_voice = mc.get("hasVoice")
                repo.upsert_chunk(conn, AudioChunk(
                    id=repo.new_id(), meeting_id=meeting_id, source=source, sequence_no=seq,  # type: ignore[arg-type]
                    start_offset_ms=start, end_offset_ms=_int_or(mc.get("endOffsetMs"), start + duration), duration_ms=duration,
                    sample_count=sample_count, local_path=str(f.relative_to(data_dir)), size_bytes=f.stat().st_size, sha256=wav_sha,
                    # 有音かどうかが分からなければ有音として扱う（無音と決めつけて STT を省かない。Invariant 7）
                    vad_score=_vad_score(mc.get("vadScore")), has_voice=has_voice if isinstance(has_voice, bool) else True,
                    save_status="verified", created_at=t,
                    codec="wav" if f.suffix == ".wav" else ("flac" if f.suffix == ".flac" else "fake"),
                ))
                report.chunks_created += 1
        # DB にあるがファイルがない Chunk を missing に
        for c in repo.list_chunks(conn, meeting_id):
            if not (data_dir / c.local_path).exists() and c.save_status != "missing":
                repo.update_chunk(conn, c.id, save_status="missing")
                report.chunks_marked_missing += 1
    return report
```

---

# 19. 利用者と TLS `auth/`

```python
# minutes_local/auth/users.py
"""利用者とトークン。users が空なら単一利用者モード（token ファイル、user_id='local'）。§2.5。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3

from ..db.connection import now_ms
from ..db.models import User
from ..db.repo import _row, new_id

LOCAL_USER_ID = "local"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_user(conn: sqlite3.Connection, name: str) -> tuple[User, str]:
    """戻り値の token は 1 回しか表示しない。"""
    token = secrets.token_urlsafe(32)
    user = User(id=new_id(), name=name, token_hash=hash_token(token), created_at=now_ms())
    conn.execute("INSERT INTO users (id, name, token_hash, created_at) VALUES (?,?,?,?)", (user.id, user.name, user.token_hash, user.created_at))
    return user, token


def list_users(conn: sqlite3.Connection) -> list[User]:
    return [_row(User, r) for r in conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()]


def user_count(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"])


def find_user_by_token(conn: sqlite3.Connection, token: str) -> User | None:
    h = hash_token(token)
    for r in conn.execute("SELECT * FROM users").fetchall():
        if hmac.compare_digest(str(r["token_hash"]), h):
            return _row(User, r)
    return None


def delete_user(conn: sqlite3.Connection, user_id: str) -> bool:
    return conn.execute("DELETE FROM users WHERE id = ?", (user_id,)).rowcount == 1
```

```python
# minutes_local/auth/tls.py
"""自己署名証明書の生成。cryptography は extras（lan）。§2.5。"""
from __future__ import annotations

import datetime as dt
import ipaddress
from pathlib import Path


def generate_self_signed(cert_path: Path, key_path: Path, hostnames: list[str], days: int = 825) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostnames[0] if hostnames else "minutes-local")])
    sans: list[x509.GeneralName] = []
    for h in hostnames:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            sans.append(x509.DNSName(h))
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def certificate_hostnames(cert_path: Path) -> list[str]:
    from cryptography import x509
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return [str(v) for v in san.get_values_for_type(x509.DNSName)] + [str(v) for v in san.get_values_for_type(x509.IPAddress)]
```

---

# 20. API `api/`

## 20.1 認証と所有者照合 `api/app.py`（変更）

トークンを `user_id` に解決し、`/v1/meetings/{id}/...` と `/v1/jobs/{id}/...` の所有者を照合する。他人の会議は `404`。

```python
# minutes_local/api/app.py
"""FastAPI アプリ。Phase 2 の CORS・エラー応答の統一・アプリ配信に、Phase 3 で利用者認証と所有者照合を追加。"""
from __future__ import annotations

import hmac
import re
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from ..auth.users import LOCAL_USER_ID, find_user_by_token
from ..db import repo_phase3
from ..jobs.context import AppContext
from .common import error_body

CSP = (
    "default-src 'self'; connect-src 'self' http://127.0.0.1:43117 http://localhost:43117; "
    "worker-src 'self'; script-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
)
MEETING_PATH = re.compile(r"^/v1/meetings/([^/]+)(?:/|$)")
JOB_PATH = re.compile(r"^/v1/jobs/([^/]+)(?:/|$)")

# Vite の開発サーバー（Phase 1 §31.1）。Phase 1 §12 が CORS を許可する唯一の配信元
DEV_ORIGIN = "http://127.0.0.1:5173"
CORS_METHODS = ["GET", "POST", "PUT", "DELETE"]
# Authorization を付ける要求はすべて preflight になる。If-Match はノートの楽観ロック（§21.3）
CORS_HEADERS = ["Authorization", "Content-Type", "X-Chunk-SHA256", "X-Chunk-Meta", "If-Match"]


def create_app(ctx: AppContext, token: str) -> FastAPI:
    from . import routes_jobs, routes_meetings, routes_models, routes_phase1, routes_phase3, sse

    app = FastAPI(title="minutes-local", version=ctx.server_version, docs_url=None, redoc_url=None)
    app.state.ctx = ctx
    app.state.token = token

    @app.middleware("http")
    async def auth_and_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        path = request.url.path
        user_id = _resolve_user(request, ctx, token)
        request.state.authenticated = user_id is not None
        request.state.user_id = user_id or LOCAL_USER_ID
        # OPTIONS（preflight）はトークンを運べないので認証しない（Phase 1 §12）
        if path.startswith("/v1/") and path != "/v1/health" and request.method != "OPTIONS":
            if user_id is None:
                return JSONResponse(error_body("UNAUTHORIZED", "invalid or missing token"), status_code=401)
            denied = _ownership_denied(path, user_id, ctx)
            if denied:
                return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        try:
            response = await call_next(request)
        except Exception:
            # ブラウザ側は応答本文を ApiErrorBody として読む（Phase 1 §12）。スタックトレースや既定の HTML を返さない
            return JSONResponse(error_body("INTERNAL", "internal server error"), status_code=500)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    # 後から足したミドルウェアが外側になる。CORS を最も外側に置き、401・422・500・507 にも CORS ヘッダを付ける。
    # 付いていないと、ブラウザは応答を読めず原因を NETWORK と区別できない
    app.add_middleware(CORSMiddleware, allow_origins=[DEV_ORIGIN], allow_methods=CORS_METHODS, allow_headers=CORS_HEADERS)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        # FastAPI 既定の {"detail": [...]} ではなく、他のエラーと同じ形で返す
        return JSONResponse(error_body("VALIDATION", "invalid request"), status_code=422)

    app.include_router(routes_phase1.router)
    app.include_router(routes_meetings.router)
    app.include_router(routes_jobs.router)
    app.include_router(routes_models.router)
    app.include_router(routes_phase3.router)
    app.include_router(sse.router)
    # ブラウザアプリ（`npm run build` の出力）の配信。ルータより後に置き、/v1/ を覆わない。
    # 認証は /v1/ だけに掛かる（アプリ本体に秘密はなく、トークンは利用者が画面で入力する）
    web = ctx.settings.web_dir
    if web is not None and (web / "index.html").is_file():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    return request.cookies.get("minutes_token")


def _resolve_user(request: Request, ctx: AppContext, token: str) -> str | None:
    presented = _bearer(request)
    if presented is None:
        return None
    if ctx.multi_user:
        with ctx.db.read() as conn:
            user = find_user_by_token(conn, presented)
        return user.id if user is not None else None
    return LOCAL_USER_ID if hmac.compare_digest(presented, token) else None


def _ownership_denied(path: str, user_id: str, ctx: AppContext) -> bool:
    """存在する会議 / ジョブの所有者が異なるときだけ True。存在しないものはルータに任せる（404 は同じ）。"""
    m = MEETING_PATH.match(path)
    if m is not None:
        with ctx.db.read() as conn:
            owner = repo_phase3.meeting_owner(conn, m.group(1))
        return owner is not None and owner != user_id
    j = JOB_PATH.match(path)
    if j is not None:
        with ctx.db.read() as conn:
            owner = repo_phase3.job_owner(conn, j.group(1))
        return owner is not None and owner != user_id
    return False
```

## 20.2 Phase 1 互換ルート `api/routes_phase1.py`（変更）

変更点：(1) `POST /meetings` が `local_user_id` と `live_stt_enabled` を設定、(2) `PUT chunk` の保存先に利用者階層、登録後に Live フック、(3) `GET /chunks` が `missing` を `registered=false` で返す、(4) `finalize` が `meeting.json` を書く。レスポンス形状は不変。

```python
# minutes_local/api/routes_phase1.py
"""Phase 1 §12 の契約。形状は変更禁止、検証規則は Phase 2 §21.2 のまま。Phase 3 で利用者階層・Live フック・meeting.json・missing を追加。"""
from __future__ import annotations

import asyncio
import base64
import errno
import json
import math
import re
from typing import Any, Literal

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from ..db import repo
from ..db.connection import now_ms
from ..db.models import AudioChunk, Meeting
from ..jobs import live, pipeline
from ..jobs.context import AppContext
from ..storage.files import (InvalidWavError, chunk_relative_path, meeting_dir, parse_wav_header, read_pcm, sha256_hex,
                             write_atomic)
from ..storage.rebuild import write_meeting_json
from .common import error_body, get_ctx

router = APIRouter(prefix="/v1")

# meetingId はファイルパス（recordings/{meetingId}/…）に使うので形式を固定する。".." や区切り文字を通さない
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z")
# finalize 前の状態。これ以外の会議には新しい Chunk を足さず、確定値も書き換えない
OPEN_STATUSES = ("created", "recording", "finalizing")


class CreateMeetingRequest(BaseModel):
    meetingId: str
    title: str
    sessionStartEpochMs: int = Field(ge=0)
    nativeSampleRate: int = Field(gt=0)
    consentConfirmedAt: int = Field(ge=0)


class FinalizeRequest(BaseModel):
    expectedChunkCounts: dict[str, int]
    endedAtEpochMs: int = Field(ge=0)
    totalAudioFrames: int = Field(ge=0)
    stopReason: Literal["manual", "mic_ended"] | None = None
    stopDetectedAtEpochMs: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)  # SQLite INTEGER の上限（Phase 1 §12）

    @model_validator(mode="after")
    def validate_stop_observation(self) -> "FinalizeRequest":
        if (self.stopReason is None) != (self.stopDetectedAtEpochMs is None):
            raise ValueError("stopReason and stopDetectedAtEpochMs must be supplied together")
        return self


def _capabilities(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    hw, m, s = ctx.hardware, ctx.models, ctx.settings
    return {
        "service": "minutes-local", "version": ctx.server_version, "dataDir": str(s.data_dir),
        "freeDiskBytes": hw.free_disk_bytes,
        "gpu": {"available": hw.gpu.available, "name": hw.gpu.name, "vramBytes": hw.gpu.vram_bytes},
        "cpuCores": hw.cpu_cores, "totalMemoryBytes": hw.total_memory_bytes,
        "sttModel": m.stt.name if m.stt else None, "llmModel": m.llm, "maxConcurrentStt": m.max_concurrent_stt,
        "tier": m.tier,
        "availableSttModels": [
            {"name": n, "computeType": m.stt.compute_type if m.stt else "int8", "estimatedMemoryBytes": 0, "installed": True}
            for n in sorted(m.installed_stt)
        ],
        "availableLlmModels": [{"name": n, "parameterSizeB": None, "quantization": None, "estimatedMemoryBytes": None}
                               for n in m.available_llm],
        "ollamaReachable": m.ollama_reachable, "allowConcurrentSttAndLlm": m.allow_concurrent_stt_and_llm,
        # Phase 3
        "diarizationAvailable": ctx.diarization is not None, "languageDetectionAvailable": ctx.language is not None,
        "codec": ctx.codec.name if ctx.codec else None, "multiUser": ctx.multi_user, "tls": ctx.tls_enabled,
        "liveSttAllowed": live.live_allowed(ctx),
    }


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    body: dict[str, Any] = {"status": "ok", "service": "minutes-local"}
    if getattr(request.state, "authenticated", False):
        body["capabilities"] = _capabilities(request)
    return body


@router.post("/meetings")
async def create_meeting(req: CreateMeetingRequest, request: Request) -> JSONResponse:
    ctx = get_ctx(request)
    if not SAFE_ID.fullmatch(req.meetingId):
        return JSONResponse(error_body("VALIDATION", "invalid meetingId"), status_code=422)
    t = now_ms()
    m = Meeting(id=req.meetingId, local_user_id=request.state.user_id, title=req.title, status="recording",
                session_start_epoch_ms=req.sessionStartEpochMs, native_sample_rate=req.nativeSampleRate,
                consent_confirmed_at=req.consentConfirmedAt, created_at=t, updated_at=t)
    async with ctx.db.write() as conn:
        created = repo.insert_meeting(conn, m)
        if created:
            repo.update_meeting(conn, m.id, live_stt_enabled=int(live.default_live_enabled(ctx)))
        current = repo.get_meeting(conn, req.meetingId)
        chunks_now = repo.list_chunks(conn, req.meetingId)
    assert current is not None
    # 録音メタデータの控え（Phase 1 §13）。作成時に書き、再送時はファイルが失われているときだけ書き直す
    # （finalize 後の再送で、確定値を持つ meeting.json を作成時の内容へ戻さない）。
    # 書くときは finalize と同じ write_meeting_json で DB の会議行と Chunk から書く。作成時の要求から書くと、
    # 確定後に控えが失われて再送されたとき、確定値と Chunk 一覧のない控えに戻る
    rel = f"{meeting_dir(current.id, current.local_user_id)}/meeting.json"
    if created or not (ctx.settings.data_dir / rel).is_file():
        try:
            write_meeting_json(ctx.settings.data_dir, current, chunks_now)
        except OSError as e:
            if e.errno == errno.ENOSPC:
                return JSONResponse(error_body("INSUFFICIENT_STORAGE", "disk full"), status_code=507)
            raise
    body = {"meetingId": current.id, "status": current.status, "dataPath": meeting_dir(current.id, current.local_user_id)}
    return JSONResponse(body, status_code=201 if created else 200)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_meta(header: str, meeting_id: str, source: str, sequence_no: int, sample_count: int, sha: str, size: int) -> dict[str, Any]:
    """X-Chunk-Meta（Base64URL の JSON）を復号し、URL・WAV と食い違えば ValueError（→ 422）。

    メタデータは録音時刻の正なので、既定値で補わない。食い違ったまま登録すると transcript の時刻がずれる。
    """
    try:
        meta = json.loads(base64.urlsafe_b64decode(header + "=" * (-len(header) % 4)))
    except ValueError as e:      # binascii.Error / JSONDecodeError / UnicodeDecodeError はすべて ValueError の派生
        raise ValueError("invalid X-Chunk-Meta") from e
    if not isinstance(meta, dict):
        raise ValueError("metadata must be an object")
    if (meta.get("meetingId") != meeting_id or meta.get("source") != source
            or meta.get("sequenceNo") != sequence_no or meta.get("sampleCount") != sample_count):
        raise ValueError("metadata does not match URL or WAV")
    start, end = meta.get("startOffsetMs"), meta.get("endOffsetMs")
    if not _is_int(start) or not _is_int(end) or start < 0 or end < start:
        raise ValueError("invalid timing")
    # VAD の結果も既定値で補わない。hasVoice を True で補うと無音の Chunk まで文字起こしに回る（欠落は 422）
    score = meta.get("vadScore")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        raise ValueError("invalid vadScore")
    if not isinstance(meta.get("hasVoice"), bool):
        raise ValueError("invalid hasVoice")
    if (meta.get("sha256", sha) != sha or meta.get("sizeBytes", size) != size
            or meta.get("sampleRate", 16000) != 16000 or meta.get("channels", 1) != 1):
        raise ValueError("metadata does not match WAV")
    return meta


def _stored_chunk_intact(ctx: AppContext, chunk: AudioChunk) -> bool:
    """保存済みファイルを read_pcm で読み、WAV の sha256 まで一致するか。"""
    try:
        read_pcm(ctx.settings.data_dir, chunk.local_path, chunk.sha256, ctx.codec)
    except InvalidWavError:        # 欠損・sha256 不一致・復号の失敗（コーデックは失敗を ValueError で返し、read_pcm が包む）
        return False
    except OSError:                # 権限・照合中の削除など読めないファイルも欠損として修復へ進める（500 にしない。chunk_file_intact と同じ規則）
        return False
    return True


@router.put("/meetings/{meeting_id}/chunks/{source}/{sequence_no}")
async def put_chunk(meeting_id: str, source: str, sequence_no: int, request: Request,
                    x_chunk_sha256: str | None = Header(default=None),
                    x_chunk_meta: str | None = Header(default=None)) -> JSONResponse:
    ctx = get_ctx(request)
    if not SAFE_ID.fullmatch(meeting_id) or source not in ("mic", "system") or sequence_no < 0:
        return JSONResponse(error_body("VALIDATION", "invalid chunk key"), status_code=422)
    if (request.headers.get("content-type") != "audio/wav" or x_chunk_sha256 is None
            or not SHA256_HEX.fullmatch(x_chunk_sha256) or x_chunk_meta is None):
        return JSONResponse(error_body("VALIDATION", "invalid chunk headers"), status_code=422)
    data = await request.body()
    try:
        header = parse_wav_header(data)
    except InvalidWavError as e:
        return JSONResponse(error_body("VALIDATION", "invalid wav", str(e)), status_code=422)
    sha = sha256_hex(data)
    if x_chunk_sha256 != sha:
        return JSONResponse(error_body("VALIDATION", "sha256 header mismatch"), status_code=422)
    try:
        meta = _validate_meta(x_chunk_meta, meeting_id, source, sequence_no, header.sample_count, sha, len(data))
    except ValueError as e:
        return JSONResponse(error_body("VALIDATION", str(e)), status_code=422)

    with ctx.db.read() as conn:
        meeting = repo.get_meeting(conn, meeting_id)
        if meeting is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        existing = repo.get_chunk_by_key(conn, meeting_id, source, sequence_no)
    if existing is not None:
        if existing.sha256 != sha:
            return JSONResponse(error_body("CONFLICT_HASH_MISMATCH", "chunk exists with different content"), status_code=409)
        path = ctx.settings.data_dir / existing.local_path
        # 圧縮済み（codec != wav）も復号して WAV の sha256 と照合する（read_pcm と同じ検証）。存在だけを見ると壊れた控えを修復しない
        intact = path.is_file() and _stored_chunk_intact(ctx, existing)
        if not intact:
            # 修復・逆同期（§2.4）：登録済みだがファイルが失われた・壊れた。内容は同じ（sha256 一致）なので WAV として書き戻す。
            # 圧縮済みだった Chunk も WAV に戻る。確定後の会議でも受け付ける。
            # 照合の間に会議・Chunk が削除されていれば書き戻さない。削除は DB のコミット後に rmtree するので、
            # 書き込みロック下で確かめ直し、書き戻しもロックの中で行う（消えた録音を作り直さない。Phase 2 server §21.2 と同じ）
            rel = chunk_relative_path(meeting_id, source, sequence_no, meeting.local_user_id)
            repaired = {"local_path": rel, "codec": "wav", "sha256_flac": None, "size_bytes": len(data), "save_status": "registered"}
            async with ctx.db.write() as conn:
                current = repo.get_chunk_by_key(conn, meeting_id, source, sequence_no)
                if repo.get_meeting(conn, meeting_id) is None or current is None or current.id != existing.id:
                    return JSONResponse(error_body("NOT_FOUND", "chunk not found"), status_code=404)
                try:
                    write_atomic(ctx.settings.data_dir, rel, data)
                except OSError as e:
                    if e.errno == errno.ENOSPC:
                        return JSONResponse(error_body("INSUFFICIENT_STORAGE", "disk full"), status_code=507)
                    raise
                repo.update_chunk(conn, existing.id, **repaired)
            existing = existing.model_copy(update=repaired)
        elif existing.save_status == "missing":
            # ファイルは無事（手動で戻された等）なのに missing のままなら、印だけ直す
            async with ctx.db.write() as conn:
                repo.update_chunk(conn, existing.id, save_status="registered")
            existing = existing.model_copy(update={"save_status": "registered"})
        return JSONResponse(_chunk_response(existing), status_code=200)   # 冪等再送（Phase 2 基本設計 §11）
    if meeting.status not in OPEN_STATUSES:
        # 確定後の会議には新しい Chunk を足さない（登録済み Chunk の再送・修復は上で受け付け済み）
        return JSONResponse(error_body("CONFLICT_MEETING_FINALIZED", "meeting is already finalized"), status_code=409)

    rel = chunk_relative_path(meeting_id, source, sequence_no, meeting.local_user_id)
    try:
        write_atomic(ctx.settings.data_dir, rel, data)
    except OSError as e:
        if e.errno == errno.ENOSPC:
            return JSONResponse(error_body("INSUFFICIENT_STORAGE", "disk full"), status_code=507)
        raise
    duration_ms = round(header.sample_count / 16)
    chunk = AudioChunk(
        id=repo.new_id(), meeting_id=meeting_id, source=source, sequence_no=sequence_no,  # type: ignore[arg-type]
        start_offset_ms=meta["startOffsetMs"], end_offset_ms=meta["endOffsetMs"],
        duration_ms=duration_ms, sample_count=header.sample_count, local_path=rel, size_bytes=len(data), sha256=sha,
        vad_score=float(meta["vadScore"]), has_voice=meta["hasVoice"], created_at=now_ms(),
    )
    # 同期誤差サンプル（基本設計 §16.3.1）。frameClockDriftMs は Phase 1 の ChunkTimingMetadata に
    # 後から足した optional フィールドなので、欠落や非数値は 422 にせず無視する
    # （Phase 1 クライアントがそのまま Phase 2 サーバーに繋がる、§2 の後方互換）。
    drift = meta.get("frameClockDriftMs")
    wall_start = meta.get("wallClockStartEpochMs")
    sampled_at = (wall_start if _is_int(wall_start) else now_ms()) + duration_ms

    live_job: str | None = None
    async with ctx.db.write() as conn:
        # 読み取り後に finalize が確定させた場合に備え、書き込みロック下で状態を確かめ直す
        current = repo.get_meeting(conn, meeting_id)
        if current is None or current.status not in OPEN_STATUSES:
            return JSONResponse(error_body("CONFLICT_MEETING_FINALIZED", "meeting is already finalized"), status_code=409)
        stored = repo.upsert_chunk(conn, chunk)
        if isinstance(drift, (int, float)) and not isinstance(drift, bool) and math.isfinite(drift):
            # 冪等再送で重複しないよう INSERT OR IGNORE（UNIQUE (meeting_id, source, sequence_no)）
            repo.insert_sync_sample(conn, meeting_id, source, sequence_no, sampled_at, float(drift))
        if stored.id == chunk.id:
            live_job = live.on_chunk_registered(conn, ctx, meeting, stored)
    if live_job is not None:
        ctx.events.publish(meeting_id, {"type": "progress", "jobType": "live_transcribe_chunk", "done": 0, "total": 1})
    return JSONResponse(_chunk_response(stored), status_code=201 if stored.id == chunk.id else 200)


def _chunk_response(c: AudioChunk) -> dict[str, Any]:
    return {"meetingId": c.meeting_id, "source": c.source, "sequenceNo": c.sequence_no, "sha256": c.sha256,
            "sizeBytes": c.size_bytes, "path": c.local_path, "registered": c.save_status != "missing"}


@router.get("/meetings/{meeting_id}/chunks")
async def list_chunks(meeting_id: str, request: Request) -> Any:
    ctx = get_ctx(request)
    if not SAFE_ID.fullmatch(meeting_id):
        return JSONResponse(error_body("VALIDATION", "invalid meetingId"), status_code=422)
    with ctx.db.read() as conn:
        if repo.get_meeting(conn, meeting_id) is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        chunks = repo.list_chunks(conn, meeting_id)
    return {"meetingId": meeting_id, "chunks": [
        {"source": c.source, "sequenceNo": c.sequence_no, "sha256": c.sha256, "sizeBytes": c.size_bytes,
         "registered": c.save_status != "missing"}      # §2.4 逆同期：missing は registered=false
        for c in chunks]}


@router.post("/meetings/{meeting_id}/finalize")
async def finalize(meeting_id: str, req: FinalizeRequest, request: Request) -> Any:
    """Finalization Barrier のサーバー側：件数一致 + 連番の連続 + ファイル存在 + sha256 照合 → finalized → ジョブ生成。"""
    ctx = get_ctx(request)
    if (not SAFE_ID.fullmatch(meeting_id) or set(req.expectedChunkCounts) != {"mic", "system"}
            or any(v < 0 for v in req.expectedChunkCounts.values())):
        return JSONResponse(error_body("VALIDATION", "invalid finalize request"), status_code=422)
    with ctx.db.read() as conn:
        meeting = repo.get_meeting(conn, meeting_id)
        chunks = repo.list_chunks(conn, meeting_id)
    if meeting is None:
        return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
    counts = {"mic": 0, "system": 0}
    missing: list[str] = []
    for c in chunks:
        # sha256 の計算はファイル全体を読むので、イベントループを塞がないようスレッドで行う（書き込みトランザクションの前）
        if not await asyncio.to_thread(pipeline.chunk_file_intact, ctx.settings.data_dir, c):
            missing.append(f"{c.source}/{c.sequence_no}")
            continue
        counts[c.source] += 1
    # 件数不一致で 409 を返す前に missing を記録し、GET /chunks が registered=false を返せるようにする（§2.4 逆同期）
    async with ctx.db.write() as conn:
        for c in chunks:
            repo.update_chunk(conn, c.id, save_status="missing" if f"{c.source}/{c.sequence_no}" in missing else "verified")
    for source, expected in req.expectedChunkCounts.items():
        if counts.get(source, 0) != expected:
            return JSONResponse(error_body("CONFLICT_CHUNKS_MISSING", f"{source}: have {counts.get(source, 0)}, expected {expected}",
                                           ", ".join(missing) or None), status_code=409)
        # 件数が合っていても連番に穴があれば確定しない（0,1,3 の 3 件を「3 件そろった」と扱わない）
        seqs = sorted(c.sequence_no for c in chunks if c.source == source)
        if seqs != list(range(len(seqs))):
            return JSONResponse(error_body("CONFLICT_CHUNKS_MISSING", f"{source}: sequence gap"), status_code=409)
    # 件数が期待と合っていても、登録済みで欠損・破損した Chunk があれば確定しない（期待より多く登録されていて、余りが壊れた場合）
    if missing:
        return JSONResponse(error_body("CONFLICT_CHUNKS_MISSING", "missing or corrupted chunks", ", ".join(missing)), status_code=409)
    transitioned = False
    async with ctx.db.write() as conn:
        # 先に確定した値を正とする。書き込みロック下で状態と件数を確かめ直し、2 回目以降は更新しない
        current = repo.get_meeting(conn, meeting_id)
        # 照合の間に削除された会議を「確定した」と返さない（Phase 2 §21.2 と同じ）
        if current is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        if current.status in OPEN_STATUSES:
            if len(repo.list_chunks(conn, meeting_id)) != len(chunks):
                return JSONResponse(error_body("CONFLICT_CHUNKS_MISSING", "chunks changed during finalize"), status_code=409)
            repo.update_meeting(conn, meeting_id, status="finalized", ended_at=req.endedAtEpochMs, total_audio_frames=req.totalAudioFrames,
                                stop_reason=req.stopReason, stop_detected_at=req.stopDetectedAtEpochMs)
            pipeline.on_finalized(conn, meeting_id, ctx.diarization_active)
            transitioned = True
        snapshot = repo.get_meeting(conn, meeting_id)
        chunks_now = repo.list_chunks(conn, meeting_id)
    # 状態の遷移はコミット済みなので、控えの書き出しより先に通知する。書き出しが 507 で終わると、
    # 再送は transitioned が False になり、この遷移を通知する機会がなくなる（Phase 2 §21.2 と同じ）。
    # 再送（確定済み会議への 2 回目以降の POST）では状態を進めていないので通知しない。
    # 毎回 transcribing を流すと、completed の会議の画面が再送のたびに処理中へ戻る
    if transitioned and snapshot is not None:
        ctx.events.publish(meeting_id, {"type": "meeting_status", "status": snapshot.status})
    # コミット後に確定値から書き、meeting.json が DB より先行しないようにする。再送でも毎回書き直す（Phase 1 §12）
    if snapshot is not None:
        try:
            write_meeting_json(ctx.settings.data_dir, snapshot, chunks_now)
        except OSError as e:
            if e.errno == errno.ENOSPC:
                return JSONResponse(error_body("INSUFFICIENT_STORAGE", "disk full"), status_code=507)
            raise
    return {"meetingId": meeting_id, "status": "finalized", "registeredChunkCounts": counts}
```

## 20.3 会議ルート `api/routes_meetings.py`（変更）

変更点：(1) `GET /meetings` を利用者スコープに、(2) `GET /meetings/{id}` に `liveState` / `languageRatio` / `speakers` / `diarized`、(3) transcript に `speakerId` / `speakerName` / `language`、(4) `exclude-failed` は `routes_jobs.py`（変更禁止）が `pipeline.exclude_failed(conn, meeting_id)` を旧シグネチャで呼ぶため、`routes_jobs` を変更せずに済むよう `pipeline.exclude_failed` は `diarize` 引数を省略可にする（§8 のコードでは必須にしたので、§21 の後に示す互換ラッパで吸収する）。

```python
# minutes_local/api/routes_meetings.py
"""会議・transcript・summary・notes・settings。Phase 3 で利用者スコープ・Live 状態・話者・言語を追加。"""
from __future__ import annotations

import json
import shutil
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from ..db import repo, repo_phase3
from ..db.connection import now_ms
from ..jobs import live, pipeline
from ..jobs.selection import refresh_llm, refresh_stt
from ..storage.files import meeting_dir
from .common import MERGED_STATUSES, POST_FINALIZE_STATUSES, clean_settings, error_body, get_ctx

router = APIRouter(prefix="/v1")


class RerunRequest(BaseModel):
    sttModel: str | None = None


class NotesPutRequest(BaseModel):
    blocknoteJson: Any
    lastAppliedSummaryVersion: int | None = None


class SettingsPutRequest(BaseModel):
    language: str | None = None
    sttModel: str | None = None
    llmModel: str | None = None
    vadSamplingRatio: float | None = None
    liveSttEnabled: bool | None = None
    summaryLanguage: str | None = None
    diarizationEnabled: bool | None = None


@router.get("/meetings")
async def list_meetings(request: Request) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        ms = repo_phase3.list_meetings_for_user(conn, request.state.user_id)
    return {"meetings": [{"meetingId": m.id, "title": m.title, "status": m.status, "createdAt": m.created_at,
                          "transcriptVersion": m.transcript_version} for m in ms]}


@router.get("/meetings/{meeting_id}")
async def meeting_detail(meeting_id: str, request: Request) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        chunks = repo.list_chunks(conn, meeting_id)
        stt_counts = repo.count_chunks_by_stt(conn, meeting_id)
        latest = repo.latest_summary(conn, meeting_id)
        drift = repo.sync_drift_percentiles(conn, meeting_id)      # 基本設計 §16.3.1
        live_state = live.compute_live_state(conn, ctx, m, now_ms())
        speakers = repo_phase3.list_speakers(conn, meeting_id)
        diarized = repo.count_jobs(conn, meeting_id, "diarize_meeting", ["completed"]) > 0
    return {
        "meetingId": m.id, "title": m.title, "status": m.status,
        "chunkCounts": {"mic": sum(1 for c in chunks if c.source == "mic"), "system": sum(1 for c in chunks if c.source == "system")},
        "sttStatusCounts": stt_counts, "transcriptVersion": m.transcript_version,
        "latestSummaryVersion": latest.version if latest else None,
        "sttModelUsed": m.stt_model_used, "llmModelUsed": m.llm_model_used, "syncDriftMs": drift,
        # Phase 3
        "liveState": live_state, "liveSttEnabled": m.live_stt_enabled,
        "languageRatio": json.loads(m.language_ratio_json) if m.language_ratio_json else {},
        "speakers": [{"label": s.label, "name": s.name} for s in speakers], "diarized": diarized,
        "codecs": sorted({c.codec for c in chunks}),
    }


@router.delete("/meetings/{meeting_id}", status_code=204)
async def delete_meeting(meeting_id: str, request: Request) -> Response:
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        repo.delete_meeting(conn, meeting_id)
    shutil.rmtree(ctx.settings.data_dir / meeting_dir(meeting_id, m.local_user_id), ignore_errors=True)
    return Response(status_code=204)


@router.get("/meetings/{meeting_id}/transcript")
async def transcript(meeting_id: str, request: Request, version: int | None = None) -> Any:
    from ..merge.merger import render_lines
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        v = version if version is not None else m.transcript_version
        lines, gaps = render_lines(conn, meeting_id, v)
        seq_by_chunk = {c.id: c.sequence_no for c in repo.list_chunks(conn, meeting_id)}
        segs = {s.id: s for s in repo.list_segments(conn, meeting_id, merged_version=v)}
    return {
        "meetingId": meeting_id, "transcriptVersion": v,
        "segments": [{"id": ln.segment_id, "source": ln.source, "startMs": ln.start_ms, "endMs": ln.end_ms, "text": ln.text,
                      "confidence": segs[ln.segment_id].confidence, "language": ln.language,
                      "chunkSequenceNo": seq_by_chunk.get(segs[ln.segment_id].chunk_id, -1),
                      "speakerId": ln.speaker_id, "speakerName": ln.speaker_name} for ln in lines],
        "gaps": [{"source": g.source, "startMs": g.start_ms, "endMs": g.end_ms} for g in gaps],
    }


@router.get("/meetings/{meeting_id}/segments")
async def segments(meeting_id: str, request: Request, includeRejected: bool = False) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        segs = repo.list_segments(conn, meeting_id)
    if not includeRejected:
        segs = [s for s in segs if s.merged_version is not None]
    return {"meetingId": meeting_id, "segments": [s.model_dump() for s in segs]}


@router.get("/meetings/{meeting_id}/summary")
async def summary(meeting_id: str, request: Request, version: int | None = None) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        s = repo.latest_summary(conn, meeting_id, version)
    if s is None:
        return JSONResponse(error_body("NOT_FOUND", "summary not found"), status_code=404)
    return {"meetingId": meeting_id, "version": s.version, "summary": json.loads(s.result_json),
            "validation": json.loads(s.validation_json)}


@router.post("/meetings/{meeting_id}/summary/regenerate", status_code=202)
async def regenerate(meeting_id: str, request: Request) -> Any:
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None or m.transcript_version == 0:
            return JSONResponse(error_body("VALIDATION", "transcript not ready"), status_code=422)
        pipeline.request_regenerate_summary(conn, meeting_id)
        jobs = [j for j in repo.list_jobs(conn, meeting_id) if j.job_type == "synthesize_minutes"]
    return {"jobId": jobs[0].id if jobs else None}


@router.post("/meetings/{meeting_id}/transcript/rerun", status_code=202)
async def rerun(meeting_id: str, req: RerunRequest, request: Request) -> Any:
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        if m.status not in POST_FINALIZE_STATUSES:
            # 確定前（録音中）に通すと会議が transcribing に進み、以後の Chunk の PUT が「確定済み」の 409 になる
            return JSONResponse(error_body("VALIDATION", "meeting is not finalized"), status_code=422)
        if req.sttModel is not None and req.sttModel not in ctx.models.installed_stt:
            # 未配置のモデルで作り直すと、全 Chunk が MODEL_MISSING の待機に入る（既存の transcript は消した後）
            return JSONResponse(error_body("VALIDATION", "stt model is not installed"), status_code=422)
        n = pipeline.request_rerun_stt(conn, meeting_id, req.sttModel)
    return {"jobsCreated": n}


@router.get("/meetings/{meeting_id}/notes")
async def get_notes(meeting_id: str, request: Request) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        n = repo.get_notes(conn, meeting_id)
    if n is None:
        return {"meetingId": meeting_id, "blocknoteJson": None, "revision": 0, "lastAppliedSummaryVersion": None}
    return {"meetingId": meeting_id, "blocknoteJson": json.loads(n.blocknote_json), "revision": n.revision,
            "lastAppliedSummaryVersion": n.last_applied_summary_version}


@router.put("/meetings/{meeting_id}/notes")
async def put_notes(meeting_id: str, req: NotesPutRequest, request: Request,
                    if_match: str | None = Header(default=None)) -> Any:
    ctx = get_ctx(request)
    expected = int(if_match) if if_match and if_match.isdigit() else None
    async with ctx.db.write() as conn:
        if repo.get_meeting(conn, meeting_id) is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        n = repo.put_notes(conn, meeting_id, json.dumps(req.blocknoteJson, ensure_ascii=False), expected, req.lastAppliedSummaryVersion)
    if n is None:
        return JSONResponse(error_body("CONFLICT_HASH_MISMATCH", "revision mismatch"), status_code=409)
    return {"meetingId": meeting_id, "blocknoteJson": json.loads(n.blocknote_json), "revision": n.revision,
            "lastAppliedSummaryVersion": n.last_applied_summary_version}


@router.post("/meetings/{meeting_id}/chunks/{source}/{sequence_no}/transcribe", status_code=202)
async def transcribe_silent_chunk(meeting_id: str, source: str, sequence_no: int, request: Request) -> Any:
    """has_voice=0 の Chunk を手動で STT（基本設計 §13.2）。"""
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        m = repo.get_meeting(conn, meeting_id)
        c = repo.get_chunk_by_key(conn, meeting_id, source, sequence_no)
        if m is None or c is None:
            return JSONResponse(error_body("NOT_FOUND", "chunk not found"), status_code=404)
        if m.status not in MERGED_STATUSES:
            # merge の前（録音中・transcribing）は受けない。実行待ちの merge が、この Chunk の STT より先に走りうる
            return JSONResponse(error_body("VALIDATION", "transcript is not ready"), status_code=422)
        if c.stt_status != "skipped":
            # 対象は VAD が無音と判定した Chunk だけ。それ以外は transcribe ジョブが既にあり（一意制約）、
            # ジョブを作れないまま queued にすると、終端にならない Chunk が残って merge が永久に止まる
            return JSONResponse(error_body("VALIDATION", "chunk is not a skipped chunk"), status_code=422)
        job_id = repo.insert_job(conn, meeting_id, "transcribe_chunk", chunk_id=c.id)
        if job_id is None:
            return JSONResponse(error_body("VALIDATION", "chunk already has a transcribe job"), status_code=422)
        repo.update_chunk(conn, c.id, stt_status="queued", has_voice=True)
        # 完了済みの merge ジョブを消す。この Chunk の STT が終わると ensure_merge_job が作り直し、transcript の版が上がる。
        # 要約は自動では作り直さない（会議は transcribed に戻る。利用者が再生成を選ぶ）
        repo.delete_finished_job(conn, meeting_id, "merge_transcript")
        repo.record_metric(conn, "vad_manual_transcribe", 1, meeting_id=meeting_id)
    return {"jobId": job_id}


@router.put("/settings")
async def put_settings(req: SettingsPutRequest, request: Request) -> Any:
    ctx = get_ctx(request)
    values = {k: v for k, v in {
        "language": req.language, "stt_model": req.sttModel, "llm_model": req.llmModel, "vad_sampling_ratio": req.vadSamplingRatio,
        "live_stt_enabled": req.liveSttEnabled, "summary_language": req.summaryLanguage, "diarization_enabled": req.diarizationEnabled,
    }.items() if v is not None}
    error = clean_settings(values)      # 検査に通らなければ 1 つも保存しない
    if error is not None:
        return JSONResponse(error_body("VALIDATION", error), status_code=422)
    async with ctx.db.write() as conn:
        for k, v in values.items():
            repo.put_setting(conn, k, v)
    ctx.settings = ctx.settings.with_overrides(values)
    # モデルの指定を変えたら選定をやり直す（やり直さないと再起動するまで前のモデルで走る）
    if "stt_model" in values:
        refresh_stt(ctx)
    if "llm_model" in values:
        await refresh_llm(ctx)
    warnings: list[str] = []
    if values.get("live_stt_enabled") and ctx.models.tier in ("gpu_small", "cpu_only"):
        warnings.append("この区分では Live STT が録音に影響する可能性があります（§2.1）")
    return {"updated": sorted(values), "warnings": warnings}
```

## 20.4 Phase 3 ルート `api/routes_phase3.py`

```python
# minutes_local/api/routes_phase3.py
"""話者・Live・利用者・復旧。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..auth.users import list_users
from ..db import repo, repo_phase3
from ..db.connection import now_ms
from ..jobs import live
from .common import error_body, get_ctx

router = APIRouter(prefix="/v1")


class SpeakersPutRequest(BaseModel):
    speakers: list[dict[str, str | None]]   # [{label, name}]


class LivePutRequest(BaseModel):
    enabled: bool


@router.get("/meetings/{meeting_id}/speakers")
async def get_speakers(meeting_id: str, request: Request) -> Any:
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        if repo.get_meeting(conn, meeting_id) is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        labels = {r["speaker_id"] for r in conn.execute(
            "SELECT DISTINCT speaker_id FROM transcript_segments WHERE meeting_id = ? AND speaker_id IS NOT NULL", (meeting_id,)).fetchall()}
        names = {s.label: s.name for s in repo_phase3.list_speakers(conn, meeting_id)}
    return {"meetingId": meeting_id, "speakers": [{"label": lb, "name": names.get(lb)} for lb in sorted(labels | set(names))]}


@router.put("/meetings/{meeting_id}/speakers")
async def put_speakers(meeting_id: str, req: SpeakersPutRequest, request: Request) -> Any:
    """ラベル → 名前。名前は利用者が付ける（Invariant 9）。"""
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        if repo.get_meeting(conn, meeting_id) is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        for sp in req.speakers:
            label = sp.get("label")
            if not label:
                continue
            repo_phase3.upsert_speaker(conn, meeting_id, label, sp.get("name") or None)
        speakers = repo_phase3.list_speakers(conn, meeting_id)
    return {"meetingId": meeting_id, "speakers": [{"label": s.label, "name": s.name} for s in speakers]}


@router.get("/meetings/{meeting_id}/live")
async def get_live(meeting_id: str, request: Request, since: int = 0) -> Any:
    """未マージの生セグメント（Live Transcript ペイン用）。

    since は created_at（epoch ms）で、**境界を含む**（live_segments_since 参照）。
    返す cursor は取得したセグメントの最大 created_at なので、次回の呼び出しでは
    その 1 ミリ秒分が再送される。受信側は id で重複排除すること（クライアント側 §2.1）。
    """
    ctx = get_ctx(request)
    with ctx.db.read() as conn:
        m = repo.get_meeting(conn, meeting_id)
        if m is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        segs = repo_phase3.live_segments_since(conn, meeting_id, since)
        state = live.compute_live_state(conn, ctx, m, now_ms())
    return {"meetingId": meeting_id, "liveState": state,
            "segments": [{"id": s.id, "source": s.source, "startMs": s.start_ms, "endMs": s.end_ms, "text": s.text,
                          "language": s.language, "confidence": s.confidence, "createdAt": s.created_at} for s in segs],
            "cursor": max((s.created_at for s in segs), default=since)}


@router.put("/meetings/{meeting_id}/live")
async def put_live(meeting_id: str, req: LivePutRequest, request: Request) -> Any:
    ctx = get_ctx(request)
    async with ctx.db.write() as conn:
        if repo.get_meeting(conn, meeting_id) is None:
            return JSONResponse(error_body("NOT_FOUND", "meeting not found"), status_code=404)
        live.set_live_enabled(conn, meeting_id, req.enabled and live.live_allowed(ctx))
        m = repo.get_meeting(conn, meeting_id)
    return {"meetingId": meeting_id, "liveSttEnabled": bool(m and m.live_stt_enabled), "allowed": live.live_allowed(ctx)}


@router.get("/users/me")
async def me(request: Request) -> Any:
    ctx = get_ctx(request)
    uid = request.state.user_id
    name = "local"
    if ctx.multi_user:
        with ctx.db.read() as conn:
            names = {u.id: u.name for u in list_users(conn)}
        name = names.get(uid, uid)
    return {"userId": uid, "name": name, "multiUser": ctx.multi_user}
```

---

# 21. ジョブハンドラ `jobs/handlers.py`（変更）

追加：`handle_live_transcribe`、`handle_diarize`、`handle_compress`。変更：`handle_transcribe`（言語判定・Live 結果の再利用・言語比率）、`handle_summary`（要約言語・話者名付き入力）。

```python
# minutes_local/jobs/handlers.py
"""7 種のジョブ本体。ML 処理は db.write() の外で行い、結果の書き込みだけをトランザクションに入れる。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ..db import repo, repo_phase3
from ..db.connection import now_ms
from ..db.models import AudioChunk, Job, Segment, SummaryVersion
from ..diarization.provider import DiarizationRequest, SpeakerTurn
from ..llm.caveats import caveats_for
from ..llm.map_reduce import synthesize
from ..llm.prompts import MIXED_NOTE_EN, MIXED_NOTE_JA, PROMPT_VERSION
from ..llm.schema import MeetingSummary, SummaryValidationReport
from ..llm.validate import SegmentIndex, validate
from ..merge.merger import format_for_llm, render_lines, run_merge
from ..merge.normalize import normalize
from ..stt.confidence import confidence
from ..stt.language import LanguageGuess, resolve_chunk_language
from ..stt.overlap import build_input, to_absolute
from ..stt.provider import STTRequest, STTResult
from ..storage.files import InvalidWavError, build_wav, read_pcm, sha256_hex, write_atomic
from . import pipeline
from .context import AppContext
from .retry import InvalidAudioError, JobTimeoutError, ModelMissingError, ProviderUnreachableError
from .selection import refresh_llm, refresh_stt

DEFAULT_LLM_CTX_TOKENS = 8192


def read_chunk_pcm(ctx: AppContext, chunk: AudioChunk) -> bytes:
    """Chunk の PCM を読む。行を読んでからファイルを開くまでの間に圧縮（§2.4）がファイルを置き換えていたら、行を読み直して読む。

    読み直さないと、置き換わった直後の読み取りが「ファイルなし」で失敗し、呼び出し側が正常な Chunk を missing にする。
    パスが変わっていなければ本当の欠損・破損なので、InvalidWavError をそのまま返す。
    """
    try:
        return read_pcm(ctx.settings.data_dir, chunk.local_path, chunk.sha256, ctx.codec)
    except InvalidWavError:
        with ctx.db.read() as conn:
            fresh = repo.get_chunk(conn, chunk.id)
        if fresh is None or fresh.local_path == chunk.local_path:
            raise
        return read_pcm(ctx.settings.data_dir, fresh.local_path, fresh.sha256, ctx.codec)


def _stt_model_for(ctx: AppContext, meeting_id: str, conn) -> str | None:  # type: ignore[no-untyped-def]
    m = repo.get_meeting(conn, meeting_id)
    if m is not None and m.stt_model_used:
        return m.stt_model_used
    return ctx.models.stt.name if ctx.models.stt else None


# ---- vad ----

async def handle_vad(ctx: AppContext, job: Job) -> str | None:
    with ctx.db.read() as conn:
        chunk = pipeline.job_of_chunk(conn, job)
    if ctx.vad is None:
        # モデル未配置：ブラウザ側の has_voice をそのまま採用し、vad_source は browser_rms のまま。
        # 例外を投げずに戻るので runner は processing_jobs.status を completed にし、Phase 2 基本設計 §9.5 の
        # transcribe_chunk 生成へ進む。skipped は audio_chunks.stt_status 専用の値であり、
        # processing_jobs.status には存在しない（Phase 2 基本設計 §13.1）。
        async with ctx.db.write() as conn:
            pipeline.on_vad_completed(conn, chunk, chunk.has_voice, _stt_model_for(ctx, job.meeting_id, conn), ctx.diarization_active)
        return None
    try:
        pcm = read_chunk_pcm(ctx, chunk)
    except InvalidWavError as e:
        async with ctx.db.write() as conn:
            repo.update_chunk(conn, chunk.id, save_status="missing")
        raise InvalidAudioError(str(e)) from e
    result = await asyncio.to_thread(ctx.vad.detect, pcm)
    async with ctx.db.write() as conn:
        repo.update_chunk(conn, chunk.id, has_voice=result.has_voice, server_vad_score=result.voiced_ratio, vad_source="server_silero")
        pipeline.on_vad_completed(conn, chunk, result.has_voice, _stt_model_for(ctx, job.meeting_id, conn), ctx.diarization_active)
    return None


# ---- STT 共通 ----

async def _run_stt(ctx: AppContext, job: Job, chunk: AudioChunk, *, with_overlap: bool) -> tuple[STTResult, int, str, str, LanguageGuess | None]:
    """(結果, prefix_ms, モデル名, 使用言語, 判定結果)。"""
    with ctx.db.read() as conn:
        meeting = repo.get_meeting(conn, job.meeting_id)
        prev = repo.get_chunk_by_key(conn, chunk.meeting_id, chunk.source, chunk.sequence_no - 1) if with_overlap else None
    if meeting is None:
        raise InvalidAudioError("meeting missing")
    if ctx.models.stt is None:
        refresh_stt(ctx)   # 起動後に配置・取得したモデルを拾う。起動時の選定のままだと、再起動するまで待ち続ける
    model_name = job.model_name or meeting.stt_model_used or (ctx.models.stt.name if ctx.models.stt else None)
    if model_name is None:
        raise ModelMissingError("no STT model available")
    compute = ctx.models.stt.compute_type if ctx.models.stt else "int8"
    device = ctx.models.stt.device if ctx.models.stt else "cpu"
    try:
        pcm = read_chunk_pcm(ctx, chunk)
        prev_pcm = read_chunk_pcm(ctx, prev) if prev is not None else None
    except InvalidWavError as e:
        async with ctx.db.write() as conn:
            repo.update_chunk(conn, chunk.id, save_status="missing")
        raise InvalidAudioError(str(e)) from e

    th = ctx.settings.thresholds
    stt_input, prefix_ms = build_input(prev_pcm, pcm, th.overlap_ms)

    # 言語（§2.3）：auto なら Chunk ごとに判定
    guess: LanguageGuess | None = None
    primary, _ = repo_phase3.primary_language(json.loads(meeting.language_ratio_json) if meeting.language_ratio_json else {})
    if ctx.settings.language == "auto" and ctx.language is not None:
        guess = await asyncio.to_thread(ctx.language.detect, pcm)
    language, _reason = resolve_chunk_language(ctx.settings.language, guess, primary, th.language_min_prob)

    factor = th.stt_timeout_factor_cpu if ctx.models.tier == "cpu_only" else th.stt_timeout_factor_gpu
    timeout_s = max(30.0, chunk.duration_ms / 1000 * factor)
    req = STTRequest(pcm=stt_input, model_name=model_name, compute_type=compute, device=device, models_dir=str(ctx.settings.models_dir),
                     language=language, beam_size=1 if ctx.models.tier == "cpu_only" else 5)
    try:
        result = await ctx.stt.transcribe(req, timeout_s)
    except asyncio.TimeoutError as e:
        raise JobTimeoutError(f"stt timeout after {timeout_s:.0f}s") from e
    return result, prefix_ms, model_name, language, guess


def _segments_from(result: STTResult, chunk: AudioChunk, prefix_ms: int, language: str) -> list[Segment]:
    t = now_ms()
    absolute = to_absolute(result.segments, chunk.start_offset_ms, prefix_ms)
    return [
        Segment(id=repo.new_id(), meeting_id=chunk.meeting_id, chunk_id=chunk.id, source=chunk.source, segment_index=i,
                start_ms=a.start_ms, end_ms=a.end_ms, text=a.text, normalized_text=normalize(a.text),
                language=result.language or language, confidence=confidence(a.avg_logprob, a.no_speech_prob),
                no_speech_prob=a.no_speech_prob, created_at=t)
        for i, a in enumerate(absolute)
    ]


async def handle_transcribe(ctx: AppContext, job: Job) -> str | None:
    with ctx.db.read() as conn:
        chunk = pipeline.job_of_chunk(conn, job)
        existing = repo_phase3.segments_of_chunk(conn, chunk.id)
        meeting = repo.get_meeting(conn, job.meeting_id)
    if existing:
        # Live STT の結果を再利用（§2.1）。完了にするのは lease の現行の所有者だけ（Phase 2 基本設計 §9.3）
        async with ctx.db.write() as conn:
            if not repo.lease_is_current(conn, job.id, job.lease_owner or "", job.attempts):
                return None
            pipeline.on_transcribe_completed(conn, chunk, ctx.diarization_active)
            repo.record_metric(conn, "stt_reused_live", 1, meeting_id=chunk.meeting_id)
        return None
    result, prefix_ms, model_name, language, guess = await _run_stt(ctx, job, chunk, with_overlap=True)
    segments = _segments_from(result, chunk, prefix_ms, language)
    async with ctx.db.write() as conn:
        # lease が失効していれば書かず、以降の集計と完了処理も行わない（Phase 2 基本設計 §9.3）。
        # 書いた件数では判定しない。無音で segments が空だと失効していても 0 件になり、旧ワーカーが Chunk を完了にしてしまう
        if not repo.lease_is_current(conn, job.id, job.lease_owner or "", job.attempts):
            return model_name
        repo.insert_segments(conn, segments, job_id=job.id, owner=job.lease_owner or "", attempts=job.attempts)
        if meeting is not None and meeting.stt_model_used is None:
            repo.update_meeting(conn, chunk.meeting_id, stt_model_used=model_name)
        repo.record_metric(conn, "stt_seconds", chunk.duration_ms / 1000, model_name=model_name, meeting_id=chunk.meeting_id)
        if result.model_load_ms:
            repo.record_metric(conn, "stt_model_load_ms", result.model_load_ms, model_name=model_name)
        if guess is not None:
            repo.record_metric(conn, "language_prob", guess.probability, meeting_id=chunk.meeting_id)
        repo_phase3.save_language_ratio(conn, chunk.meeting_id, repo_phase3.language_ratio(conn, chunk.meeting_id))
        pipeline.on_transcribe_completed(conn, chunk, ctx.diarization_active)
    return model_name


async def handle_live_transcribe(ctx: AppContext, job: Job) -> str | None:
    """Overlap なし・確定パイプラインに影響しない（chunk.stt_status は触らない）。"""
    with ctx.db.read() as conn:
        chunk = pipeline.job_of_chunk(conn, job)
        if repo_phase3.segments_of_chunk(conn, chunk.id):
            return None
    result, prefix_ms, model_name, language, _ = await _run_stt(ctx, job, chunk, with_overlap=False)
    segments = _segments_from(result, chunk, prefix_ms, language)
    async with ctx.db.write() as conn:
        # 確定 STT と同じ fencing（Phase 2 基本設計 §9.3）。失効したワーカーの結果は書かず、SSE にも流さない。
        if not repo.lease_is_current(conn, job.id, job.lease_owner or "", job.attempts):
            return model_name
        repo.insert_segments(conn, segments, job_id=job.id, owner=job.lease_owner or "", attempts=job.attempts)
        repo.record_metric(conn, "live_lag_ms", now_ms() - chunk.created_at, meeting_id=chunk.meeting_id)
    for s in segments:
        ctx.events.publish(chunk.meeting_id, {"type": "live_segment", "segment": {
            "id": s.id, "source": s.source, "startMs": s.start_ms, "endMs": s.end_ms, "text": s.text,
            "language": s.language, "confidence": s.confidence, "createdAt": s.created_at}})
    return model_name


# ---- 話者分離 ----

def _assign_speakers(segments: list[Segment], turns: tuple[SpeakerTurn, ...]) -> list[tuple[str, str | None, float | None]]:
    out: list[tuple[str, str | None, float | None]] = []
    by_source: dict[str, list[SpeakerTurn]] = {}
    for t in turns:
        by_source.setdefault(t.source, []).append(t)
    for s in segments:
        best: SpeakerTurn | None = None
        best_overlap = 0
        for t in by_source.get(s.source, []):
            ov = min(s.end_ms, t.end_ms) - max(s.start_ms, t.start_ms)
            if ov > best_overlap:
                best, best_overlap = t, ov
        out.append((s.id, best.label if best else None, best.confidence if best else None))
    return out


async def handle_diarize(ctx: AppContext, job: Job) -> str | None:
    if ctx.diarization is None:
        raise ModelMissingError("diarization provider not available")
    with ctx.db.read() as conn:
        chunks = repo.list_chunks(conn, job.meeting_id)
        segments = repo.list_segments(conn, job.meeting_id)
    pcm_by_source: dict[str, list[tuple[int, bytes]]] = {}
    for c in chunks:
        if c.stt_status != "completed":
            continue
        try:
            pcm = read_chunk_pcm(ctx, c)
        except InvalidWavError:
            continue
        pcm_by_source.setdefault(c.source, []).append((c.start_offset_ms, pcm))
    req = DiarizationRequest(meeting_id=job.meeting_id, pcm_by_source=pcm_by_source, models_dir=str(ctx.settings.models_dir),
                             work_dir=str(ctx.settings.tmp_dir))
    result = await asyncio.to_thread(ctx.diarization.diarize, req)
    assignments = _assign_speakers(segments, result.turns)
    async with ctx.db.write() as conn:
        for sid, label, conf in assignments:
            repo_phase3.set_segment_speaker(conn, sid, label, conf)
        for label in sorted({lb for _, lb, _ in assignments if lb}):
            conn.execute("INSERT OR IGNORE INTO meeting_speakers (meeting_id, label, name, updated_at) VALUES (?,?,NULL,?)",
                         (job.meeting_id, label, now_ms()))
        repo.record_metric(conn, "diarize_duration_ms", result.duration_ms, meeting_id=job.meeting_id)
        repo.record_metric(conn, "diarize_speakers", result.speaker_count, meeting_id=job.meeting_id)
    return None


# ---- merge / summary ----

async def handle_merge(ctx: AppContext, job: Job) -> str | None:
    async with ctx.db.write() as conn:
        report = run_merge(conn, job.meeting_id, ctx.settings.thresholds)
        pipeline.on_merge_completed(conn, job.meeting_id)
        repo.record_metric(conn, "merge_echo", report.echo, meeting_id=job.meeting_id)
    ctx.events.publish(job.meeting_id, {"type": "transcript_version", "transcriptVersion": report.transcript_version})
    return None


def _summary_language(ctx: AppContext, ratio: dict[str, float]) -> tuple[str, bool]:
    """(要約言語, 混在フラグ)。§2.3。"""
    primary, share = repo_phase3.primary_language(ratio)
    th = ctx.settings.thresholds
    if primary in ("ja", "en") and share >= th.language_dominant_ratio:
        return primary, False
    if not ratio:
        return ("en" if ctx.settings.language == "en" else "ja"), False
    lang = ctx.settings.summary_language if ctx.settings.summary_language in ("ja", "en") else "ja"
    return lang, True


async def handle_summary(ctx: AppContext, job: Job) -> str | None:
    await refresh_llm(ctx)   # サーバーより後に起動した Ollama・後から pull したモデルを拾う（/api/tags を 1 回、期限 2 秒）
    llm_model = ctx.models.llm
    if llm_model is None:
        if not ctx.models.ollama_reachable:
            raise ProviderUnreachableError("ollama not reachable")
        raise ModelMissingError("no LLM model available")
    with ctx.db.read() as conn:
        meeting = repo.get_meeting(conn, job.meeting_id)
        if meeting is None:
            raise InvalidAudioError("meeting missing")
        lines, gaps = render_lines(conn, job.meeting_id, meeting.transcript_version)
        seg_texts = {ln.segment_id: ln.text for ln in lines}
    ratio = json.loads(meeting.language_ratio_json) if meeting.language_ratio_json else {}
    language, mixed = _summary_language(ctx, ratio)
    text = format_for_llm(lines, gaps)
    if mixed:
        text = (MIXED_NOTE_EN if language == "en" else MIXED_NOTE_JA) + "\n" + text
    th = ctx.settings.thresholds
    synth = await synthesize(ctx.llm, llm_model, language, text, DEFAULT_LLM_CTX_TOKENS, th.llm_ctx_fill_ratio)

    index = SegmentIndex(seg_texts)
    accepted, rejected, unresolved = validate(synth.draft, index)
    total = len(synth.draft.topics) + len(synth.draft.decisions) + len(synth.draft.actionItems)
    t = now_ms()
    summary = MeetingSummary(
        **accepted.model_dump(), rejected=rejected, modelName=llm_model, promptVersion=PROMPT_VERSION,
        transcriptVersion=meeting.transcript_version, generatedAt=t,
        modelCaveats=caveats_for(meeting.stt_model_used, llm_model),
    )
    report = SummaryValidationReport(schemaValid=True, schemaRetries=synth.schema_retries, mapWindows=synth.map_windows,
                                     totalItems=total, rejectedItems=len(rejected), unresolvedSegmentIds=unresolved)
    async with ctx.db.write() as conn:
        version = repo.next_summary_version(conn, job.meeting_id)
        repo.insert_summary(conn, SummaryVersion(
            id=repo.new_id(), meeting_id=job.meeting_id, version=version, transcript_version=meeting.transcript_version,
            model_name=llm_model, prompt_version=PROMPT_VERSION, result_json=summary.model_dump_json(),
            raw_response_json=synth.raw, validation_json=report.model_dump_json(), generated_at=t,
        ))
        repo.update_meeting(conn, job.meeting_id, llm_model_used=llm_model, summary_language=language)
        repo.record_metric(conn, "llm_schema_fail", synth.schema_retries, model_name=llm_model, meeting_id=job.meeting_id)
        pipeline.on_summary_completed(conn, job.meeting_id)
    ctx.events.publish(job.meeting_id, {"type": "summary_version", "version": version})
    return llm_model


# ---- 圧縮 ----

async def handle_compress(ctx: AppContext, job: Job) -> str | None:
    """WAV → コーデック。復元して WAV sha256 が一致したときだけ WAV を消す（§2.4）。"""
    codec = ctx.codec
    if codec is None:
        raise ModelMissingError("codec not available")
    with ctx.db.read() as conn:
        chunk = pipeline.job_of_chunk(conn, job)
    if chunk.codec != "wav":
        # 切り替えのコミット後・WAV の削除前に落ちた回のやり直し。残っている WAV を消す（圧縮済みが正なので、消してよい）
        (ctx.settings.data_dir / chunk.local_path).with_suffix(".wav").unlink(missing_ok=True)
        return codec.name
    wav_path = ctx.settings.data_dir / chunk.local_path
    if not wav_path.exists():
        raise InvalidAudioError(f"wav missing: {chunk.local_path}")
    try:
        pcm = read_pcm(ctx.settings.data_dir, chunk.local_path, chunk.sha256, None)
    except InvalidWavError as e:
        raise InvalidAudioError(str(e)) from e          # 壊れた WAV は圧縮しない（再試行しても直らない）
    encoded = await asyncio.to_thread(codec.encode, pcm)
    restored = await asyncio.to_thread(codec.decode, encoded)
    if sha256_hex(build_wav(restored)) != chunk.sha256:
        raise InvalidAudioError("round-trip mismatch; keeping wav")
    new_rel = str(Path(chunk.local_path).with_suffix(codec.extension))
    new_path = write_atomic(ctx.settings.data_dir, new_rel, encoded)
    saved_bytes = wav_path.stat().st_size - len(encoded)
    async with ctx.db.write() as conn:
        # 切り替えるのは lease の現行の所有者だけ（Phase 2 基本設計 §9.3）。STT の再実行はジョブを行ごと消し（§8）、
        # 再 PUT の修復は Chunk を書き戻す。どちらかが先に起きていたら WAV のまま残し、作った圧縮ファイルを消す
        current = repo.get_chunk(conn, chunk.id)
        if (not repo.lease_is_current(conn, job.id, job.lease_owner or "", job.attempts)
                or current is None or current.local_path != chunk.local_path or current.sha256 != chunk.sha256):
            new_path.unlink(missing_ok=True)
            return codec.name
        repo.update_chunk(conn, chunk.id, local_path=new_rel, codec=codec.name, sha256_flac=sha256_hex(encoded), size_bytes=len(encoded))
        repo.record_metric(conn, "compress_saved_bytes", saved_bytes, meeting_id=chunk.meeting_id)
    wav_path.unlink(missing_ok=True)
    return codec.name


HANDLERS = {
    "vad_chunk": handle_vad,
    "transcribe_chunk": handle_transcribe,
    "live_transcribe_chunk": handle_live_transcribe,
    "diarize_meeting": handle_diarize,
    "merge_transcript": handle_merge,
    "synthesize_minutes": handle_summary,
    "compress_chunk": handle_compress,
}
```

`routes_jobs.py`（変更禁止）は `pipeline.exclude_failed(conn, meeting_id)` を 2 引数で呼ぶ。§8 の `exclude_failed` は `diarize` を必須にしたため、互換のため既定値を持たせる。§8 のコードは次の 1 行を差し替えたものとする。

```text
def exclude_failed(conn: sqlite3.Connection, meeting_id: str, diarize: bool = False) -> int:
```

`diarize=False` で呼ばれた場合、話者分離が有効でも `merge_transcript` が直接生成される（`INSERT OR IGNORE` で `diarize_meeting` は生成されない）。除外操作は利用者の明示的判断なので、この経路では話者分離を省略する挙動を仕様とする。

---

# 22. 起動処理 `bootstrap.py`（変更）と CLI `__main__.py`（変更）

Phase 2 §22 からの変更点。

| 場面 | 動作 |
| --- | --- |
| `build_context`：DB が壊れている | `open_database_with_recovery` が退避と復元を行い（§17）、マイグレーションの後で `rebuild` が録音ファイルから行を作り直す（§18）。結果は `AppContext.recovery`。正常なら `None` |
| `serve` | ロック → 一時ディレクトリ（`{dataDir}/tmp`）を空にする → `build_context` → 復旧していれば警告を標準エラーに出す → 以降は Phase 2 と同じ（bind → トークン → sweep → `resume_finalized` → Runner・Sweeper・定期処理のループ）。復旧で `finalized` に戻った会議は `resume_finalized` がジョブを作る |
| `doctor`（serve が動いていない） | ロックを取り、`build_context(recover=True)`。壊れた DB はここでも復旧する |
| `doctor`（serve が動いている） | ロックが取れないので `build_context(recover=False)`。使用中の DB を退避・復元しない。DB が開けなければ「サーバーを再起動して復旧する」と出して終了コード 1 |
| `doctor --rebuild` | ロックが取れなければ何もせず終了コード 1（「サーバーを止めてから」）。取れたら `rebuild` を実行して件数を出す |
| `doctor --init-tls [--host …]` | 証明書を作って終了する（DB もロックも触らない）。既存の証明書は上書きする（端末側の受け入れはやり直しになる） |
| `user add <name>` | 同名は終了コード 1（トレースバックにしない）。最初の 1 人のときは、再起動で複数利用者に切り替わること・`token` ファイルが使えなくなること・既存の会議が見えなくなることを表示する（§2.5） |
| `user remove <id>` | 利用者を削除する。トークンは次の要求から通らない。会議と録音は消さない。最後の 1 人のときは、再起動で単一利用者に戻ることを表示する。該当なしは終了コード 1 |

```python
# minutes_local/bootstrap.py
"""AppContext の組み立て。Phase 3 で integrity_check / Phase 3 マイグレーション / 新 Provider / 利用者モードを追加。"""
from __future__ import annotations

import csv
import os
import re
import secrets
import socket
import subprocess
import sys
from pathlib import Path

from .auth.users import user_count
from .config import Settings
from .db import repo
from .db.connection import Database
from .db.migrate import migrate
from .db.migrations_phase3 import apply_phase3
from .diarization.provider import DiarizationProvider
from .hw.detect import Hardware, detect
from .jobs.context import AppContext
from .jobs.selection import select_models
from .llm.provider import SummaryProvider
from .storage import backup
from .storage.codec import AudioCodec
from .storage.rebuild import rebuild
from .stt.executor import InlineExecutor, PoolExecutor, STTExecutor
from .stt.language import LanguageDetector
from .stt.provider import STTProvider
from .storage.models_dir import silero_model_path
from .vad.provider import VADProvider


def rotate_token(path: Path) -> str:
    """32 バイトの乱数トークンを作り直して 0600 で書く。`serve` が起動のたびに呼ぶ（Phase 1 §4.3 の短命性）。

    作成時点から 0600 にする（write_text の後で chmod すると、その間だけ他者が読める）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        # 既存ファイルの権限が緩かった場合も締める。Windows の Python 3.12 以前には fchmod がないのでパスで行う
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        else:
            os.chmod(path, 0o600)
        os.write(fd, token.encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return token


def bind_listen_socket(host: str, port: int) -> socket.socket:
    """待ち受けポートを確保する。`serve` はこれが成功してからトークンを作り直す（Phase 2 §22 と同じ）。

    先にトークンを書くと、ポートが使用中で起動に失敗したとき、動いている既存のサーバーが受け付けるトークンと
    ファイル（`minutes-local token` の表示）が食い違う。確保できなければ OSError（EADDRINUSE など）を送出する。
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    return socket.create_server((host, port), family=family)


def read_token(path: Path) -> str | None:
    """現在のトークン。`token` コマンド用。サーバーを一度も起動していなければ None。"""
    if not path.is_file():
        return None
    return path.read_text(encoding="ascii").strip() or None


def open_database_with_recovery(settings: Settings) -> tuple[Database, backup.Recovery | None]:
    """integrity_check に失敗したら、壊れた DB を退避し、直近のバックアップ（なければ空の DB）で開く（§2.4）。

    壊れていなければ 2 番目は None。使えるバックアップがなくても起動は止めない。サーバーが動いていなければブラウザは
    Chunk を送れず、録音ファイルが残っていれば会議は作り直せる（Invariant 10）。作り直しは build_context が行う。
    """
    if backup.integrity_ok(settings.db_path):
        return Database(settings.db_path), None
    restored = backup.restore_latest(settings.db_path, settings.backups_dir)
    return Database(settings.db_path), backup.Recovery(restored_from=restored)


def _default_codec() -> AudioCodec | None:
    try:
        import soundfile  # type: ignore[import-not-found]  # noqa: F401
    except ImportError:
        return None
    from .storage.codec import FlacCodec
    return FlacCodec()


def restrict_to_current_user(path: Path) -> None:
    """ディレクトリを現在の OS ユーザーだけが使えるようにする（録音・トークン・DB を置く）。

    Unix は 0700。Windows の os.chmod は読み取り専用属性しか変えず ACL に効かないので、icacls で設定する。
    1. 先にルートの継承を外し（/inheritance:r）、現在のユーザーの SID にだけフルコントロールを与える（(OI)(CI) で配下へ継承）。
       ここから後の操作は権限を狭める方向だけになる。
    2. 既存の配下を 1 件ずつ /reset で継承に戻す（ディレクトリは /T で再帰、ファイルは単体）。/inheritance:r は
       継承した ACE しか外さず、他の主体へ明示的に与えた ACE が配下に残るため（Windows は既定で走査チェックを省くので、
       配下のファイルは親を読めなくてもパス指定で開ける）。戻した配下はルートの SID の ACE だけを継承する。
       ルートには /reset も再帰の操作もかけない。かけると親の継承が戻り、失敗・中断したときに前より緩い状態で残る。
    /C（エラーを無視して続行）は付けない。1 つでも設定できなければ例外にする（1 が失敗すれば配下に触らない。2 の途中で
    止まってもルートは締めたまま）。ルート自身に他の主体への明示 ACE が付いていれば残るが、サーバーが作ったディレクトリに
    それを付けられるのは所有者か管理者だけで、その相手には ACL を掃除しても防げない。
    付与先を名前や Administrators でなくトークンのユーザー SID にするのは、管理者として昇格して起動しても
    付与先が変わらず、昇格せずに起動したときに本人が締め出されないため（昇格時の既定の所有者は Administrators になりうる）。
    ACL を設定できなければ例外で起動を止める（緩い権限のまま録音を置かない）。
    """
    if not sys.platform.startswith("win"):
        os.chmod(path, 0o700)
        return
    system32 = Path(os.environ.get("SystemRoot", "C:\\Windows")) / "System32"
    # PATH 上の同名の実行ファイルを拾わないよう、System32 の絶対パスで呼ぶ
    out = subprocess.run([str(system32 / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
                         check=True, capture_output=True, text=True).stdout
    row = next(csv.reader([out.strip()]), [])
    sid = row[1] if len(row) == 2 else ""
    if not re.fullmatch(r"S-1-\d+(-\d+)+", sid):
        raise RuntimeError(f"cannot determine current user SID: {out.strip()!r}")
    icacls = str(system32 / "icacls.exe")
    subprocess.run([icacls, str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
                   check=True, capture_output=True, text=True)
    for entry in sorted(os.scandir(path), key=lambda e: e.name):
        recurse = ["/T"] if entry.is_dir(follow_symlinks=False) else []
        subprocess.run([icacls, entry.path, "/reset", *recurse, "/Q"], check=True, capture_output=True, text=True)


def acquire_data_dir_lock(data_dir: Path) -> int | None:
    """データディレクトリを使う serve を 1 つに限る。取れたらロックを持つ fd、他の serve が持っていれば None。

    ポートの確保だけでは、別のポートで起動した 2 つ目の serve が同じデータディレクトリのトークンを作り直し、
    動いている 1 つ目のサーバーのトークンと `token` の表示が食い違う（DB のジョブも 2 つのプロセスが取り合う）。
    fd はサーバーが動いている間閉じずに持つ。プロセスが終われば OS がロックを外す（ファイルは消さない）。
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(data_dir / "serve.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if sys.platform.startswith("win"):
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


async def build_context(settings: Settings, *, stt_provider: STTProvider | None = None, vad_provider: VADProvider | None = None,
                        llm_provider: SummaryProvider | None = None, hardware: Hardware | None = None,
                        diarization_provider: DiarizationProvider | None = None, language_detector: LanguageDetector | None = None,
                        codec: AudioCodec | None = None, tls_enabled: bool = False, recover: bool = True) -> AppContext:
    """recover=False は、動いている serve の横で呼ぶ `doctor` 用。壊れた DB の退避・復元をしない（使用中の DB を動かさない）。"""
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    restrict_to_current_user(settings.data_dir)   # 録音・トークン・DB を置く。他の OS ユーザーに読ませない
    db, recovery = open_database_with_recovery(settings) if recover else (Database(settings.db_path), None)
    migrate(db)
    apply_phase3(db, settings.data_dir)
    codec = codec if codec is not None else _default_codec()
    if recovery is not None:
        # 復元元のバックアップより後に録音した会議（バックアップがなければ全部）は DB にない。録音ファイルから行を作り直す（§18）。
        # 確定済みの会議は finalized で戻り、serve の resume_finalized がジョブを作る。要約とノートは作り直せない
        with db.write_sync() as conn:
            recovery.rebuilt = rebuild(conn, settings.data_dir, codec)
    with db.read() as conn:
        settings = settings.with_overrides(repo.get_settings(conn))
        multi_user = user_count(conn) > 0

    hw = hardware or detect(settings.data_dir)

    if llm_provider is None:
        from .llm.ollama_provider import OllamaProvider
        th = settings.thresholds
        llm_provider = OllamaProvider(settings.ollama_base_url, th.llm_connect_timeout_s, th.llm_read_timeout_s)
    # None = 届かない（Ollama 未起動）、[] = 届くがモデルがない。起動は止めず、後で選び直す（jobs/selection.py）
    listed = await llm_provider.list_models()
    models = select_models(settings, hw, listed or [], listed is not None)

    stt: STTExecutor = InlineExecutor(stt_provider) if stt_provider is not None else PoolExecutor(models.max_concurrent_stt)

    vad: VADProvider | None = vad_provider
    if vad is None:
        p = silero_model_path(settings.models_dir)
        if p is not None:
            th = settings.thresholds
            try:
                from .vad.silero_provider import SileroVADProvider
                vad = SileroVADProvider(p, th.vad_threshold, th.vad_min_speech_ms, th.vad_min_voiced_ms)
            except ImportError:
                # モデルは置いてあるが onnxruntime（extras の stt / cuda）が入っていない。起動を止めず、未配置と同じく
                # ブラウザ側の VAD で進める（doctor の vad 行に NOT INSTALLED と出る）
                vad = None

    diarization = diarization_provider
    if diarization is None and (settings.models_dir / "diarization" / "config.yaml").exists():
        from .diarization.pyannote_provider import PyannoteDiarizationProvider
        # STT と同じく、GPU で走らせるのは CUDA だけ（Apple Silicon・GPU なしは CPU。Phase 2 §9）
        diarization = PyannoteDiarizationProvider(device="cuda" if hw.gpu.backend == "cuda" else "cpu")

    language = language_detector
    if language is None and models.stt is not None and stt_provider is None:
        from .stt.language import FasterWhisperLanguageDetector
        language = FasterWhisperLanguageDetector(settings.models_dir, models.stt.name, models.stt.compute_type, models.stt.device)

    return AppContext(settings=settings, db=db, hardware=hw, models=models, stt=stt, vad=vad, llm=llm_provider,
                      diarization=diarization, language=language, codec=codec,
                      multi_user=multi_user, tls_enabled=tls_enabled, recovery=recovery)
```

```python
# minutes_local/__main__.py
"""CLI：serve / token / doctor / user。Phase 3 で --tls / --bind / --rebuild / --init-tls / user add・remove・list を追加。"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sqlite3
import sys

from .bootstrap import acquire_data_dir_lock, bind_listen_socket, build_context, read_token, rotate_token
from .config import Settings, settings_from_env
from .storage.backup import Recovery

LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _warn_recovery(recovery: Recovery | None) -> None:
    """起動時に壊れた DB を作り直したことを知らせる（§2.4）。黙って古い状態に戻さない。"""
    if recovery is None:
        return
    source = recovery.restored_from.name if recovery.restored_from is not None else "none (started from an empty database)"
    r = recovery.rebuilt
    print(f"WARNING: the database was corrupt and has been recovered. backup: {source}. "
          f"rebuilt from recordings: meetings+{r.meetings_created} chunks+{r.chunks_created} skipped={len(r.skipped_files or [])}. "
          "Summaries and notes saved after the backup are lost; rebuilt meetings are transcribed again.", file=sys.stderr)


def _cmd_token(args: argparse.Namespace) -> int:
    s = settings_from_env()
    token = read_token(s.token_path)
    if token is None:
        print("token file not found. Start the server once with `minutes-local serve`.", file=sys.stderr)
        return 1
    print(token)
    return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    s = settings_from_env()
    if args.init_tls:
        from .auth.tls import generate_self_signed
        hosts = args.host or ["127.0.0.1"]
        generate_self_signed(s.tls_cert_path, s.tls_key_path, hosts)
        print(f"tls          : generated {s.tls_cert_path} for {hosts}")
        print("               ブラウザで初回に証明書の受け入れが必要です（§3）。")
        return 0
    # serve が動いていなければロックが取れる。DB を書き換える処理（壊れた DB の復元・rebuild）は、取れたときだけ行う
    lock = acquire_data_dir_lock(s.data_dir)
    try:
        if args.rebuild and lock is None:
            print(f"ERROR: stop the server before `doctor --rebuild` ({s.data_dir} is in use).", file=sys.stderr)
            return 1
        return _doctor_report(s, rebuild_requested=bool(args.rebuild), recover=lock is not None)
    finally:
        if lock is not None:
            os.close(lock)


def _doctor_report(s: Settings, *, rebuild_requested: bool, recover: bool) -> int:
    try:
        ctx = asyncio.run(build_context(s, recover=recover))
    except sqlite3.DatabaseError as e:
        # recover=False（serve が動いている）で DB が壊れていた場合。使用中の DB は動かさない
        print(f"ERROR: cannot open {s.db_path} ({e}). Restart the server to recover from the latest backup.", file=sys.stderr)
        return 1
    _warn_recovery(ctx.recovery)
    if rebuild_requested:
        from .storage.rebuild import rebuild
        with ctx.db.write_sync() as conn:
            report = rebuild(conn, s.data_dir, ctx.codec)
        print(f"rebuild      : meetings+{report.meetings_created} chunks+{report.chunks_created} missing={report.chunks_marked_missing} skipped={report.skipped_files}")
    m, hw = ctx.models, ctx.hardware
    print(f"dataDir      : {s.data_dir}")
    print(f"sqlite       : {ctx.db.path}")
    print(f"tier         : {m.tier} (gpu={hw.gpu.name or 'none'}, vram={hw.gpu.vram_bytes}, cores={hw.cpu_cores})")
    print(f"stt          : {m.stt.name + '/' + m.stt.compute_type if m.stt else 'NOT AVAILABLE'} installed={sorted(m.installed_stt)}")
    print(f"vad          : {'silero' if ctx.vad else 'NOT INSTALLED (browser VAD only)'}")
    print(f"diarization  : {'available' if ctx.diarization else 'NOT INSTALLED'}")
    print(f"language     : {'available' if ctx.language else 'fixed (' + s.language + ')'}")
    print(f"codec        : {ctx.codec.name if ctx.codec else 'NOT AVAILABLE (wav only)'}")
    print(f"ollama       : {'reachable' if m.ollama_reachable else 'unreachable'} llm={m.llm}")
    print(f"concurrency  : stt={m.max_concurrent_stt} stt+llm={'yes' if m.allow_concurrent_stt_and_llm else 'no'}")
    print(f"users        : {'multi-user' if ctx.multi_user else 'single (token file)'}")
    ctx.stt.shutdown()
    ctx.db.close()
    return 0


def _cmd_user(args: argparse.Namespace) -> int:
    from .auth.users import create_user, delete_user, list_users, user_count
    from .db.connection import Database
    from .db.migrate import migrate
    from .db.migrations_phase3 import apply_phase3
    s = settings_from_env()
    db = Database(s.db_path)
    migrate(db)
    apply_phase3(db, s.data_dir)
    try:
        if args.user_cmd == "add":
            try:
                with db.write_sync() as conn:
                    user, token = create_user(conn, args.name)
                    count = user_count(conn)
            except sqlite3.IntegrityError:
                print(f"ERROR: user {args.name!r} already exists.", file=sys.stderr)   # users.name は UNIQUE
                return 1
            print(f"user {user.name} ({user.id}) created. token (shown once):\n{token}")
            if count == 1:
                # 単一利用者と複数利用者の切り替えは起動時に決まる（§2.5）
                print("note: restart the server to switch to multi-user mode. The token file stops working, and meetings "
                      "recorded so far (owner `local`) are hidden until every user is removed.")
        elif args.user_cmd == "remove":
            with db.write_sync() as conn:
                removed = delete_user(conn, args.user_id)
                count = user_count(conn)
            if not removed:
                print(f"ERROR: no such user id: {args.user_id}", file=sys.stderr)
                return 1
            # 会議と録音は消さない（その利用者の会議は、誰からも見えないまま残る）
            print(f"user {args.user_id} removed. The token is no longer accepted.")
            if count == 0:
                print("note: restart the server to return to single-user mode (token file).")
        else:
            with db.read() as conn:
                for u in list_users(conn):
                    print(f"{u.id}  {u.name}")
        return 0
    finally:
        db.close()


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn
    from .api.app import create_app
    from .jobs import scheduler, sweeper
    from .jobs.handlers import HANDLERS
    from .jobs.runner import JobRunner

    s = settings_from_env()
    lan = args.bind not in LOOPBACK
    if lan and not args.tls:
        print("ERROR: non-loopback bind requires --tls (token would be sent in clear text). Run `doctor --init-tls` first.", file=sys.stderr)
        return 2
    if args.tls and not (s.tls_cert_path.exists() and s.tls_key_path.exists()):
        print(f"ERROR: TLS files not found under {s.tls_cert_path.parent}. Run `doctor --init-tls --host <hostname>`.", file=sys.stderr)
        return 2

    async def main() -> int:
        # 同じデータディレクトリの serve は 1 つだけ。migrate より前に取り、取れなければ何も変えずに終わる
        # （別のポートで動いている既存のサーバーのトークンを作り直さない）
        lock = acquire_data_dir_lock(s.data_dir)
        if lock is None:
            print(f"ERROR: another server is using {s.data_dir}. The token was not changed.", file=sys.stderr)
            return 1
        try:
            return await run()
        finally:
            os.close(lock)

    async def run() -> int:
        # 前回の強制終了で残った一時ファイル（話者分離に渡した WAV）を消す。ロックを持っているので、使用中のものはない
        shutil.rmtree(s.tmp_dir, ignore_errors=True)
        ctx = await build_context(s, tls_enabled=bool(args.tls))
        _warn_recovery(ctx.recovery)
        try:
            sock = bind_listen_socket(args.bind, s.port)
        except OSError as e:
            # ポートの確保に失敗したらトークンを書き換えない（既存のサーバーが動いていれば、そのトークンが有効なまま）
            print(f"ERROR: cannot listen on {args.bind}:{s.port} ({e}). The token was not changed.", file=sys.stderr)
            ctx.stt.shutdown()
            ctx.db.close()
            return 1
        token = rotate_token(s.token_path)      # 起動のたびに作り直す（Phase 1 §4.3）。利用者別トークン（users テーブル）は作り直さない
        if not ctx.multi_user:
            print(f"token: {token}")
        app = create_app(ctx, token)
        stop = asyncio.Event()
        await sweeper.sweep_once(ctx.db)
        # Phase 1 で確定した会議と doctor --rebuild が復元した会議のジョブを作る（Phase 2 §14）。diarize は既定の False
        await sweeper.resume_finalized(ctx.db, s.data_dir)
        runners = [JobRunner(ctx, HANDLERS, i) for i in range(ctx.models.max_concurrent_stt)]
        tasks = [asyncio.create_task(r.run_forever()) for r in runners]
        tasks.append(asyncio.create_task(sweeper.run_forever(ctx.db, stop)))
        tasks.append(asyncio.create_task(scheduler.run_forever(ctx, stop)))
        kwargs = {"ssl_certfile": str(s.tls_cert_path), "ssl_keyfile": str(s.tls_key_path)} if args.tls else {}
        config = uvicorn.Config(app, host=args.bind, port=s.port, log_level="info", **kwargs)
        server = uvicorn.Server(config)
        try:
            await server.serve(sockets=[sock])
        finally:
            stop.set()
            for r in runners:
                r.stop()
            for t in tasks:
                t.cancel()
            ctx.stt.shutdown()
            ctx.db.close()
        return 0

    return asyncio.run(main())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="minutes-local")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_serve = sub.add_parser("serve")
    p_serve.add_argument("--bind", default="127.0.0.1")
    p_serve.add_argument("--tls", action="store_true")
    p_serve.set_defaults(fn=_cmd_serve)
    sub.add_parser("token").set_defaults(fn=_cmd_token)
    p_doc = sub.add_parser("doctor")
    p_doc.add_argument("--rebuild", action="store_true")
    p_doc.add_argument("--init-tls", action="store_true")
    p_doc.add_argument("--host", action="append")
    p_doc.set_defaults(fn=_cmd_doctor)
    p_user = sub.add_parser("user")
    user_sub = p_user.add_subparsers(dest="user_cmd", required=True)
    p_add = user_sub.add_parser("add")
    p_add.add_argument("name")
    p_remove = user_sub.add_parser("remove")
    p_remove.add_argument("user_id")
    user_sub.add_parser("list")
    p_user.set_defaults(fn=_cmd_user)
    args = parser.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
```

---

# 23. テストコード

## 23.1 ハーネス（変更）と Phase 2 テストの回帰

Phase 2 §23.1 の `tests/conftest.py` を、Phase 3 の Fake（話者分離・言語判定・コーデック）を注入できる `ctx3` / `client3` / `runner3` 付きに差し替える。既定の `ctx` は Phase 2 と同じ構成（Phase 3 の Provider なし）にし、Phase 2 の 131 件がそのまま通ることを回帰条件とする。物理パスを見るテストは `conftest.py` の `recording_dir()`（Phase 3 は利用者階層を挟む）を通すので変更不要。唯一の例外は `test_phase1_contract.py` の「ファイルの物理パス」の期待値で、§2.5 の利用者階層に合わせて更新する（API 契約は不変）。

```python
# tests/conftest.py
from __future__ import annotations

import base64
import json
import math
import re
import struct
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest

from minutes_local.api.app import create_app
from minutes_local.bootstrap import build_context
from minutes_local.config import Settings
from minutes_local.diarization.fake_provider import FakeDiarizationProvider
from minutes_local.hw.detect import GpuInfo, Hardware
from minutes_local.hw.tiers import SttCandidate
from minutes_local.jobs.context import AppContext
from minutes_local.jobs.handlers import HANDLERS
from minutes_local.jobs.runner import JobRunner
from minutes_local.llm.fake_provider import FakeSummaryProvider
from minutes_local.llm.provider import LLMRequest
from minutes_local.storage.codec import FakeCodec
from minutes_local.stt.fake_provider import FakeSTTProvider
from minutes_local.stt.language import FakeLanguageDetector, LanguageGuess
from minutes_local.storage.files import build_wav, sha256_hex
from minutes_local.vad.fake_provider import FakeVADProvider

TOKEN = "test-token"
BASE = "http://127.0.0.1:43117"
CPU_HW = Hardware(gpu=GpuInfo(False, None, None, None), cpu_cores=4, total_memory_bytes=16 * 1024 ** 3, free_disk_bytes=10 * 1024 ** 3)
GPU_HW = Hardware(gpu=GpuInfo(True, "test-gpu", 16 * 1024 ** 3, "cuda"), cpu_cores=8, total_memory_bytes=32 * 1024 ** 3, free_disk_bytes=10 * 1024 ** 3)


def sine_pcm(seconds: float, freq: float = 440.0, amplitude: float = 0.3) -> bytes:
    n = int(seconds * 16000)
    return struct.pack(f"<{n}h", *(int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / 16000)) for i in range(n)))


def silence_pcm(seconds: float) -> bytes:
    return b"\x00\x00" * int(seconds * 16000)


def valid_summary_response(req: LLMRequest) -> str:
    """transcript 中の [seg:xxxxxxxx] を根拠として引用する、検証を通る応答。"""
    # 段階2（v4.0 §66.2）を通すには、逐語引用とその位置まで揃える必要がある。
    # 本文を伴わないダミー応答にすると検証が素通りし、回帰テストの意味がなくなる
    hits = re.findall(r"\[seg:([0-9a-f]{8,12})\]\s*(.*)", req.user)
    first = hits[:1]
    ids = [h[0] for h in first]
    quote = first[0][1] if first else ""
    span = {"segmentId": ids[0], "start": 0, "end": len(quote)} if first else {"segmentId": "", "start": 0, "end": 0}
    evidence = {"sourceSegmentIds": ids, "quote": quote, "evidenceSpan": span}
    return json.dumps({
        "summary": "テスト会議の要約",
        "topics": [{"title": "話題A", "description": "説明", "sourceSegmentIds": ids}],
        # claim は quote に裏付けられている必要があるので、引用本文から作る
        "decisions": [{"text": quote, **evidence}],
        "actionItems": [{"task": quote, "assignee": None, "deadline": None, **evidence}],
    }, ensure_ascii=False)


class AlternatingLanguage:
    """呼び出し順に ja / en を交互に返す決定的な判定器。"""

    def __init__(self) -> None:
        self.n = 0

    def __call__(self, pcm: bytes) -> LanguageGuess:
        self.n += 1
        return LanguageGuess("ja" if self.n % 2 == 1 else "en", 0.9)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture
def stt_provider() -> FakeSTTProvider:
    return FakeSTTProvider()


@pytest.fixture
def llm_provider() -> FakeSummaryProvider:
    return FakeSummaryProvider([valid_summary_response] * 10)


@pytest.fixture
def diarization_provider() -> FakeDiarizationProvider:
    return FakeDiarizationProvider()


@pytest.fixture
def language_detector() -> FakeLanguageDetector:
    return FakeLanguageDetector(AlternatingLanguage())


def _pin_stt(c: AppContext) -> None:
    c.models.stt = SttCandidate("small", "int8", 0)
    c.models.installed_stt = {"small", "base", "tiny"}


@pytest.fixture
async def ctx(settings: Settings, stt_provider: FakeSTTProvider, llm_provider: FakeSummaryProvider) -> AsyncIterator[AppContext]:
    """Phase 2 と同じ構成（話者分離・言語判定・コーデックなし）。"""
    c = await build_context(settings, stt_provider=stt_provider, vad_provider=FakeVADProvider(), llm_provider=llm_provider, hardware=CPU_HW)
    _pin_stt(c)
    try:
        yield c
    finally:
        c.stt.shutdown()
        c.db.close()


@pytest.fixture
async def ctx3(settings: Settings, stt_provider: FakeSTTProvider, llm_provider: FakeSummaryProvider,
               diarization_provider: FakeDiarizationProvider, language_detector: FakeLanguageDetector) -> AsyncIterator[AppContext]:
    """Phase 3 構成：GPU 区分（Live 既定有効）、話者分離・言語判定・Fake コーデックあり。"""
    c = await build_context(settings, stt_provider=stt_provider, vad_provider=FakeVADProvider(), llm_provider=llm_provider, hardware=GPU_HW,
                            diarization_provider=diarization_provider, language_detector=language_detector, codec=FakeCodec())
    _pin_stt(c)
    try:
        yield c
    finally:
        c.stt.shutdown()
        c.db.close()


@pytest.fixture
def runner(ctx: AppContext) -> JobRunner:
    return JobRunner(ctx, HANDLERS)


@pytest.fixture
def runner3(ctx3: AppContext) -> JobRunner:
    return JobRunner(ctx3, HANDLERS)


async def _client_for(c: AppContext, token: str = TOKEN) -> httpx.AsyncClient:
    app = create_app(c, token)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE)
    client.headers["Authorization"] = f"Bearer {token}"
    return client


@pytest.fixture
async def client(ctx: AppContext) -> AsyncIterator[httpx.AsyncClient]:
    c = await _client_for(ctx)
    try:
        yield c
    finally:
        await c.aclose()


@pytest.fixture
async def client3(ctx3: AppContext) -> AsyncIterator[httpx.AsyncClient]:
    c = await _client_for(ctx3)
    try:
        yield c
    finally:
        await c.aclose()


def recording_dir(ctx: AppContext, meeting_id: str, user_id: str = "local") -> Path:
    """会議の録音ディレクトリ。Phase 3 は利用者階層を挟む（§2.5）。"""
    return ctx.settings.data_dir / "recordings" / user_id / meeting_id


async def create_meeting(client: httpx.AsyncClient, meeting_id: str = "m-1") -> None:
    r = await client.post("/v1/meetings", json={"meetingId": meeting_id, "title": "t", "sessionStartEpochMs": 0,
                                                "nativeSampleRate": 48000, "consentConfirmedAt": 1})
    assert r.status_code in (200, 201)


async def put_chunk(client: httpx.AsyncClient, meeting_id: str, seq: int, pcm: bytes, source: str = "mic",
                    meta: str | None = None) -> httpx.Response:
    """meta は X-Chunk-Meta の中身（Base64URL 済み）。未指定なら既定のメタデータを組み立てる。"""
    wav = build_wav(pcm)
    duration = len(pcm) // 32
    if meta is None:
        # Phase 1 のクライアントが送る ChunkTimingMetadata のうち、サーバーが照合する項目（§21.2）
        body = {"meetingId": meeting_id, "source": source, "sequenceNo": seq, "sampleCount": len(pcm) // 2,
                "startOffsetMs": seq * 30000, "endOffsetMs": seq * 30000 + duration, "vadScore": 0.5, "hasVoice": True}
        meta = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return await client.put(f"/v1/meetings/{meeting_id}/chunks/{source}/{seq}", content=wav,
                            headers={"Content-Type": "audio/wav", "X-Chunk-SHA256": sha256_hex(wav), "X-Chunk-Meta": meta})


async def finalize(client: httpx.AsyncClient, meeting_id: str, mic: int, system: int = 0) -> httpx.Response:
    return await client.post(f"/v1/meetings/{meeting_id}/finalize",
                             json={"expectedChunkCounts": {"mic": mic, "system": system}, "endedAtEpochMs": 1, "totalAudioFrames": mic * 480000})


ChunkFactory = Callable[[float], bytes]
```

```python
# tests/test_phase1_contract.py
"""Phase 2 §23.3 と同一。Phase 3 の利用者階層に合わせ物理パスの期待値だけ更新（API 契約は不変）。"""
from __future__ import annotations

import httpx

from minutes_local.db import repo
from minutes_local.jobs.context import AppContext
from tests.conftest import BASE, TOKEN, create_meeting, finalize, put_chunk, silence_pcm, sine_pcm


async def test_health_without_token_has_no_capabilities(ctx: AppContext) -> None:
    from minutes_local.api.app import create_app
    app = create_app(ctx, TOKEN)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE) as c:
        r = await c.get("/v1/health")
        assert r.status_code == 200
        assert r.json()["service"] == "minutes-local"
        assert "capabilities" not in r.json()
        assert (await c.get("/v1/meetings")).status_code == 401


async def test_health_with_token(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/health")
    caps = r.json()["capabilities"]
    assert caps["tier"] == "cpu_only" and caps["sttModel"] == "small"
    assert caps["multiUser"] is False and caps["tls"] is False


async def test_create_meeting_idempotent(client: httpx.AsyncClient) -> None:
    body = {"meetingId": "m-x", "title": "t", "sessionStartEpochMs": 0, "nativeSampleRate": 44100, "consentConfirmedAt": 1}
    assert (await client.post("/v1/meetings", json=body)).status_code == 201
    assert (await client.post("/v1/meetings", json=body)).status_code == 200


async def test_put_chunk_idempotent_and_conflict(client: httpx.AsyncClient, ctx: AppContext) -> None:
    await create_meeting(client)
    pcm = sine_pcm(30)
    r1 = await put_chunk(client, "m-1", 0, pcm)
    assert r1.status_code == 201 and r1.json()["registered"] is True and r1.json()["sizeBytes"] == 960044
    r2 = await put_chunk(client, "m-1", 0, pcm)
    assert r2.status_code == 200 and r2.json()["sha256"] == r1.json()["sha256"]
    r3 = await put_chunk(client, "m-1", 0, sine_pcm(30, freq=880))
    assert r3.status_code == 409 and r3.json()["code"] == "CONFLICT_HASH_MISMATCH"
    assert (ctx.settings.data_dir / "recordings/local/m-1/mic/000000.wav").exists()       # Phase 3 §2.5 の階層
    assert not list((ctx.settings.data_dir / "recordings/local/m-1/mic").glob("*.part"))


async def test_put_chunk_rejects_invalid_wav_and_bad_hash(client: httpx.AsyncClient) -> None:
    await create_meeting(client)
    r = await client.put("/v1/meetings/m-1/chunks/mic/0", content=b"RIFFxxxx", headers={"Content-Type": "audio/wav"})
    assert r.status_code == 422
    from minutes_local.storage.files import build_wav
    r = await client.put("/v1/meetings/m-1/chunks/mic/0", content=build_wav(sine_pcm(1)),
                         headers={"Content-Type": "audio/wav", "X-Chunk-SHA256": "0" * 64})
    assert r.status_code == 422


async def test_list_and_finalize(client: httpx.AsyncClient, ctx: AppContext) -> None:
    await create_meeting(client)
    for seq in range(3):
        await put_chunk(client, "m-1", seq, sine_pcm(30) if seq != 1 else silence_pcm(30))
    r = await client.get("/v1/meetings/m-1/chunks")
    assert [c["sequenceNo"] for c in r.json()["chunks"]] == [0, 1, 2]
    bad = await finalize(client, "m-1", mic=4)
    assert bad.status_code == 409 and bad.json()["code"] == "CONFLICT_CHUNKS_MISSING"
    ok = await finalize(client, "m-1", mic=3)
    assert ok.status_code == 200 and ok.json()["registeredChunkCounts"] == {"mic": 3, "system": 0}
    with ctx.db.read() as conn:
        assert repo.get_meeting(conn, "m-1").status == "transcribing"
        assert repo.count_jobs(conn, "m-1", "vad_chunk", ["pending"]) == 3
        assert all(c.save_status == "verified" for c in repo.list_chunks(conn, "m-1"))
    assert (ctx.settings.data_dir / "recordings/local/m-1/meeting.json").exists()        # Phase 3 §2.4
    again = await finalize(client, "m-1", mic=3)
    assert again.status_code == 200
    with ctx.db.read() as conn:
        assert repo.count_jobs(conn, "m-1", "vad_chunk", ["pending"]) == 3  # 冪等
```

## 23.2 マイグレーション

```python
# tests/test_migration_phase3.py
"""Phase 2 の DB とファイル配置から 009〜012 を適用する。"""
from __future__ import annotations

from pathlib import Path

from minutes_local.db import repo
from minutes_local.db.connection import Database, now_ms
from minutes_local.db.migrate import current_version, migrate
from minutes_local.db.migrations_phase3 import apply_phase3
from minutes_local.db.models import AudioChunk, Meeting
from minutes_local.storage.files import build_wav
from tests.conftest import sine_pcm


def test_apply_phase3_moves_files_and_extends_job_types(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    db = Database(data_dir / "minutes.sqlite")
    migrate(db)
    t = now_ms()
    with db.write_sync() as conn:
        repo.insert_meeting(conn, Meeting(id="m", title="t", status="completed", session_start_epoch_ms=0, native_sample_rate=48000,
                                          consent_confirmed_at=1, created_at=t, updated_at=t))
        old_rel = "recordings/m/mic/000000.wav"
        (data_dir / old_rel).parent.mkdir(parents=True)
        (data_dir / old_rel).write_bytes(build_wav(sine_pcm(1)))
        repo.upsert_chunk(conn, AudioChunk(id="c", meeting_id="m", source="mic", sequence_no=0, start_offset_ms=0, end_offset_ms=1000,
                                           duration_ms=1000, sample_count=16000, local_path=old_rel, size_bytes=1, sha256="x", created_at=t))
        repo.insert_job(conn, "m", "transcribe_chunk", chunk_id="c")
    assert current_version(db._read_conn) == 8                                  # Phase 2 の最終版（008 sync_samples）

    applied = apply_phase3(db, data_dir)
    assert applied == 4
    with db.read() as conn:
        assert current_version(conn) == 12
        chunk = repo.get_chunk(conn, "c")
        assert chunk.local_path == "recordings/local/m/mic/000000.wav" and chunk.codec == "wav"
        assert (data_dir / chunk.local_path).exists() and not (data_dir / old_rel).exists()
        jobs = repo.list_jobs(conn, "m")
        assert len(jobs) == 1 and jobs[0].job_type == "transcribe_chunk"       # 再作成で行が保たれる
        assert conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0
    with db.write_sync() as conn:
        assert repo.insert_job(conn, "m", "diarize_meeting") is not None       # 新しい job_type が CHECK を通る
        assert repo.insert_job(conn, "m", "diarize_meeting") is None           # uq_diarize_job
    assert apply_phase3(db, data_dir) == 0                                      # 冪等
    db.close()


def test_apply_phase3_keeps_other_recordings_when_meeting_id_equals_user_id(tmp_path: Path) -> None:
    """会議 ID "local" の旧ディレクトリ recordings/local/ は新しい階層の親と重なる。他の会議の録音を消さずに移す。"""
    data_dir = tmp_path / "data"
    db = Database(data_dir / "minutes.sqlite")
    migrate(db)
    t = now_ms()
    with db.write_sync() as conn:
        for mid in ("local", "m"):
            repo.insert_meeting(conn, Meeting(id=mid, title="t", status="completed", session_start_epoch_ms=0, native_sample_rate=48000,
                                              consent_confirmed_at=1, created_at=t, updated_at=t))
            rel = f"recordings/{mid}/mic/000000.wav"
            (data_dir / rel).parent.mkdir(parents=True)
            (data_dir / rel).write_bytes(build_wav(sine_pcm(1)))
            (data_dir / f"recordings/{mid}/meeting.json").write_text(mid)
            repo.upsert_chunk(conn, AudioChunk(id=f"c-{mid}", meeting_id=mid, source="mic", sequence_no=0, start_offset_ms=0,
                                               end_offset_ms=1000, duration_ms=1000, sample_count=16000, local_path=rel,
                                               size_bytes=1, sha256="x", created_at=t))

    apply_phase3(db, data_dir)
    with db.read() as conn:
        for mid in ("local", "m"):
            chunk = repo.get_chunk(conn, f"c-{mid}")
            assert chunk.local_path == f"recordings/local/{mid}/mic/000000.wav"
            assert (data_dir / chunk.local_path).is_file()
            assert (data_dir / f"recordings/local/{mid}/meeting.json").read_text() == mid
    assert not (data_dir / ".migrate-012").exists()
    db.close()
```

## 23.3 Live STT

```python
# tests/test_live.py
from __future__ import annotations

import asyncio

import httpx

from minutes_local.db import repo
from minutes_local.db.connection import now_ms
from minutes_local.jobs import live
from minutes_local.jobs.context import AppContext
from minutes_local.jobs.runner import JobRunner
from minutes_local.stt.fake_provider import FakeSTTProvider
from tests.conftest import create_meeting, finalize, put_chunk, sine_pcm


async def test_live_job_created_on_put_and_reused_after_finalize(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                                stt_provider: FakeSTTProvider) -> None:
    await create_meeting(client3)
    detail = (await client3.get("/v1/meetings/m-1")).json()
    assert detail["liveSttEnabled"] is False and detail["liveState"] == "DISABLED"      # settings 既定は off
    r = await client3.put("/v1/meetings/m-1/live", json={"enabled": True})
    assert r.json() == {"meetingId": "m-1", "liveSttEnabled": True, "allowed": True}
    assert (await client3.get("/v1/meetings/m-1")).json()["liveState"] == "STARTING"

    received: list[dict] = []

    async def collect() -> None:
        async for ev in ctx3.events.subscribe("m-1"):
            if ev.get("type") == "live_segment":
                received.append(ev)
                if len(received) >= 6:
                    break

    t = asyncio.create_task(collect())
    await asyncio.sleep(0)
    await put_chunk(client3, "m-1", 0, sine_pcm(30))
    with ctx3.db.read() as conn:
        assert repo.count_jobs(conn, "m-1", "live_transcribe_chunk", ["pending"]) == 1
        assert repo.count_jobs(conn, "m-1", "vad_chunk", ["pending"]) == 0             # Live は VAD を掛けない
    assert (await client3.get("/v1/meetings/m-1")).json()["liveState"] == "RUNNING"
    assert await runner3.run_until_idle() == 1
    await asyncio.wait_for(t, 5)
    assert len(received) == 6 and received[0]["segment"]["startMs"] == 0
    live_view = (await client3.get("/v1/meetings/m-1/live", params={"since": 0})).json()
    assert len(live_view["segments"]) == 6 and live_view["liveState"] == "RUNNING"
    # since は境界を含むので、cursor を渡すと境界ミリ秒の分だけが再送される（新規は増えない）。
    # 排他境界にすると、この 1 ミリ秒に後から追記されたセグメントが永久に取り出せなくなる
    replay = (await client3.get("/v1/meetings/m-1/live", params={"since": live_view["cursor"]})).json()
    assert all(s["createdAt"] == live_view["cursor"] for s in replay["segments"])
    assert {s["id"] for s in replay["segments"]} <= {s["id"] for s in live_view["segments"]}
    with ctx3.db.read() as conn:
        assert repo.get_chunk_by_key(conn, "m-1", "mic", 0).stt_status == "pending"    # 確定パイプラインには触らない

    calls_before = len(stt_provider.calls)
    await finalize(client3, "m-1", mic=1)
    await runner3.run_until_idle()
    with ctx3.db.read() as conn:
        m = repo.get_meeting(conn, "m-1")
        segs = repo.list_segments(conn, "m-1", merged_version=1)
    assert m.status == "completed" and len(segs) == 6
    assert len(stt_provider.calls) == calls_before                                     # Live 結果を再利用し STT を呼ばない
    assert (await client3.get("/v1/meetings/m-1")).json()["liveState"] == "STOPPED"     # recording 終了


async def test_live_state_degrades_with_lag(client3: httpx.AsyncClient, ctx3: AppContext) -> None:
    await create_meeting(client3)
    await client3.put("/v1/meetings/m-1/live", json={"enabled": True})
    await put_chunk(client3, "m-1", 0, sine_pcm(30))
    with ctx3.db.read() as conn:
        m = repo.get_meeting(conn, "m-1")
        now = now_ms()
        assert live.compute_live_state(conn, ctx3, m, now) == "RUNNING"
        assert live.compute_live_state(conn, ctx3, m, now + 120_000) == "DEGRADED"
        assert live.compute_live_state(conn, ctx3, m, now + 400_000) == "STOPPED"


async def test_live_disabled_on_small_tier_by_default(client: httpx.AsyncClient, ctx: AppContext) -> None:
    ctx.settings = ctx.settings.with_overrides({"live_stt_enabled": True})
    await create_meeting(client)
    assert (await client.get("/v1/meetings/m-1")).json()["liveSttEnabled"] is False    # cpu_only は既定 off（§2.1）
    r = await client.put("/v1/settings", json={"liveSttEnabled": True})
    assert r.json()["warnings"]
```

## 23.4 話者分離とエコー

```python
# tests/test_diarization.py
from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx

from minutes_local.config import Thresholds
from minutes_local.db import repo, repo_phase3
from minutes_local.db.connection import now_ms
from minutes_local.db.models import Segment
from minutes_local.diarization.fake_provider import FakeDiarizationProvider
from minutes_local.diarization.provider import DiarizationRequest, assemble_timeline
from minutes_local.diarization.pyannote_provider import PyannoteDiarizationProvider
from minutes_local.storage.files import parse_wav_header
from minutes_local.jobs.context import AppContext
from minutes_local.jobs.retry import InvalidAudioError, ModelMissingError
from minutes_local.jobs.runner import JobRunner
from minutes_local.jobs.sweeper import sweep_once
from minutes_local.merge.merger import format_for_llm, render_lines, run_merge
from minutes_local.merge.normalize import normalize
from minutes_local.stt.fake_provider import FakeSTTProvider
from minutes_local.stt.provider import STTRequest, STTSegment
from tests.conftest import create_meeting, finalize, put_chunk, silence_pcm, sine_pcm


def _text_by_pcm(req: STTRequest) -> list[STTSegment]:
    """mic と system で異なるテキストを返す。同一テキストはエコー（§2.2）として除外されるため。"""
    tag = hashlib.md5(req.pcm[-64000:]).hexdigest()[:6]
    step = 5 * 16000 * 2
    return [STTSegment(start / 32000, min(start + step, len(req.pcm)) / 32000, f"{tag}-seg{i}", -0.2, 0.05)
            for i, start in enumerate(range(0, len(req.pcm), step))]


async def _two_source_meeting(client3: httpx.AsyncClient, stt_provider: FakeSTTProvider | None = None) -> None:
    if stt_provider is not None:
        stt_provider.script = _text_by_pcm
    await create_meeting(client3)
    for seq in range(2):
        await put_chunk(client3, "m-1", seq, sine_pcm(30), source="mic")
        await put_chunk(client3, "m-1", seq, sine_pcm(30, freq=660), source="system")
    assert (await finalize(client3, "m-1", mic=2, system=2)).status_code == 200


async def test_diarize_assigns_labels_and_names_are_user_assigned(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                                  diarization_provider: FakeDiarizationProvider, stt_provider: FakeSTTProvider) -> None:
    await _two_source_meeting(client3, stt_provider)
    n = await runner3.run_until_idle()
    assert n == 4 + 4 + 1 + 1 + 1                                                     # vad×4, stt×4, diarize, merge, summary
    with ctx3.db.read() as conn:
        segs = repo.list_segments(conn, "m-1", merged_version=1)
        assert {s.speaker_id for s in segs if s.source == "mic"} == {"S1"}
        assert {s.speaker_id for s in segs if s.source == "system"} == {"S2", "S3"}
        assert all(s.speaker_confidence == 0.9 for s in segs)
    assert len(diarization_provider.calls) == 1 and set(diarization_provider.calls[0].pcm_by_source) == {"mic", "system"}
    detail = (await client3.get("/v1/meetings/m-1")).json()
    assert detail["diarized"] is True and [s["label"] for s in detail["speakers"]] == ["S1", "S2", "S3"]
    assert all(s["name"] is None for s in detail["speakers"])                          # 名前は AI が付けない（Invariant 9）

    r = await client3.put("/v1/meetings/m-1/speakers", json={"speakers": [{"label": "S1", "name": "田中"}]})
    assert r.json()["speakers"][0] == {"label": "S1", "name": "田中"}
    tr = (await client3.get("/v1/meetings/m-1/transcript")).json()
    mic_seg = next(s for s in tr["segments"] if s["source"] == "mic")
    assert mic_seg["speakerId"] == "S1" and mic_seg["speakerName"] == "田中"
    with ctx3.db.read() as conn:
        lines, gaps = render_lines(conn, "m-1", 1)
    text = format_for_llm(lines, gaps)
    assert "[mic] [S1:田中] [seg:" in text and "[system] [S2] [seg:" in text


async def test_diarize_failure_does_not_block_merge(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                    diarization_provider: FakeDiarizationProvider) -> None:
    await _two_source_meeting(client3)
    diarization_provider.fail_with = InvalidAudioError("bad audio")
    await runner3.run_until_idle()
    with ctx3.db.read() as conn:
        m = repo.get_meeting(conn, "m-1")
        segs = repo.list_segments(conn, "m-1", merged_version=1)
        jobs = {j.job_type: j.status for j in repo.list_jobs(conn, "m-1") if j.job_type in ("diarize_meeting", "merge_transcript")}
    assert m.status == "completed" and all(s.speaker_id is None for s in segs)
    assert jobs == {"diarize_meeting": "failed", "merge_transcript": "completed"}


async def test_diarize_model_missing_does_not_wait(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                  diarization_provider: FakeDiarizationProvider) -> None:
    await _two_source_meeting(client3)
    diarization_provider.fail_with = ModelMissingError("no model")
    await runner3.run_until_idle()
    with ctx3.db.read() as conn:
        assert repo.get_meeting(conn, "m-1").status == "completed"                      # 無期限 retry で止まらない（§9）


def _seg(i: str, source: str, chunk: str, s: int, e: int, text: str, index: int = 0) -> Segment:
    return Segment(id=i, meeting_id="m", chunk_id=chunk, source=source, segment_index=index, start_ms=s, end_ms=e, text=text,
                   normalized_text=normalize(text), confidence=0.5, created_at=0)


async def test_echo_from_system_is_dropped_on_mic(ctx3: AppContext) -> None:
    from minutes_local.db.models import AudioChunk, Meeting
    t = now_ms()
    async with ctx3.db.write() as conn:
        repo.insert_meeting(conn, Meeting(id="m", title="t", status="transcribing", session_start_epoch_ms=0, native_sample_rate=16000,
                                          consent_confirmed_at=1, created_at=t, updated_at=t))
        for cid, src in (("c-mic", "mic"), ("c-sys", "system")):
            repo.upsert_chunk(conn, AudioChunk(id=cid, meeting_id="m", source=src, sequence_no=0, start_offset_ms=0, end_offset_ms=30000,
                                               duration_ms=30000, sample_count=480000, local_path="x", size_bytes=1, sha256="x", created_at=t))
        # insert_segments は lease を検証する（Phase 2 §8 の fencing）。テストでも実際に lease したジョブの名義で書く
        repo.insert_job(conn, "m", "transcribe_chunk", chunk_id="c-mic")
        job = repo.lease_job(conn, "w-test", ["transcribe_chunk"], now_ms())
        assert job is not None
        written = repo.insert_segments(conn, [
            _seg("s1", "system", "c-sys", 1000, 4000, "来週までに対応します"),
            _seg("m1", "mic", "c-mic", 1200, 4100, "来週までに対応します。"),   # エコー
            _seg("m2", "mic", "c-mic", 5000, 8000, "了解しました", index=1),    # 本人の発話
        ], job_id=job.id, owner="w-test", attempts=job.attempts)
        assert written == 3
        report = run_merge(conn, "m", Thresholds())
        rows = {r["id"]: (r["merged_version"], r["merge_reason"]) for r in conn.execute("SELECT id, merged_version, merge_reason FROM transcript_segments").fetchall()}
    assert report.echo == 1 and report.kept == 2
    assert rows["m1"] == (None, "echo_of:s1") and rows["m2"] == (1, "kept") and rows["s1"] == (1, "kept")


# ---- 実 Provider の時刻の組み立て（pyannote 本体なしで確かめる。§12） ----

class _FakeTurn:
    def __init__(self, start: float, end: float) -> None:
        self.start, self.end = start, end


class _FakeAnnotation:
    def __init__(self, tracks: list[tuple[float, float, str]]) -> None:
        self.tracks = tracks

    def itertracks(self, yield_label: bool = False) -> Iterator[tuple[_FakeTurn, None, str]]:
        for start, end, speaker in self.tracks:
            yield _FakeTurn(start, end), None, speaker


class _FakePipeline:
    """pyannote の Pipeline の代わり。渡された WAV の場所・長さと引数を記録し、決めた区間（秒）を返す。"""

    def __init__(self, tracks: list[tuple[float, float, str]]) -> None:
        self.tracks = tracks
        self.calls: list[tuple[Path, int, dict[str, Any]]] = []

    def __call__(self, path: str, **kwargs: Any) -> _FakeAnnotation:
        self.calls.append((Path(path), parse_wav_header(Path(path).read_bytes()).sample_count, kwargs))
        return _FakeAnnotation(self.tracks)


def test_assemble_timeline_pads_gaps_with_silence() -> None:
    """Chunk を絶対時刻の位置に置く。渡されなかった区間（無音で STT を省いた Chunk・欠損）は無音で埋め、後ろの時刻をずらさない。"""
    # Arrange: 1 秒の Chunk が 2 秒目と 5 秒目にある（順不同で渡す）
    one = b"\x01\x00" * 16000
    # Act
    base_ms, pcm = assemble_timeline([(5000, one), (2000, one)])
    # Assert: 2〜3 秒が音声、3〜5 秒が無音、5〜6 秒が音声
    assert base_ms == 2000 and len(pcm) == 4 * 32000
    assert pcm[:32000] == one and pcm[32000:96000] == b"\x00" * 64000 and pcm[96000:] == one
    assert assemble_timeline([]) == (0, b"")


def test_pyannote_provider_keeps_absolute_time_across_skipped_chunk(tmp_path: Path) -> None:
    """無音で STT を省いた Chunk があっても、後ろの Chunk の話者区間が会議の時刻からずれない。"""
    # Arrange: 0〜30 秒と 60〜90 秒の Chunk（30〜60 秒は渡されない）。Pipeline は 60〜90 秒に 2 人目を返す
    pipeline = _FakePipeline([(0.0, 30.0, "SPEAKER_00"), (60.0, 90.0, "SPEAKER_01")])
    provider = PyannoteDiarizationProvider(pipeline=pipeline)
    chunk = sine_pcm(30)
    req = DiarizationRequest(meeting_id="m", pcm_by_source={"mic": [(0, chunk), (60000, chunk)]}, models_dir=str(tmp_path / "models"),
                             work_dir=str(tmp_path / "tmp"), max_speakers=4)
    # Act
    result = provider.diarize(req)
    # Assert: Pipeline には 90 秒の連続した音声が渡り、区間は絶対時刻のまま返る
    path, samples, kwargs = pipeline.calls[0]
    assert samples == 90 * 16000
    assert [(t.start_ms, t.end_ms, t.label) for t in result.turns] == [(0, 30000, "S1"), (60000, 90000, "S2")]
    assert kwargs == {"max_speakers": 4}                                              # 上限であって、人数の指定（num_speakers）ではない
    assert path.parent == tmp_path / "tmp" and not path.exists()                      # 音声はデータディレクトリの中に置き、終わったら消す


async def test_speaker_after_silent_chunk_is_not_shifted(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """無音 Chunk を挟んだ会議でも、後ろの Chunk のセグメントに正しい話者が付く（実 Provider の経路を Pipeline だけ差し替えて通す）。"""
    # Arrange: 音声・無音・音声の 3 Chunk。0〜30 秒が A、60〜90 秒が B
    pipeline = _FakePipeline([(0.0, 30.0, "A"), (60.0, 90.0, "B")])
    ctx3.diarization = PyannoteDiarizationProvider(pipeline=pipeline)
    await create_meeting(client3)
    for seq, pcm in enumerate([sine_pcm(30), silence_pcm(30), sine_pcm(30)]):
        await put_chunk(client3, "m-1", seq, pcm)
    await finalize(client3, "m-1", mic=3)
    # Act
    await runner3.run_until_idle()
    # Assert
    with ctx3.db.read() as conn:
        segs = repo.list_segments(conn, "m-1", merged_version=1)
    assert {s.speaker_id for s in segs if s.start_ms < 30000} == {"S1"}
    assert {s.speaker_id for s in segs if s.start_ms >= 60000} == {"S2"}
    assert pipeline.calls[0][0].parent == ctx3.settings.data_dir / "tmp"


async def test_diarize_that_keeps_crashing_does_not_block_merge(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """話者分離がプロセスごと落ち続けても（メモリ不足など）、回数を使い切ったら話者分離なしで merge へ進む。"""
    # Arrange: 話者分離のジョブが待機になるまで進める
    await _two_source_meeting(client3)
    while True:
        with ctx3.db.read() as conn:
            if any(j.job_type == "diarize_meeting" for j in repo.list_jobs(conn, "m-1")):
                break
        assert await runner3.run_once() is True
    # Act: lease しては結果を報告せずに落ちる、を max_attempts 回くり返す
    for _ in range(5):
        async with ctx3.db.write() as conn:
            job = repo_phase3.lease_job_fair(conn, "w-dead", ["diarize_meeting"], now_ms())
            assert job is not None
            conn.execute("UPDATE processing_jobs SET lease_until = 0 WHERE id = ?", (job.id,))
        await sweep_once(ctx3.db)
    await runner3.run_until_idle()
    # Assert: 会議は完了し、話者ラベルは付かない
    with ctx3.db.read() as conn:
        meeting = repo.get_meeting(conn, "m-1")
        segs = repo.list_segments(conn, "m-1", merged_version=1)
    assert meeting is not None and meeting.status == "completed"
    assert segs and all(s.speaker_id is None for s in segs)
```

## 23.5 言語認識

```python
# tests/test_language.py
from __future__ import annotations

import json

import httpx

from minutes_local.db import repo
from minutes_local.jobs.context import AppContext
from minutes_local.jobs.runner import JobRunner
from minutes_local.llm.fake_provider import FakeSummaryProvider
from minutes_local.llm.prompts import MIXED_NOTE_JA, SYSTEM_EN, SYSTEM_JA
from minutes_local.stt.fake_provider import FakeSTTProvider
from minutes_local.stt.language import LanguageGuess, resolve_chunk_language
from tests.conftest import create_meeting, finalize, put_chunk, sine_pcm


def test_resolve_chunk_language_rules() -> None:
    assert resolve_chunk_language("en", LanguageGuess("ja", 0.99), "ja", 0.6) == ("en", "fixed")
    assert resolve_chunk_language("auto", LanguageGuess("en", 0.9), "ja", 0.6) == ("en", "detected")
    assert resolve_chunk_language("auto", LanguageGuess("en", 0.4), "ja", 0.6) == ("ja", "fallback_primary")
    assert resolve_chunk_language("auto", LanguageGuess("en", 0.4), None, 0.6) == ("ja", "fallback_default")
    assert resolve_chunk_language("auto", None, None, 0.6) == ("ja", "fallback_default")


async def test_auto_detects_per_chunk_and_mixed_summary_language(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                                 stt_provider: FakeSTTProvider, llm_provider: FakeSummaryProvider) -> None:
    await client3.put("/v1/settings", json={"language": "auto", "summaryLanguage": "ja"})
    await create_meeting(client3)
    for seq in range(2):
        await put_chunk(client3, "m-1", seq, sine_pcm(30))
    await finalize(client3, "m-1", mic=2)
    await runner3.run_until_idle()
    assert [c.language for c in stt_provider.calls] == ["ja", "en"]                     # Chunk ごとに判定
    with ctx3.db.read() as conn:
        m = repo.get_meeting(conn, "m-1")
        segs = repo.list_segments(conn, "m-1", merged_version=1)
    assert {s.language for s in segs} == {"ja", "en"}
    ratio = json.loads(m.language_ratio_json)
    # Chunk 1 は Overlap 3 秒ぶん長い（33 秒）ため en がやや多い：ja ≈ 30/63、en ≈ 33/63
    assert abs(ratio["ja"] - 30 / 63) < 0.01 and abs(ratio["en"] - 33 / 63) < 0.01
    assert (await client3.get("/v1/meetings/m-1")).json()["languageRatio"] == ratio
    # 混在（主言語比率 < 0.6）→ summary_language=ja、注記付き
    req = llm_provider.requests[0]
    assert req.system == SYSTEM_JA and MIXED_NOTE_JA in req.user        # 注記は map_prompt の見出し行の直後に入る
    assert m.summary_language == "ja"


async def test_dominant_language_selects_prompt(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                llm_provider: FakeSummaryProvider) -> None:
    ctx3.language = None                                                                # 判定器なし → fixed
    await client3.put("/v1/settings", json={"language": "en"})
    await create_meeting(client3)
    await put_chunk(client3, "m-1", 0, sine_pcm(30))
    await finalize(client3, "m-1", mic=1)
    await runner3.run_until_idle()
    req = llm_provider.requests[0]
    assert req.system == SYSTEM_EN and MIXED_NOTE_JA not in req.user
    with ctx3.db.read() as conn:
        assert json.loads(repo.get_meeting(conn, "m-1").language_ratio_json) == {"en": 1.0}
```

## 23.6 圧縮・バックアップ・復旧

```python
# tests/test_codec_recovery.py
from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest

from minutes_local.bootstrap import build_context, open_database_with_recovery
from minutes_local.config import Settings
from minutes_local.db import repo, repo_phase3
from minutes_local.db.models import Meeting
from minutes_local.db.connection import Database, now_ms
from minutes_local.jobs import scheduler
from minutes_local.jobs.context import AppContext
from minutes_local.jobs.handlers import handle_compress, read_chunk_pcm
from minutes_local.jobs.runner import JobRunner
from minutes_local.llm.fake_provider import FakeSummaryProvider
from minutes_local.storage import backup
from minutes_local.storage.codec import FakeCodec
from minutes_local.storage.files import read_pcm
from minutes_local.storage.rebuild import RebuildReport, rebuild
from minutes_local.stt.fake_provider import FakeSTTProvider
from tests.conftest import GPU_HW, create_meeting, finalize, put_chunk, sine_pcm


async def _completed_meeting(client3: httpx.AsyncClient, runner3: JobRunner, ctx3: AppContext) -> None:
    await create_meeting(client3)
    for seq in range(2):
        await put_chunk(client3, "m-1", seq, sine_pcm(30))
    await finalize(client3, "m-1", mic=2)
    await runner3.run_until_idle()
    async with ctx3.db.write() as conn:
        conn.execute("UPDATE meetings SET ended_at = 1 WHERE id = 'm-1'")              # 7 日以上前に終了したことにする


async def test_compress_replaces_wav_after_roundtrip(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    await _completed_meeting(client3, runner3, ctx3)
    assert await scheduler.schedule_compression(ctx3) == 2
    assert await scheduler.schedule_compression(ctx3) == 0                              # 冪等
    assert await runner3.run_until_idle() == 2
    with ctx3.db.read() as conn:
        chunks = repo.list_chunks(conn, "m-1")
    for c in chunks:
        assert c.codec == "fake" and c.local_path.endswith(".fake") and c.sha256_flac is not None
        assert (ctx3.settings.data_dir / c.local_path).exists()
        assert not (ctx3.settings.data_dir / c.local_path).with_suffix(".wav").exists()
        pcm = read_pcm(ctx3.settings.data_dir, c.local_path, c.sha256, FakeCodec())      # WAV sha256 で照合できる
        assert len(pcm) == 960000
    # 圧縮後も finalize の検証（codec != wav はファイル存在のみ）と transcript 取得が壊れない
    assert (await finalize(client3, "m-1", mic=2)).status_code == 200
    assert (await client3.get("/v1/meetings/m-1/transcript")).status_code == 200


@pytest.mark.parametrize("corrupt", ["truncated", "garbage"])
async def test_resend_repairs_corrupted_compressed_chunk(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                         corrupt: str) -> None:
    """圧縮済みファイルが残っていても、復号した WAV の sha256 が合わなければ再 PUT で WAV に書き戻す（§2.4 修復）。"""
    # Arrange: 圧縮した後、Chunk 0 の圧縮ファイルを壊す
    await _completed_meeting(client3, runner3, ctx3)
    await scheduler.schedule_compression(ctx3)
    await runner3.run_until_idle()
    with ctx3.db.read() as conn:
        c = repo.get_chunk_by_key(conn, "m-1", "mic", 0)
    path = ctx3.settings.data_dir / c.local_path
    data = path.read_bytes()
    path.write_bytes(data[:-100] if corrupt == "truncated" else b"xx")
    # Act: ブラウザが同じ内容を再送する
    r = await put_chunk(client3, "m-1", 0, sine_pcm(30))
    # Assert
    assert r.status_code == 200 and r.json()["registered"] is True
    with ctx3.db.read() as conn:
        repaired = repo.get_chunk_by_key(conn, "m-1", "mic", 0)
    assert repaired.codec == "wav" and repaired.save_status == "registered"
    assert len(read_pcm(ctx3.settings.data_dir, repaired.local_path, repaired.sha256)) == 960000


async def test_compress_keeps_wav_when_roundtrip_mismatches(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    await _completed_meeting(client3, runner3, ctx3)
    ctx3.codec = FakeCodec(corrupt=True)
    await scheduler.schedule_compression(ctx3)
    await runner3.run_until_idle()
    with ctx3.db.read() as conn:
        chunks = repo.list_chunks(conn, "m-1")
        jobs = [j for j in repo.list_jobs(conn, "m-1") if j.job_type == "compress_chunk"]
    assert all(c.codec == "wav" and (ctx3.settings.data_dir / c.local_path).exists() for c in chunks)
    assert all(j.status == "failed" and j.error_class == "INVALID_AUDIO" for j in jobs)


async def test_backup_prune_and_restore(ctx3: AppContext) -> None:
    s = ctx3.settings
    paths = [backup.create_backup(ctx3.db, s.backups_dir) for _ in range(3)]
    assert all(p.exists() for p in paths) and len(backup.list_backups(s.backups_dir)) == 3
    assert backup.prune_backups(s.backups_dir, keep=2) == 1
    assert backup.list_backups(s.backups_dir) == paths[1:]
    ctx3.db.close()
    s.db_path.write_bytes(b"garbage" * 100)                                             # DB 破損を再現
    assert backup.integrity_ok(s.db_path) is False
    db, recovery = open_database_with_recovery(s)
    assert recovery is not None and recovery.restored_from == paths[-1] and backup.integrity_ok(s.db_path)
    assert any(p.name.startswith("minutes.sqlite.corrupt-") for p in s.data_dir.iterdir())
    db.close()
    ctx3.db = Database(s.db_path)                                                        # fixture の close 用


async def test_rebuild_from_recordings(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    await _completed_meeting(client3, runner3, ctx3)
    with ctx3.db.read() as conn:
        before = {c.sequence_no: c.sha256 for c in repo.list_chunks(conn, "m-1")}
    async with ctx3.db.write() as conn:
        conn.execute("DELETE FROM meetings WHERE id = 'm-1'")                            # CASCADE で chunks も消える
        assert repo.get_meeting(conn, "m-1") is None
    with ctx3.db.write_sync() as conn:
        report = rebuild(conn, ctx3.settings.data_dir, ctx3.codec)
        m = repo.get_meeting(conn, "m-1")
        after = {c.sequence_no: c.sha256 for c in repo.list_chunks(conn, "m-1")}
    assert report.meetings_created == 1 and report.chunks_created == 2 and report.skipped_files == []
    assert m is not None and m.local_user_id == "local" and m.status == "finalized" and m.title == "t"
    assert after == before


async def test_rebuild_keeps_end_time_from_phase2_snapshot(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """meeting.json の終了時刻のキーは Phase 1/2 と同じ endedAtEpochMs。移行 012 で移した Phase 2 の控えからも、rebuild は終了時刻を失わない。"""
    await _completed_meeting(client3, runner3, ctx3)
    path = ctx3.settings.data_dir / "recordings" / "local" / "m-1" / "meeting.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    assert "endedAt" not in snapshot and snapshot["endedAtEpochMs"] is not None          # Phase 2 §21.2 の確定 API と同じキー
    for key in ("localUserId", "chunks"):                                                # Phase 2 の控えにはない項目を落とす
        del snapshot[key]
    path.write_text(json.dumps(snapshot), encoding="utf-8")
    async with ctx3.db.write() as conn:
        conn.execute("DELETE FROM meetings WHERE id = 'm-1'")
    with ctx3.db.write_sync() as conn:
        rebuild(conn, ctx3.settings.data_dir, ctx3.codec)
        m = repo.get_meeting(conn, "m-1")
    assert m is not None and m.ended_at == snapshot["endedAtEpochMs"] and m.ended_at is not None


def _rewrite_snapshot_and_rebuild(ctx3: AppContext, **fields: object) -> tuple[RebuildReport, Meeting | None]:
    """meeting.json の項目を書き換え、DB 行を消してから rebuild する。"""
    path = ctx3.settings.data_dir / "recordings" / "local" / "m-1" / "meeting.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    snapshot.update(fields)
    path.write_text(json.dumps(snapshot), encoding="utf-8")
    with ctx3.db.write_sync() as conn:
        conn.execute("DELETE FROM meetings WHERE id = 'm-1'")
        report = rebuild(conn, ctx3.settings.data_dir, ctx3.codec)
        return report, repo.get_meeting(conn, "m-1")


async def test_rebuild_keeps_valid_stop_pair(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """有効な停止理由と検出時刻の組は、rebuild 後もそのまま残る。"""
    await _completed_meeting(client3, runner3, ctx3)
    report, m = _rewrite_snapshot_and_rebuild(ctx3, stopReason="mic_ended", stopDetectedAtEpochMs=1_700_000_000_000)
    assert report.meetings_created == 1 and report.skipped_files == []
    assert m is not None and m.stop_reason == "mic_ended" and m.stop_detected_at == 1_700_000_000_000


@pytest.mark.parametrize(("reason", "detected"), [
    ("unplugged", 1),                 # 未知の停止理由
    ("manual", -1),                   # 範囲外（負）
    ("manual", 2**63),                # 範囲外（SQLite INTEGER 超過）
    ("manual", True),                 # bool は int のサブクラスだが時刻ではない
    ("manual", "1"),                  # 文字列
    (None, 1),                        # 片方だけ
])
async def test_rebuild_drops_malformed_stop_pair(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                 reason: object, detected: object) -> None:
    """不正な停止理由・検出時刻は組ごと None にし、rebuild 全体を止めない（会議と Chunk は復元する）。"""
    await _completed_meeting(client3, runner3, ctx3)
    report, m = _rewrite_snapshot_and_rebuild(ctx3, stopReason=reason, stopDetectedAtEpochMs=detected)
    assert report.meetings_created == 1 and report.chunks_created == 2
    assert m is not None and m.status == "finalized" and m.stop_reason is None and m.stop_detected_at is None


@pytest.mark.parametrize("ended", [-1, 2**63, True, "1700000000000", 1.5])
async def test_rebuild_drops_malformed_end_time(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner, ended: object) -> None:
    """SQLite INTEGER に入らない・整数でない終了時刻は None にし、rebuild 全体を止めない（会議と Chunk は復元する）。"""
    # Arrange / Act
    await _completed_meeting(client3, runner3, ctx3)
    report, m = _rewrite_snapshot_and_rebuild(ctx3, endedAtEpochMs=ended)
    # Assert
    assert report.meetings_created == 1 and report.chunks_created == 2
    assert m is not None and m.status == "finalized" and m.ended_at is None


async def test_missing_chunk_is_reported_for_resync(client3: httpx.AsyncClient, ctx3: AppContext) -> None:
    await create_meeting(client3)
    pcm = sine_pcm(30)
    await put_chunk(client3, "m-1", 0, pcm)
    with ctx3.db.read() as conn:
        c = repo.get_chunk_by_key(conn, "m-1", "mic", 0)
    (ctx3.settings.data_dir / c.local_path).unlink()                                    # ディスク障害を再現
    r = await finalize(client3, "m-1", mic=1)
    assert r.status_code == 409
    listed = (await client3.get("/v1/meetings/m-1/chunks")).json()["chunks"]
    assert listed[0]["registered"] is False                                             # ブラウザ側が逆同期する契機
    r2 = await put_chunk(client3, "m-1", 0, pcm)                                        # 逆同期（同一内容の再 PUT）
    assert r2.status_code == 200 and r2.json()["registered"] is True
    assert (await finalize(client3, "m-1", mic=1)).status_code == 200


def test_flac_codec_roundtrip_is_bit_exact() -> None:
    """実コーデック（libsndfile）。往復で PCM が 1 ビットも変わらず、壊れた入力は ValueError になる（extras 未導入なら skip）。"""
    pytest.importorskip("soundfile")
    from minutes_local.storage.codec import FlacCodec
    # Arrange: 極値（-32768 / 32767）を含む 1 秒
    codec = FlacCodec()
    pcm = sine_pcm(1) + (-32768).to_bytes(2, "little", signed=True) + (32767).to_bytes(2, "little", signed=True)
    # Act
    encoded = codec.encode(pcm)
    # Assert
    assert codec.decode(encoded) == pcm and len(encoded) < len(pcm)
    for broken in (b"", b"xx", encoded[: len(encoded) // 2]):
        with pytest.raises(ValueError):
            codec.decode(broken)


# ---- 圧縮と読み取りの競合 ----

async def _compress_job(ctx3: AppContext, seq: int = 0):  # type: ignore[no-untyped-def]
    with ctx3.db.read() as conn:
        chunk = repo.get_chunk_by_key(conn, "m-1", "mic", seq)
        job = next(j for j in repo.list_jobs(conn, "m-1") if j.job_type == "compress_chunk" and j.chunk_id == chunk.id)
    return chunk, job


async def test_reader_follows_chunk_replaced_by_compression(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """読み取りの直前に圧縮でファイルが置き換わっても、行を読み直して新しいパスから読む（Chunk を欠損にしない）。"""
    # Arrange: 圧縮前に読んだ行（WAV のパス）を持ったまま、圧縮が終わる
    await _completed_meeting(client3, runner3, ctx3)
    with ctx3.db.read() as conn:
        stale = repo.get_chunk_by_key(conn, "m-1", "mic", 0)
    await scheduler.schedule_compression(ctx3)
    await runner3.run_until_idle()
    assert not (ctx3.settings.data_dir / stale.local_path).exists()
    # Act
    pcm = read_chunk_pcm(ctx3, stale)
    # Assert
    assert len(pcm) == 960000


async def test_compress_does_not_switch_after_job_was_withdrawn(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """STT の再実行がジョブを消した後は、実行中だった圧縮が Chunk を切り替えない（WAV のまま、圧縮ファイルも残さない）。"""
    # Arrange: 圧縮ジョブを lease した後で、再実行がジョブを行ごと消す
    await _completed_meeting(client3, runner3, ctx3)
    await scheduler.schedule_compression(ctx3)
    async with ctx3.db.write() as conn:
        job = repo_phase3.lease_job_fair(conn, "w-old", ["compress_chunk"], now_ms())
        assert job is not None
        conn.execute("DELETE FROM processing_jobs WHERE id = ?", (job.id,))
    # Act
    await handle_compress(ctx3, job)
    # Assert
    with ctx3.db.read() as conn:
        chunk = repo.get_chunk(conn, job.chunk_id)
    path = ctx3.settings.data_dir / chunk.local_path
    assert chunk.codec == "wav" and path.exists() and not path.with_suffix(".fake").exists()


async def test_compress_retry_removes_wav_left_by_crash(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """切り替えのコミット後・WAV の削除前に落ちた場合、やり直しのジョブが残った WAV を消す。"""
    # Arrange: 圧縮済みの Chunk の隣に WAV が残っている
    await _completed_meeting(client3, runner3, ctx3)
    await scheduler.schedule_compression(ctx3)
    await runner3.run_until_idle()
    chunk, job = await _compress_job(ctx3)
    leftover = (ctx3.settings.data_dir / chunk.local_path).with_suffix(".wav")
    leftover.write_bytes(b"left by crash")
    # Act
    await handle_compress(ctx3, job)
    # Assert
    assert not leftover.exists() and (ctx3.settings.data_dir / chunk.local_path).exists()


# ---- バックアップ ----

async def test_backup_failure_leaves_no_partial_file(ctx3: AppContext, monkeypatch: pytest.MonkeyPatch) -> None:
    """書きかけのバックアップを正規の名前で残さない（残ると復元元に選ばれる）。"""
    # Arrange: 一時ファイルから正規の名前への付け替えで失敗させる
    def fail_replace(_src: object, _dst: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", fail_replace)
    # Act / Assert
    with pytest.raises(OSError):
        backup.create_backup(ctx3.db, ctx3.settings.backups_dir)
    assert list(ctx3.settings.backups_dir.iterdir()) == []


async def test_restore_skips_broken_backup(ctx3: AppContext) -> None:
    """最新のバックアップが壊れていても、検査に通る最も新しいものから復元する。"""
    # Arrange
    s = ctx3.settings
    good = backup.create_backup(ctx3.db, s.backups_dir)
    (s.backups_dir / "minutes-9999999999999.sqlite").write_bytes(b"partial")
    (s.backups_dir / "minutes-9999999999998.sqlite").write_bytes(b"")                 # 空のファイルは integrity_check に通るが中身がない
    ctx3.db.close()
    s.db_path.write_bytes(b"garbage" * 100)
    # Act
    db, recovery = open_database_with_recovery(s)
    # Assert
    assert recovery is not None and recovery.restored_from == good and backup.integrity_ok(s.db_path)
    db.close()
    ctx3.db = Database(s.db_path)                                                        # fixture の close 用


@pytest.mark.parametrize("with_backup", [True, False])
async def test_startup_recovery_rebuilds_meetings_missing_from_database(
        client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner, settings: Settings,
        stt_provider: FakeSTTProvider, llm_provider: FakeSummaryProvider, with_backup: bool) -> None:
    """DB が壊れたら、バックアップ（なければ空の DB）で起動し、録音ファイルから会議を作り直す。起動を止めない。"""
    # Arrange: バックアップの後で録音した会議がある状態で DB が壊れる
    backed_up = backup.create_backup(ctx3.db, settings.backups_dir) if with_backup else None
    await _completed_meeting(client3, runner3, ctx3)
    ctx3.db.close()
    settings.db_path.write_bytes(b"garbage" * 100)
    # Act
    c = await build_context(settings, stt_provider=stt_provider, llm_provider=llm_provider, hardware=GPU_HW, codec=FakeCodec())
    # Assert
    try:
        assert c.recovery is not None and c.recovery.restored_from == backed_up
        assert c.recovery.rebuilt.meetings_created == 1 and c.recovery.rebuilt.chunks_created == 2
        with c.db.read() as conn:
            m = repo.get_meeting(conn, "m-1")
        assert m is not None and m.status == "finalized"                                 # serve が resume_finalized でジョブを作り直す
    finally:
        c.stt.shutdown()
        c.db.close()
    ctx3.db = Database(settings.db_path)                                                 # fixture の close 用


# ---- 日次処理 ----

async def test_scheduler_backs_up_only_when_a_day_has_passed(ctx3: AppContext) -> None:
    """起動のたびにバックアップを作らない（短時間の再起動の繰り返しで、古い世代が押し出されない）。"""
    # Arrange
    day = 24 * 3600 * 1000
    t0 = now_ms()
    # Act
    first = await scheduler.run_once(ctx3, now=t0)
    second = await scheduler.run_once(ctx3, now=t0 + day - 1)
    third = await scheduler.run_once(ctx3, now=t0 + day)
    # Assert
    assert (first["backup"], second["backup"], third["backup"]) == (1, 0, 1)
    assert [backup.backup_time_ms(p) for p in backup.list_backups(ctx3.settings.backups_dir)] == [t0, t0 + day]


async def test_scheduler_loop_survives_failed_iteration(ctx3: AppContext, monkeypatch: pytest.MonkeyPatch) -> None:
    """バックアップの失敗（ディスク満杯など）で日次処理のループが終わらない。"""
    # Arrange: 1 回目のバックアップだけ失敗させる
    stop = asyncio.Event()
    calls = 0
    real = backup.create_backup

    def flaky(db: Database, backups_dir, now=None):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("disk full")
        stop.set()
        return real(db, backups_dir, now)

    monkeypatch.setattr(backup, "create_backup", flaky)
    # Act
    await asyncio.wait_for(scheduler.run_forever(ctx3, stop, interval_s=0.01), timeout=5)
    # Assert: 失敗の後の周回でバックアップができている
    assert calls == 2 and len(backup.list_backups(ctx3.settings.backups_dir)) == 1


# ---- 再構築（壊れた meeting.json・確定前の会議） ----

async def test_rebuild_restores_unfinalized_meeting_as_recording(client3: httpx.AsyncClient, ctx3: AppContext) -> None:
    """確定前の控えしかない会議は recording で復元する。ブラウザが残りの Chunk を送って確定できる（finalized にすると 409 で受け取れない）。"""
    # Arrange: 確定していない会議の行が失われる
    await create_meeting(client3)
    await put_chunk(client3, "m-1", 0, sine_pcm(30))
    with ctx3.db.write_sync() as conn:
        conn.execute("DELETE FROM meetings WHERE id = 'm-1'")
        # Act
        rebuild(conn, ctx3.settings.data_dir, ctx3.codec)
        m = repo.get_meeting(conn, "m-1")
    # Assert: 続きの Chunk と確定を受け付ける
    assert m is not None and m.status == "recording"
    assert (await put_chunk(client3, "m-1", 1, sine_pcm(30))).status_code in (200, 201)
    assert (await finalize(client3, "m-1", mic=2)).status_code == 200


@pytest.mark.parametrize("fields", [
    {"sessionStartEpochMs": "abc"},                                                   # 数値でない
    {"nativeSampleRate": None},
    {"totalAudioFrames": 2**70},                                                      # SQLite INTEGER 超過
    {"title": 123},
    {"chunks": [1]},                                                                  # 要素がオブジェクトでない
    {"chunks": {"source": "mic"}},                                                    # 配列でない
    {"chunks": [{"source": "mic", "sequenceNo": "x"}]},
    {"chunks": [{"source": "mic", "sequenceNo": 0, "startOffsetMs": "z", "endOffsetMs": None, "vadScore": "high", "hasVoice": "yes"}]},
])
async def test_rebuild_tolerates_malformed_snapshot_fields(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner,
                                                           fields: dict[str, object]) -> None:
    """meeting.json の項目が壊れていても既定値に置き換え、rebuild 全体を止めない（会議と Chunk は復元する）。"""
    # Arrange / Act
    await _completed_meeting(client3, runner3, ctx3)
    report, m = _rewrite_snapshot_and_rebuild(ctx3, **fields)
    # Assert
    assert report.meetings_created == 1 and report.chunks_created == 2 and m is not None
    with ctx3.db.read() as conn:
        first = repo.get_chunk_by_key(conn, "m-1", "mic", 0)
    assert first is not None and (first.start_offset_ms, first.end_offset_ms, first.has_voice) == (0, 30000, True)


async def test_rebuild_tolerates_snapshot_that_is_not_an_object(client3: httpx.AsyncClient, ctx3: AppContext, runner3: JobRunner) -> None:
    """meeting.json の最上位がオブジェクトでなくても、控えなしとして復元する。"""
    # Arrange
    await _completed_meeting(client3, runner3, ctx3)
    (ctx3.settings.data_dir / "recordings" / "local" / "m-1" / "meeting.json").write_text("[1, 2]", encoding="utf-8")
    # Act
    with ctx3.db.write_sync() as conn:
        conn.execute("DELETE FROM meetings WHERE id = 'm-1'")
        report = rebuild(conn, ctx3.settings.data_dir, ctx3.codec)
        m = repo.get_meeting(conn, "m-1")
    # Assert
    assert report.meetings_created == 1 and report.chunks_created == 2
    assert m is not None and m.title == "復元された会議" and m.status == "finalized"
```

## 23.7 LAN 共有

```python
# tests/test_users_lan.py
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from minutes_local.auth.tls import certificate_hostnames, generate_self_signed
from minutes_local.auth.users import create_user
from minutes_local.db import repo_phase3
from minutes_local.db.connection import now_ms
from minutes_local.jobs.context import AppContext
from tests.conftest import BASE, _client_for, create_meeting, put_chunk, sine_pcm


async def _two_users(ctx3: AppContext) -> tuple[tuple[str, str], tuple[str, str]]:
    async with ctx3.db.write() as conn:
        a, ta = create_user(conn, "alice")
        b, tb = create_user(conn, "bob")
    ctx3.multi_user = True
    return (a.id, ta), (b.id, tb)


async def test_users_are_isolated(ctx3: AppContext) -> None:
    (aid, ta), (bid, tb) = await _two_users(ctx3)
    ca, cb = await _client_for(ctx3, ta), await _client_for(ctx3, tb)
    try:
        assert (await ca.get("/v1/users/me")).json() == {"userId": aid, "name": "alice", "multiUser": True}
        anon = httpx.AsyncClient(transport=ca._transport, base_url=BASE)
        assert (await anon.get("/v1/meetings", headers={"Authorization": "Bearer test-token"})).status_code == 401   # 旧 token は無効
        await create_meeting(ca, "m-a")
        r = await put_chunk(ca, "m-a", 0, sine_pcm(30))
        assert r.json()["path"] == f"recordings/{aid}/m-a/mic/000000.wav"
        assert (ctx3.settings.data_dir / r.json()["path"]).exists()
        assert (await cb.get("/v1/meetings/m-a")).status_code == 404                     # 存在を漏らさない
        assert (await cb.get("/v1/meetings/m-a/chunks")).status_code == 404
        assert (await cb.put("/v1/meetings/m-a/chunks/mic/1", content=b"x")).status_code == 404
        assert [m["meetingId"] for m in (await cb.get("/v1/meetings")).json()["meetings"]] == []
        assert [m["meetingId"] for m in (await ca.get("/v1/meetings")).json()["meetings"]] == ["m-a"]
        assert (await ca.get("/v1/health")).json()["capabilities"]["multiUser"] is True
    finally:
        await ca.aclose()
        await cb.aclose()


async def test_fair_lease_prefers_user_with_fewer_running_jobs(ctx3: AppContext) -> None:
    (aid, _), (bid, _) = await _two_users(ctx3)
    t = now_ms()
    async with ctx3.db.write() as conn:
        for mid, uid in (("m-a", aid), ("m-b", bid)):
            conn.execute("INSERT INTO meetings (id,local_user_id,title,status,session_start_epoch_ms,native_sample_rate,consent_confirmed_at,created_at,updated_at) VALUES (?,?,?,'transcribing',0,16000,1,?,?)", (mid, uid, "t", t, t))
        # alice は既に 1 件実行中、両者に pending が 1 件ずつ（alice の方が先に作られている）
        # 同一会議に同種ジョブは 1 件（部分一意インデックス）なので、alice の実行中と待機は別種にする
        conn.execute("INSERT INTO processing_jobs (id,meeting_id,job_type,status,priority,created_at,updated_at) VALUES ('ja-run','m-a','diarize_meeting','processing',150,?,?)", (t, t))
        conn.execute("INSERT INTO processing_jobs (id,meeting_id,job_type,status,priority,created_at,updated_at) VALUES ('ja-pend','m-a','merge_transcript','pending',200,?,?)", (t - 10, t))
        conn.execute("INSERT INTO processing_jobs (id,meeting_id,job_type,status,priority,created_at,updated_at) VALUES ('jb-pend','m-b','merge_transcript','pending',200,?,?)", (t, t))
        first = repo_phase3.lease_job_fair(conn, "w", ["merge_transcript"], t + 1)
        second = repo_phase3.lease_job_fair(conn, "w", ["merge_transcript"], t + 1)
    assert first is not None and first.id == "jb-pend"                                  # bob（実行中 0 件）が先
    assert second is not None and second.id == "ja-pend"


def test_generate_self_signed_certificate(tmp_path: Path) -> None:
    cert, key = tmp_path / "tls" / "cert.pem", tmp_path / "tls" / "key.pem"
    generate_self_signed(cert, key, ["minutes.local", "192.168.1.10"])
    assert cert.exists() and key.exists()
    assert (key.stat().st_mode & 0o777) == 0o600
    assert set(certificate_hostnames(cert)) == {"minutes.local", "192.168.1.10"}


def test_serve_refuses_lan_bind_without_tls(capsys: pytest.CaptureFixture[str]) -> None:
    from minutes_local.__main__ import main
    assert main(["serve", "--bind", "0.0.0.0"]) == 2
    assert "requires --tls" in capsys.readouterr().err


def test_user_cli_rejects_duplicate_name_and_removes_user(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                          capsys: pytest.CaptureFixture[str]) -> None:
    """user add は同名を拒否し（トレースバックにしない）、user remove でトークンを失効できる。"""
    from minutes_local.__main__ import main
    # Arrange
    monkeypatch.setenv("MINUTES_DATA_DIR", str(tmp_path))
    assert main(["user", "add", "alice"]) == 0
    # Act / Assert: 同名は 1 で終わる
    assert main(["user", "add", "alice"]) == 1
    assert "already exists" in capsys.readouterr().err
    assert main(["user", "list"]) == 0
    user_id = capsys.readouterr().out.split()[0]
    # Act / Assert: 削除は 1 回だけ成功し、一覧から消える
    assert main(["user", "remove", user_id]) == 0
    assert main(["user", "remove", user_id]) == 1
    capsys.readouterr()
    assert main(["user", "list"]) == 0
    assert capsys.readouterr().out == ""


def test_doctor_rebuild_refuses_while_server_is_running(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                        capsys: pytest.CaptureFixture[str]) -> None:
    """serve が使っているデータディレクトリには rebuild をかけない（同じ Chunk の行を 2 つのプロセスが作り合う）。"""
    from minutes_local.__main__ import main
    from minutes_local.bootstrap import acquire_data_dir_lock
    # Arrange: 動いている serve の代わりにロックを持つ
    monkeypatch.setenv("MINUTES_DATA_DIR", str(tmp_path))
    lock = acquire_data_dir_lock(tmp_path)
    assert lock is not None
    try:
        # Act / Assert
        assert main(["doctor", "--rebuild"]) == 1
        assert "stop the server" in capsys.readouterr().err
    finally:
        os.close(lock)
```

## 23.8 テストと設計判断の対応

| §2 の判断 | テスト |
| --- | --- |
| Live：PUT 直後に生成、VAD なし、確定パイプラインに触れない、finalize 後に再利用 | `test_live_job_created_on_put_and_reused_after_finalize` |
| Live State（RUNNING / DEGRADED / STOPPED） | `test_live_state_degrades_with_lag` |
| Live の小区分既定オフと警告 | `test_live_disabled_on_small_tier_by_default` |
| 話者ラベル割当・名前は利用者・LLM 入力の `[S1:名前]` | `test_diarize_assigns_labels_and_names_are_user_assigned` |
| 分離失敗 / モデル未配置 / プロセスごと落ち続けても merge へ | `test_diarize_failure_does_not_block_merge`、`test_diarize_model_missing_does_not_wait`、`test_diarize_that_keeps_crashing_does_not_block_merge` |
| 実 Provider：無音 Chunk を挟んでも話者区間の時刻がずれない、上限は `max_speakers`、一時ファイルはデータディレクトリの中 | `test_assemble_timeline_pads_gaps_with_silence`、`test_pyannote_provider_keeps_absolute_time_across_skipped_chunk`、`test_speaker_after_silent_chunk_is_not_shifted` |
| エコー除去 | `test_echo_from_system_is_dropped_on_mic` |
| Chunk 単位言語判定・比率・混在時の要約言語 | `test_auto_detects_per_chunk_and_mixed_summary_language`、`test_dominant_language_selects_prompt`、`test_resolve_chunk_language_rules` |
| 圧縮の往復検証・不一致時の保持 | `test_compress_replaces_wav_after_roundtrip`、`test_compress_keeps_wav_when_roundtrip_mismatches`、`test_flac_codec_roundtrip_is_bit_exact`（実コーデック。`soundfile` がなければ skip） |
| 圧縮と他の処理の競合（読み取りの読み直し・再実行後は切り替えない・残った WAV の掃除） | `test_reader_follows_chunk_replaced_by_compression`、`test_compress_does_not_switch_after_job_was_withdrawn`、`test_compress_retry_removes_wav_left_by_crash` |
| バックアップ・整合性・再構築・逆同期 | `test_backup_prune_and_restore`、`test_rebuild_from_recordings`、`test_rebuild_keeps_end_time_from_phase2_snapshot`、`test_missing_chunk_is_reported_for_resync` |
| バックアップの原子性・壊れたバックアップを復元元にしない | `test_backup_failure_leaves_no_partial_file`、`test_restore_skips_broken_backup` |
| バックアップは 24 時間に 1 回・定期処理のループが失敗で終わらない | `test_scheduler_backs_up_only_when_a_day_has_passed`、`test_scheduler_loop_survives_failed_iteration` |
| 起動時の復旧（バックアップあり / なし）で録音ファイルから作り直す | `test_startup_recovery_rebuilds_meetings_missing_from_database` |
| 壊れた `meeting.json` で rebuild を止めない・確定前の会議は `recording` に戻す | `test_rebuild_drops_malformed_stop_pair`、`test_rebuild_drops_malformed_end_time`、`test_rebuild_tolerates_malformed_snapshot_fields`、`test_rebuild_tolerates_snapshot_that_is_not_an_object`、`test_rebuild_restores_unfinalized_meeting_as_recording` |
| 利用者分離・階層・公平 lease・TLS・LAN bind 拒否 | `test_users_lan.py` |
| CLI：同名の利用者の拒否と削除、serve の動作中は `doctor --rebuild` を断る | `test_user_cli_rejects_duplicate_name_and_removes_user`、`test_doctor_rebuild_refuses_while_server_is_running` |
| マイグレーション 009〜012 | `test_apply_phase3_moves_files_and_extends_job_types`、`test_apply_phase3_keeps_other_recordings_when_meeting_id_equals_user_id` |
| Phase 2 の回帰 | Phase 2 §23 の 131 件（`test_phase1_contract.py` は物理パスのみ更新。`test_phase1_server_compat.py` は `recording_dir()` 経由なので無変更） |

---

# 24. Invariant 対応・DoD・実装順序

## 24.1 Invariant 1〜10（Phase 3 で影響する箇所）

| Invariant | Phase 3 での担保 |
| --- | --- |
| 1 Live STT failure ≠ Recording failure | `live.on_chunk_registered` はジョブを生成するだけで PUT の成否に影響しない（例外は `insert_job` の冪等失敗のみ）。`handle_live_transcribe` は `stt_status` を触らない。Live ジョブの失敗は後続に影響しない（§9 `_on_failure`）。ブラウザ側は `NO_AUDIO_FRAMES` で Live を自動停止（client 文書 §8） |
| 2 AI failure ≠ Transcript loss | Phase 2 と同じ。要約言語の判定（§21 `_summary_language`）は読み取りのみ |
| 3 STT failure ≠ Recording loss | `handle_compress` は往復検証に成功し、lease が現行で、Chunk が読んだ時のままのときだけ WAV を消す。`read_pcm` は FLAC でも WAV sha256 で照合。読み取りは圧縮による置き換えを読み直して追う（`read_chunk_pcm`。正常な Chunk を `missing` にしない）。`rebuild` は既存行を上書きせず、確定前の会議を `recording` に戻して残りの Chunk を受け取れるようにする |
| 4 Queue failure ≠ Job metadata loss | 010 のテーブル再作成は `INSERT ... SELECT *` で行を保つ（§23.2）。`processing_jobs` が唯一の Job Store である点は不変 |
| 5 Duplicate delivery ≠ Duplicate transcript | `uq_live_job` / `uq_diarize_job` / `uq_compress_job`。`handle_live_transcribe` と `handle_transcribe` は既存セグメントがあれば挿入しない |
| 6 AI regeneration ≠ Manual note overwrite | 変更なし |
| 7 VAD false negative ≠ Original audio loss | Live はブラウザ VAD の `has_voice=false` をスキップするだけで、確定 STT は Phase 2 の経路（サーバー VAD + 手動 STT）で救済できる |
| 8 Browser tab hidden ≠ timer-based recording failure | サーバー側の日次スケジューラ・Sweeper は録音と無関係 |
| 9 Speaker source ≠ Speaker identity | ラベル `S1..Sn` は経路でも人物でもない。名前は `PUT /speakers` で利用者のみが付け、プロンプト v2 は名前付きラベル以外を担当者にしない（§15）。`validate` 段 4 は Phase 2 のまま |
| 10 Queue ≠ Source of Truth | `rebuild` が `recordings/` + `meeting.json` から `meetings` / `audio_chunks` を再構築できる。`backup` は SQLite を再構築可能なメタデータとして扱う。DB が壊れてバックアップが 1 つもなくても、空の DB で起動して録音ファイルから作り直す（§22） |

## 24.2 Definition of Done（Phase 3 サーバー側）

| 項目 | 状況 | 担保箇所 |
| --- | --- | --- |
| Live STT が録音中に段階的に出る（遅延 30〜60 秒） | 設計済・テスト済（生成・再利用）・実機（遅延） | §10、§23.3 |
| Live 有効時に `NO_AUDIO_FRAMES` が増えない | 実機 | client 文書 §8、`usage_metrics(live_lag_ms)` |
| 話者ラベルが付き、名前は利用者が割り当てる | 設計済・テスト済（Fake と、Pipeline を差し替えた実 Provider）・実機（pyannote 本体。§12 の表の「3-h」の行） | §12、§20.4、§23.4 |
| 話者分離なしでも transcript / 要約が完了する | テスト済 | §23.4 |
| 日英混在会議で Chunk ごとに言語が付き、要約言語が規則どおり | 設計済・テスト済・実機（判定精度） | §13、§21、§23.5 |
| FLAC 化後も STT 再実行・transcript 取得・finalize 再実行が動く | テスト済（Fake コーデック。実コーデックは往復と破損入力のみ）・実機（実コーデックでの一連の動作） | §16、§23.6 |
| DB 破損から自動復元（バックアップなしでも起動）、復元後に録音ファイルから自動で作り直す、`doctor --rebuild` で行を再構築 | テスト済 | §17、§18、§22、§23.6 |
| バックアップが 1 日 1 世代で、再起動の繰り返しで古い世代を失わない | テスト済 | §11、§23.6 |
| 欠損 Chunk が `registered=false` で返り、再 PUT で復旧 | テスト済 | §20.2、§23.6 |
| 利用者ごとの分離、公平 lease、TLS 証明書、LAN bind の TLS 必須 | テスト済（証明書生成）・実機（ブラウザ受け入れ・LAN 遅延） | §19、§20.1、§23.7 |
| Phase 1 §12・Phase 2 §14 の契約が不変 | テスト済 | §23.1（Phase 2 テストの回帰） |
| 外部通信ゼロ（`httpx` は 2 モジュールのみ） | テスト済 | Phase 2 `test_imports.py` が Phase 3 でも通る |

## 24.3 実装順序

| Step | 内容 | 通過すべきテスト |
| --- | --- | --- |
| 3-a | §1.1 `pyproject.toml`、§4 マイグレーション、§5〜§6 設定とモデル、§16 ファイル階層 | `test_migration_phase3.py`、Phase 2 の回帰 |
| 3-b | §7〜§9 パイプラインと Runner、§20 API | Phase 2 の回帰、`test_phase1_contract.py` |
| 3-c | §10 Live + §20.4 | `test_live.py` |
| 3-d | §12 話者分離 + §14 エコー + §15 プロンプト v2 | `test_diarization.py` |
| 3-e | §13 言語判定 + §21 `_summary_language` | `test_language.py` |
| 3-f | §16 コーデック + §11 スケジューラ + §17 バックアップ + §18 再構築 | `test_codec_recovery.py` |
| 3-g | §19 利用者・TLS + §20.1 所有者照合 + §22 CLI | `test_users_lan.py` |
| 3-h | 実機：pyannote / faster-whisper `detect_language` / libsndfile / LAN 2 台構成 | §24.2 の実機項目 |

Step の順序で気を付ける点：

* Phase 2 のファイルのうち `jobs/sweeper.py` と `db/repo.py` は Phase 3 で変更しないが、Phase 2 側の `pipeline.on_job_failed()`（Phase 2 §12）は Phase 3 の `jobs/pipeline.py` で `diarize_meeting` の分岐を足した版に置き換わる（§8）。3-b で `pipeline.py` を差し替えるときに落とさない
* 3-d の話者分離のテストは pyannote を入れずに通る（Pipeline の差し替え。§12）。`diarization` extras を入れるのは 3-h
* 3-f の `test_flac_codec_roundtrip_is_bit_exact` は `soundfile` がなければ skip になる。`dev` extras（§1.1）を入れて、skip ではなく通過になっていることを確かめる

3-h（実機）で確かめる項目と、結果を書き戻す場所：

| 項目 | 手順 | 書き戻す場所 |
| --- | --- | --- |
| pyannote のモデルの配置 | 配布元から取得し `{dataDir}/models/diarization/` に置く。`config.yaml` の参照をローカルの絶対パスにする。`doctor` の `diarization` 行が `available` になる | §12 の表「モデルの場所」「取得」 |
| 通信しないこと | ネットワークをつないだまま話者分離を 1 回実行し、外向きの接続が出ないことを確かめる（`HF_HUB_OFFLINE`） | §12 の表「通信」 |
| Pipeline の戻り値 | 入れた版で `itertracks(yield_label=True)` が使えるか、`speaker_diarization` 属性を経由するか | §12 の表「戻り値」、`_run()` の末尾 |
| 所要時間とメモリ | 60 分・2 source の会議で `diarize_duration_ms` とプロセスの最大メモリを記録する（Apple Silicon は CPU） | §3 の表 |
| 言語判定 | 日英混在の録音で `language_prob` と判定結果を確かめる | §3 の表 |
| FLAC の一連の動作 | `compress_after_days=0` にして圧縮 → STT の再実行 → transcript 取得 | §24.2 |
| LAN | 2 台構成で `doctor --init-tls --host <名前>` → `serve --bind 0.0.0.0 --tls` → 別の端末から証明書を受け入れて録音 | §3 の表、§24.2 |

---

*本書のコードは Fake Provider によるテストで検証済みだが、pyannote の話者分離、Whisper の言語判定、libsndfile の FLAC、自己署名 TLS のブラウザ受け入れ、LAN 越しの遅延は実機でのみ確認できる。§24.2 の実機項目を通過したものだけを Phase 3 サーバー側の完了とする。*
