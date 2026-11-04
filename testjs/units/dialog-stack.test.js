// =========================================================================
// dialog-stack.test.js —— 弹窗层级栈（V5-003）正反用例
//
// 报告 V5-003 的根因：openStack 写在 DialogShell 的 <script setup> 里，
// 每个实例各有一份，嵌套弹窗的 Esc 层级判断失效（外层被一起关掉）。
// 抽成模块级后必须保证：
//   正常：单层 / 两层 / 三层都只有栈顶响应
//   正常：关闭栈顶后次顶层接管；重复 push 幂等
//   异常：remove 不存在项不报错、不破坏其余层级；空栈时无人响应
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..')
const STACK_SRC = path.join(ROOT, 'student-frontend/src/utils/dialogStack.js')

let seq = 0
async function loadStack() {
  // 每个用例一份全新模块实例：用自增序号而不是 Date.now()，避免同毫秒取到同一个缓存
  seq += 1
  return import(pathToFileURL(STACK_SRC).href + '?case=' + seq)
}

test('单层：唯一弹窗就是栈顶', async () => {
  const s = await loadStack()
  const a = {}
  s.pushDialog(a)
  assert.strictEqual(s.isTopDialog(a), true)
  assert.strictEqual(s._stackSize(), 1)
})

test('两层：后打开的是栈顶，外层不响应 Esc', async () => {
  const s = await loadStack()
  const outer = {}
  const inner = {}
  s.pushDialog(outer)
  s.pushDialog(inner)
  assert.strictEqual(s.isTopDialog(outer), false, '外层不能响应（否则 Esc 会关掉两层）')
  assert.strictEqual(s.isTopDialog(inner), true)
  assert.strictEqual(s._stackSize(), 2)
})

test('关闭栈顶后次顶层接管', async () => {
  const s = await loadStack()
  const outer = {}
  const inner = {}
  s.pushDialog(outer)
  s.pushDialog(inner)
  s.removeDialog(inner)
  assert.strictEqual(s.isTopDialog(outer), true)
  assert.strictEqual(s._stackSize(), 1)
})

test('三层：只有最上层响应，乱序移除不破坏顺序', async () => {
  const s = await loadStack()
  const a = {}, b = {}, c = {}
  s.pushDialog(a); s.pushDialog(b); s.pushDialog(c)
  assert.strictEqual(s.isTopDialog(c), true)
  assert.strictEqual(s.isTopDialog(b), false)
  assert.strictEqual(s.isTopDialog(a), false)
  // 中间层提前关闭（Esc 被内层控件消费后又点了遮罩），不应影响顶层
  s.removeDialog(b)
  assert.strictEqual(s.isTopDialog(c), true)
  assert.strictEqual(s._stackSize(), 2)
  s.removeDialog(c)
  assert.strictEqual(s.isTopDialog(a), true)
})

test('重复 push 幂等：visible 反复切换不会把同一实例压两次', async () => {
  const s = await loadStack()
  const a = {}
  s.pushDialog(a); s.pushDialog(a); s.pushDialog(a)
  assert.strictEqual(s._stackSize(), 1)
})

test('异常输入：移除不存在的实例不报错、不影响现有层级', async () => {
  const s = await loadStack()
  const a = {}
  s.pushDialog(a)
  assert.doesNotThrow(() => s.removeDialog({}))
  assert.strictEqual(s._stackSize(), 1)
  assert.strictEqual(s.isTopDialog(a), true)
})

test('空栈：任何实例都不响应', async () => {
  const s = await loadStack()
  assert.strictEqual(s.isTopDialog({}), false)
  assert.strictEqual(s._stackSize(), 0)
})
