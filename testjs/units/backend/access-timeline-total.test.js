// =========================================================================
// access-timeline-total.test.js —— 访问记录时间线的「条数口径」（#33）
//
// 三个数字各有各的用途，混用就是用户可见的错误：
//   total          当前来源视图的条数          → 弹窗行尾「已记 N 条」/ 清空按钮可用性
//   retentionTotal 全表原始条数（两来源合计）  → 改小 keep 的丢历史确认
//   logs           合并、筛选、截断后的时间线  → 列表本身
//
// 修复前 total 取的是「截断后的数组长度」：读侧只拉 500 条，per_day 还会合并，
// 于是 620 条也只报 500；前端拿它和 keep 比，改小保留条数时不弹确认，后端却真删。
// 另外 onlyAbnormal 是在内存里筛的，窗口外的旧 denied 永远进不了异常视图。
//
// 手法：真内存库 + 真 store（不 mock SQL），直接调 services/accessTimeline。
// =========================================================================
const test = require('node:test')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'access-timeline-total', extraDbExports: { renumber: () => {} } })

// 夹具装好内存库之后再 require（store 顶层 require('../db') 会持有代理）
const accessLog = require('../../../student-backend/services/accessLogStore')
const aiConfigStore = require('../../../student-backend/services/aiConfigStore')
const timeline = require('../../../student-backend/services/accessTimeline')

test.after(() => fx.close())

// 每个用例都从「永久保留」起步：默认 keep=500 会在每次写入后把表裁到 500 条，
// 想验证「超过 500 条」就永远灌不进去（最早的那条 denied 会先被裁掉）。
test.beforeEach(() => {
  fx.reset()
  aiConfigStore.setLogConfig({ keep: 0, granularity: 'per_call' })
})

function rec(patch) {
  accessLog.record({ source: 'ai', tool: 'query', target: 'students', amount: 1, ...patch })
}

test('超过 500 条时 total 报真实条数，不是窗口长度', () => {
  for (let i = 0; i < 620; i += 1) rec({ target: `t${i}` })

  const out = timeline.list({ source: 'ai', limit: 200 })
  assert.equal(out.logs.length, 200, '默认 cap 仍是 200，列表不该因为改了 total 就变长')
  assert.equal(out.total, 620, `total 应为真实条数 620，实际 ${out.total}`)
})

test('per_day 合并后 total 仍按原始行数报（合并只是查看方式）', () => {
  for (let i = 0; i < 40; i += 1) rec({ target: 'students' })
  aiConfigStore.setLogConfig({ granularity: 'per_day' })

  const out = timeline.list({ source: 'ai', limit: 200 })
  assert.ok(out.logs.length < 40, 'per_day 下同一天同工具同目标应合并成少量行')
  assert.equal(out.total, 40, 'total 不随查看粒度变')
})

test('retentionTotal 是全表原始总数（两个来源合计），与当前来源无关', () => {
  for (let i = 0; i < 30; i += 1) rec({ target: 'students' })
  for (let i = 0; i < 45; i += 1) rec({ source: 'mcp', target: 'scores' })

  const ai = timeline.list({ source: 'ai', limit: 200 })
  assert.equal(ai.total, 30, '来源视图只看自己这 30 条')
  assert.equal(ai.retentionTotal, 75, '保留条数是全局的，要报两来源合计 75 条')

  const mcp = timeline.list({ source: 'mcp', limit: 200 })
  assert.equal(mcp.total, 45)
  assert.equal(mcp.retentionTotal, 75, '两个面板看到同一个 retentionTotal')
})

test('异常筛选会在 SQL 层分页前生效：窗口外的旧 denied 也能筛出来', () => {
  // 最早的一条是 denied —— 之后堆 620 条正常记录把它挤出 500 条窗口
  rec({ result: 'denied', reason: '该表已在设置中关闭 AI 读取（students）' })
  for (let i = 0; i < 620; i += 1) rec({ target: `t${i}` })

  const bad = timeline.list({ source: 'ai', onlyAbnormal: true, limit: 200 })
  assert.equal(bad.logs.length, 1, '窗口外的 denied 必须仍出现在异常视图里')
  assert.equal(bad.logs[0].result, 'denied')
  assert.equal(bad.total, 1, '异常视图的 total 只数异常条数')
  assert.equal(bad.retentionTotal, 621, 'retentionTotal 不受异常筛选影响')
})

test('异常筛选下 total 不把普通写入/提案算进去', () => {
  rec({ result: 'failed', reason: '读取失败：no such column' })
  for (let i = 0; i < 5; i += 1) rec({ target: `t${i}` })

  const bad = timeline.list({ source: 'ai', onlyAbnormal: true, limit: 200 })
  assert.equal(bad.total, 1, '只有那一条 failed')
})

// ---------------------------------------------------------------------------
// 前端接线：确认框必须按全表条数判断，不能按当前来源视图
// ---------------------------------------------------------------------------

// 从 .vue 源码里抠出 `function name(...) { ... }` 的函数体（大括号配平）
test('前端 onKeep 用全表条数判断（来源视图条数不够）', () => {
  const file = abs('student-frontend/src/components/data-manage/AccessLogDialog.vue')
  const src = fs.readFileSync(file, 'utf8')
  const fnSrc = extractFunctionDecl(src, 'onKeep')

  // 造一个「本来源 20 条、全表 800 条」的弹窗状态：改成 100 时必须弹确认
  const pendingKeep = { value: null }
  let applied = null
  const factory = new Function(
    'pendingKeep', 'retentionTotal', 'total', 'applyKeep',
    `${fnSrc}\nreturn onKeep;`,
  )
  const onKeep = factory(pendingKeep, { value: 800 }, { value: 20 }, (v) => { applied = v })

  onKeep(100)
  assert.equal(pendingKeep.value, 100, '全表 800 条 > 100，必须先确认（不能只看来源视图的 20 条）')
  assert.equal(applied, null, '确认前不该真的写配置')

  // 全表也不超限时直接设置，不打扰用户
  pendingKeep.value = null
  onKeep(2000)
  assert.equal(applied, 2000, '不丢历史时直接生效')
})

test('前端确认文案报的是全表条数', () => {
  const file = abs('student-frontend/src/components/data-manage/AccessLogDialog.vue')
  const src = fs.readFileSync(file, 'utf8')
  const start = src.indexOf('const shrinkMessage = computed(')
  assert.ok(start >= 0, '找不到 shrinkMessage')
  const seg = src.slice(start, src.indexOf('\n\n', start))
  assert.match(seg, /retentionTotal\.value/, '确认文案必须按全表条数说明会丢多少')
  assert.doesNotMatch(seg, /(?<!retention)total\.value/, '不能再用来源视图条数（少报会让用户误判）')
})
