#!/usr/bin/env bash
# 构建 AssemblyScript 插件为 wasm。
#
#   bash build.sh <entry.ts> <out.wasm>
#
# 入口路径相对调用方当前目录；--use 的 abort 路径相对 pdk-as 目录
# （脚本先 cd 到 pdk-as 再跑 asc）。
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: bash build.sh <entry.ts> <out.wasm>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$(realpath "$1")"
OUT="$(realpath -m "$2")"

# asc 的 --use 元素路径按 --baseDir 解析；默认 baseDir 是入口所在目录，
# 入口在 pdk-as 之外时 `src/abort/abort` 会解析失败（AS111）。固定用仓库
# 根作 baseDir，abort 元素路径也换算成相对仓库根的形式。
REPO="$(cd "$HERE/.." && pwd)"
ABORT_REL="$(realpath -m --relative-to="$REPO" "$HERE/src/abort/abort")"

cd "$HERE"

# 自定义 abort 必须由入口的模块图导出（index.ts 已 export { abort }）。
exec npx asc "$ENTRY" \
  -o "$OUT" \
  --optimize \
  --baseDir "$REPO" \
  --use "abort=$ABORT_REL"
