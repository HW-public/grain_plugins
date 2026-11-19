# bili-wbi（AssemblyScript）

哔哩哔哩 WBI 插件，从 `pdk/rust/plugins/bili-wbi` 逐条移植到 AssemblyScript，
面向 grain_engine ABI v0.2。

- package：`bilibili.com.wbi.ts`
- name：`哔哩哔哩(WBI·TS)`
- version：`v0.1.0`
- type：`bangumi`

全部逻辑在 WASM 沙箱内完成：playurl 与 search 的 WBI 签名（mixin_key 派生、
参数排序编码、MD5）都在插件内计算；`wts` 取自 nav 响应的 `Date` 头，不依赖宿主时钟。

## 构建

在仓库根目录 `grain_plugins/`：

```bash
bash pdk-as/build.sh plugins/bili-wbi/ts/index.ts \
  plugins/bili-wbi/ts/build/plugin_bili_wbi_ts.wasm
```

产物：`plugins/bili-wbi/ts/build/plugin_bili_wbi_ts.wasm`（约 62 KB）。

## 接口

| 导出 | 行为 |
| --- | --- |
| `latest(page)` | `/x/web-interface/popular?ps=20&pn={page}` → 条目数组 |
| `search(kw)` | nav 取 wbi key → 签名 `/x/web-interface/wbi/search/type` → 条目数组 |
| `detail(url)` | 从 URL 提取 bvid → `/x/web-interface/view?bvid=` → 详情对象 |
| `watch(url)` | 解析私有集数协议 → nav → 签名 `/x/player/wbi/playurl` → 直链 |

条目形状：`{"title","url","cover","update"}`（search 的 `update` 为 UP 主，
latest 的 `update` 为 `owner.name`，标题里的 `<em>` 高亮标签会被剥掉）。

详情形状：`{"title","cover","description","episodes":[{"title","url"}]}`。

watch 结果：`{"url","headers":{"Referer","User-Agent"}}`；dash 优先取
`data.dash.video` 中 `bandwidth` 最大者的 `baseUrl`（或 `base_url`），
无 dash 时回退 `data.durl[0].url`。

所有多步请求（nav → 签名 → 目标接口）由 Task 状态机逐步推进：每次
`take_result` 只推进一个阶段，不在 `step()` 内自旋等待宿主。

## 私有 episode 协议

`detail` 返回的 `episodes[].url` 是插件私有协议值：

```
{bvid}|{cid}|{page}
```

例：`BV1gcs469Ecu|43723197779|1`。调用方必须原样回传给同一个插件的
`watch`，宿主不得解析其结构。`page` 供调用方展示/排序，`watch` 只使用
前三段中的 `bvid`、`cid` 两段（第三段仅校验段数）。

当视频没有 `pages` 字段（或为空）时，detail 用 `data.cid` 生成单集，
`page` 固定为 `1`，标题取视频标题（无标题时为 `正片`）。

## 风控说明

B 站对机房/数据中心 IP 的风控会作用在 search 与 playurl 接口：

- 签名错误或缺失 → `code -403`（"访问权限不足"）；
- 风控拦截 → `code -412`（"请求被拦截"）或 `-352`；
- 地区限制 → 对应 `code` 与 `message`。

插件把源站 `code`/`message` 原样写入错误信封的 `message`，并附带响应
body 作为 `detail`，例如：

```
bili playurl rejected (code -412): 请求被拦截 — source-side risk control
commonly blocks datacenter IPs
```

这类失败取决于运行环境的公网出口，不是插件缺陷；换到住宅/移动网络通常
即可恢复。实测（2026-11-19，本机网络）search 与 playurl 均返回 `code 0`，
直链可用。

## 与 Rust 版的差异

只有一处有意差异：

- **nav 非 0 code 的容忍度**。Rust 版要求 nav 的 `code == 0`，否则
  `nav error: 账号未登录` 直接失败。匿名访问 nav 固定返回
  `code: -101`（同时 `data.wbi_img` 完整可用），因此 Rust 版在未登录
  环境里 search/watch 完全不可用（历史 harness 输出即为此现象）。
  TS 版在 `code != 0` 但 `data.wbi_img` 的 `img_url`/`sub_url` 均存在时
  继续执行，并打一条 warn 日志；缺少 key 时仍按 Rust 的文案失败。

其余签名算法、参数集、字段映射、错误文案与 Rust 版一致；`Date` 头查找
额外兜底了小写 `date`（宿主正常情况下已补规范大小写键）。

## 已知限制

- 未登录：`qn=80` + `fnval=16` 返回的是游客可用的最高清晰度，不一定到 1080P。
- 不支持 Cookie/登录态（插件无跨请求会话注入），大会员清晰度不可用。
- 单页视频的 `pages[0].part` 常是完整标题，因此分集标题可能与视频标题重复。
- ABI 堆为 1 MiB 静态 arena；popular/search 响应约 30-60 KB，正常解析无压力，
  但超大响应（如数 MB）会因分配失败返回 `abi` 错误。
