// =========================================================================
// gridview-cell-style.test.js —— GridView 单元格配色的结构约定
//
// 运行：npm run test:behavior
//
// 背景（2026-11-05 实测踩坑）：
//   GridView 读格子配色只认 **cell 顶层**的 `_bg` / `_fg`
//   （`cell._bg != null ? 'cell-heat' : ''` + 内联 `--cell-heat-bg`）。
//   座位表把色值塞进 `cell.extra`，再由 useSeatGrid 的 `buildSeatLikeRows`
//   里的 `...(v.extra || {})` 摊平到顶层，所以能正常显示。
//   值日权重表自己拼 rows，没有摊平这一步 → 色值永远躺在 extra 里没人读，
//   表现就是「输入数字保存后格子不变色」。
//
// 约定：任何给 GridView 塞 `_bg` / `_fg` 的地方，
//   要么直接写在 cell 顶层，要么所在文件必须走 useSeatGrid 的摊平路径。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '../../student-frontend/src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|vue)$/.test(e.name)) out.push(p)
  }
  return out
}
const files = walk(SRC)
const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/')

function scriptOf(s) {
  return (s.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || ''
}
function stripComments(s) {
  return s.split('\n').map((l) => (/(^\s*\/\/)/.test(l) ? '' : l.replace(/\/\/.*$/, ''))).join('\n')
}

test('约定：GridView 的 _bg/_fg 不许藏在 cell.extra 里（除非走 useSeatGrid 摊平）', () => {
  const bad = []
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'))
    // 只看真正构造 extra 的地方：extra: { ... _bg ... }
    const usesExtraStyle = /extra\s*:\s*\{[^}]*_bg/.test(s)
    if (!usesExtraStyle) continue
    // 走 useSeatGrid 摊平路径的合法
    if (/useSeatGrid|buildSeatLikeRows/.test(s)) continue
    bad.push(rel(f))
  }
  assert.deepEqual(bad, [],
    '以下文件把 GridView 格子配色塞进 cell.extra，但没走 useSeatGrid 摊平 → 颜色不生效：\n' + bad.join('\n'))
})

// 找出源码里所有「对象字面量」的最内层内容（含嵌套花括号，如模板字符串里的 ${...}）。
// 用括号配对扫描，不能用 /\{[^{}]*\}/ —— 模板字符串 `rgb(${x})` 里有花括号，正则会漏。
function objectLiterals(src) {
  const out = []
  const stack = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') stack.push(i)
    else if (ch === '}') {
      const start = stack.pop()
      if (start !== undefined) out.push(src.slice(start + 1, i))
    }
  }
  return out
}

test('约定：直接写在 cell 顶层的 _bg 必须同时给 _fg（深底白字/浅底深字）', () => {
  const bad = []
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'))
    for (const o of objectLiterals(s)) {
      // 只看**赋值**写法：`_bg:`（带冒号）。`cell._bg != null` 是读取，不算。
      if (!/_bg\s*:/.test(o)) continue
      if (o.includes('extra')) continue // extra 内部另算
      if (!/_fg\s*:/.test(o)) { bad.push(`${rel(f)}: ${o.replace(/\s+/g, ' ').slice(0, 90)}`); break }
    }
  }
  assert.deepEqual(bad, [], '以下格子给了 _bg 但没给 _fg（深底上是黑字，看不清）：\n' + bad.join('\n'))
})
