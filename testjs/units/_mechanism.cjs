// =========================================================================
// _mechanism.cjs ——「固定机制」测试底座：从产品代码抽真实配置，跑真依赖
//
// 和 L1 文本断言（assert.match(src, /正则/)）的区别：
//   文本断言固定的是「源码长什么样」，格式化/换行/换引号就假红，且改坏了写法但
//   行为没变也照过；这里固定的是「机制还生不生效」——配置从产品代码用 AST 提取，
//   喂给真的 cors/express，发真 HTTP 请求，看响应头。源码怎么写都行，行为对了才过。
//
// 边界：只提取声明式配置（正则/函数/选项对象），不 eval 业务路由；执行依赖用产品
// 自己的 node_modules（backendRequire），避免测试装一份版本漂移的 cors。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const { createRequire, Module } = require('node:module')
const { analyze, walk, findFunction, scriptBlocks } = require('../_source-scan.cjs')

/**
 * 解析源码找函数，返回节点在**原始字符串**上的 [start, end)。
 * .js 直接解析；.vue SFC 逐 <script> 块解析，再把块内下标加偏移映射回全文
 * （切片必须落在原文上，拼块会让下标错位）。
 */
function locateFunction(src, name, what) {
  // 先按整份当 JS/TS 解析。.js 文件（哪怕内含 <script> 字符串字面量）在这里就命中；
  // .vue SFC 整份解析会失败或找不到函数，再退回逐 <script> 块找。
  // 不靠「文本里有没有 <script>」猜文件类型——dev-loader 就因为模板字符串踩过这个坑。
  const tryParse = (text, offset) => {
    try {
      const entry = findFunction(analyze(text).ast, name)
      if (entry) {
        return { start: entry.start + offset, end: entry.end + offset, bodyStart: entry.bodyStart + offset, bodyEnd: entry.bodyEnd + offset }
      }
    } catch (_) { /* SFC 的 HTML 模板不是合法 JS，走 fallback */ }
    return null
  }
  const whole = tryParse(src, 0)
  if (whole) return whole

  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(src))) {
    const hit = tryParse(m[1], m.index + m[0].indexOf(m[1]))
    if (hit) return hit
  }
  throw new Error(`机制提取失败：找不到函数 ${what}`)
}

const { ROOT } = require('#testjs/paths')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 把源码变异后重新编译成模块：`require` 仍走原目录，所以变异体拿到的是同一个
 * db 代理 / 单例，真的执行原函数逻辑 —— 拿字符串做正则会「改坏了也照过」（T08-02）。
 *
 * transform 没匹配到目标代码时直接抛：静默返回原模块会让「变异反证」变成假绿
 * （断言的对象其实没被改坏，测试红不红都与守卫无关）。
 */
function loadMutated(rel, transform) {
  const full = path.join(ROOT, rel)
  const src = fs.readFileSync(full, 'utf8')
  const out = transform(src)
  if (out === src) throw new Error(`变异未匹配到目标代码：${rel}（正则要跟着源码一起改）`)
  const m = new Module(full, null)
  m.filename = full
  m.paths = Module._nodeModulePaths(path.dirname(full))
  m._compile(out, full)
  return m.exports
}

/** 在 AST 里按「声明名 + 节点类型」取源码切片；找不到直接报错，别静默降级成文本正则。 */
function sliceDecl(src, ast, predicate, what) {
  let out = null
  walk(ast.program, (n) => {
    if (!out && predicate(n)) out = src.slice(n.start, n.end)
  })
  if (!out) throw new Error(`机制提取失败：找不到 ${what}（产品代码结构变了，需同步更新提取器）`)
  return out
}

/**
 * 按函数名从源码抽「函数体」源码（AST 节点边界，不是手动数花括号）。
 * 用于「抽出产品函数 + 注入假依赖真跑」这类机制测试：源码格式化/加注释不影响，
 * 但函数改名或删掉会明确报错（不静默降级成空断言）。
 *
 * NOTE: 只支持具名函数 / 具名箭头（const fn = () => {}），与 _source-scan.functionEntries 一致。
 */
function extractFunctionBody(src, name, what = name) {
  const loc = locateFunction(src, name, what)
  return src.slice(loc.bodyStart, loc.bodyEnd)
}

/**
 * 同上，但返回**去掉外层花括号的内部文本**（与旧式手动配平 `slice(open+1, i)` 同形）。
 * 给「抽出后 new Function(body) 真跑」的测试用——它们要的是函数体内容，不是带括号的块。
 */
function extractFunctionInner(src, name, what = name) {
  const body = extractFunctionBody(src, name, what)
  return body.slice(1, -1)
}

/** 抽**完整函数声明**（含 function 头与花括号）——给拿去当字符串分析、而非 new Function 执行的测试用。 */
function extractFunctionDecl(src, name, what = name) {
  const loc = locateFunction(src, name, what)
  return src.slice(loc.start, loc.end)
}

/**
 * 解析一份源码，返回 `{ ast, code }`：`code` 是**实际被解析的文本**。
 *
 * .vue SFC 的模板不是合法 JS，整份解析会失败 —— 这时逐 `<script>` 块拼成一份再解析。
 * 关键约定：`code` 与节点 start/end **同源**，所以 `code.slice(n.start, n.end)` 是安全的；
 * 但它**不等于**传入的 src（SFC 少了模板部分），要切原文仍得用下面几个 extract*。
 *
 * 用途：只需要遍历结构（参数个数、对象键、调用关系），不需要回切原文件时。
 */
function analyzeSfc(src) {
  try {
    return { ast: analyze(src).ast, code: src }
  } catch (_) { /* SFC / 含 <script> 的 HTML：走脚本块 */ }
  const code = scriptBlocks(src)
  if (!code) throw new Error('解析失败：既不是合法 JS，也没有 <script> 块')
  return { ast: analyze(code).ast, code }
}

/**
 * 按「锚点」取一段代码块：从含 anchor 的位置起，按大括号配平到收尾。
 *
 * 用途：目标不是具名函数，而是**某一行开头的调用**——例如
 *   router.post('/recover-password', async (req, res) => { ... })
 * 这时 AST 找不到「叫这个名字的函数」，只能按锚点定位。
 *
 * 比手写版多做的事：配平会跳过字符串/模板/注释里的 `{}`。手写版在
 *   router.post('/x', async () => { res.json({ ok: true }) }) 这种**本来正常**的代码上
 * 也会算错——它把参数/字面量里的大括号也计数，换个写法就假红。
 */
function extractBlockByAnchor(src, anchor, what = anchor) {
  const at = src.indexOf(anchor)
  if (at < 0) throw new Error(`机制提取失败：找不到锚点 ${what}`)
  const skipComment = (i) => {
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      return nl < 0 ? src.length : nl + 1
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) throw new Error(`机制提取失败：注释未闭合（${what}）`)
      return end + 2
    }
    return -1
  }
  const skipString = (i) => {
    const quote = src[i]
    i += 1
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === quote) return i + 1
      i += 1
    }
    throw new Error(`机制提取失败：字符串未闭合（${what}）`)
  }

  let depth = 0
  let started = false
  let i = at
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(i); continue }
    if (c === "'" || c === '"' || c === '`') { i = skipString(i); continue }
    if (c === '{') { depth += 1; started = true }
    else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return src.slice(at, i + 1)
    }
    i += 1
  }
  throw new Error(`机制提取失败：锚点 ${what} 的大括号没有配平`)
}

function extractAppCors(src) {
  const { ast } = analyze(src)

  // 正则取 init 节点本身的切片，不用字符串前缀去啃声明文本 —— 否则格式化就断。
  let reSrc = null
  walk(ast.program, (n) => {
    if (!reSrc && n.type === 'VariableDeclarator' && n.id.name === 'CORS_ORIGIN_RE' &&
        n.init && n.init.type === 'RegExpLiteral') {
      reSrc = src.slice(n.init.start, n.init.end)
    }
  })
  if (!reSrc) throw new Error('机制提取失败：找不到 CORS_ORIGIN_RE 正则字面量')

  const fnSrc = sliceDecl(src, ast,
    (n) => n.type === 'FunctionDeclaration' && n.id.name === 'corsOriginAllowed',
    'corsOriginAllowed')

  let objSrc = null
  walk(ast.program, (n) => {
    if (!objSrc && n.type === 'CallExpression' && n.callee.type === 'Identifier' &&
        n.callee.name === 'cors' && n.arguments[0] && n.arguments[0].type === 'ObjectExpression') {
      objSrc = src.slice(n.arguments[0].start, n.arguments[0].end)
    }
  })
  if (!objSrc) throw new Error('机制提取失败：找不到 app.use(cors({...})) 的选项对象')

  // 正则字面量来自产品源码本身；判定函数与选项对象在同一闭包里求值。
  const CORS_ORIGIN_RE = eval(reSrc)
  const corsOriginAllowed = new Function('CORS_ORIGIN_RE', `${fnSrc}\nreturn corsOriginAllowed;`)(CORS_ORIGIN_RE)
  const options = new Function('corsOriginAllowed', `return (${objSrc});`)(corsOriginAllowed)
  return { options, corsOriginAllowed }
}

/**
 * 起一个只挂真 cors 中间件的最小 express 服务，返回 { request, close }。
 * request(origin, path) → Response；用产品自己的 express/cors，验证的是真实中间件行为。
 */
async function startCorsProbe(options) {
  const express = backendRequire('express')
  const cors = backendRequire('cors')
  const app = express()
  app.use(cors(options))
  app.get('/probe', (_req, res) => res.json({ ok: true }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    async request(origin) {
      const headers = origin === undefined ? {} : { Origin: origin }
      return fetch(`${base}/probe`, { headers })
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

module.exports = { read, analyze, walk, findFunction, extractFunctionBody, extractFunctionInner, extractFunctionDecl, extractBlockByAnchor, analyzeSfc, loadMutated, extractAppCors, startCorsProbe, backendRequire, ROOT }
