# V动漫（vdm8.com）—— AssemblyScript 版

面向 `https://www.vdm8.com` 的 ABI v0.2 插件。站点是 MacCMS 定制主题，
**没有 JSON API**，四个调用全部从 HTML 抓取；wasm 内无正则，解析统一用
`indexOf` 线性扫描。

- package：`vdm8.com`
- 类型：`bangumi`，author `grain-engine`，version `v1.0.0`
- 编码：UTF-8；请求需桌面 UA，响应 header 额外带 `Referer: https://www.vdm8.com/`

## 构建

在 `grain_plugins` 仓库根目录：

```bash
bash pdk-as/build.sh plugins/vdm8/ts/index.ts \
  plugins/vdm8/ts/build/plugin_vdm8_ts.wasm
```

产物：`plugins/vdm8/ts/build/plugin_vdm8_ts.wasm`（约 48 KB）。

## 站点结构

### 最新列表（动漫分类 id=23）

`{BASE}/vod/show/id/23/page/{page}.html`，页码从 1 起。每部作品是一个
`<li>` 块（与 `/vod/type/id/23/page/N.html` 列表页同构）：

```html
<li>
  <div class="show_play">
    <a href="/vod/detail/id/<slug>.html" class="tcl-img" title="标题">
      <div class="tc_img img_wrapper lazyload" data-original="封面"></div>
      ...
      <p class="tc_wz">更新状态</p>
    </a>
  </div>
  <div class="name">...</div>
</li>
```

### 搜索

`{BASE}/vod/search.html?wd={urlencode(keyword)}`。结果块是
`<div class="result_list">`，块内第一个 `/vod/detail/id/` 链接、第一个
`data-original` 封面、`<div class="result_title">` 里的锚点文本分别是
地址、封面、标题；状态取自 `状态：<span>...</span>`。标题锚点内可能有
`<em>` 高亮标签，解析时去标签并解码 HTML 实体。

### 详情

`{BASE}/vod/detail/id/<slug>.html`：

- 标题：`<h1 class="l">` 内锚点 `title` 属性，缺失时取 `<span>` 文本；
- 封面：页面第一个 `data-original`；
- 简介：`<meta name="description" content="...">`；
- 剧集：所有 `/vod/play/id/<slug>/sid/<S>/nid/<N>.html` 锚点。同一作品
  常有 sid=1/2/3 多条线路，插件**只取文档中第一个出现的 sid** 的全部剧集，
  去重后按页面顺序返回；锚点文本即集名（如 `第01集`），为空时回退锚点
  `title` 属性。

### 播放

`{BASE}/vod/play/id/<slug>/sid/<S>/nid/<N>.html`。页面内联
`player_aaaa={...}`，插件从 `{` 起做花括号配平扫描（感知字符串与 `\`
转义），用 PDK JSON 解析器取出 `url` 字段。

## 调用契约

| 调用 | 行为 |
| --- | --- |
| `latest(page)` | 请求动漫分类第 `page` 页（`page < 1` 归一为 1），返回 `[{"title","url","cover","update"}]`；`url` 是详情页绝对地址 |
| `search(kw)` | 请求搜索页，返回与 `latest` 同形状的条目数组；空白关键词退化为最新页第 1 页 |
| `detail(url)` | 入参为绝对详情 URL 或 `/vod/detail/id/<slug>.html`；返回 `{"title","cover","description","episodes":[{"title","url"}]}`，`episodes[].url` 为剧集绝对地址 |
| `watch(url)` | 入参为剧集绝对 URL；返回 `{"url":<player_aaaa.url>,"headers":{"User-Agent":..., "Referer":"https://www.vdm8.com/"}}`；`player_aaaa` 缺失、JSON 非法或 `url` 为空时返回 `plugin` 错误；若 `url` 不是媒体直链（如 ffzy 的 `/share/` 分享页），自动按同集依次尝试 sid 1..8 的其它线路，取第一个 `.m3u8`/`.mp4` 直链 |

`watch` 的直链由站点播放器配置决定：部分线路是 m3u8（如 `*.ppqrrs.com`），
部分线路是第三方分享页（如 `vip.ffzy-plays.com/share/<id>`），插件按
`player_aaaa.url` **原样返回**，不做二次解析。

## 错误与容错

- 宿主返回非 2xx/3xx 时进入 `http` 错误态；宿主错误信封的 `code`/`message`
  原样透传。
- 列表/搜索条目缺链接或标题时跳过该块；缺封面/状态留空串。
- 详情单字段缺失只影响该字段；标题、封面与剧集全为空才报
  `plugin: detail page parse failed`。
- 剧集只按 `sid` 字符串相等过滤，不依赖页码顺序；重复 URL 去重。
- 所有解析均为下标扫描，不抛异常、不 panic（唯一例外是宿主内存/句柄错误，
  由 PDK 统一返回 `abi` 错误信封）。

## 已知限制

- 搜索是站内标题子串匹配且**没有分页参数**；例如 `火影忍者` 当前只返回
  1 条（`火影忍者：佐助VS鸣人`），`第` 可返回 10 条。
- 若主题把单集特别篇（如 `HD`）排在剧集线路之前，`detail` 按“第一个 sid”
  规则只会返回该特别篇的 1 集。这是避免多线路重复的取舍。
- 站点域名镜像较多（抓取时 canonical 也出现过 `vdm6.com`），`BASE` 固定为
  `https://www.vdm8.com`；无域名故障转移。
- 无重试与主动缓存；每次调用一次 HTTP（`detail`/`watch` 各一次）。
- `player_aaaa` 的花括号配平假设字符串内没有裸 `{`/`}`（站点实际数据满足）；
  不满足时按 `player_aaaa not found` 报错，不会 panic。
