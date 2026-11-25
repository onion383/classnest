// =========================================================================
// widget-capture.test.js —— 浮窗截屏必须「自己先藏好」
//
// 回归 B12-11：便签窗口的注释背景里出现了它自己那张「加载中」卡片。
// 成因不是忘了隐藏，而是**隐藏方式对这类窗口无效**：
//   工具箱浮窗是 `transparent: true`（main.widget.js），Windows 上 setOpacity
//   对透明窗口不生效 —— 主进程的 hideWidget（setOpacity(0) + 等 150ms）等于没做。
// Screenshot.vue 早先就发现了这点，改成「自己把内容 visibility:hidden + 传 hideWidget:false」，
// 但 Note.vue 还在走那条无效的路。
//
// 这条判据锁的是「所有浮窗截屏调用方都用同一套自隐藏」，因为：
//   · 这类判据测不了画面（要真起 Electron 抓屏），只能锁调用形态；
//   · 将来再加第三个浮窗截屏入口时，它会因为「没走 captureHide」直接变红。
// 运行：npm run test:units
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  analyze, walk, keyName, memberPath, findFunction, scriptBlocks,
} = require('#testjs/source-scan')

const WIDGET_DIR = abs('student-frontend/src/subwindows/widget')

// 去注释：本文件的修复注释里就写着旧写法，不去注释会命中自己的说明文字
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const read = (rel) => stripComments(fs.readFileSync(abs(rel), 'utf8'))

// 调用名：hideForCapture() 或 captureHide.hideForCapture()
function calleeName(callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed) return keyName(callee.property)
  return null
}

test('captureHide.js 是「藏/还原」的唯一实现', () => {
  const src = fs.readFileSync(abs('student-frontend/src/subwindows/widget/captureHide.js'), 'utf8')
  // 为什么用 AST 而不是 /style\.visibility\s*=\s*'hidden'/g 计数：
  // 这条判据要守「整个文件只有一处隐藏、一处还原」，正则只认单引号，改成双引号就算 0 处（假红），
  // 而字符串注释里的同句又会算进去（旧的 stripComments 挡不住模板串）。
  const { ast } = analyze(src)
  const hideFn = findFunction(ast, 'hideForCapture')
  const restoreFn = findFunction(ast, 'restoreAfterCapture')
  assert.ok(hideFn, '应有 hideForCapture')
  assert.ok(restoreFn, '应有 restoreAfterCapture')

  const hideSets = []
  const restoreSets = []
  walk(ast.program, (node) => {
    if (node.type !== 'AssignmentExpression' || !node.right || node.right.type !== 'StringLiteral') return
    if (memberPath(node.left) !== 'document.documentElement.style.visibility') return
    if (node.right.value === 'hidden') hideSets.push(node)
    else if (node.right.value === '') restoreSets.push(node)
  })
  assert.equal(hideSets.length, 1, 'captureHide 里应当只有一处隐藏')
  assert.equal(restoreSets.length, 1, 'captureHide 里应当只有一处还原')
  assert.ok(hideSets[0].start >= hideFn.start && hideSets[0].end <= hideFn.end, '隐藏应写在 hideForCapture 里')
  assert.ok(restoreSets[0].start >= restoreFn.start && restoreSets[0].end <= restoreFn.end, '还原应写在 restoreAfterCapture 里')

  // 必须等两帧再返回（合成器提交 + DWM 更新）：外层 rAF 的回调里再调一次 rAF。
  let doubleRaf = false
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression' || calleeName(node.callee) !== 'requestAnimationFrame') return
    const cb = node.arguments[0]
    if (!cb || !cb.body) return
    walk(cb.body, (inner) => {
      if (inner.type === 'CallExpression' && calleeName(inner.callee) === 'requestAnimationFrame') doubleRaf = true
    })
  })
  assert.ok(doubleRaf, '必须等两帧再返回（合成器提交 + DWM 更新）')
})

test('浮窗里所有截屏调用方都自己藏、并传 hideWidget:false', () => {
  const files = fs.readdirSync(WIDGET_DIR).filter((f) => f.endsWith('.vue'))
  // 「调用方」= 真的引用了 INVOKE.SCREENSHOT_CAPTURE（AST MemberExpression），
  // 不是文件里出现过这个字符串 —— 注释掉的旧截屏代码、日志文案都不会再被误算。
  const callers = []
  const parsed = new Map()
  for (const f of files) {
    const src = fs.readFileSync(path.join(WIDGET_DIR, f), 'utf8')
    const { ast } = analyze(scriptBlocks(src))
    let isCaller = false
    walk(ast.program, (node) => {
      if (memberPath(node) === 'INVOKE.SCREENSHOT_CAPTURE') isCaller = true
    })
    if (isCaller) {
      callers.push(f)
      parsed.set(f, ast)
    }
  }
  assert.ok(callers.length >= 2, `应至少有便签与一键截屏两个调用方，实际：${callers.join(',')}`)
  for (const f of callers) {
    const ast = parsed.get(f)
    // 从 captureHide.js 具名引入 hideForCapture / restoreAfterCapture
    let importDecl = null
    walk(ast.program, (node) => {
      if (node.type === 'ImportDeclaration' && node.source.value === './captureHide.js') importDecl = node
    })
    assert.ok(importDecl, `${f} 必须从 captureHide.js 引入隐藏逻辑`)
    const imported = new Set(importDecl.specifiers
      .filter((s) => s.type === 'ImportSpecifier')
      .map((s) => (s.imported.name || s.imported.value)))
    assert.ok(imported.has('hideForCapture'), `${f} 必须引入 hideForCapture`)
    assert.ok(imported.has('restoreAfterCapture'), `${f} 必须引入 restoreAfterCapture`)

    const called = new Set()
    walk(ast.program, (node) => {
      if (node.type === 'CallExpression') {
        const name = calleeName(node.callee)
        if (name) called.add(name)
      }
    })
    assert.ok(called.has('hideForCapture'), `${f} 抓屏前没隐藏自己`)
    assert.ok(called.has('restoreAfterCapture'), `${f} 抓屏后没恢复显示（失败时窗口会一直隐身）`)

    // SCREENSHOT_CAPTURE 的选项对象必须显式 hideWidget:false
    let captureCall = null
    walk(ast.program, (node) => {
      if (node.type !== 'CallExpression') return
      if (node.arguments.some((a) => memberPath(a) === 'INVOKE.SCREENSHOT_CAPTURE')) captureCall = node
    })
    assert.ok(captureCall, `${f} 找不到 SCREENSHOT_CAPTURE 调用`)
    const opts = captureCall.arguments.find((a) => a.type === 'ObjectExpression')
    const hideWidget = opts && opts.properties.find(
      (p) => p.type === 'ObjectProperty' && keyName(p.key) === 'hideWidget',
    )
    assert.ok(hideWidget && hideWidget.value.type === 'BooleanLiteral' && hideWidget.value.value === false,
      `${f} 应传 hideWidget:false —— 主进程那段对透明窗口无效，白等 150ms`)

    // 不许自己再写一份 visibility 操作（否则「唯一实现」立刻失效）
    let ownVisibility = false
    walk(ast.program, (node) => {
      if (node.type === 'MemberExpression' && memberPath(node) === 'document.documentElement.style.visibility') {
        ownVisibility = true
      }
    })
    assert.ok(!ownVisibility, `${f} 不要自己操作 visibility，改用 captureHide.js`)
  }
})

test('主进程注释里说明了「setOpacity 对 transparent 窗口无效」这条坑', () => {
  // 判据看着"只是注释"，但它守的是一件事：以后有人想删掉 hideWidget 或反过来
  // 让渲染层别再自己藏，必须先看到这段原因。没有这段说明，注释一删，坑就重现。
  const raw = fs.readFileSync(abs('electron/main/main.dialogs.js'), 'utf8')
  assert.match(raw, /transparent[^\n]*setOpacity[^\n]*不生效|setOpacity[^\n]*对透明窗口不生效/,
    'main.dialogs.js 缺少「setOpacity 对透明窗口不生效」的说明')
})
