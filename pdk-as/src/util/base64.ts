// 标准 Base64 编码（A-Z a-z 0-9 + /，'=' 填充）。
// 语义与 Rust `base64_encode` 一致：入参按 UTF-8 字节编码。

const B64_TBL: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(s: string): string {
  const data = Uint8Array.wrap(String.UTF8.encode(s, false));
  const len = data.length;
  if (len == 0) return "";

  const units: i32[] = [];
  for (let i = 0; i < len; i += 3) {
    const has1 = i + 1 < len;
    const has2 = i + 2 < len;
    const b0 = <u32>data[i];
    const b1: u32 = has1 ? <u32>data[i + 1] : 0;
    const b2: u32 = has2 ? <u32>data[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    units.push(B64_TBL.charCodeAt((n >>> 18) & 63));
    units.push(B64_TBL.charCodeAt((n >>> 12) & 63));
    units.push(has1 ? B64_TBL.charCodeAt((n >>> 6) & 63) : 61);
    units.push(has2 ? B64_TBL.charCodeAt(n & 63) : 61);
  }
  return String.fromCharCodes(units);
}
