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
const fs = require('node:fs')
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
const loadArrangeOptions = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.options.js',
)).href)
const loadPersonKey = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/utils/dutyPersonKey.js',
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

function seatCtx(dataSource, usable, extra = {}) {
  return {
    rows: { value: 2 },
    cols: { value: 2 },
    students: { value: SEAT_STUDENTS },
    baseSeats: { value: SEAT_BASE },
    // 数据源能力位：table 模式不允许新同学参与（A5-01 的唯一判据）
    allowNew: { value: dataSource !== 'table' },
    excludeNew: { value: false },
    strangerNames: { value: new Set() },
    dataSource: { value: dataSource },
    satisfaction: { value: {} },
    // 异形网格改造后：算法只碰「可用格」（types=座位）。全座位布局时恒 true。
    isUsable: typeof usable === 'function' ? usable : () => true,
    ...extra,
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

test('座位排表 · 走廊行/空位格不参与排表：补位与条件作用域都跳过它们', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  // 只有第 0 行可用（第 1 行整行是走廊）
  const ctx = seatCtx('all', (r) => r === 0)
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  assert.equal(grid.flat().filter(Boolean).length, 2, '只有 2 个可用格能坐人')
  assert.deepEqual(grid[1], [null, null], '走廊行必须保持空 —— 学生不能排进走廊')
  // 条件的作用域同样不该包含走廊格，否则随机/分组会把「走廊」当空座位来换位
  assert.deepEqual(pipeline.allCells(), [{ r: 0, c: 0 }, { r: 0, c: 1 }])
})

// F03-02：容量不变量下沉到算法层 —— 装不下的学生不能只被静默丢弃，缺口数必须透出
test('座位排表 · 容量不足：pipeline 透出 shortfall，不再静默丢人', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  // 名册 6 人，座位 2×2 只有 4 格，rest 里有 4 人未入座但只能塞下 2 个
  const ctx = seatCtx('all', undefined, {
    students: { value: [...SEAT_STUDENTS, { id: 5, 姓名: '钱七' }, { id: 6, 姓名: '孙八' }] },
  })
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  assert.equal(grid.flat().filter(Boolean).length, 4, '只有 4 个座位能落人')
  assert.equal(ctx.shortfall, 2, '装不下的 2 人必须由算法层报出，不能静默消失')
})

test('座位排表 · 容量刚好/table 模式：shortfall 为 0', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  const ctxAll = seatCtx('all')
  useSmartArrangementPipeline(ctxAll, {}).initGrid()
  assert.equal(ctxAll.shortfall, 0, '4 人 4 格刚好装满，缺口为 0')
  const ctxTable = seatCtx('table')
  useSmartArrangementPipeline(ctxTable, {}).initGrid()
  assert.equal(ctxTable.shortfall, 0, 'table 模式只排表内已有的人，不产生缺口')
})

// A5-01：table 模式下 excludeNew 是上一轮「全部同学」的选择残留，不能拿它排除表内已有成员
test('座位排表 · 现有排表表格：excludeNew 不能排除表内已有的新同学', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  const ctx = seatCtx('table', undefined, {
    baseSeats: { value: [[1, '钱七'], [null, null]] },
    excludeNew: { value: true },
    strangerNames: { value: new Set(['钱七']) },
  })
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  assert.ok(
    grid.flat().some(s => s && s.姓名 === '钱七'),
    'table 模式的语义是「以表里的内容为准」，名册外的钱七必须保留',
  )
})

test('座位排表 · 全部同学：excludeNew 仍然排除新同学', async () => {
  const { useSmartArrangementPipeline } = await loadSeat()
  const ctx = seatCtx('all', undefined, {
    baseSeats: { value: [[1, '钱七'], [null, null]] },
    excludeNew: { value: true },
    strangerNames: { value: new Set(['钱七']) },
  })
  const pipeline = useSmartArrangementPipeline(ctx, {})
  const grid = pipeline.initGrid()
  assert.ok(
    !grid.flat().some(s => s && s.姓名 === '钱七'),
    'all 模式下用户选择「不参与」，新同学必须被排除',
  )
})

// A5-01：新人确认只在 allowNew 的数据源下弹
function arrangeOptionsCtx(dataSource) {
  return {
    arranged: { value: false },
    allowNew: { value: dataSource !== 'table' },
    strangers: { value: ['王五'] },
    showNewPrompt: { value: false },
    excludeNew: { value: false },
    generated: false,
    generatePreview() { this.generated = true },
  }
}

test('座位排表 · 现有排表表格：startArrange 不弹新人确认', async () => {
  const { useSmartArrangementOptions } = await loadArrangeOptions()
  const ctx = arrangeOptionsCtx('table')
  useSmartArrangementOptions(ctx, {}).startArrange()
  assert.equal(ctx.showNewPrompt.value, false, 'table 模式不该弹新人确认')
  assert.equal(ctx.generated, true, '应直接生成预览')
})

test('座位排表 · 全部同学：startArrange 仍弹新人确认', async () => {
  const { useSmartArrangementOptions } = await loadArrangeOptions()
  const ctx = arrangeOptionsCtx('all')
  useSmartArrangementOptions(ctx, {}).startArrange()
  assert.equal(ctx.showNewPrompt.value, true, 'all 模式仍要先问新同学是否参与')
  assert.equal(ctx.generated, false, '确认前不应生成预览')
})

// ==================== 值日排表 ====================
// 一天一个项目「扫地」需要 3 人；当前值日表里只排了 2 人（还差 1 个空槽）
const DUTY_STUDENTS = ['张三', '李四', '王五', '赵六']
const DUTY_CELLS = { 扫地: { 周一: ['张三', '李四'] } }

// 值日排表内部用 key（`id:<id>` / `name:<姓名>`）标识人。这里的学生没有 id，
// 所以池子里的人一律是 name: 形态 —— 与真实代码走同一份转换实现，不另写一套。
const K = (name) => `name:${name}`
let PK = null
test.before(async () => { PK = await loadPersonKey() })

function dutyCtx(dataSource, pool) {
  const nameById = PK.buildNameById([])
  const idByName = PK.buildIdByName(nameById)
  return {
    daysArr: { value: ['周一'] },
    itemsArr: { value: [{ name: '扫地', count: 3 }] },
    weights: { value: {} },
    ledger: { value: {} },
    ledgerByName: { value: {} },
    baseCells: { value: DUTY_CELLS },
    studentKeys: { value: DUTY_STUDENTS.map(K) },
    poolKeys: { value: pool },
    keyOfValue: (v) => PK.keyOfValue(v, idByName),
    valueOfKey: PK.valueOfKey,
    nameOfKey: (k) => PK.nameOfKey(k, nameById),
    toKeyCells: (c) => PK.toKeyCells(c, idByName),
    toValueCells: PK.toValueCells,
    dataSource: { value: dataSource },
    seat: { value: { seats: [] } },
    satisfaction: { value: {} },
    conditions: { value: [] },
  }
}

test('值日排表 · 现有排表表格：空槽由表里的人轮转补，不引入名册里没上表的人', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const pool = [K('张三'), K('李四')]
  const ctx = dutyCtx('table', pool)
  const pipeline = useDutyArrangementPipeline(ctx, {})
  const slots = pipeline.buildSlots()
  const assigned = pipeline.buildBaseAssignment(slots)
  assert.equal(assigned.length, 3, '3 个槽位都要填上')
  assert.deepEqual(assigned.slice(0, 2), [K('张三'), K('李四')], '原有两人留在原槽位')
  assert.ok(pool.includes(assigned[2]), `补槽的人必须来自表里的人，实际是「${assigned[2]}」`)
  assert.ok(!DUTY_STUDENTS.map(K).includes(assigned[2]) || DUTY_CELLS.扫地.周一.map(K).includes(assigned[2]),
    '不能把名册里没上表的人塞进来')
})

test('值日排表 · 全部同学：空槽优先补名册里没上表的人', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx('all', DUTY_STUDENTS.map(K))
  const pipeline = useDutyArrangementPipeline(ctx, {})
  const slots = pipeline.buildSlots()
  const assigned = pipeline.buildBaseAssignment(slots)
  assert.deepEqual(assigned.slice(0, 2), [K('张三'), K('李四')], '原有两人留在原槽位')
  assert.ok(['王五', '赵六'].map(K).includes(assigned[2]), `补槽的人应来自名册里没上表的，实际是「${assigned[2]}」`)
})

test('值日排表 · 作用域「全部」的参与者 = 当前数据源的学生池', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const tableCtx = dutyCtx('table', ['张三', '李四'].map(K))
  const tablePipeline = useDutyArrangementPipeline(tableCtx, {})
  const slots = tablePipeline.buildSlots()
  const assigned = tablePipeline.buildBaseAssignment(slots)
  const tableParticipants = [...tablePipeline.scopeContexts('all', slots, assigned)[0].participants].sort()
  assert.deepEqual(tableParticipants, ['张三', '李四'].map(K).sort(), '现有排表表格：只有表里的人参与')

  const allCtx = dutyCtx('all', DUTY_STUDENTS.map(K))
  const allPipeline = useDutyArrangementPipeline(allCtx, {})
  const allSlots = allPipeline.buildSlots()
  const allAssigned = allPipeline.buildBaseAssignment(allSlots)
  const allParticipants = [...allPipeline.scopeContexts('all', allSlots, allAssigned)[0].participants].sort()
  assert.deepEqual(allParticipants, DUTY_STUDENTS.map(K).sort(), '全部同学：名册 4 人参与')
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

test('分组 · 切数据源清空条件里的旧学生 id（A5-04）', async () => {
  const { clearStudentSelections } = await loadGroup()
  const stages = [
    { type: 'relation', kind: 'together', a: 1, b: 2 },
    { type: 'identity', kind: 'leader', studentId: 3 },
    { type: 'gender', mode: 'balanced' },
  ]
  clearStudentSelections(stages)
  assert.equal(stages[0].a, '', '关系条件 a 要清空')
  assert.equal(stages[0].b, '', '关系条件 b 要清空')
  assert.equal(stages[1].studentId, '', '身份条件 studentId 要清空')
  assert.equal(stages[2].mode, 'balanced', '其它条件不受影响')
})

test('[静态] 切数据源统一复位（排表 excludeNew / 分组旧学生 id）', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8')
  const arrangeSrc = read('student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.vue')
  assert.match(
    arrangeSrc,
    /function onDataSourceChange\(\) \{[\s\S]{0,220}?excludeNew\.value = false/,
    '排表切源必须复位 excludeNew / showNewPrompt',
  )
  const groupSrc = read('student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.vue')
  assert.match(
    groupSrc,
    /function onDataSourceChange\(\) \{[\s\S]{0,320}?ctx\.resetStudentSelections\(\)/,
    '分组切源必须走统一的旧学生选择清理入口',
  )
})
