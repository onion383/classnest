#!/usr/bin/env node
// =========================================================================
// guard-ledger.cjs —— 守卫台账：给「散点守卫」装一道增量闸 + 一个自动退场机制
//
// 要解决的问题（不是体积，是只涨不跌）：
//   修一个 bug 最省力的验证方式是「在测试里加一条 assert.doesNotMatch(src, /x/)」，
//   5 秒写完、当下为真、以后没人记得它在防什么。于是 339 个文件 / 939 条源码断言，
//   删掉又不放心（存量审计结论：139 条恒绿里最多只能删 8 条）。
//
// 本工具不改存量断言，只立两条规矩：
//   1) 每条源码断言旁边写一行锚点：  // @pin <源码相对路径>#<符号名>
//      锚点是「这条断言在守护哪个函数的实现」。写一行注释，5 秒，几乎不加摩擦。
//   2) 锚点必须还活着。符号没了 = 这条断言已经无法失败 = 纯噪音 → 报错要求删除。
//      **这就是退出机制**：不靠人判断「以后还会不会再犯」，只靠机器回答「你钉的东西还在不在」。
//
// 增量闸：存量按文件记「无 @pin 断言数」基线，只降不升。
//   加一条不带 @pin 的源码断言 → 该文件计数超过基线 → 失败。
//   补了 @pin 或删了死守卫 → 计数下降 → 提示下调基线（--update 写回）。
//
// 另外把 README §0.5 的两个度量也做成闸门（`_test-rules-baseline.json`）：
//   A. 纯读源码 + 正则、从不执行产品代码的文件 —— 只减不增。
//      这类文件红了，人判断不了是「写法变了」还是「真坏了」，是维护成本的集中地。
//   B. 「只有 1 条源码断言、且没有任何行为断言」的用例 —— 只降不升。
//      这是「一个 bug 一条散点守卫」的标准形态，也是锚点机制主要要清掉的那批。
//   两个基线都只允许下调：变差的正确解法是改进（让它真跑 / 补一条行为断言），不是放宽基线。
//
// 用法：
//   node testjs/tools/guard-ledger.cjs            # 校验（死 pin / 超基线 → 退出码 1）
//   node testjs/tools/guard-ledger.cjs --report   # 只出报告，不判成败
//   node testjs/tools/guard-ledger.cjs --update   # 用当前实测值重写基线（只允许下调）
//   node testjs/tools/guard-ledger.cjs --top=20   # 顺带列源码断言最多的文件
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const { ROOT } = require('#testjs/paths')
const { analyze, walk, scriptBlocks } = require('../_source-scan.cjs')

const UNITS = path.join(ROOT, 'testjs', 'units')
const BASELINE = path.join(UNITS, '_guard-baseline.json')

const args = process.argv.slice(2)
const REPORT_ONLY = args.includes('--report')
const UPDATE = args.includes('--update')
const TOP = Number((args.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || 0

// ---------------------------------------------------------------------------
// 「源码断言」的识别口径
//
// 刻意用行级启发式而不是 AST 分析：这段代码的历史数字（939 条 / 150 文件）就是用
// 同一口径统计出来的，改口径会让「存量 vs 增量」失去可比性。
//
// 口径：断言行里出现源码类变量名。误判方向是**多算**（把普通断言算成源码断言），
// 结果只是逼人写一行 @pin，代价可接受；少算才是危险的（漏掉真正的新增守卫）。
// ---------------------------------------------------------------------------
const SRC_HINT = /src|source|body|code|decl|text|snippet|flat|sfc|raw|content/i
const ASSERT_LINE = /assert\.(match|doesNotMatch|ok)\s*\(/

/** 从测试源码里取每条源码断言：[{ line, pin }]。pin 为 null 表示未登记。 */
function collectAssertions(testSrc) {
  const lines = testSrc.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!ASSERT_LINE.test(line)) continue
    // 只看断言本身，跳过被注释掉的旧代码
    if (/^\s*(\/\/|\*)/.test(line)) continue
    const isSrcAssert = SRC_HINT.test(line)
    // pin 可以写在断言行尾，也可以写在紧邻的上一行
    const pin = readPin(lines[i]) || readPin(lines[i - 1])
    if (!pin && !isSrcAssert) continue
    out.push({ line: i + 1, pin })
  }
  return out
}

function readPin(line) {
  if (!line) return null
  const m = line.match(/@pin\s+(\S+)/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// 锚点存活判定
//
// 符号集合从 AST 收集（标识符 = 变量/函数/参数/属性访问/对象键，字符串键也算），
// 而不是在文本里 indexOf —— 后者会被注释和字符串里的同名文字骗到，
// 于是「函数早删了、注释里还提一句」也会被判成活着（假绿）。
// ---------------------------------------------------------------------------
const symbolCache = new Map()

function symbolsOf(rel) {
  if (symbolCache.has(rel)) return symbolCache.get(rel)
  const full = path.join(ROOT, rel)
  let set = null
  try {
    const src = fs.readFileSync(full, 'utf8')
    set = new Set()
    const harvest = (text) => {
      const { ast } = analyze(text)
      walk(ast.program, (n) => {
        if (n.type === 'Identifier' || n.type === 'JSXIdentifier') set.add(n.name)
        else if (n.type === 'StringLiteral' && /^[A-Za-z_$][\w$]*$/.test(n.value)) set.add(n.value)
      })
    }
    try { harvest(src) } catch (_) {
      // .vue SFC 整份不是合法 JS：逐 <script> 块解析（模板/CSS 里的东西只能靠 path#* 钉）
      const blocks = scriptBlocks(src)
      if (!blocks) throw new Error('no script block')
      harvest(blocks)
    }
  } catch (e) {
    set = null // 读不了 / 解析不了 → 交给调用方报「锚点失效」，别静默放行
  }
  symbolCache.set(rel, set)
  return set
}

/** @returns {{ok:true} | {ok:false, why:string}} */
function checkPin(pin) {
  const [rel, symbol] = pin.split('#')
  if (!rel || !symbol) return { ok: false, why: '格式应为 路径#符号（或 路径#*）' }
  if (!fs.existsSync(path.join(ROOT, rel))) return { ok: false, why: `源码文件已不存在：${rel}` }
  if (symbol === '*') return { ok: true }
  const set = symbolsOf(rel)
  if (!set) return { ok: false, why: `源码无法解析：${rel}` }
  if (!set.has(symbol)) return { ok: false, why: `符号已不存在：${rel}#${symbol}` }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
/** 递归收集 *.test.js，返回相对 units/ 的路径（含子目录） */
function collectTests(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, e.name)
    if (e.isDirectory()) { collectTests(dir, full, out); continue }
    if (e.name.endsWith('.test.js')) out.push(path.relative(dir, full).split(path.sep).join('/'))
  }
  return out
}

function scan() {
  const files = collectTests(UNITS).sort()
  const perFile = []
  const deadPins = []
  const badPins = []
  const seen = new Map() // basename → rel，用于检测重名（基线 key 用 basename）

  for (const f of files) {
    const key = path.basename(f)
    if (seen.has(key)) {
      console.error(`✗ 测试文件重名：${seen.get(key)} 与 ${f}\n`
        + '  基线用文件名做 key，重名会互相覆盖。请改掉其中一个的文件名。')
      process.exit(1)
    }
    seen.set(key, f)

    const src = fs.readFileSync(path.join(UNITS, f), 'utf8')
    const asserts = collectAssertions(src)
    const pinned = asserts.filter((a) => a.pin)
    const bare = asserts.filter((a) => !a.pin)

    for (const a of pinned) {
      const r = checkPin(a.pin)
      if (r.ok) continue
      // 格式错（没有 #）与「锚点死了」分开报：前者是写错，后者才是该删守卫
      if (/^格式应为/.test(r.why)) badPins.push({ file: f, line: a.line, pin: a.pin, why: r.why })
      else deadPins.push({ file: f, line: a.line, pin: a.pin, why: r.why })
    }

    perFile.push({ file: f, key, total: asserts.length, pinned: pinned.length, bare: bare.length, bareLines: bare.map((b) => b.line) })
  }
  return { perFile, deadPins, badPins, files }
}

// ---------------------------------------------------------------------------
// 基线读写
//
// key 用**文件名**而不是相对路径：以后 units/ 分类分目录时路径会变，
// 用路径会让全部存量一夜之间变成「新增」。同名文件另行报错（不能静默合并）。
// ---------------------------------------------------------------------------
function loadBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    return j.files || {}
  } catch (_) {
    return {}
  }
}

function saveBaseline(files) {
  const sorted = {}
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: '守卫台账基线：每个测试文件允许的「无 @pin 源码断言数」。只降不升。由 npm run check:guards --update 维护。',
    files: sorted,
  }, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// §0.5 度量闸门（两个「只降不升」的数）
//
// 判据刻意复用上面的行级口径（SRC_HINT + ASSERT_LINE），不另立一套：
// 两套口径会漂，而这里的数字要与 README 对得上才有人信。
//
// 「真跑」的判据是「有没有把产品代码加载进来执行」。列的是实际用到的加载手段，
// 不是「够不够高级」——新增一种加载方式（比如以后用 vm.SourceTextModule）时，
// 这里要跟着加，否则会把它误判成「纯读+正则」而误报。
// ---------------------------------------------------------------------------
const RULES_BASELINE = path.join(UNITS, '_test-rules-baseline.json')
const VALUE_LINE = /assert\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notDeepEqual|throws|rejects|fail)\s*\(/
const RUNS_CODE = /pathToFileURL|new Function|loadMutated|_db-express-fixture|_mechanism|_vue-loader|require\(\s*abs\(|createRequire/

function scanRules(files) {
  const pureRegex = []
  const oneShotByFile = {} // 文件 → { count, names }，用于定位「这次是哪个文件变差了」
  let oneShotCases = 0

  for (const f of files) {
    const src = fs.readFileSync(path.join(UNITS, f), 'utf8')
    if (/\bread\(|\breadFileSync\(/.test(src) && !RUNS_CODE.test(src)) pureRegex.push(f)

    for (const chunk of src.split(/\n(?=test\()/)) {
      if (!/^\s*test(?:\.\w+)?\(/.test(chunk)) continue
      let srcLines = 0
      let valLines = 0
      for (const line of chunk.split(/\r?\n/)) {
        if (/^\s*(\/\/|\*)/.test(line)) continue
        if (!ASSERT_LINE.test(line) && !VALUE_LINE.test(line)) continue
        if (ASSERT_LINE.test(line) && SRC_HINT.test(line)) srcLines++
        else valLines++ // 值断言，以及「对运行结果做 match/ok」的行为断言
      }
      if (srcLines === 1 && valLines === 0) {
        oneShotCases++
        const slot = oneShotByFile[f] || (oneShotByFile[f] = { count: 0, names: [] })
        slot.count++
        const nm = chunk.match(/^\s*test(?:\.\w+)?\(\s*['`](.+?)['`]/)
        slot.names.push(nm ? nm[1].slice(0, 56) : '(无名用例)')
      }
    }
  }
  return { pureRegex, oneShotCases, oneShotByFile }
}

function loadRulesBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(RULES_BASELINE, 'utf8'))
    return {
      pureRegexFiles: j.pureRegexFiles || [],
      oneShotCases: j.oneShotCases || 0,
      oneShotByFile: j.oneShotByFile || null, // 旧基线可能没有：那时只报总数
    }
  } catch (_) {
    return null // null = 还没建立基线
  }
}

function saveRulesBaseline({ pureRegex, oneShotCases, oneShotByFile }) {
  const byFile = {}
  for (const k of Object.keys(oneShotByFile).sort()) byFile[k] = oneShotByFile[k].count
  fs.writeFileSync(RULES_BASELINE, JSON.stringify({
    note: '测试规则的度量基线（README §0.5）：纯读+正则的文件清单、单条源码断言且无行为断言的用例数（含按文件分布）。只降不升，由 npm run check:guards:update 维护。',
    pureRegexFiles: [...pureRegex].sort(),
    oneShotCases,
    oneShotByFile: byFile,
  }, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const { perFile, deadPins, badPins, files } = scan()
const rules = scanRules(files)
const rulesBase = loadRulesBaseline()
const baseline = loadBaseline()
const firstRun = Object.keys(baseline).length === 0

const grown = []   // 超基线 = 新增了散点守卫
const shrunk = []  // 低于基线 = 已补 @pin / 已删守卫，可下调

for (const f of perFile) {
  const base = baseline[f.key]
  if (base === undefined) {
    if (f.bare > 0) grown.push({ ...f, base: 0 })
  } else if (f.bare > base) {
    grown.push({ ...f, base })
  } else if (f.bare < base) {
    shrunk.push({ ...f, base })
  }
}

const totalBare = perFile.reduce((s, f) => s + f.bare, 0)
const totalPinned = perFile.reduce((s, f) => s + f.pinned, 0)

// §0.5 的差异（基线不存在时一律不判，先让人建立基线）
const newPure = rulesBase ? rules.pureRegex.filter((f) => !rulesBase.pureRegexFiles.includes(f)) : []
const gonePure = rulesBase ? rulesBase.pureRegexFiles.filter((f) => !rules.pureRegex.includes(f)) : []
const oneShotGrown = rulesBase ? Math.max(0, rules.oneShotCases - rulesBase.oneShotCases) : 0
const oneShotShrunk = rulesBase ? Math.max(0, rulesBase.oneShotCases - rules.oneShotCases) : 0
// 按文件定位「谁变差了」：文件名比用例名稳定（用例改名不该触发闸门）
const oneShotGrownFiles = rulesBase && rulesBase.oneShotByFile
  ? Object.entries(rules.oneShotByFile)
    .map(([f, v]) => ({ f, now: v.count, base: rulesBase.oneShotByFile[f] || 0 }))
    .map((x) => ({ ...x, added: x.now - x.base }))
    .filter((x) => x.added > 0)
    .sort((a, b) => b.added - a.added)
  : []

console.log('== 守卫台账 ==')
console.log(`测试文件 ${perFile.length} 个 · 源码断言 ${totalBare + totalPinned} 条`
  + ` · 已登记 @pin ${totalPinned} 条 · 未登记 ${totalBare} 条`)

if (deadPins.length) {
  console.log(`\n✗ 失效锚点 ${deadPins.length} 条 —— 这些断言已无法失败，应当删除：`)
  for (const d of deadPins.slice(0, 30)) console.log(`   · ${d.file}:${d.line}  @pin ${d.pin}  （${d.why}）`)
  if (deadPins.length > 30) console.log(`   … 另有 ${deadPins.length - 30} 条`)
}
if (badPins.length) {
  console.log(`\n✗ 锚点写法错误 ${badPins.length} 条：`)
  for (const d of badPins.slice(0, 10)) console.log(`   · ${d.file}:${d.line}  @pin ${d.pin}  （${d.why}）`)
}

if (grown.length) {
  console.log(`\n✗ 新增未登记源码断言（存量只降不升）：${grown.length} 个文件`)
  for (const g of grown.slice(0, 20)) {
    console.log(`   · ${g.file}  ${g.bare} 条（基线 ${g.base}）行 ${g.bareLines.slice(-5).join(', ')}`)
  }
  console.log('   修法：给断言补一行  // @pin 源码相对路径#符号名')
} else {
  console.log('\n✓ 无新增未登记源码断言')
}

if (shrunk.length) {
  console.log(`\n· 可下调基线 ${shrunk.length} 个文件（少了 ${shrunk.reduce((s, x) => s + (x.base - x.bare), 0)} 条）`
    + '：npm run check:guards:update')
}

// ---------------------------------------------------------------------------
// §0.5 输出
// ---------------------------------------------------------------------------
console.log('\n== 测试规则度量（README §0.5）==')
console.log(`纯读+正则的文件 ${rules.pureRegex.length} 个`
  + ` · 单条源码断言且无行为断言的用例 ${rules.oneShotCases} 个`)

if (!rulesBase) {
  console.log('· 还没有度量基线：跑一次 npm run check:guards:update 建立')
} else {
  if (newPure.length) {
    console.log(`\n✗ 新增纯读+正则的测试文件 ${newPure.length} 个 —— 这类文件只读源码、从不执行产品代码：`)
    for (const f of newPure.slice(0, 20)) console.log(`   · ${f}`)
    console.log('   它红了，人判断不了是「写法变了」还是「真坏了」。改法二选一：')
    console.log('   a) 让它真跑：require/动态 import 产品模块，或抽函数体用 new Function 执行；')
    console.log('   b) 确实不能真跑（读 .vue 模板/样式）→ 并进已有的同类文件，不要新建。')
  }
  if (oneShotGrown) {
    console.log(`\n✗ 单条源码断言且无行为断言的用例多了 ${oneShotGrown} 个`
      + `（基线 ${rulesBase.oneShotCases} → 现 ${rules.oneShotCases}）—— 这是「一个 bug 一条散点守卫」的形态：`)
    if (oneShotGrownFiles.length) {
      for (const g of oneShotGrownFiles.slice(0, 12)) console.log(`   · ${g.f}  ${g.base} → ${g.now}`)
    } else {
      console.log('   （基线没记按文件分布，跑一次 --update 后可定位到文件）')
    }
    console.log('   改法：补成行为断言（跑真代码断言输入输出），或并进同族用例；')
    console.log('   只有「确实只能静态判断」时才单独留，并补 @pin 说明它守哪个符号。')
  }
  if (oneShotShrunk) {
    console.log(`\n· 单条守卫用例少了 ${oneShotShrunk} 个，可下调：npm run check:guards:update`)
  }
  if (gonePure.length) {
    console.log(`\n· 纯读+正则文件少了 ${gonePure.length} 个（已改造为真跑），可下调：npm run check:guards:update`)
  }
}

if (TOP) {
  console.log(`\n== 源码断言最多的 ${TOP} 个文件 ==`)
  for (const f of [...perFile].sort((a, b) => b.total - a.total).slice(0, TOP)) {
    console.log(`   ${String(f.total).padStart(3)} 条  ${f.file}`)
  }
}

if (UPDATE) {
  // --update 只允许下调或新增已知文件，不允许悄悄抬高（否则等于自己给自己放水）
  // 只记 bare>0 的文件：已经全部登记 @pin 的文件不需要一行基线，少一行噪音。
  const next = {}
  for (const f of perFile) {
    if (f.bare === 0) continue
    const base = baseline[f.key]
    next[f.key] = base === undefined ? f.bare : Math.min(base, f.bare)
  }
  const raised = Object.keys(next).filter((k) => baseline[k] !== undefined && next[k] > baseline[k])
  if (raised.length) {
    console.error('\n拒绝写入：以下文件实测值高于基线，不能用 --update 抬高：' + raised.join(', '))
    process.exit(1)
  }
  // 度量基线同样只许下调：变差的正确解法是改进，不是放宽阈值。
  if (rulesBase && (newPure.length || oneShotGrown)) {
    console.error('\n拒绝写入测试规则基线：实测结果比基线差 ——')
    if (newPure.length) console.error(`  新增纯读+正则文件 ${newPure.length} 个：${newPure.slice(0, 8).join(', ')}`)
    if (oneShotGrown) console.error(`  单条守卫用例 ${rulesBase.oneShotCases} → ${rules.oneShotCases}（+${oneShotGrown}）`)
    console.error('  先按上面的提示改好（让它真跑 / 补行为断言），再跑 --update。')
    process.exit(1)
  }
  saveBaseline(next)
  saveRulesBaseline(rules)
  console.log(`\n已写基线：${path.relative(ROOT, BASELINE).replace(/\\/g, '/')}`)
  console.log(`已写基线：${path.relative(ROOT, RULES_BASELINE).replace(/\\/g, '/')}`)
  process.exit(0)
}

const failed = deadPins.length + badPins.length + grown.length + newPure.length + (oneShotGrown ? 1 : 0)
if (REPORT_ONLY) {
  console.log('\n(--report：不判成败)')
  process.exit(0)
}
if (firstRun && !failed) {
  console.log('\n提示：基线还是空的，先跑一次 npm run check:guards:update 建立基线。')
  process.exit(0)
}
process.exit(failed ? 1 : 0)
