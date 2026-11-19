// ABI 堆：1 MiB 静态 arena + first-fit 空闲链表。
//
// 块布局（8 字节块头）：
//   [0..4)  size:u32  载荷字节数（恒为 8 的倍数）
//   [4..8)  used:u32  0=空闲 1=已用
//   载荷从块头 +8 开始。
//
// 所有导出给宿主的指针都指向载荷起点；dealloc 忽略 len，长度从块头读。
// 越界/非法指针一律静默忽略——宿主 import 回调里 trap 会打爆整个实例。

const ARENA_SIZE: usize = 1048576;
const HEADER: usize = 8;
const ALIGN: usize = 8;
const MIN_PAYLOAD: usize = 8;

const arena = new StaticArray<u8>(ARENA_SIZE as i32);
const arenaBase: usize = changetype<usize>(arena);

// 已提交区域的末尾偏移（相对 arenaBase）。
let heapEnd: usize = 0;

function alignUp(n: usize): usize {
  return (n + ALIGN - 1) & ~(ALIGN - 1);
}

// 分配 len 字节（len 为 0 时给最小块），失败返回 0。
export function allocBytes(len: usize): usize {
  let payload = alignUp(len == 0 ? MIN_PAYLOAD : len);
  if (payload == 0) return 0;

  // first-fit：扫描已提交区域找足够大的空闲块。
  let off: usize = 0;
  while (off < heapEnd) {
    const size = load<u32>(arenaBase + off) as usize;
    const used = load<u32>(arenaBase + off + 4);
    if (size == 0 || (size & (ALIGN - 1)) != 0) return 0; // 堆结构损坏
    if (used == 0 && size >= payload) {
      const remain = size - payload;
      if (remain >= HEADER + MIN_PAYLOAD) {
        // 分裂尾部为一个新的空闲块。
        const tail = off + HEADER + payload;
        store<u32>(arenaBase + tail, (remain - HEADER) as u32);
        store<u32>(arenaBase + tail + 4, 0);
        store<u32>(arenaBase + off, payload as u32);
      }
      store<u32>(arenaBase + off + 4, 1);
      return arenaBase + off + HEADER;
    }
    off += HEADER + size;
  }

  // 尾部不足：bump 提交新块。
  const need = HEADER + payload;
  if (heapEnd + need > ARENA_SIZE) return 0;
  store<u32>(arenaBase + heapEnd, payload as u32);
  store<u32>(arenaBase + heapEnd + 4, 1);
  const ptr = arenaBase + heapEnd + HEADER;
  heapEnd += need;
  return ptr;
}

// 释放指针所指块；非法指针、重复释放、非块起点均静默忽略。
export function freeBytes(ptr: usize): void {
  if (ptr == 0 || ptr < arenaBase + HEADER) return;
  const rel = ptr - arenaBase - HEADER;
  if (rel >= heapEnd || (rel & (ALIGN - 1)) != 0) return;

  let off: usize = 0;
  let prev: usize = 0;
  let prevFree = false;
  while (off < heapEnd) {
    const size = load<u32>(arenaBase + off) as usize;
    if (size == 0 || (size & (ALIGN - 1)) != 0) return;
    const total = HEADER + size;
    if (off + total > heapEnd) return;

    if (off == rel) {
      if (load<u32>(arenaBase + off + 4) == 0) return; // 重复释放
      store<u32>(arenaBase + off + 4, 0);
      let curSize = size;

      // 与后一块合并。
      const nextOff = off + total;
      if (nextOff < heapEnd && load<u32>(arenaBase + nextOff + 4) == 0) {
        curSize += HEADER + (load<u32>(arenaBase + nextOff) as usize);
        store<u32>(arenaBase + off, curSize as u32);
      }

      // 与前一块合并；尾部空闲则回退 heapEnd。
      if (prevFree) {
        const prevSize = load<u32>(arenaBase + prev) as usize;
        const merged = prevSize + HEADER + curSize;
        store<u32>(arenaBase + prev, merged as u32);
        if (prev + HEADER + merged == heapEnd) heapEnd = prev;
      } else if (off + HEADER + curSize == heapEnd) {
        heapEnd = off;
      }
      return;
    }

    prev = off;
    prevFree = load<u32>(arenaBase + off + 4) == 0;
    off += total;
  }
}

// 宿主 ABI：alloc / dealloc。
export function alloc(len: i32): i32 {
  if (len < 0) return 0;
  return allocBytes(len as usize) as i32;
}

export function dealloc(ptr: i32, len: i32): void {
  if (ptr <= 0) return;
  freeBytes(ptr as usize);
}
