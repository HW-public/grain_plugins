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

for bin in cargo openssl sha256sum xxd node npx; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "error: required command not found: $bin" >&2
        if [ "$bin" = node ] || [ "$bin" = npx ]; then
            echo "hint: TS plugins need Node.js 20+ (npx comes with npm)" >&2
        fi
        exit 1
    }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}/wasm32-unknown-unknown/release"
DIST="$ROOT/dist"

# TS 插件构建依赖 pdk-as 的本地依赖（asc 0.28.20）。
if [ ! -x "$ROOT/pdk-as/node_modules/.bin/asc" ]; then
    echo "error: pdk-as dependencies missing; run: cd pdk-as && npm ci" >&2
    exit 1
fi

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

# 清单含中文名：强制 Python 以 UTF-8 读写，避免 Windows 控制台代码页污染 TSV。
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

echo "==> cargo build --release --target wasm32-unknown-unknown"
cargo build --release --target wasm32-unknown-unknown

echo "==> AssemblyScript plugins (pdk-as)"
for dir in "$ROOT"/plugins/*/ts; do
    [ -d "$dir" ] || continue
    plugin="$(basename "$(dirname "$dir")")"
    out="$dir/build/plugin_${plugin//-/_}_ts.wasm"
    mkdir -p "$dir/build"
    bash "$ROOT/pdk-as/build.sh" "$dir/index.ts" "$out"
done

rm -rf "$DIST"
mkdir -p "$DIST"

PUBKEY_HEX="$(tr -d '[:space:]' < "$ROOT/keys/public.hex")"
if [ "${#PUBKEY_HEX}" -ne 64 ]; then
    echo "error: keys/public.hex must contain 32-byte hex (64 chars), got ${#PUBKEY_HEX}" >&2
    exit 1
fi

TMPDIR_BUILD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

# ---- 插件自动发现：不需要在此维护插件清单 ----
# 目录约定 plugins/<插件名>/<语言>/；元数据以插件源码为唯一事实来源：
#   rust/  -> 编译产物 grain.metadata custom section（scripts/meta_row.py）
#   ts/    -> 实例化后读 metadata_json 导出（scripts/meta_ts.mjs）
# 新增插件只需建目录与源码，本脚本零修改。清单行字段：
#   源 wasm | 产物文件名 | package | name | version | site | impl
ROWS="$TMPDIR_BUILD/rows.tsv"
: > "$ROWS"

echo "==> collect plugin metadata (auto-discovery)"
for dir in "$ROOT"/plugins/*/rust; do
    [ -d "$dir" ] || continue
    plugin="$(basename "$(dirname "$dir")")"
    crate="$(sed -n 's/^name = "\(.*\)"/\1/p' "$dir/Cargo.toml" | head -n1)"
    if [ -z "$crate" ]; then
        echo "error: cannot read [package] name from $dir/Cargo.toml" >&2
        exit 1
    fi
    wasm="$TARGET_DIR/${crate//-/_}.wasm"
    "$PYTHON" "$ROOT/scripts/meta_row.py" \
        --wasm "$wasm" --plugin "$plugin" --impl rust >> "$ROWS"
done

for dir in "$ROOT"/plugins/*/ts; do
    [ -d "$dir" ] || continue
    plugin="$(basename "$(dirname "$dir")")"
    wasm="$dir/build/plugin_${plugin//-/_}_ts.wasm"
    meta="$(node "$ROOT/scripts/meta_ts.mjs" "$wasm")" || exit 1
    "$PYTHON" "$ROOT/scripts/meta_row.py" \
        --wasm "$wasm" --plugin "$plugin" --impl ts --json "$meta" >> "$ROWS"
done

if [ ! -s "$ROWS" ]; then
    echo "error: no plugins discovered under $ROOT/plugins" >&2
    exit 1
fi

ENTRIES="$TMPDIR_BUILD/entries.tsv"
: > "$ENTRIES"

while IFS=$'\t' read -r src_wasm file_name package name version site impl; do
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

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$package" "$name" "$version" "$file_name" "$sha256" "$signature" "$site" "$impl" >> "$ENTRIES"

    echo "    $file_name  sha256=$sha256"
done < "$ROWS"

"$PYTHON" - "$ENTRIES" "$TAG" "$DIST/manifest.json" <<'PY'
import datetime
import json
import sys

entries_path, tag, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

plugins = []
seen_packages = set()
with open(entries_path, encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        package, name, version, file_name, sha256, signature, site, impl = line.split("\t")
        if package in seen_packages:
            sys.exit(f"error: duplicate package id in manifest: {package}")
        seen_packages.add(package)
        plugins.append({
            "package": package,
            "name": name,
            "version": version,
            "site": site,
            "impl": impl,
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
