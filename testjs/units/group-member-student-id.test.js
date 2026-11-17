// =========================================================================
// group-member-student-id.test.js —— P2-1：小组成员指针化（member_name → student_id）
//
// 这一条要守住的核心不是「多了一列」，而是**同名两人能各自独立**：
//   以前 group_members 只有姓名，两个「张子涵」在库里是同一行文本，分不出谁是谁；
//   有了 student_id，按 id 认人才能把他们分到不同组、各自改名、各自删除。
//
// 同时守住三条容易退化的边界：
//   ① 只改备注不能把已绑好的 id 冲成 null（前端 PUT 永远把 member_name 一起带上）
//   ② 同名歧义且没给 id → id 留空、姓名照存（不替用户猜）
//   ③ 老库补列必须幂等，且补完的外键真的生效（不能重演 P0-1 的分叉）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-student-id', extraDbExports: { renumber: () => {} } })

test.before(async () => {
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
})
test.after(() => fx.close())

const all = (sql, ...args) => fx.conn.prepare(sql).all(...args)
const one = (sql, ...args) => fx.conn.prepare(sql).get(...args)
const member = (id) => one('SELECT id, group_id, student_id, member_name, remark FROM group_members WHERE id = ?', id)

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const { initSchema } = require('../../student-backend/schema/schema')

function addStudent(name, xuehao = '') {
  const info = fx.conn.prepare(
    "INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)"
  ).run(xuehao, name)
  return Number(info.lastInsertRowid)
}

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

// ============ ① 写入即回填 id ============

test('新增成员：名册里唯一同名 → student_id 直接指向该正式学生', async () => {
  fx.reset()
  const sid = addStudent('李唯一', '2026001')
  const { groupIds } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '李唯一' })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const m = member(r.json.id)
  assert.equal(m.student_id, sid, '成员行必须指向那个正式学生，而不是留空让人再猜一次')
  assert.equal(m.member_name, '李唯一')
  // 不该顺手多建一条临时学生
  assert.equal(all('SELECT id FROM students WHERE 姓名 = ?', '李唯一').length, 1)
})

test('新增成员：名册外姓名 → 建临时学生并把 id 写进成员行', async () => {
  fx.reset()
  const { groupIds } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '名册外丁' })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const m = member(r.json.id)
  assert.ok(m.student_id, '名册外姓名也必须拿到 id，否则这一行永远是孤儿')
  const stu = one('SELECT id, 姓名, is_provisional FROM students WHERE id = ?', m.student_id)
  assert.equal(stu.姓名, '名册外丁')
  assert.equal(stu.is_provisional, 1)
})

// ============ ② 同名两人各自独立（本条的核心验收） ============

test('同名两人分到不同组：靠 student_id 区分，各自独立', async () => {
  fx.reset()
  const a = addStudent('张子涵', '2026001')
  const b = addStudent('张子涵', '2026002')
  assert.notEqual(a, b, '夹具本身要造出两个不同 id 的同名学生')
  const { dimId, groupIds } = makeDim('宿舍组', 2)

  // 前端从名册选人时会带上 student_id —— 这正是「按 id 认人」的入口
  const r1 = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '张子涵', student_id: a })
  const r2 = await fx.call('POST', `/api/group-manage/groups/${groupIds[1]}/members`, { member_name: '张子涵', student_id: b })
  assert.equal(r1.status, 200, r1.text.slice(0, 300))
  assert.equal(r2.status, 200, r2.text.slice(0, 300))

  assert.equal(member(r1.json.id).student_id, a)
  assert.equal(member(r2.json.id).student_id, b)
  assert.notEqual(member(r1.json.id).student_id, member(r2.json.id).student_id)

  // 各自独立改名：改 1 号不会动到 2 号
  const upd = await fx.call('PUT', `/api/group-manage/group-members/${r1.json.id}`, { member_name: '张子涵甲' })
  assert.equal(upd.status, 200, upd.text.slice(0, 300))
  assert.equal(member(r1.json.id).member_name, '张子涵甲')
  assert.equal(member(r2.json.id).member_name, '张子涵', '另一个同名成员不能被连带改掉')
  assert.equal(member(r2.json.id).student_id, b, '改名的那个换了人，另一个的绑定必须原样')
  assert.equal(all('SELECT id FROM students WHERE 姓名 = ?', '张子涵甲').length, 1, '改名后要为新名字建档')
  assert.equal(dimId > 0, true)
})

test('同名歧义且没给 id → student_id 留空，姓名照存（不猜）', async () => {
  fx.reset()
  addStudent('赵清越', '2026001')
  addStudent('赵清越', '2026002')
  const { groupIds } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '赵清越' })
  assert.equal(r.status, 200, r.text.slice(0, 300))
  const m = member(r.json.id)
  assert.equal(m.student_id, null, '两个同名分不出是谁，宁可留空也不替用户选')
  assert.equal(m.member_name, '赵清越', '姓名照存 —— 留空 id 不该连姓名一起丢')
})

test('给了不存在的 student_id → 明确报错，不静默留空', async () => {
  fx.reset()
  const { groupIds } = makeDim()
  const r = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, {
    member_name: '幽灵', student_id: 999999,
  })
  // 400 而不是 500：这是「前端带了已删除学生的 id」＝用户填错/界面过期，
  // 不是服务端故障。报 500 会让老师和排查都以为后端崩了。
  assert.equal(r.status, 400, '这是调用方的问题，但也不能报成服务器错误')
  assert.match(String(r.json.error || ''), /不存在/)
  assert.equal(all('SELECT id FROM group_members').length, 0, '失败不能留下半截成员行')
})

// ============ ③ 更新路径的三种情况 ============

test('只改备注（前端仍带上同名 member_name）不得冲掉已绑定的 id', async () => {
  fx.reset()
  const a = addStudent('张子涵', '2026001')
  addStudent('张子涵', '2026002')
  const { groupIds } = makeDim()

  const add = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '张子涵', student_id: a })
  assert.equal(add.status, 200, add.text.slice(0, 300))

  // 前端保存备注时会把 member_name 一起带上（同值）
  const upd = await fx.call('PUT', `/api/group-manage/group-members/${add.json.id}`, {
    member_name: '张子涵', remark: '宿舍长',
  })
  assert.equal(upd.status, 200, upd.text.slice(0, 300))
  const m = member(add.json.id)
  assert.equal(m.student_id, a, '姓名没变就不该重认 —— 重认会被同名歧义冲成 null')
  assert.equal(m.remark, '宿舍长')
})

test('按 student_id 换人：姓名以 students.姓名 为准（快照不覆盖权威）', async () => {
  fx.reset()
  const a = addStudent('甲同学', '2026001')
  const b = addStudent('乙同学', '2026002')
  const { groupIds } = makeDim()

  const add = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '甲同学', student_id: a })
  // 前端传了新 id，但 member_name 还是旧的 —— 后端必须以 id 为准回填姓名
  const upd = await fx.call('PUT', `/api/group-manage/group-members/${add.json.id}`, {
    member_name: '甲同学', student_id: b,
  })
  assert.equal(upd.status, 200, upd.text.slice(0, 300))
  const m = member(add.json.id)
  assert.equal(m.student_id, b)
  assert.equal(m.member_name, '乙同学', 'id 指向乙，姓名就必须是乙，不能留着甲的旧快照')
})

test('改名：id 跟着新名字重新认人', async () => {
  fx.reset()
  const a = addStudent('旧名戊', '2026001')
  const { groupIds } = makeDim()
  const add = await fx.call('POST', `/api/group-manage/groups/${groupIds[0]}/members`, { member_name: '旧名戊', student_id: a })

  const upd = await fx.call('PUT', `/api/group-manage/group-members/${add.json.id}`, { member_name: '新名戊' })
  assert.equal(upd.status, 200, upd.text.slice(0, 300))
  const m = member(add.json.id)
  assert.notEqual(m.student_id, null, '新名字要建档并绑上')
  const stu = one('SELECT 姓名 FROM students WHERE id = ?', m.student_id)
  assert.equal(stu.姓名, '新名戊', '改名后不能还挂着旧名的 id')
})

// ============ ④ 另外两个写入口也回填 ============

test('智能分组写回：每个成员行的 student_id 都回填', async () => {
  fx.reset()
  const a = addStudent('正式己', '2026001')
  const { dimId, groupIds } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/dimensions/${dimId}/apply-grouping`, {
    groups: [['正式己', '组外己'], []],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const rows = all('SELECT student_id, member_name FROM group_members WHERE group_id = ? ORDER BY sort_order', groupIds[0])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].student_id, a, '名册内的人要直接指向他')
  assert.ok(rows[1].student_id, '名册外的人也要建档并绑上')
})

test('Excel/表格导入：成员行同样带 student_id', async () => {
  fx.reset()
  const a = addStudent('导入庚', '2026001')
  const { dimId } = makeDim()

  const r = await fx.call('POST', `/api/group-manage/dimensions/${dimId}/import`, {
    fields: ['小组', '姓名'],
    rows: [['第1组', '导入庚'], ['第1组', '导入外人']],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const rows = all('SELECT student_id, member_name FROM group_members ORDER BY id')
  const got = Object.fromEntries(rows.map((x) => [x.member_name, x.student_id]))
  assert.equal(got['导入庚'], a)
  assert.ok(got['导入外人'], '导入的名册外姓名也要拿到 id')
})

// ============ ⑤ 改名级联按 id（否则同名两人互相踩） ============

test('同名两人：改其中一个的名字，只改他自己那条成员行', () => {
  fx.reset()
  const a = addStudent('张子涵', '2026001')
  const b = addStudent('张子涵', '2026002')
  const { groupIds } = makeDim()
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, student_id, member_name, sort_order) VALUES (?,?,?,1)')
  const ma = Number(ins.run(groupIds[0], a, '张子涵').lastInsertRowid)
  const mb = Number(ins.run(groupIds[1], b, '张子涵').lastInsertRowid)

  // 级联的调用约定：students 行已经改成新名，再调 renameStudentRefs
  fx.conn.prepare('UPDATE students SET 姓名 = ? WHERE id = ?').run('张子涵甲', a)
  const { renameStudentRefs } = require('../../student-backend/services/studentRename')
  const r = renameStudentRefs('张子涵', '张子涵甲', a)

  assert.equal(member(ma).member_name, '张子涵甲', '改名的人自己那条要跟上')
  assert.equal(member(mb).member_name, '张子涵', '另一个同名的人绝不能被连带改掉')
  assert.ok(r.counts.group >= 1, '级联报告里要体现真的改到了分组行')
})

test('改名级联：拿不到 id 时仍按姓名兜底（非同名场景行为不变）', () => {
  fx.reset()
  const a = addStudent('李独一', '2026001')
  const { groupIds } = makeDim()
  // 故意造一条「id 为空」的历史行 —— 老数据就是这样，不能因为加了 id 就把它漏掉
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, student_id, member_name, sort_order) VALUES (?,?,?,1)')
  const legacy = Number(ins.run(groupIds[0], null, '李独一').lastInsertRowid)

  fx.conn.prepare('UPDATE students SET 姓名 = ? WHERE id = ?').run('李独二', a)
  const { renameStudentRefs } = require('../../student-backend/services/studentRename')
  renameStudentRefs('李独一', '李独二')

  assert.equal(member(legacy).member_name, '李独二', '旧名已无人使用，历史空 id 行要跟着改名')
})

// ============ ⑥ 撤销改名后引用要拉回一致 ============

test('撤销改名：回写 member_name 后 student_id 要回到原来那个人', () => {
  fx.reset()
  const a = addStudent('张三', '2026001')
  const li = addStudent('李四', '2026002')
  const { groupIds } = makeDim()
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, student_id, member_name, sort_order) VALUES (?,?,?,1)')
  const mid = Number(ins.run(groupIds[0], a, '张三').lastInsertRowid)

  // 模拟「分组页把张三改成李四」：姓名与引用都指到李四
  fx.conn.prepare('UPDATE group_members SET student_id = ?, member_name = ? WHERE id = ?').run(li, '李四', mid)

  // 撤销记录里只有 member_name 这一列
  const { setCellValue, resyncGroupMemberRef } = require('../../student-backend/services/undoStore')
  setCellValue('group_members', 'member_name', '张三', mid)
  resyncGroupMemberRef(mid)

  assert.equal(member(mid).member_name, '张三')
  assert.equal(member(mid).student_id, a, '姓名回到张三，引用也必须回到张三，不能还指着李四')
})

test('撤销改名：名字在名册里已找不到时清空引用，不瞎指一个人', () => {
  fx.reset()
  const li = addStudent('李四', '2026002')
  const { groupIds } = makeDim()
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, student_id, member_name, sort_order) VALUES (?,?,?,1)')
  const mid = Number(ins.run(groupIds[0], li, '李四').lastInsertRowid)

  const { setCellValue, resyncGroupMemberRef } = require('../../student-backend/services/undoStore')
  setCellValue('group_members', 'member_name', '查无此人', mid)
  resyncGroupMemberRef(mid)

  assert.equal(member(mid).student_id, null, '认不出就留空，不能继续挂在李四身上')
})

test('老库：没有 student_id 的表补列后可用，老行保留、外键生效、幂等', () => {
  const db = new Database(':memory:')
  try {
    // 完全按 P2-1 之前的 DDL 造老库（group_members 没有 student_id）
    db.exec(`
      CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, 姓名 TEXT, is_provisional INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE group_dimensions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, leader_title TEXT,
        members_per_group INTEGER, group_count INTEGER, is_default INTEGER,
        male_group_count INTEGER, female_group_count INTEGER, sort_order INTEGER);
      CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT,
        dimension_id INTEGER REFERENCES group_dimensions(id) ON DELETE CASCADE, name TEXT, gender INTEGER, sort_order INTEGER);
      CREATE TABLE group_members (id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, member_name TEXT, remark TEXT, sort_order INTEGER);
    `)
    db.prepare('INSERT INTO group_dimensions (name, is_default) VALUES (?, 1)').run('宿舍组')
    db.prepare('INSERT INTO groups (dimension_id, name) VALUES (1, ?)').run('302')
    db.prepare('INSERT INTO group_members (group_id, member_name) VALUES (1, ?)').run('老成员')

    initSchema(db)

    const cols = db.prepare('PRAGMA table_info(group_members)').all().map((c) => c.name)
    assert.ok(cols.includes('student_id'), '老库必须补出 student_id 列，否则读写一碰就报 no such column')

    const old = db.prepare('SELECT student_id, member_name FROM group_members').get()
    assert.equal(old.member_name, '老成员', '补列不能动老数据')
    assert.equal(old.student_id, null, '没迁过的老行 id 为空是预期的，由一次性回填脚本处理')

    // 补出来的外键必须真的生效：删学生 → 成员行跟着走。
    // 如果这里的 ADD COLUMN 没带 REFERENCES，老库就又一次「看起来一样、其实没保护」。
    const fk = db.pragma('foreign_key_list(group_members)').find((f) => f.from === 'student_id')
    assert.ok(fk, '补列必须带外键，否则老库删学生会留下悬空引用')
    assert.equal(fk.table, 'students')
    assert.equal(fk.on_delete, 'CASCADE')

    const stu = db.prepare('INSERT INTO students (姓名) VALUES (?)').run('有主的人')
    db.prepare('UPDATE group_members SET student_id = ? WHERE id = 1').run(Number(stu.lastInsertRowid))
    db.prepare('DELETE FROM students WHERE id = ?').run(Number(stu.lastInsertRowid))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM group_members').get().c, 0, '删学生必须带走成员行')

    // 幂等：再跑一次不重复加列、不报错
    assert.doesNotThrow(() => initSchema(db))
    assert.equal(db.prepare('PRAGMA table_info(group_members)').all().filter((c) => c.name === 'student_id').length, 1)
  } finally { db.close() }
})
