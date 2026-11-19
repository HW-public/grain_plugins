// PDK 端到端回归探针：
// latest(1) 发起一次 httpGet(https://example.com)，poll 到完成后返回
// {"len":N}（N 为响应 body 的近似字符数，>0 即链路通）。
//
// 构建：bash build.sh probe/pdk_probe.ts probe/pdk_probe.wasm
// 检查：imports 只应有 grain_http_request / grain_event_wait。

import {
  HostCall,
  Task,
  httpGet,
  setMeta,
  spawn,
} from "../src/index";

// 把 ABI 导出（alloc/dealloc/metadata_json/take_result/last_error/
// free_result）带上 wasm。
export * from "../src/index";

setMeta(
  '{"name":"AS-PDK探针","version":"v0.0.1","type":"general","package":"probe.pdk.as","author":"grain","lang":"zh-cn","webSite":"","nsfw":false}',
);

// 本机 Dart 对 example.com 的 TLS 链校验失败（CERTIFICATE_VERIFY_FAILED），
// 探针改用明文 HTTP；真机插件可换回 https。
const TARGET_URL: string = "http://example.com";

// 从 http 响应 JSON 里估算 body 长度（探针只关心 >0）。
function bodyLength(resp: string): i32 {
  const key = '"body":"';
  const at = resp.indexOf(key);
  if (at < 0) return -1;
  let i = at + key.length;
  let n = 0;
  while (i < resp.length) {
    const c = resp.charCodeAt(i);
    if (c == 92) {
      // 转义序列：粗略按一个输出字符计。
      n++;
      i += 2;
      continue;
    }
    if (c == 34) break;
    n++;
    i++;
  }
  return n;
}

class LatestTask extends Task {
  call: HostCall;

  constructor(url: string) {
    super();
    this.call = httpGet(url);
  }

  step(): string | null {
    const resp = this.call.poll();
    if (resp == null) return null;
    if (resp.startsWith('{"code"')) {
      return this.fail("http", "request failed", resp);
    }
    let n = bodyLength(resp);
    if (n < 0) n = resp.length;
    return '{"len":' + n.toString() + "}";
  }
}

export function latest(page: i32): i32 {
  return spawn(new LatestTask(TARGET_URL));
}

export function search(kwPtr: i32): i32 {
  return 0;
}
