#!/usr/bin/env node
// =========================================================================
// pin-spread.cjs —— 存量源码断言「批量补 @pin」的推断机（先只报告，不写盘）
//
// 与 pin-feasibility.cjs 的区别：那个用「文件里出现过的任意标识符」，于是
// require / hasSelection 这种到处都有的词也会命中（假锚点）。
// 这里只认**声明符号**：函数名、模块级变量、类名、对象方法的键。
// 假锚点的代价是「永远活着」，等于没有退场机制，比不写更糟。
//
// 用法：
//   node testjs/tmp/pin-spread.cjs              # 统计 + 抽样
//   node testjs/tools/pin-spread.cjs --json     # 输出完整映射到 testjs/tmp/pin-spread.json
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const { ROOT } = require('#testjs/paths')
const { analyze, walk, scriptBlocks } = require('../_source-scan.cjs')

const UNITS = path.join(ROOT, 'testjs', 'units')
const ASSERT_LINE = /assert\.(match|doesNotMatch|ok)\s*\(/
const SRC_HINT = /src|source|body|code|decl|text|snippet|flat|sfc|raw|content/i

// 太通用的名字：作为锚点没有语义（而且几乎必然存在于任何文件）
const GENERIC = new Set([
  'data', 'item', 'items', 'value', 'values', 'name', 'names', 'type', 'types', 'list',
  'key', 'keys', 'id', 'ids', 'props', 'ref', 'computed', 'watch', 'result', 'res',
  'index', 'length', 'push', 'map', 'filter', 'forEach', 'reduce', 'slice', 'split',
  'string', 'number', 'boolean', 'object', 'array', 'error', 'err', 'args', 'arg',
  'options', 'config', 'params', 'event', 'target', 'node', 'el', 'self', 'this',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'default', 'module',
  'exports', 'require', 'import', 'export', 'const', 'let', 'var', 'async', 'await',
  'class', 'style', 'width', 'height', 'left', 'right', 'top', 'bottom', 'text',
  'title', 'label', 'rows', 'cols', 'row', 'col', 'next', 'prev', 'curr', 'current',
  'state', 'store', 'api', 'http', 'url', 'path', 'file', 'files', 'dir', 'json',
  'console', 'window', 'document', 'Object', 'Array', 'Math', 'Date', 'JSON', 'String',
  'Number', 'Boolean', 'Promise', 'Map', 'Set', 'RegExp', 'Error', 'parseInt', 'parseFloat',
])

// ---------------------------------------------------------------------------
// 1. 目标源码的「声明符号表」
// ---------------------------------------------------------------------------
const declCache = new Map()

function declsOf(rel) {
  if (declCache.has(rel)) return declCache.get(rel)
  const set = new Set()
  let src
  try {
    src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (_) {
    declCache.set(rel, set)
    return set
  }

  const harvest = (text) => {
    const { ast } = analyze(text)
    const addPattern = (id) => {
      if (!id) return
      if (id.type === 'Identifier') set.add(id.name)
      else if (id.type === 'ObjectPattern') id.properties.forEach((p) => addPattern(p.value || p.argument))
      else if (id.type === 'ArrayPattern') id.elements.forEach(addPattern)
    }
    // 收「一个对象表达式里的键」：Vue options API 的 methods / computed 就在这层
    const addObjectKeys = (obj) => {
      for (const p of obj.properties || []) {
        const k = p.key
        if (!k) continue
        // 只收「值是函数」的键（methods / computed）；data() 返回的数据键不收，理由同 isCallable
        const callable = p.value && (
          p.value.type === 'FunctionExpression' ||
          p.value.type === 'ArrowFunctionExpression'
        )
        if (!callable) continue
        if (k.type === 'Identifier') set.add(k.name)
        else if (k.type === 'StringLiteral' && /^[A-Za-z_$][\w$]*$/.test(k.value)) set.add(k.value)
      }
    }
    // 只有「可调用单元」才配当锚点：函数、类、赋值为函数/箭头的 const。
    // 数据变量（const scrollTop = ref(0)）不作为锚点——它改名不改变断言语义，
    // 断言文本里出现它多半是巧合（同一段代码里的邻居），钉上去等于永远活着。
    const isCallable = (init) => init && (
      init.type === 'ArrowFunctionExpression' ||
      init.type === 'FunctionExpression' ||
      init.type === 'CallExpression' && init.callee && /^(defineComponent|defineAsyncComponent)$/.test(init.callee.name || '')
    )
    const addVar = (d) => {
      if (d.id && d.id.type === 'Identifier' && isCallable(d.init)) set.add(d.id.name)
      else if (d.id && d.id.type === 'Identifier' && !d.init) set.add(d.id.name) // let/var 先声明后赋值
    }
    const visitStmt = (s) => {
      if (!s) return
      switch (s.type) {
        case 'VariableDeclaration':
          s.declarations.forEach(addVar)
          break
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
          if (s.id) set.add(s.id.name)
          break
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration':
          visitStmt(s.declaration)
          break
        case 'ExpressionStatement': {
          // module.exports = { foo, bar }
          const e = s.expression
          if (e && e.type === 'AssignmentExpression' && e.right.type === 'ObjectExpression') addObjectKeys(e.right)
          break
        }
        default:
          break
      }
    }
    for (const s of ast.program.body) {
      visitStmt(s)
      // export default { methods: {...}, computed: {...} }
      if (s.type === 'ExportDefaultDeclaration' && s.declaration && s.declaration.type === 'ObjectExpression') {
        addObjectKeys(s.declaration)
        for (const p of s.declaration.properties) {
          if (p.value && p.value.type === 'ObjectExpression') addObjectKeys(p.value)
        }
      }
    }
  }

  try {
    harvest(src)
  } catch (_) {
    const blocks = scriptBlocks(src)
    if (blocks) { try { harvest(blocks) } catch (_) { /* 放弃这个文件 */ } }
  }
  declCache.set(rel, set)
  return set
}

// ---------------------------------------------------------------------------
// 2. 测试文件里「变量 → 源码文件」的映射（多轮传播，处理 const geo = src.slice(...)）
// ---------------------------------------------------------------------------
const READ_CALL = /\b(?:read|readSrc|readText)\(\s*['`]([^'`]+)['`]/

const BIZ = /^(student-frontend\/src|student-backend|electron)\//

/** 规整 `a/./b`、`a/b/../c`，统一正斜杠 */
function normPath(p) {
  const parts = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

function makeScopedVars(text) {
  const lines = text.split(/\r?\n/)
  const dirs = new Map()
  const pathConst = new Map() // const TABS = 'student-frontend/src/components/base/Tabs.vue'

  // 目录常量：const SRC = abs('student-frontend/src')
  // 带扩展名的不是目录，是文件（const APP = abs('student-backend/app.js')）。
  for (const line of lines) {
    const m = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*abs\(\s*['`]([^'`]+)['`]\s*\)/)
    if (m) {
      const p = normPath(m[2])
      if (/\.(js|cjs|mjs|vue|json|html)$/.test(p)) pathConst.set(m[1], p)
      else dirs.set(m[1], p)
      continue
    }
    // 路径常量的两种写法：纯字符串 / path.join(SRC, 'a', 'b')
    const s = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['`]([^'`]+)['`]\s*$/)
    if (s && BIZ.test(normPath(s[2]))) { pathConst.set(s[1], normPath(s[2])); continue }
    const j = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,([^)]*)\)/)
    if (j) {
      const base = dirs.get(j[2])
      const segs = [...j[3].matchAll(/['`]([^'`]+)['`]/g)].map((x) => x[1])
      if (base && segs.length) pathConst.set(j[1], normPath(base + '/' + segs.join('/')))
    }
  }

  /** 从右手里解析出「读了哪个文件」 */
  const fromRhs = (rhs) => {
    /** 相对路径（components/x.vue）按第一个目录常量补全 */
    const qual = (p) => {
      const n = normPath(p)
      if (BIZ.test(n)) return n
      const base = [...dirs.values()][0]
      if (!base) return null
      const q = normPath(base + '/' + n)
      return BIZ.test(q) ? q : null
    }
    let m = rhs.match(READ_CALL)
    if (m) return qual(m[1])
    // read(TABS) / readFileSync(APP)：路径是常量
    m = rhs.match(/\bread(?:Src|Text)?\(\s*([A-Za-z_$][\w$]*)\s*[,)]/)
    if (m && pathConst.has(m[1])) return pathConst.get(m[1])
    m = rhs.match(/readFileSync\(\s*([A-Za-z_$][\w$]*)\s*[,)]/)
    if (m && pathConst.has(m[1])) return pathConst.get(m[1])
    m = rhs.match(/readFileSync\(\s*abs\(\s*['`]([^'`]+)['`]/)
    if (m) return normPath(m[1])
    // readFileSync(path.join(SRC, 'views/X.vue'))：拼目录常量 + 字符串片段
    m = rhs.match(/readFileSync\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,([^)]*)\)/)
    if (m) {
      const base = dirs.get(m[1])
      const segs = [...m[2].matchAll(/['`]([^'`]+)['`]/g)].map((x) => x[1])
      if (base && segs.length) return normPath(base + '/' + segs.join('/'))
    }
    // readFileSync(path.join(__dirname, '..', '..', 'student-frontend/src/x'))
    m = rhs.match(/readFileSync\(\s*path\.join\(\s*(?:__dirname|ROOT)\s*,([^)]*)\)/)
    if (m) {
      const segs = [...m[1].matchAll(/['`]([^'`]+)['`]/g)].map((x) => x[1])
      if (segs.length) return normPath(segs.join('/'))
    }
    // 兜底：abs('x.js') 被别的函数包了一层（pathToFileURL(abs(...)).href）
    m = rhs.match(/abs\(\s*['`]([^'`]+)['`]\s*\)/)
    if (m) return normPath(m[1])
    return null
  }

  const DECL = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/
  const DECL_TOP = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/
  const TEST_START = /^\s*test(?:\.\w+)?\(/
  // const body = fnBody(code, 'measureViewport') —— 断言对象就是这个函数本身
  const FN_EXTRACT = /(?:extractFunctionInner|extractFunctionBody|extractFunctionDecl|extractFnBody|fnBody|innerBody)\(\s*([A-Za-z_$][\w$]*)\s*,\s*['`]([A-Za-z_$][\w$]*)['`]/

  /** 在给定的行区间里做多轮传播。topOnly 只认顶格声明（模块级常量），
   *  避免把**别的 test 内部**的 const body 当成当前用例的声明——
   *  那会让每条断言都锚到同一个函数上，且看上去完全合理。 */
  const build = (from, to, topOnly = false) => {
    const declRe = topOnly ? DECL_TOP : DECL
    const map = new Map()
    const fnOf = new Map() // 变量名 → { file, fn }
    const pending = []
    for (let round = 0; round < 5; round++) {
      let grew = false
      for (let i = from; i <= to; i++) {
        const m = lines[i].match(declRe)
        if (!m) continue
        const [, name, rhs] = m

        // 抽函数体：这是最精确的锚点，断言守的就是那个函数的实现
        const fx = rhs.match(FN_EXTRACT)
        if (fx && !fnOf.has(name)) {
          const [, srcVar, fnName] = fx
          const file = map.get(srcVar) || fromRhs(rhs)
          if (file) { fnOf.set(name, { file, fn: fnName }); grew = true }
          else pending.push({ name, srcVar, fnName })
        }

        if (map.has(name)) continue
        const direct = fromRhs(rhs)
        if (direct && BIZ.test(direct)) { map.set(name, direct); grew = true; continue }
        // 派生：从源码变量里切出来的片段
        if (!/\b(?:slice|match|matchAll|split|indexOf|substring|replace|exec|filter|map|join)\b/.test(rhs)) continue
        for (const [v, p] of map) {
          if (new RegExp('\\b' + v + '\\b').test(rhs)) { map.set(name, p); grew = true; break }
        }
      }
      // 抽函数体时源变量可能在本轮之后才解析出来，重试一次
      for (let k = pending.length - 1; k >= 0; k--) {
        const p = pending[k]
        const file = map.get(p.srcVar)
        if (file) { fnOf.set(p.name, { file, fn: p.fnName }); pending.splice(k, 1); grew = true }
      }
      if (!grew) break
    }
    return { map, fnOf }
  }

  return {
    /**
     * 断言里**内联**出现的读取（没有中间变量）：
     *   assert.match(read('views/X.vue'), /…/)
     *   assert.match(fs.readFileSync(path.join(SRC, 'views/X.vue'), 'utf8'), /…/)
     * 这类占「无法定位变量」的一大半——不是推断不出来，是压根没变量可追。
     */
    inlineFiles(assertText) {
      const out = []
      const push = (p) => { if (p && BIZ.test(p)) out.push(p) }
      // read('views/X.vue') —— 文件内自定义 read，相对第一个目录常量
      for (const m of assertText.matchAll(/\bread(?:Src|Text)?\(\s*['`]([^'`]+)['`]/g)) {
        const p = normPath(m[1])
        if (BIZ.test(p)) push(p)
        else {
          const base = [...dirs.values()][0]
          if (base) push(normPath(base + '/' + p))
        }
      }
      for (const m of assertText.matchAll(/\breadFileSync\(\s*abs\(\s*['`]([^'`]+)['`]/g)) push(normPath(m[1]))
      for (const m of assertText.matchAll(/\breadFileSync\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,\s*['`]([^'`]+)['`]/g)) {
        const base = dirs.get(m[1])
        if (base) push(normPath(base + '/' + m[2]))
      }
      for (const m of assertText.matchAll(/(?:^|[^.\w])abs\(\s*['`]([^'`]+)['`]\s*\)/g)) push(normPath(m[1]))
      return [...new Set(out)]
    },

    /**
     * 断言所在行的变量映射。
     * 先用「本用例内」的声明（同一 test 内 const src = read(...) 会重复声明，
     * 名字相同但指向不同文件——只能就近取），再用文件顶层的常量兜底。
     */
    /**
     * 该断言所在 test 内读到的业务文件。
     * 变量是 helper 返回值（const body = registryValidBody()）或函数参数时，
     * 单个变量追不到文件；但「一个用例只读一个源码文件」是常态，可以兜底。
     * 只在**唯一**时使用——多个文件时猜错比不猜更糟。
     */
    testFiles(idx) {
      let start = 0
      for (let i = idx; i >= 0; i--) if (TEST_START.test(lines[i])) { start = i; break }
      let end = lines.length - 1
      for (let i = idx + 1; i < lines.length; i++) if (TEST_START.test(lines[i])) { end = i - 1; break }
      const out = new Set()
      for (const p of this.inlineFiles(lines.slice(start, end + 1).join('\n'))) out.add(p)
      for (let i = start; i <= end; i++) {
        const m = lines[i].match(DECL)
        if (!m) continue
        const p = fromRhs(m[2])
        if (p) out.add(p)
      }
      return [...out]
    },

    at(idx) {
      let start = 0
      for (let i = idx; i >= 0; i--) {
        if (TEST_START.test(lines[i])) { start = i; break }
      }
      const inner = build(start, Math.min(idx + 2, lines.length - 1))
      const vars = inner.map
      const fnOf = inner.fnOf
      if (start > 0) {
        const outer = build(0, start - 1, true)
        for (const [k, v] of outer.map) if (!vars.has(k)) vars.set(k, v)
        for (const [k, v] of outer.fnOf) if (!fnOf.has(k)) fnOf.set(k, v)
      }
      return { vars, fnOf }
    },
  }
}

// ---------------------------------------------------------------------------
// 3. 推断单条断言的锚点
// ---------------------------------------------------------------------------
function identCandidates(s) {
  // 从断言文本（正则源码形态）里抠标识符，保持出现顺序。
  // 前后不许是 `-`/`.`/`/`：`rc-close` 里的 close、`a/b` 里的 b 都不是独立符号
  // （真踩过：断言 `/rc-close/` 被推断成 `#close`，锚点与断言毫无关系，却永远活着）。
  const out = []
  const re = /(?<![\w$./-])[A-Za-z_$][\w$]{3,}(?![\w$/-])/g
  let m
  while ((m = re.exec(s))) {
    const w = m[0]
    if (GENERIC.has(w)) continue
    // 4 字符以内的短符号（safe / emit / init）做锚点没有辨识度，几乎必然误配
    if (w.length < 5) continue
    if (!out.includes(w)) out.push(w)
  }
  return out
}

/** @returns {{pin:string, symbol:string, how:string} | {why:string}} */
function inferPin(assertText, vars, inline, fnOf, testFiles) {
  // 0) 断言对象是「抽出来的函数体」：锚点天然是那个函数，最精确的一类
  if (fnOf && fnOf.size) {
    for (const [v, hit] of fnOf) {
      if (!new RegExp('\\b' + v + '\\b').test(assertText)) continue
      // 抽的函数名必须真的是该文件的声明符号，否则锚点一插就是死的
      if (!declsOf(hit.file).has(hit.fn)) continue
      return { pin: `${hit.file}#${hit.fn}`, symbol: hit.fn, how: '函数体提取', rel: hit.file }
    }
  }
  // 断言里出现的源码变量 → 候选文件（可能多个）；再加上内联读取直接给出的文件
  const usedVars = [...vars.keys()].filter((v) => new RegExp('\\b' + v + '\\b').test(assertText))
  let files = [...new Set([...usedVars.map((v) => vars.get(v)), ...(inline || [])])]
  // 兜底：变量追不到（helper 返回值 / 函数参数），但整段用例只读了一个源码文件
  if (!files.length && testFiles && testFiles.length === 1) files = testFiles

  const idents = identCandidates(assertText)
  const hits = []
  for (const rel of files) {
    const decls = declsOf(rel)
    for (const w of idents) {
      if (decls.has(w)) hits.push({ rel, symbol: w, pos: assertText.indexOf(w) })
    }
  }
  if (!hits.length) {
    return { why: files.length ? '断言里没有该文件的声明符号（模板属性/字面量/数值）' : '无法定位源码变量' }
  }
  // 去重（同一符号可能在多个文件命中）
  const uniq = []
  for (const h of hits) if (!uniq.some((u) => u.rel === h.rel && u.symbol === h.symbol)) uniq.push(h)
  uniq.sort((a, b) => a.pos - b.pos)

  const filesOfTop = new Set(uniq.map((u) => u.rel))
  const best = uniq[0]
  const ambiguous = filesOfTop.size > 1
  return { pin: `${best.rel}#${best.symbol}`, symbol: best.symbol, how: ambiguous ? '多文件' : '唯一', rel: best.rel }
}

// ---------------------------------------------------------------------------
// 4. 扫描
// ---------------------------------------------------------------------------
function readPinLine(line) {
  if (!line) return null
  const m = line.match(/@pin\s+(\S+)/)
  return m ? m[1] : null
}

/** 递归收集 *.test.js，返回相对 units/ 的路径（与 guard-ledger.collectTests 同口径）。
 *  347 个单测全在 13 个子目录，非递归会扫到 0 个文件、静默报「0 断言 / 0 可补锚点」（V9-T02b-04）。 */
function collectTests(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, e.name)
    if (e.isDirectory()) { collectTests(dir, full, out); continue }
    if (e.name.endsWith('.test.js')) out.push(path.relative(dir, full).split(path.sep).join('/'))
  }
  return out
}

const files = collectTests(UNITS).sort()
const rows = []
let totalAssert = 0, pinned = 0, bare = 0

for (const f of files) {
  const text = fs.readFileSync(path.join(UNITS, f), 'utf8')
  const scoped = makeScopedVars(text)
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!ASSERT_LINE.test(line)) continue
    if (/^\s*(\/\/|\*)/.test(line)) continue
    totalAssert++
    if (readPinLine(line) || readPinLine(lines[i - 1])) { pinned++; continue }
    if (!SRC_HINT.test(line)) continue
    bare++
    // 只看断言行本身：把上一行拼进来会引入「同一段代码里的邻居变量」，
    // 抽样时 scrollTop / pendingResolved 就是这么被误当成锚点的（那句断言根本没提它们）。
    // 只有断言首参换行（行尾停在 `assert.match(x, ` 且没有正则闭合）才往后续拼。
    let ctx = line
    if (/assert\.(match|doesNotMatch|ok)\(\s*[^,]+,\s*$/.test(line.trim())) {
      ctx = [line, lines[i + 1] || '', lines[i + 2] || ''].join('\n')
    }
    const scope = scoped.at(i)
    const r = inferPin(ctx, scope.vars, scoped.inlineFiles(ctx), scope.fnOf, scoped.testFiles(i))
    rows.push({ file: f, line: i + 1, text: line.trim().slice(0, 100), ...r })
  }
}

const ok = rows.filter((r) => r.pin)
const uniqOk = ok.filter((r) => r.how === '唯一')
const multiOk = ok.filter((r) => r.how === '多文件')
const fail = rows.filter((r) => !r.pin)

console.log('== @pin 铺开可行性 ==')
console.log(`源码断言 ${totalAssert} 条 · 已有 @pin ${pinned} 条 · 未登记 ${bare} 条`)
console.log(`  可推断出声明符号  ${ok.length} 条（${(ok.length / bare * 100).toFixed(0)}%）`
  + `  → 唯一文件 ${uniqOk.length} / 多文件歧义 ${multiOk.length}`)
console.log(`  推断不出         ${fail.length} 条`)

const byReason = {}
for (const r of fail) byReason[r.why] = (byReason[r.why] || 0) + 1
console.log('\n推断不出的原因：')
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

// 按文件看：能补多少
const perFile = new Map()
for (const r of ok) perFile.set(r.file, (perFile.get(r.file) || 0) + 1)
const perFileBare = new Map()
for (const r of rows) perFileBare.set(r.file, (perFileBare.get(r.file) || 0) + 1)
const ranked = [...perFile.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n有可补锚点的文件 ${perFile.size} 个。前 15：`)
for (const [f, n] of ranked.slice(0, 15)) console.log(`  ${String(n).padStart(3)}/${String(perFileBare.get(f)).padStart(3)}  ${f}`)

console.log('\n== 抽样 20 条（看锚点是不是真的指向那条断言守的实现）==')
const sample = []
const step = Math.max(1, Math.floor(uniqOk.length / 20))
for (let i = 0; i < uniqOk.length && sample.length < 20; i += step) sample.push(uniqOk[i])
for (const r of sample) {
  console.log(`\n${r.file}:${r.line}`)
  console.log(`  断言  ${r.text}`)
  console.log(`  锚点  ${r.pin}`)
}

if (process.argv.includes('--json')) {
  const dir = path.join(ROOT, 'testjs', 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'pin-spread.json')
  fs.writeFileSync(out, JSON.stringify(rows, null, 1))
  console.log(`\n已写 ${out}（${rows.length} 条）`)
}
