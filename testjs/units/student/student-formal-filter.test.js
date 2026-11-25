// =========================================================================
// student-formal-filter.test.js —— 学生管理只列正式学生（?formal=1）
//
// 背景：临时学生（值日/座位/分组里直接填名字自动建的档）与正式学生共用 students 表，
// 只在 is_provisional 上区分。学生管理表格不该混进它们（分辨不出、也算进人数与导出），
// 但分组候选 / 座位与值日输入 / 点名器 / 桌面小组件都要能看到临时学生 ——
// 所以过滤只能是「按请求参数 opt-in」，不能改全局。
//
// 本用例锁三件事：
//   ① 不带 formal：正式与临时都在（其它使用方的口径不能变）；
//   ② formal=1：只剩正式学生（过滤真的落在 SQL 上，不是前端筛的）；
//   ③ app.js 的 students 路由确实接上了这条过滤（防止以后被删掉）。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'student-formal-filter' })
const conn = fx.conn

// 从 app.js 的 students 路由配置里解析出真实的 listWhere 表达式（T08-03）。
// 以前这里复刻一份同样的箭头函数 —— 源码改了复刻没改，行为用例照样绿。
// 现在直接取真实表达式编译：app.js 的过滤方向变了，下面 ①② 会立刻失败。
function listWhereExpr(src) {
  const start = src.indexOf("createDynamicTableRouter('students'")
  assert.ok(start >= 0, 'app.js 里找不到 students 路由配置')
  const block = src.slice(start)
  const lwStart = block.indexOf('listWhere:')
  assert.ok(lwStart >= 0, 'students 路由缺少 listWhere 配置')
  const lwEnd = block.indexOf('extraRoutes:', lwStart)
  assert.ok(lwEnd > lwStart, '无法定位 listWhere 表达式边界')
  return block.slice(lwStart + 'listWhere:'.length, lwEnd).trim().replace(/,$/, '').trim()
}

const compileWhere = (expr) => new Function(`return (${expr})`)()
const APP_SRC = fs.readFileSync(abs('student-backend/app.js'), 'utf8')
const listWhere = compileWhere(listWhereExpr(APP_SRC))

let base
test.before(async () => {
  const { createDynamicTableRouter } = require('../../../student-backend/routes/dynamicTable')
  conn.prepare("INSERT INTO students (姓名, 学号, is_provisional) VALUES ('正式甲', '001', 0)").run()
  conn.prepare("INSERT INTO students (姓名, 学号, is_provisional) VALUES ('临时乙', '', 1)").run()
  base = await fx.mount(
    '/api/students',
    createDynamicTableRouter('students', { protectedColumns: ['学号', '姓名'], listWhere })
  )
})

test.after(() => fx.close())

const names = (json) => (json.data || []).map((r) => r.姓名)

test('不带 formal：正式与临时都返回（其它使用方的全量口径不变）', async () => {
  const r = await fx.call('GET', '/')
  assert.equal(r.status, 200)
  assert.deepEqual(names(r.json).sort(), ['临时乙', '正式甲'].sort())
})

test('formal=1：只返回正式学生', async () => {
  const r = await fx.call('GET', '/?formal=1')
  assert.equal(r.status, 200)
  assert.deepEqual(names(r.json), ['正式甲'])
})

test('formal 传其它值：按全量处理（不是「非 1 就过滤」的反向误伤）', async () => {
  const r = await fx.call('GET', '/?formal=0')
  assert.equal(r.status, 200)
  assert.equal(names(r.json).length, 2)
})

test('app.js 的 students 路由确实接上了 formal 过滤', () => {
  const src = fs.readFileSync(abs('student-backend/app.js'), 'utf8')
  // 允许中间夹注释：只要求「同一个 createDynamicTableRouter('students') 配置块里」出现这两样
  const block = src.slice(src.indexOf("createDynamicTableRouter('students'"))
  assert.match(block.slice(0, 800), /listWhere:/, 'students 路由缺少 listWhere 配置')
  assert.match(block.slice(0, 800), /is_provisional = 0/, '过滤条件丢失')
  assert.match(block.slice(0, 800), /formal/, 'formal 查询参数没人读')
})

test('变异反证：把真实 listWhere 的过滤方向写反，方向判据必须失败', async () => {
  // 取 app.js 的真实表达式，只把 `is_provisional = 0` 改成 `= 1`（原 bug 的反向），
  // 用同一路由 + 同一份数据验证：如果实现方向写反，`formal=1` 会返回临时学生。
  const expr = listWhereExpr(APP_SRC)
  const mutatedExpr = expr.replace('is_provisional = 0', 'is_provisional = 1')
  assert.notEqual(mutatedExpr, expr, '变异未匹配到过滤方向')

  const { createDynamicTableRouter } = require('../../../student-backend/routes/dynamicTable')
  await fx.mount(
    '/api/students-mut',
    createDynamicTableRouter('students', { protectedColumns: ['学号', '姓名'], listWhere: compileWhere(mutatedExpr) }),
  )
  const r = await fx.call('GET', '/api/students-mut/?formal=1')
  assert.equal(r.status, 200)
  assert.deepEqual(names(r.json), ['临时乙'], '过滤方向写反后 formal=1 只剩临时学生 —— 正例判据必然失败')
})
