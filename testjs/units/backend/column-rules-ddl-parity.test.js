// =========================================================================
// column-rules-ddl-parity.test.js —— 列级规则的列名必须落在真实 DDL 上（V8 · 5-3 / Q4-01 缺口⑤）
//
// Q4-01 唯一完全无守卫的一条：COLUMN_RULES[table][column] 的列名与真实 DDL 列名
// 没有对账。G12 只钉 3 个日期列、batch5 只钉 2 个 phone 列，其余 47 条规则
// 拼错列名或 DDL 改名都不会有任何测试变红。
//
// 后果是真实的：规则列一旦不在调用方用的列名上，sanitizeField 就找不到规则、
// 退化成宽松归一 —— 非法日期 '2026-13-45' 不再抛错而是静默落库。
//
// 判据：
//   ① 真跑 initSchema 建内存库，用 PRAGMA table_info 取每张表/视图的真实列集，
//      断言 COLUMN_RULES 每个 (表,列) 都在真列集里（列集来自真库输出，不是源码正则）；
//   ② 每类有明确拒绝分支的规则（enum/number/date/phone）喂必被拒的值调真实
//      sanitizeField，断言抛错 —— 证明规则是活的，不是对上了列名的死映射；
//   ③ 变异反证：把 leave_records.返校时间 规则列改名 → ①红 且 ②的 HTTP 行为退化。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const { COLUMN_RULES, sanitizeField } = require('../../../student-backend/services/sanitize')

const fx = createBackendDb({ label: 'column-rules-ddl' })
const conn = fx.conn

// 取真库里一张表/视图的列集（PRAGMA 对物理表和视图都有效）
function realColumns(table) {
  const rows = conn.prepare(`PRAGMA table_info("${table}")`).all()
  assert.ok(rows.length > 0, `DDL 里找不到表/视图：${table}`)
  return new Set(rows.map((r) => r.name))
}

test('① COLUMN_RULES 的每条规则列都真实存在于 DDL（物理表或视图）', () => {
  let checked = 0
  for (const [table, columns] of Object.entries(COLUMN_RULES)) {
    const cols = realColumns(table)
    for (const column of Object.keys(columns)) {
      assert.ok(cols.has(column),
        `规则列不在 DDL 里：${table}.${column}（拼错或 DDL 改名会让该列的业务规则静默失效）`)
      checked++
    }
  }
  assert.ok(checked >= 50, `规则数异常偏少（${checked}），COLUMN_RULES 结构可能变了`)
})

// ② 抽几类有明确拒绝分支的规则，喂必被拒的值，证明规则真的挂在列名上生效。
// 若①的名字对但规则是死的，这些断言会红。
test('② 规则是活的：非法值调真实 sanitizeField 必抛错', () => {
  // date：非法日期
  assert.throws(() => sanitizeField('2026-13-45', 'leave_records', '返校时间', '文字'), /日期|合法/)
  // enum：白名单外的值
  const enumTable = 'fee_records'
  const enumCol = '收支类型'
  assert.throws(() => sanitizeField('非法类型', enumTable, enumCol, '文字'), /只能/)
  // number：超上限
  assert.throws(() => sanitizeField(999999999, 'fee_records', '收支金额', '数字'), /不能大于/)
  // phone：非法号码
  const phoneEntry = Object.entries(COLUMN_RULES).find(([, cols]) => Object.values(cols).some((r) => r.kind === 'phone'))
  assert.ok(phoneEntry, '应至少有一条 phone 规则')
  const phoneCol = Object.keys(phoneEntry[1]).find((c) => phoneEntry[1][c].kind === 'phone')
  assert.throws(() => sanitizeField('abc', phoneEntry[0], phoneCol, '文字'), /电话|手机|号码/)
})
