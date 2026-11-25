// =========================================================================
// ai-batch-rename-cascade.test.js —— AI 批量改学生姓名级联（3-1 / #44 / 独立 M2）
//
// 原缺陷：apply-batch 的 update 分支改 students.姓名 时只改主表，没调 renameStudentRefs，
// 值日（字符串名）/座位/请假/加分/小组/班干部 的旧名残留，同一人在不同表叫不同名字。
// 普通编辑（tableService.updateRowWithRename）与 MCP 提案（mcpProposalExec）都做了，
// 只有 AI 批量这条漏了 —— 典型「一处修了、兄弟路径没修」。
//
// 判据：① 行为：真 HTTP apply-batch 改名 → 值日格/请假姓名同步为新名；
//       ② 结果带 renamed 字段；③ 同名/id 口径不变；④ 变异反证。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb, ROOT } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-batch-rename' })
let base
test.before(async () => {
  base = await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
})
test.after(() => fx.close())

const applyBatch = async (ops) => {
  const res = await fetch(base + '/apply-batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
  })
  return { status: res.status, json: await res.json() }
}
const dutyCells = (conn) => JSON.parse(conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells)

function seed(conn) {
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO leave_records (id, student_id, 姓名, 开始时间, 结束时间) VALUES (1, 1, ?, ?, ?)')
    .run('张三', '2026-11-01', '2026-11-02')
  conn.prepare('INSERT INTO score_records (id, student_id, 姓名, 分值) VALUES (1, 1, ?, 5)').run('张三')
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 周一: ['张三'] } }, big: {} }))
}

test('行为：apply-batch 改学生姓名 → 值日/请假/加分同步改，结果带 renamed', async () => {
  const conn = fx.reset()
  seed(conn)
  const r = await applyBatch([{ action: 'update', table: 'students', id: 1, changes: { 姓名: '张三丰' } }])
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(conn.prepare('SELECT 姓名 FROM students WHERE id = 1').get().姓名, '张三丰', '主表要改')
  assert.deepEqual(dutyCells(conn).daily.扫地.周一, ['张三丰'], '值日字符串格要跟着改')
  assert.equal(conn.prepare('SELECT 姓名 FROM leave_records WHERE id = 1').get().姓名, '张三丰', '请假姓名要跟着改')
  assert.equal(conn.prepare('SELECT 姓名 FROM score_records WHERE id = 1').get().姓名, '张三丰', '加分姓名要跟着改')
  const upd = r.json.results.find((x) => x.action === 'update')
  assert.ok(upd.renamed && upd.renamed.changed, '回执要带级联结果（供一致性/撤销核对）')
  assert.ok(upd.renamed.counts.duty >= 1 && upd.renamed.counts.leave >= 1, '级联计数要反映实际改动')
})

test('行为：只改非姓名字段不触级级联', async () => {
  const conn = fx.reset()
  seed(conn)
  const r = await applyBatch([{ action: 'update', table: 'students', id: 1, changes: { position: 9 } }])
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(dutyCells(conn).daily.扫地.周一, ['张三'], '没改名，值日不动')
  assert.equal(conn.prepare('SELECT 姓名 FROM leave_records WHERE id = 1').get().姓名, '张三')
})

test('接线：update 分支在改主表后、同事务内调 renameStudentRefs(old,new,id)', () => {
  const src = fs.readFileSync(abs('student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
  assert.match(src, /require\('\.\.\/\.\.\/services\/studentRename'\)/, '未引入 studentRename')
  // update 分支里：改名判断 → 带 id 级联（分段匹配，避免被 && 链的顺序绑死）
  assert.match(src, /table === 'students' && old[\s\S]{0,200}renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\)/,
    '改学生姓名要带 id 调 renameStudentRefs')
})

test('变异反证：抹掉 renameStudentRefs 调用后接线判据失败', () => {
  const src = fs.readFileSync(abs('student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
  const mutated = src.replace(/renamed = renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\);/, 'renamed = null;')
  assert.ok(mutated !== src, '变异没匹配到级联调用')
  assert.doesNotMatch(mutated, /renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\)/, '变异后判据应失败')
})

// ---------- 写/读闸门：执行端必须与设置里的「只读 / 完全禁止」同口径 ----------
// v8 · K02-01 / K02-09 / N3-16：闸门挂在入口、执行端漏挂，老师设了权限仍能写进/读出。
test('守卫：只读表的 apply-batch 行式写必须整批拒绝且不落库（K02-01）', async () => {
  const conn = fx.reset()
  seed(conn)
  const aiConfigStore = require(abs('student-backend/services/aiConfigStore'))
  aiConfigStore.setPrivacy({ readonly_tables: ['students'] })
  const r = await applyBatch([{ action: 'add', table: 'students', data: { 姓名: '李四' } }])
  assert.equal(r.status, 400, JSON.stringify(r.json))
  assert.match(String(r.json.error), /只读/)
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 1, '被拒后不得落库')
  // 变异反证：清空只读后同样请求必须成功，否则上面那条只是「永远拒绝」
  aiConfigStore.setPrivacy({ readonly_tables: [] })
  const r2 = await applyBatch([{ action: 'add', table: 'students', data: { 姓名: '李四' } }])
  assert.equal(r2.status, 200, JSON.stringify(r2.json))
})

test('守卫：closed_tables 的 AI 记录预览必须 403（K02-09）', async () => {
  const conn = fx.reset()
  seed(conn)
  const aiConfigStore = require(abs('student-backend/services/aiConfigStore'))
  aiConfigStore.setPrivacy({ closed_tables: ['students'], readonly_tables: [] })
  const res = await fetch(base + '/records/students?ids=1')
  const j = await res.json()
  assert.equal(res.status, 403, JSON.stringify(j))
  assert.match(String(j.error), /设置/, '报错要指向设置面板，不能让模型以为数据为空')
  aiConfigStore.setPrivacy({ closed_tables: [] })
})

test('守卫：完全禁止的学生/座位表，resolve_student 与 export_image 都必须拒绝（K02-02/04）', async () => {
  fx.reset()
  const aiConfigStore = require(abs('student-backend/services/aiConfigStore'))
  const tools = require(abs('student-backend/routes/ai/ai.tools/tools'))
  aiConfigStore.setPrivacy({ closed_tables: ['students', 'seat_layout'], readonly_tables: [] })
  const found = await tools.runTool('resolve_student', { query: '张' })
  assert.match(String(found.result.error || ''), /关闭/, 'resolve_student 必须走读闸门')
  const img = await tools.runTool('export_image', { targets: ['seat'] })
  assert.equal(img.result.ok, false, 'export_image 必须被拒')
  assert.match(String(img.result.error || ''), /关闭/)
  aiConfigStore.setPrivacy({ closed_tables: [] })
})
