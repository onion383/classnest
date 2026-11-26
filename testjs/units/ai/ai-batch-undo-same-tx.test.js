// =========================================================================
// ai-batch-undo-same-tx.test.js —— AI 写的撤销登记与写入同事务（V9-2-5）
//
// 判据：apply-batch / doc 带 _undoSpec 时，后端在同一事务里用写结果生成 payload 并登记，
// 响应回 undoId(s)。单一 fixture 实例 —— createBackendDb 会替换 require.cache 里的 db 代理，
// 多实例互覆盖会让路由/undoStore 持有旧连接。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'ai-batch-same-tx' })

test('apply-batch 带 _undoSpecs：后端同事务登记，undoIds 与 ops 一一对应', async () => {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)').run(1, 1, '张三')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)').run(2, 2, '李四')
  const base = await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
  const res = await fetch(base + '/apply-batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ops: [
        { action: 'update', table: 'students', id: 1, changes: { '姓名': '王五' } },
        { action: 'delete', table: 'students', id: 2 },
      ],
      _undoSpecs: [
        { key: 'students', type: 'row_update', label: 'AI 改名', payload: {} },
        { key: 'students', type: 'row_delete', label: 'AI 删除', payload: {} },
      ],
    }),
  })
  const j = await res.json()
  assert.equal(res.status, 200, JSON.stringify(j))
  assert.equal(j.undoIds.length, 2, '两条写各登记一条撤销')
  const undoRows = j.undoIds.map((id) => conn.prepare('SELECT type, payload FROM undo_history WHERE id = ?').get(id))
  assert.ok(undoRows.every(Boolean), '两条撤销记录都要落库')
  const updated = JSON.parse(undoRows[0].payload)
  assert.equal(undoRows[0].type, 'row_update')
  assert.equal(updated.oldRow['姓名'], '张三', 'payload 用写前快照，由后端生成')
  assert.equal(updated.newRow['姓名'], '王五')
  assert.equal(undoRows[1].type, 'row_delete')
})

test('不传 _undoSpecs 时保持旧行为（前端自行登记），后端不额外登记', async () => {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)').run(1, 1, '张三')
  const base = await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
  const res = await fetch(base + '/apply-batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: [{ action: 'update', table: 'students', id: 1, changes: { '姓名': '李四' } }] }),
  })
  const j = await res.json()
  assert.equal(res.status, 200, JSON.stringify(j))
  assert.deepEqual(j.undoIds, [], '没有 spec 就不登记')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 0)
})

test('/api/ai/doc 带 _undoSpec：before/after 由后端同事务生成并登记', async () => {
  const conn = fx.reset()
  conn.prepare("INSERT INTO students (position, 学号, 姓名) VALUES (1,'001','张三')").run()
  conn.prepare("INSERT INTO students (position, 学号, 姓名) VALUES (2,'002','李四')").run()
  const base = await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
  const res = await fetch(base + '/doc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      table: 'duty_layout', id: 1,
      values: { cells: { daily: { 扫地: { 周一: ['张三', '李四'] } }, big: {} } },
      _undoSpec: { key: '值日表', type: 'doc_update', label: 'AI 改值日', payload: {} },
    }),
  })
  const j = await res.json()
  assert.equal(res.status, 200, JSON.stringify(j))
  assert.ok(j.undoId, '响应带回 undoId')
  const row = conn.prepare('SELECT payload FROM undo_history WHERE id = ?').get(j.undoId)
  assert.ok(row, '撤销记录落库')
  const payload = JSON.parse(row.payload)
  assert.equal(payload.table, 'duty_layout')
  assert.ok(payload.before && payload.after, 'payload 含写前写后值')
})

test.after(() => fx.close())
