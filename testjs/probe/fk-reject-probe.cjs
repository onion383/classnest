// =========================================================================
// fk-reject-probe.cjs —— 外键严格的表收到「不存在的 student_id」时会怎样：
// 400 明确报错 / 500 崩溃 / 静默写入一行脏数据。
//
// 为什么要有：三种结果都「看起来保存成功」，只有跑一遍才能分清。
// 静默写入最难发现 —— 页面上正常显示，直到某天统计人数对不上。
//
// 跑法：node testjs/probe/fk-reject-probe.cjs
// 判读：期望是 400 + 明确 error。出现 500 或 2xx 就是问题。
// 依赖：testjs/units/_db-express-fixture.cjs（内存库）。
// 来历：2026-11-21 从 testjs/tmp 转正，tmp 里的原文件已删除，以本文件为准。
// =========================================================================
const { createBackendDb } = require('../units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'audit-reject-paths' })

const out = []
const rec = (label, d) => out.push({ label, ...d })

async function main() {
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
  await fx.mount('/api/cadres', 'student-backend/routes/cadres.js')
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
  await fx.mount('/api/seats', 'student-backend/routes/seats.js')
  await fx.mount('/api/duty', 'student-backend/routes/duty.js')

  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (1, ?, ?, 1)').run('张三', 'A001')
  }})

  const fkOn = fx.conn.pragma('foreign_keys', { simple: true })
  rec('外键状态', { foreignKeys: fkOn })

  // ① 请假 POST 传不存在的 student_id
  // 注意参数名：leaves 读的是驼峰 studentId，不是 snake_case。写成 student_id 会落进
  // 「没传 id、按姓名解析」的分支，于是正常建档 + 200 —— 看起来像「静默接受」，其实是
  // 这条用例没测到目标路径（2026-11-21 转正后跑一遍才发现）。
  let r = await fx.call('POST', '/api/leaves', { studentId: 9999, 姓名: '张三', 开始时间: '2026-11-01', 结束时间: '2026-11-02' })
  rec('leaves POST 不存在的 studentId', { status: r.status, error: r.json && r.json.error })

  // ② 班干部成员传不存在的 student_id
  const cadreId = fx.conn.prepare("INSERT INTO cadres (name, sort_order) VALUES ('班长', 1)").run().lastInsertRowid
  r = await fx.call('POST', `/api/cadres/${cadreId}/members`, { student_id: 9999, student_name: '张三' })
  rec('cadres POST 不存在的 student_id', { status: r.status, error: r.json && r.json.error })

  // ③ 分组传不存在的 student_id
  const dimId = fx.conn.prepare(
    "INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order) VALUES ('宿舍组','组长',6,2,1,1)"
  ).run().lastInsertRowid
  const gid = fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 1)').run(dimId, '301').lastInsertRowid
  r = await fx.call('POST', `/api/group-manage/groups/${gid}/members`, { student_id: 9999, member_name: '张三' })
  rec('group POST 不存在的 student_id', { status: r.status, error: r.json && r.json.error })

  // ④ 加减分 POST 传不存在的 studentId
  r = await fx.call('POST', '/api/scores', { studentId: 9999, 项目: 'x', 分值: 1 })
  rec('scores POST 不存在的 studentId', { status: r.status, error: r.json && r.json.error })

  // ⑤ 座位单格写不存在的 id
  r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 0, value: 9999 })
  rec('seats PATCH cell 不存在的 id', { status: r.status, error: r.json && r.json.error })

  // ⑥ 值日 PUT 传不存在的 id（先取一份可用的 cells 结构）
  const duty = await fx.call('GET', '/api/duty?mode=daily')
  const cells = (duty.json && duty.json.cells) || {}
  const items = Object.keys(cells)
  if (items.length) {
    const item = items[0]
    const days = Object.keys(cells[item] || {})
    const day = days[0]
    if (day) {
      const next = JSON.parse(JSON.stringify(cells))
      next[item][day] = [9999, 9999]
      r = await fx.call('PUT', '/api/duty?mode=daily', { cells: next, settings: (duty.json && duty.json.settings) || {} })
      rec('duty PUT 不存在的 id', { status: r.status, error: r.json && r.json.error })
    }
  }

  // ⑦ 通用表格接口写 score_records（前端「加一行」走的是哪条？这里验证 /api/scores 之外没有别的口）
  r = await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: 'y', 分值: 2 })
  rec('scores POST 唯一同名 → 复用正式学生', { status: r.status, studentId: fx.conn.prepare('SELECT student_id FROM score_records ORDER BY id DESC LIMIT 1').get() })

  console.log('\n=== 拒绝路径审计 ===')
  for (const o of out) console.log(JSON.stringify(o))
  fx.close()
}

main().catch((e) => { console.error('FAIL', e && e.stack || e); fx.close(); process.exit(1) })
