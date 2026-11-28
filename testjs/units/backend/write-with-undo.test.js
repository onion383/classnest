// =========================================================================
// write-with-undo.test.js —— 写与撤销登记同事务（V9-I-13 / Q2-01）
//
// 判据：①真跑 writeWithUndo：写+登记带回 undoId、失败整笔回滚；
//       ②真跑 EXPRESS 路由：POST 带 _undoSpec 同事务登记，_undoSpec 不当列名落库；
//       ③变异反证：无事务包裹时写失败数据仍在（证明回滚确实靠事务）。
//
// 注意：fixture 替换 require.cache 里的 db 模块，所有依赖 db 的模块只在
// 唯一 fixture 建好后加载一次；各用例用 fx.reset() 换干净库。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'write-undo' })
const { writeWithUndo, takeUndoSpec, validSpec } = require(abs('student-backend/services/writeWithUndo.js'))
const { createDynamicTableRouter } = require(abs('student-backend/routes/dynamicTable.js'))

const spec = (type = 'row_insert') => ({
  key: 'students', type, label: '测试写',
  payload: { table: 'students', row: { id: 1, '姓名': '甲' } },
})

test('takeUndoSpec：取出保留字段并从 body 移除，绝不落库', () => {
  const body = { '姓名': '甲', _undoSpec: spec(), _undoSpecs: [spec(), spec()] }
  const taken = takeUndoSpec(body)
  assert.equal(taken.type, 'row_insert')
  // @pin student-backend/services/writeWithUndo.js#takeUndoSpec
  assert.ok(!('_undoSpec' in body), '保留字段必须移除')
  // @pin student-backend/services/writeWithUndo.js#takeUndoSpec
  assert.ok(!('_undoSpecs' in body), '多规格保留字段也必须移除（V10-K03-03）')
  assert.equal(Object.keys(body).length, 1, '只剩业务字段')
  assert.equal(Object.keys(body)[0], '姓名')
})

test('validSpec：缺 key/type/payload 都拒绝，防止写坏撤销栈', () => {
  assert.equal(validSpec(spec()), true)
  assert.equal(validSpec({ type: 'x', payload: {} }), false)
  assert.equal(validSpec({ key: 'k', payload: {} }), false)
  assert.equal(validSpec({ key: 'k', type: 't' }), false)
  assert.equal(validSpec(null), false)
})

test('真跑 writeWithUndo：写+登记同事务，带回 undoId', () => {
  const conn = fx.reset({ seed: (c) => { c.prepare('INSERT INTO students (姓名) VALUES (?)').run('已有') } })
  let wrote = 0
  const result = writeWithUndo(spec(), () => {
    conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('新增')
    wrote = 1
    return { id: 2 }
  })
  assert.equal(wrote, 1)
  assert.ok(result.undoId, '响应要带回 undoId')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 2)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 1)
})

test('真跑 writeWithUndo：写失败整笔回滚（数据不留）', () => {
  const conn = fx.reset()
  assert.throws(() => writeWithUndo(spec(), () => {
    conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('不该留下')
    throw new Error('模拟写失败')
  }), /模拟写失败/)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 0, '写入失败时数据不能留')
})

test('变异反证：无事务包裹时写失败后数据仍在（证明回滚靠事务）', () => {
  const conn = fx.reset()
  const mutant = (writeFn) => writeFn() || {}
  assert.throws(() => mutant(() => {
    conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('变异留下')
    throw new Error('模拟写失败')
  }), /模拟写失败/)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 1, '无事务时数据留在，证明原版回滚靠事务')
})

test('真跑 EXPRESS 路由：带 _undoSpec 的写请求同事务登记', async () => {
  const conn = fx.reset()
  const router = createDynamicTableRouter('students', { minCount: 0 })
  await fx.mount('/api/students', router)
  const s = spec('row_insert')
  s.payload = { table: 'students', row: { '姓名': '路由新增' } }
  const res = await fx.call('POST', '/api/students', { '姓名': '路由新增', _undoSpec: s })
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.undoId, '响应要带回 undoId')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 1)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 1)
  const cols = conn.prepare('PRAGMA table_info(students)').all().map((c) => c.name)
  assert.ok(!cols.includes('_undoSpec'), '_undoSpec 不能当列名落库')
})


test('buildPayload：payload 依赖写结果时由后端在同事务里生成', () => {
  const conn = fx.reset()
  const result = writeWithUndo(
    { key: 'students', type: 'row_insert', label: '新建', payload: {} },
    () => { conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('后端生成'); return { id: 7 } },
    (writeResult, hint) => ({ table: 'students', rowId: writeResult.id, hint }),
  )
  assert.ok(result.undoId)
  const row = conn.prepare('SELECT payload FROM undo_history WHERE id = ?').get(result.undoId)
  const payload = JSON.parse(row.payload)
  assert.equal(payload.rowId, 7, 'payload 用了写结果里的 id')
  assert.deepEqual(payload.hint, {})
})

test.after(() => fx.close())
