// =========================================================================
// smart-group-student-id.test.js —— 智能分组写回的同名定人（X3-10 同族）
//
// 智能分组内部按名册学生对象（带 id）排，但 emit 时只丢姓名 → 后端按姓名认人 →
// 同名两人被并成一人。现在 emit 同时带 studentIds（key = `${组号}:${组内位置}`），
// 写回路径按 id 落权威字段；没给 id 仍按姓名认人（外部直调接口 / 名册外姓名）。
//
// 锁：① 写回按 id；② 同名两人分到不同组各自独立；③ 不存在的 id → 400 整批回滚；
//     ④ 没给 studentIds → 旧行为；⑤ emit 带 id 矩阵；⑥ 前端透传。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'smart-group-student-id' })
test.before(async () => { await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js') })
test.after(() => fx.close())

function addStudent(name, xuehao) {
  const info = fx.conn.prepare(
    'INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)'
  ).run(xuehao, name)
  return Number(info.lastInsertRowid)
}
function makeDim(groupCount = 2) {
  const dim = fx.conn.prepare(
    'INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count) VALUES (?,?,?,?)'
  ).run('学习小组', '组长', 6, groupCount)
  const dimId = Number(dim.lastInsertRowid)
  for (let i = 1; i <= groupCount; i++) {
    fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?,?,?)').run(dimId, `第${i}组`, i)
  }
  return dimId
}
const apply = (dimId, body) => fx.call('POST', `/dimensions/${dimId}/apply-grouping`, body)
const membersOf = (dimId) => fx.conn.prepare(`
  SELECT gm.member_name, gm.student_id, g.name AS group_name
  FROM group_members gm JOIN groups g ON g.id = gm.group_id
  WHERE g.dimension_id = ? ORDER BY g.sort_order, gm.sort_order
`).all(dimId)

test('① 写回按 studentIds 落 id，不按姓名猜', async () => {
  fx.reset()
  const a = addStudent('同名同学', '2026001')
  const dimId = makeDim()
  const r = await apply(dimId, { groups: [['同名同学']], studentIds: { '0:0': a } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const got = membersOf(dimId)
  assert.equal(got.length, 1)
  assert.equal(got[0].student_id, a, '落用户/名册指定的 id')
})

test('② 同名两人分到不同组，各自独立不合并', async () => {
  fx.reset()
  const a = addStudent('同名同学', '2026001')
  const b = addStudent('同名同学', '2026002')
  const dimId = makeDim()
  const r = await apply(dimId, {
    groups: [['同名同学'], ['同名同学']],
    studentIds: { '0:0': a, '1:0': b },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const got = membersOf(dimId)
  assert.equal(got.length, 2)
  assert.equal(got[0].student_id, a)
  assert.equal(got[1].student_id, b)
  assert.notEqual(got[0].student_id, got[1].student_id, '同名两人必须是两个不同 id')
})

test('③ 不存在的 id → 400，整批回滚', async () => {
  fx.reset()
  const dimId = makeDim()
  const r = await apply(dimId, { groups: [['某人']], studentIds: { '0:0': 999999 } })
  assert.equal(r.status, 400)
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM group_members').get().n, 0)
})

test('④ 没给 studentIds → 旧行为：按姓名认人', async () => {
  fx.reset()
  const a = addStudent('独一名', '2026001')
  const dimId = makeDim()
  const r = await apply(dimId, { groups: [['独一名']] })
  assert.equal(r.status, 200)
  assert.equal(membersOf(dimId)[0].student_id, a)
})

const PREVIEW = abs('student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.preview.js')
const VIEW = abs('student-frontend/src/views/GroupManageView.vue')

test('⑤ emit 同时带姓名矩阵与 id 矩阵（key 为 组:位置）', () => {
  const src = fs.readFileSync(PREVIEW, 'utf8')
  // @pin student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.preview.js#outputGroups
  assert.match(src, /ctx\.emit\('confirm',\s*\{\s*groups: outputGroups\(ctx, result\),\s*studentIds: outputStudentIds\(ctx, result\)\s*\}\)/,
    'confirm 载荷要带 studentIds')
  // @pin student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.preview.js#outputStudentIds
  assert.match(src, /function outputStudentIds\(ctx, result\)/, '要有独立的 id 矩阵函数')
  assert.match(src, /out\[`\$\{g\}:\$\{i\}`\]/, 'key 用 组:位置，与 groups 下标对齐')
  assert.match(src, /ctx\.roster\.value\[si\]\?\.id/, '取名册学生对象的 id')
})

test('⑥ 前端把 studentIds 透传给写回接口', () => {
  const src = fs.readFileSync(VIEW, 'utf8')
  // @pin student-frontend/src/views/GroupManageView.vue#handleSmartGroupResult
  assert.match(src, /async function handleSmartGroupResult\(result\)[\s\S]{0,200}const studentIds = result && result\.studentIds/,
    '处理器要接住 studentIds')
  assert.match(src, /JSON\.stringify\(\{ groups, studentIds \}\)/, '要把 studentIds 透传给后端')
})
