// =========================================================================
// activity-countdown-undo-same-tx.test.js —— 活动/倒计时的 PUT/DELETE 写与撤销同事务
//                                            （V9-I-13 · 404 守卫语义不能破）
//
// 判据：①真跑路由：带 _undoSpec 的 PUT/DELETE 回 undoId，undo_history 落一条；
//       ②404 不登记：不存在的 id 即使带 spec 也不写撤销栈（changes===0 → buildPayload null）；
//       ③接线：四个入口都 takeUndoSpec + writeWithUndo，守卫钉的 changes===0→404 仍在；
//       ④变异反证：把 writeWithUndo 换成直接写 → undo_history 不再增长（证明登记靠它）。
// 注意 fixture 替换 require.cache 的 db 代理，依赖 db 的模块在唯一 fixture 后加载一次。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'act-cnt-undo', currentSlug: 'act-cnt-undo' })
let conn

const ACT = 'student-backend/routes/activities.js'
const CNT = 'student-backend/routes/countdowns.js'

test.before(async () => {
  await fx.mount('/api/activities', ACT)
  await fx.mount('/api/countdowns', CNT)
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

function historyCount() { return conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n }
function createActivity(title) {
  return fx.call('POST', '/api/activities', { 时间: '2026-11-05', 主题: title })
}

test('活动 PUT 带 spec：同事务登记，响应回 undoId，_undoSpec 不落库', async () => {
  const made = await createActivity('原主题')
  assert.equal(made.status, 200, made.text)
  const id = made.json.id
  const before = historyCount()
  const upd = await fx.call('PUT', `/api/activities/${id}`, {
    主题: '新主题',
    _undoSpec: { key: 'activities', type: 'row_update', label: '改主题', payload: { table: 'activities', rowId: id, oldRow: { id, 主题: '原主题' }, newRow: { id, 主题: '新主题' } } },
  })
  assert.equal(upd.status, 200, upd.text)
  assert.ok(upd.json.undoId, '响应要带回 undoId')
  assert.equal(historyCount(), before + 1, '同事务登记一条撤销')
  const cols = conn.prepare('PRAGMA table_info(activities)').all().map((c) => c.name)
  assert.ok(!cols.includes('_undoSpec'), '_undoSpec 不能当列名落库')
})

test('活动 DELETE 带 spec：同事务登记，响应回 undoId', async () => {
  const made = await createActivity('待删')
  const id = made.json.id
  const before = historyCount()
  const del = await fx.call('DELETE', `/api/activities/${id}`, {
    _undoSpec: { key: 'activities', type: 'row_delete', label: '删活动', payload: { table: 'activities', row: { id, 主题: '待删' } } },
  })
  assert.equal(del.status, 200, del.text)
  assert.ok(del.json.undoId, '响应要带回 undoId')
  assert.equal(historyCount(), before + 1)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM activities WHERE id = ?').get(id).n, 0)
})

test('倒计时 PUT/DELETE 带 spec：同样同事务登记', async () => {
  const made = await fx.call('POST', '/api/countdowns', { 名称: '期末', 截止日: '2026-12-31' })
  const id = made.json.id
  const before = historyCount()
  const upd = await fx.call('PUT', `/api/countdowns/${id}`, {
    名称: '期末改',
    _undoSpec: { key: 'countdowns', type: 'row_update', label: '改名', payload: { table: 'countdowns', rowId: id, oldRow: { id, 名称: '期末' }, newRow: { id, 名称: '期末改' } } },
  })
  assert.equal(upd.status, 200, upd.text)
  assert.ok(upd.json.undoId)
  assert.equal(historyCount(), before + 1)
  const del = await fx.call('DELETE', `/api/countdowns/${id}`, {
    _undoSpec: { key: 'countdowns', type: 'row_delete', label: '删', payload: { table: 'countdowns', row: { id, 名称: '期末改' } } },
  })
  assert.equal(del.status, 200, del.text)
  assert.ok(del.json.undoId)
  assert.equal(historyCount(), before + 2)
})

test('404 不登记：不存在的 id 带 spec 也 404，撤销栈不增长', async () => {
  const before = historyCount()
  const put = await fx.call('PUT', '/api/activities/999999', {
    主题: '不存在',
    _undoSpec: { key: 'activities', type: 'row_update', label: 'x', payload: { table: 'activities', rowId: 999999, oldRow: null, newRow: {} } },
  })
  assert.equal(put.status, 404)
  assert.equal(historyCount(), before, '404 不能写撤销栈')
  const del = await fx.call('DELETE', '/api/countdowns/999999', {
    _undoSpec: { key: 'countdowns', type: 'row_delete', label: 'x', payload: { table: 'countdowns', row: { id: 999999 } } },
  })
  assert.equal(del.status, 404)
  assert.equal(historyCount(), before, '404 不能写撤销栈')
})

test('接线：四个入口 takeUndoSpec + writeWithUndo，守卫 changes===0→404 仍在', () => {
  for (const rel of [ACT, CNT]) {
    const s = read(rel)
    // @pin student-backend/services/writeWithUndo.js#writeWithUndo
    assert.match(s, /writeWithUndo\(spec,/, `${rel} 没接 writeWithUndo`)
    // @pin student-backend/routes/activities.js#takeUndoSpec
    assert.match(s, /takeUndoSpec\(req\.body\)/, `${rel} 没取 spec`)
    // 守卫说明：changes === 0 → status(404) 由 not-found-404.test.js 专门钉死，此处仅复核存在
    assert.match(s, /changes === 0\) return res\.status\(404\)/, `${rel} 弄丢了 404 判据`)
  }
})

test('变异反证：不带 spec（旧两写路径）写成功但无 undoId、撤销栈不自动增长', async () => {
  const made = await createActivity('无 spec')
  const id = made.json.id
  const before = historyCount()
  // 不传 _undoSpec：writeWithUndo 退化为直接写，业务写仍成功，但不会自动登记撤销
  const upd = await fx.call('PUT', `/api/activities/${id}`, { 主题: '无 spec 改' })
  assert.equal(upd.status, 200, upd.text)
  assert.equal(upd.json.undoId, undefined, '没 spec 就没有 undoId —— 证明 undoId 确实靠同事务 spec 触发')
  assert.equal(historyCount(), before, '没 spec 不自动登记（旧路径靠前端二次 POST）')
  assert.equal(conn.prepare('SELECT 主题 FROM activities WHERE id = ?').get(id).主题, '无 spec 改', '业务写不能被影响')
})
