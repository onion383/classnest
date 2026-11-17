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

test('写入中途失败：设置表 / 模板表也一起回滚', async () => {
  fresh()
  const readSettings = () => fx.conn.prepare("SELECT items, settings FROM duty_slots WHERE kind = 'settings'").get()
  const before = readSettings()
  // 让最后一步（写模板）失败：前面的设置表与当前表都必须一起回滚
  const orig = store.setDoc
  store.setDoc = function patched(name, patch) {
    if (name === 'duty_template') throw new Error('模拟写模板失败')
    return orig.call(this, name, patch)
  }
  try {
    const r = await callApi({
      ...BODY,
      items: [{ name: '扫地', count: 2, difficulty: 9 }], // difficulty 变了，好判断有没有写进去
      // 「扫地」在 schema 里 count=2，模板也必须排满 2 人，否则校验会先拦下来，
      // 用例就测不到「设置表已写、模板失败」的回滚场景。「新同学」由 active 的校验建档。
      master: { 扫地: { 周一: ['张三', '新同学'] } },
    })
    assert.ok(r.status >= 400, `应失败，实际 ${r.status}`)
    // 必须失败在「写模板」这一步：若提前在校验阶段就抛错，本用例根本没走到写入，
    // 回滚断言会假绿（前两步没写、后面自然也没有半截数据）。
    // 注意 /save 没有局部 try/catch（既有现状），异常会走 Express 默认错误页，
    // 所以判据看 r.text 而不是 r.json.error。
    assert.match(r.text, /模拟写模板失败/,
      '失败点不对，这条用例测不到「设置表已写、模板失败」的回滚场景')
  } finally {
    store.setDoc = orig
  }
  const after = readSettings()
  assert.equal(after.items, before.items, '设置表（劳动项目）不能只写一半')
  assert.equal(after.settings, before.settings, '模式配置不能只写一半')
  const cells = fx.conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells
  assert.equal(cells, '{}', '当前值日表也不该落库')
  const tpl = fx.conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'template'").get()
  assert.ok(!tpl || tpl.cells === '{}', '模板表不该落库')
})

test('接线：/save 的校验在 dutyWrite 的事务里', () => {
  const fs = require('node:fs')
  const strip = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  // 事务边界已下沉到 services/dutyWrite.js（M12 收尾）：判据跟着实现走，
  // 否则「校验在事务内」这件事会变成路由层一句注释，没人守。
  const svc = strip('student-backend/services/dutyWrite.js')
  const fnAt = svc.indexOf('function saveAll(')
  const txAt = svc.indexOf('db.transaction(', fnAt)
  const vActive = svc.indexOf("validateRow('duty_layout', { cells: active })", fnAt)
  const vMaster = svc.indexOf("validateRow('duty_template', { cells: master })", fnAt)
  assert.ok(fnAt > 0, '没找到 saveAll')
  assert.ok(vActive > txAt && vMaster > txAt, 'saveAll 的两处校验必须在 db.transaction 之后出现（即事务内）')

  // 反向守卫：路由不许把事务再开回来（一旦回退，上面那条判据就守错了文件）
  const route = strip('student-backend/routes/duty.js')
  assert.ok(!/db\.transaction\(/.test(route), 'duty 路由不许再有事务（应走 services/dutyWrite）')
  assert.ok(/dutyWrite\.saveAll\(/.test(route), '/save 必须真的走 dutyWrite.saveAll')
})
