// =========================================================================
// orphan-check.cjs —— 只读孤儿统计（v6 §0-4 / §3-1 的前置探针）
//
// 用途：开 PRAGMA foreign_keys 之前，先回答「库里到底有没有孤儿」。
// 只读：只用 SELECT，不建表、不删行、不 vacuum。
//
// 用法：
//   node testjs/tools/orphan-check.cjs <db 文件路径> [--key <sqlcipher 密钥>]
//   node testjs/tools/orphan-check.cjs --selftest        # 用内存库自证「能查出孤儿」
//
// ⚠️ 已知限制（2026-11-11 实测）：
//   应用真实库是**加密**的（SQLCipher），密钥由主进程经 safeStorage 解出，外部拿不到。
//   从外部只能检查明文库（最低安全等级 / 测试账号）。真实库的正确检查点是
//   **应用内**：3-1 的第 ② 步 `PRAGMA foreign_key_check` 就在真实库上跑，不必在外部硬解。
// =========================================================================
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const Database = require(path.join(ROOT, 'student-backend/node_modules/better-sqlite3-multiple-ciphers'))

const T = {
  scores: 'score_records',
  leave: 'leave_records',
  cadre: 'cadre_members',
  groupMembers: 'group_members',
  duty: 'duty_slots',
  seat: 'seat_slots',
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
}

function idsAndNames(db) {
  if (!tableExists(db, 'students')) return { ids: new Set(), names: new Set(), total: 0 }
  const rows = db.prepare('SELECT id, 姓名 FROM students').all()
  return {
    ids: new Set(rows.map((r) => Number(r.id))),
    names: new Set(rows.map((r) => String(r.姓名 || '').trim()).filter(Boolean)),
    total: rows.length,
  }
}

// 从任意 JSON 结构里收集「字符串」与「数字」两类叶子值（座位/值日都是整块 JSON）
function collectLeaves(node, out) {
  if (node == null) return
  if (Array.isArray(node)) { for (const v of node) collectLeaves(v, out); return }
  if (typeof node === 'object') { for (const v of Object.values(node)) collectLeaves(v, out); return }
  if (typeof node === 'number') out.numbers.push(node)
  else if (typeof node === 'string' && node.trim()) out.strings.push(node.trim())
}

function scanJsonColumn(db, table, column, ref) {
  if (!tableExists(db, table)) return { checked: 0, orphans: [] }
  const rows = db.prepare(`SELECT kind, ${column} AS v FROM ${table}`).all()
  const orphans = []
  let checked = 0
  for (const row of rows) {
    if (!row.v) continue
    let parsed
    try { parsed = JSON.parse(row.v) } catch (_) { continue }
    const leaves = { numbers: [], strings: [] }
    collectLeaves(parsed, leaves)
    for (const n of leaves.numbers) {
      checked += 1
      // 座位里存学生 id；权重矩阵里的数字不是引用，靠「是否落在 students.id 集合附近」无法区分，
      // 所以只对 seats 列做数字检查（weights 列不查）
      if (column === 'seats' && !ref.ids.has(Number(n))) orphans.push(`${row.kind}: id=${n}`)
    }
    for (const s of leaves.strings) {
      checked += 1
      if (!ref.names.has(s)) orphans.push(`${row.kind}: ${s}`)
    }
  }
  return { checked, orphans }
}

function checkOrphans(db) {
  const ref = idsAndNames(db)
  const result = { students: ref.total, checks: {}, totalOrphans: 0 }

  // ① 显式 student_id 外键（这三张是应用层「级联删除」的责任区）
  for (const [label, table] of [['score_records', T.scores], ['leave_records', T.leave], ['cadre_members', T.cadre]]) {
    if (!tableExists(db, table)) { result.checks[label] = { rows: 0, orphans: [] }; continue }
    const rows = db.prepare(`SELECT id, student_id FROM ${table} WHERE student_id IS NOT NULL`).all()
    const orphans = rows
      .filter((r) => !ref.ids.has(Number(r.student_id)))
      .map((r) => `id=${r.id} → student_id=${r.student_id}`)
    result.checks[label] = { rows: rows.length, orphans }
    result.totalOrphans += orphans.length
  }

  // ② 按姓名引用的表（只存姓名的约定，见项目记忆「六份同款拷贝」）
  if (tableExists(db, T.groupMembers)) {
    const rows = db.prepare(`SELECT id, member_name FROM ${T.groupMembers}`).all()
    const orphans = rows
      .filter((r) => r.member_name && !ref.names.has(String(r.member_name).trim()))
      .map((r) => `id=${r.id} → ${r.member_name}`)
    result.checks.group_members = { rows: rows.length, orphans }
    result.totalOrphans += orphans.length
  } else {
    result.checks.group_members = { rows: 0, orphans: [] }
  }

  // ③ 整块 JSON 里的引用（值日存姓名、座位存 id/姓名）
  for (const [label, table, column] of [['duty_slots.cells', T.duty, 'cells'], ['seat_slots.seats', T.seat, 'seats']]) {
    const r = scanJsonColumn(db, table, column, ref)
    result.checks[label] = { rows: r.checked, orphans: r.orphans }
    result.totalOrphans += r.orphans.length
  }

  result.note = 'fee_records 无学生字段（只有收支编码/类型/金额/收据），不存在「班费孤儿」这个检查项'
  return result
}

function printResult(res, label) {
  console.log(`\n=== ${label} ===`)
  console.log(`学生数：${res.students}`)
  for (const [k, v] of Object.entries(res.checks)) {
    const n = v.orphans.length
    console.log(`  ${n ? '✗' : '✓'} ${k.padEnd(20)} 检查 ${String(v.rows).padStart(5)} 处，孤儿 ${n}`)
    for (const s of v.orphans.slice(0, 5)) console.log(`      · ${s}`)
    if (n > 5) console.log(`      · …还有 ${n - 5} 条`)
  }
  console.log(`合计孤儿：${res.totalOrphans}`)
  console.log(`注：${res.note}`)
}

// —— 自证：内存库种出已知孤儿，确认「查得出来」而不是恒返回 0 ——
function selftest() {
  const { initSchema } = require(path.join(ROOT, 'student-backend/schema/schema'))
  const db = new Database(':memory:')
  initSchema(db)
  // 自证要模拟的是**加外键声明之前的老库**：那时没有约束，库里才可能存在孤儿。
  // 不关外键的话，连「种一条孤儿」这一步都写不进去 —— 也正好说明：
  // 新库里不会再产生这类孤儿，这个检查器只对老库有意义。
  db.pragma('foreign_keys = OFF')
  const stu = db.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (?,?,?,?,?,?,?,?)")
  stu.run(1, '001', '初二', '3班', '张三', 14, '1', '')
  stu.run(2, '002', '初二', '3班', '李四', 14, '1', '')

  // ① 三条 student_id 孤儿
  db.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (999, '幽灵', '加分', '作业', 1)").run()
  db.prepare("INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间, 状态) VALUES (998, '幽灵', '事假', '2026-11-01', '2026-11-02', '已返校')").run()
  db.prepare("INSERT INTO cadre_members (cadre_id, student_id, student_name) VALUES (1, 997, '幽灵')").run()
  // ② 一条姓名孤儿（分组）
  db.prepare("INSERT INTO group_members (group_id, member_name) VALUES (1, '王五')").run()
  // ③ JSON 里的孤儿：座位一个 id、值日一个姓名
  db.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'").run(JSON.stringify([[1, 996], [null, null]]))
  db.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'").run(JSON.stringify({ 扫地: { 周一: ['张三', '赵六'] } }))

  const res = checkOrphans(db)
  printResult(res, '自证（内存库，预期 6 条孤儿）')
  const got = res.totalOrphans
  db.close()
  if (got !== 6) {
    console.error(`\n自证失败：预期 6 条孤儿，实际 ${got} 条 —— 检查器本身不可信`)
    process.exit(1)
  }
  console.log('\n自证通过：检查器确实能把 6 条孤儿逐类找出来')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) { selftest(); return }
  const file = args[0]
  if (!file) {
    console.error('用法：node testjs/tools/orphan-check.cjs <db 文件> [--key K] | --selftest')
    process.exit(2)
  }
  const keyIdx = args.indexOf('--key')
  const key = keyIdx > -1 ? args[keyIdx + 1] : ''
  if (!require('node:fs').existsSync(file)) {
    console.error('文件不存在：' + file)
    process.exit(2)
  }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    if (key) db.pragma(`key = '${key}'`)
    // 加密库用错密钥时这条会抛，能区分「打不开」与「没孤儿」
    db.prepare('SELECT 1 FROM students LIMIT 1').get()
    printResult(checkOrphans(db), path.basename(file))
  } finally {
    db.close()
  }
}

module.exports = { checkOrphans }
if (require.main === module) main()
