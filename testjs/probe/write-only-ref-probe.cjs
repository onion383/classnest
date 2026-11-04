// =========================================================================
// write-only-ref-probe.cjs —— 扫「只写不读」的响应式变量
//
// 为什么需要它：
//   ESLint 的 no-unused-vars 只抓「从未被引用」，而 `result.value = x` 这种
//   赋值算作引用 —— 于是「存了但永远没人读」的 ref 能一路活下来。
//   RollCall.vue 的 result 就是这么留了很久（三次赋值，模板里一次没读）。
//
// 判据（两层，缺一不可）：
//   1. **<script> 内**：名字出现，且不是赋值左边（`X =` / `X.value =`）→ 算读取
//   2. **<template> 的表达式**：只认 `{{ ... }}` 插值和 `:x=` / `v-x=` / `@x=` / `#x=`
//      这类指令属性的值 —— **不算** `class="result-card"` 里的子串
//      （旧版 RollCall 的 `class="result-card"` 就骗过了第一版探针，导致假阴性）
//   3. `<style>` 完全不参与判据（`.result-card{}` 同样会骗过匹配）
//
// 豁免：
//   - `defineExpose({ X })` 算读取（父组件会读）
//   - 以 _ 开头的名字跳过（约定为有意占位）
//   - `X.value++` / `X.value += 1` 算读取（保守，避免误报）
//
// 用法：
//   node testjs/probe/write-only-ref-probe.cjs            # 扫 student-frontend/src
//   node testjs/probe/write-only-ref-probe.cjs --file=<路径>
//   node testjs/probe/write-only-ref-probe.cjs --json
// 退出码：0 = 没命中；1 = 有命中
// =========================================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../..')
const TARGET_DIRS = ['student-frontend/src']
const singleFile = (process.argv.find(a => a.startsWith('--file=')) || '').slice('--file='.length)

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      walk(p, out)
    } else if (/\.(vue|js)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

// 只取模板里真正会成为 JS 表达式的片段：插值 + 指令/绑定/事件属性的值。
// 刻意排除 class / style / 普通文本 —— 它们只是字符串，不是对变量的读取。
function templateExpressions(tpl) {
  const parts = []
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) parts.push(m[1])
  for (const m of tpl.matchAll(/(?:^|\s)(?::|v-|@|#)[\w:.-]+\s*=\s*"([^"]*)"/g)) parts.push(m[1])
  for (const m of tpl.matchAll(/(?:^|\s)(?::|v-|@|#)[\w:.-]+\s*=\s*'([^']*)'/g)) parts.push(m[1])
  return parts.join('\n')
}

// 拆 SFC：模板 / 脚本 / （样式丢弃）。scriptOffset 用于把 script 内行号换算成文件行号
function splitSfc(raw) {
  const tplMatch = raw.match(/<template[^>]*>([\s\S]*)<\/template>/)
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g
  const scripts = []
  let firstStart = -1
  let m
  while ((m = scriptRe.exec(raw))) {
    if (firstStart < 0) firstStart = m.index
    scripts.push(m[1])
  }
  if (!scripts.length) return { tpl: '', script: raw, scriptStartLine: 0 }
  return {
    tpl: tplMatch ? tplMatch[1] : '',
    script: scripts.join('\n'),
    scriptStartLine: raw.slice(0, firstStart).split('\n').length - 1,
  }
}

const DEF_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|reactive|shallowRef|computed|toRef|shallowReactive)\s*(?:<[^>]*>)?\(/g

// 名字的独立出现：不能用 `(?<![\w$.])` 排除前置的 `.` ——
// `[...X.value]` 这种展开写法里，`X` 前面也是 `.`（来自 `...`），会被误判成属性访问而漏掉，
// 于是「明明读了」被报成「只写不读」。改为只排除标识符字符，点号在循环里手工判。
function nameRe(name) {
  return new RegExp('(?<![\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g')
}

// 这个匹配是「obj.X」形式的属性访问吗（区别于 spread 的 ...X）
function isPropertyAccess(code, index) {
  if (index === 0) return false
  const prev = code[index - 1]
  if (prev !== '.') return false
  // `...` 是展开运算符 → 不是属性访问
  return code[index - 2] !== '.'
}

function usedAsRead(name, code, skipIndex) {
  const re = nameRe(name)
  let m
  while ((m = re.exec(code))) {
    if (m.index === skipIndex) continue
    if (isPropertyAccess(code, m.index)) continue
    const after = code.slice(m.index + name.length)
    // 赋值左边：X = ... / X.value = ...（排除 == / === / =>）
    if (/^\s*\.value\s*=(?!=)/.test(after)) continue
    if (/^\s*=(?![=>])/.test(after)) continue
    return true
  }
  return false
}

function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const { tpl, script, scriptStartLine } = splitSfc(raw)
  const scriptCode = stripComments(script)
  // 模板表达式里出现即算读取
  const tplCode = stripComments(templateExpressions(tpl))

  const hits = []
  let m
  DEF_RE.lastIndex = 0
  while ((m = DEF_RE.exec(scriptCode))) {
    const name = m[1]
    if (name.startsWith('_')) continue
    const defIndex = m.index + m[0].indexOf(name)
    if (usedAsRead(name, scriptCode, defIndex)) continue
    if (tplCode && nameRe(name).test(tplCode)) continue
    const line = scriptStartLine + scriptCode.slice(0, m.index).split('\n').length
    hits.push({ file: path.relative(ROOT, file), line, name })
  }
  return hits
}

const files = singleFile
  ? [path.resolve(ROOT, singleFile)]
  : TARGET_DIRS.flatMap(d => walk(path.join(ROOT, d)))
const all = files.flatMap(scanFile)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(all, null, 2))
} else if (all.length === 0) {
  console.log(`✓ 没发现「只写不读」的响应式变量（扫描 ${files.length} 个文件）`)
} else {
  console.log(`发现 ${all.length} 处「只写不读」：`)
  for (const h of all) console.log(`  ${h.file}:${h.line}  ${h.name}`)
}
process.exit(all.length ? 1 : 0)
