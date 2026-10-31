/**
 * bundle-diff.mjs —— 两套构建产物的体积对比（Vue 3.5/VDOM 基线 vs 3.6/Vapor 实验组）
 * ---------------------------------------------------------------------------
 * 为什么需要它：Vapor 的收益不能只看「编译更快」，要落到用户真实支付的字节上。
 * 但全量 dist 里包含 xlsx / exceljs / jspdf 这类懒加载大块，**它们和 Vue 无关**，
 * 混在一起看会把信号淹没。所以本脚本拆三档口径：
 *
 *   ① 首屏闭包 —— index.html 里的 entry chunk，沿**静态 import** 递归闭合
 *                 （动态 import() 不算，那是点进某个页面才付的钱）
 *   ② 逐模块   —— 按「名字-哈希.js」的逻辑名配对，看单文件增减
 *   ③ 全量     —— 目录总字节
 *
 * 体积同时给 raw 与 gzip（zlib 默认 level，两侧同参，可横向比）。
 *
 * 用法：
 *   node testjs/probe/bundle-diff.mjs                       # 默认读 testjs/tmp/bench/dist35|dist36
 *   node testjs/probe/bundle-diff.mjs --a=dirA --b=dirB
 *   node testjs/probe/bundle-diff.mjs --top=40              # 单模块表只列变化最大的 N 行
 *
 * 产物目录怎么来（不动生产配置，各自输出到独立目录）：
 *   node student-frontend/dev-vite.js build --outDir ../testjs/tmp/bench/dist35 --emptyOutDir
 *   node student-frontend/dev-vite.js --vue36 build --outDir ../testjs/tmp/bench/dist36 --emptyOutDir
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/)
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]
  }),
)
const DIR_A = path.resolve(ROOT, args.a || 'testjs/tmp/bench/dist35')
const DIR_B = path.resolve(ROOT, args.b || 'testjs/tmp/bench/dist36')
const TOP = Number(args.top || 25)

for (const d of [DIR_A, DIR_B]) {
  if (!existsSync(d)) {
    console.error(`目录不存在：${d}\n先跑构建（见本文件头部注释）。`)
    process.exit(1)
  }
}

const gz = (buf) => zlib.gzipSync(buf, { level: zlib.constants.Z_DEFAULT_COMPRESSION }).length

/** 逻辑名：`AboutView-DeVW-kPh.js` → `AboutView.js`（保留扩展名，避免 .js/.css 撞名） */
function logicalName(file) {
  const ext = path.extname(file)
  const base = path.basename(file, ext)
  const m = base.match(/^(.+?)-[A-Za-z0-9_-]{8}$/)
  return (m ? m[1] : base) + ext
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 目录快照：逻辑名 → {raw, gzip, file}（同名多份时取最大，理论上不该出现） */
function snapshot(dir) {
  const map = new Map()
  let totalRaw = 0
  let totalGz = 0
  for (const p of walk(dir)) {
    const buf = readFileSync(p)
    totalRaw += buf.length
    totalGz += gz(buf)
    const key = logicalName(p)
    const prev = map.get(key)
    if (!prev || buf.length > prev.raw) {
      map.set(key, { raw: buf.length, gzip: gz(buf), file: path.relative(dir, p).replace(/\\/g, '/') })
    }
  }
  return { map, totalRaw, totalGz }
}

/** 从 index.html 找 entry chunk（首个 type=module 的 script） */
function entryOf(dir) {
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
  const m = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)
  if (!m) throw new Error(`${dir}/index.html 里没找到 module 入口`)
  // 绝对路径写法（/assets/xxx.js）或相对写法都归一成文件名
  return path.basename(m[1])
}

/**
 * 静态 import 闭包。只跟 `from"./x.js"` / `import"./x.js"`，
 * 不跟 `import("./x.js")` —— 动态 import 属于「用到才付」的钱。
 */
function staticClosure(dir, entryFile) {
  const seen = new Set()
  const queue = [entryFile]
  let raw = 0
  let gzip = 0
  while (queue.length) {
    const f = queue.pop()
    if (seen.has(f)) continue
    seen.add(f)
    const p = path.join(dir, 'assets', f)
    if (!existsSync(p)) continue
    const code = readFileSync(p, 'utf8')
    raw += statSync(p).size
    gzip += gz(readFileSync(p))
    // 静态依赖只有两种写法：`… from "./x.js"`（含 export … from）和纯副作用 `import "./x.js"`。
    // 动态 `import("./x.js")` 引号前是 `(`，下面这个正则不匹配它 —— 这是刻意的。
    for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+\.(?:js|mjs))["']/g)) {
      const spec = m[1]
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue
      queue.push(path.basename(spec))
    }
  }
  return { files: seen, raw, gzip }
}

/** 首屏 CSS 闭包：index.html 里所有 rel=stylesheet */
function cssClosure(dir) {
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
  const files = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => path.basename(m[1]))
  let raw = 0
  let gzip = 0
  for (const f of files) {
    const p = path.join(dir, f.includes('/') ? f : path.join('assets', f))
    if (!existsSync(p)) continue
    const buf = readFileSync(p)
    raw += buf.length
    gzip += gz(buf)
  }
  return { files, raw, gzip }
}

const kb = (n) => (n / 1024).toFixed(2)
const signed = (n) => (n >= 0 ? '+' : '−') + Math.abs(n / 1024).toFixed(2)
const pct = (a, b) => (a === 0 ? '—' : ((b - a) / a * 100 >= 0 ? '+' : '') + ((b - a) / a * 100).toFixed(1) + '%')

const A = snapshot(DIR_A)
const B = snapshot(DIR_B)

console.log('================ 构建产物体积对比 ================')
console.log(`A（基线）  ${path.relative(ROOT, DIR_A)}`)
console.log(`B（实验）  ${path.relative(ROOT, DIR_B)}`)
console.log('口径：raw = 磁盘字节；gzip = zlib 默认级别；Δ = B − A\n')

// ---------- ① 首屏闭包 ----------
console.log('---- ① 首屏（index.html 入口 + 静态 import 闭包）----')
const entA = entryOf(DIR_A)
const entB = entryOf(DIR_B)
const scA = staticClosure(DIR_A, entA)
const scB = staticClosure(DIR_B, entB)
const cssA = cssClosure(DIR_A)
const cssB = cssClosure(DIR_B)

const firstRows = [
  {
    项: '首屏 JS 闭包',
    模块数: `${scA.files.size} → ${scB.files.size}`,
    'A raw(KB)': kb(scA.raw),
    'B raw(KB)': kb(scB.raw),
    'Δraw(KB)': signed(scB.raw - scA.raw),
    'A gzip(KB)': kb(scA.gzip),
    'B gzip(KB)': kb(scB.gzip),
    'Δgzip(KB)': signed(scB.gzip - scA.gzip),
    'gzip Δ%': pct(scA.gzip, scB.gzip),
  },
  {
    项: '首屏 CSS',
    模块数: `${cssA.files.length} → ${cssB.files.length}`,
    'A raw(KB)': kb(cssA.raw),
    'B raw(KB)': kb(cssB.raw),
    'Δraw(KB)': signed(cssB.raw - cssA.raw),
    'A gzip(KB)': kb(cssA.gzip),
    'B gzip(KB)': kb(cssB.gzip),
    'Δgzip(KB)': signed(cssB.gzip - cssA.gzip),
    'gzip Δ%': pct(cssA.gzip, cssB.gzip),
  },
]
console.table(firstRows)
console.log(`A 入口 ${entA}     B 入口 ${entB}`)
console.log(`A 首屏模块：${[...scA.files].join(', ')}`)
console.log(`B 首屏模块：${[...scB.files].join(', ')}\n`)

// ---------- ② 逐模块 ----------
const keys = [...new Set([...A.map.keys(), ...B.map.keys()])]
const rows = keys
  .map((k) => {
    const a = A.map.get(k)
    const b = B.map.get(k)
    return {
      模块: k,
      'A raw(KB)': a ? kb(a.raw) : '—',
      'B raw(KB)': b ? kb(b.raw) : '—',
      'Δraw(KB)': a && b ? signed(b.raw - a.raw) : (b ? '新增' : '缺失'),
      'Δgzip(KB)': a && b ? signed(b.gzip - a.gzip) : '—',
      _d: a && b ? b.raw - a.raw : (b ? b.raw : -a.raw),
    }
  })
  .sort((x, y) => Math.abs(y._d) - Math.abs(x._d))

console.log(`---- ② 逐模块（按 |Δraw| 降序，取前 ${TOP}；共 ${keys.length} 个）----`)
console.table(rows.slice(0, TOP).map(({ _d, ...r }) => r))

// ---------- ③ 全量 ----------
console.log('---- ③ 全量目录 ----')
console.table([{
  项: '所有资源（含懒加载大块）',
  文件数: `${A.map.size} → ${B.map.size}`,
  'A raw(KB)': kb(A.totalRaw),
  'B raw(KB)': kb(B.totalRaw),
  'Δraw(KB)': signed(B.totalRaw - A.totalRaw),
  'Δgzip(KB)': signed(B.totalGz - A.totalGz),
  'gzip Δ%': pct(A.totalGz, B.totalGz),
}])

console.log('\n注意：全量含 xlsx/exceljs/jspdf 等与 Vue 无关的懒加载块，判断 Vue 成本看①。')
