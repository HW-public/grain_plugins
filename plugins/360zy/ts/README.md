# 360资源（360zy.com）—— AssemblyScript 版

`grain_engine/pdk/rust/plugins/360zy` 的 AssemblyScript 移植，ABI v0.2，
行为与 Rust 原版一致（无差异）。

- package：`360zy.com.ts`（与 Rust 版 `360zy.com` 区分）
- 类型：`bangumi`，author `hualiong`，version `v0.0.2`

## 构建

在 `grain_plugins` 仓库根目录：

```bash
bash pdk-as/build.sh plugins/360zy/ts/index.ts plugins/360zy/ts/build/plugin_360zy_ts.wasm
```

产物：`plugins/360zy/ts/build/plugin_360zy_ts.wasm`（约 46 KB）。

## 行为

- **latest(page)**：请求
  `https://{domain}/api.php/provide/vod?ac=detail&pg={page}(&h={cachedH})`，
  7 个域名（360zy.com / .net / .top / .tv / 360zy1.com / 360zy2.com /
  360zy3.com）串行故障转移，响应 200 且 body 以 `{` 开头才算成功。
  成功后从响应 `Date` 头推导东九区小时（0 归一为 24）缓存 `h`，供后续请求复用。
  返回 `[{"title","url","cover","update"}]`，`url` 为 `vod_id` 字符串。
- **search(kw)**：关键词空白时等价 `latest(1)`（含 `h` 缓存与刷新）；
  否则请求 `&wd={urlencode(kw)}&pg=1`（ABI v0.2 只传 keyword，页码固定 1）。
- **detail(id)**：请求 `&ids={urlencode(id)}`，同域名故障转移。
  `title=vod_name`（空则 `vod {id}`），`cover=vod_pic`，
  `description=vod_content`（空则 `vod_blurb`）。
  `episodes` 取 `vod_play_url`：先按 `$$$` 取第一播放源，按 `#` 分集，
  每项按首个 `$` 拆标题与地址；地址为空跳过，标题为空补 `第NN集`（两位补零）。
- **watch(url)**：trim 后为空报 `plugin` 错误 `watch url required`；
  否则原样返回 `{"url": <url>}`（maccms 播放地址即直链）。

## 契约示例

`latest(1)`：

```json
[{"title":"十万狂花入梦来","url":"109934","cover":"https://...jpg","update":"更新至12集"}]
```

`detail("109934")`：

```json
{
  "title": "十万狂花入梦来",
  "cover": "https://...jpg",
  "description": "……",
  "episodes": [
    {"title": "第01集", "url": "https://vod1.maowushi.com/.../index.m3u8"}
  ]
}
```

`watch("https://vod1.maowushi.com/.../index.m3u8")`：

```json
{"url":"https://vod1.maowushi.com/.../index.m3u8"}
```
