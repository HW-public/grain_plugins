// 自定义 abort：插件不引入 env.abort import（宿主只注册 "grain" 模块）。
// 构建时用 `--use abort=src/abort/abort`（路径相对 pdk-as 目录）。
export function abort(
  message: string | null,
  fileName: string | null,
  lineNumber: u32,
  columnNumber: u32,
): void {}
