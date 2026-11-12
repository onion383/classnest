// =========================================================================
// inp-longtask.test.js —— 主线程长任务观察（v6 性能专题 · 0-2）
//
// 这张卡的验收不是「卡顿消失」，而是「不挂交互的主线程阻塞能被看见」：
//   ① 16ms 起记录，15ms 的噪声不进来；
//   ② 不支持的浏览器/内核不装配观察器，事件观察者照常工作；
//   ③ observe 抛错、单条 onRecord 抛错都不影响后续；
//   ④ 渲染层确实把 longTasks 汇总进 dump 并落 inp.log，reset 能清空。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.join(__dirname, '../../student-frontend')
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
const load = () => import(pathToFileURL(path.join(FRONTEND, 'src/utils/inpLongtask.js')).href)

// 假观察器：保留回调与 observe 参数，测试里手动 emit
class FakeObserver {
  constructor(cb) {
    this.cb = cb
    this.opts = null
    FakeObserver.last = this
  }
  observe(opts) {
    this.opts = opts
  }
  emit(entries) {
    this.cb({ getEntries: () => entries })
  }
}

test('16ms 起记录，15ms 及以下不记录', async () => {
  const { LONG_TASK_MIN, isLongTask } = await load()
  assert.equal(LONG_TASK_MIN, 16)
  assert.equal(isLongTask({ duration: 15.9 }), false)
  assert.equal(isLongTask({ duration: 16 }), true)
  assert.equal(isLongTask(null), false)
})

test('长任务行四舍五入并带上路由/目标归属', async () => {
  const { longTaskRow } = await load()
  const row = longTaskRow({ duration: 42.6, name: 'self' }, { route: '#/seat', target: 'button#save' })
  assert.deepEqual(row, { 时长: 43, 名称: 'self', 路由: '#/seat', 目标: 'button#save' })
  const bare = longTaskRow({ duration: 20 })
  assert.deepEqual(bare, { 时长: 20, 名称: 'unknown', 路由: '', 目标: '' })
})

test('内核不支持 longtask 时不装配观察器', async () => {
  const { createLongtaskObserver } = await load()
  let called = 0
  const observer = createLongtaskObserver({
    Observer: FakeObserver,
    supported: false,
    onRecord: () => called++,
  })
  assert.equal(observer, null)
  assert.equal(called, 0)
})

test('只把达标条目交给 onRecord，一条失败不影响后续', async () => {
  const { createLongtaskObserver } = await load()
  const seen = []
  const observer = createLongtaskObserver({
    Observer: FakeObserver,
    supported: true,
    onRecord: (entry) => {
      seen.push(entry.duration)
      if (entry.duration === 20) throw new Error('单条归属失败')
    },
  })
  assert.ok(observer)
  assert.deepEqual(observer.opts, { type: 'longtask', buffered: true })
  assert.doesNotThrow(() => observer.emit([
    { duration: 15 },
    { duration: 20 },
    { duration: 40 },
  ]))
  assert.deepEqual(seen, [20, 40], '20ms 那条抛错后，40ms 仍必须被记录')
})

test('observe 抛错时返回 null 并走告警出口', async () => {
  const { createLongtaskObserver } = await load()
  class Broken extends FakeObserver {
    observe() { throw new Error('不支持该 entryType') }
  }
  let warned = null
  const observer = createLongtaskObserver({
    Observer: Broken,
    supported: true,
    onRecord: () => {},
    warn: (err) => { warned = err },
  })
  assert.equal(observer, null)
  assert.match(String(warned && warned.message), /不支持/)
})

test('打包版按需采样：≥min 才记、最多 max 条、带 route 与 epoch', async () => {
  const { installLongTaskMarks } = await load()
  const lines = []
  const orig = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    const observer = installLongTaskMarks({
      min: 50,
      max: 2,
      Observer: FakeObserver,
      supported: true,
      now: (entry) => 1000 + (entry.startTime || 0),
    })
    assert.ok(observer)
    observer.emit([{ duration: 40, startTime: 10 }, { duration: 120, startTime: 20 }, { duration: 90, startTime: 30 }, { duration: 80, startTime: 40 }])
  } finally {
    console.log = orig
  }
  assert.equal(lines.length, 2, '低于 min 的不记，超过 max 的丢弃')
  assert.match(lines[0], /^\[startup\] 长任务 120ms .* @1020$/)
  assert.match(lines[1], /^\[startup\] 长任务 90ms .* @1030$/)
})

test('打包版采样接线：preload 开关、web-prefs 参数、入口调用、主进程放行', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../../electron/preload.js'), 'utf8')
  assert.match(preload, /__PERF_LONG_TASK__/)
  const prefs = fs.readFileSync(path.join(__dirname, '../../electron/main/main.web-prefs.js'), 'utf8')
  assert.match(prefs, /PERF_LONG_TASK === '1'/)
  assert.match(prefs, /--perf-long-task/)
  const entry = read('src/main.js')
  assert.match(entry, /installLongTaskMarks\(\)/)
  const main = fs.readFileSync(path.join(__dirname, '../../electron/main/main.js'), 'utf8')
  assert.match(main, /'长任务'/)
})

test('渲染层接线：dump 带 longTasks、reset 清空、主进程落盘有长任务段', () => {
  const probe = read('src/utils/inpProbe.js')
  assert.match(probe, /createLongtaskObserver/, '必须复用纯模块装配，不能各写一份观察器')
  assert.match(probe, /supportedEntryTypes\?\.includes\?\.\('longtask'\)/)
  assert.match(probe, /longTasks\.push/)
  assert.match(probe, /longTasks\.splice\(/, '长任务必须有上限，不能让 dev 长会话无限涨')
  assert.match(probe, /longTasks\.length = 0/, 'reset 必须清空长任务')
  assert.match(probe, /\{ reason, categories, details, longTasks \}/, '长任务必须随 INP_REPORT 落盘')

  const log = fs.readFileSync(path.join(__dirname, '../../electron/main/main.inpLog.js'), 'utf8')
  assert.match(log, /Array\.isArray\(p\.longTasks\)/)
  assert.match(log, /formatLongTasks/)
  assert.match(log, /主线程长任务/)
})
