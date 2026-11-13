// =========================================================================
// startup-io.test.js —— 启动期同步 IO 打点（v6 性能专题 · 1-10）
//
// 验收点：
//   ① 默认（PERF_STARTUP 未开）不安装：传 enabled:false 时一个 fs 方法都不替换；
//   ② 开启后按方法计数、返回值与异常原样透传（计时不能改变语义）；
//   ③ summarize 打印合计并把 mark 写进启动时间线；重复 install 不叠加。
// 另外锁接线：main.js 必须在业务模块 require 之前安装，summary 必须在 report 之前。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const io = require(path.join(ROOT, 'electron/main/main.startup-io'))
const timer = require(path.join(ROOT, 'electron/main/main.startup-timer'))

function fakeFs(overrides = {}) {
  return {
    existsSync: Object.assign(() => true, overrides.existsSync || {}),
    readFileSync: Object.assign(() => 'content', overrides.readFileSync || {}),
    mkdirSync: () => undefined,
  }
}

test('开关未开启时不安装，fs 方法保持原引用', () => {
  io.reset()
  const f = fakeFs()
  const orig = f.existsSync
  assert.equal(io.install(f, { enabled: false }), false)
  assert.equal(f.existsSync, orig)
  assert.equal(io.isInstalled(), false)
  assert.deepEqual(io.collect(), { calls: 0, ms: 0, rows: [] })
})

test('开启后按方法计数，返回值与异常原样透传', () => {
  io.reset()
  const f = fakeFs()
  f.readFileSync = () => { throw new Error('boom') }
  assert.equal(io.install(f, { enabled: true }), true)
  assert.equal(io.isInstalled(), true)

  // 返回值透传
  assert.equal(f.existsSync('a'), true)
  assert.equal(f.mkdirSync('d'), undefined)
  // 异常透传，但仍然计数
  assert.throws(() => f.readFileSync('b'), /boom/)

  const r = io.collect()
  assert.equal(r.calls, 3)
  assert.ok(r.ms >= 0)
  const byName = Object.fromEntries(r.rows.map((x) => [x.name, x.count]))
  assert.equal(byName.existsSync, 1)
  assert.equal(byName.mkdirSync, 1)
  assert.equal(byName.readFileSync, 1)
})

test('重复 install 不叠加，summarize 打印合计并写入启动时间线', () => {
  io.reset()
  const f = fakeFs()
  assert.equal(io.install(f, { enabled: true }), true)
  assert.equal(io.install(f, { enabled: true }), false, '第二次安装应被忽略')

  f.existsSync('a')
  const lines = []
  const r = io.summarize({ console: { log: (s) => lines.push(String(s)) } })
  assert.ok(r, 'summarize 应返回汇总')
  assert.equal(r.calls, 1)
  assert.match(lines[0], /^\[boot\] 同步IO合计 /)
  assert.ok(lines.some((l) => /fs\.existsSync .* × 1$/.test(l)))

  const timeline = timer.getTimeline()
  assert.ok(
    timeline.marks.some((m) => m.label.startsWith('同步IO合计 ')),
    '时间线里必须有一条同步 IO 合计 mark'
  )
})

test('未安装时 summarize 是空操作', () => {
  io.reset()
  assert.equal(io.summarize({ console: { log: () => { throw new Error('不该打印') } } }), null)
})

test('接线判据：安装了 main.js，且顺序正确', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.js'), 'utf8')
  const installAt = src.indexOf('startupIo.install(fs)')
  const firstSyncIoAt = src.indexOf('fs.mkdirSync(_ccDir')
  assert.ok(installAt > 0, 'main.js 必须调用 startupIo.install(fs)')
  assert.ok(firstSyncIoAt > 0, 'main.js 必须保留启动路径上的首个同步 IO（node-compile-cache 建目录）')
  assert.ok(firstSyncIoAt > installAt, '安装必须早于首个同步 IO 调用（node-compile-cache 建目录）')

  const summarizeAt = src.indexOf('startupIo.summarize()')
  const reportAt = src.indexOf('startupTimer.report()', summarizeAt > 0 ? summarizeAt : 0)
  assert.ok(summarizeAt > 0, 'onFinal 里必须调用 startupIo.summarize()')
  assert.ok(reportAt > summarizeAt, 'summarize 必须早于 report，否则时间线漏这条')

  const impl = fs.readFileSync(path.join(ROOT, 'electron/main/main.startup-io.js'), 'utf8')
  assert.match(impl, /PERF_STARTUP === '1'/, '默认必须由 PERF_STARTUP 开关门控（默认零开销）')
})

// v6 · 2-21：fork→就绪空档拆段（fork 发起 / 子进程 spawn / 入口 / 监听成功 四戳）
test('2-21 接线：fork 与子进程入口都带 epoch，且默认零开销', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'electron/main/main.backend.js'), 'utf8')
  assert.match(backend, /_bootMark\('fork 发起'\)/, '打包分支必须记录 fork 发起时刻')
  assert.match(backend, /_bootMark\('fork 发起（dev）'\)/, '开发分支同样要记录')
  assert.match(backend, /child\.once\('spawn'/, '必须有 spawn 事件戳（区分进程创建与 Node 引导）')
  assert.match(backend, /process\.env\.PERF_STARTUP === '1'/, '打点必须由 PERF_STARTUP 门控')

  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  assert.match(app, /_bootEpoch/, '后端入口/监听成功必须带绝对 epoch，供主进程按同一时钟相减')
  assert.match(app, /process\.env\.PERF_STARTUP === '1'/, 'epoch 只在 PERF_STARTUP=1 时追加')
})
