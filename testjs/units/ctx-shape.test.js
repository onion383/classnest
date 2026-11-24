// =========================================================================
// ctx-shape.test.js —— ctx 共享上下文的形状判据
//
// 背景：表格组件把大量 ref / 方法 / 运行时字段挂在一个 ctx 对象上。
// 对 ctx 做 delete 或动态键读写，会把整个对象永久推入 dictionary mode；
// 首次交互才给 ctx 新增键，会在交互期触发 map transition。
// 三条判据：
//   1) 全仓不得出现 delete ctx.<prop>
//   2) 全仓不得出现 ctx[...] 动态键
//   3) 表格组件的 _ 运行时字段必须在 ctx 字面量（或模块返回对象）里先声明
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (/\.(js|vue)$/.test(ent.name)) out.push(full)
  }
  return out
}

const FILES = walk(SRC)
const read = (f) => fs.readFileSync(f, 'utf8')

test('ctx：不得 delete ctx 的属性', () => {
  const hits = []
  for (const f of FILES) {
    const src = read(f)
    for (const m of src.matchAll(/delete\s+ctx\.[A-Za-z_$][\w$]*/g)) {
      hits.push(`${path.relative(ROOT, f)}: ${m[0]}`)
    }
  }
  assert.deepEqual(hits, [], `删除 ctx 属性会让对象永久进入字典模式：\n${hits.join('\n')}`)
})

test('ctx：不得使用 ctx[...] 动态键', () => {
  const hits = []
  for (const f of FILES) {
    const src = read(f)
    for (const m of src.matchAll(/ctx\s*\[[^\]]+\]/g)) {
      hits.push(`${path.relative(ROOT, f)}: ${m[0]}`)
    }
  }
  assert.deepEqual(hits, [], `动态键会把 ctx 推入字典模式：\n${hits.join('\n')}`)
})

// 每个表格组件一组：字段可能由 .vue 的 ctx 字面量声明，也可能由拖拽模块返回对象声明
const GROUPS = [
  {
    name: 'DynamicTable',
    files: [
      'student-frontend/src/components/tables/DynamicTable/DynamicTable.vue',
      'student-frontend/src/components/tables/DynamicTable/DynamicTable.drag.js',
      'student-frontend/src/components/tables/DynamicTable/DynamicTable.filter.vue',
    ],
  },
  {
    name: 'GridView',
    files: [
      'student-frontend/src/components/tables/GridView/GridView.vue',
      'student-frontend/src/components/tables/GridView/GridView.drag.js',
    ],
  },
]

test('ctx：表格运行时字段必须先声明再赋值', () => {
  for (const g of GROUPS) {
    const sources = g.files.map((p) => read(path.join(ROOT, p)))
    // 去掉所有 ctx.xxx 的读写，剩下的 xxx: / xxx, / xxx( 才是声明位置
    const declText = sources.map((s) => s.replace(/ctx\.[A-Za-z_$][\w$]*/g, 'ctx')).join('\n')
    const declared = new Set(
      [...declText.matchAll(/(?:^|[\s,{])(_[A-Za-z0-9_]+)\s*[:,(}]/gm)].map((m) => m[1])
    )
    const assigned = new Set()
    for (const src of sources) {
      for (const m of src.matchAll(/ctx\.(_[A-Za-z0-9_]+)\s*=/g)) assigned.add(m[1])
    }
    const missing = [...assigned].filter((k) => !declared.has(k)).sort()
    assert.ok(assigned.size > 0, `${g.name} 未扫描到任何 ctx._ 赋值，判据已失效`)
    assert.deepEqual(missing, [], `${g.name} 有运行时字段未在 ctx 创建时声明：${missing.join(', ')}`)
  }
})
