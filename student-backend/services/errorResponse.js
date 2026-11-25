// =========================================================================
// errorResponse —— Express 全局错误处理（N3-09 错误分层）
//
// 从 app.js 抽出成独立模块，让判据能真跑函数而不是读源码正则（N1-31）。
// 行为与原内联版逐字一致：4xx 保留业务 message；5xx 只回通用文案，
// 原始现场（SQL / 路径 / 模块名）只进本地 console.error；err.expose 显式例外。
// 响应头已发出时交回 Express 默认处理，避免 ERR_HTTP_HEADERS_SENT 掩盖原始错误。
// =========================================================================

function errorResponse(err, req, res, next) {
  if (res.headersSent) return next(err)
  const status = Number((err && (err.status || err.statusCode)) || 0) || 500
  // 全量现场只进本地日志：这是用户自己机器上的单用户工具，控制台是唯一的诊断入口。
  console.error('[express-error]', req.method, req.originalUrl, '->', status, err)
  // 响应体形状必须保持 { error: string }：前端大量代码读 err.response.data.error。
  const isClientError = status >= 400 && status < 500
  const message = isClientError || (err && err.expose === true)
    ? ((err && err.message) || '请求无效')
    : '服务器内部错误，请查看日志后重试'
  res.status(status).json({ error: message })
}

module.exports = { errorResponse }
