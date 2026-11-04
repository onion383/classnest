// =========================================================================
// data-write-guards-probe.cjs —— 「部分更新 / 跨字段校验 / 名额上限」四条写入守卫的回归探针
//
// 覆盖：
//   1) PUT /api/widgets：只传一个字段时不得把其余字段写成 0 / 空串；
//   2) PUT /api/leaves/:id：只改「结束时间」时仍要校验「结束晚于开始」；
//   3) POST /api/cadres/members/:id/move：跨职务移动要守目标 max_count；
//   4) PUT /api/group-manage/dimensions/:id（内置宿舍）：数量不变时不得清空成成员分配。
// 另带一条 schema 播种断言：duty_slots.items 必须是 {daily,big} 分键结构。
//
// 做法：内存库 + initSchema → require.cache 把 ../db 换成这个连接 → 挂真实 express 路由发 HTTP。
// 不碰真实班级库。
//
// 用法：node testjs/probe/data-write-guards-probe.cjs
// 退出码：有断言失败 → 1，否则 0。
// =========================================================================
const path = require('path')
// 关服务要强制断开存量 keep-alive 连接，否则事件循环仍有活 handle → 脚本永不退出
const { closeServer } = require('../tools/closeServer.cjs')
const http = require('http')
const assert = require('assert/strict')

const BACKEND = path.join(__dirname, '../../student-backend')
const Database = require(path.join(BACKEND, 'node_modules/better-sqlite3-multiple-ciphers'))
const express = require(path.join(BACKEND, 'node_modules/express'))

const conn = new Database(':memory:')
require(path.join(BACKEND, 'schema/schema.js')).initSchema(conn)

// ==================== 把 ../db 换成内存连接 ====================
const dbPath = require.resolve(path.join(BACKEND, 'db.js'))
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    db: conn,
    getFields(tableName) {
      return conn.prepare('SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(tableName)
    },
    renumber(tableName) {
      const rows = conn.prepare(`SELECT id FROM ${tableName} ORDER BY position, id`).all()
      if (!rows.length) return
      const stmt = conn.prepare(`UPDATE ${tableName} SET position = ? WHERE id = ?`)
      conn.transaction(() => { rows.forEach((r, i) => stmt.run(i + 1, r.id)) })()
    },
  },
}

const app = express()
app.use(express.json())
app.use('/api/widgets', require(path.join(BACKEND, 'routes/widgetSettings.js')))
app.use('/api/leaves', require(path.join(BACKEND, 'routes/leaves.js')))
app.use('/api/cadres', require(path.join(BACKEND, 'routes/cadres.js')))
app.use('/api/group-manage', require(path.join(BACKEND, 'routes/groupManage.js')))
// 与 app.js 的错误处理对齐：未捕获的同步异常 → 500 { error }
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  res.status(Number(err && err.status) || 500).json({ error: err.message })
})

// ==================== HTTP 小工具 ====================
let server
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: url, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        let json = null
        try { json = text ? JSON.parse(text) : null } catch (_) { json = text }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const cases = []
async function check(name, fn) {
  try { await fn(); cases.push([true, name]) } catch (e) { cases.push([false, name, e]) }
}

async function main() {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })

  // ==================== 1. 小组件设置：补丁式更新 ====================
  const seedW = await request('PUT', '/api/widgets', {
    toolboxEnabled: true, noteSavePath: 'D:/notes-original', screenshotSavePath: 'D:/shot-original',
  })
  await check('widgets：完整保存 200', () => assert.equal(seedW.status, 200))

  const partial = await request('PUT', '/api/widgets', { screenshotSavePath: 'D:/shot-new' })
  await check('widgets：只传截屏目录仍 200', () => assert.equal(partial.status, 200))

  const afterW = conn.prepare('SELECT * FROM widget_settings WHERE id = 1').get()
  await check('widgets：未传的 toolboxEnabled 保持 1（不被写成 0）', () => assert.equal(afterW.toolbox_enabled, 1))
  await check('widgets：未传的 note_save_path 保持原值（不被清空）', () => assert.equal(afterW.note_save_path, 'D:/notes-original'))
  await check('widgets：传入的 screenshot_save_path 已更新', () => assert.equal(afterW.screenshot_save_path, 'D:/shot-new'))

  // ==================== 2. 请假：部分更新仍校验时间窗口 ====================
  const insLeave = conn.prepare(
    "INSERT INTO leave_records (姓名, 开始时间, 结束时间, position) VALUES ('甲', '2026-11-01 08:00', '2026-11-03 08:00', 1)"
  ).run()
  const leaveId = insLeave.lastInsertRowid

  const bad = await request('PUT', `/api/leaves/${leaveId}`, { 结束时间: '2026-10-30 08:00' })
  await check('leaves：只改结束时间到开始之前 → 400', () => assert.equal(bad.status, 400))
  await check('leaves：拒绝时库里旧值未变', () => {
    assert.equal(conn.prepare('SELECT 结束时间 FROM leave_records WHERE id = ?').get(leaveId).结束时间, '2026-11-03 08:00')
  })

  const good = await request('PUT', `/api/leaves/${leaveId}`, { 结束时间: '2026-11-05 08:00' })
  await check('leaves：合法的结束时间 → 200 且已落库', () => {
    assert.equal(good.status, 200)
    assert.equal(conn.prepare('SELECT 结束时间 FROM leave_records WHERE id = ?').get(leaveId).结束时间, '2026-11-05 08:00')
  })

  const noteOnly = await request('PUT', `/api/leaves/${leaveId}`, { 备注: '家长来电' })
  await check('leaves：只改备注不被时间校验误拦', () => assert.equal(noteOnly.status, 200))

  // ==================== 3. 班干部：移动担任学生守名额 ====================
  const leaderId = conn.prepare("INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES ('班长', 0, 1, 0)").run().lastInsertRowid
  const viceId = conn.prepare("INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES ('副班长', 0, 5, 1)").run().lastInsertRowid
  conn.prepare("INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?, NULL, '甲', 0)").run(leaderId)
  const viceMem = conn.prepare("INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?, NULL, '乙', 0)").run(viceId).lastInsertRowid

  const over = await request('POST', `/api/cadres/members/${viceMem}/move`, { cadre_id: leaderId })
  await check('cadres：往已满的「班长」拖动 → 400', () => assert.equal(over.status, 400))
  await check('cadres：拒绝后成员仍在原职务', () => {
    assert.equal(conn.prepare('SELECT cadre_id FROM cadre_members WHERE id = ?').get(viceMem).cadre_id, viceId)
  })

  const same = await request('POST', `/api/cadres/members/${viceMem}/move`, { cadre_id: viceId })
  await check('cadres：同职务内拖动（人数不变）不拦', () => assert.equal(same.status, 200))

  // ==================== 4. 宿舍组：数量不变不清空分配 ====================
  const dimId = conn.prepare('SELECT id FROM group_dimensions WHERE is_default = 1').get()?.id
    || conn.prepare("INSERT INTO group_dimensions (name, is_default, sort_order, male_group_count, female_group_count) VALUES ('宿舍组', 1, 1, 0, 0)").run().lastInsertRowid

  await request('PUT', `/api/group-manage/dimensions/${dimId}`, { male_group_count: 2, female_group_count: 1 })
  const dorm1 = conn.prepare('SELECT id FROM groups WHERE dimension_id = ? ORDER BY sort_order LIMIT 1').get(dimId).id
  conn.prepare("INSERT INTO group_members (group_id, member_name, sort_order) VALUES (?, '甲', 0)").run(dorm1)
  conn.prepare("INSERT INTO group_members (group_id, member_name, sort_order) VALUES (?, '乙', 1)").run(dorm1)

  const keep = await request('PUT', `/api/group-manage/dimensions/${dimId}`, { members_per_group: 8 })
  await check('group-manage：数量不变时成员分配保留', () => {
    assert.equal(keep.status, 200)
    const names = conn.prepare('SELECT member_name FROM group_members WHERE group_id = ? ORDER BY sort_order').all(dorm1).map(r => r.member_name)
    assert.deepEqual(names, ['甲', '乙'])
  })

  // 减少男生宿舍：只删尾部那一组，留下的组（含成员）不动
  const maleGroups = conn.prepare('SELECT id FROM groups WHERE dimension_id = ? AND gender = 0 ORDER BY sort_order').all(dimId)
  conn.prepare("INSERT INTO group_members (group_id, member_name, sort_order) VALUES (?, '丙', 0)").run(maleGroups[1].id)
  const shrink = await request('PUT', `/api/group-manage/dimensions/${dimId}`, { male_group_count: 1 })
  await check('group-manage：减少宿舍数只删尾部组，保留组的成员不动', () => {
    assert.equal(shrink.status, 200)
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM groups WHERE dimension_id = ? AND gender = 0').get(dimId).n, 1)
    const names = conn.prepare('SELECT member_name FROM group_members WHERE group_id = ? ORDER BY sort_order').all(dorm1).map(r => r.member_name)
    assert.deepEqual(names, ['甲', '乙'])
  })

  // ==================== 5. 值日项目播种结构 ====================
  await check('schema.duty：items 播种为 {daily,big} 分键结构，daily 有 3 个项目', () => {
    const row = conn.prepare("SELECT items FROM duty_slots WHERE kind = 'settings'").get()
    const parsed = JSON.parse(row.items)
    assert.ok(Array.isArray(parsed.daily) && parsed.daily.length === 3, `daily=${JSON.stringify(parsed.daily)}`)
    assert.ok(Array.isArray(parsed.big) && parsed.big.length === 3, `big=${JSON.stringify(parsed.big)}`)
    assert.equal(parsed.daily[0].name, '擦黑板')
  })

  await closeServer(server)
  let failed = 0
  for (const [ok, name, err] of cases) {
    if (ok) console.log(`  PASS  ${name}`)
    else { failed++; console.error(`  FAIL  ${name}\n        ${err && err.message}`) }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
