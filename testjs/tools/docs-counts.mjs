// =========================================================================
// docs-counts.mjs —— 文档「数量类」计数的唯一来源（verify 与 sync 共用）
//
// 为什么要单独一份：验数和改数是同一张表。过去 verify 里有这张表、改数靠手抄，
// 两边一旦分开就会出现「校验通过但文档写的是旧数」（v6 · 5-1 修过一次这种假绿）。
// 现在：
//   · docs-verify.mjs 只负责「比」；
//   · docs-sync.mjs 只负责「写」；
//   · 计数从哪儿现算、文档里长什么样，都只在这一个文件里定义。
// 新增一个数字类断言时，改这里一处即可，不会漏掉另一条链路。
// =========================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DOC_DIR = path.join(ROOT, 'doc')

function exists(p) { try { return fs.existsSync(p) } catch { return false } }
function read(p) { return fs.readFileSync(p, 'utf8') }
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
const count = (dir, filter) => walk(dir, filter).length

/**
 * 文档里的计数断言表。
 * @param {number} routeCount docs-verify 现算出的后端路由条数（由调用方传入，避免两边各算一遍）
 */
export function countExpectations(routeCount) {
  // 导出表数：从 dataExport.js 的 TABLES 现算，不靠文档抄
  const dataExportSrc = read(path.join(ROOT, 'student-backend/routes/dataExport.js'))
  const tablesBlock = dataExportSrc.match(/const TABLES = \[([\s\S]*?)\n\];/)
  const tableCount = tablesBlock ? (tablesBlock[1].match(/\{\s*key:\s*'/g) || []).length : 0

  return [
    { name: '组件数', file: path.join(DOC_DIR, 'development/frontend/components/README.md'), actual: count(path.join(ROOT, 'student-frontend/src/components'), (p) => p.endsWith('.vue')), re: /共\s*(\d+)\s*个\s*`?\.vue/ },
    { name: '组合式函数数', file: path.join(DOC_DIR, 'development/frontend/composables.md'), actual: count(path.join(ROOT, 'student-frontend/src/composables'), (p) => p.endsWith('.js')), re: /^(\d+)\s*个文件：/m },
    { name: '前端 utils 数', file: path.join(DOC_DIR, 'development/frontend/misc.md'), actual: count(path.join(ROOT, 'student-frontend/src/utils'), (p) => p.endsWith('.js')), re: /工具（`src\/utils\/`，(\d+)\s*个）/ },
    { name: '主进程 main.*.js 数', file: path.join(DOC_DIR, 'development/main-process/README.md'), actual: count(path.join(ROOT, 'electron/main'), (p) => /main\.[A-Za-z-]+\.js$/.test(p)), re: /共\s*\*\*(\d+)\s*个/ },
    { name: '后端运行时依赖数', file: path.join(DOC_DIR, 'development/dependencies/README.md'), actual: Object.keys(JSON.parse(read(path.join(ROOT, 'student-backend/package.json'))).dependencies).length, re: /后端运行时依赖（`student-backend\/package\.json`，(\d+)\s*个）/ },
    { name: '页面数', file: path.join(DOC_DIR, 'development/frontend/views.md'), actual: (read(path.join(ROOT, 'student-frontend/src/router/index.js')).match(/path:\s*'/g) || []).length - 2, re: /(\d+)\s*个页面/ },
    { name: '导出表数', file: path.join(DOC_DIR, 'development/frontend/components/data-manage.md'), actual: tableCount, re: /(\d+)\s*张业务表/ },
    { name: '单元测试文件数', file: path.join(DOC_DIR, 'development/testing/units.md'), actual: count(path.join(ROOT, 'testjs/units'), (p) => p.endsWith('.test.js')), re: /(\d+)\s*个\s*`node:test`/ },
    { name: '后端路由数', file: path.join(DOC_DIR, 'development/backend/routes.md'), actual: routeCount, re: /共\s*(\d+)\s*条(?:路由|接口)/ },
  ]
}

/**
 * 把文本里第一个匹配到的计数替换成 actual。
 * @returns {string|null} 找不到计数位置时返回 null（调用方应报错，而不是静默跳过）
 */
export function replaceCount(text, re, actual) {
  const m = re.exec(text)
  if (!m || m[1] == null) return null
  // 只替换捕获组本身，保留前后缀（如「工具（`src/utils/`，」「 个）」）
  const start = m.index + m[0].indexOf(m[1])
  return text.slice(0, start) + String(actual) + text.slice(start + m[1].length)
}
