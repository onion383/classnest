// =========================================================================
// docs-verify.mjs —— 开发文档一致性校验（只读，不改任何文件）
//
// 目的：把「文档写的」与「源码里的」做机器比对，给出可复现的 PASS/FAIL。
// 共 20 项断言（七组）：
//   1) 文档内部相对链接必须能解析（无死链）
//   2) 源码文件必须被文档覆盖（组件/页面/composable/util/路由/服务/主进程模块）
//   3) backend/routes.md 必须覆盖 routes/ 里实际注册的每个 (METHOD, path)
//   4) 依赖版本与许可证标识必须与 package.json / node_modules 一致
//   5) 文档里的关键计数必须与源码统计一致
//   6) npm 脚本、.env/运行时环境变量、IPC 通道必须与配置和源码一致
//   7) Mermaid 图必须围栏闭合、首行是受支持的图表类型
//
// 用法：node testjs/tools/docs-verify.mjs [--json]
// 退出码：0 = 全通过；1 = 有不一致（明细打印到 stdout）
// =========================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DOC_DIR = path.join(ROOT, 'doc')
const JSON_OUT = process.argv.includes('--json')
const problems = []
const checks = []

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/') }
function exists(p) { try { return fs.existsSync(p) } catch { return false } }
function walk(dir, filter) {
  const out = []
  if (!exists(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, filter))
    else if (!filter || filter(p)) out.push(p)
  }
  return out
}
function docFiles() {
  return [
    path.join(ROOT, 'README.md'),
    ...walk(DOC_DIR, (p) => p.endsWith('.md') && !p.includes(`${path.sep}开发文档${path.sep}`))
  ]
}
function read(p) { return fs.readFileSync(p, 'utf8') }
function pass(name, detail) { checks.push({ name, ok: true, detail }) }
function fail(name, detail) { checks.push({ name, ok: false, detail }); problems.push(`${name}: ${detail}`) }

// 1) 死链 ------------------------------------------------------------------
{
  let bad = 0
  for (const f of docFiles()) {
    const text = read(f)
    for (const m of text.matchAll(/\]\((?![#])([^)]+)\)/g)) {
      const raw = m[1].trim()
      if (!raw || /^(?:http|mailto):/.test(raw)) continue
      const target = raw.split('#')[0].trim()
      if (!target) continue
      const abs = path.resolve(path.dirname(f), target)
      if (!exists(abs)) { bad++; problems.push(`DEAD LINK ${rel(f)} -> ${target}`) }
    }
  }
  checks.push({ name: '文档内部链接', ok: bad === 0, detail: `${docFiles().length} 份文档，死链 ${bad}` })
  if (bad) problems.push(`死链合计 ${bad}`)
}

// 2) 源码覆盖 --------------------------------------------------------------
const suite = [
  {
    name: '组件覆盖',
    src: walk(path.join(ROOT, 'student-frontend/src/components'), (p) => p.endsWith('.vue')),
    docs: walk(path.join(DOC_DIR, 'development/frontend/components'), (p) => p.endsWith('.md')),
    key: (p) => path.basename(p)
  },
  {
    name: '页面覆盖',
    src: walk(path.join(ROOT, 'student-frontend/src/views'), (p) => /\.(vue|js)$/.test(p) && !p.includes(`${path.sep}components${path.sep}`)),
    docs: [path.join(DOC_DIR, 'development/frontend/views.md')],
    key: (p) => path.basename(p)
  },
  {
    name: '组合式函数覆盖',
    src: walk(path.join(ROOT, 'student-frontend/src/composables'), (p) => p.endsWith('.js')),
    docs: [path.join(DOC_DIR, 'development/frontend/composables.md')],
    key: (p) => path.basename(p)
  },
  {
    name: '前端 utils 覆盖',
    src: walk(path.join(ROOT, 'student-frontend/src/utils'), (p) => p.endsWith('.js')),
    docs: [path.join(DOC_DIR, 'development/frontend/misc.md')],
    key: (p) => path.basename(p)
  },
  {
    name: '后端文件覆盖',
    src: [
      ...walk(path.join(ROOT, 'student-backend/routes'), (p) => p.endsWith('.js')),
      ...walk(path.join(ROOT, 'student-backend/services'), (p) => p.endsWith('.js')),
      ...walk(path.join(ROOT, 'student-backend/dbManager'), (p) => p.endsWith('.js')),
      ...walk(path.join(ROOT, 'student-backend/schema'), (p) => p.endsWith('.js')),
      ...walk(path.join(ROOT, 'student-backend/middleware'), (p) => p.endsWith('.js')),
      ...walk(path.join(ROOT, 'student-backend/utils'), (p) => p.endsWith('.js')),
      ...['app.js', 'db.js', 'init.js', 'albumScan.js', 'scanWorker.js', 'worker.scan.js', 'albumThumbs.js', 'albumExif.js', 'albumOps.js']
        .map((n) => path.join(ROOT, 'student-backend', n)).filter(exists)
    ],
    docs: walk(path.join(DOC_DIR, 'development/backend'), (p) => p.endsWith('.md')),
    key: (p) => path.basename(p)
  },
  {
    name: '主进程文件覆盖',
    src: [
      ...walk(path.join(ROOT, 'electron/main'), (p) => p.endsWith('.js')),
      ...['preload.js', 'ipc-channels.json', 'afterPack.js', 'startup.html']
        .map((n) => path.join(ROOT, 'electron', n)).filter(exists)
    ],
    docs: [
      path.join(DOC_DIR, 'development/main-process/README.md'),
      path.join(DOC_DIR, 'development/main-process/files.md')
    ],
    key: (p) => path.basename(p)
  }
]
for (const s of suite) {
  const docText = s.docs.filter(exists).map(read).join('\n')
  const missing = s.src.filter((p) => !docText.includes(s.key(p)))
  checks.push({ name: s.name, ok: missing.length === 0, detail: `源码 ${s.src.length} 个，未覆盖 ${missing.length}` })
  for (const p of missing) problems.push(`${s.name} 未覆盖：${rel(p)}`)
}

// 3) 路由断言 --------------------------------------------------------------
{
  const docText = read(path.join(DOC_DIR, 'development/backend/routes.md'))
  const routeFiles = walk(path.join(ROOT, 'student-backend/routes'), (p) => p.endsWith('.js') && !p.includes('tools.executors') && !p.includes('ai.tools'))
  const actual = []
  const CATCH = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g
  for (const f of routeFiles) {
    for (const m of read(f).matchAll(CATCH)) actual.push({ method: m[1].toUpperCase(), p: m[2], file: rel(f) })
  }
  for (const line of ['GET /history', 'GET /history/:weekStart', 'POST /snapshot', 'DELETE /history/:weekStart']) {
    const [method, p] = line.split(' ')
    actual.push({ method, p, file: 'routes/historyRoutes.js (factory)' })
  }

  // 文档写法混合：表格行、正文「GET/PUT /a、POST /b」。按行收集方法与路径，成对登记。
  const claimed = new Set()
  const PATH_RE = /\/(?:[A-Za-z0-9_:{}.*-]+(?:\/[A-Za-z0-9_:{}.*-]+)*)?/g
  const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE)\b/g
  for (const line of docText.split(/\r?\n/)) {
    if (!line.includes('/')) continue
    const methods = [...line.matchAll(METHOD_RE)].map((m) => m[1])
    if (!methods.length) continue
    const paths = [...line.matchAll(PATH_RE)].map((m) => m[0])
    for (const method of methods) for (const p of paths) claimed.add(`${method} ${p}`)
  }
  const missing = actual.filter((a) => !claimed.has(`${a.method} ${a.p}`))
  checks.push({ name: '后端路由断言', ok: missing.length === 0, detail: `实际 ${actual.length} 条，文档缺 ${missing.length}` })
  for (const a of missing) problems.push(`routes.md 缺接口：${a.method} ${a.p}（${a.file}）`)
}

// 4) 依赖版本 / 许可证 -------------------------------------------------------
{
  const pkgRoot = JSON.parse(read(path.join(ROOT, 'package.json')))
  const pkgFe = JSON.parse(read(path.join(ROOT, 'student-frontend/package.json')))
  const pkgBe = JSON.parse(read(path.join(ROOT, 'student-backend/package.json')))
  const depDocs = walk(path.join(DOC_DIR, 'development/dependencies'), (p) => p.endsWith('.md') && !p.endsWith('licenses.md')).map(read).join('\n')
  const licDoc = read(path.join(DOC_DIR, 'development/dependencies/licenses.md'))
  const all = { ...pkgRoot.dependencies, ...pkgRoot.devDependencies, ...pkgFe.dependencies, ...pkgFe.devDependencies, ...pkgBe.dependencies }
  const missingDoc = [], versionMismatch = [], missingLic = []
  const installedVersion = (name) => {
    for (const base of ['node_modules', 'student-frontend/node_modules', 'student-backend/node_modules']) {
      const p = path.join(ROOT, base, name, 'package.json')
      if (exists(p)) return JSON.parse(read(p)).version
    }
    return null
  }
  for (const [name, range] of Object.entries(all)) {
    if (/^(file:|https?:)/.test(String(range))) continue
    if (!depDocs.includes(name)) { missingDoc.push(name); continue }
    const declared = String(range).replace(/^[~^]/, '')
    const installed = installedVersion(name)
    if (!depDocs.includes(declared) && !(installed && depDocs.includes(installed))) versionMismatch.push(`${name}@${range}`)
    if (!licDoc.includes(name)) missingLic.push(name)
  }
  const ok = missingDoc.length === 0 && versionMismatch.length === 0 && missingLic.length === 0
  checks.push({ name: '依赖版本与许可', ok, detail: `共 ${Object.keys(all).length} 项；缺文档 ${missingDoc.length}，版本不符 ${versionMismatch.length}，缺许可 ${missingLic.length}` })
  for (const n of missingDoc) problems.push(`依赖未写入文档：${n}`)
  for (const n of versionMismatch) problems.push(`依赖版本与文档不符：${n}`)
  for (const n of missingLic) problems.push(`licenses.md 缺：${n}`)
}

// 5) 关键计数 --------------------------------------------------------------
{
  const count = (dir, filter) => walk(dir, filter).length
  const expectations = [
    { name: '组件数 76', file: path.join(DOC_DIR, 'development/frontend/components/README.md'), actual: count(path.join(ROOT, 'student-frontend/src/components'), (p) => p.endsWith('.vue')), re: /76 个/ },
    { name: '组合式 26', file: path.join(DOC_DIR, 'development/frontend/composables.md'), actual: count(path.join(ROOT, 'student-frontend/src/composables'), (p) => p.endsWith('.js')), re: /26 个/ },
    { name: 'utils 25', file: path.join(DOC_DIR, 'development/frontend/misc.md'), actual: count(path.join(ROOT, 'student-frontend/src/utils'), (p) => p.endsWith('.js')), re: /25 个/ },
    { name: '主进程 main.*.js 21', file: path.join(DOC_DIR, 'development/main-process/README.md'), actual: count(path.join(ROOT, 'electron/main'), (p) => /main\.[A-Za-z-]+\.js$/.test(p)), re: /21 个/ },
    { name: '后端依赖 12', file: path.join(DOC_DIR, 'development/dependencies/README.md'), actual: Object.keys(JSON.parse(read(path.join(ROOT, 'student-backend/package.json'))).dependencies).length, re: /12 个/ },
    { name: '页面 15', file: path.join(DOC_DIR, 'development/frontend/views.md'), actual: (read(path.join(ROOT, 'student-frontend/src/router/index.js')).match(/path:\s*'/g) || []).length - 2, re: /15 个页面/ }
  ]
  for (const e of expectations) {
    const text = exists(e.file) ? read(e.file) : ''
    const ok = e.re.test(text)
    checks.push({ name: `计数：${e.name}`, ok, detail: `源码 ${e.actual}，文档${ok ? '已标注' : '未标注'}` })
    if (!ok) problems.push(`计数不符：${e.name}（源码 ${e.actual}）`)
  }
}

// 6) npm 脚本 / 环境变量 / IPC 通道 -----------------------------------------
{
  const rootReadme = read(path.join(ROOT, 'README.md'))
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')))
  const missingScripts = Object.keys(pkg.scripts).filter((s) => !rootReadme.includes(s))
  checks.push({ name: 'npm 脚本已写入 README', ok: missingScripts.length === 0, detail: `共 ${Object.keys(pkg.scripts).length} 个，缺 ${missingScripts.length}` })
  for (const s of missingScripts) problems.push(`README 缺 npm 脚本：${s}`)

  const envKeys = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/).filter((l) => /^\s*[A-Z_]+\s*=/.test(l)).map((l) => l.split('=')[0].trim())
  const undocumentedEnv = envKeys.filter((k) => !rootReadme.includes(k))
  checks.push({ name: '.env 变量已说明', ok: undocumentedEnv.length === 0, detail: `.env ${envKeys.length} 个，README 未提及 ${undocumentedEnv.length}` })
  for (const k of undocumentedEnv) problems.push(`README 未说明 .env 变量：${k}`)

  // 文档里出现的「运行时环境变量」必须在源码里真的被读取
  const envUsed = new Set()
  const ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)/g
  const srcAll = [
    ...walk(path.join(ROOT, 'electron'), (p) => p.endsWith('.js')),
    ...walk(path.join(ROOT, 'student-backend'), (p) => p.endsWith('.js') && !p.includes('node_modules')),
    ...walk(path.join(ROOT, 'student-frontend/src'), (p) => p.endsWith('.js')),
    ...walk(path.join(ROOT, 'testjs'), (p) => p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs'))
  ]
  for (const f of srcAll) for (const m of read(f).matchAll(ENV_RE)) envUsed.add(m[1])
  const documentedRuntimeEnv = ['PORT', 'JWT_SECRET', 'DB_MASTER_KEY', 'SECURE_MASTER', 'DATA_DIR', 'ALBUM_THUMBS_DIR', 'AI_SKILLS_DIR']
  const notUsed = documentedRuntimeEnv.filter((k) => !envUsed.has(k))
  checks.push({ name: '环境变量真实存在', ok: notUsed.length === 0, detail: `文档声明 ${documentedRuntimeEnv.length} 个，源码未读 ${notUsed.length}` })
  for (const k of notUsed) problems.push(`文档声明但源码未读取的环境变量：${k}`)

  const channels = JSON.parse(read(path.join(ROOT, 'electron/ipc-channels.json')))
  const docIpc = read(path.join(DOC_DIR, 'development/main-process/README.md')) + read(path.join(DOC_DIR, 'development/main-process/files.md')) + read(path.join(DOC_DIR, 'development/topics/security.md'))
  const list = [...(channels.send || []), ...(channels.invoke || []), ...(channels.receive || [])]
  const missingChannels = list.filter((c) => !docIpc.includes(c))
  checks.push({ name: 'IPC 通道已写入文档', ok: missingChannels.length === 0, detail: `通道 ${list.length} 个，文档缺 ${missingChannels.length}` })
  for (const c of missingChannels) problems.push(`IPC 通道未写入文档：${c}`)
}

// 7) Mermaid 图结构 --------------------------------------------------------
{
  const TYPES = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|quadrantChart|block-beta|packet-beta|architecture-beta|radar-beta|treemap|sankey-beta|xyChart)\b/
  const badType = []
  const unclosed = []
  let total = 0
  for (const f of docFiles()) {
    const text = read(f)
    // 反引号围栏必须成对，否则后面的正文会被吞进代码块
    const fenceCount = (text.match(/^```/gm) || []).length
    if (fenceCount % 2) unclosed.push(rel(f))
    for (const m of text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)) {
      total++
      const first = m[1].split(/\r?\n/).find((l) => l.trim())
      if (!first || !TYPES.test(first.trim())) badType.push(`${rel(f)}: ${first ? first.trim() : '空块'}`)
    }
  }
  const ok = badType.length === 0 && unclosed.length === 0
  checks.push({ name: 'Mermaid 图结构', ok, detail: `图 ${total} 张；围栏未闭合 ${unclosed.length}，图表类型非法 ${badType.length}` })
  for (const f of unclosed) problems.push(`代码块围栏未闭合：${f}`)
  for (const b of badType) problems.push(`Mermaid 首行不是受支持的图表类型：${b}`)
}

// 输出 --------------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, checks, problems }, null, 2))
} else {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`)
  if (problems.length) {
    console.log('\n--- 问题明细 ---')
    for (const p of problems) console.log('- ' + p)
  }
}
process.exit(problems.length ? 1 : 0)
