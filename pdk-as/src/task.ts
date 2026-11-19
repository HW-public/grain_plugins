// 异步任务状态机：task 槽位 + 宿主泵轮询接口。
//
// 宿主调用 latest/search/detail/watch 得到 guest handle
// （0x40000000 | slot）；随后反复 take_result(handle) 推进一次 step()：
//   step() 返回 null  -> 未完成，take_result 返回 0
//   step() 返回字符串 -> 完成，结果缓冲指针返回
//   step() 调 fail()  -> 错误终态，last_error 返回错误信封

import { freeBytes } from "./heap";
import { errorEnvelope, writeCstr } from "./strings";

export abstract class Task {
  abstract step(): string | null;

  // 错误终态（由 fail() 写入；成功后保持 null）。
  errorJson: string | null = null;

  // 在 step() 里 `return this.fail(...)` 即进入错误终态。
  fail(code: string, message: string, detail: string = ""): string | null {
    this.errorJson = errorEnvelope(code, message, detail);
    return null;
  }
}

// 独立可用的信封构造器（不需要进入 Task 错误态的场合）。
export function fail(
  code: string,
  message: string,
  detail: string = "",
): string {
  return errorEnvelope(code, message, detail);
}

const MAX_TASKS: i32 = 32;
const GUEST_HANDLE_BASE: i32 = 0x40000000;
const GUEST_HANDLE_MASK: i32 = 0x3fffffff;

const slots = new Array<Task | null>(MAX_TASKS + 1);
const resultPtrs = new StaticArray<i32>(MAX_TASKS + 1);
const failedFlags = new StaticArray<u8>(MAX_TASKS + 1);

let lastErrorPtr: i32 = 0;
let lastErrorSlot: i32 = 0;

// 登记一个 task，返回 guest handle；槽位满返回 0。
export function spawn(task: Task): i32 {
  for (let i = 1; i <= MAX_TASKS; i++) {
    if (slots[i] == null) {
      slots[i] = task;
      resultPtrs[i] = 0;
      failedFlags[i] = 0;
      return GUEST_HANDLE_BASE | i;
    }
  }
  return 0;
}

function slotOf(handle: i32): i32 {
  if ((handle & GUEST_HANDLE_BASE) == 0) return 0;
  const slot = handle & GUEST_HANDLE_MASK;
  if (slot < 1 || slot > MAX_TASKS) return 0;
  return slot;
}

function releaseSlot(slot: i32): void {
  if (slot < 1 || slot > MAX_TASKS) return;
  slots[slot] = null;
  resultPtrs[slot] = 0;
  failedFlags[slot] = 0;
}

function setError(slot: i32, ptr: i32): void {
  // 旧错误缓冲未释放则先回收，避免每次失败泄漏一块。（宿主已读走）
  if (lastErrorPtr != 0) freeBytes(lastErrorPtr as usize);
  lastErrorPtr = ptr;
  lastErrorSlot = slot;
  failedFlags[slot] = 1;
}

// 宿主泵：每次调用最多推进一次 step()。
export function takeResult(handle: i32): i32 {
  const slot = slotOf(handle);
  if (slot == 0) return 0;
  const task = slots[slot];
  if (task == null) return 0;
  if (resultPtrs[slot] != 0) return resultPtrs[slot];
  if (failedFlags[slot] != 0) return 0;

  const out = task.step();
  if (out == null) {
    const err = task.errorJson;
    if (err != null) {
      const ptr = writeCstr(err);
      if (ptr == 0) {
        setError(slot, writeCstr(errorEnvelope("abi", "error buffer exhausted")));
      } else {
        setError(slot, ptr);
      }
    }
    return 0;
  }

  const ptr = writeCstr(out);
  if (ptr == 0) {
    setError(slot, writeCstr(errorEnvelope("abi", "result buffer exhausted")));
    return 0;
  }
  resultPtrs[slot] = ptr;
  return ptr;
}

export function lastError(): i32 {
  return lastErrorPtr;
}

// 释放结果/错误/元数据等 ABI 缓冲；释放 task 结果或错误时同时回收槽位。
export function freeResult(ptr: i32): void {
  if (ptr <= 0) return;

  if (lastErrorPtr != 0 && ptr == lastErrorPtr) {
    freeBytes(ptr as usize);
    const slot = lastErrorSlot;
    lastErrorPtr = 0;
    lastErrorSlot = 0;
    releaseSlot(slot);
    return;
  }

  for (let i = 1; i <= MAX_TASKS; i++) {
    if (resultPtrs[i] == ptr) {
      freeBytes(ptr as usize);
      releaseSlot(i);
      return;
    }
  }

  // 其余指针（如 metadata_json 结果）：只释放堆块。
  freeBytes(ptr as usize);
}

// 当前占用的槽位数（调试用）。
export function activeTasks(): i32 {
  let n = 0;
  for (let i = 1; i <= MAX_TASKS; i++) {
    if (slots[i] != null) n++;
  }
  return n;
}
