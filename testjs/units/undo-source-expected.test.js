// =========================================================================
// undo-source-expected.test.js —— 撤销统一 B1+B2 判据
//   B1：undo_history.source 迁移 + 三类 origin 归类
//   B2：flip 的 expected 快照校验（跳批撤销不许吞手改）
//
// 关键：B2 的用例必须**真走 flip**（不是直接调 executor.undo）——
// expected 校验挂在 flip 里，只测 executor 是假绿。末尾用「替换 checkExpected」
// 做变异反证：去掉校验后，拒绝用例必须失败，否则说明拦截另有原因。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createBackendDb, ROOT, Database } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'undo-source-expected' })
// 注意：fx.reset() 会换掉底层连接，必须用动态 getter fx.conn，不能顶层静态捕获。
test.after(() => fx.close())

const undoStore = require('../../student-backend/services/undoStore')
const undoRecords = require('../../student-backend/routes/undo/undo.records')
const expectedMod = require('../../student-backend/routes/undo/undo.expected')

// ---------------------------------------------------------------------------
// B1 · sourceOfOrigin 三类归类（纯函数，边界）
// ---------------------------------------------------------------------------
test('sourceOfOrigin：空→manual，32 位小写 hex→mcp，ai-/子agent→ai_assistant，其余→manual', () => {
  assert.equal(undoStore.sourceOfOrigin(''), 'manual')
  assert.equal(undoStore.sourceOfOrigin(undefined), 'manual')
  assert.equal(undoStore.sourceOfOrigin(null), 'manual')
  assert.equal(undoStore.sourceOfOrigin('a'.repeat(32)), 'mcp')
  // 下面三条是「不认识的 origin 一律算手改」，不是「算助手」：
  // 老师一次改三格产生的批次 origin 是 op-<ts>-<rand>，按「非 hex 即助手」会整批标成 AI，
  // 面板上就出现「AI 改了 3 条」的假记录。所以只认两种助手词形，其余归手改。
  assert.equal(undoStore.sourceOfOrigin('A'.repeat(32)), 'manual', '大写不是 mcp 的 hex 形态，也不是助手词形')
  assert.equal(undoStore.sourceOfOrigin('a'.repeat(31)), 'manual', '少一位既不是 mcp 也不是助手')
  assert.equal(undoStore.sourceOfOrigin('op-1730000000000-ab12cd'), 'manual', '老师一次动作的批次')
  assert.equal(undoStore.sourceOfOrigin('ai-1730000000000-ab12cd'), 'ai_assistant')
  assert.equal(undoStore.sourceOfOrigin('子agent:math-1730000000000-x1'), 'ai_assistant')
})

test('push 缺省 source 由 origin 推断；list 带 source 列', () => {
  fx.reset()
  const idMcp = undoStore.push({ key: 'students', type: 'row_update', label: '', payload: {}, origin: 'b'.repeat(32) })
  const idAi = undoStore.push({ key: 'students', type: 'row_update', label: '', payload: {}, origin: 'ai-1-x' })
  const idManual = undoStore.push({ key: 'students', type: 'row_update', label: '', payload: {}, origin: '' })
  assert.equal(undoStore.findById(idMcp).source, 'mcp')
  assert.equal(undoStore.findById(idAi).source, 'ai_assistant')
  assert.equal(undoStore.findById(idManual).source, 'manual')
  assert.equal(undoStore.listAll().length, 3)
  assert.ok('source' in undoStore.listAll()[0], 'listAll 必须带 source 供面板筛选')
  assert.ok('source' in undoStore.listAiRows()[0], 'listAiRows 必须带 source')
  assert.ok('source' in undoStore.latestByKey('students', 1, true), 'latestByKey(full) 必须带 source')
})

// ---------------------------------------------------------------------------
// B2 · flip 的 expected 校验（真走 flip）
// ---------------------------------------------------------------------------
function seedOne(cnx, { id = 1, name = '张三' } = {}) {
  cnx.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(id, name)
  return { id, 姓名: name }
}
const rowOf = (id) => fx.conn.prepare('SELECT * FROM students WHERE id = ?').get(id)

test('row_update 正常撤销：当前仍是 newRow → 通过，写回 oldRow', async () => {
  fx.reset()
  seedOne(fx.conn, { name: '张山' }) // B 写入后留下的状态 = newRow
  const oldRow = { id: 1, 姓名: '张三' }
  const newRow = { id: 1, 姓名: '张山' }
  const id = undoStore.push({
    key: 'students', type: 'row_update', label: '改名',
    payload: { table: 'students', rowId: 1, oldRow, newRow }, origin: 'a'.repeat(32),
  })
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(rowOf(1)['姓名'], '张三')
})

test('row_update 跳批撤销：当前已被手改成李四 → 拒绝，dir 与数据都不动', async () => {
  fx.reset()
  seedOne(fx.conn, { name: '李四' }) // B 之后又有手改/C，当前 ≠ B 的 newRow
  const id = undoStore.push({
    key: 'students', type: 'row_update', label: '改名',
    payload: {
      table: 'students', rowId: 1,
      oldRow: { id: 1, 姓名: '张三' }, newRow: { id: 1, 姓名: '张山' },
    }, origin: 'a'.repeat(32),
  })
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.match(r.error || '', /又被改过/)
  assert.equal(undoStore.findById(id).dir, 1, '拒绝后方向不变，仍可重试')
  assert.equal(rowOf(1)['姓名'], '李四', '拒绝后数据不被吞')
})

test('row_update 残缺快照不误杀：快照无匹配字段 → 放行', async () => {
  fx.reset()
  seedOne(fx.conn, { name: '李四' })
  const id = undoStore.push({
    key: 'students', type: 'row_update', label: '老记录',
    payload: { table: 'students', rowId: 1, oldRow: { _x: 1 }, newRow: { _x: 2 } }, origin: 'x',
  })
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('row_insert：当前行仍在→撤销通过；已被删→拒绝', async () => {
  fx.reset()
  const row = seedOne(fx.conn, { id: 10, name: '新增' })
  const id = undoStore.push({
    key: 'students', type: 'row_insert', label: '新增',
    payload: { table: 'students', row }, origin: 'ai-1-x',
  })
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(rowOf(10), undefined)

  // 已删场景：重新造一条记录，但当前库里没有那行
  const id2 = undoStore.push({
    key: 'students', type: 'row_insert', label: '新增',
    payload: { table: 'students', row: { id: 99, 姓名: '幽灵' } }, origin: 'ai-2-x',
  })
  const r2 = await undoRecords.flip(id2, 1, 0, 'undo')
  assert.match(r2.error || '', /已不存在/)
})

test('row_delete：当前行不存在→撤销插回；已被重新插入→拒绝', async () => {
  fx.reset()
  const row = { id: 20, 姓名: '被删' }
  const id = undoStore.push({
    key: 'students', type: 'row_delete', label: '删除',
    payload: { table: 'students', row }, origin: '',
  })
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(rowOf(20)['姓名'], '被删')
})

test('redo 对称：row_update 重做要求当前是 oldRow，否则拒绝', async () => {
  fx.reset()
  seedOne(fx.conn, { name: '张三' }) // 撤销后状态 = oldRow
  const id = undoStore.push({
    key: 'students', type: 'row_update', label: '改名',
    payload: {
      table: 'students', rowId: 1,
      oldRow: { id: 1, 姓名: '张三' }, newRow: { id: 1, 姓名: '张山' },
    }, origin: 'a'.repeat(32),
  })
  undoStore.claimDir(id, 0, 1) // 模拟已在 undo 侧
  const ok = await undoRecords.flip(id, 0, 1, 'redo')
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(rowOf(1)['姓名'], '张山')

  undoStore.claimDir(id, 0, 1) // 再翻回 undo 侧，把当前改成别的
  fx.conn.prepare("UPDATE students SET 姓名='乱改' WHERE id=1").run()
  const bad = await undoRecords.flip(id, 0, 1, 'redo')
  assert.match(bad.error || '', /又被改过/)
})

test('复合类型不校验：doc_update 即使当前状态对不上也走原逻辑', async () => {
  fx.reset()
  const id = undoStore.push({
    key: 'schedule', type: 'doc_update', label: '整块',
    payload: { table: 'schedule', id: 1, before: { cells: [] }, after: { cells: [] } }, origin: '',
  })
  // schedule 表存在且 id=1；doc_update 不在 ROW_TYPES，checkExpected 必须放行
  assert.equal(expectedMod.checkExpected({ type: 'doc_update', payload: {} }, 'undo'), null)
  const r = await undoRecords.flip(id, 1, 0, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
})

// ---------------------------------------------------------------------------
// 变异反证：把 checkExpected 换成「永远通过」，跳批拒绝用例必须变成成功吞数据
// ---------------------------------------------------------------------------
test('变异反证：去掉 expected 校验后，跳批撤销会成功覆盖手改（证明拦截确实生效）', async () => {
  fx.reset()
  seedOne(fx.conn, { name: '李四' })
  const id = undoStore.push({
    key: 'students', type: 'row_update', label: '改名',
    payload: {
      table: 'students', rowId: 1,
      oldRow: { id: 1, 姓名: '张三' }, newRow: { id: 1, 姓名: '张山' },
    }, origin: 'a'.repeat(32),
  })
  const real = expectedMod.checkExpected
  try {
    expectedMod.checkExpected = () => null
    const r = await undoRecords.flip(id, 1, 0, 'undo')
    assert.equal(r.ok, true, '去掉校验后应当放行')
    assert.equal(rowOf(1)['姓名'], '张三', '去掉校验后手改被吞——正是要防的事故')
  } finally {
    expectedMod.checkExpected = real
  }
  // 恢复后再验证一次确实拦得住
  fx.reset()
  seedOne(fx.conn, { name: '李四' })
  const id2 = undoStore.push({
    key: 'students', type: 'row_update', label: '改名',
    payload: {
      table: 'students', rowId: 1,
      oldRow: { id: 1, 姓名: '张三' }, newRow: { id: 1, 姓名: '张山' },
    }, origin: 'a'.repeat(32),
  })
  const r2 = await undoRecords.flip(id2, 1, 0, 'undo')
  assert.match(r2.error || '', /又被改过/, '恢复校验后必须重新拦截')
})
