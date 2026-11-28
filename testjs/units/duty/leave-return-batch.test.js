// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// leave-return-batch.test.js —— 批量销假端点（v8 · P3-11）
//
// 事故面：请假页「全部销假」对逾期名单逐条串行 POST，40 人 = 40 次 loopback；
// 一条慢或失败都要等完，且半途失败会留下「一半已销、一半未销」的列表。
//
// 覆盖：
//   ① 一次请求写完全部 id，重复 id 去重、按 id 返回成功项；
//   ② 不存在的 id 只进 missingIds，合法项照常写入（与前端「一条失败不影响其余」一致）；
//   ③ 非法/空/超量入参 → 400，且一行都不写；
//   ④ 单条 POST /:id/return 仍保留（行内「销假」走它）；
//   ⑤ 前端接线：全部销假只发 1 个 return-batch 请求。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'leave-return-batch' })
const conn = fx.conn

const ins = conn.prepare(
  'INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间, 状态, 返校时间, 备注, position) VALUES (?,?,?,?,?,?,?,?,?)'
)
conn.transaction(() => {
  for (let i = 0; i < 4; i++) {
    ins.run(null, `学生${i + 1}`, '事假', '2026-09-01 08:00', '2026-09-01 17:00', '请假中', null, '', i + 1)
  }
})()
const ids = conn.prepare('SELECT id FROM leave_records ORDER BY id').all().map((r) => r.id)

let base
test.before(async () => {
  base = await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
})
test.after(() => fx.close())

const statusOf = (id) => conn.prepare('SELECT 状态, 返校时间 FROM leave_records WHERE id = ?').get(id)
const post = async (p, body) => (await fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

test('一次请求销假多条：重复 id 去重、成功项全部落库', async () => {
  const j = await post('/return-batch', { ids: [ids[0], ids[1], ids[1]] })
  assert.equal(j.updated, 2)
  assert.deepEqual(j.updatedIds.sort((a, b) => a - b), [ids[0], ids[1]])
  assert.deepEqual(j.missingIds, [])
  for (const id of [ids[0], ids[1]]) {
    const row = statusOf(id)
    assert.equal(row.状态, '已返校')
    assert.ok(row.返校时间, '返校时间必须写入')
  }
  assert.equal(statusOf(ids[2]).状态, '请假中', '未选中的记录不能被连带改掉')
})

test('不存在的 id 只进 missingIds，合法项照常写入', async () => {
  const j = await post('/return-batch', { ids: [ids[2], 999999] })
  assert.equal(j.updated, 1)
  assert.deepEqual(j.updatedIds, [ids[2]])
  assert.deepEqual(j.missingIds, [999999])
  assert.equal(statusOf(ids[2]).状态, '已返校')
})

test('非法 / 空 / 超量入参 → 400 且不写库', async () => {
  for (const body of [{}, { ids: 'x' }, { ids: [] }, { ids: [0, -1, 'a'] }]) {
    const r = await fx.call('POST', '/return-batch', body)
    assert.equal(r.status, 400, `入参 ${JSON.stringify(body)} 应拒绝`)
  }
  const tooMany = Array.from({ length: 501 }, (_, i) => i + 1)
  const r = await fx.call('POST', '/return-batch', { ids: tooMany })
  assert.equal(r.status, 400)
  assert.equal(statusOf(ids[3]).状态, '请假中', '被拒的请求不能留下半写状态')
})

test('单条销假端点仍保留', async () => {
  const j = await post(`/${ids[3]}/return`, {})
  assert.equal(j.message, '已销假')
  assert.equal(statusOf(ids[3]).状态, '已返校')
})

test('前端接线：全部销假只发 1 个 return-batch 请求', () => {
  const src = fs.readFileSync(
    abs('student-frontend/src/views/LeaveManagement.vue'),
    'utf8',
  )
  const start = src.indexOf('async function runOverdueReturnAll(')
  const end = src.indexOf('async function submitAdd(', start)
  assert.ok(start > 0 && end > start, '找不到 runOverdueReturnAll 方法区间')
  const block = src.slice(start, end)
  assert.match(block, /leaves\/return-batch/, '批量销假必须走批量端点')
  assert.equal((block.match(/axios\.post\(/g) || []).length, 1, '整批只允许发 1 个请求')
  assert.ok(!/leaves\/\$\{rec\.id\}\/return/.test(block), '不能退回逐条销假')
})
