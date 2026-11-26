// =========================================================================
// 验收①（V9 2-5 卡）：真库注入「写入成功、第二次 POST 失败」，断言撤销栈仍有记录。
//
// 事故模型：常规业务写是两步——第一次 POST 写数据成功，第二次 POST /api/undo 补登记。
// 第二次失败就留下「数据改了、撤销栈里却没有」的状态，用户按 Ctrl+Z 才发现撤不回。
//
// 判据（真库 + 真 HTTP，不用静态正则）：
//   ① 新模式：写请求带 _undoSpec（后端同事务登记）→ 再注入「第二次登记 POST 失败」
//      （发一个非法 spec 让它 400）→ 断言撤销栈里仍有那条记录。
//   ② 变异反证：老模式（写请求不带 spec，靠第二次 POST 登记）→ 同样的第二次 POST 失败
//      → 断言撤销栈为空。证明①里的记录确实来自同事务，不是碰巧。
//
// 单一 fixture —— createBackendDb 会替换 require.cache 里的 db 代理，多实例互覆盖。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'write-undo-2nd-post' })
const { createDynamicTableRouter } = require(abs('student-backend/routes/dynamicTable.js'))

const spec = () => ({
  key: 'students', type: 'row_insert', label: '验收写',
  payload: { table: 'students', row: { '姓名': '验收' } },
})

async function setup() {
  const conn = fx.reset()
  await fx.mount('/api/students', createDynamicTableRouter('students', { minCount: 0 }))
  await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js')
  return conn
}

test('新模式：写成功 + 第二次登记 POST 失败，撤销栈仍有记录', async () => {
  const conn = await setup()
  // 第一次：写请求带 spec，后端同事务写数据 + 登记
  const write = await fx.call('POST', '/api/students', { '姓名': '验收', _undoSpec: spec() })
  assert.equal(write.status, 200, write.text)
  assert.ok(write.json.undoId, '响应带回 undoId')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 1, '数据已写入')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 1, '同事务已登记')

  // 注入「第二次 POST 失败」：前端旧路径会再发一次登记，这里发一个非法 spec 强制 400。
  const second = await fx.call('POST', '/api/undo', { key: '', type: '' })
  assert.equal(second.status, 400, '第二次登记请求确实失败')
  assert.match(String(second.json.error), /缺少参数/)

  // 关键断言：第二次失败后，撤销栈里那条记录仍在（不依赖第二次请求）
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 1,
    '第二次 POST 失败后撤销栈里仍有记录')
})

test('变异反证：老式两写路径下，第二次 POST 失败就没有记录', async () => {
  const conn = await setup()
  // 老模式：写请求不带 spec（后端不登记），写完由前端第二次 POST 补登记
  const write = await fx.call('POST', '/api/students', { '姓名': '老模式' })
  assert.equal(write.status, 200, write.text)
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 0, '老模式写完撤销栈为空')

  // 第二次登记失败
  const second = await fx.call('POST', '/api/undo', { key: '', type: '' })
  assert.equal(second.status, 400, '第二次登记失败')

  // 老模式的后果：数据改了，撤销栈还是空的 —— 正是本卡要治的病
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM students').get().n, 1, '数据已写入')
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n, 0,
    '老模式下第二次失败 → 撤销栈空（变异反证必须红）')
})

test.after(() => fx.close())
