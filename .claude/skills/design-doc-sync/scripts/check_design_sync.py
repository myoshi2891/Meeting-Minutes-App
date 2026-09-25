#!/usr/bin/env python3
"""設計書内の `// src/...` `// test/...` で始まる TypeScript コードブロックを、実ファイルと照合する。

使い方: python3 .claude/skills/design-doc-sync/scripts/check_design_sync.py [設計書 ...] [--diff]
  既定の対象は design-local-phase1.md。src の不一致があれば終了コード 1。
  test の不一致は「設計書は最低限の集合」扱いのため情報表示のみ。
"""
import difflib
import os
import re
import sys

# 閉じフェンスは「行頭・開きと同じ記号・開き以上の長さ・行末まで空白のみ」のときだけ認める（CommonMark と同じ）
BLOCK = re.compile(
    r"^(?P<fence>(?P<ch>[`~])(?P=ch){2,})typescript[ \t]*\n"
    r"(?P<body>// (?P<path>(?:src|test)/\S+)\n.*?)"
    r"^(?P=fence)(?P=ch)*[ \t]*$",
    re.S | re.M,
)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_diff = "--diff" in sys.argv
    docs = args or ["design-local-phase1.md"]
    src_mismatch = 0
    for doc in docs:
        print(f"== {doc}")
        text = open(doc, encoding="utf-8").read()
        for m in BLOCK.finditer(text):
            # 閉じフェンス直前の改行はファイル末尾の改行に当たるので、前後を削らずにそのまま比べる
            body, path = m.group("body"), m.group("path")
            if not os.path.exists(path):
                print(f"MISSING  {path}（未実装）")
                continue
            actual = open(path, encoding="utf-8").read()
            if actual == body:
                print(f"MATCH    {path}")
                continue
            is_src = path.startswith("src/")
            src_mismatch += is_src
            print(f"{'DIFF' if is_src else 'DIFF(i)'}  {path}")
            if show_diff:
                diff = difflib.unified_diff(body.splitlines(), actual.splitlines(), "doc", "file", n=1, lineterm="")
                print("\n".join(diff))
                # splitlines() は末尾改行の有無を捨てるため、その差だけは別に表示する
                if body.endswith("\n") != actual.endswith("\n"):
                    print(f"  末尾改行: doc={body.endswith(chr(10))} file={actual.endswith(chr(10))}")
    return 1 if src_mismatch else 0


if __name__ == "__main__":
    sys.exit(main())
