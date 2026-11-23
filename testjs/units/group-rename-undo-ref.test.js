// =========================================================================
// group-rename-undo-ref.test.js —— 撤销「分组页改名」必须按 ID 恢复引用（v7 §5-4 / #57）
//
// 事故面：把已绑学生 A 的成员改名成唯一姓名「李四」，后端会把 student_id 改指李四；
// 用户再撤销，撤销记录里只有 member_name 一列 → 姓名回到「张子涵」，执行器再按姓名
// 重新认人。若名册里有**两个**张子涵，resolveOne 判为歧义返回空，于是 student_id
// 被写成 null：界面上看不出任何异常，但按 ID 的统计、编辑、关联从此把这行当未绑定。
//
// 修法：后端 updateMember 返回解析后的 student_id，前端把「改名前后各绑的是谁」
// 一起登记进撤销 payload（oldRef / newRef），撤销时直接写回，不再按姓名猜。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-rename-undo', extraDbExports: { renumber: () => {} } })

test.before(async () => {
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
  await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js')
})
test.after(() => fx.close())

const one = (sql, ...args) => fx.conn.prepare(sql).get(...args)
const all = (sql, ...args) => fx.conn.prepare(sql).all(...args)
const memberRow = (id) => one('SELECT id, group_id, student_id, member_name, remark FROM group_members WHERE id = ?', id)

function addStudent(name, xuehao) {
  const info = fx.conn.prepare(
    'INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)'
  ).run(xuehao, name)
  return Number(info.lastInsertRowid)
}
function makeGroup() {
  const dim = fx.conn.prepare(
    'INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count) VALUES (?,?,?,?)'
  ).run('学习小组', '组长', 6, 1)
  const g = fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?,?,?)')
    .run(Number(dim.lastInsertRowid), '第1组', 1)
  return Number(g.lastInsertRowid)
}

// 登记一条 cell_update（前端 recordGroupUndo 的形状），payload 是否带 refs 由参数决定
async function pushCellUndo({ rowId, oldValue, newValue, oldRef, newRef }) {
  const payload = { table: 'group_members', rowId, field: 'member_name', oldValue, newValue }
  if (oldRef !== undefined) payload.oldRef = oldRef
  if (newRef !== undefined) payload.newRef = newRef
  const r = await fx.call('POST', '/api/undo', {
    key: 'group_manage',
    type: 'cell_update',
    label: `member_name：「${oldValue}」→「${newValue}」`,
    payload,
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json.id
}

// 造出「同名两人 + 成员绑定其中一位」的现场
function setup() {
  fx.reset()
  const gid = makeGroup()
  const a = addStudent('张子涵', '2026001')
  const b = addStudent('张子涵', '2026002')
  const ins = fx.conn.prepare(
    'INSERT INTO group_members (group_id, student_id, member_name, remark, sort_order) VALUES (?,?,?,?,?)'
  ).run(gid, a, '张子涵', '', 1)
  return { gid, a, b, memberId: Number(ins.lastInsertRowid) }
}

test('§5-4 后端：成员 PUT 返回解析后的 student_id（撤销要靠它记新引用）', async () => {
  const { memberId, a } = setup()
  const r = await fx.call('PUT', `/api/group-manage/group-members/${memberId}`, { member_name: '李四' })
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.equal(r.json.member_name, '李四')
  assert.ok(r.json.student_id, '响应里必须带 student_id —— 前端要拿它登记 newRef')
  assert.notEqual(r.json.student_id, a, '改名到名册外姓名，绑定应指向新（临时）学生')
  assert.equal(memberRow(memberId).student_id, r.json.student_id, '响应值与库内值必须一致')
})

test('§5-4 核心：撤销改名后 student_id 恢复原学生（同名歧义也不清空）', async () => {
  const { memberId, a } = setup()

  const put = await fx.call('PUT', `/api/group-manage/group-members/${memberId}`, { member_name: '李四' })
  assert.equal(put.status, 200, put.text.slice(0, 300))
  const newRef = put.json.student_id
  assert.equal(memberRow(memberId).member_name, '李四')

  const undoId = await pushCellUndo({
    rowId: memberId, oldValue: '张子涵', newValue: '李四', oldRef: a, newRef,
  })
  const un = await fx.call('POST', `/api/undo/${undoId}/undo`)
  assert.equal(un.status, 200, un.text.slice(0, 300))

  const m = memberRow(memberId)
  assert.equal(m.member_name, '张子涵', '姓名要还原')
  assert.equal(m.student_id, a, '必须回到原来那个学生 —— 名册里有两个张子涵，按姓名重认只会得到 null')
})

test('§5-4 重做：按 newRef 写回改名后的引用，不依赖姓名解析', async () => {
  const { memberId, a } = setup()
  const put = await fx.call('PUT', `/api/group-manage/group-members/${memberId}`, { member_name: '李四' })
  const newRef = put.json.student_id

  const undoId = await pushCellUndo({ rowId: memberId, oldValue: '张子涵', newValue: '李四', oldRef: a, newRef })
  await fx.call('POST', `/api/undo/${undoId}/undo`)
  assert.equal(memberRow(memberId).student_id, a)

  const re = await fx.call('POST', `/api/undo/${undoId}/redo`)
  assert.equal(re.status, 200, re.text.slice(0, 300))
  const m = memberRow(memberId)
  assert.equal(m.member_name, '李四')
  assert.equal(m.student_id, newRef, '重做要回到改名后那位学生')
})

test('§5-4 老 payload（无 oldRef）仍按姓名重认 —— 兼容历史记录，也正是原 bug 的形态', async () => {
  const { memberId, a } = setup()
  const put = await fx.call('PUT', `/api/group-manage/group-members/${memberId}`, { member_name: '李四' })
  const newRef = put.json.student_id

  // 不带 refs：模拟升级前登记的撤销记录
  const undoId = await pushCellUndo({ rowId: memberId, oldValue: '张子涵', newValue: '李四' })
  const un = await fx.call('POST', `/api/undo/${undoId}/undo`)
  assert.equal(un.status, 200, un.text.slice(0, 300))

  const m = memberRow(memberId)
  assert.equal(m.member_name, '张子涵')
  assert.equal(m.student_id, null,
    '没有 refs 时只能按姓名猜，两个张子涵 → 歧义 → 清空。这条对照说明新字段确实在起作用')
  assert.notEqual(m.student_id, a)
  assert.notEqual(m.student_id, newRef)
})

test('§5-4 未绑定成员撤销：oldRef 为 null 时写回 null，不被误绑到同名学生', async () => {
  fx.reset()
  const gid = makeGroup()
  addStudent('王五', '2026001')  // 名册里恰好有一个王五
  const ins = fx.conn.prepare(
    'INSERT INTO group_members (group_id, student_id, member_name, remark, sort_order) VALUES (?,?,?,?,?)'
  ).run(gid, null, '王五', '', 1)
  const memberId = Number(ins.lastInsertRowid)

  const put = await fx.call('PUT', `/api/group-manage/group-members/${memberId}`, { member_name: '王五五' })
  const newRef = put.json.student_id

  const undoId = await pushCellUndo({ rowId: memberId, oldValue: '王五', newValue: '王五五', oldRef: null, newRef })
  await fx.call('POST', `/api/undo/${undoId}/undo`)

  const m = memberRow(memberId)
  assert.equal(m.member_name, '王五')
  assert.equal(m.student_id, null,
    '改名前这行本来没绑定；撤销不该因为名册里有个王五就顺手绑上去（引用状态也要还原）')
  assert.ok(all('SELECT id FROM students WHERE 姓名 = ?', '王五').length >= 1)
})

// ———————————————— 前端接线：payload 里真的带上 oldRef / newRef ————————————————
// 后端能力再对，前端不填就等于没修（撤销时走回「按姓名猜」）。这条判据钉住接线。
const fs = require('node:fs')
const path = require('node:path')
const VIEW = path.join(__dirname, '../../student-frontend/src/views/GroupManageView.vue')
const viewSrc = () => fs.readFileSync(VIEW, 'utf8')

test('§5-4 前端：改名前快照原始 student_id，保存后把 oldRef/newRef 登记进撤销 payload', () => {
  const src = viewSrc()
  assert.match(src, /_undoStudentId/, '进入编辑时要快照原绑定（只快照姓名的话撤销只能靠猜）')
  assert.match(src, /payload\.oldRef\s*=/, 'recordGroupUndo 必须把 oldRef 写进 payload')
  assert.match(src, /payload\.newRef\s*=/, 'recordGroupUndo 必须把 newRef 写进 payload')
  assert.match(src, /saved\.student_id/, 'PUT 响应里的 student_id 要作为 newRef 的来源')

  // 顺序：必须先拿响应、再登记撤销（失败时不该留下一条指向不存在状态的记录）
  const atApi = src.indexOf('`/group-members/${m.id}`')
  const atRecord = src.indexOf("recordGroupUndo('group_members', m.id, 'member_name'")
  assert.ok(atApi > 0 && atRecord > atApi, '撤销登记必须在 PUT 成功之后')
})
