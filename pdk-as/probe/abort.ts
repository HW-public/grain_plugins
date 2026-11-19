// 自定义 abort：插件不引入 env.abort import（宿主只注册 "grain" 模块）。
// 真实 PDK 会把它包装成 trap（unreachable），这里返回即可。
export function abort(
  message: string | null,
  fileName: string | null,
  lineNumber: u32,
  columnNumber: u32,
): void {}
