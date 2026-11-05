// =========================================================================
// 值日权重表：同一项目多子行的「联动」
//
// 背景：权重表按项目的人数拆成多行（倒垃圾 3 人 → 3 行），但底层数据是
//   {项目: {星期: 权重}} —— 一个项目只有一个权重值。
// GridView 编辑时只替换被编辑的那一格，其余子行仍是旧值，
// 所以保存时不能只读首个子行（改了第 2/3 行会被丢掉 → 「改动一格保存不了」）。
//
// 判据：
//   1. 改第 2/3 子行 → 整个项目的权重一起变（联动生效）
//   2. 改第 1 子行 → 同样生效
//   3. 没改动的子行不产生「误判为已编辑」
//   4. 一维（单列）：改任意子行 → 该项目所有天都取这个值
//   5. 越界/空值/非数字的容错
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadMod = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/utils/dutyWeightGroups.js',
)).href)

// ESM 模块异步加载：CJS 测试文件里不能用顶层 await，改成测试内 await 同一个 promise
const modPromise = loadMod()

const DAYS = ['周一', '周二', '周三']

// 造 GridView 编辑后的 rows：同项目的 n 个子行，只有一行的那一格被改了。
// values 是该项目的「改动前的显示值」（每个子行都一样）。
const DEFAULT_VALUES = { 周一: 0.5, 周二: 0.6, 周三: 0.7 }
function makeGroups({ name = '倒垃圾', n = 3, days = DAYS, values = DEFAULT_VALUES, editRow = 1, editDay = 0, editText = '0.9' }) {
  const rows = []
  for (let k = 0; k < n; k++) {
    const cells = days.map((d, i) => {
      const v = values[d]
      const text = (k === editRow && i === editDay) ? editText : (v == null ? '' : String(v))
      return { course: text }
    })
    rows.push(cells)
  }
  return { [name]: rows }
}

test('联动：改第 2 个子行 → 整个项目的权重都变成新值', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.7 } }
  const groups = makeGroups({ editRow: 1, editDay: 0, editText: '0.9' })
  const next = resolveWeightGroups({ groups, prevWeights: prev, days: DAYS, weekdayWeighted: true })
  assert.deepEqual(next, { 倒垃圾: { 周一: 0.9, 周二: 0.6, 周三: 0.7 } },
    '改第 2 子行的周一 → 周一变成 0.9，其余天不动')
})

test('联动：改第 3 个子行 → 同样生效（不只首个子行生效）', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.7 } }
  const groups = makeGroups({ editRow: 2, editDay: 2, editText: '0.2' })
  const next = resolveWeightGroups({ groups, prevWeights: prev, days: DAYS, weekdayWeighted: true })
  assert.deepEqual(next, { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.2 } })
})

test('联动：改第 1 个子行 → 同样生效', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.7 } }
  const groups = makeGroups({ editRow: 0, editDay: 1, editText: '0.3' })
  const next = resolveWeightGroups({ groups, prevWeights: prev, days: DAYS, weekdayWeighted: true })
  assert.deepEqual(next, { 倒垃圾: { 周一: 0.5, 周二: 0.3, 周三: 0.7 } })
})

test('联动：没改动的子行不会被误判成编辑（值原样保留）', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.7 } }
  // 三个子行完全一致（都没改）→ 结果应等于 prev
  const groups = makeGroups({ editRow: -1, editDay: -1 })
  const next = resolveWeightGroups({ groups, prevWeights: prev, days: DAYS, weekdayWeighted: true })
  assert.deepEqual(next, { 倒垃圾: { 周一: 0.5, 周二: 0.6, 周三: 0.7 } })
})

test('联动：一维（单列）→ 改任意子行，该项目所有天都取这个值', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.5, 周三: 0.5 } }
  const groups = makeGroups({ n: 3, editRow: 2, editDay: 0, editText: '0.8' })
  const next = resolveWeightGroups({
    groups, prevWeights: prev, days: DAYS, weekdayWeighted: false,
    avgOf: () => 0.5,
  })
  assert.deepEqual(next, { 倒垃圾: { 周一: 0.8, 周二: 0.8, 周三: 0.8 } })
})

test('容错：空值 / 非数字 → 0；越界 → 夹到 [0,1]', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  const prev = { 倒垃圾: { 周一: 0.5, 周二: 0.5, 周三: 0.5 } }
  const groups = makeGroups({ editRow: 0, editDay: 0, editText: 'abc' })
  const next = resolveWeightGroups({ groups, prevWeights: prev, days: DAYS, weekdayWeighted: true })
  assert.equal(next.倒垃圾.周一, 0, '非数字 → 0')

  const groups2 = makeGroups({ editRow: 0, editDay: 0, editText: '5' })
  const next2 = resolveWeightGroups({ groups: groups2, prevWeights: prev, days: DAYS, weekdayWeighted: true, min: 0, max: 1 })
  assert.equal(next2.倒垃圾.周一, 1, '越界上 → 夹到 1')

  const groups3 = makeGroups({ editRow: 0, editDay: 0, editText: '-3' })
  const next3 = resolveWeightGroups({ groups: groups3, prevWeights: prev, days: DAYS, weekdayWeighted: true, min: 0, max: 1 })
  assert.equal(next3.倒垃圾.周一, 0, '越界下 → 夹到 0')
})

test('纯函数：pickEditedText 挑出与旧值不同的那一格', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  assert.equal(pickEditedText(['0.5', '0.9', '0.5'], '0.5'), '0.9')
  assert.equal(pickEditedText(['0.5', '0.5', '0.5'], '0.5'), '0.5', '全同 → 沿用旧值')
  assert.equal(pickEditedText(['', '0.9', ''], ''), '0.9')
})

test('纯函数：parseWeightText 容错', async () => {
  const { resolveWeightGroups, pickEditedText, parseWeightText } = await modPromise
  assert.equal(parseWeightText('0.7'), 0.7)
  assert.equal(parseWeightText(''), 0)
  assert.equal(parseWeightText(null), 0)
  assert.equal(parseWeightText('abc'), 0)
  assert.equal(parseWeightText('2', 0, 1), 1)
})
