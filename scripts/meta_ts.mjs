// 从 AssemblyScript 产物读取 grain.metadata：实例化 wasm 后调用
// metadata_json()（AS 不支持 custom section，元数据经导出提供），
// 在导出的线性内存里读到 NUL 结尾的 JSON。
// 用法：node scripts/meta_ts.mjs <plugin.wasm>
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/meta_ts.mjs <plugin.wasm>');
  process.exit(2);
}

const bytes = readFileSync(path);
// 宿主能力 import 用桩函数满足链接；metadata_json 不调用它们。
const noop = () => 0;
const importObject = {
  grain: new Proxy({}, { get: () => noop }),
};

const { instance } = await WebAssembly.instantiate(bytes, importObject);
const { metadata_json, memory } = instance.exports;
if (typeof metadata_json !== 'function' || !(memory instanceof WebAssembly.Memory)) {
  console.error('error: missing metadata_json export');
  process.exit(1);
}
const ptr = metadata_json();
if (!ptr) {
  console.error('error: metadata_json returned 0');
  process.exit(1);
}
const view = new Uint8Array(memory.buffer);
let end = ptr;
while (end < view.length && view[end] !== 0) end++;
if (end === view.length) {
  console.error('error: metadata_json not NUL-terminated');
  process.exit(1);
}
const json = new TextDecoder('utf-8').decode(view.subarray(ptr, end));
process.stdout.write(json);
