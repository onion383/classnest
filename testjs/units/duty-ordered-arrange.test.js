// =========================================================================
// duty-ordered-arrange.test.js —— 独立条件「顺序选项」的行为
// 运行：npm run test:units
//
// 判据：
//   1. 路径：四方向的行优先 / 列优先与反向只对「行内 / 列内」生效
//   2. 顺序：按 poolNames 依次连续铺；一组占路径上连续 N 个槽
//   3. 守恒：不静默丢人；人数少于槽位沿用轮转补满，人数超出如实报 dropped
//   4. 对账：确认框里的 X（shortageCount）必须等于排表后的 dropped
//   5. 形态：确定性规则不记录满足率，界面上不显示「满足 N%」
// 全部动态 import 真实源码，不复现逻辑。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIR = path.join(__dirname, '../../student-frontend/src/components/dialogs/DutyArrangementDialog')
const loadPipeline = () => import(pathToFileURL(path.join(DIR, 'DutyArrangementDialog.pipeline.js')).href)
const loadOptions = () => import(pathToFileURL(path.join(DIR, 'DutyArrangementDialog.options.js')).href)

const DAYS = ['周一', '周二', '周三']
const ITEMS = [{ name: '扫地', count: 1 }, { name: '拖地', count: 1 }] // 3 天 × 2 槽 = 6
const names = n => Array.from({ length: n }, (_, i) => 'S' + i)
const REGISTRY = { order: { apply: 'applyOrdered' } }

function makeCtx(pool, opts = {}) {
  return {
    daysArr: { value: DAYS },
    itemsArr: { value: ITEMS },
    poolNames: { value: pool },
    baseCells: { value: {} },
    weights: { value: {} },
    ledger: { value: {} },
    satisfaction: { value: {} },
    conditions: { value: [] },
    students: { value: [] },
    seat: { value: { seats: [] } },
    dedupeWholeTable: false,
    bigCleanup: { value: false },
    groupBuckets: () => opts.groups || [],
  }
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

async function build(pool, opts = {}) {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const ctx = makeCtx(pool, opts)
  const m = Object.assign({}, useDutyArrangementPipeline(ctx, REGISTRY))
  return { ctx, m, slots: m.buildSlots() }
}

async function ordered(pool, cond, opts = {}) {
  const r = await build(pool, opts)
  const assigned = new Array(r.slots.length).fill('')
  const res = r.m.applyOrdered(r.slots, assigned, { uid: 0, ...cond })
  return { ...r, assigned, res }
}

test('路径 · 四个方向的行优先 / 列优先与反向约定', async () => {
  const { m, slots } = await build(names(6))
  const toStr = d => m.orderedPath(slots, d).map(i => slots[i].day + '/' + slots[i].item)
  assert.deepEqual(toStr('lr'), [
    '周一/扫地', '周二/扫地', '周三/扫地', '周一/拖地', '周二/拖地', '周三/拖地',
  ], '左→右：行优先，先铺满扫地行')
  assert.deepEqual(toStr('rl'), [
    '周三/扫地', '周二/扫地', '周一/扫地', '周三/拖地', '周二/拖地', '周一/拖地',
  ], '右→左：只反转行内，行序仍自上而下')
  assert.deepEqual(toStr('tb'), [
    '周一/扫地', '周一/拖地', '周二/扫地', '周二/拖地', '周三/扫地', '周三/拖地',
  ], '上→下：列优先，先铺满周一整列')
  assert.deepEqual(toStr('bt'), [
    '周一/拖地', '周一/扫地', '周二/拖地', '周二/扫地', '周三/拖地', '周三/扫地',
  ], '下→上：只反转列内，列序仍自左而右')
  for (const d of ['lr', 'rl', 'tb', 'bt']) {
    const p = m.orderedPath(slots, d)
    assert.equal(p.length, slots.length, `${d}：每个槽位都要走到`)
    assert.equal(new Set(p).size, slots.length, `${d}：不许重复走同一个槽`)
  }
})

test('顺序 · 按数据源顺序依次铺，一组占路径上连续 N 个槽', async () => {
  const r = await ordered(names(6), { unit: 'student', direction: 'lr' })
  const path = r.m.orderedPath(r.slots, 'lr')
  path.forEach((i, k) => assert.equal(r.assigned[i], 'S' + k, `第 ${k} 个槽必须是 S${k}`))
  // 交错分组：若按名册线性补槽会假绿，交错后「组内连续」才抓得住
  const groups = [['S0', 'S3'], ['S1', 'S4'], ['S2', 'S5']]
  const g = await ordered(names(6), { unit: 'dorm', direction: 'tb' }, { groups })
  const gpath = g.m.orderedPath(g.slots, 'tb')
  for (const pair of groups) {
    const at = pair.map(n => g.assigned.indexOf(n)).sort((a, b) => a - b)
    assert.ok(at.every(i => i >= 0), `${pair.join('/')} 都要进表`)
    assert.equal(gpath.indexOf(at[0]) + 1, gpath.indexOf(at[1]),
      `${pair.join('/')} 在遍历路径上必须相邻`)
  }
})

test('守恒 · 人数少于槽位时轮转补满且 dropped 为 0', async () => {
  const r = await ordered(names(3), { unit: 'student', direction: 'tb' })
  assert.equal(r.res.dropped, 0)
  assert.equal(r.res.placed, 3)
  assert.ok(r.assigned.every(Boolean), '沿用既有口径，槽位要填满')
  assert.ok(new Set(r.assigned).size < r.assigned.length, '人少时会重复值日（排表前已有确认提示）')
})

test('守恒 · 人数多于槽位时如实报 dropped，仍有空槽就不许少人', async () => {
  const r = await ordered(names(9), { unit: 'student', direction: 'tb' })
  assert.equal(r.slots.length, 6)
  assert.equal(r.res.placed, 6, '6 个槽必须全部用上')
  assert.equal(r.res.dropped, 3, '9 − 6 = 3 人排不进表')
  assert.equal(r.res.placed + r.res.dropped, 9, 'placed + dropped 必须等于参与人数')
  assert.ok(r.assigned.every(Boolean), '还有空槽就不许有人没进表')
})

test('对账 · 确认框里的 X 必须等于排表后的 dropped', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const { useDutyArrangementOptions } = await loadOptions()
  for (const n of [3, 6, 9, 14]) {
    const ctx = makeCtx(names(n))
    // 两处独立计算：X 来自 options.shortageCount()，dropped 来自 pipeline.applyOrdered()
    Object.assign(ctx, useDutyArrangementPipeline(ctx, REGISTRY), useDutyArrangementOptions(ctx, {}))
    const x = ctx.shortageCount()
    const slots = ctx.buildSlots()
    const assigned = new Array(slots.length).fill('')
    const res = ctx.applyOrdered(slots, assigned, { uid: 0, unit: 'student', direction: 'tb' })
    assert.equal(res.dropped, x, `${n} 人 / ${slots.length} 槽：X 与 dropped 不相等就是逻辑丢人`)
  }
})

test('形态 · 确定性规则不记录满足率，界面不显示百分比', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const ctx = makeCtx(names(6))
  ctx.conditions.value = [{ uid: 7, key: 'order', unit: 'student', direction: 'tb' }]
  const m = useDutyArrangementPipeline(ctx, REGISTRY)
  const r = m.buildAssignment()
  assert.ok(r.assigned.every(Boolean), '整条流水线要真的跑通 order 条件')
  const path = m.orderedPath(r.slots, 'tb')
  path.forEach((i, k) => assert.equal(r.assigned[i], 'S' + k,
    '整条流水线也必须按数据源顺序铺，不能被 buildBaseAssignment 的结果带偏'))
  assert.equal(ctx.satisfaction.value[7], undefined, '顺序选项不该写满足率')
  assert.equal(m.satisfactionOf({ uid: 7 }), null, '界面上不该显示满足 N%')
})

test('形态 · 独立条件已登记、四档方向可解析、未接装箱', async () => {
  const vue = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.vue'), 'utf8'))
  const options = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.options.js'), 'utf8'))
  const pipeline = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.pipeline.js'), 'utf8'))
  assert.ok(vue.includes("label: '顺序选项'"), '条件选项要有顺序选项')
  assert.ok(vue.includes("apply: 'applyOrdered'"), '必须指向新的执行函数')
  assert.ok(vue.includes("direction: 'tb'"), '默认从上往下（列优先）')
  assert.ok(vue.includes("path: 'direction'") && vue.includes("options: 'directions'"))
  assert.ok(vue.includes("'order'"), 'CONDITION_ORDER 要有 order 入口')
  assert.ok(options.includes("case 'directions'") && options.includes('directionOptions'))
  for (const label of ['从左往右', '从右往左', '从上往下', '从下往上']) {
    assert.ok(options.includes(`'${label}'`), `方向选项要有「${label}」`)
  }
  assert.ok(pipeline.includes('orderedPath(') && pipeline.includes('applyOrdered('))
  // 锚点只能用去注释后仍存在的真实代码：注释已被 stripComments 删掉，
  // 用注释当终点会让 indexOf 返回 -1，slice 直接切到整篇文件末尾（假红）。
  const fnStart = pipeline.indexOf('applyOrdered(')
  const fnEnd = pipeline.indexOf('fairFill(', fnStart)
  assert.ok(fnStart >= 0 && fnEnd > fnStart, '应能定位 applyOrdered 的函数体')
  const fnBody = pipeline.slice(fnStart, fnEnd)
  assert.ok(!fnBody.includes('trackSatisfaction'), '确定性规则不许记录满足率')
  assert.ok(!fnBody.includes('packGroupsIntoDays'), '顺序选项不该走装箱内核')
  assert.ok(fnBody.includes('fillEmptySlots'), '空槽沿用既有轮转口径')
})
