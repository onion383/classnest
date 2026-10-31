// =========================================================================
// vapor-verify.mjs —— 逐文件核对 vapor 标记是否真的生效
//
// 为什么需要它：`<script setup vapor>` 里的 `vapor` 拼错（VAPOR / vapour / 中文）
// **不会报错**，只会静默退回 VDOM。所以「加了标记」≠「跑了 vapor」，
// 必须查产物里组件自身有没有 `__vapor: true`。
//
// 做法：起一个 3.6 通道的 dev server，逐个请求带标记的 .vue，
// 在返回的模块里找 `__name: '<名字>', __vapor: true`。
// （只看 `__vapor` 出现次数不靠谱：chunk 里可能有子组件的标记。）
//
// 用法：
//   node testjs/probe/vapor-verify.mjs              # 自动起 3.6 dev server（默认 5199）
//   node testjs/probe/vapor-verify.mjs --port=5200  # 指定端口
//   node testjs/probe/vapor-verify.mjs --url=http://127.0.0.1:5199  # 复用已起的 server
//
// 退出码：有文件降级 → 1，否则 0。
// =========================================================================
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'student-frontend', 'src')
const args = process.argv.slice(2)
const PORT = Number((args.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 5199)
const urlArg = args.find((a) => a.startsWith('--url='))
const BASE = urlArg ? urlArg.split('=')[1] : `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 递归收集所有 .vue */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const marked = files.filter((f) => /<script\b[^>]*\bsetup\b[^>]*\bvapor\b[^>]*>/.test(fs.readFileSync(f, 'utf8')))

/** 组件名：取文件名（vite 的 __name 就是文件名去扩展名） */

/**
 * 判据：响应里出现 `__vapor: true` 即视为「这个组件自身」编译成了 vapor。
 * 不需要再定位 `__name` —— SFC 对象里字段是 __name / props / emits / __vapor 顺序排列，
 * 中间隔着 props 和 emits，不存在「紧邻」的写法（第一版就因为要求紧邻而大面积误报）。
 * 而请求单个 .vue 模块时，子组件只是 import 引用、代码不内联，
 * 所以这里出现的 `__vapor` 只可能来自该组件自己。
 */
function hasOwnVapor(text) {
  return /__vapor:\s*true/.test(text)
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  return false
}

let child = null
async function main() {
  if (!urlArg) {
    console.log(`[vapor-verify] 启动 3.6 dev server（端口 ${PORT}）…`)
    child = spawn(process.execPath, [path.join(ROOT, 'student-frontend', 'dev-vite.js'), '--vue36', '--port', String(PORT), '--strictPort'], {
      cwd: path.join(ROOT, 'student-frontend'),
      stdio: 'ignore',
    })
  }
  if (!(await waitReady())) throw new Error(`dev server 未就绪：${BASE}`)

  const ok = []
  const degraded = []
  for (const f of marked) {
    const rel = '/' + path.relative(SRC, f).split(path.sep).join('/')
    const res = await fetch(BASE + '/src' + rel)
    if (!res.ok) { degraded.push({ rel, why: `HTTP ${res.status}` }); continue }
    const text = await res.text()
    if (!hasOwnVapor(text)) { degraded.push({ rel, why: '产物里没有 __vapor: true' }); continue }
    ok.push(rel)
  }

  console.log(`\n[vapor-verify] 带 vapor 标记：${marked.length} 个 / 全库 .vue：${files.length} 个`)
  console.log(`[vapor-verify] 真实生效：${ok.length} 个`)
  if (degraded.length) {
    console.log(`[vapor-verify] ❌ 静默降级：${degraded.length} 个`)
    for (const d of degraded) console.log(`   ${d.rel}  ← ${d.why}`)
  } else {
    console.log('[vapor-verify] ✅ 无静默降级')
  }
  return degraded.length ? 1 : 0
}

main()
  .then((code) => { if (child) child.kill(); process.exit(code) })
  .catch((e) => { console.error('[vapor-verify]', e.message); if (child) child.kill(); process.exit(1) })
