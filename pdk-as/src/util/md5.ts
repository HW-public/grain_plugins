// RFC 1321 MD5（纯 u32 运算，无动态特性），逐行移植自
// grain_engine/pdk/rust/crates/pdk/src/hash.rs 的 md5_hex。

const MD5_S: usize = memory.data<u8>([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_K: usize = memory.data<u32>([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const HEX_LOWER_MD5: string = "0123456789abcdef";

function rotl32(x: u32, n: u32): u32 {
  return (x << n) | (x >>> (32 - n));
}

function wordHexLE(v: u32, out: i32[]): void {
  for (let i = 0; i < 4; i++) {
    const b = (v >>> (<u32>(i << 3))) & 0xff;
    out.push(HEX_LOWER_MD5.charCodeAt((b >> 4) & 15));
    out.push(HEX_LOWER_MD5.charCodeAt(b & 15));
  }
}

/// 对 UTF-8 编码后的字符串求 MD5，输出 32 字符小写 hex。
export function md5Hex(s: string): string {
  const data = Uint8Array.wrap(String.UTF8.encode(s, false));
  const len = data.length;
  const total = (((len + 8) >>> 6) + 1) << 6;

  const padded = new Uint8Array(total);
  for (let i = 0; i < len; i++) padded[i] = data[i];
  padded[len] = 0x80;
  const bl: u64 = <u64>len << 3;
  for (let i = 0; i < 8; i++) {
    padded[total - 8 + i] = <u8>((bl >>> (<u64>(i << 3))) & 0xff);
  }

  let a0: u32 = 0x67452301;
  let b0: u32 = 0xefcdab89;
  let c0: u32 = 0x98badcfe;
  let d0: u32 = 0x10325476;

  const m = new StaticArray<u32>(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const p = off + (i << 2);
      m[i] =
        (<u32>padded[p]) |
        (<u32>padded[p + 1] << 8) |
        (<u32>padded[p + 2] << 16) |
        (<u32>padded[p + 3] << 24);
    }

    let aa = a0;
    let bb = b0;
    let cc = c0;
    let dd = d0;

    for (let i = 0; i < 64; i++) {
      let f: u32;
      let g: i32;
      const r = i >> 4;
      if (r == 0) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (r == 1) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) & 15;
      } else if (r == 2) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) & 15;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) & 15;
      }
      const tmp = f + aa + load<u32>(MD5_K + (<usize>(i << 2))) + m[g];
      aa = dd;
      dd = cc;
      cc = bb;
      bb = bb + rotl32(tmp, <u32>load<u8>(MD5_S + (<usize>i)));
    }

    a0 = a0 + aa;
    b0 = b0 + bb;
    c0 = c0 + cc;
    d0 = d0 + dd;
  }

  const out: i32[] = [];
  wordHexLE(a0, out);
  wordHexLE(b0, out);
  wordHexLE(c0, out);
  wordHexLE(d0, out);
  return String.fromCharCodes(out);
}
