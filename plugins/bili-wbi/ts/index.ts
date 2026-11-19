// 哔哩哔哩（WBI）TS 版 —— 逐条移植自 pdk/rust/plugins/bili-wbi/src/lib.rs。
// 全流程在插件（WASM 沙箱）内完成：nav 取 img_key/sub_key → 按官方
// mixin_key 置换表派生 key → 参数排序编码 → 插件内纯 AS MD5 算 w_rid。
// 时钟同样沙箱化：wts 取自 nav 响应的 Date 头（HTTP-date → Unix 秒）。
//
// 与 Rust 版的唯一行为差异：nav 返回非 0 code 但 data.wbi_img 完整时
// （匿名访问固定返回 -101 账号未登录）继续执行；Rust 版在此直接失败，
// 导致 search/watch 在未登录环境完全不可用。见 README「与 Rust 版的差异」。

import {
  HostCall,
  Task,
  httpGet,
  log,
  readCstr,
  setMeta,
  spawn,
} from "../../../pdk-as/src/index";
import { JsonValue, parseJson } from "../../../pdk-as/src/util/json";
import { md5Hex as md5Hash } from "../../../pdk-as/src/util/md5";
import { urlencode } from "../../../pdk-as/src/util/urlencode";
import { httpDateToUnix } from "../../../pdk-as/src/util/httpdate";
import { jsonQuote } from "../../../pdk-as/src/strings";

// 把 ABI 导出（alloc/dealloc/metadata_json/take_result/last_error/
// free_result）与自定义 abort 带上 wasm。
export * from "../../../pdk-as/src/index";

setMeta(
  '{"name":"哔哩哔哩(WBI·TS)","version":"v0.1.0","type":"bangumi","package":"bilibili.com.wbi.ts","author":"grain-engine","lang":"zh-cn","webSite":"https://www.bilibili.com","nsfw":false}',
);

const UA: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFERER: string = "https://www.bilibili.com";
// JSON 字面量：UA 与 Referer 都是纯 ASCII，可直接拼接。
const HEADERS_JSON: string =
  '{"User-Agent":"' + UA + '","Referer":"' + REFERER + '"}';

const NAV_URL: string = "https://api.bilibili.com/x/web-interface/nav";

/// 官方 mixin_key 置换表（64 项）。
const MIXIN_TAB: usize = memory.data<u8>([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]);

// ---------------------------------------------------------------------------
// WBI 签名
// ---------------------------------------------------------------------------

function isHexDigit(c: i32): bool {
  return (
    (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
  );
}

/// "https://i0.hdslb.com/bfs/wbi/<key>.png" → "<key>"（32 位十六进制）。
/// 非法返回空串（Rust 版为 None）。
function keyFromUrl(url: string): string {
  const slash = url.lastIndexOf("/");
  if (slash < 0) return "";
  const seg = url.substring(slash + 1);
  const dot = seg.indexOf(".");
  const stem = dot < 0 ? seg : seg.substring(0, dot);
  if (stem.length != 32) return "";
  for (let i = 0; i < 32; i++) {
    if (!isHexDigit(stem.charCodeAt(i))) return "";
  }
  return stem;
}

function deriveMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  const units: i32[] = [];
  const n = raw.length < 64 ? raw.length : 64;
  for (let i = 0; i < 32; i++) {
    const idx = <i32>load<u8>(MIXIN_TAB + (<usize>i));
    if (idx >= n) break;
    units.push(raw.charCodeAt(idx));
  }
  return String.fromCharCodes(units);
}

/// 字符串字典序比较（参数键均为 ASCII，等价 Rust String::cmp 的字节序）。
function cmpStr(a: string, b: string): i32 {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d != 0) return d;
  }
  return a.length - b.length;
}

/// B 站 wbi 签名：补 wts → 按键名排序 → RFC3986 编码拼接 → md5(query + mixin_key)。
/// keys/vals 由调用方提供，原地补 wts 并排序。
function wbiSign(
  keys: string[],
  vals: string[],
  mixinKey: string,
  wts: i64,
): string {
  keys.push("wts");
  vals.push(wts.toString());
  // 插入排序：参数不超过 8 个，稳定且无需泛型比较器。
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    const v = vals[i];
    let j = i - 1;
    while (j >= 0 && cmpStr(keys[j], k) > 0) {
      keys[j + 1] = keys[j];
      vals[j + 1] = vals[j];
      j--;
    }
    keys[j + 1] = k;
    vals[j + 1] = v;
  }
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    parts.push(urlencode(keys[i]) + "=" + urlencode(vals[i]));
  }
  const query = parts.join("&");
  return query + "&w_rid=" + md5Hash(query + mixinKey);
}

// ---------------------------------------------------------------------------
// 宿主 HTTP 响应解包（{"status","headers","body"} / 错误信封）
// ---------------------------------------------------------------------------

class HttpOut {
  /// false：宿主错误信封（hostCode/hostMessage 有效）。
  ok: bool = false;
  /// 响应不是合法 JSON（ABI 违例）。
  invalid: bool = false;
  hostCode: string = "";
  hostMessage: string = "";
  status: i32 = 0;
  body: string = "";
  headers: JsonValue | null = null;
}

function normalizeHostCode(code: string): string {
  if (code == "http" || code == "abi" || code == "fuel" || code == "timeout") {
    return code;
  }
  return "plugin";
}

/// 解析宿主响应：错误信封 → hostCode/hostMessage；成功 → status/headers/body。
/// 与 Rust PDK 的 parse_host_response 同构（含旧式 v0 {"error":...}）。
function decodeHttp(raw: string): HttpOut {
  const out = new HttpOut();
  const v = parseJson(raw);
  if (v == null) {
    out.invalid = true;
    return out;
  }
  const code = v.get("code");
  const msg = v.get("message");
  if (code != null && code.isString() && msg != null && msg.isString()) {
    out.hostCode = code.asString();
    out.hostMessage = msg.asString();
    return out;
  }
  const err = v.get("error");
  if (err != null && err.isString()) {
    out.hostCode = "plugin";
    out.hostMessage = err.asString();
    return out;
  }
  out.ok = true;
  const st = v.get("status");
  if (st != null) out.status = <i32>st.asNumber();
  const h = v.get("headers");
  if (h != null && h.isObject()) out.headers = h;
  const b = v.get("body");
  if (b != null) out.body = b.asString();
  return out;
}

/// 响应头查找：ABI 约定宿主补规范大小写的 Date，这里再兜底小写形态。
function headerValue(h: JsonValue | null, name: string): string {
  if (h == null) return "";
  const v = h.get(name);
  if (v != null && v.isString()) return v.asString();
  return "";
}

// ---------------------------------------------------------------------------
// 业务 JSON 解析
// ---------------------------------------------------------------------------

class BodyOut {
  invalid: bool = false;
  /// 源站 code；缺失按 -1（与 Rust unwrap_or(-1) 一致）。
  code: i32 = -1;
  message: string = "unknown";
  doc: JsonValue = JsonValue.nullValue();
}

function parseBody(body: string): BodyOut {
  const out = new BodyOut();
  const v = parseJson(body);
  if (v == null) {
    out.invalid = true;
    return out;
  }
  out.doc = v;
  const c = v.get("code");
  if (c != null && c.isNumber()) out.code = <i32>c.asNumber();
  const m = v.get("message");
  if (m != null && m.isString()) out.message = m.asString();
  return out;
}

function child(v: JsonValue | null, key: string): JsonValue | null {
  if (v == null) return null;
  return v.get(key);
}

// ---------------------------------------------------------------------------
// 条目映射
// ---------------------------------------------------------------------------

/// B 站搜索标题带 <em class="keyword">高亮标签，剥掉。
function stripTags(s: string): string {
  const units: i32[] = [];
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 60) { // <
      inTag = true;
    } else if (c == 62) { // >
      inTag = false;
    } else if (!inTag) {
      units.push(c);
    }
  }
  return String.fromCharCodes(units);
}

function coverOf(e: JsonValue): string {
  const picV = e.get("pic");
  if (picV == null) return "";
  const p = picV.asString();
  if (p.startsWith("//")) return "https:" + p;
  return p;
}

/// 视频条目；updateOverride 为 null 时取 author。
function mapVideo(
  bvid: string,
  e: JsonValue,
  updateOverride: string | null,
): string {
  const titleV = e.get("title");
  const title = titleV != null ? stripTags(titleV.asString()) : "";
  let update = "";
  if (updateOverride != null) {
    update = updateOverride;
  } else {
    const authorV = e.get("author");
    if (authorV != null) update = authorV.asString();
  }
  return (
    '{"title":' +
    jsonQuote(title) +
    ',"url":' +
    jsonQuote("https://www.bilibili.com/video/" + bvid) +
    ',"cover":' +
    jsonQuote(coverOf(e)) +
    ',"update":' +
    jsonQuote(update) +
    "}"
  );
}

/// /popular 列表 → 条目数组；body 非法返回 null。
function mapPopular(body: string): string | null {
  const v = parseJson(body);
  if (v == null) return null;
  const list = child(child(v, "data"), "list");
  const items: string[] = [];
  if (list != null && list.isArray()) {
    for (let i = 0; i < list.items.length; i++) {
      const e = list.items[i];
      if (!e.isObject()) continue;
      const bv = e.get("bvid");
      if (bv == null || !bv.isString()) continue;
      const ownerName = child(child(e, "owner"), "name");
      const updateOverride: string | null =
        ownerName != null && ownerName.isString() ? ownerName.asString() : null;
      items.push(mapVideo(bv.asString(), e, updateOverride));
    }
  }
  return "[" + items.join(",") + "]";
}

/// /search/type 的 data.result → 条目数组。
function mapSearchResult(doc: JsonValue): string {
  const list = child(child(doc, "data"), "result");
  const items: string[] = [];
  if (list != null && list.isArray()) {
    for (let i = 0; i < list.items.length; i++) {
      const e = list.items[i];
      if (!e.isObject()) continue;
      const bv = e.get("bvid");
      if (bv == null || !bv.isString()) continue;
      items.push(mapVideo(bv.asString(), e, null));
    }
  }
  return "[" + items.join(",") + "]";
}

/// cid/page 既可能是数字也可能是字符串（与 Rust id_string 一致）。
function idString(v: JsonValue | null): string | null {
  if (v == null) return null;
  if (v.isNumber()) {
    if (v.numRaw.length > 0) return v.numRaw;
    return v.numValue.toString();
  }
  if (v.isString()) return v.strValue;
  return null;
}

/// /view 的 data → 详情对象。
function mapDetail(bvid: string, data: JsonValue): string {
  const titleV = data.get("title");
  const title = titleV != null ? titleV.asString() : "";
  const descV = data.get("desc");
  const description = descV != null ? descV.asString() : "";
  const cover = coverOf(data);

  const episodes: string[] = [];
  const pages = data.get("pages");
  if (pages != null && pages.isArray()) {
    for (let i = 0; i < pages.items.length; i++) {
      const p = pages.items[i];
      if (!p.isObject()) continue;
      const cid = idString(p.get("cid"));
      if (cid == null) continue;
      let page = i + 1;
      const pv = p.get("page");
      if (pv != null && pv.isNumber()) page = <i32>pv.asNumber();
      const partV = p.get("part");
      const part = partV != null ? partV.asString() : "";
      const epTitle = part.length == 0 ? "P" + page.toString() : part;
      episodes.push(
        '{"title":' +
          jsonQuote(epTitle) +
          ',"url":' +
          // 私有协议：{bvid}|{cid}|{page}，watch 解析。
          jsonQuote(bvid + "|" + cid + "|" + page.toString()) +
          "}",
      );
    }
  }

  if (episodes.length == 0) {
    const cid = idString(data.get("cid"));
    if (cid != null) {
      const epTitle = title.length == 0 ? "正片" : title;
      episodes.push(
        '{"title":' +
          jsonQuote(epTitle) +
          ',"url":' +
          jsonQuote(bvid + "|" + cid + "|1") +
          "}",
      );
    }
  }

  return (
    '{"title":' +
    jsonQuote(title) +
    ',"cover":' +
    jsonQuote(cover) +
    ',"description":' +
    jsonQuote(description) +
    ',"episodes":[' +
    episodes.join(",") +
    "]}"
  );
}

/// 从 URL 或裸 BV 号里提取 12 位 bvid（BV + 10 位字母数字）。
function extractBvid(s: string): string | null {
  for (let i = 0; i + 12 <= s.length; i++) {
    if (s.charCodeAt(i) != 66 || s.charCodeAt(i + 1) != 86) continue; // B V
    let ok = true;
    for (let j = i + 2; j < i + 12; j++) {
      if (!isAsciiAlnum(s.charCodeAt(j))) {
        ok = false;
        break;
      }
    }
    if (ok) return s.substring(i, i + 12);
  }
  return null;
}

function isAsciiAlnum(c: i32): bool {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ---------------------------------------------------------------------------
// 异步状态机：nav → sign → 目标接口
// ---------------------------------------------------------------------------

class NavResult {
  ok: bool = true;
  code: string = "";
  message: string = "";
  detail: string = "";
}

abstract class WbiTask extends Task {
  /// 0=未发起 nav；1=等待 nav；2=等待目标请求。
  phase: i32 = 0;
  nav: HostCall | null = null;
  req: HostCall | null = null;
  mixinKey: string = "";
  wts: i64 = 0;

  /// 处理 nav 响应；失败时返回带 code/message 的结果。
  loadNav(raw: string): NavResult {
    const res = new NavResult();

    const out = decodeHttp(raw);
    if (out.invalid) {
      res.ok = false;
      res.code = "abi";
      res.message = "bad http result envelope";
      res.detail = raw;
      return res;
    }
    if (!out.ok) {
      res.ok = false;
      res.code = normalizeHostCode(out.hostCode);
      res.message = out.hostMessage;
      res.detail = raw;
      return res;
    }

    const date = headerValue(out.headers, "Date");
    if (date.length == 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "nav response missing Date header";
      return res;
    }
    const wts = httpDateToUnix(date);
    if (wts < 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "unparseable Date header: " + date;
      return res;
    }

    const v = parseJson(out.body);
    if (v == null) {
      res.ok = false;
      res.code = "plugin";
      res.message = "invalid JSON body";
      res.detail = out.body;
      return res;
    }

    const codeV = v.get("code");
    const code = codeV != null && codeV.isNumber() ? <i32>codeV.asNumber() : -1;
    const msgV = v.get("message");
    const msg = msgV != null ? msgV.asString() : "unknown";
    const wbi = child(child(v, "data"), "wbi_img");
    const imgV = child(wbi, "img_url");
    const imgUrl = imgV != null && imgV.isString() ? imgV.asString() : "";
    const subV = child(wbi, "sub_url");
    const subUrl = subV != null && subV.isString() ? subV.asString() : "";

    if (code != 0 && (imgUrl.length == 0 || subUrl.length == 0)) {
      res.ok = false;
      res.code = "plugin";
      res.message = "nav error: " + msg;
      return res;
    }
    if (code != 0) {
      // 差异点：匿名 nav 恒为 -101（账号未登录），但 wbi_img 完整可用。
      log(2, "[bili-wbi-ts] nav code " + code.toString() + " ignored: " + msg);
    }
    if (imgUrl.length == 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "nav: missing data.wbi_img.img_url";
      return res;
    }
    if (subUrl.length == 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "nav: missing data.wbi_img.sub_url";
      return res;
    }

    const imgKey = keyFromUrl(imgUrl);
    if (imgKey.length == 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "bad img_url: " + imgUrl;
      return res;
    }
    const subKey = keyFromUrl(subUrl);
    if (subKey.length == 0) {
      res.ok = false;
      res.code = "plugin";
      res.message = "bad sub_url: " + subUrl;
      return res;
    }

    this.mixinKey = deriveMixinKey(imgKey, subKey);
    this.wts = wts;
    return res;
  }

  startNav(): void {
    this.nav = httpGet(NAV_URL, HEADERS_JSON);
    this.phase = 1;
  }
}

class LatestTask extends Task {
  call: HostCall;

  constructor(url: string) {
    super();
    this.call = httpGet(url, HEADERS_JSON);
  }

  step(): string | null {
    const raw = this.call.poll();
    if (raw == null) return null;
    const out = decodeHttp(raw);
    if (out.invalid) return this.fail("abi", "bad http result envelope", raw);
    if (!out.ok) {
      return this.fail(normalizeHostCode(out.hostCode), out.hostMessage, raw);
    }
    const items = mapPopular(out.body);
    if (items == null) return this.fail("plugin", "invalid JSON body", out.body);
    return items;
  }
}

class SearchTask extends WbiTask {
  keyword: string;

  constructor(keyword: string) {
    super();
    this.keyword = keyword;
  }

  step(): string | null {
    if (this.phase == 0) {
      if (this.keyword.trim().length == 0) {
        return this.fail("plugin", "keyword required");
      }
      this.startNav();
      return null;
    }

    if (this.phase == 1) {
      const nav = this.nav;
      if (nav == null) return this.fail("abi", "nav call missing");
      const raw = nav.poll();
      if (raw == null) return null;
      const nr = this.loadNav(raw);
      if (!nr.ok) return this.fail(nr.code, nr.message, nr.detail);

      const keys: string[] = ["search_type", "keyword", "page"];
      const vals: string[] = ["video", this.keyword, "1"];
      const query = wbiSign(keys, vals, this.mixinKey, this.wts);
      const url =
        "https://api.bilibili.com/x/web-interface/wbi/search/type?" + query;
      log(0, "[bili-wbi-ts] signed url: " + url);
      this.req = httpGet(url, HEADERS_JSON);
      this.phase = 2;
      return null;
    }

    const req = this.req;
    if (req == null) return this.fail("abi", "search call missing");
    const raw = req.poll();
    if (raw == null) return null;
    const out = decodeHttp(raw);
    if (out.invalid) return this.fail("abi", "bad http result envelope", raw);
    if (!out.ok) {
      return this.fail(normalizeHostCode(out.hostCode), out.hostMessage, raw);
    }
    const body = parseBody(out.body);
    if (body.invalid) {
      return this.fail("plugin", "invalid JSON body", out.body);
    }
    if (body.code != 0) {
      return this.fail(
        "plugin",
        "bili search error " +
          body.code.toString() +
          ": " +
          body.message,
        out.body,
      );
    }
    return mapSearchResult(body.doc);
  }
}

class DetailTask extends Task {
  url: string;
  bvid: string = "";
  call: HostCall | null = null;

  constructor(url: string) {
    super();
    this.url = url;
  }

  step(): string | null {
    if (this.call == null) {
      const bvid = extractBvid(this.url);
      if (bvid == null) {
        return this.fail("plugin", "no bvid found in detail url: " + this.url);
      }
      this.bvid = bvid;
      this.call = httpGet(
        "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid,
        HEADERS_JSON,
      );
      return null;
    }

    const call = this.call;
    if (call == null) return this.fail("abi", "view call missing");
    const raw = call.poll();
    if (raw == null) return null;
    const out = decodeHttp(raw);
    if (out.invalid) return this.fail("abi", "bad http result envelope", raw);
    if (!out.ok) {
      return this.fail(normalizeHostCode(out.hostCode), out.hostMessage, raw);
    }
    const body = parseBody(out.body);
    if (body.invalid) {
      return this.fail("plugin", "invalid JSON body", out.body);
    }
    if (body.code != 0) {
      return this.fail(
        "plugin",
        "bili view error " + body.code.toString() + ": " + body.message,
        out.body,
      );
    }
    const data = child(body.doc, "data");
    if (data == null || !data.isObject()) {
      return this.fail("plugin", "bili view: missing data", out.body);
    }
    return mapDetail(this.bvid, data);
  }
}

class WatchTask extends WbiTask {
  encoded: string;
  bvid: string = "";
  cid: string = "";

  constructor(encoded: string) {
    super();
    this.encoded = encoded;
  }

  step(): string | null {
    if (this.phase == 0) {
      // 私有协议：{bvid}|{cid}|{page}
      const parts = this.encoded.split("|");
      if (parts.length != 3) {
        return this.fail(
          "plugin",
          "bili watch expects bvid|cid|page (obtain from detail)",
        );
      }
      const bvid = parts[0].trim();
      const cid = parts[1].trim();
      if (bvid.length == 0 || cid.length == 0) {
        return this.fail("plugin", "bili watch: empty bvid/cid");
      }
      this.bvid = bvid;
      this.cid = cid;
      this.startNav();
      return null;
    }

    if (this.phase == 1) {
      const nav = this.nav;
      if (nav == null) return this.fail("abi", "nav call missing");
      const raw = nav.poll();
      if (raw == null) return null;
      const nr = this.loadNav(raw);
      if (!nr.ok) return this.fail(nr.code, nr.message, nr.detail);

      // fnval=16 请求 dash；qn=80 为 1080P 上限内的常规档。
      const keys: string[] = [
        "bvid",
        "cid",
        "fnval",
        "fnver",
        "fourk",
        "qn",
        "platform",
      ];
      const vals: string[] = [
        this.bvid,
        this.cid,
        "16",
        "0",
        "1",
        "80",
        "pc",
      ];
      const query = wbiSign(keys, vals, this.mixinKey, this.wts);
      const url = "https://api.bilibili.com/x/player/wbi/playurl?" + query;
      log(0, "[bili-wbi-ts] signed playurl: " + url);
      this.req = httpGet(url, HEADERS_JSON);
      this.phase = 2;
      return null;
    }

    const req = this.req;
    if (req == null) return this.fail("abi", "playurl call missing");
    const raw = req.poll();
    if (raw == null) return null;
    const out = decodeHttp(raw);
    if (out.invalid) return this.fail("abi", "bad http result envelope", raw);
    if (!out.ok) {
      return this.fail(normalizeHostCode(out.hostCode), out.hostMessage, raw);
    }
    const body = parseBody(out.body);
    if (body.invalid) {
      return this.fail("plugin", "invalid JSON body", out.body);
    }
    if (body.code != 0) {
      return this.fail(
        "plugin",
        "bili playurl rejected (code " +
          body.code.toString() +
          "): " +
          body.message +
          " — source-side risk control commonly blocks datacenter IPs",
        out.body,
      );
    }

    const doc = body.doc;
    let direct = bestDashUrl(doc);
    if (direct.length == 0) {
      direct = fallbackDurlUrl(doc);
    }
    if (direct.length == 0) {
      return this.fail(
        "plugin",
        "bili playurl: no dash baseUrl and no durl fallback",
        out.body,
      );
    }
    return (
      '{"url":' +
      jsonQuote(direct) +
      ',"headers":{"Referer":' +
      jsonQuote(REFERER) +
      ',"User-Agent":' +
      jsonQuote(UA) +
      "}}"
    );
  }
}

/// data.dash.video 中 bandwidth 最大者的 baseUrl（或 base_url）；无则空串。
function bestDashUrl(doc: JsonValue): string {
  const data = child(doc, "data");
  const dash = child(data, "dash");
  const video = child(dash, "video");
  if (video == null || !video.isArray() || video.items.length == 0) return "";
  let best: JsonValue | null = null;
  let bestBw: f64 = -1;
  for (let i = 0; i < video.items.length; i++) {
    const e = video.items[i];
    if (!e.isObject()) continue;
    const bwV = e.get("bandwidth");
    const bw = bwV != null ? bwV.asNumber() : 0;
    // Rust max_by_key 在并列时取最后一个，这里用 >= 对齐。
    if (bw >= bestBw) {
      bestBw = bw;
      best = e;
    }
  }
  if (best == null) return "";
  let u = best.get("baseUrl");
  if (u == null) u = best.get("base_url");
  if (u == null) return "";
  return u.asString();
}

/// 回退 data.durl[0].url。
function fallbackDurlUrl(doc: JsonValue): string {
  const durl = child(child(doc, "data"), "durl");
  if (durl == null || !durl.isArray()) return "";
  const first = durl.at(0);
  if (first == null || !first.isObject()) return "";
  const u = first.get("url");
  if (u == null) return "";
  return u.asString();
}

// ---------------------------------------------------------------------------
// ABI 导出
// ---------------------------------------------------------------------------

export function latest(page: i32): i32 {
  const pn = page < 1 ? 1 : page;
  return spawn(
    new LatestTask(
      "https://api.bilibili.com/x/web-interface/popular?ps=20&pn=" +
        pn.toString(),
    ),
  );
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
