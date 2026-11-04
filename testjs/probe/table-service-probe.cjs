// =========================================================================
// table-service-probe.cjs —— 动态表服务（tableService）三个数据层契约的回归探针
//
// 为什么需要它：这三条都是「不报错但结果错」的形态，光看代码容易改回去：
//   1) 删字段只删登记、保留物理列 → 重新加同名列必须能找回数据（不能 duplicate column name）；
//   2) 导入行必须显式写 position → 否则 NULL 在 ORDER BY position 里最小，整块跑到表头；
//   3) 导入的建列（DDL）与插行必须同一事务 → 插入失败不能留下半套空列。
//
// 做法：内存库 + initSchema → 用 require.cache 把 ../db 换成这个连接 → 直接调 service 层。
// 不碰真实班级库，毫秒级，可重复运行。
//
// 用法：node testjs/probe/table-service-probe.cjs
// 退出码：有断言失败 → 1，否则 0。
// =========================================================================
const path = require('path')
const assert = require('assert/strict')

const BACKEND = path.join(__dirname, '../../student-backend')
const Database = require(path.join(BACKEND, 'node_modules/better-sqlite3-multiple-ciphers'))

const conn = new Database(':memory:')
require(path.join(BACKEND, 'schema/schema.js')).initSchema(conn)

// ==================== 把 ../db 换成内存连接 ====================
// tableService 只用到 db / getFields / renumber 三个导出；照 db.js 的实现抄一份（行为必须一致）。
const dbPath = require.resolve(path.join(BACKEND, 'db.js'))
const stub = {
  db: conn,
  getFields(tableName) {
    return conn.prepare('SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(tableName)
  },
  renumber(tableName) {
    const rows = conn.prepare(`SELECT id FROM ${tableName} ORDER BY position, id`).all()
    if (!rows.length) return
    const stmt = conn.prepare(`UPDATE ${tableName} SET position = ? WHERE id = ?`)
    conn.transaction(() => { rows.forEach((r, i) => stmt.run(i + 1, r.id)) })()
  },
}
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub }

const ts = require(path.join(BACKEND, 'services/tableService.js'))

const cases = []
function check(name, fn) {
  try { fn(); cases.push([true, name]) } catch (e) { cases.push([false, name, e]) }
}

// ==================== 1. insertRow 正常追加 ====================
ts.insertRow('students', { 姓名: '甲', 备注: '第一条' })
ts.insertRow('students', { 姓名: '乙', 备注: '第二条' })
ts.insertRow('students', { 姓名: '丙', 备注: '第三条' })

check('insertRow：三行 position 连续为 1/2/3', () => {
  const rows = conn.prepare('SELECT 姓名, position FROM students ORDER BY position').all()
  assert.deepEqual(rows.map(r => r.position), [1, 2, 3])
  assert.deepEqual(rows.map(r => r.姓名), ['甲', '乙', '丙'])
})

// ==================== 2. 删字段再加回同名列：找回旧值 ====================
check('deleteColumn → addColumn 同名列：不抛 duplicate column name', () => {
  ts.deleteColumn('students', '备注')
  assert.equal(conn.prepare("SELECT 1 AS x FROM table_meta WHERE table_name='students' AND column_name='备注'").get(), undefined)
  ts.addColumn('students', '备注', '文字')
})

check('deleteColumn → addColumn 同名列：旧值仍在（隐形列数据被找回）', () => {
  const row = conn.prepare("SELECT 备注 FROM students WHERE 姓名 = '甲'").get()
  assert.equal(row.备注, '第一条')
})

check('addColumn 重复添加已登记字段：明确报「字段已存在」', () => {
  assert.throws(() => ts.addColumn('students', '备注', '文字'), /字段已存在/)
})

check('addColumn 新建列：物理列与 table_meta 同时存在', () => {
  ts.addColumn('students', '兴趣', '文字')
  const cols = conn.prepare('PRAGMA table_info("students")').all().map(c => c.name)
  assert.ok(cols.includes('兴趣'))
  assert.ok(conn.prepare("SELECT 1 AS x FROM table_meta WHERE table_name='students' AND column_name='兴趣'").get())
})

// ==================== 3. importRows：追加到末尾而不是表头 ====================
check('importRows：导入行排在最末（position 递增，不被 NULL 排到表头）', () => {
  ts.importRows('students', ['姓名'], [['新1'], ['新2']])
  const rows = conn.prepare('SELECT 姓名, position FROM students ORDER BY position').all()
  assert.deepEqual(rows.map(r => r.姓名), ['甲', '乙', '丙', '新1', '新2'])
  assert.deepEqual(rows.map(r => r.position), [1, 2, 3, 4, 5])
})

check('importRows：queryAll 返回顺序与 position 一致（前端看到的就是这个）', () => {
  const { data } = ts.queryAll('students')
  assert.deepEqual(data.map(r => r.姓名), ['甲', '乙', '丙', '新1', '新2'])
})

// ==================== 4. importRows：插行失败时建列回滚（不留半套空列） ====================
check('importRows：插入违反 NOT NULL 时，新加的列与登记一并回滚', () => {
  assert.throws(
    () => ts.importRows('students', ['姓名', '回滚测试列'], [[null, 'x']]),
    /NOT NULL|constraint/i
  )
  const cols = conn.prepare('PRAGMA table_info("students")').all().map(c => c.name)
  assert.ok(!cols.includes('回滚测试列'), '物理列应已回滚')
  assert.equal(
    conn.prepare("SELECT 1 AS x FROM table_meta WHERE table_name='students' AND column_name='回滚测试列'").get(),
    undefined,
    'table_meta 登记应已回滚'
  )
})

// ==================== 输出 ====================
let failed = 0
for (const [ok, name, err] of cases) {
  if (ok) console.log(`  PASS  ${name}`)
  else { failed++; console.error(`  FAIL  ${name}\n        ${err && err.message}`) }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed ? 1 : 0)
