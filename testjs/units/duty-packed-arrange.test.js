// =========================================================================
// duty-packed-arrange.test.js —— 「随机分组」接入 pipeline 后的行为
// 运行：npm run test:units
//
// 与 duty-packing.test.js 的分工：那边测装箱内核，这边测「整条流水线真的用了它」。
// 判据：
//   1. 语义：同一组的人必须真的落在同一天；装不下时如实降级，满足率不虚报
//   2. 守恒：槽位填满、人不重复、不丢人
//   3. 形态：界面上无「平移排布」/ action 下拉；随机选项与分组选项除 label 外一致，都指向装箱内核（去注释后匹配）
//   4. 内部排布：'random' 只打乱同一天内的槽位顺序，不改变装箱结果（谁在哪天）与整组同天率
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIR = path.join(__dirname, '../../student-frontend/src/components/dialogs/DutyArrangementDialog')
const loadPipeline = () => import(pathToFileURL(path.join(DIR, 'DutyArrangementDialog.pipeline.js')).href)
const REGISTRY = {
  random: { apply: 'applyPackedRandom' },
  group: { apply: 'applyPackedRandom' },
}

const DAYS = ['周一', '周二', '周三']
const ITEMS = [{ name: '扫地', count: 2 }, { name: '拖地', count: 2 }] // 每天 4 槽，共 12 槽
const NAMES = Array.from({ length: 12 }, (_, i) => 'S' + i)
// 故意交错配对：若装箱结果没写回、只是按名册顺序线性补槽，这些组必然散到不同天，
// 「同组同天」判据才抓得住「写回没生效」这类回归（顺序配对会假绿）。
const SMALL_GROUPS = [
  ['S0', 'S6'], ['S1', 'S7'], ['S2', 'S8'],
  ['S3', 'S9'], ['S4', 'S10'], ['S5', 'S11'],
]

function makeCtx(groups, conditions, rng, opts = {}) {
  return {
    daysArr: { value: DAYS },
    itemsArr: { value: opts.items || ITEMS },
    poolNames: { value: NAMES },
    baseCells: { value: {} },
    weights: { value: {} },
    ledger: { value: {} },
    satisfaction: { value: {} },
    conditions: { value: conditions },
    students: { value: [] },
    seat: { value: { seats: [] } },
    // 真实组件里 dedupeWholeTable 由 bigCleanup 派生；测试必须同口径，
    // 否则会掩盖「大扫除整表去重 + 补空槽」导致的人名重复
    dedupeWholeTable: opts.bigCleanup === true,
    bigCleanup: { value: opts.bigCleanup === true },
    groupBuckets: () => groups,
    packRandom: rng,
  }
}

// 固定随机源，才能把「装箱结果」与「天内顺序」分开比较
async function arrange(groups, conditions, rng = () => 0, opts = {}) {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const ctx = makeCtx(groups, conditions, rng, opts)
  const m = useDutyArrangementPipeline(ctx, REGISTRY)
  const res = m.buildAssignment()
  const dayOf = (name) => {
    const i = res.assigned.indexOf(name)
    return i >= 0 ? res.slots[i].day : null
  }
  return { ctx, m, ...res, dayOf }
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const FULL = [{ uid: 0, key: 'random', unit: 'dorm' }]

test('接入 · 同组成员真的落在同一天，整组同天率 100%', async () => {
  const r = await arrange(SMALL_GROUPS, FULL)
  assert.equal(r.assigned.filter(Boolean).length, 12, '12 个槽位必须填满')
  assert.equal(new Set(r.assigned).size, 12, '同一人不能占两个槽')
  for (const g of SMALL_GROUPS) {
    assert.equal(r.dayOf(g[0]), r.dayOf(g[1]), `${g.join('/')} 必须同一天`)
  }
  assert.deepEqual(r.ctx.satisfaction.value[0], { done: 6, total: 6 })
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100)
})

test('接入 · 组大于单天容量时如实降级，满足率按组数算', async () => {
  const groups = [
    ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'], // 6 人 > 每天 4 槽，必拆
    ['S6', 'S7'], ['S8', 'S9'], ['S10', 'S11'],
  ]
  const r = await arrange(groups, FULL)
  assert.equal(r.assigned.filter(Boolean).length, 12, '拆组不许丢人')
  assert.deepEqual(r.ctx.satisfaction.value[0], { done: 3, total: 4 })
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 75, '不能像旧实现那样报 100%')
  for (const g of groups.slice(1)) assert.equal(r.dayOf(g[0]), r.dayOf(g[1]))
  const bigDays = new Set(groups[0].map(n => r.dayOf(n)))
  assert.ok(bigDays.size > 1, '6 人组确实被拆到了不同天')
})

test('接入 · 默认「同学」维度不依赖座位表，等价于全员整体洗牌', async () => {
  const r = await arrange([], [{ uid: 0, key: 'random', unit: 'student' }])
  assert.equal(r.assigned.filter(Boolean).length, 12)
  assert.equal(new Set(r.assigned).size, 12)
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100, '每人一组，必然全部完整')
})

test('接入 · 旧草稿残留的 action / scope 字段被忽略，不崩溃', async () => {
  // 按约定不做旧草稿兼容：字段留着但不参与新模型
  const r = await arrange(SMALL_GROUPS, [
    { uid: 0, key: 'random', unit: 'dorm', action: 'shift', scope: 'six' },
  ])
  assert.equal(r.assigned.filter(Boolean).length, 12)
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100)
})

test('接入 · 分组选项与随机选项执行同一套装箱逻辑', async () => {
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'group', unit: 'dorm' }])
  assert.equal(r.assigned.filter(Boolean).length, 12)
  for (const g of SMALL_GROUPS) assert.equal(r.dayOf(g[0]), r.dayOf(g[1]))
  assert.deepEqual(r.ctx.satisfaction.value[0], { done: 6, total: 6 })
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100)
})

// 每天按槽位顺序取出人名：集合 = 谁在哪天，顺序 = 天内怎么排
function dayLists(r) {
  return DAYS.map(day => r.slots
    .map((s, i) => ({ day: s.day, name: r.assigned[i] }))
    .filter(x => x.day === day && x.name)
    .map(x => x.name))
}

test('内部排布 · 随机排布只换天内槽位顺序，不改变装箱结果', async () => {
  const cond = innerArrange => [{ uid: 0, key: 'random', unit: 'dorm', innerArrange }]
  const a = await arrange(SMALL_GROUPS, cond('default'))
  const b = await arrange(SMALL_GROUPS, cond('random'))
  const la = dayLists(a), lb = dayLists(b)
  assert.deepEqual(la.map(x => [...x].sort()), lb.map(x => [...x].sort()), '每天的人名集合必须相同')
  assert.notDeepEqual(la, lb, '天内顺序确实被打乱')
  assert.equal(a.m.satisfactionOf({ uid: 0 }), 100)
  assert.equal(b.m.satisfactionOf({ uid: 0 }), 100, '随机排布不能影响整组同天率')
  for (const g of SMALL_GROUPS) {
    assert.equal(a.dayOf(g[0]), a.dayOf(g[1]))
    assert.equal(b.dayOf(g[0]), b.dayOf(g[1]), '不能把同组的人拆到不同天')
  }
})

test('内部排布 · 默认排布与不显式指定时完全一致', async () => {
  const a = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm' }])
  const b = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', innerArrange: 'default' }])
  assert.deepEqual(b.assigned, a.assigned, '新增字段不能改变原有默认行为')
})

test('形态 · 平移已移除；随机选项 / 分组选项两个入口都指向装箱内核', async () => {
  const options = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.options.js'), 'utf8'))
  const vue = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.vue'), 'utf8'))
  const pipeline = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.pipeline.js'), 'utf8'))
  assert.ok(!options.includes('平移排布'), 'options 里不该再有平移选项')
  assert.ok(!options.includes('actionOptions'), 'actionOptions 应已移除')
  assert.ok(!vue.includes("options: 'actions'"), '语义句不该再引用 actions')
  const registry = vue.match(/const REGISTRY = \{[\s\S]*?\n\}/)
  assert.ok(registry, 'REGISTRY 应可解析')
  const reg = registry[0]
  const randomBlock = reg.slice(reg.indexOf('random: {'), reg.indexOf('group: {'))
  const groupBlock = reg.slice(reg.indexOf('group: {'), reg.indexOf('relation: {'))
  // 判据收窄到各自的块：labor 规则同样有 path:'action'（一定做 / 不做），不能全文件禁
  for (const block of [randomBlock, groupBlock]) {
    assert.ok(block.includes("apply: 'applyPackedRandom'"), '两条规则都必须接到装箱内核')
    assert.ok(!block.includes("path: 'action'"), '不该再有排布方式下拉')
    assert.ok(!block.includes("path: 'scope'"), '不该再有作用域下拉')
    assert.ok(block.includes("options: 'groups'"), '必须用新的分组维度选项')
    assert.ok(block.includes("path: 'innerArrange'"), '必须有内部排布下拉')
    assert.ok(block.includes("options: 'innerArranges'"), '内部排布下拉必须能解析')
    assert.ok(block.includes("innerArrange: 'default'"), '默认必须是默认排布')
    assert.ok(block.includes("axis: 'column'"), '默认装箱轴必须是按列')
    assert.ok(block.includes("path: 'axis'") && block.includes("options: 'axes'"), '必须有装箱轴下拉')
    assert.ok(block.includes("when: 'daily'") && block.includes("when: 'big'"), '按模式显示句子')
    assert.ok(block.includes('inner: true'), '内部排布段要能被同格档隐藏')
    assert.ok(!block.includes('innerOrder'), '不能复用 fair 的 innerOrder 字段')
  }
  // 除 label 外，apply / defaults / segments 必须逐字一致
  const core = (block) => block.slice(block.indexOf('apply:')).replace(/\s+/g, ' ').trim()
  assert.equal(core(groupBlock), core(randomBlock), '分组选项除名字外应与随机选项完全一致')
  assert.ok(randomBlock.includes("label: '随机选项'"))
  assert.ok(groupBlock.includes("label: '分组选项'"))
  const orderLine = vue.match(/const CONDITION_ORDER = \[[^\]]*\]/)
  assert.ok(orderLine && orderLine[0].includes("'group'"), '分组选项入口应恢复')
  assert.ok(vue.includes('function satisfactionLabel(node)'), '满足率标签必须按 axis 决定')
  assert.ok(vue.includes("'整组同天'") && vue.includes("'整组同区'") && vue.includes("'整组同项'") && vue.includes("'整组同格'"),
    '四种装箱轴各有自己的满足率标签')
  // 精确到完整语句，防止「cell → 整组同项」这类映射写反仍有绿
  assert.ok(vue.includes("if (node.axis === 'cell') return '整组同格'"))
  assert.ok(vue.includes("if (node.axis === 'row') return '整组同项'"))
  assert.ok(vue.includes("return props.bigCleanup ? '整组同区' : '整组同天'"))
  assert.ok(vue.includes('{{ satisfactionLabel(node) }}'), '模板必须真的调用标签函数')
  assert.ok(vue.includes("node.key !== 'group'"), '分组选项也必须走同一套标签判定')
  // minCount：随机 / 分组 / 默认条件三处都要带装箱轴，
  // 全文 includes 会在删掉其中一处时仍被另外两处命中（假绿）
  const axisDefaults = (vue.match(/axis: 'column'/g) || []).length
  assert.ok(axisDefaults >= 3, `三处默认都要带装箱轴，实际 ${axisDefaults} 处`)
  assert.ok(options.includes("case 'groups'"), '分组维度下拉必须能解析')
  assert.ok(options.includes("case 'axes'"), '装箱轴下拉必须能解析')
  assert.ok(options.includes('axisOptions'), '装箱轴选项表须独立')
  assert.ok(options.includes("'同一个工作区域'") && options.includes("'同一个劳动项目'") && options.includes("'同区域且同项目'"),
    '大扫除三档选项都要在')
  assert.ok(options.includes("s.when === 'big'") && options.includes("s.when === 'daily'"),
    '日常与大扫除要显示不同句子')
  assert.ok(options.includes("s.inner && node.axis === 'cell'"), '同格档要隐藏内部排布')
  assert.ok(options.includes("case 'innerArranges'"), '内部排布下拉必须能解析')
  assert.ok(options.includes("label: '默认排布'") && options.includes("label: '随机排布'"), '两个选项都要在')
  assert.ok(options.includes('innerArrangeOptions'), '选项表须独立，不复用 fair 的 innerOrder')
  assert.ok(pipeline.includes('packGroupsIntoDays'), 'pipeline 必须真的调用装箱内核')
  assert.ok(pipeline.includes('innerArrange ==='), 'pipeline 必须按内部排布分流')
})

// ===== 大扫除：按 axis 切桶 =====
// 3 天 × (扫地 2 + 拖地 2) = 12 槽：column 3 桶×4、row 2 桶×6、cell 6 桶×2
test('分桶 · 三种 axis 的桶数与容量直接来自槽位分组', async () => {
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', axis: 'column' }])
  const shape = axis => r.m.bucketIdxs(r.slots, axis).map(a => a.length)
  assert.deepEqual(shape('column'), [4, 4, 4], '按列 = 每天 4 槽')
  assert.deepEqual(shape('row'), [6, 6], '按行 = 每个项目跨 3 天共 6 槽')
  assert.deepEqual(shape('cell'), [2, 2, 2, 2, 2, 2], '按格 = 每格 count 个槽')
})

function cellOf(res, name) {
  const i = res.assigned.indexOf(name)
  return i < 0 ? null : res.slots[i].item + '|' + res.slots[i].day
}
function itemOf(res, name) {
  const i = res.assigned.indexOf(name)
  return i < 0 ? null : res.slots[i].item
}

test('分桶 · axis=row 让整组落在同一个劳动项目', async () => {
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', axis: 'row' }], () => 0, { bigCleanup: true })
  assert.equal(r.assigned.filter(Boolean).length, 12)
  assert.equal(new Set(r.assigned).size, 12)
  for (const g of SMALL_GROUPS) {
    assert.equal(itemOf(r, g[0]), itemOf(r, g[1]), `${g.join('/')} 必须做同一个项目`)
  }
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100)
})

test('分桶 · axis=cell 让整组落在同一区域且同一项目', async () => {
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', axis: 'cell' }], () => 0, { bigCleanup: true })
  assert.equal(r.assigned.filter(Boolean).length, 12)
  assert.equal(new Set(r.assigned).size, 12)
  for (const g of SMALL_GROUPS) {
    assert.equal(cellOf(r, g[0]), cellOf(r, g[1]), `${g.join('/')} 必须同一格`)
  }
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 100)
})

test('分桶 · 各项目 count 不同时逐桶容量生效，不丢人不重复', async () => {
  // 扫地每行 1 人 ×3 天 = 3 槽；拖地每行 3 人 ×3 天 = 9 槽 → row 桶容量 [3, 9]
  const items = [{ name: '扫地', count: 1 }, { name: '拖地', count: 3 }]
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', axis: 'row' }], () => 0, { bigCleanup: true, items })
  assert.deepEqual(r.m.bucketIdxs(r.slots, 'row').map(a => a.length), [3, 9])
  assert.equal(r.assigned.filter(Boolean).length, 12, '12 个槽必须填满')
  assert.equal(new Set(r.assigned).size, 12, '不能因超容量截断后补出重复人名')
  // 桶容量 [3, 9] 都是奇数，装 2 人组各剩 1 槽 → 最多 1 + 4 = 5 组完整，第 6 组必拆。
  // 若容量仍按单一值处理，这里会虚报 6 组或丢人。
  assert.deepEqual(r.ctx.satisfaction.value[0], { done: 5, total: 6 },
    '逐桶容量必须让「必拆一组」如实反映在满足率上')
  assert.equal(r.m.satisfactionOf({ uid: 0 }), 83)
})

test('分桶 · 大扫除关闭整桶随机映射（管线真的把开关接上）', async () => {
  const pipeline = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.pipeline.js'), 'utf8'))
  assert.ok(pipeline.includes('mapBuckets'), 'pipeline 必须把随机映射开关传给装箱内核')
  // 行为层区分不出「开关没传」：等容量大扫除下开/关映射都只是整桶换标签，分组结构不变，
  // 且内核自带「容量不等 ⇒ 自动关映射」保护。故这一项用调用点形态判据守着。
  assert.ok(pipeline.includes('caps, rng, { mapBuckets })'),
    'mapBuckets 必须真的作为第 5 参传给装箱内核，不能只算不用')
  assert.ok(pipeline.includes('!ctx.bigCleanup.value'), '大扫除必须关闭整桶随机映射')
  assert.ok(pipeline.includes("node.axis !== 'row'") && pipeline.includes("node.axis !== 'cell'"),
    '按项目行 / 按格子分桶时标签不等价，不许随机映射')
  const r = await arrange(SMALL_GROUPS, [{ uid: 0, key: 'random', unit: 'dorm', axis: 'row' }], () => 0, { bigCleanup: true })
  assert.equal(new Set(r.assigned).size, 12, '关闭映射后结果仍守恒')
})

// ===== 语义句渲染：跑 options.js 真实源码，REGISTRY 只是输入数据 =====
const loadOptions = () => import(pathToFileURL(path.join(DIR, 'DutyArrangementDialog.options.js')).href)

// 形状与真实 vue REGISTRY 的 random 块一致；两者是否对得上由上面的静态判据守着
const SEG_REGISTRY = {
  random: {
    segments: [
      { t: 'text', v: '尽量让' },
      { t: 'select', path: 'unit', options: 'groups' },
      { t: 'text', v: '在同一天值日', when: 'daily' },
      { t: 'text', v: '在', when: 'big' },
      { t: 'select', path: 'axis', options: 'axes', when: 'big' },
      { t: 'text', v: ' 并且 内部', inner: true },
      { t: 'select', path: 'innerArrange', options: 'innerArranges', inner: true },
    ],
  },
}

async function makeOptions(big) {
  const ctx = { bigCleanup: { value: big } }
  const { useDutyArrangementOptions } = await loadOptions()
  const opts = useDutyArrangementOptions(ctx, SEG_REGISTRY)
  Object.assign(ctx, opts) // 真实组件里也是 Object.assign 回填，resolveOptions 才能解析 options 段
  return opts
}

test('语义句 · 日常不渲染装箱轴下拉，大扫除渲染三档', async () => {
  const daily = await makeOptions(false)
  const big = await makeOptions(true)
  const node = { key: 'random', axis: 'column' }
  const d = daily.segmentsOf(node)
  const b = big.segmentsOf(node)
  assert.ok(d.some(s => s.v === '在同一天值日'), '日常保留原句')
  assert.ok(!d.some(s => s.path === 'axis'), '日常不该出现只有一个选项的下拉')
  assert.ok(!b.some(s => s.v === '在同一天值日'), '大扫除不提「天」')
  const axisSeg = b.find(s => s.path === 'axis')
  assert.ok(axisSeg, '大扫除要有装箱轴下拉')
  assert.deepEqual(axisSeg.options.map(o => o.value), ['column', 'row', 'cell'])
  assert.deepEqual(axisSeg.options.map(o => o.label), ['同一个工作区域', '同一个劳动项目', '同区域且同项目'])
  assert.deepEqual(daily.axisOptions(), [], '日常不提供装箱轴选项')
})

test('语义句 · 同格档隐藏内部排布，另外两档保留', async () => {
  const big = await makeOptions(true)
  const paths = axis => big.segmentsOf({ key: 'random', axis }).map(s => s.path).filter(Boolean)
  for (const axis of ['column', 'row']) {
    assert.ok(paths(axis).includes('innerArrange'), `${axis} 档要保留内部排布`)
  }
  assert.ok(!paths('cell').includes('innerArrange'), '同格档没有可排的东西')
  assert.ok(big.segmentsOf({ key: 'random', axis: 'cell' }).every(s => s.v !== ' 并且 内部'),
    '连接词也要一起隐藏，别留半句话')
})
