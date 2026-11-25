// =========================================================================
// seat-name-preview.test.js —— AI 写座位表时「认不出的人」必须被说出来
//
// 背景：老师截图 → AI OCR → 写座位表。名册外的姓名会被自动建成临时学生，
// 而学生表默认只列正式学生，从座位表上完全看不出来。OCR 错一个字就会
// 凭空多一个人。两道判据：
//   ① 提案阶段干跑预检：**不能建人**，只把名单交给 AI 去问用户
//   ② 执行阶段回传 createdStudents：真正建了谁，调用方要看得见
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-name-preview' })

const one = (sql, ...p) => fx.conn.prepare(sql).get(...p)
const countNamed = (name) => one('SELECT COUNT(*) AS n FROM students WHERE 姓名 = ?', name).n

test.before(async () => {
  await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
})
test.after(() => fx.close())

function seed() {
  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (1, ?, ?, 1)').run('张三', 'A001')
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (2, ?, ?, 2)').run('同名甲', 'A002')
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (3, ?, ?, 3)').run('同名甲', 'A003')
  }})
}

const seatWrite = () => require('../../../student-backend/services/seatWrite')

// ============ ① 干跑预检：只查不建 ============

test('干跑：名册外的名字报 missing，但**一个学生都不建**', () => {
  seed()
  const r = seatWrite().previewSeatNames([['转学甲', null], [null, '张三']])
  assert.deepEqual(r.missing.map((x) => x.name), ['转学甲'])
  assert.deepEqual(r.ambiguous, [])
  assert.equal(countNamed('转学甲'), 0, '提案还没确认就建人，用户点头之前名册已经脏了')
})

test('干跑：两个同名报 ambiguous，不替用户挑一个', () => {
  seed()
  const r = seatWrite().previewSeatNames([['同名甲', 1]])
  assert.equal(r.missing.length, 0)
  assert.equal(r.ambiguous.length, 1)
  assert.equal(r.ambiguous[0].name, '同名甲')
  assert.equal(r.ambiguous[0].candidates.length, 2)
  assert.equal(one('SELECT COUNT(*) AS n FROM students').n, 3, '同名不建档，也不改任何人')
})

test('干跑：名册里唯一命中就什么也不报', () => {
  seed()
  const r = seatWrite().previewSeatNames([['张三', null], [null, 1]])
  assert.deepEqual(r, { missing: [], ambiguous: [] })
})

test('干跑：数字格与空字符串不当姓名', () => {
  seed()
  const r = seatWrite().previewSeatNames([[1, '', '  ', null], ['  张三  ', 2]])
  assert.deepEqual(r, { missing: [], ambiguous: [] }, 'trim 后 IDENTICAL 姓名算命中，别误报')
})

// ============ ② 执行阶段：详细解析回传 ============

test('详细解析：新建的临时学生回传 created，同名进 ambiguous', () => {
  seed()
  const r = seatWrite().resolveNameCellsDetailed([['转学甲', '同名甲']])
  const created = one('SELECT * FROM students WHERE 姓名 = ?', '转学甲')
  assert.ok(created && created.is_provisional === 1)
  assert.equal(r.seats[0][0], created.id, '解析后格子存的是学生 id')
  assert.equal(r.seats[0][1], '同名甲', '同名认不出就保持字符串')
  assert.deepEqual(r.created, [{ id: created.id, name: '转学甲' }])
  assert.deepEqual(r.ambiguous.map((a) => a.name), ['同名甲'])
})

test('兼容：resolveNameCells 仍只返回格子数组', () => {
  seed()
  const seats = [['转学乙', null]]
  const r = seatWrite().resolveNameCells(seats)
  assert.ok(Array.isArray(r), '老调用方（座位路由）不能因为新增详细版而拿到对象')
  assert.equal(typeof r[0][0], 'number')
})

// ============ ③ AI 提案：预检结果必须回到模型上下文 ============

test('propose_json_write：座位提案带 seat_name_check 与提醒文案', async () => {
  seed()
  const tools = require('../../../student-backend/routes/ai/ai.tools/tools.js')
  const r = await tools.runTool('propose_json_write', {
    table: 'seat_layout',
    id: 1,
    values: { seats: [['OCR错字', null], [null, '同名甲']] },
    label: '截图导入座位',
  }, {})
  assert.equal(r.result.ok, true, JSON.stringify(r.result))
  assert.ok(r.proposal, '应该生成提案')
  const check = r.result.seat_name_check
  assert.deepEqual(check.missing.map((x) => x.name), ['OCR错字'])
  assert.deepEqual(check.ambiguous.map((x) => x.name), ['同名甲'])
  assert.match(r.result.note, /OCR错字/, '模型必须看到具体名字，才可能在回复里问用户')
  assert.match(r.result.note, /同名甲/)
  assert.equal(countNamed('OCR错字'), 0, '生成提案阶段绝不建档')
})

test('propose_json_write：没有认不出的名字时不塞多余提示', async () => {
  seed()
  const tools = require('../../../student-backend/routes/ai/ai.tools/tools.js')
  const r = await tools.runTool('propose_json_write', {
    table: 'seat_layout', id: 1,
    values: { seats: [['张三', null], [null, 2]] },
    label: '正常座位',
  }, {})
  assert.equal(r.result.ok, true, JSON.stringify(r.result))
  assert.equal(r.result.seat_name_check, undefined)
  assert.equal(r.result.note, undefined)
})

// ============ ④ 执行结果：真实 POST /api/ai/doc 回传 ============

test('POST /api/ai/doc：回传 createdStudents，且库里真的建了人', async () => {
  seed()
  const r = await fx.call('POST', '/api/ai/doc', {
    table: 'seat_layout', id: 1,
    values: { seats: [['新同学甲', null], [null, null]] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual((r.json.createdStudents || []).map((x) => x.name), ['新同学甲'])
  const stu = one('SELECT * FROM students WHERE 姓名 = ?', '新同学甲')
  assert.ok(stu, '回传的人必须真在名册里（is_provisional=1）')
  assert.equal(stu.is_provisional, 1)
  assert.ok(Array.isArray(r.json.after.seats), '回传的 after 必须是解析后的格子，不是解析前的姓名')
  assert.equal(r.json.after.seats[0][0], stu.id)
})
