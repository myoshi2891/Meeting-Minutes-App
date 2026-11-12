#!/bin/sh
# 未実装フェーズ（Phase 2 / 3）の設計書を、コードブロックを実ファイルに展開してコンパイル・テストで確かめる。
#
# 使い方: scripts/verify-design-docs.sh [server|client|all]   （既定 all）
#
# 何を確かめるか:
#   server … docs/design-local-phase2-server.md を展開して pytest。その上に phase3-server.md を重ねて pytest
#   client … Phase 1 の現行 src/ test/ に phase2-client.md を重ねて tsc と Vitest。さらに phase3-client.md を重ねて同じ
# Phase 1 の設計書は scripts/sync-design-code.mjs --check（src と一字一句一致）で確かめる。こちらは対象外。
#
# 前提: uv（サーバー側。検証用の仮想環境を作業ディレクトリに作り、PyPI から依存を入れる）、npm ci 済みの node_modules（クライアント側）
# 作業ディレクトリは既定で一時ディレクトリ。VERIFY_DIR を指定すると残る（失敗の調査用）。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${VERIFY_DIR:-$(mktemp -d)}
TARGET=${1:-all}
# 打ち間違いの対象で何も検査せずに OK と出さない
case "$TARGET" in
  server|client|all) ;;
  *) echo "使い方: $0 [server|client|all]（不明な対象: ${TARGET}）" >&2; exit 2 ;;
esac
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)   # 相対パスの VERIFY_DIR でも、下の cd 後に venv を指せるよう絶対パスにする
extract() { python3 "$ROOT/scripts/extract-design-code.py" "$@"; }
echo "作業ディレクトリ: $WORK"
status=0

init_packages() {  # 設計書は空の __init__.py を載せていない（Phase 2 server §23.1）
  find "$1/minutes_local" -type d -exec sh -c 'touch "$0/__init__.py"' {} \;
}

if [ "$TARGET" = server ] || [ "$TARGET" = all ]; then
  [ -x "$WORK/venv/bin/python" ] || uv venv -q --python 3.12 "$WORK/venv"
  uv pip install -q --python "$WORK/venv/bin/python" \
    "fastapi>=0.115" "uvicorn>=0.30" "httpx>=0.27" "pydantic>=2.7" "psutil>=5.9" \
    "pytest>=8" "pytest-asyncio>=0.23" "anyio>=4" "cryptography>=42" pyflakes
  rm -rf "$WORK/p2s" "$WORK/p3s"; mkdir -p "$WORK/p2s"
  extract "$ROOT/docs/design-local-phase2-server.md" "$WORK/p2s"; init_packages "$WORK/p2s"
  cp -R "$WORK/p2s" "$WORK/p3s"
  extract "$ROOT/docs/design-local-phase3-server.md" "$WORK/p3s"; init_packages "$WORK/p3s"
  for phase in p2s p3s; do
    echo "== $phase: pyflakes + pytest"
    # soundfile の未使用 import（import の可否で依存の有無を確かめている）だけを許す。それ以外の指摘と pyflakes 自体の失敗は NG
    rc=0
    out=$(cd "$WORK/$phase" && "$WORK/venv/bin/python" -m pyflakes minutes_local tests 2>&1) || rc=$?
    rest=$(printf '%s\n' "$out" | grep -v "'soundfile' imported but unused" | grep -v '^$' || true)
    if [ -n "$rest" ] || [ "$rc" -gt 1 ]; then printf '%s\n' "$rest"; echo "pyflakes: NG (exit $rc)"; status=1; fi
    (cd "$WORK/$phase" && "$WORK/venv/bin/python" -m pytest -q -p no:cacheprovider) || status=1
  done
fi

if [ "$TARGET" = client ] || [ "$TARGET" = all ]; then
  for phase in 2 3; do
    d="$WORK/c$phase"; rm -rf "$d"; mkdir -p "$d"
    cp -R "$ROOT/src" "$ROOT/test" "$ROOT/tsconfig.json" "$ROOT/vitest.config.ts" "$ROOT/vite.config.ts" "$ROOT/package.json" "$d/"
    ln -s "$ROOT/node_modules" "$d/node_modules"
    extract "$ROOT/docs/design-local-phase2-client.md" "$d"
    [ "$phase" = 3 ] && extract "$ROOT/docs/design-local-phase3-client.md" "$d"
    # Phase 2 client §7 が指定する Phase 1 テストの適応（listByMeeting は mic の呼び出しだけを数える）
    python3 - "$d/test/app.test.ts" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
old = "      return ++reads <= 2 ? chunks.map("
assert text.count(old) == 1, "test/app.test.ts の対象箇所が変わった。Phase 2 client §7 を見直す"
open(path, "w", encoding="utf-8").write(text.replace(old, '      if (args[1] !== "mic") return chunks;\n' + old))
PY
    echo "== phase$phase client: tsc + vitest"
    # npx は見つからないパッケージをその場で取得しうる。npm ci 済みのものだけを使う
    (cd "$d" && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run) || status=1
  done
fi

[ "$status" = 0 ] && echo "OK: 設計書のコードはすべて通過" || echo "NG: 失敗あり（VERIFY_DIR を指定して再実行すると作業ディレクトリが残る）"
exit "$status"
