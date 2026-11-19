# grain_plugins

grain 引擎插件分发仓库：集中托管插件源码，CI 编译为 WebAssembly、用 Ed25519 签名，
并以 GitHub Release 发布 wasm 产物与 `manifest.json` 清单。

宿主侧按以下固定地址拉取清单，校验 sha256 与签名后再安装：

```
https://github.com/HW-public/grain_plugins/releases/latest/download/manifest.json
```

## 目录结构

```
grain_plugins/
├── Cargo.toml                 # workspace：members 列出全部插件 crate
├── .cargo/config.toml         # crates.io 镜像 + Windows 下 rust-lld 链接器
├── keys/public.hex            # 签名公钥（32 字节 hex，单行）
├── plugins/
│   ├── 360zy/                 # 360资源（maccms API）插件
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── bili-wbi/              # 哔哩哔哩 WBI 搜索插件
│       ├── Cargo.toml
│       └── src/lib.rs
├── scripts/build_dist.sh      # 构建 + 签名 + 生成 manifest.json
├── .github/workflows/release.yml
├── dist/                      # 构建产物（不入库）
└── target/                    # cargo 产物（不入库）
```

插件通过相对路径引用 PDK：`../../../grain_engine/pdk/rust/crates/pdk`。
因此本地构建时，仓库必须与 `grain_engine` 位于同一父目录下（CI 中由 workflow 克隆到兄弟位置）。

## manifest schema

`dist/manifest.json`（UTF-8，缩进 2 空格）：

```json
{
  "schema": 1,
  "generatedAt": "2026-11-19T08:30:00Z",
  "plugins": [
    {
      "package": "360zy.com",
      "name": "360资源",
      "version": "v0.0.2",
      "file": "plugin_360zy.wasm",
      "url": "https://github.com/HW-public/grain_plugins/releases/download/v0.1.0/plugin_360zy.wasm",
      "sha256": "<64 位小写 hex>",
      "signature": "<128 位小写 hex>"
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `schema` | 清单格式版本，当前恒为 `1` |
| `generatedAt` | 生成时间，UTC，`YYYY-MM-DDTHH:MM:SSZ` |
| `package` | 插件包名，与源码 `plugin_meta!` 的 `package` 一致 |
| `name` | 展示名 |
| `version` | 插件版本，与 `plugin_meta!` 的 `version` 一致 |
| `file` | wasm 文件名 |
| `url` | Release 下载地址（`.../releases/download/<TAG>/<file>`） |
| `sha256` | wasm 文件的 SHA-256，小写 hex |
| `signature` | 对签名消息的 Ed25519 签名，小写 hex（64 字节） |

## 签名规则

- 算法：Ed25519（OpenSSL `pkeyutl -sign -rawin`，无额外摘要包装）。
- 私钥：PKCS#8 PEM，仅保存在本地与 CI secret 中，绝不入库。
- 公钥：32 字节裸公钥，hex 见 `keys/public.hex`，运行时随 `dist/public.hex` 一起发布。
- 签名消息为 UTF-8 字符串，无结尾换行，字段顺序与分隔符严格如下：

```
{package}|{version}|{sha256}
```

例如：

```
360zy.com|v0.0.2|4f2c...（wasm 的 sha256 小写 hex）
```

宿主校验步骤：下载 wasm → 计算 sha256 → 比对清单 → 用公钥验证
`package|version|sha256` 的签名 → 通过后安装。

## 公钥

```
0280177a17a8e5bab6b77f36108f21054e9b5be46c064da961ccdd0eb636d867
```

SHA-256 指纹（对 32 字节裸公钥）：

```
afc918b1 eb5175ae 59ab3ae7 783e843a c7404316 b84dfad0 ad5c0b76 b95c26cb
```

## 新增插件

1. 复制现有插件目录为 `plugins/<slug>/`，修改 `Cargo.toml` 的 `[package].name` 与源码
   `plugin_meta!`（`package` / `name` / `version` 必须准确）。
2. 在根 `Cargo.toml` 的 `members` 中加入 `"plugins/<slug>"`。
3. 在 `scripts/build_dist.sh` 的 `PLUGINS` 表中追加一行
   `产物crate名|wasm文件名|package|name|version`，与 `plugin_meta!` 保持同步。
4. 本地跑一次 `scripts/build_dist.sh` 确认产物与签名正常。
5. 按下面的发布流程打 tag。

## 本地构建

前置：Rust stable + `wasm32-unknown-unknown` 目标、OpenSSL 3.x（带 Ed25519）、
`sha256sum`、`xxd`、Python 3。

```bash
rustup target add wasm32-unknown-unknown

PLUGIN_SIGNING_KEY=C:/Users/WH/.grain/plugin-signing.pem \
TAG=v0.1.0-local \
bash scripts/build_dist.sh
```

产物写入 `dist/`：两个 wasm、`manifest.json`、`public.hex`。`dist/` 每次构建前清空。

`scripts/build_dist.sh` 会自动探测 `python3` / `python` / `py`
（Windows Git Bash 下 `python3` 可能是应用商店占位符，脚本会实际执行一次确认）。

`.cargo/config.toml` 中的 `[target.x86_64-pc-windows-msvc]` 段用于本机无 MSVC
Build Tools 时链接宿主侧 proc-macro；在其他机器上若 rust-lld 路径不同，需自行调整。
CI 跑在 Linux 上，该段不生效。

## 发布流程

打 tag 即发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` 在 `v*` tag 推送时执行：

1. 检出本仓库；
2. 把 `grain_engine` 克隆到 workspace 上一级（供 PDK 路径依赖使用）；
3. 安装 stable 工具链与 wasm32 目标；
4. 从 secret 写出签名私钥到 runner 临时文件；
5. 执行 `scripts/build_dist.sh`；
6. `gh release create` 上传 `dist/*`。

## 配置签名 secret

仓库 Settings → Secrets and variables → Actions → New repository secret：

- 名称：`PLUGIN_SIGNING_KEY`
- 值：私钥 PEM 全文（含 `-----BEGIN PRIVATE KEY-----` 与
  `-----END PRIVATE KEY-----` 两行）

私钥只存在于该 secret 与本地 `C:/Users/WH/.grain/plugin-signing.pem`。
轮换密钥时需同时更新 `keys/public.hex` 与宿主内置公钥，否则旧宿主会拒绝新签名。

## 安全边界

- 签名只证明「产物来自持有私钥的发布者，且内容未被篡改」，不赋予插件任何额外权限。
- 插件的运行时能力仍由宿主沙箱限制：无文件系统访问，网络只能经宿主提供的 HTTP 接口，
  资源配额由宿主约束。
- 防重放与降级由宿主侧的版本比较和清单校验负责；本仓库只保证清单与产物一致。
- 私钥泄露等同于发布权泄露，应立即轮换并在宿主侧替换公钥。

## English summary

`grain_plugins` is the plugin distribution repository for the grain engine. Plugin sources
live under `plugins/`, are compiled to `wasm32-unknown-unknown`, hashed with SHA-256, signed
with Ed25519 over the UTF-8 message `{package}|{version}|{sha256}`, and published as GitHub
Release assets alongside a `manifest.json` (schema 1). Hosts fetch
`https://github.com/HW-public/grain_plugins/releases/latest/download/manifest.json`, verify
the hash and signature against the bundled public key (`keys/public.hex`), and install only
after verification passes. Pushing a `v*` tag triggers the release workflow; the signing key
is provided via the `PLUGIN_SIGNING_KEY` Actions secret. Signatures establish provenance and
integrity only; plugin capabilities remain constrained by the host sandbox.
