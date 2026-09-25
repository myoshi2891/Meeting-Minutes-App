# Minutes（完全ローカル議事録アプリ）

ブラウザ録音 → IndexedDB → ローカル常駐サーバーへ保存 → 文字起こし・議事録化を、利用者のマシン上だけで行う。

- **セッション開始時は必ず [PROGRESS.md](PROGRESS.md) を読み**、「次の作業」の先頭から着手する。終了時に同ファイルを更新する。
- 設計の正は `design-local-phase*.md`。`archive/` は旧版で、参照も編集もしない（CodeRabbit も対象外）。
- コマンド: `npm test`（Vitest）、`npm run typecheck`（tsc）。lint はまだない。

---

## ルール（常に守る）

### 1. Step by Step で進める

- 設計書 §30 の Step 順に、**前の Step のテストが通ってから次に着手する**。
  - 理由: 保存パイプラインは Worklet → IDB → Scheduler → Finalizer と下流が上流の保証に依存している。上流が未検証のまま下流を書くと、不具合の原因を切り分けられない。
- 1 Step の中もさらに小さな単位（1 クラス・1 振る舞い）に分ける。1 単位ごとに「テスト → 実装 → 確認 → 報告」を回す。
  - 理由: 差分が小さいほどレビューと巻き戻しが容易になる。
- 修正が失敗したら次の修正を重ねずに止まり、前提を見直す。
  - 理由: 投機的な修正を重ねると、どの変更が効いたのか分からなくなる。

### 2. TDD（Red → Green → Refactor）

1. **Red**: 設計書 §24 のテスト、または振る舞いを表すテストを先に書き、`npx vitest run <file>` で**失敗することを確認する**。
   - 理由: 失敗を確認していないテストは、何も検証していない可能性がある。バグ修正の回帰テストも、修正前のコードで Red になることを確かめる。
2. **Green**: テストを通す最小限の実装を書く。設計書にコードがあれば、それをそのまま使う。
3. **Refactor**: テストが通った状態のまま整える。
4. 最後に `npm run typecheck && npm test` で全体を確認する。

テストの書き方:

- AAA（Arrange / Act / Assert）で書く。テスト名は日本語で振る舞いを書く（例: `"未登録 Chunk が残っていれば finalizing に進まず waiting_local_save を返す"`）。
- 正常系と異常系の両方を書く。

### 3. 設計書と実装を同期する

- `design-local-phase1.md` には `// src/...` で始まるコードブロックがあり、**実装ファイルと一字一句一致させる**。
  - 理由: 設計書だけを読んで実装・レビューできることが設計書の目的（冒頭「位置づけ」）。ずれると次のセッションが古いコードを正として扱ってしまう。
- テストのコードブロックは「最低限の集合」という扱いで、実装側でテストを追加して差分が出るのは許容する。
- コードを変えたら、本文（不変条件・状態遷移図・Barrier 条件）も同じ作業の中で直す。**確認は不要**。
- 同じコードを引き継いでいる後続フェーズの設計書（`design-local-phase2-client.md` など）にも、同じ修正が必要かを確認する。
- 手順と照合スクリプトは `design-doc-sync` スキルにある。

### 4. コミット

- **コミットは利用者の指示・承認を得てから行う。** 作業ブランチは `dev`。main へは PR で入れる。
- 形式は `<type>(<scope>): <subject>`（英語・命令形・小文字始まり）。
  - type: `feat` / `fix` / `docs` / `refactor` / `test` / `chore`
  - scope の例: `setup` `audio` `worklet` `storage` `save` `recording` `phase1` `phase2` `phase3-client` `claude`
- コード変更と設計書変更はコミットを分ける（`fix(recording): ...` と `docs(phase1): ...`）。
  - 理由: 既存の履歴がこの分け方で、設計書の変更履歴を追いやすい。
- 1 コミット = 1 つの論理的な変更。Step をまたぐ変更を 1 コミットにまとめない。
- コミット前に `npm run typecheck && npm test` を必ず通す。失敗したままコミットしない。
- `.env`・トークン・録音データ（`*.wav`、`recordings/`）はコミットしない。

---

## 既知の落とし穴

- **fake-indexeddb はテスト間でグローバル DB を共有する。** 会議 ID をテストごとに変える（`test/finalizer.test.ts` の `m-fin-${n}` 方式）。そうしないと前のテストの Chunk が混ざる。
- **タイマーは依存注入する。** Scheduler の `setTimer`、テストハーネスの `h.advance(ms)` を使う。実時間の `setTimeout` を待つテストは書かない（遅く不安定になる）。
- **サーバー応答は外部入力。** `as` でキャストせず、`src/api/contracts.ts` の型ガード（`isChunkListResponse` など）を通す。
- **ローカル以外へ通信しない。** URL を組み立てたら `assertLocalHost()` を通す（Zero External Data Egress、設計書 §4.4）。
- **非同期の完了通知は、どの要求への応答かを対応付ける。** 例: `flushed` は FIFO で 1 件ずつ解放する。ポーリングは世代番号で古いループを捨てる。フラグ 1 つで判定すると、stop → start の競合で壊れる。
- **Finalization Barrier は IDB の中身だけを見ると不十分。** メモリ待機中の末尾 Chunk は連番チェックをすり抜けるので、`unpersistedChunkCount` を必ず配線する（§22）。
