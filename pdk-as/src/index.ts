// PDK 统一入口。
//
// 插件入口文件只需：
//   import { ... } from "../src/index";   // 或 pdk 包路径
//   export * from "../src/index";         // 把 ABI 导出（alloc/dealloc/
//                                         // metadata_json/take_result/
//                                         // last_error/free_result）带上
// 然后自行 export latest / search / detail / watch。
//
// 实测：`export *` 会把被重导出的函数保留为 wasm 导出，imports 也按实际
// 使用情况裁剪（未调用的宿主能力不会产生 import）。

export { alloc, dealloc } from "./heap";
export { metadata_json, setMeta } from "./meta";
export { spawn, fail, activeTasks, Task } from "./task";
export {
  HostCall,
  httpGet,
  httpRequest,
  xpathQuery,
  log,
  md5Hex,
  base64Encode,
} from "./host";
export {
  readCstr,
  writeCstr,
  strLen,
  jsonEscape,
  jsonQuote,
  errorEnvelope,
} from "./strings";

// abort 模块必须进入编译图，--use abort=src/abort/abort 才能解析到它。
export { abort } from "./abort";

import { takeResult, lastError, freeResult } from "./task";

export function take_result(handle: i32): i32 {
  return takeResult(handle);
}

export function last_error(): i32 {
  return lastError();
}

export function free_result(ptr: i32): void {
  freeResult(ptr);
}
