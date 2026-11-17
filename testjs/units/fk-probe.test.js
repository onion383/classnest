// =========================================================================
// fk-probe.test.js —— 外键探测（施工清单 P0-1）
//
// 守三件事：
//   ① 新库探出 10/10 完整（这是新建库的真实收益，不能被悄悄改掉）
//   ② 老库场景探出「缺哪条、缺几条」—— 这条是变异反证：如果探测退化成
//      「恒返回完整」，②会当场变红，而只测「新库完整」的用例抓不到
//   ③ 契约清单与 DDL 双向对账：新增外键忘了登记，或登记了却没写，都红
//
// 探测只读 PRAGMA，不改数据。这里也顺带断言「探测完数据一行没动」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const { initSchema } = require('../../student-backend/schema/schema')
const { FK_DECLARATIONS } = require('../../student-backend/schema/foreignKeySpec')
const { probeForeignKeys, hasFkFor, describeForeignKeys } = require('../../student-backend/schema/foreignKeyProbe')

function fresh() {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

// 把 score_records 换回「加外键声明之前」的样子：列齐全、只是没有 REFERENCES
const LEGACY_SCORE_DDL = `CREATE TABLE score_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, 姓名 TEXT, 学号 TEXT,
  类型 TEXT, 项目 TEXT, 分值 REAL, 原因 TEXT, 加分时间 TEXT, created_at TEXT,
  source TEXT DEFAULT 'personal', group_name TEXT, 成员数 INTEGER DEFAULT 0)`

test('新库：10 条全部命中，判定为受外键保护', () => {
  const db = fresh()
  try {
    const r = probeForeignKeys(db)
    assert.equal(r.total, 10)
    assert.equal(r.count, 10)
    assert.equal(r.complete, true)
    assert.deepEqual(r.missing, [])
    assert.equal(describeForeignKeys(r), '10/10')
    assert.ok(hasFkFor(db, 'score_records', 'student_id'))
  } finally { db.close() }
})

test('老库场景：缺的那条会被单独指出来，不是一律报完整', () => {
  const db = fresh()
  try {
    db.exec('DROP TABLE score_records')
    db.exec(LEGACY_SCORE_DDL)

    const r = probeForeignKeys(db)
    assert.equal(r.complete, false, '老表没有外键，探测必须报不完整')
    assert.equal(r.count, 9, '只缺一条，不能连坐其余 9 条')
    assert.deepEqual(r.missing.map((m) => `${m.table}.${m.column}`), ['score_records.student_id'])
    assert.equal(describeForeignKeys(r), '9/10')

    // 其余 9 条仍在 —— 证明判定是按条比对，不是「有一处不齐就整体作废」
    assert.ok(hasFkFor(db, 'leave_records', 'student_id'))
    assert.ok(hasFkFor(db, 'cadre_members', 'student_id'))
    // 缺的那条如实回答「没有」
    assert.equal(hasFkFor(db, 'score_records', 'student_id'), false)
  } finally { db.close() }
})

test('ON DELETE 语义被改动也算不通过（不是只看声明在不在）', () => {
  const db = fresh()
  try {
    // SET NULL 与 CASCADE 都是「有外键」，但删学生后的结果完全不同：
    // 前者留下孤儿行、后者带走子行。只判「声明存在」会把这种改动放过去。
    db.exec('DROP TABLE leave_records')
    db.exec(`CREATE TABLE leave_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      姓名 TEXT, 类型 TEXT, 开始时间 TEXT, 结束时间 TEXT, 家长联系电话 TEXT,
      学生联系电话 TEXT, 状态 TEXT DEFAULT '请假中', 返校时间 TEXT, 备注 TEXT, created_at TEXT)`)

    const r = probeForeignKeys(db)
    assert.equal(r.complete, false)
    assert.deepEqual(r.missing.map((m) => `${m.table}.${m.column}`), ['leave_records.student_id'])
  } finally { db.close() }
})

test('同一连接只探一次：重复调用返回同一个结果对象', () => {
  const db = fresh()
  try {
    const a = probeForeignKeys(db)
    const b = probeForeignKeys(db)
    assert.equal(a, b, '缓存失效会让每次请求都重跑 9 次 PRAGMA')
    // 冻结断言用「赋值后值不变」而不是 throws：非严格模式下给冻结对象赋值是静默失败，
    // 期待抛 TypeError 的写法会假红（本条就是这么被抓出来的）。
    a.count = 99
    assert.equal(a.count, 10, '结果必须冻结，避免调用方误改共享结论')
  } finally { db.close() }
})

test('契约清单与 DDL 双向一致：多一条或少一条都会红', () => {
  const db = fresh()
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    const actual = []
    for (const t of tables) {
      let list = []
      try { list = db.pragma(`foreign_key_list(${JSON.stringify(t)})`) || [] } catch (_) { list = [] }
      for (const fk of list) actual.push(`${t}.${fk.from}->${fk.table}`)
    }
    const declared = FK_DECLARATIONS.map((s) => `${s.table}.${s.column}->${s.parent}`)
    assert.deepEqual(
      actual.sort(), declared.sort(),
      '清单与 DDL 不一致：改外键必须同步 schema/foreignKeySpec.js（否则探测会报假完整/假缺失）'
    )
  } finally { db.close() }
})

test('探测是只读的：跑完不影响数据与外键开关', () => {
  const db = fresh()
  try {
    db.prepare("INSERT INTO students (姓名) VALUES ('张三')").run()
    const before = db.prepare('SELECT COUNT(*) AS c FROM students').get().c
    probeForeignKeys(db)
    probeForeignKeys(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM students').get().c, before)
    // 探测不许自己开/关 PRAGMA（better-sqlite3 默认就是 1，这里只是确认没被改动）
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  } finally { db.close() }
})
