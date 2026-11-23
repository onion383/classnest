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
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

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
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
  assert.match(src, /require\('\.\.\/\.\.\/services\/studentRename'\)/, '未引入 studentRename')
  // update 分支里：改名判断 → 带 id 级联（分段匹配，避免被 && 链的顺序绑死）
  assert.match(src, /table === 'students' && old[\s\S]{0,200}renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\)/,
    '改学生姓名要带 id 调 renameStudentRefs')
})

test('变异反证：抹掉 renameStudentRefs 调用后接线判据失败', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
  const mutated = src.replace(/renamed = renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\);/, 'renamed = null;')
  assert.ok(mutated !== src, '变异没匹配到级联调用')
  assert.doesNotMatch(mutated, /renameStudentRefs\(old\['姓名'\], after\['姓名'\], id\)/, '变异后判据应失败')
})
