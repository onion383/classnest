// =========================================================================
// perf-mark.test.js —— 首屏分段打点（v6 · P1-01）
//
// 这张卡的验收不是「首屏变快」，而是「95ms 黑洞开始有归属」：
//   ① 打点用 epoch 毫秒，能与后端/主进程日志直接相减；
//   ② 一条汇总里同时有总耗时与各段，且兼容启动探针的 @epoch 解析；
//   ③ 没挂 __perf 的普通请求完全空转，打点抛错也绝不影响请求；
//   ④ 关键接线段真的插上了（凭据 / 加密 / 发送 / 解密 / 渲染）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.join(__dirname, '../../student-frontend')
const urlOf = (rel) => pathToFileURL(path.join(FRONTEND, rel)).href
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

async function load() {
  return import(urlOf('src/utils/perfMark.js'))
}

async function captureLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines
}

test('perfNow 与 Date.now 同一时钟，perfSince 不为负', async () => {
  const { perfNow, perfSince } = await load()
  const wall = Date.now()
  const now = perfNow()
  assert.ok(Math.abs(now - wall) < 2000, `epoch 毫秒必须与 Date.now 同量级，实际差 ${now - wall}ms`)
  assert.ok(perfSince(now) >= 0)
})

test('一条汇总里同时有总耗时与各段，并带 @epoch 供启动探针解析', async () => {
  const { createPhaseLog, phase, markSince, logSummary } = await load()
  const log = createPhaseLog()
  const done = phase({ __perf: log }, '加密')
  await new Promise((r) => setTimeout(r, 5))
  done()
  markSince({ __perf: log }, '排队')

  const lines = await captureLog(() => logSummary('首屏请求汇总 就绪 重试0次', log))
  assert.equal(lines.length, 1, '必须汇总成一条：主进程按标签去重，逐条打会被吃掉')
  assert.match(lines[0], /^\[startup\] 首屏请求汇总 就绪 重试0次 共\d+ms（加密 \d+ms \/ 排队 \d+ms）@\d{12,}$/)
})

test('汇总必须读 config 上的收集器副本（axios 会深拷贝 __perf）', async () => {
  const { phaseLogOf, createPhaseLog } = await load()
  const fallback = createPhaseLog()
  const merged = createPhaseLog()
  merged.phases.push('加密 3ms')
  assert.equal(phaseLogOf({ __perf: merged }, fallback), merged)
  assert.equal(phaseLogOf({}, fallback), fallback)
  assert.equal(phaseLogOf(null, fallback), fallback)
})

test('资源计时：能把发起/请求开始/响应开始/结束四段格式化出来', async () => {
  const { formatResourceTiming, logResourceTiming } = await load()
  const entry = {
    name: 'http://127.0.0.1:3000/api/dashboard',
    startTime: 406.4,
    requestStart: 510.2,
    responseStart: 555.8,
    responseEnd: 556.1,
    duration: 149.7,
  }
  assert.equal(formatResourceTiming(entry), 'start=406 requestStart=510 responseStart=556 responseEnd=556 duration=150')
  assert.equal(formatResourceTiming(null), '')

  const orig = globalThis.performance
  const lines = await captureLog(() => {
    globalThis.performance = { getEntriesByType: () => [entry] }
    const hit = logResourceTiming('/api/dashboard', '首屏资源计时')
    assert.equal(hit, entry)
  })
  globalThis.performance = orig
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[startup\] 首屏资源计时 \/api\/dashboard start=406 /)
})

test('没有 __perf 的普通请求完全空转；打点抛错也不影响请求', async () => {
  const { phase, markSince, logSummary, mark } = await load()
  assert.doesNotThrow(() => { phase({}, 'x')(); phase(null, 'x')(); markSince({}, 'x') })
  const lines = await captureLog(() => { logSummary('无分段', null); mark('普通标记') })
  assert.equal(lines.length, 2)

  const orig = console.log
  console.log = () => { throw new Error('日志通道坏了') }
  try {
    assert.doesNotThrow(() => { mark('x'); logSummary('y', { t0: Date.now(), phases: [] }) })
  } finally {
    console.log = orig
  }
})

test('关键接线段都插上了：排队 / 凭据 / 加密 / 发送 / 解密 / 渲染', () => {
  const dash = read('src/composables/useDashboardData.js')
  assert.match(dash, /createPhaseLog\(\)/)
  assert.match(dash, /__perf: perfLog/, '首屏请求必须真的把分段收集器挂到 axios config 上')
  assert.match(dash, /logSummary\(/)
  assert.match(dash, /phaseLogOf\(config, perfLog\)/, '汇总必须读 axios 深拷贝后的副本，否则 phases 永远为空')
  assert.match(dash, /setTimeout\(\(\) => logResourceTiming/, '资源计时必须延后一个宏任务，响应当下条目还没注册')

  const http = read('src/utils/httpClient.js')
  assert.match(http, /markSince\(config, '排队'\)/)
  assert.match(http, /phase\(config, '凭据'\)/)

  const secure = read('src/composables/secureAxios.js')
  assert.match(secure, /phase\(config, '加密'\)/)
  assert.match(secure, /phase\(res\.config, '解密'\)/)
  assert.match(secure, /__perf\.sendAt/)

  const view = read('src/views/DashboardView.vue')
  assert.match(view, /perfNow\(\)/)
  assert.match(view, /nextTick\(\)\.then/)
  assert.match(view, /patch 渲染/)

  const main = fs.readFileSync(path.join(__dirname, '../../electron/main/main.js'), 'utf8')
  assert.match(main, /'首屏资源计时'/, '资源计时在 did-finish-load 之后才发出，必须进主进程放行清单')
  assert.match(main, /'首屏发送开始'/, '发送开始戳在 did-finish-load 之后才发出，必须进放行清单')
  assert.match(main, /'派发后宏任务'/, '派发延迟探针必须进放行清单')
  assert.match(secure, /派发后宏任务/, '必须记录发送后的宏任务延迟，用于区分主线程忙与浏览器调度')

  const backend = fs.readFileSync(path.join(__dirname, '../../student-backend/app.js'), 'utf8')
  assert.match(backend, /PERF_STARTUP/, '后端到达戳必须受 PERF_STARTUP 开关控制')
  assert.match(backend, /dashboard 到达/, '必须能记录请求到达 Express 的 epoch')
  assert.match(secure, /首屏发送开始/, '渲染层必须记录派发前的 epoch')
})
