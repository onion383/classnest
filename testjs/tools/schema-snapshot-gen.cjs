// =========================================================================
// schema-snapshot-gen.cjs —— 从「当前建库结果」导出结构清单
//
// 干什么：起一个空的内存库，跑真实的 initSchema，然后把每张表的列、每个索引与视图的
// DDL 导出成 `student-backend/migrations/snapshot.js` 里的 EXPECTED。
//
// 为什么要生成而不是手写：30 张表、几百个列，手写必然漏，而且漏了看不出来
// （清单少一列 = 对账永远认为「库里多一列」，只是提示，不报错）。
//
// 用法（改了 schema 之后重跑，再 review 生成的 diff）：
//   node testjs/tools/schema-snapshot-gen.cjs
//
// 注意：清单描述的是「代码想要的结构」，不是「某个用户的库」。所以永远从一个空库导出，
// 不要拿自己的 data/ 目录导 —— 那里面还有用户自定义列和临时状态。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const { initSchema } = require(path.join(ROOT, 'student-backend/schema/schema.js'))

const OUT = path.join(ROOT, 'student-backend/migrations/snapshot.js')

// PRAGMA table_info 的一行 → ADD COLUMN 能直接用的定义片段。
// 只重建 type / NOT NULL / DEFAULT：这三样是 ADD COLUMN 能表达的全部；
// 主键、外键、CHECK 都不重建（新加列不会有这些，真要有就得写迁移脚本）。
function columnDdl(col) {
  const type = String(col.type || '').trim() || 'TEXT'
  let ddl = type
  if (col.notnull) ddl += ' NOT NULL'
  if (col.dflt_value != null && col.dflt_value !== '') ddl += ` DEFAULT ${col.dflt_value}`
  return ddl
}

function buildSnapshot(db) {
  const tables = {}
  const indexes = {}
  const views = {}

  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name)

  for (const name of names) {
    const cols = {}
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      cols[c.name] = columnDdl(c)
    }
    tables[name] = cols
  }

  // 只要「手写的」索引：自动索引（UNIQUE 约束产生的）没有 sql，重建不出来也不该重建
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()) {
    indexes[r.name] = r.sql
  }
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all()) {
    views[r.name] = r.sql
  }

  return { tables, indexes, views }
}

// 序列化成「能 review 的」代码：一个表一行太挤，一列一行又太长 —— 用 JSON.stringify 缩进 2，
// 排序已在上面的 SQL 里做好（ORDER BY name），两次生成的结果应当 byte 级一致。
function render(snapshot) {
  return `// =========================================================================
// snapshot.js —— 结构清单（\`schema/\` 的机器可读镜像）
//
// **这个文件由脚本生成，不要手改**：
//   node testjs/tools/schema-snapshot-gen.cjs
//
// 用途：和 \`PRAGMA table_info\` 对账，抓两类漂移 ——
//   · 代码要的列库里没有（老库没迁移 → no such column，启动时就该报）；
//   · 库里有的列代码不认识（清单漏登记，或用户自定义列）。
// 列的值是「ADD COLUMN 能直接用的定义片段」，所以结构自愈可以按它补列。
//
// 它描述的是「代码想要的结构」：从空库跑 initSchema 导出，不含任何用户数据与自定义列。
// =========================================================================
const EXPECTED = ${JSON.stringify(snapshot, null, 2)}

module.exports = { EXPECTED }
`
}

function main() {
  const db = new Database(':memory:')
  try {
    initSchema(db)
    const snapshot = buildSnapshot(db)
    fs.writeFileSync(OUT, render(snapshot), 'utf8')
    const cols = Object.values(snapshot.tables).reduce((n, t) => n + Object.keys(t).length, 0)
    console.log(`已写入 ${path.relative(ROOT, OUT)}`)
    console.log(`表 ${Object.keys(snapshot.tables).length} · 列 ${cols} · 索引 ${Object.keys(snapshot.indexes).length} · 视图 ${Object.keys(snapshot.views).length}`)
  } finally {
    db.close()
  }
}

main()
