// ABI 探针：验证 AssemblyScript 产物能被 grain_engine 装载并调用。
// 只实现最小 ABI 面（metadata_json/latest/search/take_result/last_error/
// free_result/alloc/dealloc），内存为 4KB 静态 arena 的单向分配。

const ARENA_SIZE: usize = 4096;
let arena = new StaticArray<u8>(4096);
let arenaUsed: usize = 0;

function arenaAlloc(len: usize): usize {
  const ptr = arenaUsed;
  if (ptr + len > ARENA_SIZE) return 0;
  arenaUsed += len;
  return changetype<usize>(arena) + ptr;
}

function writeCstr(s: string): i32 {
  const buf = String.UTF8.encode(s, false);
  const len = buf.byteLength;
  const ptr = arenaAlloc(len + 1);
  if (ptr == 0) return 0;
  memory.copy(ptr, changetype<usize>(buf), len);
  store<u8>(ptr + len, 0);
  return ptr as i32;
}

const META: string =
  '{"name":"AS探针","version":"v0.0.1","type":"bangumi","package":"probe.as","author":"grain","lang":"zh-cn","webSite":"","nsfw":false}';

export function metadata_json(): i32 {
  return writeCstr(META);
}

// 结果预置在静态区，take_result 直接返回。
let latestPtr: i32 = 0;
let searchPtr: i32 = 0;

export function latest(page: i32): i32 {
  if (latestPtr == 0) {
    latestPtr = writeCstr('<LATEST>' + page.toString());
  }
  return 0x40000001;
}

export function search(kwPtr: i32): i32 {
  if (searchPtr == 0) {
    searchPtr = writeCstr('<SEARCH>');
  }
  return 0x40000002;
}

export function take_result(handle: i32): i32 {
  if (handle == 0x40000001) return latestPtr;
  if (handle == 0x40000002) return searchPtr;
  return 0;
}

export function last_error(): i32 {
  return 0;
}

export function free_result(ptr: i32): void {
  // 探针不回收（arena 单向分配）。
}

export function alloc(len: i32): i32 {
  return arenaAlloc(len < 0 ? 0 : len as usize) as i32;
}

export function dealloc(ptr: i32, len: i32): void {}

// 自定义 abort（--use abort=probe/probe/abort）
export function abort(
  message: string | null,
  fileName: string | null,
  lineNumber: u32,
  columnNumber: u32,
): void {}
