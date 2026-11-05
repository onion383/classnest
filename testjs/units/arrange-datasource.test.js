// =========================================================================
// arrange-datasource.test.js —— 智能排表弹窗的「选择数据源」
// 运行：npm run test:units
//
// 背景：座位排表 / 值日排表两个弹窗顶部各加了一行「选择数据源」下拉框：
//   现有排表表格（默认）= 只排当前那张表里已有的人，空位保持空着
//   全部同学           = 读学生表的名册来排（座位：没入座的补进空位；值日：没上表的补进空槽）
//
// 判据：
//   1. 座位：initGrid 在「现有排表表格」下不把没入座的同学补进空位；「全部同学」下要补
//   2. 值日：baseAssignment 的补槽来源随数据源变（表里的人轮转 vs 名册里没上表的人）
//   3. 值日：作用域「全部」的参与者名单 = 当前数据源的学生池
//   4. 分组：buildRoster 的名单随数据源变（现有分组里的人 vs 名册全班）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadSeat = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.pipeline.js',
)).href)
const loadDuty = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js',
)).href)
const loadGroup = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.pipeline.js',
)).href)

// ==================== 座位排表 ====================
// 名册 4 人，座位表只坐了 2 人（第 1 行两人，第 2 行空着）
const SEAT_STUDENTS = [
  { id: 1, 姓名: '张三', 性别: '男' },
  { id: 2, 姓名: '李四', 性别: '女' },
  { id: 3, 姓名: '王五', 性别: '男' },
  { id: 4, 姓名: '赵六', 性别: '女' },
]
const SEAT_BASE = [[1, 2], [null, null]]

function seatCtx(dataSource) {
  return {
    rows: { value: 2 },
    cols: { value: 2 },
    students: { value: SEAT_STUDENTS },
    baseSeats: { value: SEAT_BASE },
    excludeNew: { value: false },
    strangerNames: { value: new Set() },
    dataSource: { value: dataSource },
    satisfaction: { value: {} },
  }
}

test('座位排表 · 现有排表表格：只重排表里的人，空位保持空着', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  const ctx = seatCtx('table')
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  const ids = grid.flat().filter(Boolean).map(s => s.id).sort()
  assert.deepEqual(ids, [1, 2], '只有座位表里已有的 2 人，没入座的同学不该被补进来')
  assert.equal(grid.flat().filter(Boolean).length, 2, '空位必须保持空着')
})

test('座位排表 · 全部同学：没入座的同学补进空位', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  const ctx = seatCtx('all')
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  const ids = grid.flat().filter(Boolean).map(s => s.id).sort()
  assert.deepEqual(ids, [1, 2, 3, 4], '名册 4 人全部入座')
})

// ==================== 值日排表 ====================
// 一天一个项目「扫地」需要 3 人；当前值日表里只排了 2 人（还差 1 个空槽）
const DUTY_STUDENTS = ['张三', '李四', '王五', '赵六']
const DUTY_CELLS = { 扫地: { 周一: ['张三', '李四'] } }

function dutyCtx(dataSource, pool) {
  return {
    daysArr: { value: ['周一'] },
    itemsArr: { value: [{ name: '扫地', count: 3 }] },
    weights: { value: {} },
    ledger: { value: {} },
    baseCells: { value: DUTY_CELLS },
    studentNames: { value: DUTY_STUDENTS },
    poolNames: { value: pool },
    dataSource: { value: dataSource },
    seat: { value: { seats: [] } },
    satisfaction: { value: {} },
    conditions: { value: [] },
  }
}

test('值日排表 · 现有排表表格：空槽由表里的人轮转补，不引入名册里没上表的人', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const pool = ['张三', '李四']
  const ctx = dutyCtx('table', pool)
  const pipeline = useDutyArrangementPipeline(ctx, {})
  const slots = pipeline.buildSlots()
  const assigned = pipeline.buildBaseAssignment(slots)
  assert.equal(assigned.length, 3, '3 个槽位都要填上')
  assert.deepEqual(assigned.slice(0, 2), ['张三', '李四'], '原有两人留在原槽位')
  assert.ok(pool.includes(assigned[2]), `补槽的人必须来自表里的人，实际是「${assigned[2]}」`)
  assert.ok(!DUTY_STUDENTS.includes(assigned[2]) || DUTY_CELLS.扫地.周一.includes(assigned[2]),
    '不能把名册里没上表的人塞进来')
})

test('值日排表 · 全部同学：空槽优先补名册里没上表的人', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx('all', DUTY_STUDENTS)
  const pipeline = useDutyArrangementPipeline(ctx, {})
  const slots = pipeline.buildSlots()
  const assigned = pipeline.buildBaseAssignment(slots)
  assert.deepEqual(assigned.slice(0, 2), ['张三', '李四'], '原有两人留在原槽位')
  assert.ok(['王五', '赵六'].includes(assigned[2]), `补槽的人应来自名册里没上表的，实际是「${assigned[2]}」`)
})

test('值日排表 · 作用域「全部」的参与者 = 当前数据源的学生池', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const tableCtx = dutyCtx('table', ['张三', '李四'])
  const tablePipeline = useDutyArrangementPipeline(tableCtx, {})
  const slots = tablePipeline.buildSlots()
  const assigned = tablePipeline.buildBaseAssignment(slots)
  const tableParticipants = [...tablePipeline.scopeContexts('all', slots, assigned)[0].participants].sort()
  assert.deepEqual(tableParticipants, ['张三', '李四'], '现有排表表格：只有表里的人参与')

  const allCtx = dutyCtx('all', DUTY_STUDENTS)
  const allPipeline = useDutyArrangementPipeline(allCtx, {})
  const allSlots = allPipeline.buildSlots()
  const allAssigned = allPipeline.buildBaseAssignment(allSlots)
  const allParticipants = [...allPipeline.scopeContexts('all', allSlots, allAssigned)[0].participants].sort()
  assert.deepEqual(allParticipants, ['张三', '李四', '王五', '赵六'], '全部同学：名册 4 人参与')
})

// ==================== 智能分组 ====================
// 名册 3 人；现有分组表里只有 2 人（其中「王五」是名册外的新同学）
const GROUP_STUDENTS = [
  { id: 1, 姓名: '张三', 性别: '男' },
  { id: 2, 姓名: '李四', 性别: '女' },
  { id: 3, 姓名: '赵六', 性别: '男' },
]
const GROUP_TABLE = [
  { name: '第1组', members: [{ member_name: '张三' }, { member_name: '王五' }] },
  { name: '第2组', members: [{ member_name: '李四' }] },
]

test('分组 · 现有分组表格：只排表里的人，名册里没进组的人不参与', async () => {
  const { buildRoster } = await loadGroup()
  const roster = buildRoster({
    dataSource: 'table', students: GROUP_STUDENTS, groups: GROUP_TABLE, includeNew: false,
  })
  assert.deepEqual(roster.map(s => s.姓名), ['张三', '王五', '李四'], '只有现有分组里的 3 人')
  assert.ok(!roster.some(s => s.姓名 === '赵六'), '名册里没进组的赵六不该参与')
})

test('分组 · 现有分组表格：表里的人能对上名册的取名册对象（带 id / 性别）', async () => {
  const { buildRoster } = await loadGroup()
  const roster = buildRoster({
    dataSource: 'table', students: GROUP_STUDENTS, groups: GROUP_TABLE, includeNew: false,
  })
  const zhang = roster.find(s => s.姓名 === '张三')
  assert.equal(zhang.id, 1, '张三要取名册对象（条件行的学生下拉靠 id 定位）')
  assert.equal(zhang.性别, '男', '性别要带上（性别比例条件靠它分池）')
  const wang = roster.find(s => s.姓名 === '王五')
  assert.equal(wang.id, undefined, '名册外的新同学没有 id')
})

test('分组 · 全部同学：名册全员参与，现有小组成员里的名册外同学不自动带进来', async () => {
  const { buildRoster } = await loadGroup()
  const roster = buildRoster({
    dataSource: 'all', students: GROUP_STUDENTS, groups: GROUP_TABLE, includeNew: false,
  })
  assert.deepEqual(roster.map(s => s.姓名), ['张三', '李四', '赵六'], '名册 3 人')
})

test('分组 · 全部同学 + 用户选择参与新同学：名册外的人附在后面', async () => {
  const { buildRoster } = await loadGroup()
  const roster = buildRoster({
    dataSource: 'all', students: GROUP_STUDENTS, groups: GROUP_TABLE, includeNew: true,
  })
  assert.deepEqual(roster.map(s => s.姓名), ['张三', '李四', '赵六', '王五'], '王五作为新同学附在末尾')
})
