// =========================================================================
// group-import-duplicate-pick.test.js —— 分组导入的同名选人（X3-10 同族）
//
// 分组导入表是「小组 / 姓名 / 备注」一行一名，studentIds 的 key 就是行号。
// 锁四条后端行为 + 两条前端接线：
//   ① 指定同名其中一位 → 落那位 id，成员姓名以库为准；
//   ② 'new' → 建临时学生并回填；
//   ③ 不存在 id → 400，整批回滚；
//   ④ 没传 studentIds → 旧行为（同名留空 id）；
//   ⑤ 分组页给 ImportExcel 传名册；⑥ onImportData 透传 studentIds。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-import-dup-name' })
test.before(async () => { await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js') })
test.after(() => fx.close())

function addStudent(name, xuehao) {
  const info = fx.conn.prepare(
    'INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)'
  ).run(xuehao, name)
  return Number(info.lastInsertRowid)
}
function makeDim() {
  const dim = fx.conn.prepare(
    'INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count) VALUES (?,?,?,?)'
  ).run('学习小组', '组长', 6, 2)
  const dimId = Number(dim.lastInsertRowid)
  fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?,?,?)').run(dimId, '第1组', 1)
  return dimId
}
const importRows = (dimId, body) => fx.call('POST', `/dimensions/${dimId}/import`, body)

const FIELDS = ['小组', '姓名', '备注']
const ROWS = [['第1组', '同名同学', '']]

test('① 指定同名其中一位 → 落那位 id，姓名以库为准', async () => {
  fx.reset()
  const b = addStudent('同名同学', '2026002')
  addStudent('同名同学', '2026003')
  const dimId = makeDim()
  const r = await importRows(dimId, { fields: FIELDS, rows: ROWS, studentIds: { '0': b } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const got = fx.conn.prepare('SELECT student_id, member_name FROM group_members WHERE group_id = (SELECT id FROM groups WHERE dimension_id = ?)').get(dimId)
  assert.equal(got.student_id, b, '必须落用户选中的第二位')
  assert.equal(got.member_name, '同名同学')
})

test('② 选新同学 → 建临时学生并回填 id', async () => {
  fx.reset()
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const dimId = makeDim()
  const r = await importRows(dimId, { fields: FIELDS, rows: ROWS, studentIds: { '0': 'new' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const stu = fx.conn.prepare('SELECT * FROM students WHERE 姓名 = ? AND is_provisional = 1').all('同名同学')
  assert.equal(stu.length, 1, '新同学要建临时学生')
  const got = fx.conn.prepare('SELECT student_id FROM group_members WHERE group_id = (SELECT id FROM groups WHERE dimension_id = ?)').get(dimId)
  assert.equal(got.student_id, stu[0].id)
})

test('③ 不存在的 id → 400，整批回滚', async () => {
  fx.reset()
  const dimId = makeDim()
  const r = await importRows(dimId, { fields: FIELDS, rows: ROWS, studentIds: { '0': 999999 } })
  assert.equal(r.status, 400, '选了不存在的人必须报错')
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM group_members').get().n, 0, '不能留半截成员')
})

test('④ 没传 studentIds → 旧行为：同名留空 id，整批成功', async () => {
  fx.reset()
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const dimId = makeDim()
  const r = await importRows(dimId, { fields: FIELDS, rows: ROWS })
  assert.equal(r.status, 200)
  const got = fx.conn.prepare('SELECT student_id FROM group_members WHERE group_id = (SELECT id FROM groups WHERE dimension_id = ?)').get(dimId)
  assert.equal(got.student_id, null)
})

const VIEW = abs('student-frontend/src/views/GroupManageView.vue')
test('⑤ 分组页传名册给导入组件，⑥ onImportData 透传 studentIds', () => {
  const src = fs.readFileSync(VIEW, 'utf8')
  const tag = (src.match(/<ImportExcel[\s\S]*?\/>/) || [])[0]
  assert.ok(tag, '分组页必须挂 ImportExcel')
  assert.match(tag, /:students="allStudents"/, '要传名册才能检测同名')
  // @pin student-frontend/src/views/GroupManageView.vue#onImportData
  assert.match(src, /async function onImportData\(\{ fields, rows, studentIds \}\)/, 'onImportData 要接 studentIds')
  assert.match(src, /JSON\.stringify\(\{ fields, rows, studentIds \}\)/, '要把 studentIds 透传给后端')
})
