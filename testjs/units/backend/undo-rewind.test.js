// =========================================================================
// undo-rewind.test.js —— 撤销统一 B3 判据：「回退到这条记录之前」原子批量入口
//
// 核心判据（必须真走 rewindTo，不是直接调 executor）：
//   1. 全局时间线逆序：退到 B 之前 = 撤 B + 中间手改 + C，跨来源一视同仁
//   2. 跨表联动：不同 key 的记录一起退
//   3. 整批原子：中途失败时前面已退的全部回滚（dir + 数据）
//   4. 变异反证：把 savepoint 换成 no-op 后，第 3 条必须变成半截状态——
//      证明回滚确实来自 savepoint，不是 releaseDir 或别的原因
//   5. 含文件操作的类型拒绝整批回退
//   6. 路由接线可用
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'undo-rewind' })
test.after(() => fx.close())

const undoStore = require('../../../student-backend/services/undoStore')
const undoRecords = require('../../../student-backend/routes/undo/undo.records')
const { executors } = require('../../../student-backend/routes/undo/undo.executors')

function seed(cnx, id, name) {
  cnx.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(id, name)
}
const nameOf = (id) => fx.conn.prepare('SELECT 姓名 FROM students WHERE id = ?').get(id)?.['姓名']
const dirOf = (id) => undoStore.findById(id).dir

function pushUpdate({ key = 'students', rowId, oldName, newName, origin = '' }) {
  return undoStore.push({
    key, type: 'row_update', label: `改名${rowId}`,
    payload: {
      table: 'students', rowId,
      oldRow: { id: rowId, 姓名: oldName },
      newRow: { id: rowId, 姓名: newName },
    }, origin,
  })
}

// ---------------------------------------------------------------------------
// 1. 链式回退：A(新增) → B(MCP改名) → 手改 → C(助手再改)，退到 B 之前
//    expected 校验必须逐条通过：撤 C 后当前=手改的 newRow，撤手改后= B 的 newRow …
// ---------------------------------------------------------------------------
test('回退到 B 之前：撤 B + 手改 + C，回到 A 之后；跨来源一视同仁', async () => {
  fx.reset()
  seed(fx.conn, 1, '张三丰') // C 写入后的当前状态

  const idA = undoStore.push({
    key: 'students', type: 'row_insert', label: '新增',
    payload: { table: 'students', row: { id: 1, 姓名: '张三' } }, origin: 'ai-A',
  })
  const idB = pushUpdate({ rowId: 1, oldName: '张三', newName: '张山', origin: 'b'.repeat(32) }) // mcp
  const idM = pushUpdate({ rowId: 1, oldName: '张山', newName: '李四' })                          // 手改
  const idC = pushUpdate({ rowId: 1, oldName: '李四', newName: '张三丰', origin: 'ai-C' })        // 助手

  const r = await undoRecords.rewindTo(idB, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.count, 3, '只退 B 及之后三条，A 保留')
  assert.equal(nameOf(1), '张三', '回到 A 之后的状态')
  assert.equal(dirOf(idA), 1, 'A 没被退')
  assert.equal(dirOf(idB), 0)
  assert.equal(dirOf(idM), 0)
  assert.equal(dirOf(idC), 0)
})

// ---------------------------------------------------------------------------
// 2. 跨表联动：不同 key 的记录一起退（表格只是视图筛选，不是回退边界）
// ---------------------------------------------------------------------------
test('跨表：退到时间线中部，students 与 leave_records 的改动一起退', async () => {
  fx.reset()
  seed(fx.conn, 1, '新名')
  fx.conn.prepare('INSERT INTO leave_records (id, 备注) VALUES (?, ?)').run(1, '新备注')

  const id1 = undoStore.push({
    key: 'students', type: 'row_update', label: '',
    payload: {
      table: 'students', rowId: 1,
      oldRow: { id: 1, 姓名: '旧名' }, newRow: { id: 1, 姓名: '新名' },
    }, origin: '',
  })
  const id2 = undoStore.push({
    key: 'leave_records', type: 'row_update', label: '',
    payload: {
      table: 'leave_records', rowId: 1,
      oldRow: { id: 1, 备注: '旧备注' }, newRow: { id: 1, 备注: '新备注' },
    }, origin: '',
  })

  const r = await undoRecords.rewindTo(id1, 'undo')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.count, 2)
  assert.equal(nameOf(1), '旧名')
  assert.equal(fx.conn.prepare('SELECT 备注 FROM leave_records WHERE id = 1').get()['备注'], '旧备注')
})

// ---------------------------------------------------------------------------
// 3. 整批原子：中途失败 → 前面已退的全部回滚
// ---------------------------------------------------------------------------
// 让指定 rowId 的执行器抛错。逆序执行时 id 大的先退、id 小的后退，
// 所以要把失败注入到**后执行**的那条，才能构造出「先退的已经落地、后一条失败」。
function installFailingUndo(rowId) {
  const real = executors.row_update.undo
  executors.row_update.undo = function (p) {
    if (p.rowId === rowId) throw new Error('注入：执行失败')
    return real.call(this, p)
  }
  return () => { executors.row_update.undo = real }
}

function seedTwoRows() {
  fx.reset()
  seed(fx.conn, 1, '新1')
  seed(fx.conn, 2, '新2')
  const first = pushUpdate({ rowId: 1, oldName: '旧1', newName: '新1' })
  const second = pushUpdate({ rowId: 2, oldName: '旧2', newName: '新2' })
  return { first, second }
}

test('中途失败整批回滚：先退的那条也要恢复，dir 全部翻回', async () => {
  const { first, second } = seedTwoRows()
  // 逆序：second(id=2) 先退成功，first(id=1) 后执行时失败
  const restore = installFailingUndo(1)
  try {
    const r = await undoRecords.rewindTo(first, 'undo')
    assert.equal(r.ok, false)
    assert.match(r.error || '', /注入：执行失败/)
    // second 先退成功（写成旧2），被 savepoint 回滚回新2
    assert.equal(nameOf(2), '新2', '先退成功的那条必须被回滚')
    assert.equal(nameOf(1), '新1')
    assert.equal(dirOf(first), 1, 'dir 必须全部翻回')
    assert.equal(dirOf(second), 1)
  } finally {
    restore()
  }
})

test('expected 冲突中途失败也整批回滚', async () => {
  const { first, second } = seedTwoRows()
  // 把先执行的 second 当前值改成快照对不上 → 退到它时 expected 立刻拒绝
  fx.conn.prepare("UPDATE students SET 姓名='乱入' WHERE id=2").run()
  const r = await undoRecords.rewindTo(first, 'undo')
  assert.equal(r.ok, false)
  assert.match(r.error || '', /又被改过/)
  assert.equal(nameOf(2), '乱入', '不该有半条被改写')
  assert.equal(nameOf(1), '新1')
  assert.equal(dirOf(first), 1)
  assert.equal(dirOf(second), 1)
})

// ---------------------------------------------------------------------------
// 4. 变异反证：savepoint 换成 no-op → 中途失败留下半截
//    这是本文件最重要的判据：若没有它，上面「整批回滚」可能是 releaseDir 造成的假绿。
// ---------------------------------------------------------------------------
test('变异反证：去掉 savepoint 后，中途失败留下半截状态', async () => {
  const real = {
    begin: undoStore.beginRewind,
    commit: undoStore.commitRewind,
    rollback: undoStore.rollbackRewind,
  }
  const { first, second } = seedTwoRows()
  // 失败注入到后执行的 first；先执行的 second 会成功落地，用来观察是否回滚
  const restoreUndo = installFailingUndo(1)
  try {
    undoStore.beginRewind = () => 'fake'
    undoStore.commitRewind = () => {}
    undoStore.rollbackRewind = () => {}

    const r = await undoRecords.rewindTo(first, 'undo')
    assert.equal(r.ok, false, '仍然报错')
    assert.equal(nameOf(2), '旧2', '没有 savepoint：先退成功的那条留在旧值，半截状态')
    assert.equal(dirOf(second), 0, '没有 savepoint：那条 dir 留在 0')
  } finally {
    restoreUndo()
    undoStore.beginRewind = real.begin
    undoStore.commitRewind = real.commit
    undoStore.rollbackRewind = real.rollback
  }

  // 恢复 savepoint 后重跑，必须重新做到整批回滚
  const again = seedTwoRows()
  const restoreAgain = installFailingUndo(1)
  try {
    const r2 = await undoRecords.rewindTo(again.first, 'undo')
    assert.equal(r2.ok, false)
    assert.equal(nameOf(2), '新2', '恢复后必须回滚干净')
    assert.equal(dirOf(again.second), 1)
  } finally {
    restoreAgain()
  }
})

// ---------------------------------------------------------------------------
// 5. 含文件操作的类型：拒绝整批回退，且不改任何数据
// ---------------------------------------------------------------------------
test('photo_trash 拒绝整批回退（文件操作进不了事务）', async () => {
  fx.reset()
  const id = undoStore.push({
    key: 'album', type: 'photo_trash', label: '删照片',
    payload: { photo: { id: 7, file_path: '/x.jpg' } }, origin: '',
  })
  const r = await undoRecords.rewindTo(id, 'undo')
  assert.equal(r.ok, false)
  assert.match(r.error || '', /文件操作|逐条/)
  assert.equal(dirOf(id), 1, '拒绝后 dir 不变')
})

// ---------------------------------------------------------------------------
// 6. 重做对称：replay 退回去的一批
// ---------------------------------------------------------------------------
test('replay：正序重做到指定记录', async () => {
  fx.reset()
  seed(fx.conn, 1, '张三丰') // 当前 = 最后写入态；先撤回到张三，再正序重做
  const id1 = pushUpdate({ rowId: 1, oldName: '张三', newName: '张山' })
  const id2 = pushUpdate({ rowId: 1, oldName: '张山', newName: '张三丰' })

  const back = await undoRecords.rewindTo(id1, 'undo')
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.equal(nameOf(1), '张三')

  const fwd = await undoRecords.rewindTo(id2, 'redo')
  assert.equal(fwd.ok, true, JSON.stringify(fwd))
  assert.equal(nameOf(1), '张三丰')
  assert.equal(dirOf(id1), 1)
  assert.equal(dirOf(id2), 1)
})

// ---------------------------------------------------------------------------
// 7. 路由接线
// ---------------------------------------------------------------------------
test('路由：POST /:id/rewind 可用，返回 batch', async () => {
  await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js')
  fx.reset()
  seed(fx.conn, 1, '新名')
  const id = pushUpdate({ rowId: 1, oldName: '旧名', newName: '新名' })
  const res = await fx.call('POST', `/${id}/rewind`, {})
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.batch, 1)
  assert.equal(nameOf(1), '旧名')
})
