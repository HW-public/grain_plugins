#!/usr/bin/env python3
"""从插件元数据生成 dist 清单行（TSV）。

两种来源：
  --wasm <built.wasm>   Rust（或任意带 grain.metadata custom section 的产物）：
                        直接解析 wasm custom section。
  --json '<json>'       TS（AssemblyScript，无 custom section）：
                        由 scripts/meta_ts.mjs 实例化后取 metadata_json。

输出（单行 TSV）：
  src_wasm | dist_file | package | name | version | site | impl

site 规则：metadata 里显式 "site" 优先；否则取 webSite 的主机名并去掉
前导 "www."。这样新增插件无需改任何脚本。
"""
import argparse
import json
import sys
from urllib.parse import urlparse


def read_uleb(data, i):
    result = 0
    shift = 0
    while True:
        b = data[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def read_custom_section(wasm_path, section_name):
    data = open(wasm_path, "rb").read()
    if data[:4] != b"\0asm":
        raise SystemExit(f"error: not a wasm file: {wasm_path}")
    i = 8
    while i < len(data):
        sec_id = data[i]
        i += 1
        size, i = read_uleb(data, i)
        payload = data[i:i + size]
        i += size
        if sec_id != 0:
            continue
        name_len, j = read_uleb(payload, 0)
        name = payload[j:j + name_len].decode("utf-8", "replace")
        if name == section_name:
            return payload[j + name_len:].decode("utf-8").rstrip("\x00")
    return None


def derive_site(meta):
    site = meta.get("site")
    if isinstance(site, str) and site.strip():
        return site.strip()
    web = meta.get("webSite") or ""
    host = urlparse(web).hostname if web else None
    if not host:
        return meta.get("package", "")
    return host[4:] if host.startswith("www.") else host


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wasm", required=True, help="源 wasm 路径（行首字段）")
    ap.add_argument("--plugin", required=True, help="插件目录名，如 360zy")
    ap.add_argument("--impl", required=True, help="实现语言，如 rust/ts")
    ap.add_argument("--json", help="直接提供元数据 JSON（TS 产物）")
    args = ap.parse_args()

    raw = args.json
    if raw is None:
        raw = read_custom_section(args.wasm, "grain.metadata")
        if raw is None:
            raise SystemExit(
                f"error: {args.wasm} has no grain.metadata custom section "
                "(use --json with meta_ts.mjs for AssemblyScript artifacts)"
            )
    try:
        meta = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: invalid plugin metadata JSON: {exc}")

    package = meta.get("package") or ""
    name = meta.get("name") or ""
    version = meta.get("version") or ""
    for field, value in (("package", package), ("name", name), ("version", version)):
        if not value:
            raise SystemExit(f"error: plugin metadata missing '{field}' ({args.wasm})")

    safe = args.plugin.replace("-", "_")
    dist_file = f"plugin_{safe}_{args.impl}.wasm"
    row = [
        args.wasm,
        dist_file,
        package,
        name,
        version,
        derive_site(meta),
        args.impl,
    ]
    print("\t".join(row))


if __name__ == "__main__":
    main()
