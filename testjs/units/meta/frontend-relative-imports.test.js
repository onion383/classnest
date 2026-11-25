// =========================================================================
// frontend-relative-imports.test.js —— 前端相对 import 必须指向真实存在的文件
//
// 根因：批量迁移（如 §5-17 给 20+ 组件加 useDisposables）时，把浅层目录的
// 路径模板套到深一层组件上（GridView 在 components/tables/GridView/，需要 '../../../'
// 却写了 '../../'）。现有判据只用 compiler-sfc 做 parse/compileScript —— 它只验语法，
// 不解析 import 目标，所以这类错误一路全绿，直到 Vite 运行时报 Failed to resolve。
//
// 判据：扫 src 下所有 .vue/.js 的相对 import，按 Vite 的解析规则（补 .js/.vue/index、
// 剥 ?raw 等查询串）验证目标文件真实存在。变异（改错任意一处层级）必须转红。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = abs('student-frontend/src')
const RESOLVE_EXTS = ['', '.js', '.vue', '.json', '.css', '.mjs', '/index.js', '/index.vue']

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(p, out)
    else if (/\.(vue|js|mjs)$/.test(entry.name)) out.push(p)
  }
  return out
}

/** 按 Vite 规则解析相对 import：剥查询串/哈希，再试常见后缀与 index */
function resolveImport(fromFile, spec) {
  const clean = spec.split('?')[0].split('#')[0]
  const base = path.resolve(path.dirname(fromFile), clean)
  for (const ext of RESOLVE_EXTS) {
    if (fs.existsSync(base + ext)) return base + ext
  }
  return null
}

function brokenImports() {
  const bad = []
  // from '...' / import '...' / require('...') 三种写法都要覆盖
  const re = /(?:from\s+|import\s+|require\s*\(\s*)['"](\.[^'"]*)['"]/g
  for (const file of sourceFiles(SRC)) {
    const code = fs.readFileSync(file, 'utf8')
    let m
    while ((m = re.exec(code))) {
      if (!resolveImport(file, m[1])) {
        bad.push(`${path.relative(SRC, file)} -> ${m[1]} (第 ${code.slice(0, m.index).split('\n').length} 行)`)
      }
    }
  }
  return bad
}

test('src 下所有相对 import 都能解析到真实文件', () => {
  const bad = brokenImports()
  assert.deepEqual(bad, [], `发现 ${bad.length} 处断链：\n${bad.join('\n')}`)
})

test('判据本身能识别层级写错（变异反证：把正确路径改成错的）', () => {
  const gridView = path.join(SRC, 'components/tables/GridView/GridView.vue')
  const good = "import { useDisposables } from '../../../utils/disposables.js'"
  const bad = "import { useDisposables } from '../../utils/disposables.js'"
  const code = fs.readFileSync(gridView, 'utf8')
  assert.ok(code.includes(good), 'GridView 必须用三层相对路径到 src/utils')
  // 判据要能识别这种写法是断的：目标从 GridView 目录上两级找不到
  const resolved = resolveImport(gridView, '../../utils/disposables.js')
  assert.equal(resolved, null, '上两级只能到 components/utils，不该解析成功')
  assert.ok(resolveImport(gridView, '../../../utils/disposables.js'), '上三级才到 src/utils')
  assert.ok(!code.includes(bad + '\n') && !code.includes(bad + ';'), '源码里不应残留错误路径')
})
