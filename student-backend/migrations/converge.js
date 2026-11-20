// ==================== 结构对账与自愈（converge） ====================
//
// 只干三件事，多一件都不干：
//   1. 缺列  → ALTER TABLE ... ADD COLUMN（能自动做的只有这一种改表操作）
//   2. 缺索引 → 执行声明的 CREATE INDEX
//   3. 缺视图 → 执行声明的 CREATE VIEW
//
// **不建表**。建表已经由 `schema/schema.*.js` 的 `CREATE TABLE IF NOT EXISTS` 负责了，
// 再在这里写一份 DDL 就是两份真相，迟早漂：改了一边忘了另一边，新库和老库长得不一样。
// 所以表缺失只报告、不自愈，让调用方先跑 schema 层。
//
// 做不到的（必须写迁移脚本，不能指望自愈）：
//   · 改列类型 / 改默认值 / 加约束 —— SQLite 要重建整表，无法从声明推导「哪个是对的」；
//   · 删列 / 删表 —— 同上，而且「库里多一列」和「代码忘了声明这一列」无法区分；
//   · 任何要 SELECT 出数据才能决定怎么改的（搬数据、改 JSON 形状）。
// 这些一律进 blocked，由 `assertConverged` 抛出来，让问题在启动时暴露，而不是等用户点按钮。

const q = (name) => `"${String(name).replace(/"/g, '""')}"`

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(String(table))
}
function hasView(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?").get(String(name))
}
function hasIndex(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(String(name))
}

// 列定义能不能用 ADD COLUMN 加进去？SQLite 的限制（违反任一条会直接报错，
// 与其让它抛一句 SQL 语法错，不如提前给出人能读的理由）：
//   · NOT NULL 必须带 DEFAULT（老行无法填值）；
//   · DEFAULT 必须是常量（CURRENT_TIMESTAMP / 表达式不行）；
//   · 不能是 PRIMARY KEY / UNIQUE 列（会要求重建整表）。
function addColumnBlocker(ddl) {
  const text = String(ddl || '').trim()
  if (!text) return '没有列定义，无法生成 ADD COLUMN（structure 里请写成 { 列名: "TEXT NOT NULL DEFAULT \'\'" }）'
  if (/PRIMARY\s+KEY|UNIQUE/i.test(text)) return '主键 / UNIQUE 列不能 ADD COLUMN，需要重建整表'
  if (/NOT\s+NULL/i.test(text) && !/DEFAULT/i.test(text)) return 'NOT NULL 列必须带 DEFAULT，否则老行没法填值'
  if (/DEFAULT\s+[^'"\d\-+]/i.test(text)) return 'DEFAULT 必须是常量（CURRENT_TIMESTAMP 之类的表达式不能用于 ADD COLUMN）'
  return null
}

// 对账：把「声明里应该有、库里没有」逐条列出来。
// expected 形状（增量与全量都能传，函数只按传进来的内容比）：
//   {
//     tables:  { students: { 姓名: 'TEXT', is_provisional: 'INTEGER NOT NULL DEFAULT 0' } },
//     indexes: { idx_xxx: 'CREATE INDEX ...' },
//     views:   { seat_layout: 'CREATE VIEW ...' },
//   }
// 返回 { missing, extra, blocked }：
//   missing —— 能自愈的（缺列 / 缺索引 / 缺视图）
//   extra   —— 库里多出来的（多列 / 多表 / 多视图）。**不当错误**：可能是用户自定义列，
//              也可能是这边清单没登记；只提示，交给 assertConverged 之外的渠道看。
//   blocked —— 缺表（该由 schema 层建）、以及列定义不可 ADD COLUMN 的情况。
function diffSchema(db, expected) {
  const spec = expected || {}
  const missing = []
  const extra = []
  const blocked = []
  const tables = spec.tables || {}

  for (const [table, cols] of Object.entries(tables)) {
    if (!hasTable(db, table)) {
      blocked.push({ kind: 'missing_table', target: table, reason: '缺表：先跑 schema 层的 CREATE TABLE，这里不重复建表' })
      continue
    }
    const have = new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name))
    const want = cols && typeof cols === 'object' ? cols : {}
    for (const [col, ddl] of Object.entries(want)) {
      if (have.has(col)) continue
      const reason = addColumnBlocker(ddl)
      if (reason) blocked.push({ kind: 'missing_column', target: `${table}.${col}`, ddl, reason })
      else missing.push({ kind: 'missing_column', target: `${table}.${col}`, table, column: col, ddl })
    }
    for (const col of have) {
      if (!Object.prototype.hasOwnProperty.call(want, col)) extra.push({ kind: 'extra_column', target: `${table}.${col}` })
    }
  }

  for (const [name, sql] of Object.entries(spec.indexes || {})) {
    if (!hasIndex(db, name)) missing.push({ kind: 'missing_index', target: name, sql })
  }
  for (const [name, sql] of Object.entries(spec.views || {})) {
    if (!hasView(db, name)) missing.push({ kind: 'missing_view', target: name, sql })
  }

  // 库里多出来的表 / 视图：只提示，不动。系统表与账本表天然不在清单里，跳过。
  const known = new Set(Object.keys(tables))
  const KNOWN_SYSTEM = new Set(['schema_migrations'])
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (!known.has(row.name) && !KNOWN_SYSTEM.has(row.name)) extra.push({ kind: 'extra_table', target: row.name })
  }
  const knownViews = new Set(Object.keys(spec.views || {}))
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all()) {
    if (!knownViews.has(row.name)) extra.push({ kind: 'extra_view', target: row.name })
  }

  return { missing, extra, blocked }
}

// 自愈：只执行 missing 里那三类。返回做过什么，方便打印/断言。
// 不包事务：调用方决定边界（全量收敛适合一个大事务，逐条迁移适合跟在版本步骤后面）。
function converge(db, expected) {
  const diff = diffSchema(db, expected)
  const done = []
  for (const item of diff.missing) {
    if (item.kind === 'missing_column') {
      db.exec(`ALTER TABLE ${q(item.table)} ADD COLUMN ${q(item.column)} ${item.ddl}`)
    } else if (item.kind === 'missing_index') {
      db.exec(item.sql)
    } else if (item.kind === 'missing_view') {
      db.exec(item.sql)
    } else {
      continue
    }
    done.push(item.target)
  }
  return { done, blocked: diff.blocked, extra: diff.extra }
}

// 终检：自愈跑完还有差异就**抛**。
// 为什么必须抛：留着不管的代价是「代码以为有、库里没有」，而且是在用户点按钮时才炸
// （no such column）。让它在启动时就报错、并写清缺什么，这才叫可控。
function assertConverged(db, expected) {
  const diff = diffSchema(db, expected)
  const fatal = [
    ...diff.blocked.map((b) => `${b.kind} ${b.target}：${b.reason}`),
    ...diff.missing.map((m) => `${m.kind} ${m.target}：自愈后仍然缺失`),
  ]
  if (!fatal.length) return { ok: true, extra: diff.extra }
  const err = new Error(`库结构与声明不一致（${fatal.length} 处）：\n- ${fatal.join('\n- ')}`)
  err.problems = fatal
  err.extra = diff.extra
  throw err
}

module.exports = { diffSchema, converge, assertConverged, addColumnBlocker }
