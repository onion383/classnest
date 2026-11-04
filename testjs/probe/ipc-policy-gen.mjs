// 生成 IPC 授权表（通道 → 允许的窗口角色）。
//
// 判定规则（两段）：
//   1) 调用点文件位于 src/subwindows/<role>/** → 角色就是 <role>
//   2) 调用点文件是公共模块（src/ 根下）→ 角色 = 「能 import 到它的入口集合」
//      （一个公共模块被多个窗口 import 时，它内部的调用就在多个窗口里都可能发生）
//   例外：electronChannels.js 只是常量表，不含调用，不参与判定。
//
// 输出 electron/ipc-policy.json（主进程与 preload 共用的唯一授权来源）。
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(process.argv[2] || '.')
// 入口路径相对 ROOT 解析（不能相对进程 cwd，否则从仓库根跑时全部解析失败）
const ENTRIES = {
  main: 'src/main.js',
  widget: 'src/subwindows/widget/main.js',
  'desktop-widget': 'src/subwindows/desktop-widget/main.js',
  setup: 'src/subwindows/setup/main.js',
  migration: 'src/subwindows/migration/main.js',
}
// 两条正则分开写：
//   1) 静态 import/export ... from '...'（含副作用 import '...'）
//   2) 动态 import('...') —— 路由懒加载全靠它，且**不在行首**，
//      早先用一条带行首锚点的正则把整个 views/ 目录漏掉了（表现为「无授权」）。
const STATIC_RE = /(?:^|[\s;{}()])import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|[\s;{}()])export\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveSpec(baseDir, spec) {
  const p = path.resolve(baseDir, spec)
  for (const c of [p, p + '.js', p + '.mjs', p + '.vue', path.join(p, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c } catch (_) {}
  }
  return null
}
function importsOf(file) {
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch (_) { return [] }
  const specs = []
  let m
  STATIC_RE.lastIndex = 0
  while ((m = STATIC_RE.exec(src))) {
    const spec = m[1] || m[2]
    if (spec) specs.push(spec)
  }
  DYNAMIC_RE.lastIndex = 0
  while ((m = DYNAMIC_RE.exec(src))) specs.push(m[1])
  const out = []
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue
    const d = resolveSpec(path.dirname(file), spec)
    if (d) out.push(d)
  }
  return out
}
function reachable(entry) {
  const seen = new Set()
  const stack = [path.resolve(entry)]
  while (stack.length) {
    const f = stack.pop()
    if (!f || seen.has(f)) continue
    seen.add(f)
    for (const d of importsOf(f)) if (!seen.has(d)) stack.push(d)
  }
  return seen
}
const reach = {}
for (const [k, v] of Object.entries(ENTRIES)) reach[k] = reachable(path.join(ROOT, v))

const ROLE_DIR = {
  widget: 'subwindows/widget',
  'desktop-widget': 'subwindows/desktop-widget',
  setup: 'subwindows/setup',
  migration: 'subwindows/migration',
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

function rolesForFile(f) {
  for (const [role, dir] of Object.entries(ROLE_DIR)) {
    if (rel(f).startsWith('src/' + dir + '/')) return [role]
  }
  if (rel(f) === 'setup.html') return ['setup']
  if (rel(f).startsWith('src/')) {
    const roles = []
    for (const [role, set] of Object.entries(reach)) if (set.has(f)) roles.push(role)
    return roles
  }
  return []
}

const channels = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../electron/ipc-channels.json'), 'utf8'))
const toKey = (n) => n.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()

const files = []
;(function walk(d) {
  let es
  try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|vue|mjs|html)$/.test(e.name)) files.push(p)
  }
})(path.join(ROOT, 'src'))
for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.html')) files.push(path.join(ROOT, f))

const CONST_FILE = 'src/electronChannels.js'
// 人工覆盖：静态图推导不出调用方、但**能力应当保留**的通道。
// 键 = 通道名，值 = 允许的角色数组。
//   set-db-encryption：后端 POST /api/account/db-encryption 与迁移窗的 crypt 模式都已就绪，
//     只是设置页还没接入口（能力备好、入口未接）。删掉等于连后端接口与迁移窗分支一起废，
//     补个设置项就能用 —— 所以保留并授权给主窗口。
//   （用「当前无调用方但保留」的方式记在这里，而不是直接改 ipc-policy.json：
//     策略文件是**生成物**，人工改会被下次重跑覆盖。）
const OVERRIDE = {
  'set-db-encryption': ['main'],
}

const policy = {}
const evidence = {}
for (const list of ['send', 'invoke']) {
  const KEY = list === 'send' ? 'SEND' : 'INVOKE'
  for (const name of channels[list]) {
    const tk = toKey(name)
    const re1 = new RegExp('\\b' + KEY + '\\.' + tk + '\\b')
    const re2 = new RegExp("(invoke|send|on)\\(\\s*['\"]" + name.replace(/[-]/g, '\\-') + "['\"]")
    const roles = new Set()
    const sites = []
    for (const f of files) {
      if (rel(f) === CONST_FILE) continue
      let src
      try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
      if (!src.includes(tk) && !src.includes(name)) continue
      if (!re1.test(src) && !re2.test(src)) continue
      sites.push(rel(f))
      rolesForFile(f).forEach((r) => roles.add(r))
    }
    if (OVERRIDE[name]) {
      for (const r of OVERRIDE[name]) roles.add(r)
    }
    policy[name] = [...roles].sort()
    evidence[name] = sites
  }
}
const out = { _comment: '通道 → 允许的窗口角色（由静态 import 图推导，见 testjs/probe/ipc-policy-probe.cjs）', ...policy }
fs.writeFileSync(path.resolve(ROOT, '../electron/ipc-policy.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify({ policy, evidence }, null, 1))
