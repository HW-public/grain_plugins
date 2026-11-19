// 跨边界字符串工具：NUL 结尾 UTF-8 串的读写与 JSON 转义。

import { allocBytes } from "./heap";

const PAGE_SIZE: usize = 65536;

function memoryBytes(): usize {
  return (memory.size() as usize) << 16;
}

// 扫描 NUL，返回字节长度；指针非法时返回 0。
export function strLen(ptr: i32): i32 {
  if (ptr <= 0) return 0;
  const start = ptr as usize;
  const end = memoryBytes();
  if (start >= end) return 0;
  let n: usize = 0;
  while (start + n < end && load<u8>(start + n) != 0) n++;
  return n as i32;
}

// 读 NUL 结尾 UTF-8 串；指针非法或空串返回 ""。
export function readCstr(ptr: i32): string {
  const n = strLen(ptr);
  if (n == 0) return "";
  return String.UTF8.decodeUnsafe(ptr as usize, n as usize, false);
}

// 从 ABI 堆分配 len+1 并写入 NUL 结尾 UTF-8；失败返回 0。
export function writeCstr(s: string): i32 {
  const buf = String.UTF8.encode(s, false);
  const len = buf.byteLength;
  const ptr = allocBytes(len + 1);
  if (ptr == 0) return 0;
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  return ptr as i32;
}

const HEX: string = "0123456789abcdef";

// JSON 字符串内容转义（不含两侧引号）。
export function jsonEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) out += '\\"';
    else if (c == 92) out += "\\\\";
    else if (c == 8) out += "\\b";
    else if (c == 12) out += "\\f";
    else if (c == 10) out += "\\n";
    else if (c == 13) out += "\\r";
    else if (c == 9) out += "\\t";
    else if (c < 32) {
      out += "\\u00" + HEX.charAt((c >> 4) & 15) + HEX.charAt(c & 15);
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

// JSON 字符串字面量（含两侧引号）。
export function jsonQuote(s: string): string {
  return '"' + jsonEscape(s) + '"';
}

// ABI v0.2 错误信封，code 取 plugin|http|abi|fuel|timeout。
export function errorEnvelope(
  code: string,
  message: string,
  detail: string = "",
): string {
  let out = '{"code":' + jsonQuote(code) + ',"message":' + jsonQuote(message);
  if (detail.length > 0) out += ',"detail":' + jsonQuote(detail);
  out += "}";
  return out;
}
