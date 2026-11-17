// =========================================================================
// duty-ledger-by-id.test.js —— 值日账本按「学生身份」而不是按姓名统计
//
// 背景：值日格里的历史数据存的是姓名，两个同名学生在那里合成了一个字符串。
// 排表的公平账本过去按姓名累加，于是「张子涵做过 4 次」会同时算到两个人头上，
// 两人都被少排 —— 不报错、界面看着正常，只是越排越不均。
//
// 现在内部用 key 标识人：`id:16` / `name:张三`。这个文件盯三件事：
//   ① key 转换规则（与生产同一份实现 utils/dutyPersonKey.js）
//   ② 两个同名 id 的账本各算各的
//   ③ 已经按 id 存好的值日表，排表时不会被当成空格重排
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIR = path.join(__dirname, '../../student-frontend/src')
const loadPK = () => import(pathToFileURL(path.join(DIR, 'utils/dutyPersonKey.js')).href)
const loadPipeline = () => import(pathToFileURL(path.join(
  DIR, 'components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js',
)).href)
const loadOptions = () => import(pathToFileURL(path.join(
  DIR, 'components/dialogs/DutyArrangementDialog/DutyArrangementDialog.options.js',
)).href)

// 两个同名 + 一个不同名
const STUDENTS = [
  { id: 16, 姓名: '张子涵' },
  { id: 46, 姓名: '张子涵' },
  { id: 7, 姓名: '李四' },
]

let PK = null
test.before(async () => { PK = await loadPK() })

function maps() {
  const nameById = PK.buildNameById(STUDENTS)
  return { nameById, idByName: PK.buildIdByName(nameById) }
}

// ============ ① key 转换规则 ============

test('keyOfValue：数字 id 直接成 id 形态，唯一姓名折算成 id', () => {
  const { idByName } = maps()
  assert.equal(PK.keyOfValue(7, idByName), 'id:7')
  assert.equal(PK.keyOfValue('李四', idByName), 'id:7', '名册里唯一的名字要折算成身份')
})

test('keyOfValue：同名两人无法判断，退回 name 形态而不是随便挑一个', () => {
  const { idByName } = maps()
  assert.equal(PK.keyOfValue('张子涵', idByName), 'name:张子涵',
    '挑错等于把 A 的值日记到 B 头上，数字还看着正常')
})

test('keyOfValue：已经是 key 形态时不二次包装', () => {
  const { idByName } = maps()
  assert.equal(PK.keyOfValue('id:16', idByName), 'id:16')
  assert.equal(PK.keyOfValue('name:外人', idByName), 'name:外人')
})

test('keyOfValue：0 / 负数 / 空值不是人', () => {
  const { idByName } = maps()
  for (const v of [0, -1, '', null, undefined, '   ']) {
    assert.equal(PK.keyOfValue(v, idByName), '')
  }
})

test('valueOfKey 与 nameOfKey 可往返', () => {
  const { nameById } = maps()
  assert.equal(PK.valueOfKey('id:16'), 16)
  assert.equal(PK.valueOfKey('name:王五'), '王五')
  assert.equal(PK.nameOfKey('id:16', nameById), '张子涵')
  assert.equal(PK.nameOfKey('name:王五', nameById), '王五')
  // 学生已删：显示 id 本身，不能静默变空（空看起来像「这格本来没人」）
  assert.equal(PK.nameOfKey('id:9999', nameById), '#9999')
})

test('toKeyCells / toValueCells 在两个值域之间往返', () => {
  const { idByName } = maps()
  const asValues = { 扫地: { 周一: [16, '李四', '外人', ''] } }
  const asKeys = PK.toKeyCells(asValues, idByName)
  assert.deepEqual(asKeys, { 扫地: { 周一: ['id:16', 'id:7', 'name:外人', ''] } })
  assert.deepEqual(PK.toValueCells(asKeys), { 扫地: { 周一: [16, 7, '外人', ''] } })
})

// ============ ② 同名两人的账本各算各的 ============

function makeCtx({ pool, ledger, baseCells = {}, items = null }) {
  const { nameById, idByName } = maps()
  return {
    daysArr: { value: ['周一'] },
    itemsArr: { value: items || [{ name: '扫地', count: 2 }] },
    poolKeys: { value: pool },
    baseCells: { value: baseCells },
    weights: { value: { 扫地: { 周一: 1 } } },
    ledger: { value: ledger },
    ledgerByName: { value: {} },
    satisfaction: { value: {} },
    conditions: { value: [] },
    students: { value: STUDENTS },
    seat: { value: { seats: [] } },
    dedupeWholeTable: false,
    bigCleanup: { value: false },
    groupBuckets: () => [],
    keyOfValue: (v) => PK.keyOfValue(v, idByName),
    valueOfKey: PK.valueOfKey,
    nameOfKey: (k) => PK.nameOfKey(k, nameById),
    toKeyCells: (c) => PK.toKeyCells(c, idByName),
    toValueCells: PK.toValueCells,
  }
}

test('同名两人：账本按 id 各算各的，不合并', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  // 16 号做过很多次、46 号一次没做过 —— 按姓名合并时两人都会拿到 9
  const ctx = makeCtx({ pool: ['id:16', 'id:46'], ledger: { 16: 9, 46: 0 } })
  const p = useDutyArrangementPipeline(ctx, {})
  assert.equal(p.ledgerOf('id:16'), 9)
  assert.equal(p.ledgerOf('id:46'), 0, '另一个同名的人不能被算成做过 9 次')
})

test('名册外的姓名（name 形态）走 unresolved 账本', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const ctx = makeCtx({ pool: ['name:外人'], ledger: { 16: 9 } })
  ctx.ledgerByName = { value: { 外人: 2.5 } }
  const p = useDutyArrangementPipeline(ctx, {})
  assert.equal(p.ledgerOf('name:外人'), 2.5)
})

test('公平分配按身份账本排序：账本高的配轻活（不按姓名合并）', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  // 三个人账本各不相同：正确排序是 16(9) → 7(5) → 46(1)。
  // 如果 ledgerOf 退化成「一律 0」（按姓名合并时同名两人会同时拿到 9 或同时 0），
  // 稳定排序会保住池子的原始顺序 16 → 46 → 7，这条断言就会红。
  const ctx = makeCtx({
    pool: ['id:16', 'id:46', 'id:7'],
    ledger: { 16: 9, 46: 1, 7: 5 },
    items: [{ name: '扫地', count: 3 }],
  })
  const p = useDutyArrangementPipeline(ctx, {})
  const assigned = p.fairFill(p.buildSlots())
  assert.deepEqual(assigned, ['id:16', 'id:7', 'id:46'])
})

// ============ ③ 已经存成 id 的值日表不能被当成空格 ============

test('当前值日表里是数字 id 时，基准排表要认出来（不能当空格重排）', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  // 两个槽位都排好了：16 号和 46 号。池子里故意多放一个 7 号（不在当前表里），
  // 并且排在池子最前面 —— 如果数字格被当成空格，补槽会按池子顺序填成 7 号 / 16 号，
  // 断言立刻红。（只用这两人做池子会假绿：补槽刚好补回原来两个人。）
  const ctx = makeCtx({
    pool: ['id:7', 'id:16', 'id:46'],
    ledger: {},
    baseCells: { 扫地: { 周一: [16, 46] } },
  })
  const p = useDutyArrangementPipeline(ctx, {})
  const slots = p.buildSlots()
  const assigned = p.buildBaseAssignment(slots)
  // 旧实现只认字符串，数字格被当成空的 → 补槽会把 7 号塞进来，把用户的安排覆盖掉
  assert.deepEqual(assigned, ['id:16', 'id:46'])
})

test('预览显示把 id 换回姓名（不显示数字）', async () => {
  const { useDutyArrangementPipeline } = await loadPipeline()
  const ctx = makeCtx({ pool: ['id:16'], ledger: {} })
  const p = useDutyArrangementPipeline(ctx, {})
  const rows = p.buildPreviewRows({ 扫地: { 周一: ['id:16', 'name:外人'] } })
  assert.equal(rows[0].cells[0].course, '张子涵')
  assert.equal(rows[1].cells[0].course, '外人')
})

// ============ ④ 确认写回的是格子值，不是内部 key ============

test('确认排表：写回数字 id / 姓名，不能把 id:16 这种内部 key 存进库里', async () => {
  const { useDutyArrangementOptions } = await loadOptions()
  const emitted = []
  const ctx = makeCtx({ pool: ['id:16'], ledger: {} })
  ctx.emit = (evt, payload) => emitted.push({ evt, payload })
  ctx.previewCells = { value: { 扫地: { 周一: ['id:16', 'name:外人'] } } }
  const opts = useDutyArrangementOptions(ctx, {})
  opts.confirm()
  assert.equal(emitted.length, 1)
  assert.deepEqual(emitted[0].payload.cells, { 扫地: { 周一: [16, '外人'] } },
    '内部 key 一旦写进库，下次读出来就成了名叫「id:16」的人')
})

test('保存草稿：同样转回格子值', async () => {
  const { useDutyArrangementOptions } = await loadOptions()
  const emitted = []
  const ctx = makeCtx({ pool: ['id:16'], ledger: {} })
  ctx.emit = (evt, payload) => emitted.push({ evt, payload })
  ctx.previewCells = { value: { 扫地: { 周一: ['id:46'] } } }
  ctx.conditions = { value: [] }
  const opts = useDutyArrangementOptions(ctx, {})
  opts.onSaveDraft()
  assert.deepEqual(emitted[0].payload.cells, { 扫地: { 周一: [46] } })
})
