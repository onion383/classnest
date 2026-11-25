// =========================================================================
// filter-present-identity.test.js —— 点名候选名单按 ID 排除请假，不按姓名（v7 §5-4 / #20）
//
// 事故面：filterPresentStudents 把「今天请假的人」的姓名也收进排除集合。
// 名册里两个「张子涵」时，A 请假会导致在校的 B 也被排除 —— 用户打开点名器发现
// B 不见了，或者开着「排除请假学生」却始终点不到 B。
// 有 student_id 的请假记录只按 ID 排除；只有导入/历史行没有 ID 时才退回姓名。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const loadLeaveState = () => import(pathToFileURL(abs('student-frontend/src/utils/leaveState.js')).href)

const leave = (o) => ({ 状态: '请假中', 开始时间: '2026-11-23', 结束时间: '2026-11-23', ...o })
const stu = (id, name) => ({ id, 姓名: name })
const DAY = '2026-11-23'

const NAMES = (list) => list.map((s) => s.姓名)

test('§5-4：A 请假（带 ID）不影响同名的在校 B', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(11, '张子涵'), stu(12, '张子涵'), stu(13, '李四')]
  const leaves = [leave({ student_id: 11, 姓名: '张子涵' })]

  const r = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(r.list.map((s) => s.id), [12, 13], '只有 11 号不在校，12 号同样是「张子涵」但在校')
  assert.equal(r.excludedCount, 1)
})

test('§5-4：没有 ID 的历史请假行仍按姓名排除（无法区分同名，保守多排除）', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(11, '王五'), stu(12, '王五')]
  const leaves = [leave({ 姓名: '王五' })]  // 导入行，没有 student_id

  const r = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(NAMES(r.list), [], '没有 ID 时只能按姓名判，两条都会被排除（不能点到一个可能不在校的人）')
  assert.equal(r.excludedCount, 2)
})

test('§5-4：同一人的多条请假记录只扣一次人数', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(11, '甲'), stu(12, '乙')]
  const leaves = [
    leave({ student_id: 11, 姓名: '甲' }),
    leave({ student_id: 11, 姓名: '甲' }),  // 重复记录（同一天两条）
  ]
  const r = filterPresentStudents(students, leaves, DAY)
  assert.equal(r.excludedCount, 1, 'excludedCount 是人数，不是记录数')
  assert.deepEqual(r.list.map((s) => s.id), [12])
})

test('§5-4：今天没请假的人一个都不排除（空名单 / 空请假）', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  assert.deepEqual(filterPresentStudents([], [], DAY), { list: [], excludedCount: 0 })
  const students = [stu(1, '甲')]
  assert.deepEqual(NAMES(filterPresentStudents(students, [], DAY).list), ['甲'])
  // 请假在别的日子
  const r = filterPresentStudents(students, [leave({ student_id: 1, 姓名: '甲', 开始时间: '2026-12-01', 结束时间: '2026-12-02' })], DAY)
  assert.deepEqual(NAMES(r.list), ['甲'], '未来的假不算今天不在校')
})

test('§5-4：姓名前后的空白不影响历史行匹配（与名册口径一致）', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(1, '  赵六 ')]
  const leaves = [leave({ 姓名: '赵六' })]
  const r = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(r.list, [], 'trim 后同名应命中（历史数据常带空格）')
})

// ———————————————— 请假统计按身份汇总 ————————————————
const loadPersonKey = () => import(pathToFileURL(abs('student-frontend/src/utils/dutyPersonKey.js')).href)

test('§5-4：personKeyOfRecord —— 有 id 只认 id，缺 id 才退回姓名', async () => {
  const { personKeyOfRecord } = await loadPersonKey()
  assert.equal(personKeyOfRecord({ student_id: 11, 姓名: '张子涵' }), 'id:11')
  assert.equal(personKeyOfRecord({ student_id: '12', 姓名: '张子涵' }), 'id:12', '字符串 id 也要认')
  assert.equal(personKeyOfRecord({ student_id: null, 姓名: ' 王五 ' }), 'name:王五', '缺 id 按 trim 后的姓名')
  assert.equal(personKeyOfRecord({ student_id: '', 姓名: '' }), 'name:', '两者都空也要有稳定 key，不能 undefined')
  assert.equal(personKeyOfRecord(null), '')
})

test('§5-4 接线：请假统计按 personKeyOfRecord 汇总（不再拿姓名当 Map 键）', () => {
  const src = fs.readFileSync(abs('student-frontend/src/views/LeaveManagement.vue'), 'utf8')
  assert.match(src, /import \{ personKeyOfRecord \} from '\.\.\/utils\/dutyPersonKey\.js'/, '要复用「人」标识的单源实现')
  assert.match(src, /const key = personKeyOfRecord\(l\)/, '统计要以身份为键')
  assert.doesNotMatch(src, /const name = l\.姓名 \|\| '未知'\s*\n\s*let row = map\.get\(name\)/,
    '旧的「按姓名取行」写法应已消失')
})
