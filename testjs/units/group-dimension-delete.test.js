// =========================================================================
// group-dimension-delete.test.js —— 分组维度删除的撤销（Q2-08 / §4-6）
//
// 事故面：`DELETE /dimensions/:id` 一次删掉「维度 + 该维度全部小组 + 全部成员」，
// 还把剩余维度重排成 1..n，但一条撤销记录都不登记；用户删错一个维度，
// 所有小组/成员只能手工重建。前端注释甚至写着「维度删除不含在撤销内」。
//
// 判据分两层：
//   ① 行为（真内存库 + 真 Express router + 真 HTTP）：删除 → 撤销后
//      维度/小组/成员/排序一起回到原样；重做再一起删掉
//   ② 接线：后端带回四段快照，前端登记成一条 group_dimension_delete
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-dim' })
const { executors } = require('../../student-backend/routes/undo/undo.executors')

test.before(() => fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js'))
test.after(() => fx.close())

// 三个维度：1 默认、2 待删、3 最后一个。排序 1/2/3。
function freshDb() {
  const conn = fx.reset()
  conn.exec(`
    INSERT INTO group_dimensions (id, name, is_default, sort_order) VALUES (1, '宿舍组', 1, 1);
    INSERT INTO group_dimensions (id, name, is_default, sort_order) VALUES (2, '学习小组', 0, 2);
    INSERT INTO group_dimensions (id, name, is_default, sort_order) VALUES (3, '值日组', 0, 3);
    INSERT INTO groups (id, dimension_id, name, sort_order) VALUES (10, 2, '第一组', 1);
    INSERT INTO groups (id, dimension_id, name, sort_order) VALUES (11, 2, '第二组', 2);
    INSERT INTO group_members (id, group_id, member_name, remark, sort_order) VALUES (100, 10, '张三', '', 1);
    INSERT INTO group_members (id, group_id, member_name, remark, sort_order) VALUES (101, 10, '李四', '', 2);
    INSERT INTO group_members (id, group_id, member_name, remark, sort_order) VALUES (102, 11, '王五', '', 1);
  `)
  return conn
}

const count = (conn, table, where = '') => conn.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get().c
const sortMap = (conn) => Object.fromEntries(
  conn.prepare('SELECT id, sort_order FROM group_dimensions ORDER BY sort_order, id').all().map(r => [r.id, r.sort_order])
)

// ---------------------------------------------------------------------------
// ① 行为：真实路由删除，真执行器撤销/重做
// ---------------------------------------------------------------------------
test('Q2-08 复现：删维度会连带小组/成员并重排剩余维度，快照必须四段齐全', async () => {
  const conn = freshDb()
  const res = await fx.call('DELETE', '/api/group-manage/dimensions/2')

  assert.equal(res.status, 200)
  assert.equal(count(conn, 'group_dimensions', 'WHERE id = 2'), 0)
  assert.equal(count(conn, 'groups', 'WHERE dimension_id = 2'), 0)
  assert.equal(count(conn, 'group_members', 'WHERE id IN (100,101,102)'), 0)
  assert.deepEqual(sortMap(conn), { 1: 1, 3: 2 }, '剩余维度被重排成 1..n')

  const removed = res.json.removed
  assert.equal(removed.dimension.id, 2, '必须带回维度整行')
  assert.equal(removed.dimension.name, '学习小组')
  assert.deepEqual(removed.groups.map(g => g.id), [10, 11], '必须带回小组整行')
  assert.deepEqual(removed.members.map(m => m.id), [100, 101, 102], '必须带回成员整行')
  assert.deepEqual(removed.sortOrders, [
    { id: 1, sort_order: 1 }, { id: 2, sort_order: 2 }, { id: 3, sort_order: 3 },
  ], '排序快照必须是删除前的值')
})

test('撤销：一个 group_dimension_delete 命令恢复维度/小组/成员/排序', async () => {
  const conn = freshDb()
  const { json } = await fx.call('DELETE', '/api/group-manage/dimensions/2')

  executors.group_dimension_delete.undo(json.removed)

  assert.equal(count(conn, 'group_dimensions'), 3)
  assert.equal(conn.prepare('SELECT name FROM group_dimensions WHERE id = 2').get().name, '学习小组')
  assert.deepEqual(conn.prepare('SELECT id FROM groups WHERE dimension_id = 2 ORDER BY sort_order, id').all().map(r => r.id), [10, 11])
  assert.deepEqual(conn.prepare('SELECT id FROM group_members WHERE group_id IN (10,11) ORDER BY group_id, sort_order, id').all().map(r => r.id), [100, 101, 102])
  assert.deepEqual(sortMap(conn), { 1: 1, 2: 2, 3: 3 }, '排序要回到删除前，而不是简单追加')
})

test('重做：同一条命令再次删除并重排剩余维度', async () => {
  const conn = freshDb()
  const { json } = await fx.call('DELETE', '/api/group-manage/dimensions/2')
  executors.group_dimension_delete.undo(json.removed)

  executors.group_dimension_delete.redo(json.removed)

  assert.equal(count(conn, 'group_dimensions', 'WHERE id = 2'), 0)
  assert.equal(count(conn, 'groups'), 0)
  assert.equal(count(conn, 'group_members'), 0)
  assert.deepEqual(sortMap(conn), { 1: 1, 3: 2 })
})

test('删除中间维度后撤销：其余维度顺序不被永久改变（排序快照生效）', async () => {
  const conn = freshDb()
  const { json } = await fx.call('DELETE', '/api/group-manage/dimensions/2')
  // 删除后如果用户又移动过排序，撤销仍按删除前的快照还原三分项
  assert.deepEqual(sortMap(conn), { 1: 1, 3: 2 })

  executors.group_dimension_delete.undo(json.removed)

  assert.deepEqual(sortMap(conn), { 1: 1, 2: 2, 3: 3 })
})

test('validate：缺维度整行直接拒绝', () => {
  assert.equal(executors.group_dimension_delete.validate({}), '参数不完整')
  assert.equal(executors.group_dimension_delete.validate({ dimension: { id: '2' } }), '参数不完整')
  assert.equal(executors.group_dimension_delete.validate({ dimension: { id: 2 } }), null)
})

// ---------------------------------------------------------------------------
// ② 接线：后端四段快照 + 前端一条命令登记
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('接线：路由返回四段快照，执行器已注册', () => {
  const route = read('student-backend/routes/groupManage.js')
  assert.match(route, /removed:\s*\{\s*dimension: dim,\s*groups,\s*members,\s*sortOrders\s*\}/)
  assert.match(route, /SELECT id, sort_order FROM group_dimensions/, '排序快照必须在删除前取')

  const ex = read('student-backend/routes/undo/undo.executors.js')
  assert.match(ex, /group_dimension_delete:/)
  assert.match(ex, /insertRow\('group_dimensions', dimension\)/)
  assert.match(ex, /insertRow\('groups', g\)/)
  assert.match(ex, /insertRow\('group_members', m\)/)
})

test('接线：前端登记成一条命令，并处理「当前维度已被删掉」', () => {
  const view = read('student-frontend/src/views/GroupManageView.vue')
  assert.match(view, /type:\s*'group_dimension_delete'/)
  assert.match(view, /payload:\s*removed/)
  assert.match(view, /维度已被删掉[\s\S]*?activeDimId\.value = null/, '不清空会请求已删除的维度')
})
