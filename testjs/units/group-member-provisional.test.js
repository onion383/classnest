// =========================================================================
// group-member-provisional.test.js —— 小组成员的每个写入口都要给姓名建档
//
// 背景：`group_members.member_name` 只存姓名、没有 student_id（P2-1 才指针化）。
// 要让「成员名」和「名册里的某个人」是同一身份，姓名第一次出现时必须建一条
// is_provisional = 1 的 students 记录（共用 students.id，转正只改状态位）。
//
// 已有建档的入口：groupDim.addMember / updateMember / importMembers。
// 本用例锁住**补齐后的另外两个入口**，它们都是「按列名直写行」的通用写入器，
// 本身不知道哪一列是学生姓名：
//   ① 智能分组写回（POST /dimensions/:dimId/apply-grouping → replaceGroupMembers）
//   ② AI 批量写入（POST /api/ai/apply-batch，含 add 与 update 改名）
//
// 判据不能只测「学生表多了人」——那样把 group_members 写入整个删掉也会绿。
// 每条都同时断言「成员行存在」+「学生记录存在且身份正确」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

// renumber 在 db.js 里是闭包导出、内部走 dbManager 绑定的连接，单测里不需要
const fx = createBackendDb({ label: 'group-provisional', extraDbExports: { renumber: () => {} } })

test.before(async () => {
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
  await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
})
test.after(() => fx.close())

const all = (sql, ...args) => fx.conn.prepare(sql).all(...args)
const one = (sql, ...args) => fx.conn.prepare(sql).get(...args)
const studentsNamed = (name) => all('SELECT id, 姓名, is_provisional FROM students WHERE 姓名 = ? ORDER BY id', name)
const membersNamed = (name) => all('SELECT id, group_id, member_name FROM group_members WHERE member_name = ?', name)

const addStudent = (name, xuehao = '') =>
  fx.conn.prepare("INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)").run(xuehao, name)

// 建一个维度 + 2 个小组，返回 { dimId, groupIds }
function makeDim(name = '学习小组', groups = 2) {
  const dim = fx.conn.prepare(
    'INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count) VALUES (?,?,?,?)'
  ).run(name, '组长', 6, groups)
  const dimId = Number(dim.lastInsertRowid)
  for (let i = 1; i <= groups; i++) {
    fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?,?,?)').run(dimId, `第${i}组`, i)
  }
  const groupIds = all('SELECT id FROM groups WHERE dimension_id = ? ORDER BY sort_order, id', dimId).map((g) => g.id)
  return { dimId, groupIds }
}

// ============ ① 智能分组写回 ============

test('智能分组写回：名册外姓名建档，且每个姓名只有一条学生记录', async () => {
  fx.reset()
  const { dimId, groupIds } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/dimensions/${dimId}/apply-grouping`, {
    groups: [['组外甲', '组外乙'], ['组外丙']],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  assert.equal(all('SELECT id FROM group_members WHERE group_id = ?', groupIds[0]).length, 2, '成员行没写进去')
  for (const name of ['组外甲', '组外乙', '组外丙']) {
    const rows = studentsNamed(name)
    assert.equal(rows.length, 1, `「${name}」应恰好一条学生记录（实得 ${rows.length}）`)
    assert.equal(rows[0].is_provisional, 1, `「${name}」应为临时学生`)
    assert.equal(membersNamed(name).length, 1, `「${name}」的成员行不见了`)
  }
})

test('智能分组写回：名册里已有正式同名 → 复用，不建临时学生', async () => {
  fx.reset()
  addStudent('正式甲', '2026001')
  const { dimId } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/dimensions/${dimId}/apply-grouping`, {
    groups: [['正式甲'], []],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const rows = studentsNamed('正式甲')
  assert.equal(rows.length, 1, '不该为已有正式学生再建一条临时学生')
  assert.equal(rows[0].is_provisional, 0)
})

test('智能分组写回：同一姓名写回两次（重跑）不会越建越多', async () => {
  fx.reset()
  const { dimId } = makeDim()

  await fx.call('POST', `/api/group-manage/dimensions/${dimId}/apply-grouping`, { groups: [['重跑甲'], []] })
  await fx.call('POST', `/api/group-manage/dimensions/${dimId}/apply-grouping`, { groups: [['重跑甲'], []] })

  assert.equal(studentsNamed('重跑甲').length, 1, '第二次写回不该再建一条临时学生')
  assert.equal(membersNamed('重跑甲').length, 1, '写回是「清空重建」，不该残留两行')
})

// ============ ② AI 批量写入 ============

test('AI 批量新增组成员：名册外姓名建档（成员行与学生记录同时存在）', async () => {
  fx.reset()
  const { groupIds } = makeDim()

  const r = await fx.call('POST', '/api/ai/apply-batch', {
    ops: [{ action: 'add', table: 'group_members', data: { group_id: groupIds[0], member_name: 'AI外甲' } }],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  assert.equal(membersNamed('AI外甲').length, 1, '成员行没写进去')
  const rows = studentsNamed('AI外甲')
  assert.equal(rows.length, 1, 'AI 写进的名册外姓名必须建档，否则留下孤儿成员')
  assert.equal(rows[0].is_provisional, 1)
})

test('AI 批量新增组成员：已在名册 → 复用正式学生，不建临时', async () => {
  fx.reset()
  addStudent('AI正式乙', '2026002')
  const { groupIds } = makeDim()

  const r = await fx.call('POST', '/api/ai/apply-batch', {
    ops: [{ action: 'add', table: 'group_members', data: { group_id: groupIds[0], member_name: 'AI正式乙' } }],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const rows = studentsNamed('AI正式乙')
  assert.equal(rows.length, 1, '不该多建临时学生')
  assert.equal(rows[0].is_provisional, 0)
})

test('AI 批量改名：改成名册外的新姓名同样建档', async () => {
  fx.reset()
  const { groupIds } = makeDim()
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?,?,?,1)')
  const memberId = Number(ins.run(groupIds[0], '旧名丙', '').lastInsertRowid)

  const r = await fx.call('POST', '/api/ai/apply-batch', {
    ops: [{ action: 'update', table: 'group_members', id: memberId, changes: { member_name: '新名丙' } }],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  assert.equal(membersNamed('新名丙').length, 1, '改名没落到成员行')
  const rows = studentsNamed('新名丙')
  assert.equal(rows.length, 1, '改名后的新姓名必须建档')
  assert.equal(rows[0].is_provisional, 1)
})

test('AI 批量写别的表不受影响（映射只对小组成员生效）', async () => {
  fx.reset()
  const r = await fx.call('POST', '/api/ai/apply-batch', {
    ops: [{ action: 'add', table: 'countdowns', data: { 名称: '期中考试', 截止日: '2026-11-20', 包含这一天: 1 } }],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.equal(all('SELECT id FROM students').length, 0, '不该因为写倒计时而建学生')
})

// ============ ③ 接线判据（防止将来新增写入口绕过建档） ============

test('接线：group_members 的四个业务写入口都要认人', async () => {
  const fsMod = require('node:fs')
  const pathMod = require('node:path')
  const { ROOT } = require('./_db-express-fixture.cjs')
  const src = fsMod.readFileSync(pathMod.join(ROOT, 'student-backend/services/groupDim.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  // 每个函数体（从声明到下一个顶层 function）里必须出现认人调用。
  // P2-1 起 addMember/updateMember 走 resolveMemberRef（它同时能按 id 定人），
  // 另两个入口仍直接调 ensureProvisionalStudent —— 两者都算「认人」，判据收两者。
  const fnBody = (name) => {
    const at = src.indexOf(`function ${name}(`)
    assert.ok(at > 0, `找不到 ${name}`)
    const next = src.indexOf('\nfunction ', at + 1)
    return src.slice(at, next > 0 ? next : src.length)
  }
  for (const fn of ['addMember', 'updateMember', 'replaceGroupMembers', 'importMembers']) {
    assert.match(fnBody(fn), /resolveMemberRef\(|ensureProvisionalStudent\(/, `${fn} 必须给成员姓名建档`)
  }
  // resolveMemberRef 必须复用 applyRowStudentRef：认人 + 回填 student_id 只有那一份实现，
  // 各写一套就会出现「这里补 id、那里不补」的分叉。
  assert.match(fnBody('resolveMemberRef'), /applyRowStudentRef\(/, 'resolveMemberRef 必须复用 applyRowStudentRef')
})

test('接线：AI 行式写入的 add/update 两条分支都调用 applyRowStudentRef', async () => {
  const fsMod = require('node:fs')
  const pathMod = require('node:path')
  const { ROOT } = require('./_db-express-fixture.cjs')
  const raw = fsMod.readFileSync(pathMod.join(ROOT, 'student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const start = raw.indexOf("router.post('/apply-batch'")
  const seg = raw.slice(start, raw.indexOf('res.json({ ok: true, count: results.length', start))

  const calls = seg.match(/applyRowStudentRef\(/g) || []
  assert.equal(calls.length, 2, `apply-batch 的 add 与 update 都要认人（实得 ${calls.length} 处）`)

  // 认人会就地补 student_id，keys 必须在它之后才算 —— 否则补出来的 id 进不了 INSERT
  const addAt = seg.indexOf('applyRowStudentRef(table, row)')
  const addKeysAt = seg.indexOf('const keys = Object.keys(row)', addAt)
  assert.ok(addKeysAt > addAt, 'add 分支的 keys 必须重算在 applyRowStudentRef 之后')
})
