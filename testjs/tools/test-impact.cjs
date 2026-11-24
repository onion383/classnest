#!/usr/bin/env node
// test-impact.cjs —— 按改动文件挑相关单测，避免"改一行跑全量"
//
// 用法：
//   node testjs/tools/test-impact.cjs                 看工作区改动（含未跟踪）命中哪些单测
//   node testjs/tools/test-impact.cjs --since=HEAD~1  看某个提交范围的改动
//   node testjs/tools/test-impact.cjs --path=a.js,b.js  模拟改动（只读验证用）
//   node testjs/tools/test-impact.cjs --run            直接跑选中的单测
//   node testjs/tools/test-impact.cjs --json           输出机器可读结果
//
// 选测依据（只读扫描，不要求给现有测试加元数据）：
//   1. 测试文件里出现的源码路径字面量（student-frontend/…、electron/… 等）
//   2. 头部 WATCH: 显式声明的监视路径（新增测试建议写上，优先维护）
// 命中后输出可直接粘的 `run-units.js --only=…` 命令；零命中时提示跑全量，
// 避免"选择器漏了"被误当成"改动安全"。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const UNITS = path.join(ROOT, 'testjs/units')
const SOURCE_EXT = '(?:js|mjs|cjs|vue|css|scss|json|html|iss|ps1)'
const SOURCE_ROOT = 'student-frontend|student-backend|electron|config|testjs'
const PATH_LITERAL = new RegExp(`['"]((?:${SOURCE_ROOT})/[^'"\\n]+\\.${SOURCE_EXT})['"]`, 'g')

function git(args) {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
  } catch (_) {
    return ''
  }
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function watchedBy(fileName) {
  const text = fs.readFileSync(path.join(UNITS, fileName), 'utf8')
  const out = new Set()
  for (const m of text.matchAll(PATH_LITERAL)) out.add(normalize(m[1]))
  for (const m of text.matchAll(/(?:^|\n)[^\n]*WATCH:\s*([^\n]+)/g)) {
    for (const p of m[1].split(/[,\s]+/)) {
      if (p && SOURCE_ROOT.split('|').some((r) => p.startsWith(r + '/'))) out.add(normalize(p))
    }
  }
  return [...out]
}

function hit(changed, watched) {
  if (changed === watched) return true
  if (watched.endsWith('/')) return changed.startsWith(watched)
  if (changed.startsWith(watched + '/')) return true
  return watched.startsWith(changed + '/')
}

function parseArgs(argv) {
  const opt = { since: 'HEAD', paths: [], run: false, json: false, all: false }
  for (const a of argv) {
    if (a.startsWith('--since=')) opt.since = a.slice(8)
    else if (a.startsWith('--path=')) opt.paths.push(...a.slice(7).split(',').map(normalize).filter(Boolean))
    else if (a === '--run') opt.run = true
    else if (a === '--json') opt.json = true
    else if (a === '--all') opt.all = true
  }
  return opt
}

function changedFiles(opt) {
  if (opt.paths.length) return opt.paths
  const tracked = git(['diff', '--name-only', opt.since])
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  return [...new Set([tracked, untracked].join('\n').split('\n').map(normalize).filter(Boolean))].filter(
    (p) => !p.startsWith('doc/') && !p.startsWith('.workbuddy/') && p !== 'code-stats.md',
  )
}

const opt = parseArgs(process.argv.slice(2))
const allTests = fs.readdirSync(UNITS).filter((f) => f.endsWith('.test.js')).sort()
const changed = changedFiles(opt)
const selected = []
for (const file of allTests) {
  if (opt.all) { selected.push(file); continue }
  const watched = watchedBy(file)
  if (watched.some((w) => changed.some((c) => hit(c, w)))) selected.push(file)
}

const cmd = ['node', 'testjs/run-units.js', ...selected.map((f) => `--only=${f}`)].join(' ')

if (opt.json) {
  console.log(JSON.stringify({ changed, selected, command: cmd }, null, 2))
} else {
  console.log(`改动文件 ${changed.length} 个，命中单测 ${selected.length}/${allTests.length} 个`)
  if (selected.length) {
    for (const f of selected) console.log('  ' + f)
    console.log('\n跑这些：\n' + cmd)
  } else {
    console.log('零命中：不要当成改动安全，请跑全量 npm test。')
  }
}

if (opt.run) {
  if (!selected.length) {
    console.error('零命中时不执行 --run，请显式跑 npm test')
    process.exit(2)
  }
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'testjs/run-units.js'), ...selected.map((f) => `--only=${f}`)], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}
