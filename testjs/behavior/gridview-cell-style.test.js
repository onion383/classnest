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
const {
  analyze, walk: walkAst, keyName, memberPath,
} = require('../_source-scan.cjs')

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
  const blocks = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(s))) blocks.push(m[1])
  return blocks.join('\n')
}

function sourceOf(file) {
  const s = fs.readFileSync(file, 'utf8')
  return file.endsWith('.vue') ? scriptOf(s) : s
}

// 在 AST 上找出「带 _bg 的对象字面量」，并判断它是不是某个 extra 属性的直接值。
// 为什么不用 /extra\s*:\s*\{[^}]*_bg/：`[^}]*` 只跨一层花括号，extra 里再嵌对象
// （或 _bg 写成 `_bg: rgb(...)` 前面先有别的嵌套）就匹配不到 —— 漏报。
// 为什么豁免不再按「文件里出现 useSeatGrid 字样」整文件放行：
// 按真实引用关系判定 —— 只有包在 buildSeatLikeRows(...) / useSeatGrid(...) 实参范围里的
// extra._bg 才真的会被 `...(v.extra || {})` 摊平；同文件其它位置塞的 _bg 仍要报。
function styleCells(ast, code) {
  const flattenSpans = []
  walkAst(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const p = memberPath(node.callee)
    if (p === 'buildSeatLikeRows' || p === 'useSeatGrid') flattenSpans.push([node.start, node.end])
  })
  const inFlatten = (node) => flattenSpans.some(([a, b]) => node.start >= a && node.end <= b)

  const extraCells = []
  const topLevelCells = []
  walkAst(ast.program, (node, parents) => {
    if (node.type !== 'ObjectExpression') return
    const bg = node.properties.find((p) => p.type !== 'SpreadElement' && keyName(p.key) === '_bg')
    if (!bg) return
    const parent = parents[parents.length - 1]
    const isExtraValue = parent && parent.type === 'ObjectProperty'
      && parent.value === node && keyName(parent.key) === 'extra'
    const entry = { node, bg, line: code.slice(0, node.start).split('\n').length }
    if (isExtraValue) extraCells.push({ ...entry, flattened: inFlatten(node) })
    else topLevelCells.push(entry)
  })
  return { extraCells, topLevelCells }
}

test('约定：GridView 的 _bg/_fg 不许藏在 cell.extra 里（除非走 useSeatGrid 摊平）', () => {
  const bad = []
  for (const f of files) {
    const code = sourceOf(f)
    if (!code.trim()) continue
    const { ast } = analyze(code)
    for (const cell of styleCells(ast, code).extraCells) {
      if (!cell.flattened) {
        bad.push(`${rel(f)}:${cell.line}`)
        break
      }
    }
  }
  assert.deepEqual(bad, [],
    '以下文件把 GridView 格子配色塞进 cell.extra，但没走 useSeatGrid 摊平 → 颜色不生效：\n' + bad.join('\n'))
})

test('约定：直接写在 cell 顶层的 _bg 必须同时给 _fg（深底白字/浅底深字）', () => {
  const bad = []
  for (const f of files) {
    const code = sourceOf(f)
    if (!code.trim()) continue
    const { ast } = analyze(code)
    for (const cell of styleCells(ast, code).topLevelCells) {
      // 只看同一个对象字面量里是否也有 _fg；`cell._bg != null` 是读取，不是属性节点，天然排除。
      if (!cell.node.properties.some((p) => p.type !== 'SpreadElement' && keyName(p.key) === '_fg')) {
        bad.push(`${rel(f)}:${cell.line} 缺少 _fg`)
        break
      }
    }
  }
  assert.deepEqual(bad, [], '以下格子给了 _bg 但没给 _fg（深底上是黑字，看不清）：\n' + bad.join('\n'))
})
