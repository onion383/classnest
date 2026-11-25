#!/usr/bin/env node
// =========================================================================
// error-boundary-check.cjs —— 错误处理边界扫描
//
// 只做两件事：
//   1) 找出「空 catch / 静默 .catch(()=>{})」，要求同一行或上一行写 `// best-effort: 原因`；
//   2) 统计 catch / console.error 数量，给评审一个可对比的基线。
//
// 默认发现未标注的静默捕获就 exit 1（N1-24：只报告不拦的时代已过，存量清零后默认即闸门）；
// --report-only 显式保留「只报告不拦」的报告用途；--strict 兼容既有 CI 调用（等价于默认）。
// 不扫描 node_modules / release / release36 / release4 / dist / .vite / .git（见 SKIP_DIRS），
// 也不扫 build.bundle.mjs 的产物 app.bundle.js（2.9MB 生成物，源码里的空 catch 在里面
// 被原样保留，扫它等于把同一处违规数两遍，且没人会给生成物补注释）。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const TARGETS = ['electron', 'student-backend', path.join('student-frontend', 'src')]
const EXTS = new Set(['.js', '.cjs', '.mjs', '.vue'])
// release4 为旧产物目录名，保留跳过避免历史目录被误扫
const SKIP_DIRS = new Set(['node_modules', 'release', 'release36', 'release4', 'dist', '.vite', '.git'])

const args = new Set(process.argv.slice(2))
// 默认即闸门；--report-only 只报告；--strict 是历史别名，行为同默认（CI 已在用，无需特判）。
const reportOnly = args.has('--report-only')

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(path.join(dir, ent.name), out)
    } else if (EXTS.has(path.extname(ent.name).toLowerCase())) {
      // 打包产物：与 dist 同为生成物，不参与源码质量扫描。
      if (ent.name === 'app.bundle.js') continue
      out.push(path.join(dir, ent.name))
    }
  }
}

const files = []
for (const t of TARGETS) walk(path.join(ROOT, t), files)

// 空 catch 的判定：**按块匹配**，不能只看单行。
//   原来用单行正则 `catch (...) { }` → 多行写法的空 catch（下面注释占几行）完全漏报，
//   而「空 catch」正是这个工具要抓的东西 —— 漏报等于工具失效。
//   做法：把源码里的注释与字符串先抹平（否则注释里的字面量会干扰匹配），
//   再用跨行正则找 `catch (…) {` 后面**只跟空白**的块。
const STRIP_COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const EMPTY_CATCH_BLOCK = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g
const EMPTY_CATCH_ARROW = /\.catch\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/g
const HAS_MARK = /best-effort/i

// catch 计数：只算**真正**的 catch 块起点。
//   原来 `/\bcatch\s*\(/g` 会把 `.catch(` 也算进去 → 分母偏宽 → 覆盖率虚高。
const CATCH_KEYWORD = /(?<![.\w])catch\s*(?:\([^)]*\))?\s*\{/g

let catchCount = 0
let consoleErrorCount = 0
const violations = []

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  // 抹平注释后的整篇文本（用于跨行匹配空 catch）
  const code = raw.replace(STRIP_COMMENTS, (m) => m.replace(/[^\n]/g, ' '))
  const codeLines = code.split(/\r?\n/)

  // ① 跨行空 catch 块：定位所有 `catch (...) {` 且块内只有空白的位置
  const emptyBlockLines = new Set()
  let m
  EMPTY_CATCH_BLOCK.lastIndex = 0
  while ((m = EMPTY_CATCH_BLOCK.exec(code)) !== null) {
    const lineNo = code.slice(0, m.index).split('\n').length
    emptyBlockLines.add(lineNo)
  }

  codeLines.forEach((line, i) => {
    // catch 计数：只算 catch 关键字，不算 .catch(
    catchCount += (line.match(CATCH_KEYWORD) || []).length
    consoleErrorCount += (line.match(/console\.error/g) || []).length

    const isEmpty = emptyBlockLines.has(i + 1) || EMPTY_CATCH_ARROW.test(line)
    if (!isEmpty) return
    // 判 best-effort 标记必须读**原始行** lines[i]，不是抹平注释后的 codeLines[i]：
    // line 参数来自 codeLines，注释已被抹成空格，同行标记永远匹配不到（只有上一行 prev
    // 用原始行才生效）——结果就是同行写 `catch { /* best-effort: 原因 */ }` 仍被误报。
    const rawLine = lines[i] || ''
    const prev = i > 0 ? lines[i - 1] : ''
    if (HAS_MARK.test(rawLine) || HAS_MARK.test(prev)) return
    violations.push({ file: path.relative(ROOT, file), line: i + 1, code: line.trim() })
  })
}

console.log('错误处理边界扫描')
console.log(`  文件：${files.length}  catch：${catchCount}  console.error：${consoleErrorCount}`)
console.log(`  未标注的静默捕获：${violations.length}`)
if (violations.length) {
  const limit = reportOnly ? Math.min(violations.length, 30) : violations.length
  for (const v of violations.slice(0, limit)) {
    console.log(`    ${v.file}:${v.line}  ${v.code}`)
  }
  if (reportOnly && violations.length > limit) console.log(`    …… 其余 ${violations.length - limit} 条`)
  console.log('\n处理方式：给 best-effort 捕获补 `// best-effort: 原因`；业务路径不要静默吞错。')
}

if (!reportOnly && violations.length) process.exit(1)
