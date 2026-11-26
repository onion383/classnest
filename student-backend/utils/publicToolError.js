// =========================================================================
// publicToolError —— 外部客户端可见的 MCP 工具错误文案（K02-05 / N3-09）
//
// 从 mcp.server.js 抽出成独立纯模块，让 stdio 转发器（mcp-forwarder.cjs）
// 也能复用同一套脱敏——它跑在独立进程，不能 require 整个 server 模块
// （那会拉起路由与 handler）。两处各写一份正则就是两份会漂移的清单（V9-K02-01）。
//
// 业务错误原样返回；内部细节（SQL 状态字 / 路径 / 堆栈 / 文件名）一律换成通用文案。
// =========================================================================
const INTERNAL_DETAIL_RE = /(SQLITE_|ENOENT|EACCES|EPERM|at\s+\S+\s+\(|[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+\.(js|json|cjs|db)|SELECT\s+.*\s+FROM\s+\w+|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w+)/

function publicToolError(message) {
  const m = String(message == null || message === '' ? '工具执行失败' : message)
  return INTERNAL_DETAIL_RE.test(m) ? '工具执行失败（内部错误，详情见应用日志）' : m
}

module.exports = { publicToolError, INTERNAL_DETAIL_RE }
