// =========================================================================
// student-relations-namesake.test.js —— 删学生不误删同名学生的关联（1-7 / #9）
//
// 原缺陷：studentRelations / purgeStudentRelations 对 group_members / cadre_members
// 用 `student_id = ? OR TRIM(name) = TRIM(?)` 无条件姓名 OR。两名同名学生各在一组/
// 担任班干部时，删 A 并勾选关联清理，会把 B 的行也删掉 —— student_id 才是权威引用，
// 姓名只是快照（schema 注释明确）。
// 修法：有效 id 只按 id 匹配；只有 legacy 空 id 行才按姓名兜底。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createBackendDb, ROOT } = require('#testjs/units/_db-express-fixture.cjs')
const { loadMutated } = require('#testjs/units/_mechanism.cjs')

const fx = createBackendDb({ label: 'student-namesake' })
const {
  studentRelations, purgeStudentRelations,
} = require('../../../student-backend/services/studentRelations')

test.after(() => fx.close())

// 两个同名学生（不同 id），各有一组/班干部关联，另有一条 legacy 空 id 行
function seedNamesakes() {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张伟')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (2, 2, ?)').run('张伟')
  conn.prepare("INSERT INTO group_dimensions (id, name) VALUES (1, '宿舍')").run()
  conn.prepare("INSERT INTO groups (id, dimension_id, name) VALUES (1, 1, 'A组')").run()
  conn.prepare("INSERT INTO group_members (id, group_id, student_id, member_name) VALUES (1, 1, 1, '张伟')").run()
  conn.prepare("INSERT INTO group_members (id, group_id, student_id, member_name) VALUES (2, 1, 2, '张伟')").run()
  // legacy 行：student_id 为空，只能按姓名兜底（属于 id=1 的删除）
  conn.prepare("INSERT INTO group_members (id, group_id, student_id, member_name) VALUES (3, 1, NULL, '张伟')").run()
  conn.prepare("INSERT INTO cadres (id, name) VALUES (1, '班长')").run()
  conn.prepare("INSERT INTO cadre_members (id, cadre_id, student_id, student_name) VALUES (1, 1, 1, '张伟')").run()
  conn.prepare("INSERT INTO cadre_members (id, cadre_id, student_id, student_name) VALUES (2, 1, 2, '张伟')").run()
  return conn
}

const ZHANG_WEI_1 = { id: 1, '姓名': '张伟' }

test('统计：预览只算本人（含 legacy 空 id）关联，不含另一同名学生', () => {
  seedNamesakes()
  const r = studentRelations(ZHANG_WEI_1)
  assert.equal(r.group, 2, '本人的 group 行（id=1）+ legacy 空 id 行（id=3）= 2，不该把 id=2 算进来')
  assert.equal(r.cadre, 1, '本人的 cadre 行 1 条，不该含另一同名学生')
})

test('清理：删学生 A 只清 A 的关联，同名学生 B 的关联完好', () => {
  const conn = seedNamesakes()
  const purged = purgeStudentRelations(ZHANG_WEI_1, { group: true, cadre: true })

  assert.equal(purged.group, 2, '清掉 id=1 + legacy 空 id 两行')
  assert.equal(purged.cadre, 1, '只清 id=1 的班干部行')
  assert.equal(conn.prepare('SELECT COUNT(*) AS c FROM group_members WHERE student_id = 2').get().c, 1,
    '同名学生 B 的分组关联被误删 —— 正是本 bug')
  assert.equal(conn.prepare('SELECT COUNT(*) AS c FROM cadre_members WHERE student_id = 2').get().c, 1,
    '同名学生 B 的班干部关联被误删')
  assert.equal(conn.prepare('SELECT COUNT(*) AS c FROM group_members WHERE student_id IS NULL').get().c, 0,
    'legacy 空 id 行应被姓名兜底清掉')
})

test('快照：撤销 payload 含被清掉的行，不含同名学生 B 的行', () => {
  seedNamesakes()
  const purged = purgeStudentRelations(ZHANG_WEI_1, { group: true, cadre: true })
  assert.deepEqual(purged.groupRows.map((r) => r.id).sort(), [1, 3])
  assert.deepEqual(purged.cadreRows.map((r) => r.id), [1])
  assert.ok(!purged.groupRows.some((r) => r.student_id === 2))
  assert.ok(!purged.cadreRows.some((r) => r.student_id === 2))
})

// ————————————————————————— 接线层 + 变异反证 —————————————————————————

function src() {
  return fs.readFileSync(path.join(ROOT, 'student-backend/services/studentRelations.js'), 'utf8')
}

test('接线：group/cadre 匹配都带 student_id IS NULL 兜底，不再无条件姓名 OR', () => {
  const s = src()
  const groupHits = [...s.matchAll(/FROM group_members WHERE[^\n']*/g)].map((m) => m[0])
  const cadreHits = [...s.matchAll(/FROM cadre_members WHERE[^\n']*/g)].map((m) => m[0])
  assert.ok(groupHits.length >= 2 && cadreHits.length >= 2, '统计与清理各应有一处')
  for (const h of [...groupHits, ...cadreHits]) {
    assert.match(h, /student_id = \?/, `${h} 缺权威 id 匹配`)
    assert.match(h, /student_id IS NULL/, `${h} 缺 legacy 兜底，会误删同名`)
  }
})

test('变异反证：把兜底改回无条件姓名 OR，行为判据必须失败', () => {
  // 原 bug 形态：有效 id 的删除也按姓名 OR —— 同名学生 B 的行会被一起删掉
  const mutated = loadMutated('student-backend/services/studentRelations.js', (s) => s.replace(
    /student_id = \? OR \(student_id IS NULL AND TRIM\(member_name\) = TRIM\(\?\)\)/g,
    'student_id = ? OR TRIM(member_name) = TRIM(?)',
  ))
  const conn = seedNamesakes()
  const purged = mutated.purgeStudentRelations(ZHANG_WEI_1, { group: true, cadre: true })

  assert.equal(purged.group, 3, '变异后 A 的清理把同名学生 B 的分组行也删了（原 bug 复现）')
  assert.equal(conn.prepare('SELECT COUNT(*) AS c FROM group_members WHERE student_id = 2').get().c, 0,
    '正例判据「同名学生 B 的关联完好」在变异后必然失败')
})
