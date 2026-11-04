// =========================================================================
// user-scoped-race.test.js —— 换号后在途请求不得写回（V5-004）正反用例
//
// 背景：登出/换号时 resetUserScopedCaches() 只把 cached/pending 置 null，
// 已经发出去的请求回来时仍会写回缓存 —— B 登录后看到 A 的数据。
// 修复方式：请求发出时记下登录代次，响应回来时代次变了就丢弃并重拉。
//
// 这里用**真 HTTP 服务 + 真 axios**（与前端模块共用同一个 ESM 实例）跑时序：
//   正例：不换号 → 响应正常写缓存，第二次调用直接命中缓存（不再发请求）
//   反例：请求在飞时换号 → 旧响应被丢弃，最终拿到新用户数据，且缓存里不是旧数据
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.join(__dirname, '../../student-frontend')
const urlOf = (rel) => pathToFileURL(path.join(FRONTEND, rel)).href

let seq = 0
// 每个用例拿到一份全新的 useDashboardData / semesterStart（模块状态互不干扰）；
// userScopedCache 故意共用同一个实例，模拟「应用进程里只有一份登录代次」。
const fresh = (rel) => import(urlOf(rel) + '?case=' + (++seq))

// 前端模块内部 `import axios from 'axios'` 解析到同一个 ESM 入口，这里 import 同一路径
// 拿到的就是同一个 axios 实例，设置 baseURL 对被测模块生效。
async function loadAxios() {
  return (await import(urlOf('node_modules/axios/index.js'))).default
}

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

function json(res, code, body, delayMs = 0) {
  setTimeout(() => {
    if (res.destroyed) return
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }, delayMs)
}

test('正例：不换号时响应正常写缓存，第二次调用命中缓存', async () => {
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.url.startsWith('/api/dashboard')) {
      hits += 1
      json(res, 200, { students: [{ 姓名: 'A' }] }, 0)
      return
    }
    json(res, 404, { error: 'not found' })
  })
  try {
    const axios = await loadAxios()
    axios.defaults.baseURL = 'http://127.0.0.1:' + server.address().port
    const mod = await fresh('src/composables/useDashboardData.js')
    const d1 = await mod.ensureDashboardData()
    assert.equal(d1.students[0].姓名, 'A')
    const d2 = await mod.ensureDashboardData()
    assert.equal(d2.students[0].姓名, 'A')
    assert.equal(hits, 1, '第二次应命中缓存，不再发请求')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('反例：请求在飞时换号 → 旧响应不写缓存，最终拿到新用户数据', async () => {
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.url.startsWith('/api/dashboard')) {
      hits += 1
      // 第一次（旧用户）故意慢，制造「换号发生在响应回来之前」的时序
      json(res, 200, { students: [{ 姓名: hits === 1 ? 'A' : 'B' }] }, hits === 1 ? 250 : 0)
      return
    }
    json(res, 404, { error: 'not found' })
  })
  try {
    const axios = await loadAxios()
    axios.defaults.baseURL = 'http://127.0.0.1:' + server.address().port
    const mod = await fresh('src/composables/useDashboardData.js')
    const scoped = await import(urlOf('src/utils/userScopedCache.js'))

    const p = mod.ensureDashboardData()
    // 旧用户请求还在路上时「登出 + 新用户登录」
    setTimeout(() => scoped.resetUserScopedCaches(), 60)

    const d = await p
    assert.equal(d.students[0].姓名, 'B', '旧用户的响应必须被丢弃，返回/重拉新用户数据')
    assert.equal(hits, 2, '应丢弃旧响应并就新用户重拉一次')

    // 缓存里也必须是新数据：再次调用不该回到 A
    const again = await mod.ensureDashboardData()
    assert.equal(again.students[0].姓名, 'B')
    assert.equal(hits, 2, '重拉后应命中缓存，不再发第三次请求')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('反例：semesterStart 换号后不返回上一个库的开学日', async () => {
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.url.startsWith('/api/schedule/settings')) {
      hits += 1
      json(res, 200, { semester_start: hits === 1 ? '2026-02-01' : '2026-09-01' }, hits === 1 ? 250 : 0)
      return
    }
    json(res, 404, { error: 'not found' })
  })
  try {
    const axios = await loadAxios()
    axios.defaults.baseURL = 'http://127.0.0.1:' + server.address().port
    const mod = await fresh('src/utils/semesterStart.js')
    const scoped = await import(urlOf('src/utils/userScopedCache.js'))

    const p = mod.getSemesterStart()
    setTimeout(() => scoped.resetUserScopedCaches(), 60)
    const v = await p
    assert.equal(v, '2026-09-01', '旧库的开学日不能返回给新用户')
    assert.equal(hits, 2, '应丢弃旧响应并就新库重拉')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('机制：代次号在每次登出/换号时递增', async () => {
  const scoped = await import(urlOf('src/utils/userScopedCache.js'))
  const before = scoped.userScopedGeneration()
  scoped.resetUserScopedCaches()
  assert.equal(scoped.userScopedGeneration(), before + 1, 'reset 必须先递增代次，在途响应才会被判定为过期')
  scoped.resetUserScopedCaches()
  assert.equal(scoped.userScopedGeneration(), before + 2)
})
