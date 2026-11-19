// AS 工具库自检插件：独立实现最小 ABI（不依赖 PDK 核心），
// latest(page) 内联执行全部断言，结果为 JSON 数组字符串。
// 构建：npx asc selftest/selftest.ts --outFile selftest/selftest.wasm
//        --optimize --use abort=src/abort/abort

import { JsonValue, parseJson, stringifyJson, escapeJsonString } from "../src/util/json";
import { md5Hex } from "../src/util/md5";
import { base64Encode } from "../src/util/base64";
import { urlencode } from "../src/util/urlencode";
import { httpDateToUnix } from "../src/util/httpdate";
import { abort } from "../src/abort";

const ARENA_SIZE: usize = 65536;
let arena = new StaticArray<u8>(65536);
let arenaUsed: usize = 0;

function arenaAlloc(len: usize): usize {
  const ptr = arenaUsed;
  if (ptr + len > ARENA_SIZE) return 0;
  arenaUsed += len;
  return changetype<usize>(arena) + ptr;
}

function writeCstr(s: string): i32 {
  const buf = String.UTF8.encode(s, false);
  const len = buf.byteLength;
  const ptr = arenaAlloc(len + 1);
  if (ptr == 0) return 0;
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  return <i32>ptr;
}

const META: string =
  '{"name":"AS工具库自检","version":"v0.0.1","type":"selftest","package":"selftest.as","author":"grain","lang":"zh-cn","webSite":"","nsfw":false}';

export function metadata_json(): i32 {
  return writeCstr(META);
}

const report: string[] = [];

function add(name: string, ok: bool): void {
  report.push(
    '{"name":"' + escapeJsonString(name) + '","ok":' + (ok ? "true" : "false") + "}",
  );
}

function jsonParseValuesOk(): bool {
  const doc = parseJson('{"a":[1,"b",true,null],"c":{"d":"e\\n"}}');
  if (doc == null) return false;
  const a = doc.get("a");
  const c = doc.get("c");
  if (a == null || c == null) return false;
  if (!a.isArray() || a.length != 4) return false;
  const i0 = a.at(0);
  const i1 = a.at(1);
  const i2 = a.at(2);
  const i3 = a.at(3);
  if (i0 == null || i1 == null || i2 == null || i3 == null) return false;
  if (i0.asNumber() != 1) return false;
  if (i1.asString() != "b") return false;
  if (!i2.asBool()) return false;
  if (!i3.isNull()) return false;
  const d = c.get("d");
  if (d == null) return false;
  return d.asString() == "e\n";
}

function jsonRoundtripOk(): bool {
  const src = '{"a":[1,"b",true,null],"c":{"d":"e\\n"}}';
  const doc = parseJson(src);
  if (doc == null) return false;
  return stringifyJson(doc) == src;
}

function jsonEscapeRoundtripOk(): bool {
  const original = 'he said "hi"\n中文\\path\t!';
  const encoded = stringifyJson(JsonValue.ofString(original));
  const back = parseJson(encoded);
  if (back == null) return false;
  return back.asString() == original;
}

function jsonUnicodeEscapeOk(): bool {
  const v = parseJson('"\\u4e2d\\u6587"');
  if (v == null) return false;
  return v.asString() == "中文";
}

function jsonInvalidOk(): bool {
  return parseJson("{") == null &&
    parseJson("") == null &&
    parseJson("{}x") == null &&
    parseJson("[1,]") == null &&
    parseJson("tru") == null;
}

function buildReport(): string {
  add("md5_empty", md5Hex("") == "d41d8cd98f00b204e9800998ecf8427e");
  add("md5_abc", md5Hex("abc") == "900150983cd24fb0d6963f7d28e17f72");
  add(
    "md5_message_digest",
    md5Hex("message digest") == "f96b697d7cb7938d525a2f31aaf161d0",
  );
  add("md5_bilibili", md5Hex("Bilibili") == "fb5bebe1b7df48e6606fdffed2cf8b14");
  add(
    "md5_long_blocks",
    md5Hex(
      "search_type=video&keyword=test&page=1&wts=1700000000ea1dc1234abcd5678efgh",
    ) == "e5fdbab426a21762f872ac04ef67dee8",
  );

  add("base64_empty", base64Encode("") == "");
  add("base64_grain", base64Encode("grain") == "Z3JhaW4=");
  add("base64_rfc_vectors", base64Encode("f") == "Zg==" && base64Encode("fo") == "Zm8=" && base64Encode("foobar") == "Zm9vYmFy");
  add("base64_utf8", base64Encode("中文") == "5Lit5paH");

  add("urlencode_utf8", urlencode("测试") == "%E6%B5%8B%E8%AF%95");
  add("urlencode_unreserved", urlencode("a b~") == "a%20b~");
  add("urlencode_reserved", urlencode("a b&c=d") == "a%20b%26c%3Dd");
  add("urlencode_specials", urlencode("!'()*") == "%21%27%28%29%2A");

  const known = httpDateToUnix("Wed, 18 Nov 2026 07:53:00 GMT");
  // 07:53:00 UTC → 7*3600 + 53*60 = 28380（与 hash.rs 的 Rust 测试同一表达式）。
  add("httpdate_known", known % 86400 == 7 * 3600 + 53 * 60);
  // 精确值由 Python datetime 对照（2026-11-18T07:53:00Z）。
  add("httpdate_exact", known == 1794988380);
  // 星期可省略：无 "Wed," 前缀同样解析。
  add("httpdate_no_weekday", httpDateToUnix("18 Nov 2026 07:53:00 GMT") == 1794988380);
  add("httpdate_epoch", httpDateToUnix("Thu, 01 Jan 1970 00:00:00 GMT") == 0);
  add(
    "httpdate_leap_day",
    httpDateToUnix("Tue, 29 Feb 2000 12:00:00 GMT") == 951825600,
  );
  add("httpdate_invalid", httpDateToUnix("") == -1 && httpDateToUnix("nope") == -1);

  add("json_parse_values", jsonParseValuesOk());
  add("json_roundtrip", jsonRoundtripOk());
  add("json_escape_roundtrip", jsonEscapeRoundtripOk());
  add("json_escape_function", escapeJsonString('a"b\n') == 'a\\"b\\n');
  add("json_unicode_escape", jsonUnicodeEscapeOk());
  add("json_invalid", jsonInvalidOk());

  return "[" + report.join(",") + "]";
}

let resultPtr: i32 = 0;
const REPORT_HANDLE: i32 = 0x40000001;

export function latest(page: i32): i32 {
  if (resultPtr == 0) resultPtr = writeCstr(buildReport());
  return REPORT_HANDLE;
}

export function take_result(handle: i32): i32 {
  if (handle == REPORT_HANDLE) return resultPtr;
  return 0;
}

export function last_error(): i32 {
  return 0;
}

export function free_result(ptr: i32): void {}

export function alloc(len: i32): i32 {
  return <i32>arenaAlloc(len < 0 ? 0 : <usize>len);
}

export function dealloc(ptr: i32, len: i32): void {}
