// HTTP Date 头 → Unix 秒。wasm 内无时钟，插件只能从响应的 Date 头取时间。
// 支持 RFC 1123 形态 "Wed, 18 Nov 2026 07:53:00 GMT"；星期可任意或省略。
// 纯算术 days_from_civil（Howard Hinnant 算法），正确覆盖闰年。

function isWs(c: i32): bool {
  return c == 32 || c == 9 || c == 10 || c == 13;
}

function parseUnsignedDigits(s: string): i32 {
  if (s.length == 0) return -1;
  let v: i32 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
    if (v > 100000000) return -1;
  }
  return v;
}

/// 1 月 → 1，…，12 月 → 12；无法识别返回 -1。
function monthFromToken(tok: string): i32 {
  if (tok.length < 3) return -1;
  const m = tok.substring(0, 3);
  if (m == "Jan") return 1;
  if (m == "Feb") return 2;
  if (m == "Mar") return 3;
  if (m == "Apr") return 4;
  if (m == "May") return 5;
  if (m == "Jun") return 6;
  if (m == "Jul") return 7;
  if (m == "Aug") return 8;
  if (m == "Sep") return 9;
  if (m == "Oct") return 10;
  if (m == "Nov") return 11;
  if (m == "Dec") return 12;
  return -1;
}

/// days since 1970-01-01（Hinnant days_from_civil）。
function daysFromCivil(y: i64, m: i64, d: i64): i64 {
  const yy: i64 = m <= 2 ? y - 1 : y;
  const era: i64 = (yy >= 0 ? yy : yy - 399) / 400;
  const yoe: i64 = yy - era * 400;
  const mp: i64 = (m + 9) % 12;
  const doy: i64 = (153 * mp + 2) / 5 + d - 1;
  const doe: i64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

/// 解析 RFC 1123 日期为 Unix 秒；非法输入返回 -1。
export function httpDateToUnix(s: string): i64 {
  let start = 0;
  const comma = s.indexOf(",");
  if (comma >= 0) start = comma + 1;

  const tokens: string[] = [];
  let i = start;
  while (i < s.length) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (i >= s.length) break;
    const begin = i;
    while (i < s.length && !isWs(s.charCodeAt(i))) i++;
    tokens.push(s.substring(begin, i));
  }
  if (tokens.length < 4) return -1;

  const day = parseUnsignedDigits(tokens[0]);
  const month = monthFromToken(tokens[1]);
  const year = parseUnsignedDigits(tokens[2]);
  if (day < 1 || day > 31) return -1;
  if (month < 1) return -1;
  if (year < 0) return -1;

  const hms = tokens[3];
  const c1 = hms.indexOf(":");
  if (c1 < 0) return -1;
  const c2 = hms.indexOf(":", c1 + 1);
  if (c2 < 0) return -1;
  if (hms.indexOf(":", c2 + 1) >= 0) return -1;
  const h = parseUnsignedDigits(hms.substring(0, c1));
  const mi = parseUnsignedDigits(hms.substring(c1 + 1, c2));
  const sec = parseUnsignedDigits(hms.substring(c2 + 1));
  if (h < 0 || h > 23) return -1;
  if (mi < 0 || mi > 59) return -1;
  if (sec < 0 || sec > 59) return -1;

  const days = daysFromCivil(<i64>year, <i64>month, <i64>day);
  return days * 86400 + <i64>h * 3600 + <i64>mi * 60 + <i64>sec;
}
