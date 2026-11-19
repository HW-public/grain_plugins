# pdk-as — grain_engine 的 AssemblyScript 插件 PDK

面向 `grain_engine` ABI v0.2 的 TypeScript 插件开发包，产物为无 WASI、
只依赖 `grain` import 模块的 wasm。

## 快速开始

插件入口 `my_plugin.ts`：

```ts
import { HostCall, Task, httpGet, setMeta, spawn } from "../src/index";

// 必须：把 ABI 导出（alloc/dealloc/metadata_json/take_result/last_error/
// free_result）与自定义 abort 带进 wasm。实测 `export *` 会保留这些导出。
export * from "../src/index";

setMeta(
  '{"name":"示例插件","version":"v0.0.1","type":"general","package":"demo.as","author":"you","lang":"zh-cn","webSite":"","nsfw":false}',
);

class LatestTask extends Task {
  call: HostCall;

  constructor(url: string) {
    super();
    this.call = httpGet(url);
  }

  step(): string | null {
    const resp = this.call.poll(); // null = 宿主还没完成
    if (resp == null) return null;
    if (resp.startsWith('{"code"')) {
      return this.fail("http", "请求失败", resp); // 进入错误终态
    }
    return resp; // 完成：take_result 把它写进结果缓冲
  }
}

export function latest(page: i32): i32 {
  return spawn(new LatestTask("https://example.com/list?p=" + page.toString()));
}

// 其余导出按需实现：search(kw_ptr)、detail(url_ptr)、watch(url_ptr)。
```

构建前置（Node.js 20+），在 `pdk-as/` 目录安装依赖：

```bash
npm ci
```

构建（在 `pdk-as/` 目录）：

```bash
bash build.sh ../my_plugin.ts out/my_plugin.wasm
```

`build.sh` 内部先 `cd pdk-as`，再执行：

```bash
npx asc <abs entry> -o <abs out> --optimize \
  --baseDir <仓库根> --use abort=pdk-as/src/abort/abort
```

不要省略 `--baseDir`：入口在 `pdk-as/` 之外时，自定义 abort 元素
`pdk-as/src/abort/abort` 会按默认 baseDir 解析而失败（AS111）。

在 `grain_plugins` 仓库根目录构建 TS 插件示例：

```bash
bash pdk-as/build.sh plugins/360zy/ts/index.ts \
  plugins/360zy/ts/build/plugin_360zy_ts.wasm
```

## 模块

| 文件 | 内容 |
| --- | --- |
| `src/heap.ts` | 1 MiB 静态 arena + first-fit 空闲链表；导出 `alloc`/`dealloc`，内部 `allocBytes`/`freeBytes` |
| `src/strings.ts` | `readCstr`/`writeCstr`/`strLen`、JSON 转义与错误信封 |
| `src/host.ts` | `grain_*` import 声明、`HostCall`、`httpGet`/`httpRequest`/`xpathQuery`/`log`/`md5Hex`/`base64Encode` |
| `src/task.ts` | `Task` 抽象类、`spawn`/`takeResult`/`lastError`/`freeResult`、`fail` |
| `src/meta.ts` | `setMeta`/`metadata_json` |
| `src/index.ts` | 统一入口 + 蛇形 ABI 包装（`take_result`/`last_error`/`free_result`） |
| `src/abort.ts` | 自定义 abort（不产生 `env.abort` import） |
| `probe/pdk_probe.ts` | 端到端回归探针（http 请求 → `{"len":N}`） |

## 异步状态机

宿主同步调用 `latest(page)` 拿 guest handle（`0x40000000 | slot`），然后反复
`take_result(handle)`：

- `step()` 返回 `null` → 未完成，宿主 await 自己的 Future 后再 poll；
- `step()` 返回字符串 → 结果写入 ABI 堆，`take_result` 返回指针，
  宿主读完调 `free_result(ptr)` 并回收槽位；
- `step()` 里 `return this.fail(code, message, detail)` → 错误终态，
  `last_error()` 返回 `{"code","message","detail"?}` 信封。

`HostCall.poll()` 每次只对应一次宿主检查：返回 `null` 表示宿主能力尚未完成，
返回字符串表示响应 JSON（可能本身是错误信封）。一次 `grain_event_wait`
最多消费一个结果，不要在同一个 `step()` 里重复 poll 同一个已完成的调用。

宿主 import 均为同步：`httpGet`/`httpRequest`/`md5Hex`/`base64Encode`/
`xpathQuery` 在调用时立即把参数交给宿主并返回 `HostCall`。

## ABI 实测结论（2026-11-19）

- `index.ts` 的蛇形包装 + 入口 `export * from "../src/index"` 会被 asc 0.28.20
  保留为 wasm 导出：`alloc`、`dealloc`、`metadata_json`、`take_result`、
  `last_error`、`free_result` 均存在。
- 由于入口重导出了全部宿主便捷函数，所有六个 `grain_*` import 都会进入
  imports（宿主按声明注册，未调用也会注册为同步闭包）。这是统一入口的
  取舍；若需要极简 imports，可让入口只导出 ABI 包装、从 `src/host.ts`
  直接导入所需能力。
- 探针 `probe/pdk_probe.wasm` 在 grain_engine 实测：`callLatest(1)` 返回
  `{"len":577}`（`http://example.com` 正文长度）。

## 已知限制

- ABI 堆固定 1 MiB，单次分配失败返回 0；结果/错误缓冲写失败会置
  `{"code":"abi","message":"... buffer exhausted"}` 错误信封。
- task 槽位 32 个；满时 `spawn` 返回 0（宿主泵会超时或按错误处理）。
- `HostCall` 接收缓冲初始 4 KiB，自动翻倍到 1 MiB 上限；超限返回 abi 错误。
- 同时存在多个错误时 `last_error()` 只保留最新一个（旧缓冲会被回收）。
- 未捕获的 trap（越界、除零等）按 SandboxError 处理，PDK 不做恢复。
