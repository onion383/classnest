// =========================================================================
// event-loop-stats.test.js —— 主进程事件循环延迟观测（v6 性能专题 · 0-7）
//
// 验收点：
//   ① ns → ms 的口径正确、空 histogram 返回 null；
//   ② start 幂等，read 能给出完整分位数，stop 后不再读数；
//   ③ 接线：perf-snapshot 带 eventLoop、启动后有一个观测窗口、内存首采延后并计耗时。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MAIN = path.join(__dirname, '../../electron/main')
const read = (rel) => fs.readFileSync(path.join(MAIN, rel), 'utf8')

// 每次测试前清掉模块缓存，避免模块级 histogram 串扰
function loadEventLoop() {
  const file = path.join(MAIN, 'main.eventloop.js')
  delete require.cache[file]
  return require(file)
}

function fakeHistogram(values = {}) {
  return {
    // 50 分位落在下标 2 → 30ms；95/99 落在下标 3 → 40ms
    p: values.p || [1_000_000, 2_000_000, 30_000_000, 40_000_000],
    count: values.count == null ? 9 : values.count,
    max: values.max == null ? 50_400_000 : values.max,
    percentile(n) { return this.p[Math.min(this.p.length - 1, Math.floor(n / 25))] || 0 },
  }
}

test('ns → ms 保留 1 位小数，空 histogram 返回 null', () => {
  const { statsFromHistogram } = loadEventLoop()
  assert.equal(statsFromHistogram(null), null)
  const stats = statsFromHistogram(fakeHistogram())
  assert.deepEqual(stats, { p50: 30, p95: 40, p99: 40, max: 50.4, count: 9 })
})

test('start 幂等；read 给出完整分位数；stop 后返回 null', () => {
  const { startEventLoopSampling, readEventLoopStats, stopEventLoopSampling } = loadEventLoop()
  const a = startEventLoopSampling()
  const b = startEventLoopSampling()
  assert.equal(a, b, '重复 start 必须复用同一个 histogram')
  assert.ok(a, 'Node 环境下 monitorEventLoopDelay 应可用')

  const stats = readEventLoopStats()
  for (const key of ['p50', 'p95', 'p99', 'max', 'count']) {
    assert.equal(typeof stats[key], 'number', `${key} 必须是数字`)
  }
  assert.ok(stats.max >= 0 && stats.count >= 0)

  stopEventLoopSampling()
  assert.equal(readEventLoopStats(), null, 'stop 后应返回 null')
})

test('接线：启动窗口观测、perf-snapshot 带 eventLoop、内存首采延后并计耗时', () => {
  const perf = read('main.perf.js')
  assert.match(perf, /require\('\.\/main\.eventloop'\)/)
  assert.match(perf, /startEventLoopSampling\(\)/)
  assert.match(perf, /markEventLoopWindow\('启动后'\)/)
  assert.match(perf, /eventLoop: readEventLoopStats\(\{ reset: true \}\)/)
  assert.match(perf, /MEM_FIRST_DELAY/)
  assert.match(perf, /process\.hrtime\.bigint\(\)/)
  assert.match(perf, /> 30/)
  assert.match(perf, /启动后1s/, '2-16 必须在首屏窗口内读一次主进程事件循环分位数')
  assert.match(perf, /PERF_STARTUP/, '该窗口读数必须受显式开关控制')
})

test('统计输出只在超阈值时打日志（源码判据，避免正常路径刷屏）', () => {
  const src = read('main.eventloop.js')
  assert.match(src, /WARN_MAX_MS = 50/)
  assert.match(src, /WARN_P95_MS = 30/)
  assert.match(src, /stats\.max >= WARN_MAX_MS \|\| stats\.p95 >= WARN_P95_MS/)
})
