// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// api-paths.test.js —— 前端调用的认证路径 vs 后端**真实注册**的路径
//
// 起因（审查 v4 · P0）：后端 routes/auth.js 是 `app.use('/api', authRoutes)`，
// 没有 /api/auth 这一层。前端按「REST 分组」的直觉写成 /api/auth/logout、
// /api/auth/media-token，两个请求恒 404，又都被 .catch 吞掉：
//   · 登出：界面看着成功，服务端 sid 没吊销、JWT 仍有效
//   · 安全模式媒体凭据：拿不到 token，相册图片全空且无任何报错
//   · 更隐蔽的一处：middleware/auth.js 的 RECOVER_ALLOWED 白名单也写成 /api/auth/logout，
//     两边同时错所以「看起来一致」，那条放行规则其实从未生效过
//
// 只改字符串治不了根：路径字面量散落、没人对账，下次换端点还会重演。
// 所以这里做三件事：① 断言挂载前缀；② 断言前端常量 ⊆ 后端真实路由；
// ③ 断言全库不再出现 /api/auth/ 字面量（含白名单）。
// =========================================================================
const test = require('node:test')
const { ROOT, abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const BACKEND = abs('student-backend')
const FRONT_SRC = abs('student-frontend', 'src')

const read = (p) => fs.readFileSync(p, 'utf8')

// app.js 里 authRoutes 的挂载前缀：这是「后端到底挂在哪」的唯一事实来源，
// 不许在测试里写死 '/api'，否则后端一改挂载点，测试反而继续绿。
function authMountPrefix() {
  const code = read(path.join(BACKEND, 'app.js'))
  const m = code.match(/app\.use\(\s*'([^']+)'\s*,\s*authRoutes\s*\)/)
  assert.ok(m, 'app.js 里找不到 `app.use(<prefix>, authRoutes)`')
  return m[1]
}

// 把 routes/auth.js 里 router.<verb>('<path>') 与挂载前缀拼成完整路径
function backendAuthPaths() {
  const prefix = authMountPrefix()
  const code = read(path.join(BACKEND, 'routes', 'auth.js'))
  const re = /router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g
  const out = new Set()
  let m
  while ((m = re.exec(code))) out.add(prefix + m[1])
  return out
}

// 前端唯一来源里的常量：`key: '/api/...'`
function frontendAuthPaths() {
  const code = read(path.join(FRONT_SRC, 'utils', 'apiPaths.js'))
  const re = /(\w+)\s*:\s*'(\/api\/[^']+)'/g
  const out = new Map()
  let m
  while ((m = re.exec(code))) out.set(m[1], m[2])
  return out
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(js|vue|mjs|cjs)$/.test(e.name)) out.push(full)
  }
  return out
}

test('后端 authRoutes 挂在 /api 下（不存在 /api/auth 这一层）', () => {
  assert.equal(authMountPrefix(), '/api')
  const paths = backendAuthPaths()
  assert.ok(paths.has('/api/logout'), `后端应有 /api/logout，实际：${[...paths].join(', ')}`)
  assert.ok(paths.has('/api/media-token'), `后端应有 /api/media-token，实际：${[...paths].join(', ')}`)
})

test('前端每个认证常量都能在后端真实路由里找到', () => {
  const backend = backendAuthPaths()
  const front = frontendAuthPaths()
  assert.ok(front.size >= 2, 'apiPaths.js 里没解析到任何常量（文件被改名/改结构了？）')
  for (const [key, p] of front) {
    assert.ok(backend.has(p), `AUTH_API.${key} = ${p} 在后端没有对应路由；后端现有：${[...backend].join(', ')}`)
  }
})

test('源码里不再出现 /api/auth/ 字面量（前端 + 后端路由/中间件）', () => {
  const files = [
    ...walk(FRONT_SRC),
    ...walk(path.join(BACKEND, 'routes')),
    path.join(BACKEND, 'middleware', 'auth.js'),
    path.join(BACKEND, 'app.js'),
  ]
  const quoteRe = /(['"`])([^'"`\n]*\/api\/auth\/[^'"`\n]*)\1/g
  const bad = []
  for (const file of files) {
    const code = read(file)
    let m
    while ((m = quoteRe.exec(code))) bad.push(`${path.relative(ROOT, file)} → ${m[2]}`)
  }
  assert.deepEqual(bad, [], `仍有 /api/auth/ 字面量：\n${bad.join('\n')}`)
})

test('恢复态白名单里的登出路径与后端真实路由一致', () => {
  const code = read(path.join(BACKEND, 'middleware', 'auth.js'))
  const block = code.match(/const RECOVER_ALLOWED = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(block, 'middleware/auth.js 里找不到 RECOVER_ALLOWED')
  const logoutPaths = [...block[1].matchAll(/'([A-Z]+)\s+(\/api\/[^']+)'/g)]
    .filter((m) => m[2].includes('logout'))
    .map((m) => m[2])
  assert.equal(logoutPaths.length, 1, 'RECOVER_ALLOWED 里应有且只有一条登出放行')
  assert.ok(backendAuthPaths().has(logoutPaths[0]),
    `白名单 ${logoutPaths[0]} 不是后端真实路径（改动前前后端同时写错，这条放行从未生效）`)
})

// =========================================================================
// G10（v8 · 5-4）：前端全部静态 API 路径 vs 后端真实挂载。
// 上面只守了 2 条认证端点；这里守「前端调了一个后端完全没挂的 /api 前缀」。
// 清单对账而非真跑 404：真跑需鉴权/数据/写库，不适合通用守卫。
// 局限：前缀匹配抓不到同一 router 内的具体路由拼写错，由业务行为测试守。
// =========================================================================

/** 前端静态 /api 路径全集（源码 literal，不含 ${} 动态段） */
function frontendStaticApiPaths() {
  const out = new Set()
  for (const file of walk(FRONT_SRC)) {
    const code = read(file)
    for (const m of code.matchAll(/['"`](\/api\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)['"`]/g)) {
      out.add(m[1])
    }
  }
  return out
}

/** 后端已知路径源：app.use 前缀 + app.<verb> 直挂 + auth router 具体路由 */
function backendMountedPaths() {
  const app = read(path.join(BACKEND, 'app.js'))
  const auth = read(path.join(BACKEND, 'routes', 'auth.js'))
  const known = new Set()
  // app.use('/api/xxx', …) — 排除裸 '/api'（它只挂 auth 具体路由，不是通配）
  for (const m of app.matchAll(/app\.use\(\s*'((\/api)[^']*)'/g)) {
    if (m[1] !== '/api') known.add(m[1])
  }
  // app.get('/api/xxx', …) 直挂（setup/semester-prefill 这类免登录端点）
  for (const m of app.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'((\/api)[^']*)'/g)) {
    known.add(m[1])
  }
  for (const m of auth.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    known.add('/api' + m[1])
  }
  return known
}

test('G10：前端每个静态 API 路径都落在后端真实挂载下（无幽灵端点）', () => {
  const paths = frontendStaticApiPaths()
  const known = backendMountedPaths()
  assert.ok(paths.size >= 80, `前端静态路径解析异常（只拿到 ${paths.size} 条，源文件结构变了？）`)
  assert.ok(known.size >= 30, `后端挂载解析异常（只拿到 ${known.size} 条，app.js 结构变了？）`)
  const orphans = [...paths].filter((p) => ![...known].some((k) => p === k || p.startsWith(k + '/')))
  assert.deepEqual(orphans, [],
    `前端调用了后端未挂载的 /api 路径：\n${orphans.join('\n')}\n（后端已知：${[...known].sort().join(', ')}）`)
})

test('G10：挂载前缀从 app.js 现读（含直挂与 auth router），不写死', () => {
  const known = backendMountedPaths()
  assert.ok(known.has('/api/students'), '应解析到 app.use("/api/students", …)')
  assert.ok(known.has('/api/setup/semester-prefill'), '应解析到 app.get 直挂路由')
  assert.ok(known.has('/api/logout'), '应解析到 auth router 的 /api/logout')
  assert.ok(!known.has('/api'), '裸 /api 不应算万能前缀（否则幽灵端点检测恒绿）')
})
