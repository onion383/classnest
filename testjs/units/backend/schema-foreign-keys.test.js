// =========================================================================
// schema-foreign-keys.test.js —— 外键声明（v6 · N2-03 第一步）
//
// 这一步只做一件事：把「谁引用谁、父行删了子行怎么办」写进表结构。
// **不开 PRAGMA foreign_keys** —— 声明对已存在的库是空操作，对新建库也只是元数据，
// 所以现有行为必须一模一样。这个测试就守这两条：
//   ① 10 处声明在、且 ON DELETE 语义正确（少了 = 约定丢了，多了/错了 = 以后开 PRAGMA 会出事）
//   ② PRAGMA 仍是关的、且不合法的引用照样写得进去（证明「行为不变」）
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')

const backendRequire = createRequire(abs('student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const { initSchema } = require('../../../student-backend/schema/schema')
// 清单不再写在本文件里：DDL 一改、这里忘改，就会出现「库里多了一条、测试还说 9 条齐」。
// 单源在 schema/foreignKeySpec.js，探测模块与这里共用同一份（对账见 fk-probe.test.js）。
const { FK_DECLARATIONS } = require('../../../student-backend/schema/foreignKeySpec')

function fresh() {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}
const fkList = (db, table) => db.pragma(`foreign_key_list(${JSON.stringify(table)})`)

test('10 处外键声明都在，且父表/列/删除策略正确', () => {
  const db = fresh()
  try {
    // 清单本身被删减也要红：下面只验证「登记过的都在」，不会发现「少登记了」
    assert.equal(FK_DECLARATIONS.length, 10, '契约清单条数变了 —— 是新增了外键还是误删了一条？')
    for (const spec of FK_DECLARATIONS) {
      const fk = fkList(db, spec.table).find((r) => r.from === spec.column)
      assert.ok(fk, `${spec.table}.${spec.column} 缺少外键声明 —— 这条约定又变回「应用层自觉」了`)
      assert.equal(fk.table, spec.parent, `${spec.table}.${spec.column} 指向的父表不对`)
      assert.equal(fk.to, 'id', `${spec.table}.${spec.column} 应指向父表主键 id`)
      assert.equal(fk.on_delete, spec.onDelete, `${spec.table}.${spec.column} 的 ON DELETE 应为 ${spec.onDelete}`)
    }
  } finally { db.close() }
})

test('故意不加外键的两处保持不加（加了会误伤）', () => {
  const db = fresh()
  try {
    // 0 是「没有上级」的哨兵值，不是 cadres.id
    assert.equal(fkList(db, 'cadres').find((r) => r.from === 'parent_id'), undefined)
    // 按姓名引用，students.姓名 不唯一，SQLite 外键要求父列 PK/UNIQUE
    assert.equal(fkList(db, 'group_members').find((r) => r.from === 'member_name'), undefined)
  } finally { db.close() }
})

test('新库上声明立即生效：better-sqlite3 默认 foreign_keys=ON', () => {
  const db = fresh()
  try {
    // 这条断言是本次改动最容易被忽略的事实：better-sqlite3 打开连接时**默认就开了**
    // PRAGMA foreign_keys（裸库实测 = 1，不写在任何业务代码里）。
    // 所以「报告说 PRAGMA 全程未开」是错的；过去没约束只是因为一处声明都没有。
    // 结论：声明一加，**新建库立刻受约束**；老库因建表语句早已执行过，保持无约束。
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'better-sqlite3 默认开外键，别以为是我们开的')
    assert.throws(
      () => db.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (99999, '幽灵', '加分', '作业', 1)").run(),
      /FOREIGN KEY/i,
      '新库必须拒绝指向不存在学生的记录 —— 这是这次声明换来的收益',
    )
  } finally { db.close() }
})

test('老库不受影响：表已存在 → 加声明不会回填，也不报错', () => {
  const db = fresh()
  try {
    // 模拟加声明之前建出来的老表（列齐全、只缺外键）
    db.exec('DROP TABLE IF EXISTS score_records')
    db.exec(`CREATE TABLE score_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, 姓名 TEXT, 学号 TEXT,
      类型 TEXT, 项目 TEXT, 分值 REAL, 原因 TEXT, 加分时间 TEXT, created_at TEXT,
      source TEXT DEFAULT 'personal', group_name TEXT, 成员数 INTEGER DEFAULT 0)`)
    assert.doesNotThrow(() => initSchema(db), '迁移必须幂等，不能因为加声明就炸老库')
    assert.equal(fkList(db, 'score_records').length, 0, '老表不会被回填外键 —— 这正是「只影响新库」的含义')
    // 老库仍能写入不合规数据（外键只对有声明的表生效，而这条表没有声明）
    db.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (99999, '幽灵', '加分', '作业', 1)").run()
    assert.equal(db.prepare('SELECT COUNT(*) c FROM score_records').get().c, 1)
  } finally { db.close() }
})
