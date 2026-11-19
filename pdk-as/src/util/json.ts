// 极简 JSON 解析/序列化（UTF-8 字符串，非流式）。
// 插件运行在 wasm 内，无第三方依赖，这里按 RFC 8259 支持 object/array/
// string/number/bool/null 与 \uXXXX 转义；非法输入 parseJson 返回 null。

const TAG_NULL: i32 = 0;
const TAG_BOOL: i32 = 1;
const TAG_NUMBER: i32 = 2;
const TAG_STRING: i32 = 3;
const TAG_ARRAY: i32 = 4;
const TAG_OBJECT: i32 = 5;

const HEX_LOWER: string = "0123456789abcdef";

function isDigit(c: i32): bool {
  return c >= 48 && c <= 57;
}

function hexUnit(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/// JSON 值节点。数组用 items；对象用 keys/vals（保持插入顺序）。
export class JsonValue {
  tag: i32;
  boolValue: bool = false;
  numValue: f64 = 0;
  /// 解析得到的数字原始文本，序列化时原样回写（避免 f64 格式化丢精度）。
  numRaw: string = "";
  strValue: string = "";
  items: JsonValue[] = [];
  keys: string[] = [];
  vals: JsonValue[] = [];

  constructor(tag: i32) {
    this.tag = tag;
  }

  static nullValue(): JsonValue {
    return new JsonValue(TAG_NULL);
  }

  static ofBool(v: bool): JsonValue {
    const out = new JsonValue(TAG_BOOL);
    out.boolValue = v;
    return out;
  }

  static ofNumber(v: f64): JsonValue {
    const out = new JsonValue(TAG_NUMBER);
    out.numValue = v;
    return out;
  }

  static ofString(v: string): JsonValue {
    const out = new JsonValue(TAG_STRING);
    out.strValue = v;
    return out;
  }

  static ofArray(items: JsonValue[]): JsonValue {
    const out = new JsonValue(TAG_ARRAY);
    out.items = items;
    return out;
  }

  static ofObject(keys: string[], vals: JsonValue[]): JsonValue {
    const out = new JsonValue(TAG_OBJECT);
    out.keys = keys;
    out.vals = vals;
    return out;
  }

  isNull(): bool {
    return this.tag == TAG_NULL;
  }

  isBool(): bool {
    return this.tag == TAG_BOOL;
  }

  isNumber(): bool {
    return this.tag == TAG_NUMBER;
  }

  isString(): bool {
    return this.tag == TAG_STRING;
  }

  isArray(): bool {
    return this.tag == TAG_ARRAY;
  }

  isObject(): bool {
    return this.tag == TAG_OBJECT;
  }

  get length(): i32 {
    if (this.tag == TAG_ARRAY) return this.items.length;
    if (this.tag == TAG_OBJECT) return this.keys.length;
    if (this.tag == TAG_STRING) return this.strValue.length;
    return 0;
  }

  /// 对象取键；不存在或类型不符返回 null。
  get(key: string): JsonValue | null {
    if (this.tag != TAG_OBJECT) return null;
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] == key) return this.vals[i];
    }
    return null;
  }

  has(key: string): bool {
    return this.get(key) != null;
  }

  /// 数组按下标取；越界或类型不符返回 null。
  at(i: i32): JsonValue | null {
    if (this.tag != TAG_ARRAY || i < 0 || i >= this.items.length) return null;
    return this.items[i];
  }

  asString(): string {
    return this.tag == TAG_STRING ? this.strValue : "";
  }

  asNumber(): f64 {
    return this.tag == TAG_NUMBER ? this.numValue : 0;
  }

  asBool(): bool {
    return this.tag == TAG_BOOL ? this.boolValue : false;
  }
}

class JsonParser {
  src: string;
  pos: i32 = 0;
  len: i32;

  constructor(src: string) {
    this.src = src;
    this.len = src.length;
  }

  parse(): JsonValue | null {
    this.skipWs();
    const v = this.parseValue();
    if (v == null) return null;
    this.skipWs();
    if (this.pos != this.len) return null;
    return v;
  }

  skipWs(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c == 32 || c == 9 || c == 10 || c == 13) this.pos++;
      else break;
    }
  }

  parseValue(): JsonValue | null {
    this.skipWs();
    if (this.pos >= this.len) return null;
    const c = this.src.charCodeAt(this.pos);
    if (c == 123) return this.parseObject(); // {
    if (c == 91) return this.parseArray(); // [
    if (c == 34) { // "
      const s = this.parseStringRaw();
      return s == null ? null : JsonValue.ofString(s);
    }
    if (c == 116) return this.parseLiteral("true", JsonValue.ofBool(true)); // t
    if (c == 102) return this.parseLiteral("false", JsonValue.ofBool(false)); // f
    if (c == 110) return this.parseLiteral("null", JsonValue.nullValue()); // n
    if (c == 45 || isDigit(c)) return this.parseNumber();
    return null;
  }

  parseLiteral(word: string, value: JsonValue): JsonValue | null {
    if (this.pos + word.length > this.len) return null;
    if (this.src.substring(this.pos, this.pos + word.length) != word) return null;
    this.pos += word.length;
    return value;
  }

  parseObject(): JsonValue | null {
    this.pos++; // {
    const keys: string[] = [];
    const vals: JsonValue[] = [];
    this.skipWs();
    if (this.pos < this.len && this.src.charCodeAt(this.pos) == 125) { // }
      this.pos++;
      return JsonValue.ofObject(keys, vals);
    }
    while (true) {
      this.skipWs();
      const key = this.parseStringRaw();
      if (key == null) return null;
      this.skipWs();
      if (this.pos >= this.len || this.src.charCodeAt(this.pos) != 58) return null; // :
      this.pos++;
      const val = this.parseValue();
      if (val == null) return null;
      keys.push(key);
      vals.push(val);
      this.skipWs();
      if (this.pos >= this.len) return null;
      const c = this.src.charCodeAt(this.pos);
      if (c == 44) { // ,
        this.pos++;
        continue;
      }
      if (c == 125) { // }
        this.pos++;
        return JsonValue.ofObject(keys, vals);
      }
      return null;
    }
  }

  parseArray(): JsonValue | null {
    this.pos++; // [
    const items: JsonValue[] = [];
    this.skipWs();
    if (this.pos < this.len && this.src.charCodeAt(this.pos) == 93) { // ]
      this.pos++;
      return JsonValue.ofArray(items);
    }
    while (true) {
      const val = this.parseValue();
      if (val == null) return null;
      items.push(val);
      this.skipWs();
      if (this.pos >= this.len) return null;
      const c = this.src.charCodeAt(this.pos);
      if (c == 44) { // ,
        this.pos++;
        continue;
      }
      if (c == 93) { // ]
        this.pos++;
        return JsonValue.ofArray(items);
      }
      return null;
    }
  }

  /// 解析字符串字面量（调用时 pos 指向 '"'）；单位（UTF-16 code unit）
  /// 先累积为整数数组，避免逐字符拼接。
  parseStringRaw(): string | null {
    if (this.pos >= this.len || this.src.charCodeAt(this.pos) != 34) return null;
    this.pos++;
    const units: i32[] = [];
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos++);
      if (c == 34) return String.fromCharCodes(units);
      if (c == 92) { // backslash
        if (this.pos >= this.len) return null;
        const e = this.src.charCodeAt(this.pos++);
        if (e == 34) units.push(34);
        else if (e == 92) units.push(92);
        else if (e == 47) units.push(47);
        else if (e == 98) units.push(8);
        else if (e == 102) units.push(12);
        else if (e == 110) units.push(10);
        else if (e == 114) units.push(13);
        else if (e == 116) units.push(9);
        else if (e == 117) { // \uXXXX
          const u = this.readHex4();
          if (u < 0) return null;
          units.push(u);
        } else return null;
        continue;
      }
      if (c < 0x20) return null;
      units.push(c);
    }
    return null; // 未闭合
  }

  readHex4(): i32 {
    if (this.pos + 4 > this.len) return -1;
    let v: i32 = 0;
    for (let i = 0; i < 4; i++) {
      const h = hexUnit(this.src.charCodeAt(this.pos + i));
      if (h < 0) return -1;
      v = (v << 4) | h;
    }
    this.pos += 4;
    return v;
  }

  parseNumber(): JsonValue | null {
    const start = this.pos;
    if (this.pos < this.len && this.src.charCodeAt(this.pos) == 45) this.pos++; // -
    if (this.pos >= this.len) return null;
    let c = this.src.charCodeAt(this.pos);
    if (c == 48) { // 0
      this.pos++;
    } else if (c >= 49 && c <= 57) {
      while (this.pos < this.len && isDigit(this.src.charCodeAt(this.pos))) this.pos++;
    } else {
      return null;
    }
    if (this.pos < this.len && this.src.charCodeAt(this.pos) == 46) { // .
      this.pos++;
      let digits = 0;
      while (this.pos < this.len && isDigit(this.src.charCodeAt(this.pos))) {
        this.pos++;
        digits++;
      }
      if (digits == 0) return null;
    }
    if (this.pos < this.len) {
      c = this.src.charCodeAt(this.pos);
      if (c == 101 || c == 69) { // e E
        this.pos++;
        if (this.pos < this.len) {
          c = this.src.charCodeAt(this.pos);
          if (c == 43 || c == 45) this.pos++;
        }
        let digits = 0;
        while (this.pos < this.len && isDigit(this.src.charCodeAt(this.pos))) {
          this.pos++;
          digits++;
        }
        if (digits == 0) return null;
      }
    }
    const raw = this.src.substring(start, this.pos);
    const out = JsonValue.ofNumber(parseFloat(raw));
    out.numRaw = raw;
    return out;
  }
}

export function parseJson(s: string): JsonValue | null {
  return new JsonParser(s).parse();
}

/// 转义字符串内容（不含首尾引号），供手工拼 JSON 使用。
export function escapeJsonString(s: string): string {
  // 直接产出 UTF-16 单位序列：转义序列的字符也是 ASCII 单位。
  const out: i32[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) {
      out.push(92); out.push(34);
    } else if (c == 92) {
      out.push(92); out.push(92);
    } else if (c == 10) {
      out.push(92); out.push(110);
    } else if (c == 13) {
      out.push(92); out.push(114);
    } else if (c == 9) {
      out.push(92); out.push(116);
    } else if (c == 8) {
      out.push(92); out.push(98);
    } else if (c == 12) {
      out.push(92); out.push(102);
    } else if (c < 0x20) {
      out.push(92); out.push(117); out.push(48); out.push(48);
      out.push(HEX_LOWER.charCodeAt((c >> 4) & 15));
      out.push(HEX_LOWER.charCodeAt(c & 15));
    } else {
      out.push(c);
    }
  }
  return String.fromCharCodes(out);
}

function writeString(s: string, out: string[]): void {
  out.push('"');
  out.push(escapeJsonString(s));
  out.push('"');
}

function writeNumber(n: JsonValue, out: string[]): void {
  if (n.numRaw.length > 0) {
    out.push(n.numRaw);
    return;
  }
  const v = n.numValue;
  if (!isFinite(v)) {
    out.push("null");
    return;
  }
  let s = v.toString();
  if (s.endsWith(".0")) s = s.substring(0, s.length - 2);
  out.push(s);
}

function writeValue(v: JsonValue, out: string[]): void {
  const tag = v.tag;
  if (tag == TAG_NULL) {
    out.push("null");
  } else if (tag == TAG_BOOL) {
    out.push(v.boolValue ? "true" : "false");
  } else if (tag == TAG_NUMBER) {
    writeNumber(v, out);
  } else if (tag == TAG_STRING) {
    writeString(v.strValue, out);
  } else if (tag == TAG_ARRAY) {
    out.push("[");
    for (let i = 0; i < v.items.length; i++) {
      if (i > 0) out.push(",");
      writeValue(v.items[i], out);
    }
    out.push("]");
  } else {
    out.push("{");
    for (let i = 0; i < v.keys.length; i++) {
      if (i > 0) out.push(",");
      writeString(v.keys[i], out);
      out.push(":");
      writeValue(v.vals[i], out);
    }
    out.push("}");
  }
}

export function stringifyJson(v: JsonValue): string {
  const out: string[] = [];
  writeValue(v, out);
  return out.join("");
}
