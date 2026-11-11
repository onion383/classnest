// =========================================================================
// context-menu-exclusive.test.js —— 右键菜单互斥（同时只出现一个）
// 运行：npm run test:units
//
// 为什么登记在模块级：座位页的行标签菜单和列头菜单是**两个组件实例**，
// 各自只有自己的 visible，看不见对方。放在组件里逐个改调用方必然漏网
// （SeatView 两个 + ClassroomView + FeeManagement 共四处）。
//
// 判据分两类：
//   1. 运行时：直接 import registry，验证「新开一个 → 上一个被关」及边界
//   2. 接线：组件真的登记了，且四个使用点都绑了 @close ——
//      少一个 @close，前一个菜单就收不起来，而 registry 单测照样全绿（假绿）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const REG = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/contextMenuRegistry.js')).href
const MENU = path.join(ROOT, 'student-frontend/src/components/base/ContextMenu.vue')
const USES = [
  'student-frontend/src/views/SeatView.vue',
  'student-frontend/src/views/ClassroomView.vue',
  'student-frontend/src/views/FeeManagement.vue',
]

// ---------------- 运行时：登记表语义 ----------------
test('打开第二个菜单 → 第一个被关闭一次', async () => {
  const { claimContextMenu, resetContextMenuRegistry } = await import(REG)
  resetContextMenuRegistry()
  const calls = []
  const a = Symbol('a'), b = Symbol('b')
  claimContextMenu(a, () => calls.push('a'))
  claimContextMenu(b, () => calls.push('b'))
  assert.deepEqual(calls, ['a'], '只关上一个，不能把新菜单自己也关掉')
})

test('同一个实例在别处重新定位不关自己（visible 已是 true 时又右键别处）', async () => {
  const { claimContextMenu, resetContextMenuRegistry } = await import(REG)
  resetContextMenuRegistry()
  const calls = []
  const a = Symbol('a')
  claimContextMenu(a, () => calls.push('a'))
  claimContextMenu(a, () => calls.push('a'))
  assert.deepEqual(calls, [], '同一个菜单换个坐标不算「两个菜单」')
})

test('连续打开三个：只关紧邻的前一个', async () => {
  const { claimContextMenu, resetContextMenuRegistry } = await import(REG)
  resetContextMenuRegistry()
  const calls = []
  for (const k of ['a', 'b', 'c']) claimContextMenu(Symbol(k), () => calls.push(k))
  assert.deepEqual(calls, ['a', 'b'])
})

test('release 只在自己仍是当前菜单时清空，不能把新菜单的登记一起清掉', async () => {
  const { claimContextMenu, resetContextMenuRegistry } = await import(REG)
  resetContextMenuRegistry()
  const calls = []
  const a = Symbol('a'), b = Symbol('b'), c = Symbol('c')
  const releaseA = claimContextMenu(a, () => calls.push('a'))
  claimContextMenu(b, () => calls.push('b'))
  releaseA() // 旧菜单的离场/清理晚于新菜单登记是正常时序
  claimContextMenu(c, () => calls.push('c'))
  assert.deepEqual(calls, ['a', 'b'], 'releaseA 不应该把 b 的登记清掉')
})

test('当前菜单主动关闭后，再开新菜单不会误关任何东西', async () => {
  const { claimContextMenu, resetContextMenuRegistry } = await import(REG)
  resetContextMenuRegistry()
  const calls = []
  const releaseA = claimContextMenu(Symbol('a'), () => calls.push('a'))
  releaseA()
  claimContextMenu(Symbol('b'), () => calls.push('b'))
  assert.deepEqual(calls, [])
})

// ---------------- 接线：组件 + 四个使用点 ----------------
test('ContextMenu 打开时登记、关闭/卸载时释放、closeSelf 走 emit(close)', () => {
  const src = fs.readFileSync(MENU, 'utf8')
  assert.match(src, /from '\.\.\/\.\.\/utils\/contextMenuRegistry\.js'/, '必须引用登记表')
  assert.match(src, /releaseMenu = claimContextMenu\(menuToken, closeSelf\)/, '打开时要登记')
  assert.match(src, /function closeSelf\(\) \{\s*if \(props\.visible\) emit\('close'\)/,
    '关的是「受控组件的 close 事件」，不是组件自己改 props')
  // 打开分支要在 measured 重置之前；关闭分支与卸载都要释放。
  // 注意 onBeforeUnmount 第一次出现在 **import 行**，锚点必须带 '(' 并从 watch 之后找，
  // 否则 slice 得到空串、判据假红。
  const watchAt = src.indexOf('watch(() => props.visible')
  const unmountAt = src.indexOf('onBeforeUnmount(', watchAt)
  const body = src.slice(watchAt, unmountAt)
  const closeAt = body.indexOf('if (!v) {')
  const retAt = body.indexOf('    return;', closeAt)
  assert.match(body.slice(closeAt, retAt), /releaseSelf\(\)/, '关闭分支要释放登记')
  assert.ok((src.match(/releaseSelf\(\)/g) || []).length >= 3, '定义 + 关闭 + 卸载')
  assert.match(src.slice(unmountAt), /releaseSelf\(\)/, '卸载时也要释放')
})

test('四个使用点都绑定 @close（少一个，前一个菜单就收不起来）', () => {
  let total = 0
  for (const f of USES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    const blocks = src.match(/<ContextMenu[\s\S]*?\/>/g) || []
    assert.ok(blocks.length > 0, `${f} 里没找到 ContextMenu`)
    for (const b of blocks) {
      assert.match(b, /@close=/, `${f} 的 ContextMenu 必须绑定 @close`)
      total++
    }
  }
  assert.equal(total, 4, 'SeatView 两个 + ClassroomView 一个 + FeeManagement 一个')
})
