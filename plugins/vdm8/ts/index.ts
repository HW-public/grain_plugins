// V动漫（vdm8.com）插件 —— MacCMS 定制主题的纯 HTML 抓取实现。
//
// 站点没有 JSON API：最新、搜索、详情、播放全部从 page HTML 提取。
// wasm 内没有正则，所有解析都是 indexOf 线性扫描；坏块直接跳过，
// 不 panic（缺字段只影响该条目/该字段）。

import {
  HostCall,
  Task,
  httpGet,
  jsonQuote,
  log,
  readCstr,
  setMeta,
  spawn,
} from "../../../pdk-as/src/index";
import {
  JsonValue,
  parseJson,
  stringifyJson,
} from "../../../pdk-as/src/util/json";
import { urlencode } from "../../../pdk-as/src/util/urlencode";

// 把 ABI 导出（alloc/dealloc/metadata_json/take_result/last_error/
// free_result）与自定义 abort 带进 wasm。
export * from "../../../pdk-as/src/index";

setMeta(
  '{"name":"V动漫","version":"v1.0.0","type":"bangumi","package":"vdm8.com","author":"grain-engine","lang":"zh-cn","webSite":"https://www.vdm8.com","nsfw":false}',
);

const BASE: string = "https://www.vdm8.com";
const ANIME_CATEGORY: string = "23";
const UA: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQ_HEADERS: string =
  '{"User-Agent":"' + UA + '","Referer":"' + BASE + '/"}';

/// 站点返回的是 UTF-8 HTML（无 charset meta，HTTP 头也没有 charset，
/// 但正文按 UTF-8 编码，宿主按字节透传，这里只做字符串处理）。

// ---------------------------------------------------------------------------
// 通用字符串 / HTML 工具
// ---------------------------------------------------------------------------

function hexDigit(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return -1;
}

function codePointToString(cp: i32): string {
  if (cp <= 0xffff) return String.fromCharCode(cp);
  const v = cp - 0x10000;
  const hi = 0xd800 + (v >> 10);
  const lo = 0xdc00 + (v & 0x3ff);
  return String.fromCharCode(hi) + String.fromCharCode(lo);
}

/// HTML 实体解码：常见命名实体 + 十进制/十六进制数字实体。
/// 无法识别的实体原样保留（只把 & 当普通字符继续扫描）。
function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) {
      out += s.substring(i);
      break;
    }
    out += s.substring(i, amp);
    const semi = s.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const ent = s.substring(amp + 1, semi);
    let rep: string | null = null;
    if (ent == "amp") rep = "&";
    else if (ent == "quot") rep = '"';
    else if (ent == "lt") rep = "<";
    else if (ent == "gt") rep = ">";
    else if (ent == "apos") rep = "'";
    else if (ent == "nbsp") rep = " ";
    else if (ent.length > 1 && ent.charCodeAt(0) == 35) { // #
      let cp = -1;
      if (
        ent.length > 2 &&
        (ent.charCodeAt(1) == 120 || ent.charCodeAt(1) == 88) // x X
      ) {
        let v = 0;
        let ok = ent.length > 2 && ent.length <= 8;
        if (ok) {
          for (let k = 2; k < ent.length; k++) {
            const h = hexDigit(ent.charCodeAt(k));
            if (h < 0) {
              ok = false;
              break;
            }
            v = (v << 4) | h;
          }
        }
        if (ok && v > 0 && v <= 0x10ffff) cp = v;
      } else {
        let v = 0;
        let ok = ent.length > 1 && ent.length <= 8;
        if (ok) {
          for (let k = 1; k < ent.length; k++) {
            const d = ent.charCodeAt(k);
            if (d < 48 || d > 57) {
              ok = false;
              break;
            }
            v = v * 10 + (d - 48);
          }
        }
        if (ok && v > 0 && v <= 0x10ffff) cp = v;
      }
      if (cp > 0) rep = codePointToString(cp);
    }
    if (rep == null) {
      out += "&";
      i = amp + 1;
      continue;
    }
    out += rep;
    i = semi + 1;
  }
  return out;
}

/// 去掉标签，保留文本。
function stripTags(s: string): string {
  if (s.indexOf("<") < 0) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.substring(i);
      break;
    }
    out += s.substring(i, lt);
    const gt = s.indexOf(">", lt);
    if (gt < 0) break;
    i = gt + 1;
  }
  return out;
}

/// 锚点/标签内文本：去标签、解码实体、trim。
function cleanText(s: string): string {
  return decodeEntities(stripTags(s)).trim();
}

/// 在 s 中从 from 起查找 `name="..."` 的属性值。
function attrValueFrom(s: string, from: i32, name: string): string {
  const key = name + '="';
  const i = s.indexOf(key, from);
  if (i < 0) return "";
  const start = i + key.length;
  const end = s.indexOf('"', start);
  if (end < 0) return "";
  return s.substring(start, end);
}

function absolutize(u0: string): string {
  const u = u0.trim();
  if (u.length == 0) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  return BASE + "/" + u;
}

/// 详情入参：绝对 URL 或 /vod/detail/id/<slug>.html；裸 slug 也容错。
function normalizeDetailUrl(u0: string): string {
  const u = u0.trim();
  if (u.length == 0) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  if (u.indexOf(".") >= 0) return BASE + "/" + u;
  return BASE + "/vod/detail/id/" + u + ".html";
}

/// 块内第一个详情链接（href 值以 /vod/detail/id/ 为特征）。
function firstDetailHref(block: string): string {
  let pos = 0;
  while (pos < block.length) {
    const h = block.indexOf('href="', pos);
    if (h < 0) return "";
    const start = h + 6;
    const end = block.indexOf('"', start);
    if (end < 0) return "";
    const v = block.substring(start, end);
    if (v.indexOf("/vod/detail/id/") >= 0) return v;
    pos = end + 1;
  }
  return "";
}

/// 块内第一个封面：data-original="..."。
function firstCover(block: string): string {
  const key = 'data-original="';
  const i = block.indexOf(key);
  if (i < 0) return "";
  const start = i + key.length;
  const end = block.indexOf('"', start);
  if (end < 0) return "";
  const raw = block.substring(start, end);
  if (raw.startsWith("//")) return "https:" + raw;
  if (raw.startsWith("/")) return BASE + raw;
  return raw;
}

/// 列表块里的更新状态：<p class="tc_wz">更新状态</p>。
function tcWzText(block: string): string {
  const i = block.indexOf('class="tc_wz"');
  if (i < 0) return "";
  const gt = block.indexOf(">", i);
  if (gt < 0) return "";
  const end = block.indexOf("</p>", gt);
  if (end < 0) return "";
  return cleanText(block.substring(gt + 1, end));
}

// ---------------------------------------------------------------------------
// 列表 / 搜索解析
// ---------------------------------------------------------------------------

/// 列表页（最新页与 show 页同构）：按 <li> 分块，
/// 只保留含 /vod/detail/id/ 链接的块。
function parseListItems(html: string): string {
  let out = "[";
  let first = true;
  let pos = 0;
  while (pos < html.length) {
    const liStart = html.indexOf("<li", pos);
    if (liStart < 0) break;
    const liEnd = html.indexOf("</li>", liStart);
    if (liEnd < 0) break;
    pos = liEnd + 5;
    // 排除 <link ...>：<li 后必须是空白、'>' 或 '/'。
    const after = liStart + 3;
    if (after >= html.length) break;
    const nc = html.charCodeAt(after);
    if (
      !(nc == 32 || nc == 9 || nc == 10 || nc == 13 || nc == 62 || nc == 47)
    ) {
      continue;
    }
    const block = html.substring(liStart, liEnd);
    const href = firstDetailHref(block);
    if (href.length == 0) continue;
    const url = absolutize(href);
    if (url.length == 0) continue;
    let title = decodeEntities(attrValueFrom(block, 0, "title")).trim();
    if (title.length == 0) {
      // 兜底：<div class="name"> 内的锚点文本。
      const nameIdx = block.indexOf('class="name"');
      if (nameIdx >= 0) {
        const a = block.indexOf("<a", nameIdx);
        if (a >= 0) {
          const gt = block.indexOf(">", a);
          const close = block.indexOf("</a>", gt);
          if (gt >= 0 && close >= 0) {
            title = cleanText(block.substring(gt + 1, close));
          }
        }
      }
    }
    if (title.length == 0) continue;
    const cover = firstCover(block);
    const update = tcWzText(block);
    if (!first) out += ",";
    first = false;
    out +=
      '{"title":' + jsonQuote(title) +
      ',"url":' + jsonQuote(url) +
      ',"cover":' + jsonQuote(cover) +
      ',"update":' + jsonQuote(update) + "}";
  }
  return out + "]";
}

/// 搜索页：按 class="result_list" 分块，块内取详情链接、封面、
/// result_title 锚点文本。
function parseSearchItems(html: string): string {
  const marker = 'class="result_list"';
  let out = "[";
  let first = true;
  let pos = html.indexOf(marker);
  while (pos >= 0) {
    const next = html.indexOf(marker, pos + marker.length);
    const block = next < 0 ? html.substring(pos) : html.substring(pos, next);
    pos = next;

    const href = firstDetailHref(block);
    if (href.length == 0) continue;
    const url = absolutize(href);
    if (url.length == 0) continue;

    let title = "";
    const rt = block.indexOf('class="result_title"');
    if (rt >= 0) {
      const a = block.indexOf("<a", rt);
      if (a >= 0) {
        const gt = block.indexOf(">", a);
        const close = block.indexOf("</a>", gt);
        if (gt >= 0 && close >= 0) {
          title = cleanText(block.substring(gt + 1, close));
        }
      }
    }
    if (title.length == 0) title = decodeEntities(attrValueFrom(block, 0, "title")).trim();
    if (title.length == 0) continue;

    // 状态：<span>...</span>（块内 <li>状态：<span>HD全集</span></li>）
    let update = "";
    const st = block.indexOf("状态：");
    if (st >= 0) {
      const sp = block.indexOf("<span", st);
      if (sp >= 0) {
        const gt = block.indexOf(">", sp);
        const close = block.indexOf("</span>", gt);
        if (gt >= 0 && close >= 0) {
          update = cleanText(block.substring(gt + 1, close));
        }
      }
    }

    const cover = firstCover(block);
    if (!first) out += ",";
    first = false;
    out +=
      '{"title":' + jsonQuote(title) +
      ',"url":' + jsonQuote(url) +
      ',"cover":' + jsonQuote(cover) +
      ',"update":' + jsonQuote(update) + "}";
  }
  return out + "]";
}

// ---------------------------------------------------------------------------
// 详情解析
// ---------------------------------------------------------------------------

function parseDetailTitle(html: string): string {
  const h = html.indexOf("<h1");
  if (h < 0) return "";
  const hEnd = html.indexOf("</h1>", h);
  const seg = html.substring(h, hEnd < 0 ? html.length : hEnd);
  const t = attrValueFrom(seg, 0, "title");
  if (t.length > 0) return decodeEntities(t).trim();
  const sp = seg.indexOf("<span");
  if (sp >= 0) {
    const gt = seg.indexOf(">", sp);
    const end = seg.indexOf("</span>", gt);
    if (gt >= 0 && end >= 0) return cleanText(seg.substring(gt + 1, end));
  }
  return cleanText(seg);
}

/// <meta name="description" content="...">；属性顺序无关。
function parseDescription(html: string): string {
  const n = html.indexOf('name="description"');
  if (n < 0) return "";
  let tagStart = html.lastIndexOf("<meta", n);
  if (tagStart < 0) tagStart = n;
  const tagEnd = html.indexOf(">", n);
  if (tagEnd < 0) return "";
  const tag = html.substring(tagStart, tagEnd);
  const c = tag.indexOf('content="');
  if (c < 0) return "";
  const start = c + 9;
  const end = tag.indexOf('"', start);
  if (end < 0) return "";
  return decodeEntities(tag.substring(start, end)).trim();
}

/// 扫描全部 /vod/play/id/<slug>/sid/<S>/nid/<N>.html 锚点。
/// 只取文档中第一个出现的 sid 的全部剧集（同一作品多线路时避免重复）。
function parseEpisodes(html: string): JsonValue[] {
  const out: JsonValue[] = [];
  const seen: string[] = [];
  let sid = "";
  let haveSid = false;
  let pos = 0;
  while (pos < html.length) {
    const h = html.indexOf('href="', pos);
    if (h < 0) break;
    const vStart = h + 6;
    const vEnd = html.indexOf('"', vStart);
    if (vEnd < 0) break;
    pos = vEnd + 1;
    const href = html.substring(vStart, vEnd);
    if (href.indexOf("/vod/play/id/") < 0) continue;
    const si = href.indexOf("/sid/");
    if (si < 0) continue;
    const sidStart = si + 5;
    const sidEnd = href.indexOf("/", sidStart);
    if (sidEnd <= sidStart) continue;
    const thisSid = href.substring(sidStart, sidEnd);
    if (!haveSid) {
      sid = thisSid;
      haveSid = true;
    }
    if (thisSid != sid) continue;

    const abs = absolutize(href);
    if (abs.length == 0) continue;
    let dup = false;
    for (let k = 0; k < seen.length; k++) {
      if (seen[k] == abs) {
        dup = true;
        break;
      }
    }
    if (dup) continue;

    // 锚点起始标签 -> 文本；文本空时回退标签的 title 属性。
    let title = "";
    const gt = html.indexOf(">", vEnd);
    if (gt >= 0) {
      const close = html.indexOf("</a>", gt + 1);
      if (close >= 0) title = cleanText(html.substring(gt + 1, close));
      if (title.length == 0) {
        const tagStart = html.lastIndexOf("<a", vEnd);
        if (tagStart >= 0 && gt > tagStart) {
          title = decodeEntities(
            attrValueFrom(html.substring(tagStart, gt), 0, "title"),
          ).trim();
        }
      }
    }

    seen.push(abs);
    out.push(
      JsonValue.ofObject(["title", "url"], [
        JsonValue.ofString(title),
        JsonValue.ofString(abs),
      ]),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 播放页解析
// ---------------------------------------------------------------------------

/// 截取 `player_aaaa=` 之后的 JSON 对象（花括号配平，感知字符串/转义）。
/// 输入字符串内不含未转义的裸花括号（站点实际数据满足；若不满足，
/// 配平会失败并返回空串，由调用方走错误态）。
function extractPlayerJson(html: string): string {
  const key = "player_aaaa=";
  const i = html.indexOf(key);
  if (i < 0) return "";
  let p = i + key.length;
  while (p < html.length) {
    const c = html.charCodeAt(p);
    if (c == 32 || c == 9 || c == 10 || c == 13) {
      p++;
    } else {
      break;
    }
  }
  if (p >= html.length || html.charCodeAt(p) != 123) return ""; // {
  const start = p;
  let depth = 0;
  let inStr = false;
  let esc = false;
  while (p < html.length) {
    const c = html.charCodeAt(p);
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c == 92) {
        esc = true;
      } else if (c == 34) {
        inStr = false;
      }
    } else {
      if (c == 34) {
        inStr = true;
      } else if (c == 123) {
        depth++;
      } else if (c == 125) {
        depth--;
        if (depth == 0) return html.substring(start, p + 1);
      }
    }
    p++;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 任务：每次 step 最多推进一个宿主调用
// ---------------------------------------------------------------------------

/// 单次 HTTP GET + 解析。宿主响应形如
/// {"status":int,"headers":{...},"body":"..."} 或错误信封。
abstract class PageTask extends Task {
  url: string;
  call: HostCall | null = null;

  constructor(url: string) {
    super();
    this.url = url;
  }

  abstract parse(body: string): string | null;

  step(): string | null {
    if (this.call == null) {
      this.call = httpGet(this.url, REQ_HEADERS);
      return null;
    }

    const call = this.call!;
    const resp = call.poll();
    if (resp == null) return null;
    this.call = null;

    const v = parseJson(resp);
    if (v == null) return this.fail("http", "invalid host response", this.url);

    const statusV = v.get("status");
    if (statusV == null || !statusV.isNumber()) {
      const codeV = v.get("code");
      const msgV = v.get("message");
      const code = codeV != null && codeV.isString() ? codeV.asString() : "http";
      const msg = msgV != null && msgV.isString()
        ? msgV.asString()
        : "request failed";
      return this.fail(code, msg, this.url);
    }

    const status = <i32>statusV.asNumber();
    if (status < 200 || status >= 400) {
      return this.fail("http", "HTTP " + status.toString(), this.url);
    }

    const bodyV = v.get("body");
    const body = bodyV != null && bodyV.isString() ? bodyV.asString() : "";
    if (body.length == 0) log(2, "[vdm8] empty response body: " + this.url);
    return this.parse(body);
  }
}

class LatestTask extends PageTask {
  constructor(page: i32) {
    const p = page < 1 ? 1 : page;
    super(
      BASE + "/vod/show/id/" + ANIME_CATEGORY + "/page/" + p.toString() + ".html",
    );
  }

  parse(body: string): string | null {
    return parseListItems(body);
  }
}

class SearchTask extends PageTask {
  kw: string;

  constructor(kw0: string) {
    const kw = kw0.trim();
    // 空白关键词按最新页处理（搜索页结构不同，且空词无意义）。
    super(
      kw.length == 0
        ? BASE + "/vod/show/id/" + ANIME_CATEGORY + "/page/1.html"
        : BASE + "/vod/search.html?wd=" + urlencode(kw),
    );
    this.kw = kw;
  }

  parse(body: string): string | null {
    return this.kw.length == 0 ? parseListItems(body) : parseSearchItems(body);
  }
}

class DetailTask extends PageTask {
  constructor(url: string) {
    super(normalizeDetailUrl(url));
  }

  parse(body: string): string | null {
    const title = parseDetailTitle(body);
    const cover = firstCover(body);
    const description = parseDescription(body);
    const episodes = parseEpisodes(body);
    if (title.length == 0 && cover.length == 0 && episodes.length == 0) {
      log(2, "[vdm8] detail parse failed: " + this.url);
      return this.fail("plugin", "detail page parse failed", this.url);
    }
    return (
      '{"title":' + jsonQuote(title) +
      ',"cover":' + jsonQuote(cover) +
      ',"description":' + jsonQuote(description) +
      ',"episodes":' + stringifyJson(JsonValue.ofArray(episodes)) +
      "}"
    );
  }
}

/// 播放页的 `player_aaaa.url` 可能不是直链（如 ffzy 的 /share/ 分享页，
/// 需浏览器 JS 才能出地址）。此时按同集（nid 不变）依次尝试其它线路
/// （sid 1..8），取第一个媒体直链；全部失败才报错。
function isMediaUrl(u: string): bool {
  const lower = u.toLowerCase();
  return lower.indexOf(".m3u8") >= 0 || lower.indexOf(".mp4") >= 0;
}

function buildCandidates(url: string): string[] {
  const out: string[] = [];
  if (url.length > 0) out.push(url);
  const si = url.indexOf("/sid/");
  const ni = url.indexOf("/nid/", si >= 0 ? si : 0);
  if (si < 0 || ni < 0) return out;
  const prefix = url.substring(0, si + 5);
  const sidEnd = url.indexOf("/", si + 5);
  if (sidEnd < 0) return out;
  const suffix = url.substring(sidEnd);
  for (let s = 1; s <= 8; s++) {
    const cand = prefix + s.toString() + suffix;
    if (cand != url) out.push(cand);
  }
  return out;
}

/// 宿主响应信封 → HTML body；错误信封/非 2xx 返回空串。
function extractHostBody(resp: string): string {
  const v = parseJson(resp);
  if (v == null) return "";
  const codeV = v.get("code");
  if (codeV != null && codeV.isString()) return "";
  const statusV = v.get("status");
  if (statusV == null || !statusV.isNumber()) return "";
  const status = <i32>statusV.asNumber();
  if (status < 200 || status >= 400) return "";
  const bodyV = v.get("body");
  return bodyV != null && bodyV.isString() ? bodyV.asString() : "";
}

function extractDirectUrl(body: string): string {
  const raw = extractPlayerJson(body);
  if (raw.length == 0) return "";
  const v = parseJson(raw);
  if (v == null) return "";
  const urlV = v.get("url");
  return urlV != null && urlV.isString() ? urlV.asString().trim() : "";
}

class WatchTask extends Task {
  url: string;
  private candidates: string[];
  private idx: i32 = 0;
  private call: HostCall | null = null;

  constructor(url: string) {
    super();
    const u = absolutize(url);
    this.url = u;
    this.candidates = buildCandidates(u);
  }

  step(): string | null {
    if (this.url.length == 0) return this.fail("plugin", "watch url required");
    while (true) {
      if (this.call == null) {
        if (this.idx >= this.candidates.length) {
          log(2, "[vdm8] no playable source for " + this.url);
          return this.fail("plugin", "no playable source found", this.url);
        }
        this.call = httpGet(this.candidates[this.idx], REQ_HEADERS);
        return null;
      }

      const resp = this.call!.poll();
      if (resp == null) return null;
      this.call = null;

      const body = extractHostBody(resp);
      if (body.length > 0) {
        const direct = extractDirectUrl(body);
        if (direct.length > 0 && isMediaUrl(direct)) {
          return '{"url":' + jsonQuote(direct) + ',"headers":' + REQ_HEADERS + "}";
        }
      }
      this.idx++;
    }
  }
}

// ---------------------------------------------------------------------------
// ABI 导出
// ---------------------------------------------------------------------------

export function latest(page: i32): i32 {
  return spawn(new LatestTask(page));
}

export function search(kwPtr: i32): i32 {
  return spawn(new SearchTask(readCstr(kwPtr)));
}

export function detail(urlPtr: i32): i32 {
  return spawn(new DetailTask(readCstr(urlPtr)));
}

export function watch(urlPtr: i32): i32 {
  return spawn(new WatchTask(readCstr(urlPtr)));
}
