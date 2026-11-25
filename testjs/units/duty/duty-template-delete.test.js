// =========================================================================
// duty-template-delete.test.js —— 删学生要连值日模板一起清（2-11 / #9a）
//
// 原缺陷：studentRelations 只读 duty_layout（当前表），不看 duty_template。模板也存
// 学生姓名/id，且 readDuty() 在当前表为空时回退模板、apply-master 会把模板复制到当前表
// （routes/duty.js:60-72,151-162）—— 删学生后模板仍挂着已删姓名，页面会重新显示、
// 点应用模板又把孤儿姓名写回当前表。
// 修法：统计/清理/撤销快照覆盖两张表；dutySlots 带 table 字段，恢复/重做写回正确的表。
//
// 判据：① 统计含模板引用；② purge 清两张表且 slot 带 table；③ restore 精确回填两张表；
//       ④ clearDutySlots（重做）两张表都清；⑤ 变异常规：只清当前表时模板残留。
// =========================================================================
const path = require('node:path')
const { abs } = require('#testjs/paths')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb, ROOT } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'duty-template-delete' })
const {
  studentRelations, purgeStudentRelations, restoreDutySlots, clearDutySlots,
} = require(abs('student-backend/services/studentRelations'))

const ZHANG = { id: 1, position: 1, 姓名: '张三' }
const LI = { id: 2, position: 2, 姓名: '李四' }

function seed() {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (2, 2, ?)').run('李四')
  // 当前表与模板各挂一次张三（外加一个李四做对照）
  const cells = () => JSON.stringify({ daily: { 扫地: { 周一: ['张三', '李四'] } }, big: { 值日: { 周二: [1] } } })
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'").run(cells())
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'template'").run(cells())
  return { conn, cells }
}
const readCells = (conn, kind) => JSON.parse(conn.prepare('SELECT cells FROM duty_slots WHERE kind = ?').get(kind).cells)
const refsOf = (cells, name, id) => {
  let n = 0
  for (const mode of ['daily', 'big']) {
    for (const item of Object.keys(cells[mode] || {})) {
      for (const day of Object.keys(cells[mode][item])) {
        n += (cells[mode][item][day] || []).filter(v => v === name || v === id).length
      }
    }
  }
  return n
}

test('统计：duty 次数包含模板里的引用（当前表 2 + 模板 2 = 4）', () => {
  const { conn } = seed()
  const rel = studentRelations(ZHANG)
  assert.equal(rel.duty, 4, '只数当前表会得到 2，模板那两处会被漏掉')
})

test('清理：purge 同时清当前表和模板，slot 带 table 字段', () => {
  const { conn } = seed()
  const res = purgeStudentRelations(ZHANG, { duty: true })
  assert.equal(res.duty, 4)
  assert.ok(res.dutySlots.some(s => s.table === 'duty_layout'), '要有当前表的 slot')
  assert.ok(res.dutySlots.some(s => s.table === 'duty_template'), '要有模板的 slot')
  for (const kind of ['current', 'template']) {
    const cells = readCells(conn, kind)
    assert.equal(refsOf(cells, '张三', 1), 0, `${kind} 不该再引用已删学生`)
    assert.equal(refsOf(cells, '李四', 2), 1, '其它学生不受影响')
  }
})

test('撤销：restoreDutySlots 按 table 精确回填两张表', () => {
  const { conn, cells: original } = seed()
  const res = purgeStudentRelations(ZHANG, { duty: true })
  restoreDutySlots(res.dutySlots)
  assert.deepEqual(readCells(conn, 'current'), JSON.parse(original()), '当前表要还原')
  assert.deepEqual(readCells(conn, 'template'), JSON.parse(original()), '模板也要还原')
})

test('重做：clearDutySlots 同时清当前表和模板', () => {
  const { conn, cells: original } = seed()
  clearDutySlots(ZHANG)
  for (const kind of ['current', 'template']) {
    assert.equal(refsOf(readCells(conn, kind), '张三', 1), 0, `${kind} 重做后不该残留`)
  }
})

test('变异反证：把双表清单改回只认当前表后，模板判据失败', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(abs('student-backend/services/studentRelations.js'), 'utf8')
  const registry = fs.readFileSync(abs('student-backend/schema/tableRegistry.js'), 'utf8')
  // 新行为标志：从 registry 引用双表清单 + slot 带 table（表名清单必须单源，不许业务层手抄）
  assert.match(src, /require\('\.\.\/schema\/tableRegistry'\)/, '必须从 tableRegistry 引用表名')
  assert.match(registry, /DUTY_TABLES = Object\.freeze\(\['duty_layout', 'duty_template'\]\)/, 'registry 缺双表清单')
  assert.match(src, /allSlots\.push\(\{ \.\.\.s, table \}\)/, 'slot 未标来源表')
  assert.match(src, /const table = s\.table \|\| 'duty_layout'/, '恢复未区分表')
  const mutated = registry.replace("DUTY_TABLES = Object.freeze(['duty_layout', 'duty_template'])", "DUTY_TABLES = Object.freeze(['duty_layout'])")
  assert.ok(mutated !== registry, '变异没匹配到双表清单')
  assert.doesNotMatch(mutated, /DUTY_TABLES = Object\.freeze\(\['duty_layout', 'duty_template'\]\)/, '变异后判据应失败')
})
