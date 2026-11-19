// 插件元数据：setMeta() 保存编译期可读的 JSON 串，
// metadata_json() 每次调用都新分配（宿主读后 free_result，缓存会悬垂）。

import { writeCstr } from "./strings";

let metaJson: string = "";

export function setMeta(json: string): void {
  metaJson = json;
}

export function metadata_json(): i32 {
  return writeCstr(metaJson);
}
