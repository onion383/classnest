// =========================================================================
// sendError —— 路由 catch 里的统一错误响应（V9-K01-07 / K03-04 家族）
//
// 为什么要有这一层：全局 errorResponse 中间件已经做到「4xx 保留业务文案、
// 5xx 只回通用文案、原始现场只进日志」，但大量路由的 catch 直接写
// `res.status(500).json({ error: e.message })` 绕开了它 —— 每新增一个路由
// 就可能再漏一处。本工具把那句一行式替换成同一套分层语义，
// 与 errorResponse 共用同一个「5xx 文案」常量，不各写一份。
//
// 4xx 调用点不要改用本工具：业务校验错误的可读文案本来就该回给前端。
// =========================================================================
const { errorResponse } = require('../services/errorResponse')

/** 与全局中间件同一口径：500 通用文案 + 原始现场只进日志；err.expose 才回原文。 */
function sendError(res, err, req = null) {
  // errorResponse 需要一个 req（日志里打 method/url）与 next；路由 catch 里通常没有 req，
  // 这里补一个最小形状，next 用空实现（这些落点本来就不是 headersSent 分支）。
  errorResponse(err, req || { method: '', originalUrl: '' }, res, () => {})
}

module.exports = { sendError }
