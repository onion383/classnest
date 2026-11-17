// =========================================================================
// cadre-member-provisional.test.js —— 班干部成员自己认人（P1-3）
//
// 背景：`cadre_members` 允许 `student_id` 为空（「仅姓名」成员）。原来的写法是
// 「前端传什么就存什么」：id 为空时直接落 null，靠「值日先输入过这个人」把学生建出来
// —— 一条隐式顺序依赖，没人保证它成立。
// 现在两处写入口（单条新增 / Excel 导入）都走 provisionalStudents 解析：
//   ① 有 id → 姓名以 students 表为准（快照不许覆盖权威）
//   ② 无 id → 按姓名认人；名册外就建临时学生并回填 id
//
// 锁六条：
//   ① 名册外姓名 → 建临时学生 + 回填 id；
//   ② 传了 student_id 但姓名是旧名 → 以库里的姓名为准；
//   ③ student_id 不存在 → 404（不再落一条指向空 id 的孤儿行）；
//   ④ 名册里唯一同名正式学生 → 复用，不建临时；
//   ⑤ 名册里多个同名 → 200、id 留空、姓名照存（班干部本来就允许「仅姓名」成员）；
//   ⑥ 导入名册外姓名 → 建临时学生；导入重名 → 该行留空但整批成功。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'cadre-member-provisional' })
const conn = fx.conn

let base
test.before(async () => {
  base = await fx.mount('/api/cadres', 'student-backend/routes/cadres.js')
  // AI 批量提案走的是通用行式写入器（apply-batch），是第三条写入口（P1-3 当时漏掉）
  await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
})
test.after(() => fx.close())

const call = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

// 每个用例一个独立职务：max_count 默认 1，共用一个会撞「人数已达上限」
let cadreSeq = 0
async function newCadre(maxCount = 1) {
  cadreSeq += 1
  const r = await call('', { name: `职务${cadreSeq}`, max_count: maxCount })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json.id
}

const memberOf = (id) => conn.prepare('SELECT * FROM cadre_members WHERE id = ?').get(id)
const studentsNamed = (name) => conn.prepare('SELECT * FROM students WHERE 姓名 = ?').all(name)
const addStudent = (name, xuehao) =>
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run(name, xuehao)

test('名册外姓名：建临时学生并回填 student_id', async () => {
  const cadreId = await newCadre()
  const r = await call(`/${cadreId}/members`, { student_name: '班干临时甲' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const row = memberOf(r.json.id)
  assert.ok(row.student_id, '必须回填 student_id，班干部不再靠「值日先建过人」')
  const stu = studentsNamed('班干临时甲')
  assert.equal(stu.length, 1)
  assert.equal(stu[0].is_provisional, 1)
  assert.equal(row.student_id, stu[0].id)
})

test('传了 student_id 但姓名过期：以库里的姓名为准（快照不许覆盖权威）', async () => {
  addStudent('班干正式乙', '2026201')
  const stu = conn.prepare("SELECT id FROM students WHERE 姓名 = '班干正式乙'").get()
  const cadreId = await newCadre()
  const r = await call(`/${cadreId}/members`, { student_id: stu.id, student_name: '班干正式乙的旧名' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const row = memberOf(r.json.id)
  assert.equal(row.student_id, stu.id)
  assert.equal(row.student_name, '班干正式乙', '快照必须跟权威一致，否则导出与列表会显示两个名字')
})

test('student_id 不存在：404，不再落孤儿行', async () => {
  const cadreId = await newCadre()
  const r = await call(`/${cadreId}/members`, { student_id: 999999, student_name: '查无此人' })
  assert.equal(r.status, 404)
  const underCadre = conn.prepare('SELECT COUNT(*) AS n FROM cadre_members WHERE cadre_id = ?').get(cadreId).n
  assert.equal(underCadre, 0, '不能写入指向空 id 的行')
})

test('名册唯一同名正式学生：复用，不建临时', async () => {
  addStudent('班干正式丙', '2026202')
  const formal = conn.prepare("SELECT id FROM students WHERE 姓名 = '班干正式丙'").get()
  const cadreId = await newCadre()
  const r = await call(`/${cadreId}/members`, { student_name: '班干正式丙' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(memberOf(r.json.id).student_id, formal.id)
  assert.equal(studentsNamed('班干正式丙').length, 1)
})

test('名册多个同名：200 但 id 留空、姓名照存（班干部允许「仅姓名」成员）', async () => {
  addStudent('班干重名丁', '2026203')
  addStudent('班干重名丁', '2026204')
  const cadreId = await newCadre()
  const r = await call(`/${cadreId}/members`, { student_name: '班干重名丁' })
  assert.equal(r.status, 200, '歧义不该让「添加成员」失败')
  const row = memberOf(r.json.id)
  assert.equal(row.student_id, null, '不替用户挑人')
  assert.equal(row.student_name, '班干重名丁')
  assert.equal(studentsNamed('班干重名丁').length, 2, '不得额外建临时学生')
})

test('导入：名册外姓名建临时学生，重名行留空但整批成功', async () => {
  addStudent('班干导入重名戊', '2026205')
  addStudent('班干导入重名戊', '2026206')
  const r = await call('/import', {
    fields: ['职务', '担任学生'],
    rows: [
      ['导入职务甲', '班干导入新人己'],
      ['导入职务乙', '班干导入重名戊'],
    ],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const created = r.json.created.members
  assert.equal(created.length, 2)

  const fresh = created.find((m) => m.student_name === '班干导入新人己')
  assert.ok(fresh.student_id, '名册外姓名要回填 id')
  assert.equal(studentsNamed('班干导入新人己')[0].is_provisional, 1)

  const dup = created.find((m) => m.student_name === '班干导入重名戊')
  assert.equal(dup.student_id, null, '重名不猜，留空即可')
  assert.equal(studentsNamed('班干导入重名戊').length, 2, '重名时不多建临时学生')
})

// =========================================================================
// ③ AI 批量写入（apply-batch）—— 通用行式写入器的口径
//
// 这条路原来直接按列名 INSERT，不知道 student_name 是学生引用：
// AI 只给姓名就能落一条 student_id 为空的成员，名册里也查无此人（孤儿）。
// 现在它与 REST 入口共用 applyRowStudentRef：有 id 以库为准，没 id 认人并回填。
// =========================================================================
const newCadreRow = (maxCount = 10) => {
  const info = conn.prepare('INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES (?,0,?,0)')
    .run(`AI职务${Math.random().toString(36).slice(2, 7)}`, maxCount)
  return Number(info.lastInsertRowid)
}

const aiBatch = (ops) => fx.call('POST', '/api/ai/apply-batch', { ops })

test('AI 新增成员只给姓名：建临时学生并回填 student_id', async () => {
  const cadreId = newCadreRow()
  const r = await aiBatch([{ action: 'add', table: 'cadre_members', data: { cadre_id: cadreId, student_name: 'AI临时庚' } }])
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const row = conn.prepare('SELECT * FROM cadre_members WHERE cadre_id = ?').get(cadreId)
  assert.ok(row && row.student_id, 'AI 写入也必须回填 student_id，不能留孤儿快照')
  const stu = studentsNamed('AI临时庚')
  assert.equal(stu.length, 1)
  assert.equal(stu[0].is_provisional, 1)
  assert.equal(row.student_id, stu[0].id)
})

test('AI 新增成员给了 id 但姓名过期：以库里的姓名为准', async () => {
  addStudent('AI正式辛', '2026301')
  const stu = conn.prepare("SELECT id FROM students WHERE 姓名 = 'AI正式辛'").get()
  const cadreId = newCadreRow()
  const r = await aiBatch([{
    action: 'add',
    table: 'cadre_members',
    data: { cadre_id: cadreId, student_id: stu.id, student_name: 'AI正式辛的旧名' },
  }])
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const row = conn.prepare('SELECT * FROM cadre_members WHERE cadre_id = ?').get(cadreId)
  assert.equal(row.student_id, stu.id)
  assert.equal(row.student_name, 'AI正式辛', '快照必须跟权威一致')
})

test('AI 新增成员给不存在的 id：整批失败，不落半截', async () => {
  const cadreId = newCadreRow()
  // 新建库有外键，插一个不存在的 id 会被 SQLite 自己挡住 —— 那就测不到应用层守卫。
  // 老库（建表早于外键声明）没有这层保护，这才是真正要靠代码拦住的情况。
  conn.pragma('foreign_keys = OFF')
  try {
    const r = await aiBatch([{ action: 'add', table: 'cadre_members', data: { cadre_id: cadreId, student_id: 987654, student_name: '查无此人' } }])
    assert.equal(r.status, 400, '指向不存在学生的 id 必须报错，不能写成孤儿行')
    const n = conn.prepare('SELECT COUNT(*) AS n FROM cadre_members WHERE cadre_id = ?').get(cadreId).n
    assert.equal(n, 0)
  } finally {
    conn.pragma('foreign_keys = ON')
  }
})

test('AI 改名（只改 student_name）：认人并补上 student_id', async () => {
  const cadreId = newCadreRow()
  const ins = conn.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,NULL,?,1)')
  const memberId = Number(ins.run(cadreId, 'AI旧名壬').lastInsertRowid)

  const r = await aiBatch([{ action: 'update', table: 'cadre_members', id: memberId, changes: { student_name: 'AI新名壬' } }])
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const row = memberOf(memberId)
  assert.equal(row.student_name, 'AI新名壬')
  assert.ok(row.student_id, '改名成新姓名后必须认到人（名册外则建档）')
  assert.equal(studentsNamed('AI新名壬').length, 1)
})

test('AI 新增成员遇到名册重名：id 留空、姓名照存，不替用户挑', async () => {
  addStudent('AI重名癸', '2026302')
  addStudent('AI重名癸', '2026303')
  const cadreId = newCadreRow()
  const r = await aiBatch([{ action: 'add', table: 'cadre_members', data: { cadre_id: cadreId, student_name: 'AI重名癸' } }])
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const row = conn.prepare('SELECT * FROM cadre_members WHERE cadre_id = ?').get(cadreId)
  assert.equal(row.student_id, null, '重名不猜')
  assert.equal(row.student_name, 'AI重名癸')
  assert.equal(studentsNamed('AI重名癸').length, 2, '重名时不该多建临时学生')
})
