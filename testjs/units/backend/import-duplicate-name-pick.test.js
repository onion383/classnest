// =========================================================================
// import-duplicate-name-pick.test.js —— 批量导入同名选人（用户逐行定人）
//
// 后端：导入 payload 带 studentIds: {行号: id|'new'} 时，按用户选的人落 student_id，
//       不再留空。数字 id 必须真实存在（否则 400，不留断链快照）；'new' 建临时学生。
// 前端：ImportExcel 只在传了 students 时检测同名，弹窗逐组确认后才 emit import-data。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')


// ---------- 后端：请假导入 ----------
const fx = createBackendDb({ label: 'import-dup-name-leave' })
let conn = fx.conn
let base
test.before(async () => { base = await fx.mount('/api/leaves', 'student-backend/routes/leaves.js') })
test.beforeEach(() => { conn = fx.reset() })
test.after(() => fx.close())

const postImport = async (body) => {
  const res = await fetch(base + '/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}
const addStudent = (name, xuehao) =>
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run(name, xuehao).lastInsertRowid

const leaveFields = ['姓名', '开始时间', '结束时间']
const leaveRows = [['同名同学', '2026-11-10', '2026-11-12']]

test('导入选人：指定同名其中一位 → 落那位 id，不多建学生', async () => {
  const a = addStudent('同名同学', '2026001')
  const b = addStudent('同名同学', '2026002')
  const r = await postImport({ fields: leaveFields, rows: leaveRows, studentIds: { 0: b } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.created[0].student_id, b, '必须落用户选中的第二位，不是按姓名取第一个')
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students WHERE 姓名 = ?').get('同名同学').n, 2)
  assert.ok(a !== b)
})

test('导入选人：新同学 → 建临时学生并回填，正式名单不动', async () => {
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const r = await postImport({ fields: leaveFields, rows: leaveRows, studentIds: { 0: 'new' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const stu = conn.prepare('SELECT * FROM students WHERE 姓名 = ? AND is_provisional = 1').all('同名同学')
  assert.equal(stu.length, 1, '新同学要建临时学生')
  assert.equal(r.json.created[0].student_id, stu[0].id, '回填刚建的临时学生 id')
})

test('导入选人：不存在的 id → 400，不留断链快照', async () => {
  addStudent('同名同学', '2026001')
  const r = await postImport({ fields: leaveFields, rows: leaveRows, studentIds: { 0: 999999 } })
  assert.equal(r.status, 400, '选了不存在的人必须报错')
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM leave_records').get().n, 0)
})

test('没传 studentIds 时保持旧行为（重名留空）', async () => {
  addStudent('同名同学', '2026001')
  addStudent('同名同学', '2026002')
  const r = await postImport({ fields: leaveFields, rows: leaveRows })
  assert.equal(r.status, 200)
  assert.equal(r.json.created[0].student_id, null)
})

// ---------- 前端：接线判据 ----------
const IMPORTER = abs('student-frontend/src/components/import-export/ImportExcel.vue')
const DIALOG = abs('student-frontend/src/components/dialogs/DuplicateNameDialog.vue')

test('前端：传了名册才检测同名，弹窗确认后才 emit', () => {
  const src = fs.readFileSync(IMPORTER, 'utf8')
  assert.match(src, /students:\s*\{[^}]*default:/, '要有可选 students prop')
  assert.match(src, /nameBuckets\(\)/, '要按姓名分桶')
  assert.match(src, /list\.length\s*<\s*2/, '少于两人不弹窗')
  assert.match(src, /studentIds:\s*\{\s*\.\.\.pendingResolved/, 'emit 要带 studentIds')
  const confirmIdx = src.indexOf('function confirmImport()')
  const emitIdx = src.indexOf("emit('import-data'", confirmIdx)
  assert.ok(confirmIdx >= 0 && emitIdx > confirmIdx, '确认路径要 emit')

  const dlg = fs.readFileSync(DIALOG, 'utf8')
  assert.match(src, /这是一位新同学/, '选项里要有新同学')
  assert.match(dlg, /<select[\s\S]*?<\/select>/, '每行一个下拉')
  assert.match(dlg, /function onConfirm\(\)/, '要有确定处理')
  assert.match(dlg, /emit\('confirm'/, '确定要回传选择')
  assert.match(dlg, /row\.options\.find\(o => o\.value !== 'new'\)/, '默认选中第一个非新同学候选')
  assert.match(dlg, /:value="selections\[row\.key\]"/, '下拉要绑定选中值（点选才改得动）')
})

test('V9-F02-02：弹窗 watch 同时监听 rows（ImportExcel 多组同名逐组重置）', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../student-frontend/src/components/dialogs/DuplicateNameDialog.vue'), 'utf8')
  // @pin student-frontend/src/components/dialogs/DuplicateNameDialog.vue#selections
  assert.match(src, /watch\(\[\(\) => props\.visible, \(\) => props\.rows\]/,
    '只监听 visible 时，ImportExcel 全程 visible=true 切 rows 不会重置默认选择')
  // @pin student-frontend/src/components/dialogs/DuplicateNameDialog.vue#selections
  assert.match(src, /if \(!props\.visible\) return/)
})
