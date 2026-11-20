// =========================================================================
// undo-source-converge.test.js —— 撤销统一 B5 判据：三入口收敛到同一原子内核
//
// 核心判据：
//   1. AI 工具（undoAiChange / listAiChanges）按 source 区分——MCP 的改动
//      即使 origin 非空也不会被当成「助手自己的更改」退掉（旧口径 origin<>'' 会误退）。
//   2. origin 批次入口也走 SAVEPOINT：中途失败整批回滚，不再是裸循环留半截。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'undo-source-converge' })
test.after(() => fx.close())

const undoStore = require('../../student-backend/services/undoStore')
const undoRecords = require('../../student-backend/routes/undo/undo.records')
const { executors } = require('../../student-backend/routes/undo/undo.executors')

function seed(cnx, id, name) {
  cnx.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(id, name)
}
const nameOf = (id) => fx.conn.prepare('SELECT 姓名 FROM students WHERE id = ?').get(id)?.['姓名']
const dirOf = (rid) => undoStore.findById(rid).dir

function pushUpdate({ rowId, oldName, newName, origin }) {
  return undoStore.push({
    key: 'students', type: 'row_update', label: `改名${rowId}`,
    payload: {
      table: 'students', rowId,
      oldRow: { id: rowId, 姓名: oldName },
      newRow: { id: rowId, 姓名: newName },
    }, origin,
  })
}

// ---------------------------------------------------------------------------
// 1. undoAiChange 只退 AI 助手的批次，不碰 MCP 批次
// ---------------------------------------------------------------------------
test('undoAiChange 按 source 区分：退 AI 批次，MCP 批次保持不变', async () => {
  fx.reset()
  // 两行不同数据，避免 expected 快照互相干扰
  seed(fx.conn, 1, 'AI新')   // AI 批次写入后
  seed(fx.conn, 2, 'MCP新')  // MCP 批次写入后

  const mcpOrigin = 'c'.repeat(32)          // → source = mcp
  const aiOrigin = 'ai-1730000000000-ab12'  // → source = ai_assistant
  const idMcp = pushUpdate({ rowId: 2, oldName: 'MCP旧', newName: 'MCP新', origin: mcpOrigin })
  const idAi = pushUpdate({ rowId: 1, oldName: 'AI旧', newName: 'AI新', origin: aiOrigin })

  assert.equal(undoStore.findById(idMcp).source, 'mcp')
  assert.equal(undoStore.findById(idAi).source, 'ai_assistant')

  // listAiChanges 只列 AI 的
  const listed = undoRecords.listAiChanges(10)
  assert.equal(listed.length, 1, '只应有 AI 助手一个批次')
  assert.equal(listed[0].origin, aiOrigin)

  // undoAiChange 只退 AI 批次
  const r = await undoRecords.undoAiChange()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(nameOf(1), 'AI旧', 'AI 批次被退回')
  assert.equal(nameOf(2), 'MCP新', 'MCP 批次不受影响')
  assert.equal(dirOf(idMcp), 1, 'MCP 记录仍可撤销')
  assert.equal(dirOf(idAi), 0)
})

// ---------------------------------------------------------------------------
// 2. origin 批次中途失败 → 整批回滚（不再是裸循环）
// ---------------------------------------------------------------------------
test('undoOriginBatch 中途失败整批回滚：先退的那条也恢复', async () => {
  fx.reset()
  seed(fx.conn, 1, '新1')
  seed(fx.conn, 2, '新2')
  const origin = 'batch-xyz-1'
  // 同 origin 两条；逆序先退 rowId=2，后退 rowId=1
  const id1 = pushUpdate({ rowId: 1, oldName: '旧1', newName: '新1', origin })
  const id2 = pushUpdate({ rowId: 2, oldName: '旧2', newName: '新2', origin })

  const real = executors.row_update.undo
  executors.row_update.undo = function (p) {
    if (p.rowId === 1) throw new Error('注入：后执行的一条失败')
    return real.call(this, p)
  }
  try {
    const r = await undoRecords.undoOriginBatch(origin)
    assert.equal(r.ok, false)
    assert.match(r.error || '', /注入：后执行的一条失败/)
    assert.equal(nameOf(2), '新2', '先退成功的那条必须被回滚')
    assert.equal(nameOf(1), '新1')
    assert.equal(dirOf(id1), 1, 'dir 全部翻回')
    assert.equal(dirOf(id2), 1)
  } finally {
    executors.row_update.undo = real
  }
})

// ---------------------------------------------------------------------------
// 3. 变异反证：把 savepoint 换 no-op 后，origin 批次中途失败留下半截
// ---------------------------------------------------------------------------
test('变异反证：去掉 savepoint 后 origin 批次留下半截状态', async () => {
  const real = {
    begin: undoStore.beginRewind,
    commit: undoStore.commitRewind,
    rollback: undoStore.rollbackRewind,
  }
  fx.reset()
  seed(fx.conn, 1, '新1')
  seed(fx.conn, 2, '新2')
  const origin = 'batch-xyz-2'
  const id1 = pushUpdate({ rowId: 1, oldName: '旧1', newName: '新1', origin })
  const id2 = pushUpdate({ rowId: 2, oldName: '旧2', newName: '新2', origin })

  const realUndo = executors.row_update.undo
  executors.row_update.undo = function (p) {
    if (p.rowId === 1) throw new Error('注入失败')
    return realUndo.call(this, p)
  }
  try {
    undoStore.beginRewind = () => 'fake'
    undoStore.commitRewind = () => {}
    undoStore.rollbackRewind = () => {}
    const r = await undoRecords.undoOriginBatch(origin)
    assert.equal(r.ok, false)
    assert.equal(nameOf(2), '旧2', '没有 savepoint：先退成功的那条留在半截态')
    assert.equal(dirOf(id2), 0)
  } finally {
    executors.row_update.undo = realUndo
    undoStore.beginRewind = real.begin
    undoStore.commitRewind = real.commit
    undoStore.rollbackRewind = real.rollback
  }
})
