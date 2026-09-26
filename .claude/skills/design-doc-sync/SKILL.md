---
name: design-doc-sync
description: Keep the design docs (design-local-phase*.md) in sync with src/ after any code change in this repo. Use after editing files under src/ or test/, after applying review fixes, after implementing a design section, or when asked whether the design docs match the implementation. Runs a checker that compares every `// src/...` code block in the doc against the real file, then patches embedded code and prose (invariants, state diagrams, Barrier conditions) and propagates the same fix to later-phase docs that copied the code.
---

# 設計書と実装の同期

設計書 `design-local-phase1.md` は、`// src/<path>` で始まる TypeScript コードブロックに実装ファイルの全文を載せている。**src のブロックは実装と一字一句一致させる**。test のブロックは最低限の集合なので、実装側にテストが足されて差分が出ても構わない。

## 手順

1. 現状を照合する。
   ```bash
   python3 .claude/skills/design-doc-sync/scripts/check_design_sync.py            # 一覧
   python3 .claude/skills/design-doc-sync/scripts/check_design_sync.py --diff     # 差分つき
   ```
   - 判定の意味: `MATCH` は一致、`DIFF` は src の不一致（要修正・終了コード 1）、`DIFF(i)` は test の差分（情報のみ）、`MISSING` は未実装。
2. `DIFF` のブロックを直す。src のコード変更と**同じ置換**を設計書にも当てるのが最も安全。
   - Python で `assert text.count(old) == 1` を確かめてから `replace` すると、置換の漏れや二重適用を防げる。
   - ブロック全体を貼り替えてもよいが、周囲の本文は変えないこと。
3. 本文を直す。変更したクラス・関数名で `grep -n` し、次の箇所を確認する。
   - コード直後の説明段落（「〜で担保する」「〜ことはない」など、保証を言い切っている文）
   - Mermaid の状態遷移図（遷移条件）
   - §27 Invariant 担保箇所、§28 Definition of Done の表
4. 後続フェーズに波及させる。`design-local-phase2-client.md` などは Phase 1 のコードを元に拡張している。同じ不具合や同じ引数追加が必要かを `grep -n "<関数名>" design-local-phase*.md` で確認し、フェーズ固有の差分（mic/system の 2 系統など）を保ったまま同じ修正を当てる。後続フェーズのブロックは Phase 1 の src と一致しないのが正常で、チェッカーの対象外。
5. 手順 1 を再実行し、`DIFF` がゼロであることを確認する。

## 報告

どの設計書のどの節を直したか、後続フェーズに波及させたかを 1〜3 行で報告する。設計書の変更は、コード変更とは別の `docs(<phase>): ...` コミットにする。
