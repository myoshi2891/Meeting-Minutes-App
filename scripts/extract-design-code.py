#!/usr/bin/env python3
"""設計書のコードブロックを実ファイルとして書き出す。

使い方: python3 scripts/extract-design-code.py <設計書.md> <出力先ディレクトリ> [--list]

1 行目が `// src/...` `// test/...`（TypeScript）または `# minutes_local/...` `# tests/...` `# pyproject.toml`
（Python / TOML）のコードブロックを、そのパスへ書き出す。同じパスが複数あれば後ろへ連結する。
--list は書き出さずに、パス・開始行・行数を表示する。
未実装フェーズ（Phase 2 / 3）の設計書を、実際にコンパイル・テストして確かめるために使う（scripts/verify-design-docs.sh）。
"""
import argparse
import os
import re
import sys
from collections.abc import Iterator

OPEN = re.compile(r"^(?P<fence>(?P<ch>[`~])(?P=ch){2,})(?P<info>.*)$")
HEAD = re.compile(r"^(?://|#) ((?:src|test|tests|minutes_local)/\S+|pyproject\.toml)\s*$")


def top_level_blocks(text: str) -> Iterator[tuple[int, str, str]]:
    """トップレベルのフェンスコードブロックを先頭から順に返す（開きの行番号, 言語, 本文）。

    言語のないブロックも追跡し、その中身は開きフェンスとして読まない（入れ子の ```python などを取り出さない）。
    閉じフェンスは開きと同じ文字（` か ~）で、長さが開き以上のもの（CommonMark）。短いもの・別の文字では閉じない。
    閉じていないブロック（文書末まで続く）は返さない。
    """
    lines = text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = OPEN.match(lines[i].rstrip("\r\n"))
        # バッククォートのフェンスの info に ` は入らない（CommonMark）。インラインコードの行をフェンスとみなさない
        if m is None or (m.group("ch") == "`" and "`" in m.group("info")):
            i += 1
            continue
        close = re.compile(rf"^{re.escape(m.group('ch'))}{{{len(m.group('fence'))},}}[ \t]*$")
        j = i + 1
        while j < len(lines) and close.match(lines[j].rstrip("\r\n")) is None:
            j += 1
        if j == len(lines):
            print(f"L{i + 1}: 閉じていないコードブロックを無視した", file=sys.stderr)
            return
        yield i + 1, m.group("info").strip(), "".join(lines[i + 1:j])
        i = j + 1


def main() -> int:
    # 引数はファイルを開く前に解釈する。--help・不明なオプションは argparse が何も書き出さずに終了させる（終了コード 2）
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("doc", help="設計書（.md）")
    parser.add_argument("out", help="出力先ディレクトリ")
    parser.add_argument("--list", action="store_true", help="書き出さずに、パス・開始行・行数を表示する")
    args = parser.parse_args()
    doc, out = args.doc, os.path.realpath(args.out)
    listing = args.list
    text = open(doc, encoding="utf-8").read()
    seen: dict[str, int] = {}
    for line_no, lang, body in top_level_blocks(text):
        # 言語のあるブロックだけを対象にする（従来どおり）。見出しは 1 行目だけを見る
        head = HEAD.match(body.split("\n", 1)[0]) if re.fullmatch(r"\w+", lang) else None
        if head is None:
            continue
        path = head.group(1)
        seen[path] = seen.get(path, 0) + 1
        if listing:
            print(f"{path}\tL{line_no}\t{len(body.splitlines())} 行")
            continue
        # 見出しのパスは設計書（外部入力）由来。`src/../../x` のような出力先の外への書き込みを拒否する
        target = os.path.realpath(os.path.join(out, path))
        if os.path.commonpath([out, target]) != out:
            print(f"{doc}: 出力先の外を指すパスを拒否した: {path}", file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "a" if seen[path] > 1 else "w", encoding="utf-8") as f:
            f.write(body)
    if not listing:
        print(f"{doc}: {len(seen)} ファイルを {out} へ書き出した")
    return 0


if __name__ == "__main__":
    sys.exit(main())
