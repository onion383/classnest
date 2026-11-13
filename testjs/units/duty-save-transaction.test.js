// =========================================================================
// duty-save-transaction.test.js —— 建档副作用必须与写入同事务（v6 · N2-06）
//
// 事故：`PUT /api/duty/save` 在事务**外**跑 validateRow，而值日校验会把名册外的姓名
// 直接建档（有意的副作用）。后面任一步失败（磁盘满/库忙/写模板抛错）→ 值日表回滚了，
// 临时学生却已经提交：名册里凭空多出一个没排进值日的人。
//
// 判据：① 保存成功时，新名字确实被建档（别把功能修死）
//       ② 写入中途失败 → 整体回滚，名册里不能留下那个新名字
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

// renumber 是从 db.js 里闭包导出、内部走 dbManager 绑定连接的：
// 不覆盖的话，建档时 insertRow 会因「未绑定数据库连接」失败 —— 那样测的就不是事务回滚了。
const fx = createBackendDb({ label: 'duty-save', extraDbExports: { renumber: () => {} } })
const store = require('../../student-backend/services/slotStore')

test.before(() => fx.mount('/api/duty', 'student-backend/routes/duty.js'))
test.after(() => fx.close())

const callApi = (body) => fx.call('PUT', '/save', body)

function fresh() {
  const conn = fx.reset()
  conn.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (1,'001','初二','3班','张三',14,'1','')").run()
  return conn
}
const hasStudent = (name) => fx.conn.prepare('SELECT COUNT(*) c FROM students WHERE 姓名 = ?').get(name).c > 0

// schema 初始化时已种下「扫地 count=2」等项目，人数要跟设置对上，否则校验先拦
const BODY = {
  mode: 'daily',
  days: ['周一'],
  items: [{ name: '扫地', count: 2, difficulty: 1 }],
  active: { 扫地: { 周一: ['新同学', '张三'] } },
}

test('保存成功：名册外的姓名被建档（这是有意行为，不能修没了）', async () => {
  fresh()
  const r = await callApi(BODY)
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.equal(hasStudent('新同学'), true, '值日表存姓名，不建档值日指数就会漏人')
})

test('写入中途失败：值日表回滚，临时学生也不能留下', async () => {
  fresh()
  // 让「写当前值日表」这一步失败（模拟磁盘满 / 库忙），此前已发生的建档必须一起回滚
  const orig = store.setDoc
  store.setDoc = function patched(name, patch) {
    if (name === 'duty_layout') throw new Error('模拟写入失败')
    return orig.call(this, name, patch)
  }
  try {
    const r = await callApi(BODY)
    assert.ok(r.status >= 400, `应失败，实际 ${r.status}`)
  } finally {
    store.setDoc = orig
  }
  assert.equal(hasStudent('新同学'), false, '名册里多出一个没排进值日的人 —— 就是 N2-06 要修的现象')
  const cells = fx.conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells
  assert.equal(cells, '{}', '值日表本身也要回到原样')
})

test('接线：/save 的校验已经挪进事务里', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/duty.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const saveAt = src.indexOf("router.put('/save'")
  const txAt = src.indexOf('db.transaction(', saveAt)
  const vActive = src.indexOf("validateRow('duty_layout', { cells: active })", saveAt)
  const vMaster = src.indexOf("validateRow('duty_template', { cells: master })", saveAt)
  assert.ok(vActive > txAt && vMaster > txAt, '/save 的两处校验必须在 db.transaction 之后出现（即事务内）')
})
