// =========================================================================
// app-select-esc.test.js —— A5-05：Esc 让位协议（弹窗不被弹层连带关闭）
//
// 根因不是「AppSelect 少写了一个 .prevent」，而是：
//   Esc 的让位协议只有消费端（DialogShell 看 e.defaultPrevented）实现，
//   生产端每个弹层各自手写「拦不拦、什么时候拦」——漏了就连带关父弹窗，
//   无条件 .prevent 又会让「弹层收起时 Esc 关不掉父弹窗」。
//
// 修法（根治）：弹窗与弹层共用同一个 Esc 层栈，生产端统一走 consumeEscape()：
//   打开且自己是栈顶 → 消费（preventDefault + stopPropagation）
//   收起 / 不是栈顶   → 完全放行
// 本用例同时守住 AppSelect、AppHelp、表头筛选面板三个已迁移的生产端。
// =========================================================================

const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const APP_SELECT = 'student-frontend/src/components/base/AppSelect.vue'
const APP_HELP = 'student-frontend/src/components/base/AppHelp.vue'
const DYNAMIC_TABLE = 'student-frontend/src/components/tables/DynamicTable/DynamicTable.vue'
const STACK_SRC = abs('student-frontend/src/utils/dialogStack.js')


// 每个用例一份全新栈实例（模块缓存会跨用例共享，必须带序号）
let seq = 0
function loadStack() {
  seq += 1
  return import(pathToFileURL(STACK_SRC).href + '?case=' + seq)
}

function makeEscEvent() {
  return {
    key: 'Escape',
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
}

// 不复刻 DialogShell 的关闭判据（T04-02）：副本会与源码漂移。改为对源码逐条对账 +
// 行为断言只检验「协议状态」（栈顶、defaultPrevented），不冒充父弹窗实现。
const DIALOG_SHELL = 'student-frontend/src/components/base/DialogShell.vue'

function dialogShellSrc() {
  return read(DIALOG_SHELL)
}

test('[静态] DialogShell 的 Esc 关闭判据四条齐全（T04-02）', () => {
  const src = dialogShellSrc()
  assert.match(src, /if \(!props\.visible\) return/, '未打开时不得响应')
  assert.match(src, /if \(e\.key !== 'Escape'\) return/, '只处理 Escape')
  assert.match(src, /if \(!isTopDialog\(self\)\) return/, '不是栈顶不得关闭')
  assert.match(src, /if \(e\.defaultPrevented\) return/, '内层已消费则不得关闭')
})

test('[静态] AppSelect 的 Esc 由弹层自己接管，不再裸绑触发器', () => {
  const src = read(APP_SELECT)
  assert.ok(
    !/@keydown\.escape/.test(src),
    'Esc 只绑触发器会漏（焦点离开按钮就收不掉菜单），也会冒泡到 DialogShell',
  )
  assert.match(src, /consumeEscape\(e, \{ open: open\.value, self: escLayer \}\)/)
  // 注册方式两种都收：裸 addEventListener 或经 disposables 的 d.listen。
  // 这里的不变量是「展开时把 keydown 挂到 document 上」，不是用哪种 API。
  assert.match(
    src,
    /(document\.addEventListener\('keydown', onDocKeydown\)|d\.listen\(document, 'keydown', onDocKeydown\))/,
  )
  // 打开时要进栈，否则 DialogShell 不知道下拉是最上层
  assert.match(src, /watch\(open,[\s\S]{0,240}?pushEscLayer\(escLayer\)/)
  assert.match(src, /removeEscLayer\(escLayer\)/)
  // KeepAlive 切走不会 unmount：必须收起菜单，否则 Esc 层会永久留在全局栈里
  assert.match(src, /onDeactivated\(\(\) => \{[\s\S]{0,160}?open\.value = false/)
})

test('[静态] 同族弹层（AppHelp / 表头筛选）复用同一协议', () => {
  assert.match(read(APP_HELP), /consumeEscape\(e, \{ open: open\.value \}\)/)
  assert.match(
    read(DYNAMIC_TABLE),
    /consumeEscape\(e, \{ open: !!ctx\.filterField\.value, self: filterEscLayer \}\)/,
  )
  assert.match(read(DYNAMIC_TABLE), /pushEscLayer\(filterEscLayer\)/)
  assert.match(
    read(DYNAMIC_TABLE),
    /onDeactivated\(\(\) => \{[\s\S]{0,200}?removeEscLayer\(filterEscLayer\)/,
    'KeepAlive 切走必须把筛选面板的 Esc 层出栈',
  )
})

test('[行为] 菜单展开：弹层是栈顶 → 消费 Esc，父弹窗不关', async () => {
  const s = await loadStack()
  const dialog = {}
  const select = {}
  s.pushDialog(dialog)
  s.pushEscLayer(select)

  const e = makeEscEvent()
  const handled = s.consumeEscape(e, { open: true, self: select })

  assert.strictEqual(handled, true, '弹层应消费本次 Esc')
  assert.strictEqual(e.defaultPrevented, true, '必须 preventDefault')
  assert.strictEqual(e.propagationStopped, true, '必须 stopPropagation')
  // 协议语义：defaultPrevented 已置位 → DialogShell 的 `if (e.defaultPrevented) return` 会放行
  assert.strictEqual(e.defaultPrevented, true, '父弹窗依据 defaultPrevented 判据应保持打开')
})

test('[行为] 菜单收起：不消费 Esc，父弹窗照常关闭', async () => {
  const s = await loadStack()
  const dialog = {}
  const select = {}
  s.pushDialog(dialog)

  const e = makeEscEvent()
  const handled = s.consumeEscape(e, { open: false, self: select })

  assert.strictEqual(handled, false, '收起态不能消费 Esc')
  assert.strictEqual(e.defaultPrevented, false, '不能吞掉默认行为')
  assert.strictEqual(e.propagationStopped, false, '不能阻止冒泡')
  assert.strictEqual(s.isTopDialog(dialog), true, '父弹窗仍是栈顶，可照常关闭')
})

test('[行为] 有更内层弹层时，外层不抢 Esc', async () => {
  const s = await loadStack()
  const outer = {}
  const inner = {}
  s.pushEscLayer(outer)
  s.pushEscLayer(inner)

  const e = makeEscEvent()
  assert.strictEqual(s.consumeEscape(e, { open: true, self: outer }), false, '外层不是栈顶')
  assert.strictEqual(e.defaultPrevented, false, '事件要完整留给栈顶')
  assert.strictEqual(s.consumeEscape(e, { open: true, self: inner }), true, '栈顶才消费')
})

test('[行为] 非 Esc 键完全不干预', async () => {
  const s = await loadStack()
  const e = makeEscEvent()
  e.key = 'Enter'
  assert.strictEqual(s.consumeEscape(e, { open: true }), false)
  assert.strictEqual(e.defaultPrevented, false)
})

test('[行为] 同一次 Esc 只能被消费一次（多个 document 监听不连环关闭）', async () => {
  const s = await loadStack()
  const e = makeEscEvent()
  assert.strictEqual(s.consumeEscape(e, { open: true }), true)
  assert.strictEqual(s.consumeEscape(e, { open: true }), false, '后到的监听器必须放行')
})
