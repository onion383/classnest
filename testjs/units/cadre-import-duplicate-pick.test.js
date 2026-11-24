// =========================================================================
// cadre-import-duplicate-pick.test.js —— 班干部导入的同名选人（X3-09 同族）
//
// 班干部导入表与请假/成绩不同：学生写在「担任学生」列，一行可顿号分隔多人。
// 因此 studentIds 的 key 是 `${行idx}:${slotIdx}`（不是纯行号），前端 ImportExcel
// 传 student-name-fields + multi-name-per-row 后按这个 key 分桶选人，后端按同一 key 落 id。
//
// 锁四条后端行为 + 三条前端接线：
//   ① 指定同名其中一位 → 落那位 id、姓名以库为准；
//   ② 'new' → 建临时学生并回填 id；
//   ③ 不存在的 id → 400，整批回滚不留半成品；
//   ④ 没传 studentIds → 旧行为（同名留空 id，整批仍成功）；
//   ⑤ 前端给 ImportExcel 传名册 + 列名 + 多名标记；
//   ⑥ onImportData 把 studentIds 透传给后端；
//   ⑦ ImportExcel 按 key 派发（含 `${idx}:${slotIdx}` 形态）。
// 配变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const ROOT = path.join(__dirname, '../..')
const fx = createBackendDb({ label: 'cadre-import-dup-name' })
let conn = fx.conn
let base
test.before(async () => { base = await fx.mount('/api/cadres', 'student-backend/routes/cadres.js') })
test.beforeEach(() => { conn = fx.reset() })
test.after(() => fx.close())

const addStudent = (name, xuehao) =>
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run(name, xuehao).lastInsertRowid

const importCadres = async (body) => {
  const res = await fetch(base + '/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

const FIELDS = ['职务', '担任学生', '可担任人数']
const ROWS = [['学习委员', '同名同学', '3']]

test('① 指定同名其中一位 → 落那位 id，姓名以库为准', async () => {
  const a = addStudent('同名同学', '2026001')
  const b = addStudent('同名同学', '2026002')
  const r = await importCadres({ fields: FIELDS, rows: ROWS, studentIds: { '0:0': b } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.created.members.length, 1)
  const member = r.json.created.members[0]
  assert.equal(member.student_id, b, '必须落用户选中的第二位')
  assert.equal(member.student_name, '同名同学')
  assert.ok(a !== b)
  const inDb = conn.prepare('SELECT student_id FROM cadre_members WHERE id = ?').get(member.id)
  assert.equal(inDb.student_id, b, '库里也要是选中的 id')
})

test('② 一行多名：只给第二个名字选人，第一个按姓名唯一命中', async () => {
  addStudent('独一名', '2026001')
  const b = addStudent('同名同学', '2026002')
  addStudent('同名同学', '2026003')
  const r = await importCadres({
    fields: FIELDS,
    rows: [['学习委员', '独一名、同名同学', '3']],
    studentIds: { '0:1': b },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.created.members.length, 2)
  assert.equal(r.json.created.members[0].student_id, 1, '第一个名字名册唯一，按姓名认人')
  assert.equal(r.json.created.members[1].student_id, b, '第二个名字按用户选人')
})

test('③ 选新同学 → 建临时学生并回填 id', async () => {
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const r = await importCadres({ fields: FIELDS, rows: ROWS, studentIds: { '0:0': 'new' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const stu = conn.prepare('SELECT * FROM students WHERE 姓名 = ? AND is_provisional = 1').all('同名同学')
  assert.equal(stu.length, 1, '新同学要建临时学生')
  assert.equal(r.json.created.members[0].student_id, stu[0].id)
})

test('④ 不存在的 id → 400，整批回滚', async () => {
  const r = await importCadres({ fields: FIELDS, rows: ROWS, studentIds: { '0:0': 999999 } })
  assert.equal(r.status, 400, '选了不存在的人必须报错')
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM cadre_members').get().n, 0, '不能留半截成员')
})

test('⑤ 没传 studentIds → 旧行为：同名留空 id，整批成功', async () => {
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const r = await importCadres({ fields: FIELDS, rows: ROWS })
  assert.equal(r.status, 200)
  assert.equal(r.json.created.members[0].student_id, null)
})

// ---------- 前端接线判据 ----------
const MANAGE = path.join(ROOT, 'student-frontend/src/components/CadreManage.vue')
const IMPORTER = path.join(ROOT, 'student-frontend/src/components/import-export/ImportExcel.vue')

test('⑥ 班干部页给导入组件传名册 + 列名 + 多名标记，且透传 studentIds', () => {
  const manage = fs.readFileSync(MANAGE, 'utf8')
  const tag = (manage.match(/<ImportExcel[\s\S]*?\/>/) || [])[0]
  assert.ok(tag, '班干部页必须挂 ImportExcel')
  assert.match(tag, /:students="allStudents"/, '要传名册才能检测同名')
  assert.match(tag, /:student-name-fields="\['担任学生'/ , '要指定学生列为「担任学生」')
  assert.match(tag, /:multi-name-per-row="true"/, '一行多名要拆开逐个选人')
  assert.match(manage, /function onImportData\(\{ fields, rows, studentIds \}\)/, 'onImportData 要接 studentIds')
  assert.match(manage, /data:\s*\{\s*fields,\s*rows,\s*studentIds\s*\}/, '要把 studentIds 透传给后端')
})

test('⑦ ImportExcel 支持多名分桶与 key 派发（默认口径不变）', () => {
  const src = fs.readFileSync(IMPORTER, 'utf8')
  assert.match(src, /studentNameFields:\s*\{\s*type:\s*Array/, '要有可选列名 prop')
  assert.match(src, /multiNamePerRow:\s*\{\s*type:\s*Boolean/, '要有可选多名 prop')
  assert.match(src, /props\.studentNameFields\.find\(\(n\) => headers\.includes\(n\)\)/, '按列名找学生列')
  assert.match(src, /raw\.split\(\/\[、,，;；\/|\|\\s\]\+\/\)/, '一行多名按分隔符拆')
  assert.match(src, /`\$\{idx\}:\$\{slotIdx\}`/, '多名 key 用 行:slot')
  assert.match(src, /pendingResolved\.value\[key\]/, '按 key 派发选人结果')
  // 默认口径：请假/成绩仍是纯行号 key
  assert.match(src, /props\.multiNamePerRow \? `\$\{idx\}:\$\{slotIdx\}` : `\$\{idx\}`/, '默认仍用行号 key')
})
