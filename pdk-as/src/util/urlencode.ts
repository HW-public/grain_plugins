// RFC 3986 percent 编码：仅保留 unreserved 字符（A-Z a-z 0-9 - _ . ~），
// 其余按 UTF-8 字节写成大写 hex 的 %XX。与 Rust `urlencode` 一致
// （等价 encodeURIComponent 去掉 [!'()*] 的保留行为）。

const HEX_UPPER: string = "0123456789ABCDEF";

export function urlencode(s: string): string {
  const data = Uint8Array.wrap(String.UTF8.encode(s, false));
  const units: i32[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = <i32>data[i];
    const keep =
      (b >= 48 && b <= 57) ||
      (b >= 65 && b <= 90) ||
      (b >= 97 && b <= 122) ||
      b == 45 || // -
      b == 95 || // _
      b == 46 || // .
      b == 126; // ~
    if (keep) {
      units.push(b);
    } else {
      units.push(37); // %
      units.push(HEX_UPPER.charCodeAt((b >> 4) & 15));
      units.push(HEX_UPPER.charCodeAt(b & 15));
    }
  }
  return String.fromCharCodes(units);
}
