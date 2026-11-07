// =========================================================================
// duty-index.test.js —— 值日指数累加单源化 + 刷新口径同步
// 运行：npm run test:units
//
// 背景：展示用的「值日指数」与排表用的「公平账本」曾是两份逐字相同的手写累加，
// 只有结算区间 to 不同；refreshDutyIndex 又只刷前者，界面数字与排表依据会分叉。
// 判据：
//   1. 语义：逐日 / 逐项目 / 逐格累加，非数字权重与空姓名跳过
//   2. 单源：DutyView.vue 里 accumulateDutyIndex( 调用点必须 >= 2（防只改一处）
//   3. 同步：refreshDutyIndex 必须同时重取权重 / 展示账本 / 排表账本
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC = path.join(__dirname, '../../student-frontend/src')
const loadIndex = () => import(pathToFileURL(path.join(SRC, 'utils/dutyIndex.js')).href)
const VIEW = path.join(SRC, 'views/DutyView.vue')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const DAILY = [
  { snap_date: '2026-11-02', cells: { 扫地: { 周一: ['张三', '李四'] }, 拖地: { 周一: ['张三'] } } },
  { snap_date: '2026-11-03', cells: { 扫地: { 周二: ['张三'] } } },
]
const W = { 扫地: { 周一: 2, 周二: 5 }, 拖地: { 周一: 3 } }

test('累加 · 逐日逐项目逐格把权重记到人名下', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  assert.deepEqual(accumulateDutyIndex(DAILY, W), { 张三: 10, 李四: 2 })
})

test('累加 · 非数字 / 缺失权重整格跳过，不产生脏值', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const weights = { 扫地: { 周一: '2', 周二: 5 }, 拖地: { 周一: 3 } }
  const out = accumulateDutyIndex(DAILY, weights)
  assert.deepEqual(out, { 张三: 8 }, '周一扫地权重不是数字，整格跳过')
  assert.ok(!Object.values(out).some(v => typeof v !== 'number' || Number.isNaN(v)))
})

test('累加 · 空姓名与非数组名单跳过且不抛错', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const daily = [{ cells: { 扫地: { 周一: ['张三', '', null, undefined] }, 拖地: { 周二: 'oops' } } }]
  assert.deepEqual(accumulateDutyIndex(daily, { 扫地: { 周一: 2 }, 拖地: { 周二: 4 } }), { 张三: 2 })
})

test('累加 · 空输入安全，且每次返回新对象（无共享可变状态）', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  assert.deepEqual(accumulateDutyIndex([], W), {})
  assert.deepEqual(accumulateDutyIndex(null, null), {})
  assert.deepEqual(accumulateDutyIndex([null, {}, { cells: null }], W), {})
  const a = accumulateDutyIndex(DAILY, W)
  const b = accumulateDutyIndex(DAILY, W)
  assert.deepEqual(a, b)
  assert.notEqual(a, b)
})

test('单源 · DutyView 两个消费者都调用 accumulateDutyIndex，手写累加已清除', async () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'))
  const calls = (code.match(/accumulateDutyIndex\(/g) || []).length
  assert.ok(calls >= 2, `展示与排表两处都必须调用单源函数，实际 ${calls} 处`)
  assert.ok(!code.includes('(acc[name] || 0) + w'), '展示侧手写累加应已删除')
  assert.ok(!code.includes('(led[name] || 0) + w'), '账本侧手写累加应已删除')
})

test('同步 · refreshDutyIndex 必须连排表账本一起重取', async () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'))
  const fn = code.match(/async function refreshDutyIndex\(\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'refreshDutyIndex 应可解析')
  assert.ok(fn[0].includes('loadWeight()'), '权重')
  assert.ok(fn[0].includes('loadDutyIndex()'), '展示用逐日账本')
  assert.ok(fn[0].includes('loadDutyLedger()'), '排表用账本')
})
