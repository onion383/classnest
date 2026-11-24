// =========================================================================
// _source-scan.cjs —— 测试用源码解析工具（真实 AST，替代「正则 + 固定字符窗口」）
//
// 为什么不用正则/字符切片：
//   · 正则绑定空格、缩进、引号写法，源码一格式化就假红；
//   · 非贪婪 /\{([\s\S]*?)\}/ 遇到嵌套对象/函数体里的逗号会提前截断 —— 漏报；
//   · 固定窗口 slice(i, i + 900) 在重构（加一行注释）后切不到目标节点 —— 假红或空断言。
// 这里用 @babel/parser 解析出真实 AST，按节点范围取文本；AST 天然不受空格/缩进影响，
// 花括号/字符串/模板串的边界由解析器保证。
//
// 定位方式：require @vue/compiler-sfc 的方式（见 tools/template-binding-audit.mjs）——
// 从 student-frontend/node_modules 解析，保证与源码同一份解析器。
// =========================================================================
const path = require('node:path')

const FRONTEND = path.resolve(__dirname, '..', 'student-frontend')
const parser = require(require.resolve('@babel/parser', { paths: [FRONTEND] }))

const PARSE_OPTS = {
  // unambiguous：前端是 ESM、electron/backend 是 CJS，同一套选项都能解析
  sourceType: 'unambiguous',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  errorRecovery: false,
  plugins: ['topLevelAwait', 'jsx', 'importAssertions'],
}

function parse(code) {
  return parser.parse(code, PARSE_OPTS)
}

/** 遍历 AST。visit(node, parents)；parents 是祖先数组（最近的在末尾）。 */
function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents)
    return
  }
  if (typeof node.type !== 'string') return
  visit(node, parents)
  const next = parents.concat(node)
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'extra' || key === 'tokens') continue
    if (key === 'comments' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    walk(node[key], visit, next)
  }
}

/** 把若干 [start, end) 区段替换成空格（保留换行），长度不变 —— 便于用同下标继续切片。 */
function maskRanges(src, ranges) {
  const chars = src.split('')
  for (const [from, to] of ranges) {
    for (let i = Math.max(0, from); i < Math.min(src.length, to); i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

function keyName(key) {
  if (!key) return null
  if (key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  if (key.type === 'NumericLiteral') return String(key.value)
  return null
}

/** MemberExpression 的静态路径：props.colHeaders / localDays.value.includes / undoStore.foo */
function memberPath(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type !== 'MemberExpression') return null
  if (node.computed) return null
  const obj = memberPath(node.object)
  const prop = keyName(node.property)
  return obj && prop ? `${obj}.${prop}` : null
}

/**
 * 解析源码并返回两种「屏蔽视图」：
 *   code          —— 注释替换为空格（字符串保留）：需要匹配字符串字面量时用
 *   codeNoStrings —— 注释与字符串都替换为空格：判断「代码里有没有某调用/标识符」时用
 * 两者与原源码等长，可继续按 AST 节点的 start/end 切片。
 */
function analyze(src) {
  const ast = parse(src)
  const literalRanges = []
  walk(ast.program, (node) => {
    if (node.type === 'StringLiteral' || node.type === 'RegExpLiteral' || node.type === 'DirectiveLiteral') {
      literalRanges.push([node.start, node.end])
    } else if (node.type === 'TemplateElement') {
      // 只屏蔽模板文本（quasi），`${...}` 里的表达式仍是真实代码
      literalRanges.push([node.start, node.end])
    }
  })
  const commentRanges = (ast.comments || []).map((c) => [c.start, c.end])
  return {
    ast,
    comments: ast.comments || [],
    code: maskRanges(src, commentRanges),
    codeNoStrings: maskRanges(src, commentRanges.concat(literalRanges)),
  }
}

function functionName(node, parents) {
  if (node.id && node.id.name) return node.id.name
  if (node.key) {
    const k = keyName(node.key)
    if (k) return k
  }
  const parent = parents[parents.length - 1]
  if (!parent) return null
  if (parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'Identifier') return parent.id.name
  if ((parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && parent.value === node) {
    return keyName(parent.key)
  }
  if (parent.type === 'AssignmentExpression') return memberPath(parent.left)
  return null
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
])

/** 收集所有具名函数/方法（含对象方法简写、const 箭头函数）。 */
function functionEntries(ast) {
  const out = []
  walk(ast.program, (node, parents) => {
    if (!FUNCTION_TYPES.has(node.type)) return
    const name = functionName(node, parents)
    if (!name) return
    const body = node.body
    out.push({
      name,
      kind: node.type,
      node,
      start: node.start,
      end: node.end,
      bodyStart: body ? body.start : node.start,
      bodyEnd: body ? body.end : node.end,
    })
  })
  return out
}

function findFunction(ast, name) {
  return functionEntries(ast).find((f) => f.name === name) || null
}

/** 从源码里取 <script> 块（一个文件可能同时有普通 script 与 script setup）。 */
function scriptBlocks(sfcSource) {
  const out = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(sfcSource))) out.push(m[1])
  return out.join('\n')
}

/**
 * 从 anchorIdx 往前找所属 HTML 开始标签，引号感知地扫到 '>'。
 * 用于模板判据：不再用固定字符窗口，改为「稳定锚点 + 完整开始标签」。
 */
function htmlStartTagAt(src, anchorIdx) {
  const lt = src.lastIndexOf('<', anchorIdx)
  if (lt < 0) return null
  let quote = null
  for (let i = lt + 1; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return { start: lt, end: i + 1, text: src.slice(lt, i + 1) }
  }
  return null
}

module.exports = {
  parse, walk, analyze, keyName, memberPath,
  functionEntries, findFunction, scriptBlocks, htmlStartTagAt, maskRanges,
}
