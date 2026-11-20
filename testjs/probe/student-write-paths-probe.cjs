// =========================================================================
// student-write-paths-probe.cjs —— 所有「写学生」的入口：名册外姓名会不会建档、
// 改姓名会不会重认 student_id。
//
// 为什么要有：只读代码判断容易漏 —— 写学生的入口散在加减分 / 请假 / 班干部 / 分组，
// 每个路由各自处理。这类错误不会在类型层面暴露，结果是「只有姓名没有 id」的孤儿行，
// 或者改了名却仍指向旧人的历史记录。所以用真实 HTTP 请求跑一遍，人看结论。
//
// 跑法：node testjs/probe/student-write-paths-probe.cjs
// 判读：看每行的 verdict ——「建档」「已重认」是预期；「未建档」「id 未变（仍指向旧人）」是问题。
// 依赖：testjs/units/_db-express-fixture.cjs（内存库，不需要真实班级数据）。
// 来历：2026-11-21 从 testjs/tmp 转正，tmp 里的原文件已删除，以本文件为准。
// =========================================================================
const path = require('node:path')
const { createBackendDb } = require('../units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'audit-write-paths' })
// reset() 会换连接，必须每次走 getter，不能缓存

function studentByName(name) {
  return fx.conn.prepare('SELECT id, 姓名, is_provisional FROM students WHERE 姓名 = ?').all(name)
}
function rowOf(table, id) {
  return fx.conn.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id)
}
function count(table) {
  return fx.conn.prepare(`SELECT count(*) c FROM "${table}"`).get().c
}

const out = []
function record(label, detail) { out.push({ label, ...detail }) }

async function main() {
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
  await fx.mount('/api/cadres', 'student-backend/routes/cadres.js')
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')

  // ---------- 基线：一个正式学生 ----------
  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (1, ?, ?, 1)').run('张三', 'A001')
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (2, ?, ?, 2)').run('李四', 'A002')
  }})

  // ① 加减分：POST 名册外姓名 —— 期望建档
  let r = await fx.call('POST', '/api/scores', { 姓名: '转学生甲', 项目: '值日', 分值: 2 })
  const pA = studentByName('转学生甲')
  record('scores POST 名册外姓名', {
    status: r.status,
    created: pA.length,
    studentId: pA.length ? pA[0].id : null,
    verdict: pA.length === 1 ? '建档' : '未建档',
  })

  // ② 加减分：import 名册外姓名 —— 期望建档（P0 只改了请假导入）
  r = await fx.call('POST', '/api/scores/import', {
    fields: ['姓名', '项目', '分值'],
    rows: [['转学生乙', '值日', '3']],
    mode: 'personal',
  })
  const pB = studentByName('转学生乙')
  record('scores import 名册外姓名', {
    status: r.status,
    created: pB.length,
    studentId: pB.length ? pB[0].id : null,
    verdict: pB.length === 1 ? '建档' : '未建档',
  })

  // ③ 加减分：PUT 改姓名 —— 期望重认 / 至少不能指向旧人
  const firstScore = fx.conn.prepare('SELECT * FROM score_records ORDER BY id LIMIT 1').get()
  if (firstScore) {
    r = await fx.call('PUT', `/api/scores/${firstScore.id}`, { 姓名: '改后的人' })
    const after = rowOf('score_records', firstScore.id)
    record('scores PUT 改姓名', {
      status: r.status,
      before: { 姓名: firstScore.姓名, student_id: firstScore.student_id },
      after: { 姓名: after.姓名, student_id: after.student_id },
      verdict: after.student_id === firstScore.student_id ? 'id 未变（仍指向旧人）' : '已重认',
    })
  }

  // ④ 请假：import 名册外姓名 —— 期望建档（对照）
  r = await fx.call('POST', '/api/leaves/import', {
    fields: ['姓名', '开始时间', '结束时间'],
    rows: [['请假丙', '2026-11-01', '2026-11-02']],
  })
  const pC = studentByName('请假丙')
  record('leaves import 名册外姓名', {
    status: r.status,
    created: pC.length,
    verdict: pC.length === 1 ? '建档' : '未建档',
  })

  // ⑤ 请假：PUT 改姓名
  const firstLeave = fx.conn.prepare('SELECT * FROM leave_records ORDER BY id LIMIT 1').get()
  if (firstLeave) {
    r = await fx.call('PUT', `/api/leaves/${firstLeave.id}`, { 姓名: '请假改后' })
    const after = rowOf('leave_records', firstLeave.id)
    record('leaves PUT 改姓名', {
      status: r.status,
      before: { 姓名: firstLeave.姓名, student_id: firstLeave.student_id },
      after: { 姓名: after.姓名, student_id: after.student_id },
      verdict: after.student_id === firstLeave.student_id ? 'id 未变（仍指向旧人）' : '已重认',
    })
  }

  // ⑥ 班干部：POST 成员名册外姓名 —— 期望建档
  const cadreId = fx.conn.prepare("INSERT INTO cadres (name, sort_order) VALUES ('班长', 1)").run().lastInsertRowid
  r = await fx.call('POST', `/api/cadres/${cadreId}/members`, { student_name: '班干丁' })
  const pD = studentByName('班干丁')
  record('cadres POST 成员名册外', {
    status: r.status,
    created: pD.length,
    verdict: pD.length === 1 ? '建档' : '未建档',
  })

  // ⑦ 分组：POST 成员名册外姓名 —— 期望建档 + 回填 id
  const dimId = fx.conn.prepare(
    "INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order) VALUES ('宿舍组','组长',6,2,1,1)"
  ).run().lastInsertRowid
  const gid = fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 1)').run(dimId, '301').lastInsertRowid
  r = await fx.call('POST', `/api/group-manage/groups/${gid}/members`, { member_name: '组员戊' })
  const pE = studentByName('组员戊')
  const gm = fx.conn.prepare('SELECT * FROM group_members ORDER BY id DESC LIMIT 1').get()
  record('group POST 成员名册外', {
    status: r.status,
    created: pE.length,
    memberRow: gm ? { member_name: gm.member_name, student_id: gm.student_id } : null,
    verdict: pE.length === 1 && gm && gm.student_id ? '建档 + 回填 id' : '不完整',
  })

  // ---------- 汇总 ----------
  console.log('\n=== 写入路径审计 ===')
  for (const o of out) console.log(JSON.stringify(o, null, 0))
  fx.close()
}

main().catch((e) => { console.error('FAIL', e && e.stack || e); fx.close(); process.exit(1) })
