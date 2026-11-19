// 360资源（360zy.com）API 型插件 —— Rust 原版的 AssemblyScript 移植。
// 行为权威：grain_engine/pdk/rust/plugins/360zy/src/lib.rs

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
import { JsonValue, parseJson, stringifyJson } from "../../../pdk-as/src/util/json";
import { urlencode } from "../../../pdk-as/src/util/urlencode";
import { httpDateToUnix } from "../../../pdk-as/src/util/httpdate";

// 把 ABI 导出（alloc/dealloc/metadata_json/take_result/last_error/
// free_result）带进 wasm。
export * from "../../../pdk-as/src/index";

setMeta(
  '{"name":"360资源 (TS)","version":"v0.0.2","type":"bangumi","package":"360zy.com.ts","author":"hualiong","lang":"zh-cn","webSite":"https://360zy.com","nsfw":false}',
);

/// JS 基线版用自定义头做多域名并发竞速，WASM 宿主里没有对应物，这里串行故障转移。
const DOMAINS: string[] = [
  "360zy.com",
  "360zy.net",
  "360zy.top",
  "360zy.tv",
  "360zy1.com",
  "360zy2.com",
  "360zy3.com",
];

/// maccms `h` 参数（按更新小时过滤，JS 版恒带）。
/// wasm 内无时钟，从 HTTP 响应 Date 头推导（东九区小时，0 归一为 24），缓存复用。
let CACHED_H: i32 = -1;

function startsWithJsonObject(s: string): bool {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 32 || c == 9 || c == 10 || c == 13) continue;
    return c == 123; // {
  }
  return false;
}

function pad2(n: i32): string {
  return n < 10 ? "0" + n.toString() : n.toString();
}

/// maccms `vod_play_url` 形如 `第01集$http://a#第02集$http://b`
/// （多播放源以 `$$$` 分隔，这里取第一个源）。
function parsePlayUrl(raw: string): JsonValue[] {
  const out: JsonValue[] = [];
  let sep = raw.indexOf("$$$");
  const src = sep < 0 ? raw : raw.substring(0, sep);

  let start = 0;
  while (start <= src.length) {
    let end = src.indexOf("#", start);
    const last = end < 0;
    if (last) end = src.length;
    const item = src.substring(start, end).trim();
    if (item.length > 0) {
      const dollar = item.indexOf("$");
      let title: string;
      let url: string;
      if (dollar < 0) {
        title = "";
        url = item;
      } else {
        title = item.substring(0, dollar).trim();
        url = item.substring(dollar + 1).trim();
      }
      if (url.length > 0) {
        if (title.length == 0) title = "第" + pad2(out.length + 1) + "集";
        out.push(JsonValue.ofObject(["title", "url"], [
          JsonValue.ofString(title),
          JsonValue.ofString(url),
        ]));
      }
    }
    if (last) break;
    start = end + 1;
  }
  return out;
}

/// v 为 maccms 响应体，映射 list → [{"title","url","cover","update"}]。
function mapList(v: JsonValue): string | null {
  const list = v.get("list");
  let out = "[";
  let first = true;
  if (list != null && list.isArray()) {
    for (let i = 0; i < list.length; i++) {
      const e = list.at(i);
      if (e == null) continue;
      const nameV = e.get("vod_name");
      if (nameV == null || !nameV.isString()) continue;
      const idV = e.get("vod_id");
      let id = "";
      if (idV != null && idV.isNumber()) {
        id = idV.numRaw.length > 0 ? idV.numRaw : idV.asNumber().toString();
      } else if (idV != null && idV.isString()) {
        id = idV.asString();
      } else {
        continue;
      }
      const picV = e.get("vod_pic");
      const remV = e.get("vod_remarks");
      const cover = picV != null && picV.isString() ? picV.asString() : "";
      const update = remV != null && remV.isString() ? remV.asString() : "";
      if (!first) out += ",";
      first = false;
      out +=
        '{"title":' + jsonQuote(nameV.asString()) +
        ',"url":' + jsonQuote(id) +
        ',"cover":' + jsonQuote(cover) +
        ',"update":' + jsonQuote(update) + "}";
    }
  }
  return out + "]";
}

function entryStr(entry: JsonValue | null, key: string): string {
  if (entry == null) return "";
  const v = entry.get(key);
  return v != null && v.isString() ? v.asString() : "";
}

function mapDetail(v: JsonValue, id: string): string {
  let entry: JsonValue | null = null;
  const list = v.get("list");
  if (list != null && list.isArray() && list.length > 0) entry = list.at(0);

  const content = entryStr(entry, "vod_content");
  const description = content.trim().length > 0
    ? content
    : entryStr(entry, "vod_blurb");
  const episodes = entry != null
    ? parsePlayUrl(entryStr(entry, "vod_play_url"))
    : new Array<JsonValue>();
  const name = entryStr(entry, "vod_name");
  const title = name.length > 0 ? name : "vod " + id;

  return (
    '{"title":' + jsonQuote(title) +
    ',"cover":' + jsonQuote(entryStr(entry, "vod_pic")) +
    ',"description":' + jsonQuote(description) +
    ',"episodes":' + stringifyJson(JsonValue.ofArray(episodes)) +
    "}"
  );
}

function maybeCacheH(date: string): void {
  if (date.length == 0) return;
  const unix = httpDateToUnix(date);
  if (unix < 0) return;
  const SEC_PER_HOUR: i64 = 3600;
  const hourUtc: i64 = (unix / SEC_PER_HOUR) % 24;
  let h: i64 = (hourUtc + 9) % 24;
  if (h == 0) h = 24;
  CACHED_H = <i32>h;
}

/// 7 域名串行故障转移：响应 200 且 body 以 { 开头才算成功。
/// 每次 step 最多推进一个 HostCall。
abstract class VodFetchTask extends Task {
  attempt: i32 = 0;
  call: HostCall | null = null;
  lastErr: string = "no domain attempted";
  params: string = "";

  constructor(params: string) {
    super();
    this.params = params;
  }

  abstract handleSuccess(body: string, date: string): string;

  /// 发起当前 attempt 的请求；域名耗尽则进入错误终态。
  /// 宿主泵要求：step() 返回 null 时必须有尚未完成的宿主调用，因此失败
  /// 转移必须在同一次 step 内就把下一个请求发出去。
  startNext(): string | null {
    if (this.attempt >= DOMAINS.length) {
      return this.fail(
        "plugin",
        "all 360zy domains failed, last: " + this.lastErr,
      );
    }
    const domain = DOMAINS[this.attempt];
    this.call = httpGet(
      "https://" + domain + "/api.php/provide/vod?ac=detail" + this.params,
    );
    return null;
  }

  step(): string | null {
    if (this.call == null) return this.startNext();

    const call = this.call!;
    const resp = call.poll();
    if (resp == null) return null;
    this.call = null;

    const domain = DOMAINS[this.attempt];
    const v = parseJson(resp);
    if (v == null) {
      this.lastErr = domain + ": invalid response";
      log(2, "[360zy] " + this.lastErr);
      this.attempt++;
      return this.startNext();
    }

    const codeV = v.get("code");
    if (codeV != null) {
      const msgV = v.get("message");
      this.lastErr = domain + ": " +
        (msgV != null && msgV.isString() ? msgV.asString() : codeV.asString());
      log(2, "[360zy] " + this.lastErr);
      this.attempt++;
      return this.startNext();
    }

    const statusV = v.get("status");
    const bodyV = v.get("body");
    const status = statusV != null && statusV.isNumber()
      ? <i32>statusV.asNumber()
      : -1;
    const body = bodyV != null && bodyV.isString() ? bodyV.asString() : "";
    if (status != 200 || !startsWithJsonObject(body)) {
      this.lastErr = domain + ": HTTP " + status.toString();
      log(2, "[360zy] " + this.lastErr);
      this.attempt++;
      return this.startNext();
    }

    let date = "";
    const headers = v.get("headers");
    if (headers != null) {
      let d = headers.get("Date");
      if (d == null) d = headers.get("date");
      if (d != null && d.isString()) date = d.asString();
    }
    return this.handleSuccess(body, date);
  }
}

class LatestTask extends VodFetchTask {
  page: i32;

  constructor(page: i32) {
    let params = "&pg=" + page.toString();
    if (CACHED_H > 0) params += "&h=" + CACHED_H.toString();
    super(params);
    this.page = page;
  }

  handleSuccess(body: string, date: string): string {
    maybeCacheH(date);
    const v = parseJson(body);
    if (v == null) return this.fail("plugin", "invalid maccms response")!;
    const out = mapList(v);
    if (out == null) return this.fail("plugin", "invalid maccms response")!;
    return out;
  }
}

class SearchTask extends VodFetchTask {
  kw: string;

  constructor(kw: string) {
    let params: string;
    if (kw.trim().length == 0) {
      // ABI v0 的 search 没有 page，空白关键词按 latest(1) 处理。
      params = "&pg=1";
      if (CACHED_H > 0) params += "&h=" + CACHED_H.toString();
    } else {
      params = "&wd=" + urlencode(kw) + "&pg=1";
    }
    super(params);
    this.kw = kw;
  }

  handleSuccess(body: string, date: string): string {
    // 空白关键词在 Rust 版里直接复用 do_latest(1)，会顺带刷新 h 缓存。
    if (this.kw.trim().length == 0) maybeCacheH(date);
    const v = parseJson(body);
    if (v == null) return this.fail("plugin", "invalid maccms response")!;
    const out = mapList(v);
    if (out == null) return this.fail("plugin", "invalid maccms response")!;
    return out;
  }
}

class DetailTask extends VodFetchTask {
  id: string;

  constructor(id: string) {
    super("&ids=" + urlencode(id));
    this.id = id;
  }

  step(): string | null {
    if (this.id.length == 0) {
      return this.fail("plugin", "detail url (vod_id) required");
    }
    return super.step();
  }

  handleSuccess(body: string, date: string): string {
    const v = parseJson(body);
    if (v == null) return this.fail("plugin", "invalid maccms response")!;
    return mapDetail(v, this.id);
  }
}

class WatchTask extends Task {
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  step(): string | null {
    if (this.url.length == 0) {
      return this.fail("plugin", "watch url required");
    }
    // maccms 的播放地址即直链；非 http 开头（如解析页链接）也原样返回。
    return '{"url":' + jsonQuote(this.url) + "}";
  }
}

export function latest(page: i32): i32 {
  return spawn(new LatestTask(page));
}

export function search(kwPtr: i32): i32 {
  const kw = readCstr(kwPtr);
  return spawn(new SearchTask(kw));
}

export function detail(urlPtr: i32): i32 {
  const id = readCstr(urlPtr).trim();
  return spawn(new DetailTask(id));
}

export function watch(urlPtr: i32): i32 {
  const url = readCstr(urlPtr).trim();
  return spawn(new WatchTask(url));
}
