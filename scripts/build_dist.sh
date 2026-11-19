#!/usr/bin/env bash
# 构建 grain 插件 wasm 产物、签名并生成 dist/manifest.json。
#
# 用法：
#   TAG=v0.1.0 PLUGIN_SIGNING_KEY=/path/to/plugin-signing.pem bash scripts/build_dist.sh
#
# 环境变量：
#   TAG                 必填，发布 tag（如 v0.1.0），用于拼接 release 下载 URL
#   PLUGIN_SIGNING_KEY  必填，Ed25519 私钥 PKCS#8 PEM 文件路径（绝不入库）
#   CARGO_TARGET_DIR    可选，cargo 目标目录（默认 target）
set -euo pipefail

: "${TAG:?TAG is required (e.g. v0.1.0)}"
: "${PLUGIN_SIGNING_KEY:?PLUGIN_SIGNING_KEY is required (path to Ed25519 PKCS#8 PEM)}"

for bin in cargo openssl sha256sum xxd; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "error: required command not found: $bin" >&2
        exit 1
    }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}/wasm32-unknown-unknown/release"
DIST="$ROOT/dist"

# python3 在 Windows Git Bash 下可能是应用商店占位符，必须实际执行一次再判定。
PYTHON=""
for cand in python3 python py; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys' >/dev/null 2>&1; then
        PYTHON="$cand"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    echo "error: python (3.x) not found" >&2
    exit 1
fi

echo "==> cargo build --release --target wasm32-unknown-unknown"
cargo build --release --target wasm32-unknown-unknown

rm -rf "$DIST"
mkdir -p "$DIST"

PUBKEY_HEX="$(tr -d '[:space:]' < "$ROOT/keys/public.hex")"
if [ "${#PUBKEY_HEX}" -ne 64 ]; then
    echo "error: keys/public.hex must contain 32-byte hex (64 chars), got ${#PUBKEY_HEX}" >&2
    exit 1
fi

# 元数据表（与各插件源码里的 plugin_meta! 同步）。
# 字段：crate 产物名 | wasm 文件名 | package | name | version
PLUGINS=(
    "plugin_360zy|plugin_360zy.wasm|360zy.com|360资源|v0.0.2"
    "plugin_bili_wbi|plugin_bili_wbi.wasm|bilibili.com.wbi|哔哩哔哩(WBI)|v0.1.0"
)

TMPDIR_BUILD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

ENTRIES="$TMPDIR_BUILD/entries.tsv"
: > "$ENTRIES"

for row in "${PLUGINS[@]}"; do
    IFS='|' read -r crate_name file_name package name version <<< "$row"

    src_wasm="$TARGET_DIR/$file_name"
    if [ ! -f "$src_wasm" ]; then
        echo "error: missing build artifact: $src_wasm" >&2
        exit 1
    fi
    cp "$src_wasm" "$DIST/$file_name"

    sha256="$(sha256sum "$DIST/$file_name" | awk '{print $1}')"

    # 签名消息（UTF-8，无分隔空白、无结尾换行）：{package}|{version}|{sha256}
    msg="$package|$version|$sha256"
    printf '%s' "$msg" > "$TMPDIR_BUILD/message.bin"

    openssl pkeyutl -sign -rawin \
        -inkey "$PLUGIN_SIGNING_KEY" \
        -in "$TMPDIR_BUILD/message.bin" \
        -out "$TMPDIR_BUILD/signature.bin"
    signature="$(xxd -p "$TMPDIR_BUILD/signature.bin" | tr -d '\n')"

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$package" "$name" "$version" "$file_name" "$sha256" "$signature" >> "$ENTRIES"

    echo "    $file_name  sha256=$sha256"
done

"$PYTHON" - "$ENTRIES" "$TAG" "$DIST/manifest.json" <<'PY'
import datetime
import json
import sys

entries_path, tag, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

plugins = []
with open(entries_path, encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        package, name, version, file_name, sha256, signature = line.split("\t")
        plugins.append({
            "package": package,
            "name": name,
            "version": version,
            "file": file_name,
            "url": (
                "https://github.com/HW-public/grain_plugins/releases/download/"
                f"{tag}/{file_name}"
            ),
            "sha256": sha256,
            "signature": signature,
        })

manifest = {
    "schema": 1,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "plugins": plugins,
}

with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

printf '%s\n' "$PUBKEY_HEX" > "$DIST/public.hex"

rm -f "$TMPDIR_BUILD/message.bin" "$TMPDIR_BUILD/signature.bin"

echo "==> dist ready:"
ls -l "$DIST"
echo "==> manifest: $DIST/manifest.json"
