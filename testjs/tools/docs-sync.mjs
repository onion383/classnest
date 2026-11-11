// =========================================================================
// docs-sync.mjs —— 把文档里的「数量类」计数按源码现算值改写（v6 · 5-3）
//
// 只改数字，不动叙述：数字类漂移的根因是「校验脚本算一遍、人再手抄一遍」，
// 两边永远可能不同步。现在 verify 与 sync 共用 docs-counts.mjs 的同一张表，
// 改完数字后仍要跑 `npm run docs:verify` 做全量对账（死链/覆盖/路由/格式）。
//
// 用法：node testjs/tools/docs-sync.mjs [--dry]
// 退出码：0 = 已同步（或无需改动）；1 = 某处计数位置找不到（文档结构变了，需要人工处理）
// =========================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { countExpectations, replaceCount } from './docs-counts.mjs'

const DRY = process.argv.includes('--dry')
// sync 不依赖 docs-verify 的路由扫描结果：直接现算，保证单独跑也对
const list = countExpectations(computeRouteCount())

let changed = 0
let missing = 0
for (const e of list) {
  if (!fs.existsSync(e.file)) {
    missing++
    console.log(`!! ${e.name}：文档不存在 ${e.file}`)
    continue
  }
  const text = fs.readFileSync(e.file, 'utf8')
  const next = replaceCount(text, e.re, e.actual)
  if (next == null) {
    missing++
    console.log(`!! ${e.name}：文档里找不到计数位置（结构变了吗？）`)
    continue
  }
  if (next !== text) {
    changed++
    console.log(`${DRY ? '[dry] ' : ''}同步 ${e.name} → ${e.actual}`)
    if (!DRY) fs.writeFileSync(e.file, next)
  }
}
console.log(`\n计数同步：需改 ${changed} 处，异常 ${missing} 处${DRY ? '（未落盘）' : ''}`)
process.exit(missing ? 1 : 0)

// 与 docs-verify 第 3 组同一套口径：扫 routes/*.js 里注册的 (METHOD, path)，
// 外加 historyRoutes 工厂里动态注册的 4 条。
function computeRouteCount() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const walk = (dir) => {
    const out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(p))
      else if (p.endsWith('.js') && !p.includes('tools.executors') && !p.includes('ai.tools')) out.push(p)
    }
    return out
  }
  const CATCH = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g
  let n = 0
  for (const f of walk(path.join(root, 'student-backend/routes'))) {
    n += (fs.readFileSync(f, 'utf8').match(CATCH) || []).length
  }
  return n + 4
}
