// =========================================================================
// fk-reject-probe.cjs —— 外键严格的表收到「不存在的 student_id」时会怎样：
// 400 明确报错 / 500 崩溃 / 静默写入一行脏数据。
//
// 为什么要有：三种结果都「看起来保存成功」，只有跑一遍才能分清。
// 静默写入最难发现 —— 页面上正常显示，直到某天统计人数对不上。
//
// 判据（v8 · T01-01 / N1-01 闸门化）：
//   ① 路由层：每条写入口必须回 4xx（不是 5xx、更不是 2xx），且表里不留 9999 脏行；
//   ② 数据库层：绕过路由直写孤儿行必须被外键拒绝（changes === 0）——
//      这条是「外键被注释掉 / 被 try-catch 吞掉」时唯一会立刻变红的用例；
//   ③ 任何用例被静默跳过（空库等）都算失败，退出码非 0。
// 退出码：有失败 → 1，全部通过 → 0（挂进 testjs/run-probes.cjs）。
//
// 跑法：node testjs/probe/fk-reject-probe.cjs
// 依赖：testjs/units/_db-express-fixture.cjs（内存库）。
// 来历：2026-11-21 从 testjs/tmp 转正，tmp 里的原文件已删除，以本文件为准。
// =========================================================================
const assert = require('node:assert/strict')
const { createBackendDb } = require('../units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'audit-reject-paths' })

const ORPHAN_ID = 9999
const EXPECTED_CASES = 7
let total = 0
let failed = 0
let executed = 0

function check(label, fn) {
  total++
  executed++
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (e) {
    failed++
    console.error(`FAIL ${label}\n     ${e && e.message ? e.message : e}`)
  }
}

// 某张表里是否有指向不存在学生的行（路由被绕过时最直接的脏数据证据）
function dirtyRows(table, column = 'student_id') {
  return fx.conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(ORPHAN_ID).n
}

function tableRows(table) {
  return fx.conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

function assertRejected(label, r, table) {
  check(label, () => {
    assert.ok(
      r.status >= 400 && r.status < 500,
      `应回 4xx（拒绝），实际 ${r.status} ${r.text}`
    )
    assert.ok(r.json && r.json.error, '4xx 必须带明确 error 文案')
    assert.equal(dirtyRows(table), 0, `${table} 写入了指向不存在学生的脏行`)
    assert.equal(tableRows(table), 0, `${table} 仍写出了记录（changes 不为 0）`)
  })
}

async function main() {
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
  await fx.mount('/api/cadres', 'student-backend/routes/cadres.js')
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
  await fx.mount('/api/seats', 'student-backend/routes/seats.js')

  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (1, ?, ?, 1)').run('张三', 'A001')
  }})

  // ⓪ 数据库层闸门：绕过路由直写孤儿行。外键被注释 / 被吞掉时这里会插入成功。
  check('数据库层：直写孤儿 score_record 必须被外键拒绝', () => {
    let err = null
    try {
      fx.conn.prepare('INSERT INTO score_records (student_id, 姓名, 分值) VALUES (?, ?, 1)').run(ORPHAN_ID, '孤儿')
    } catch (e) { err = e }
    assert.ok(err, '外键未生效：孤儿行被静默写入')
    assert.match(String(err.message), /FOREIGN KEY/i, `应是外键约束错误，实际：${err.message}`)
    assert.equal(dirtyRows('score_records'), 0, 'score_records 残留脏行')
  })

  // ① 请假 POST 传不存在的 student_id
  // 注意参数名：leaves 读的是驼峰 studentId，不是 snake_case。写成 student_id 会落进
  // 「没传 id、按姓名解析」的分支，于是正常建档 + 200 —— 看起来像「静默接受」，其实是
  // 这条用例没测到目标路径（2026-11-21 转正后跑一遍才发现）。
  let r = await fx.call('POST', '/api/leaves', { studentId: ORPHAN_ID, 姓名: '张三', 开始时间: '2026-11-01', 结束时间: '2026-11-02' })
  assertRejected('leaves POST 不存在的 studentId', r, 'leave_records')

  // ② 班干部成员传不存在的 student_id
  const cadreId = fx.conn.prepare("INSERT INTO cadres (name, sort_order) VALUES ('班长', 1)").run().lastInsertRowid
  r = await fx.call('POST', `/api/cadres/${cadreId}/members`, { student_id: ORPHAN_ID, student_name: '张三' })
  assertRejected('cadres POST 不存在的 student_id', r, 'cadre_members')

  // ③ 分组传不存在的 student_id
  const dimId = fx.conn.prepare(
    "INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order) VALUES ('宿舍组','组长',6,2,1,1)"
  ).run().lastInsertRowid
  const gid = fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 1)').run(dimId, '301').lastInsertRowid
  r = await fx.call('POST', `/api/group-manage/groups/${gid}/members`, { student_id: ORPHAN_ID, member_name: '张三' })
  assertRejected('group POST 不存在的 student_id', r, 'group_members')

  // ④ 加减分 POST 传不存在的 studentId
  r = await fx.call('POST', '/api/scores', { studentId: ORPHAN_ID, 项目: 'x', 分值: 1 })
  assertRejected('scores POST 不存在的 studentId', r, 'score_records')

  // ⑤ 座位单格写不存在的 id
  r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 0, value: ORPHAN_ID })
  check('seats PATCH cell 不存在的 id', () => {
    assert.ok(r.status >= 400 && r.status < 500, `应回 4xx，实际 ${r.status} ${r.text}`)
    assert.ok(r.json && r.json.error, '4xx 必须带明确 error 文案')
    const row = fx.conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get()
    const cells = row ? JSON.parse(row.seats || '[]') : []
    assert.ok(!JSON.stringify(cells).includes(String(ORPHAN_ID)), 'seat_slots.seats 写入了孤儿 id')
  })

  // 注：值日格（duty）不是外键路径 —— cells 里存的是姓名/数字 id 的 JSON，没有 FK，
  // 名册外姓名会按设计建档、数字 id 原样跳过。拿它当 FK 用例只会得到「假通过」，
  // 故不在此探针内，改由值日域自己的契约测试覆盖。

  // ⑥ 唯一同名且名字匹配 → 复用正式学生（反向验证探针本身没把「正常写入」也判成拒绝）
  r = await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: 'y', 分值: 2 })
  check('scores POST 唯一同名 → 复用正式学生', () => {
    assert.equal(r.status, 200, `正常写入应 200，实际 ${r.status} ${r.text}`)
    const last = fx.conn.prepare('SELECT student_id FROM score_records ORDER BY id DESC LIMIT 1').get()
    assert.equal(last && last.student_id, 1, '应复用 id=1 的正式学生')
    const n = fx.conn.prepare('SELECT COUNT(*) AS n FROM students').get().n
    assert.equal(n, 1, '不得为同名再建一个学生')
  })

  // 用例被静默跳过（例如库没建好、某段被注释）必须判失败，不能「零用例 = 绿」
  total++
  try {
    assert.ok(executed >= EXPECTED_CASES, `只执行了 ${executed}/${EXPECTED_CASES} 条用例，有用例被静默跳过`)
    console.log(`ok   用例数 ${executed}/${EXPECTED_CASES}`)
  } catch (e) {
    failed++
    console.error(`FAIL 用例数\n     ${e && e.message ? e.message : e}`)
  }

  console.log(`\n=== 拒绝路径审计：${total - failed}/${total} 通过 ===`)
  fx.close()
  process.exitCode = failed ? 1 : 0
}

main().catch((e) => {
  console.error('FAIL', e && e.stack || e)
  fx.close()
  process.exit(1)
})
