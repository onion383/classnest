// =========================================================================
// score-leave-undo-same-tx.test.js —— 成绩/请假的 PUT/DELETE 写与撤销同事务
//                                     （V9-I-13 · 404 语义与认人逻辑不能破）
// 判据：①真跑路由：带 spec 的 PUT/DELETE 回 undoId，undo_history 增长；
//       ②两种 payload：cell_update 逐字段、row_update 整行都按前端 spec 原样登记；
//       ③404 不登记：不存在 id 带 spec 仍 404，撤销栈不增长；
//       ④变异反证：不带 spec 写成功但无 undoId、栈不自动增长。
// fixture 替换 db 代理，依赖 db 的模块在唯一 fixture 后加载一次。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'score-leave-undo', currentSlug: 'score-leave-undo' })
let conn

test.before(async () => {
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

function count() { return conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n }
function lastPayload() {
  return JSON.parse(conn.prepare('SELECT payload FROM undo_history ORDER BY id DESC LIMIT 1').get().payload)
}
function seedScore(name) {
  conn.prepare("INSERT INTO score_records (姓名, 类型, 项目, 分值) VALUES (?, '加分', '测试', 1)").run(name)
  return conn.prepare('SELECT id FROM score_records ORDER BY id DESC LIMIT 1').get().id
}

test('成绩 PUT 带 cell_update spec：同事务登记，payload 原样保留', async () => {
  const id = seedScore('张三')
  const before = count()
  const res = await fx.call('PUT', `/api/scores/${id}`, {
    '项目': '改项目',
    _undoSpec: { key: 'score_records', type: 'cell_update', label: '改项目', payload: { table: 'score_records', rowId: id, field: '项目', oldValue: '测试', newValue: '改项目' } },
  })
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.undoId, '回 undoId')
  assert.equal(count(), before + 1)
  const p = lastPayload()
  assert.equal(p.field, '项目', '逐字段 payload 必须原样登记，不能被 row_update 覆盖')
  assert.equal(p.oldValue, '测试')
  assert.equal(p.newValue, '改项目')
})

test('成绩 DELETE 带 row_delete spec：同事务登记，整行 inverse 保留', async () => {
  const id = seedScore('李四')
  const before = count()
  const res = await fx.call('DELETE', `/api/scores/${id}`, {
    _undoSpec: { key: 'score_records', type: 'row_delete', label: '删', payload: { table: 'score_records', row: { id, 姓名: '李四' } } },
  })
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.undoId)
  assert.equal(count(), before + 1)
  assert.equal(lastPayload().row.姓名, '李四')
})

test('请假 PUT 带 row_update spec：同事务登记', async () => {
  conn.prepare("INSERT INTO leave_records (姓名, 状态) VALUES ('王五', '请假中')").run()
  const id = conn.prepare('SELECT id FROM leave_records ORDER BY id DESC LIMIT 1').get().id
  const before = count()
  const res = await fx.call('PUT', `/api/leaves/${id}`, {
    状态: '已返校',
    _undoSpec: { key: 'leave_records', type: 'row_update', label: '改', payload: { table: 'leave_records', rowId: id, oldRow: { id, 状态: '请假中' }, newRow: { id, 状态: '已返校' } } },
  })
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.undoId)
  assert.equal(count(), before + 1)
  assert.equal(lastPayload().newRow.状态, '已返校')
})

test('404 不登记：不存在 id 带 spec 仍 404，撤销栈不增长', async () => {
  const before = count()
  const put = await fx.call('PUT', '/api/scores/999999', {
    项目: 'x',
    _undoSpec: { key: 'score_records', type: 'cell_update', label: 'x', payload: { table: 'score_records', rowId: 999999, field: '项目', oldValue: '', newValue: 'x' } },
  })
  assert.equal(put.status, 404)
  assert.equal(count(), before, '404 不写撤销栈')
})

test('变异反证：不带 spec 写成功但无 undoId、撤销栈不自动增长', async () => {
  const id = seedScore('赵六')
  const before = count()
  const res = await fx.call('PUT', `/api/scores/${id}`, { 项目: '无 spec' })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.undoId, undefined, '没 spec 就没有 undoId')
  assert.equal(count(), before, '没 spec 不自动登记')
})
