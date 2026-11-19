// 宿主能力声明与异步桥包装。
//
// 宿主 import 全部同步：发起调用拿 handle，之后由宿主 pump 反复推进
// take_result；guest 在每次 step 里调 HostCall.poll() 同步取结果。

import { allocBytes, freeBytes } from "./heap";
import { errorEnvelope, jsonQuote } from "./strings";

@external("grain", "grain_log")
declare function grain_log(level: i32, ptr: i32, len: i32): void;

@external("grain", "grain_http_request")
declare function grain_http_request(ptr: i32, len: i32): i32;

@external("grain", "grain_xpath_query")
declare function grain_xpath_query(
  htmlPtr: i32,
  htmlLen: i32,
  xpathPtr: i32,
  xpathLen: i32,
): i32;

@external("grain", "grain_crypto_md5")
declare function grain_crypto_md5(ptr: i32, len: i32): i32;

@external("grain", "grain_crypto_base64_encode")
declare function grain_crypto_base64_encode(ptr: i32, len: i32): i32;

@external("grain", "grain_event_wait")
declare function grain_event_wait(handle: i32, bufPtr: i32, bufCap: i32): i32;

const INITIAL_CAP: i32 = 4096;
const MAX_CAP: i32 = 1048576;

/// 一次宿主调用的句柄 + 接收缓冲。
/// poll() 语义：null=未完成；字符串=响应 JSON（可能是错误信封）。
export class HostCall {
  handle: i32;
  private buf: StaticArray<u8>;

  constructor(handle: i32) {
    this.handle = handle;
    this.buf = new StaticArray<u8>(INITIAL_CAP);
  }

  poll(): string | null {
    if (this.handle <= 0) {
      return errorEnvelope("abi", "invalid host handle", this.handle.toString());
    }
    let cap = this.buf.length;
    while (true) {
      const n = grain_event_wait(
        this.handle,
        changetype<usize>(this.buf) as i32,
        cap,
      );
      if (n == -1) {
        // buf 太小：翻倍重试，上限 1 MiB。
        if (cap >= MAX_CAP) {
          return errorEnvelope("abi", "host response exceeds 1 MiB");
        }
        cap = cap * 2 > MAX_CAP ? MAX_CAP : cap * 2;
        this.buf = new StaticArray<u8>(cap);
        continue;
      }
      if (n == 0) return null;
      if (n == -2) {
        return errorEnvelope("abi", "unknown or expired host handle");
      }
      if (n < 0) {
        return errorEnvelope("abi", "grain_event_wait failed", n.toString());
      }
      // 宿主只写 n 字节，不保证 NUL：按字节数精确解码。
      return String.UTF8.decodeUnsafe(
        changetype<usize>(this.buf),
        n as usize,
        false,
      );
    }
  }
}

// 把字符串编码进 ABI 堆，调用 import，随后立即释放参数缓冲
// （import 同步读取参数，句柄持有的是宿主侧拷贝）。
function callWithString(s: string, kind: i32): i32 {
  const buf = String.UTF8.encode(s, false);
  const len = buf.byteLength;
  const ptr = allocBytes(len + 1);
  if (ptr == 0) return 0;
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  let handle: i32 = 0;
  if (kind == 0) handle = grain_http_request(ptr as i32, len);
  else if (kind == 1) handle = grain_crypto_md5(ptr as i32, len);
  else handle = grain_crypto_base64_encode(ptr as i32, len);
  freeBytes(ptr);
  return handle;
}

function buildRequest(
  method: string,
  url: string,
  headersJson: string,
  body: string,
): string {
  const headers = headersJson.length == 0 ? "{}" : headersJson;
  return (
    '{"url":' +
    jsonQuote(url) +
    ',"method":' +
    jsonQuote(method) +
    ',"headers":' +
    headers +
    ',"body":' +
    jsonQuote(body) +
    "}"
  );
}

export function httpRequest(
  method: string,
  url: string,
  headersJson: string,
  body: string,
): HostCall {
  const req = buildRequest(method, url, headersJson, body);
  const buf = String.UTF8.encode(req, false);
  const len = buf.byteLength;
  const ptr = allocBytes(len + 1);
  if (ptr == 0) return new HostCall(0);
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  const handle = grain_http_request(ptr as i32, len);
  freeBytes(ptr);
  return new HostCall(handle);
}

export function httpGet(url: string, headersJson: string = "{}"): HostCall {
  return httpRequest("GET", url, headersJson, "");
}

export function xpathQuery(html: string, xpath: string): HostCall {
  const htmlBuf = String.UTF8.encode(html, false);
  const xpathBuf = String.UTF8.encode(xpath, false);
  const htmlLen = htmlBuf.byteLength;
  const xpathLen = xpathBuf.byteLength;
  const htmlPtr = allocBytes(htmlLen + 1);
  const xpathPtr = allocBytes(xpathLen + 1);
  if (htmlPtr == 0 || xpathPtr == 0) {
    if (htmlPtr != 0) freeBytes(htmlPtr);
    if (xpathPtr != 0) freeBytes(xpathPtr);
    return new HostCall(0);
  }
  memory.copy(htmlPtr, changetype<usize>(htmlBuf), htmlLen);
  store<u8>(htmlPtr + htmlLen, 0);
  memory.copy(xpathPtr, changetype<usize>(xpathBuf), xpathLen);
  store<u8>(xpathPtr + xpathLen, 0);
  const handle = grain_xpath_query(
    htmlPtr as i32,
    htmlLen,
    xpathPtr as i32,
    xpathLen,
  );
  freeBytes(htmlPtr);
  freeBytes(xpathPtr);
  return new HostCall(handle);
}

/// level: 0=debug 1=info 2=warn 3=error
export function log(level: i32, msg: string): void {
  const buf = String.UTF8.encode(msg, false);
  const len = buf.byteLength;
  const ptr = allocBytes(len + 1);
  if (ptr == 0) return;
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  grain_log(level, ptr as i32, len);
  freeBytes(ptr);
}

export function md5Hex(s: string): HostCall {
  return new HostCall(callWithString(s, 1));
}

export function base64Encode(s: string): HostCall {
  return new HostCall(callWithString(s, 2));
}
