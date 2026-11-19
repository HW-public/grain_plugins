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
├── Cargo.toml                 # workspace：members 指向 plugins/*/rust
├── .cargo/config.toml         # crates.io 镜像 + Windows 下 rust-lld 链接器
├── keys/public.hex            # 签名公钥（32 字节 hex，单行）
├── plugins/                   # 插件目录：一个插件一个目录，语言是实现子目录
│   ├── 360zy/                 # 360资源（maccms API）
│   │   ├── rust/              # Rust 实现（Cargo.toml + src/lib.rs）
│   │   └── ts/                # TypeScript 实现（index.ts，产物 build/*.wasm）
│   └── bili-wbi/              # 哔哩哔哩 WBI
│       ├── rust/
│       └── ts/
├── pdk-as/                    # AssemblyScript PDK（build.sh + src/ + probe/ + selftest/）
├── scripts/build_dist.sh      # 按语言构建 → 签名 → 生成 manifest.json
├── .github/workflows/release.yml
├── dist/                      # 构建产物（不入库）
└── target/                    # cargo 产物（不入库）
```

Rust 插件通过相对路径引用 PDK：`../../../../grain_engine/pdk/rust/crates/pdk`。
因此本地构建时，仓库必须与 `grain_engine` 位于同一父目录下（CI 中由 workflow 克隆到兄弟位置）。
TS 插件不依赖 `grain_engine` 仓库，PDK 就在本仓库的 `pdk-as/`。

同一站点存在多语言实现时，产物按语言区分（`plugin_360zy_rust.wasm` /
`plugin_360zy_ts.wasm`），清单条目带 `site` 与 `impl` 字段：宿主按 `site`
分组展示、按 `package` 安装或更新。

## TypeScript / AssemblyScript 插件

除 Rust 插件外，仓库还内置一套面向 ABI v0.2 的 AssemblyScript PDK 与两个 TS 插件：

```
grain_plugins/
├── pdk-as/                    # @grain/pdk-as
│   ├── build.sh               # 封装 asc：固定 --baseDir 并注入自定义 abort
│   ├── package.json           # assemblyscript 0.28.20
│   ├── package-lock.json      # 必须入库，CI 用 npm ci 安装
│   ├── src/                   # heap/strings/host/task/meta/index/abort
│   ├── probe/ selftest/       # 端到端探针与自检（wasm 入库作为回归证据）
│   └── README.md              # PDK 用法、模块表、ABI 约定
└── plugins/
    ├── 360zy/ts/              # 360资源（TS），入口 index.ts
    └── bili-wbi/ts/           # 哔哩哔哩 WBI（TS），入口 index.ts
```

构建前置：Node.js 20+（`npx` 随 npm 提供）。首次构建先安装 PDK 依赖：

```bash
cd pdk-as && npm ci
```

`scripts/build_dist.sh` 在 Rust 构建之后调用 `bash pdk-as/build.sh` 构建两个 TS 插件，
各插件产物统一走 sha256 + Ed25519 签名并写入同一份 `manifest.json`。

| 实现 | package | name | version | wasm 文件 |
| --- | --- | --- | --- | --- |
| Rust | `360zy.com` | 360资源 | v0.0.2 | `plugin_360zy.wasm` |
| Rust | `bilibili.com.wbi` | 哔哩哔哩(WBI) | v0.1.0 | `plugin_bili_wbi.wasm` |
| TS | `360zy.com.ts` | 360资源 (TS) | v0.0.2 | `plugin_360zy_ts.wasm` |
| TS | `bilibili.com.wbi.ts` | 哔哩哔哩(WBI·TS) | v0.1.0 | `plugin_bili_wbi_ts.wasm` |

TS 插件使用带 `.ts` 后缀的独立 package id，因此与同名 Rust 插件可并存安装、互不覆盖。

TS 插件采用同步状态机模型：**没有 `async/await`**。宿主同步调用入口拿到 handle 后反复
调用 `take_result`，插件 `Task.step()` 每次返回 `null`（宿主能力未完成）或结果字符串。
完整用法、模块表与 ABI 约定见 [pdk-as/README.md](pdk-as/README.md)。

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

构建脚本按目录自动发现插件，**不需要修改任何脚本**：

1. 新建 `plugins/<slug>/rust/`（复制现有 Rust 插件）和/或 `plugins/<slug>/ts/`；
   元数据以源码为唯一事实来源：
   - Rust：`plugin_meta!`（`package` / `name` / `version` / `webSite`）
   - TS：`setMeta` 的 JSON 串（同上）
   `site` 默认取 `webSite` 主机名（去掉 `www.`），也可在元数据里加
   `"site": "example.com"` 显式指定。
2. Rust 需把 `"plugins/<slug>/rust"` 加入根 `Cargo.toml` 的 `members`；
   TS 无需登记。
3. `package` 必须全局唯一（构建会拒绝重复）；同一站点多语言实现用不同
   `package`（如 `x.com` / `x.com.ts`），并用相同 `site` 归组。
4. 本地跑一次 `scripts/build_dist.sh` 确认产物与签名正常；
   产物文件名自动为 `plugin_<slug>_<impl>.wasm`。
5. 按下面的发布流程打 tag。

## 本地构建

前置：Rust stable + `wasm32-unknown-unknown` 目标、OpenSSL 3.x（带 Ed25519）、
`sha256sum`、`xxd`、Python 3、Node.js 20+。

```bash
rustup target add wasm32-unknown-unknown
cd pdk-as && npm ci && cd ..

PLUGIN_SIGNING_KEY=C:/Users/WH/.grain/plugin-signing.pem \
TAG=v0.1.0-local \
bash scripts/build_dist.sh
```

产物写入 `dist/`：Rust 2 + TS 3（360zy / bili-wbi / vdm8）共五个 wasm、`manifest.json`、`public.hex`。
`dist/` 每次构建前清空。

`scripts/build_dist.sh` 会自动探测 `python3` / `python` / `py`
（Windows Git Bash 下 `python3` 可能是应用商店占位符，脚本会实际执行一次确认）。
脚本同时检查 `node` / `npx` 与 `pdk-as/node_modules/.bin/asc`，任一缺失都会明确报错并提示
`cd pdk-as && npm ci`。

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
2. 把 `grain_engine` 克隆到 workspace 上一级（供 Rust PDK 路径依赖使用）；
3. 安装 Node.js 20 并执行 `cd pdk-as && npm ci`；
4. 安装 stable 工具链与 wasm32 目标；
5. 从 secret 写出签名私钥到 runner 临时文件；
6. 执行 `scripts/build_dist.sh`（Rust 2 枚 + TS 2 枚）；
7. `gh release create` 上传 `dist/*`。

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

`grain_plugins` is the plugin distribution repository for the grain engine. Rust plugin
sources live under `plugins/`, while two TypeScript plugins under `plugins-ts/` are built with
the bundled AssemblyScript PDK in `pdk-as/` (their package ids carry a `.ts` suffix so they
coexist with the Rust originals). All four artifacts are compiled to wasm, hashed with
SHA-256, signed with Ed25519 over the UTF-8 message `{package}|{version}|{sha256}`, and
published as GitHub Release assets alongside a `manifest.json` (schema 1). Hosts fetch
`https://github.com/HW-public/grain_plugins/releases/latest/download/manifest.json`, verify
the hash and signature against the bundled public key (`keys/public.hex`), and install only
after verification passes. Pushing a `v*` tag triggers the release workflow; the signing key
is provided via the `PLUGIN_SIGNING_KEY` Actions secret. Signatures establish provenance and
integrity only; plugin capabilities remain constrained by the host sandbox.
