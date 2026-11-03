/**
 * undo-batch-test.cjs —— 撤销「批次」语义回归（真实加密库 + 真实路由）
 *
 * 背景：一次用户动作可能登记多条撤销记录（拖一次座位改动多格、课表一次更新多个格）。
 * 这些记录共用同一个 origin，后端 Ctrl+Z / Ctrl+Y 按 origin 整批回退 / 整批重做；
 * 无 origin 的普通记录保持旧的「一次退一条」语义。
 *
 * 覆盖：
 *   · 无 origin：按一次只退最近一条，前面的记录不动
 *   · 同 origin（同 key）：一次 undo 全退，一次 redo 全回，label 折叠成「一次改动（N 项）」
 *   · 同 origin（跨 key）：从任一张表触发都整批回退
 *   · 批次撤销后登记新动作：redo 侧按既有规则失效
 *
 * 跑法：node testjs/smoke/undo-batch-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const NM = path.join(BACKEND, 'node_modules')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-batch-'))
process.env.DB_MASTER_KEY = 'undo-batch-test-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'thumbs')

const express = require(path.join(NM, 'express'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const undoRouter = require(path.join(BACKEND, 'routes', 'undo', 'undo'))

const USERNAME = 'undo-batch-test'
const { slug } = dbManager.createTeacher(USERNAME, 'no-hash', 'teacher')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) console.log('    →', JSON.stringify(detail).slice(0, 400))
}

// 造数据：3 名学生 + 1 条活动（用于跨 key 批次）
dbManager.withDb(slug, () => {
  const conn = dbManager.current()
  const insS = conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)')
  insS.run(1, '张三')
  insS.run(2, '李四')
  insS.run(3, '王五')
  conn.prepare('INSERT INTO activities (id, 主题) VALUES (?, ?)').run(1, '春游')
})

const readCell = (table, id, field) => dbManager.withDb(slug, () => {
  const row = dbManager.current().prepare(`SELECT "${field}" FROM "${table}" WHERE id = ?`).get(id)
  return row ? row[field] : undefined
})
// 撤销登记本身不改数据：这里显式把「老师改完的值」写进库，模拟真实顺序（先改库、后登记）
const applyCell = (table, id, field, value) => dbManager.withDb(slug, () => {
  dbManager.current().prepare(`UPDATE "${table}" SET "${field}" = ? WHERE id = ?`).run(value, id)
})

function request(port, { method = 'GET', p = '/', body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c.toString('utf8') })
      res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch (_) { } resolve({ status: res.statusCode, json, text }) })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const app = express()
app.use(express.json({ limit: '4mb' }))
const bind = (req, res, next) => {
  req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
  dbManager.withDb(slug, () => next())
}
app.use('/api/undo', bind, undoRouter)

;(async () => {
  const server = app.listen(0)
  const port = server.address().port

  // 登记一条单元格撤销
  const pushCell = (key, table, rowId, field, oldValue, newValue, origin = '') => request(port, {
    method: 'POST',
    p: '/api/undo',
    body: {
      key,
      type: 'cell_update',
      label: `${field}：「${oldValue}」→「${newValue}」`,
      payload: { table, rowId, field, oldValue, newValue },
      origin,
    },
  })

  // ===== 1. 无 origin：一次只退一条 =====
  await pushCell('students', 'students', 1, '姓名', '张三', '张三A')
  applyCell('students', 1, '姓名', '张三A')
  await pushCell('students', 'students', 2, '姓名', '李四', '李四A')
  applyCell('students', 2, '姓名', '李四A')
  const undo1 = await request(port, { method: 'POST', p: '/api/undo/table/students/undo' })
  check('无 origin：撤销成功', undo1.json && undo1.json.ok === true, undo1.text)
  check('无 origin：只退最近一条（李四 回到原值）', readCell('students', 2, '姓名') === '李四', readCell('students', 2, '姓名'))
  check('无 origin：更早那条不动（张三 仍是张三A）', readCell('students', 1, '姓名') === '张三A', readCell('students', 1, '姓名'))
  const redo1 = await request(port, { method: 'POST', p: '/api/undo/table/students/redo' })
  check('无 origin：重做回到最近一条', redo1.json && redo1.json.ok === true && readCell('students', 2, '姓名') === '李四A', readCell('students', 2, '姓名'))

  // ===== 2. 同 origin 同 key：一次退完、一次回完 =====
  const batch = 'op-smoke-1'
  await pushCell('students', 'students', 1, '姓名', '张三A', '张三B', batch)
  applyCell('students', 1, '姓名', '张三B')
  await pushCell('students', 'students', 2, '姓名', '李四A', '李四B', batch)
  applyCell('students', 2, '姓名', '李四B')
  await pushCell('students', 'students', 3, '姓名', '王五', '王五B', batch)
  applyCell('students', 3, '姓名', '王五B')
  const undo2 = await request(port, { method: 'POST', p: '/api/undo/table/students/undo' })
  check('批次撤销成功', undo2.json && undo2.json.ok === true, undo2.text)
  check('批次撤销：影响 3 条', undo2.json && undo2.json.batch === 3, undo2.json)
  check('批次撤销：文案折叠成「一次改动（3 项）」', undo2.json && undo2.json.label === '一次改动（3 项）', undo2.json && undo2.json.label)
  check('批次撤销：3 行全部回到批次前', readCell('students', 1, '姓名') === '张三A' && readCell('students', 2, '姓名') === '李四A' && readCell('students', 3, '姓名') === '王五', [readCell('students', 1, '姓名'), readCell('students', 2, '姓名'), readCell('students', 3, '姓名')])
  const redo2 = await request(port, { method: 'POST', p: '/api/undo/table/students/redo' })
  check('批次重做：影响 3 条', redo2.json && redo2.json.batch === 3, redo2.json)
  check('批次重做：3 行全部回到批次后', readCell('students', 1, '姓名') === '张三B' && readCell('students', 2, '姓名') === '李四B' && readCell('students', 3, '姓名') === '王五B', [readCell('students', 1, '姓名'), readCell('students', 2, '姓名'), readCell('students', 3, '姓名')])

  // ===== 3. 同 origin 跨 key：从任一张表触发都整批退 =====
  const cross = 'op-smoke-2'
  await pushCell('students', 'students', 1, '姓名', '张三B', '张三C', cross)
  applyCell('students', 1, '姓名', '张三C')
  await pushCell('activities', 'activities', 1, '主题', '春游', '秋游', cross)
  applyCell('activities', 1, '主题', '秋游')
  const undo3 = await request(port, { method: 'POST', p: '/api/undo/table/students/undo' })
  check('跨表批次：从 students 触发即整批', undo3.json && undo3.json.batch === 2, undo3.json)
  check('跨表批次：另一张表的数据也回退了', readCell('activities', 1, '主题') === '春游', readCell('activities', 1, '主题'))

  // ===== 4. 批次撤销后登记新动作 → redo 侧失效（既有规则） =====
  const st1 = await request(port, { p: '/api/undo/table/students/status' })
  const stA = await request(port, { p: '/api/undo/table/activities/status' })
  check('批次撤销后：可重做态存在（两张表）', st1.json && st1.json.canRedo === true && stA.json && stA.json.canRedo === true, { st1: st1.json, stA: stA.json })
  await pushCell('students', 'students', 1, '姓名', '张三B', '张三D')
  applyCell('students', 1, '姓名', '张三D')
  const st2 = await request(port, { p: '/api/undo/table/students/status' })
  const stB = await request(port, { p: '/api/undo/table/activities/status' })
  check('新动作后：students 的 redo 侧被清空', st2.json && st2.json.canRedo === false, st2.json)
  // 修 1：跨表批次的另一半也必须失效，否则去 activities 按重做会只回一半
  check('新动作后：activities 的 redo 残尾也一起清空', stB.json && stB.json.canRedo === false, stB.json)

  // ===== 5. 设置页路径：列表带 origin，按 origin 整批撤销/重做 =====
  const batch3 = 'op-smoke-3'
  await pushCell('students', 'students', 1, '姓名', '张三D', '张三E', batch3)
  applyCell('students', 1, '姓名', '张三E')
  await pushCell('students', 'students', 2, '姓名', '李四B', '李四E', batch3)
  applyCell('students', 2, '姓名', '李四E')
  const list = await request(port, { p: '/api/undo' })
  const gStudents = (list.json.groups || []).find(x => x.key === 'students')
  const marked = (gStudents.records || []).filter(r => r.origin === batch3)
  check('列表记录带 origin（设置页折叠依据）', marked.length === 2, marked.length)
  const u5 = await request(port, { method: 'POST', p: `/api/undo/origin/${batch3}/undo` })
  check('按 origin 整批撤销（设置页按钮）', u5.json && u5.json.ok === true && u5.json.batch === 2, u5.text)
  check('整批撤销后数据回退', readCell('students', 1, '姓名') === '张三D' && readCell('students', 2, '姓名') === '李四B', [readCell('students', 1, '姓名'), readCell('students', 2, '姓名')])
  const r5 = await request(port, { method: 'POST', p: `/api/undo/origin/${batch3}/redo` })
  check('按 origin 整批重做', r5.json && r5.json.ok === true && r5.json.batch === 2, r5.text)
  check('整批重做后数据回来', readCell('students', 1, '姓名') === '张三E' && readCell('students', 2, '姓名') === '李四E', [readCell('students', 1, '姓名'), readCell('students', 2, '姓名')])

  server.close()
  console.log(failed ? `\n${failed} 条断言失败` : '\n全部通过')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
