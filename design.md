# 依頼プロンプト：議事録アプリ Phase 1 詳細設計書の作成依頼

> このプロンプトはClaude Fable 5.1に提出することを想定しています。添付として、既存の「議事録Webアプリケーション システム設計書 v4.0（設計レビュー版）」を一緒に渡してください。

---

## 【目的・背景】

Notion AIのようなリアルタイム音声文字起こし機能を持ち、日本語・英語の両方に対応し、可能な限り無料（または低コスト）で運用できる「議事録Webアプリケーション」を、実装者自身が実際にコードを書き始められるレベルまで設計を落とし込みたい。使用するクラウドサービス（STT／要約／ストレージ／Queue／DB）は特定のベンダーに固定するものではなく、より優れた選択肢があれば置き換えて構わない。

すでにv3.0からv4.0への設計レビュー（添付）を実施済みだが、v4.0は「レビュー時点の叩き台」であり確定仕様ではない。以下は現時点でおおむね合意されている方針だが、これも含めてあなた自身による批判的な再検証の対象とする。

- 設計方針（案）：Free-Tier-First / Recording-First / Fault-Tolerant / At-Least-Once / Provider-Agnostic
- 最重要原則（合意済み・変更不可）：「Recording is Source of Truth」
- DBスキーマ（案）：meetings / audio_chunks / processing_jobs
- 10個の設計不変条件（合意済み・変更不可）：Invariant 1〜10

さらに、v4.0を厳しくレビューした結果、以下10個の論点が未解決のまま残っていることが分かっている。Phase 1の設計に着手する前に、少なくとも簡潔な検討・結論（採用する対策、または明示的に次フェーズへ先送りする理由）を示すこと。

1. **マルチテナント/無料枠共有問題**：`meetings.user_id`がSupabase Authに紐づく設計から、本アプリは複数ユーザーが利用するSaaS型を想定していると読めるが、STT/要約プロバイダのAPIキーはサーバー側で一括管理される想定であり、無料枠のクォータ（例：STTプロバイダのRPD/秒あたり処理量、Queueの1日あたりオペレーション数）は全ユーザーで共有される。ユーザー数が増えた場合にクォータがすぐ枯渇する構造的リスクが未検討。単一ユーザー向けの個人ツールと割り切るのか、真のマルチテナントSaaSとして設計するのか（後者ならユーザーごとのクォータ配分やBYO-APIキー方式も検討要）を明示すること。
2. **VADアルゴリズムの未定義**：`vadScore`をどう算出するか（単純なエネルギーしきい値か、WebRTC VAD／Silero VAD等の既存アルゴリズムを使うか）が指定されておらず、false negative率を実測でどう評価するかも未定義。
3. **リサンプリングのDSP品質**：ネイティブsample rateから16kHzへの変換を「リサンプラー」とだけ記述しており、アンチエイリアシングのローパスフィルタを伴わないナイーブな間引きだとエイリアシングが発生し、STT精度を落とすリスクがある。
4. **IndexedDBストレージクォータ超過時の挙動未定義**：長時間・2チャンネル録音（1時間で約230MB）がモバイル/低ストレージ端末のIndexedDBクォータに達した場合のフォールバックが設計されていない。
5. **タブの明示的クローズへの保護欠如**：バックグラウンド放置・タイマーthrottleへの耐性は詳細に設計されているが、ユーザーが録音中に意図的にタブを閉じる／リロードするケース（`beforeunload`での警告等）への保護が抜けている。
6. **Transcript Mergerの重複排除アルゴリズムが未定義**：overlapによる重複候補の「検出」ロジック（source+start_ms+end_ms+normalized_text）は定義されているが、実際に1本のテキストへマージする具体的なアルゴリズム（表記ゆれ・部分重複の扱いを含む）が指定されていない。
7. **AI Hallucination検出後の対応フローが未定義**：`sourceSegmentIds`の実在チェックは定義されているが、検証に失敗した場合（再生成／該当項目の除外／ユーザーへの警告表示のいずれか）の挙動が決まっていない。
8. **他の会議参加者のプライバシー・同意設計の欠落**：System Audioには録音者本人以外の発言も含まれ得るが、同意取得や録音であることの明示（法域によっては録音同意が必要）についての設計が存在しない。
9. **無料枠超過後のコスト・スケーリングパス未検討**：Free-Tier-Firstを掲げているが、実際に枠を超過した場合の有料プラン移行や代替プロバイダへのフェイルオーバー方針・概算コストが示されていない。
10. **オペレーション課金単位の見落とし**：ストレージ容量（GB）だけでなく、オブジェクトストレージのオペレーション数課金やDB接続数上限など、運用ベースの制限が考慮されていない。

v4.0の末尾で提言されている通り、次に必要なのは「設計書をさらに文章で厚くすること」ではなく、**実装フェーズ1（Mic → AudioWorklet → 30秒Standalone WAV → IndexedDB → 選定したオブジェクトストレージ）を、実装・結合テストに進められる詳細度まで設計すること**である。この設計書は、実装者本人がこれだけを見てPhase 1のコーディングに着手できる状態にするために使う。

## 【依頼内容】

添付のv4.0設計書のうち「Recording is Source of Truth」原則と10個のInvariantは維持したうえで、それ以外（技術スタックの選定、DBスキーマの細部）はあなた自身の判断で見直してよい。まず①上記10個の未解決論点への簡潔な結論、②アップロード先オブジェクトストレージ（R2、または代替案）の選定理由を明記したうえで、実装フェーズ1「Mic → AudioWorklet → 30秒Standalone WAV → IndexedDB → （選定したストレージ）」の詳細設計書を、TypeScriptインターフェース定義・状態遷移図・IndexedDBスキーマ・AudioWorkletコード・WAVエンコーダ実装・テストコードまで含めて作成してほしい。

対象パイプラインの範囲は以下の通り（これより先＝Phase 2以降は対象外）。

```mermaid
flowchart LR
    A[MediaStream\nMic] --> B[AudioContext]
    B --> C[AudioWorklet]
    C --> D[Native sampleRate\n取得]
    D --> E[16kHz\nResampler]
    E --> F[Mono Mix]
    F --> G[Int16変換]
    G --> H[VADスコア算出]
    H --> I[480,000サンプル蓄積]
    I --> J[WAV Header付与\nStandalone WAV]
    J --> K[IndexedDB保存]
    K --> L[Presigned PUT]
    L --> M[選定したオブジェクト\nストレージ 例:R2]
```

一度の応答で完結する概要説明ではなく、あなたが持つ「長時間・複数ステップにわたる作業を自律的に計画・実行し、表面的な対症療法ではなく根本原因から設計し、作業中も逐次状況を報告しながら進める」という特性を最大限に活かし、実装着手可能な最終成果物として仕上げてほしい。作業が複数ターン・複数ステップに及んでも構わないので、都度「ここまで完了、次は◯◯に着手」と状況を共有しながら進めてよい。

## 【完了条件】

以下がすべて満たされた状態を完了とする（機械的・客観的に判定可能）。

1. 次の7種類の成果物がすべて揃っている
   - ① TypeScriptインターフェース定義一式（`AudioPipelineConfig` / `SessionClock` / `ChunkTimingMetadata` / `VADConfig` / `VADResult` / `RecordingHealth` / Upload Stateの型）
   - ② Upload State Machineの状態遷移図（Mermaid形式。`GENERATED → IDB_STORED → UPLOAD_PENDING → UPLOADING → UPLOADED → DB_REGISTERED`、およびエラー分岐 `UPLOAD_FAILED / RETRYING` を含む全状態を網羅）
   - ③ IndexedDBスキーマ定義（object store名、keyPath、index、バージョン管理方法を含む）
   - ④ AudioWorkletProcessor実装コード（ネイティブsample rate取得 → 16kHzリサンプリング → モノラルミックス → Int16変換 → VADスコア算出 → 480,000サンプル蓄積 → WAV Builder呼び出しまでの一連の処理）
   - ⑤ WAVエンコーダ実装（44バイトWAVヘッダ生成を含む、PCM16 / Mono / 16kHz固定仕様に準拠）
   - ⑥ テストコード（最低限「60分連続録音」「Wi-Fi切断5分からの復旧」「ブラウザクラッシュ後のIndexedDB復旧」「Chunk単体再生可能性の検証」の4パターンを含む）
   - ⑦ v4.0のDefinition of Doneチェックリスト（Audio / Network項目相当）に対する対応状況の明記
2. v4.0の10個のInvariant（Invariant 1〜10）を一つも破っていないことが、設計書内の記述から明示的に確認できる（各Invariantに対応する設計上の担保箇所が示されている）
3. v4.0で明確に否定された以下3つの誤った前提を再び採用していない
   - 「AudioContextのsample rateは常に16kHzである」
   - 「共通AudioContext使用でクロックドリフトは数学的にゼロになる」
   - 「Web Worker＋無音Audioループでバックグラウンド録音を保証できる」
4. すべてのコードブロックが単体で構文的に成立している（未定義変数・未クローズの型・擬似コードのみの断片がない）
5. 日本語で記述されている
6. 【目的・背景】に列挙した10個の未解決論点それぞれについて、少なくとも一段落の検討・結論（対策を採用する場合はその内容、次フェーズへ先送りする場合はその理由）が示されている
7. アップロード先オブジェクトストレージ等の技術選定について、v4.0の候補（R2等）をそのまま採用する場合も他の選定を提案する場合も、その理由（無料枠条件・レイテンシ・マルチテナント適性等）が明記されている（無条件の踏襲は不可）

## 【制約・フォーマット】

- クライアント側はブラウザ標準API（`MediaStream` / `AudioContext` / `AudioWorklet` / `IndexedDB`）とTypeScriptに限定する（ここは変更不可）
- アップロード先オブジェクトストレージは、R2を既定候補としつつ、無料枠条件・マルチテナント適性等でより優れた代替があれば置き換えてよい。ただし「Presigned URLでクライアントから直接PUTする」方式そのものは維持する
- Phase 1の範囲内では、Queue／DB／STT／要約サービス（候補：Cloudflare Queues, Supabase, Groq, Gemini等）は「後続フェーズとの接続点」の説明にとどめ、実装コードは書かない
- MediaRecorderのtimesliceベースのBlob生成は録音のSource of Truthとして採用しない（AudioWorkletベースのPCM生成のみを正とする）
- 出力形式はMarkdown。コードブロックには`typescript`等の言語タグを付与する
- 状態遷移・処理フローの図解は必ずMermaid記法で記述する（テキストのみのASCII図は使用しない）
- 見出し構成は添付v4.0設計書と同様の「番号付きセクション」形式に揃える
- ブラウザAPIの仕様など技術的な断定を書く場合、v4.0と同様に「断定してはいけない箇所」と「実測・監視で担保する箇所」を明確に分離して記述する

## 【やらないこと】

- Phase 2（System Audio、VAD、Cloudflare Queue、Retry、DLQ）およびPhase 3（Live STT、Speaker分離、FLAC移行、高度な復旧処理）の実装設計には踏み込まない（v4.0内での位置づけへの言及のみ可）
- STT／要約／DB／エディタといった外部サービスそのものの実装コードは書かない（採用ベンダーが何であってもPhase 1の対象外）
- DBスキーマ（meetings / audio_chunks / processing_jobsテーブル）の全面的な再設計は行わない。ストレージ選定変更に伴う軽微な追随的変更（例：カラム名）以外は、Phase 1に必要な範囲でのみ参照する
- v4.0で定義された10個のInvariantを緩和・変更する提案は行わない
- マーケティング的な文言、根拠のない精度・性能の断定は書かない

## 【参考資料・コンテキスト】

- 添付：議事録Webアプリケーション システム設計書 v4.0（設計レビュー版）
  - 設計方針：Free-Tier-First / Recording-First / Fault-Tolerant / At-Least-Once / Provider-Agnostic
  - v3.0からの主要修正点（MediaRecorderを外す理由、16kHz固定の誤認修正、クロック設計の考え方）
  - DBスキーマ（meetings / audio_chunks / processing_jobs）
  - 10個の設計不変条件（Invariant 1〜10）
  - Phase 1〜3の実装順序（Phase 1 = 本依頼の対象範囲）
- v4.0は確定仕様ではなく、v3.0からのレビューを経た叩き台である。技術選定・DBスキーマの細部も含めて批判的に再検証してよい。維持すべきは「Recording is Source of Truth」原則と10個のInvariantのみ
- 対象システムの前提：Notion AI相当のリアルタイム音声文字起こし機能を持つ議事録アプリ。日本語・英語の両方に対応。可能な限り無料（または低コスト）で運用することを志向するが、特定ベンダーへの固定が目的ではない（Cloudflare Workers/Queues, Groq, Supabase, Cloudflare R2は前回レビュー時点の候補にすぎず確定ではない）
- v4.0内で今回のPhase 1に直接関係する主要セクション：
  - セクション3（MediaRecorderを録音Source of Truthから外す理由）
  - セクション4〜5（sample rate / クロック設計）
  - セクション6〜11（Session Clock / Chunk Timing Metadata / Chunk生成 / AudioWorklet仕様）
  - セクション15〜19（IndexedDB / Upload State Machine / 重複Upload対策 / R2 Object Key / R2 Security）
  - セクション90〜96（ブラウザクラッシュ対策 / Network断 / Finalization Barrier）
  - セクション107〜109（容量見積もり / 長期保存戦略）
  - セクション115〜118（実装順序 / Definition of Done）