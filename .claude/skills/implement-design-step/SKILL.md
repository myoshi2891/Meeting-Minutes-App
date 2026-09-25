---
name: implement-design-step
description: Implement the next task from PROGRESS.md or a design section (e.g. "§20 page-lifecycle", "Step 1-f", "次の作業を進めて") in this repo using strict TDD, one small unit at a time. Use at the start of a working session or whenever asked to implement something that the design docs (design-local-phase*.md) already specify. Covers reading the right design section, writing failing tests first, implementing from the doc's code, validating, syncing docs, and updating PROGRESS.md.
---

# 設計書の Step を TDD で実装する

## 手順

1. **着手するタスクを決める。** `PROGRESS.md` の「次の作業」から、依存が満たされている先頭のタスクを選び、何をするかを 1 行で利用者に伝える。依存が満たされていないタスクには着手しない。外部依存の追加（npm パッケージなど）を伴うタスクは、着手前に確認を取る。
2. **設計書の該当節だけを読む。** `grep -n "^# \|^## " design-local-phase1.md` で節の位置を特定し、その節と、参照されている節（型定義は §7、テストハーネスは §24.1）だけを読む。全体を通読しない。
3. **単位に分ける。** 1 クラス・1 公開メソッド・1 振る舞いを 1 単位とし、単位ごとに 4〜6 を回す。
4. **Red.** テストを先に書く。
   - 設計書 §24 にテストがあればそれを使う。なければ、節の本文にある保証（「〜しない」「〜まで待つ」）を 1 つずつテストにする。
   - `npx vitest run test/<file>` を実行し、**失敗を確認する**。未実装のためにモジュール解決エラーで落ちる場合は、空のエクスポートを置いてから、アサーションで落ちることを確認する。
5. **Green.** 実装する。設計書にコードがあれば一字一句そのまま使う。設計書のコードにバグを見つけたら、実装と設計書の両方を直し、報告に書く。
6. **確認する。** `npm run typecheck && npm test` を実行する。落ちたら修正を重ねる前に原因を特定する。
7. **同期する。** `design-doc-sync` スキルで `MISSING` が `MATCH` になったことを確認する。
8. **記録する。** `PROGRESS.md` の Step 表・次の作業・セッションログ・未コミットの変更を更新する。コミットはしない。提案するコミット単位（`feat(<scope>): ...` と `docs(<phase>): ...`）を報告に書く。
