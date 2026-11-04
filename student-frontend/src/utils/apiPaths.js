// =========================================================================
// apiPaths.js —— 认证端点路径的唯一来源
//
// 为什么要有这个文件：
//   后端 routes/auth.js 是 `app.use('/api', authRoutes)`（见 app.js 第 118 行），
//   **不存在 /api/auth 这一层**。前端曾按「REST 分组」的直觉写成
//   /api/auth/logout、/api/auth/media-token，两个请求恒 404，而且都被 catch 吞掉：
//     · 登出：界面看着成功，服务端 sid 没吊销、JWT 仍有效
//     · 安全模式媒体凭据：拿不到 token，相册图片全空且没有任何报错
//   两处都查不到日志 —— 404 被 .catch(() => {}) 吃干净了。
//
// 这里只收「已经错过一次、且错了就静默失败」的认证端点。其余 /api/... 仍散在各处，
// 但 testjs/units/api-paths.test.js 会拿这些常量跟后端 router **实际注册的路径**对账，
// 后端改了挂载前缀或路由名而前端没跟上，测试会直接红。
// =========================================================================

export const AUTH_API = {
  // 后端：routes/auth.js `router.post('/logout')`
  logout: '/api/logout',
  // 后端：routes/auth.js `router.get('/media-token')`
  mediaToken: '/api/media-token',
}
