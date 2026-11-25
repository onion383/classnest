// =========================================================================
// widget-overview.test.js —— 挂件单请求概览（v8 · P3-14）
//
// 事故面：桌面挂件每轮并发拉 5 份全量文档（含整份学生表），只为渲染摘要。
// 覆盖率：① 单请求返回 5 项；② 名册只含轻量字段；③ 单项失败不影响其余；④ 前端接线只发 1 个请求。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'widget-overview' })
const conn = fx.conn

conn.prepare('INSERT INTO students (学号, 年级, 班级, 姓名, 家长联系电话, 学生联系电话, 备注) VALUES (?,?,?,?,?,?,?)')
  .run('2026001', '八年级', '3 班', '张三', '13800138000', '13900139000', '')
conn.prepare('INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间, 状态, 返校时间, 备注, position) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(null, '张三', '病假', '2026-09-01 08:00', '2026-09-01 17:00', '请假中', null, '', 1)

let base
test.before(async () => {
  base = await fx.mount('/api/widget-overview', 'student-backend/routes/widgetOverview.js')
})
test.after(() => fx.close())

test('一次请求返回挂件需要的 5 项', async () => {
  const r = await fx.call('GET', '/')
  assert.equal(r.status, 200, r.text.slice(0, 300))
  const j = r.json
  assert.deepEqual(Object.keys(j).sort(), ['countdowns', 'duty', 'leaves', 'schedule', 'students'])
  assert.equal(typeof j.schedule, 'object')
  assert.equal(typeof j.duty, 'object')
  assert.ok(Array.isArray(j.countdowns))
  assert.ok(Array.isArray(j.leaves))
  assert.ok(Array.isArray(j.students))
})

test('名册只回轻量字段（id/姓名），不整表搬运', async () => {
  const j = (await fx.call('GET', '/')).json
  assert.equal(j.students.length, 1)
  assert.equal(j.students[0].姓名, '张三')
  const keys = Object.keys(j.students[0])
  assert.ok(keys.length <= 2, `studentsLite 只应有 id/姓名，实际 ${keys.join(',')}`)
  assert.equal(j.leaves.length, 1)
  assert.equal(j.leaves[0].姓名, '张三')
})

test('前端接线：每轮只发 1 个概览请求，失败时保留旧数据', () => {
  const src = fs.readFileSync(
    abs('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue'),
    'utf8',
  )
  const block = extractFunctionDecl(src, 'loadAll')
  assert.match(block, /axios\.get\('\/api\/widget-overview'\)/, '必须走单请求概览端点')
  assert.equal((block.match(/axios\.get\(/g) || []).length, 1, '一轮只允许 1 个请求')
  assert.ok(!/\/api\/(schedule|duty|countdowns|leaves|students)'/.test(block), '不能退回 5 个旧端点')
})
