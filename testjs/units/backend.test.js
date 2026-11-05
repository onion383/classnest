// =========================================================================
// backend.test.js —— 后端数据层 / 纯逻辑单元测试
//   · schema：物理表合并 + 只读视图的最终形态
//   · sanitize：入库前清洗/校验纯函数
//   · recoveryKey：恢复密钥归一化/哈希/常数时间比较
//   · backendLogic：请假时间窗校验与 SQL 时间戳格式
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

// slotStore / businessRules 会连带 require ../db（需要主密钥），故先注入测试环境变量
const tmpDir = path.join(os.tmpdir(), 'backend-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || tmpDir

const ROOT = path.resolve(__dirname, '../..')
// better-sqlite3 装在 student-backend 下，用其 package.json 作为解析基准
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')

// ---- schema ----
const { initSchema } = require('../../student-backend/schema/schema')
const store = require('../../student-backend/services/slotStore')

const MERGED_TABLES = ['schedule_slots', 'duty_slots', 'seat_slots', 'domain_history']
const LOGICAL_VIEWS = [
  'schedule', 'master_schedule',
  'duty_settings', 'duty_layout', 'duty_template', 'duty_weight', 'duty_draft',
  'seat_layout', 'seat_template', 'seat_weight', 'seat_draft',
  'schedule_history', 'duty_history', 'seat_history',
]
const DROPPED_TABLES = [
  'schedule', 'master_schedule', 'schedule_settings', 'schedule_history',
  'duty_settings', 'duty_layout', 'duty_template', 'duty_weight', 'duty_draft', 'duty_history',
  'seat_layout', 'seat_template', 'seat_weight', 'seat_draft', 'seat_history',
]

function fresh() {
  const conn = new Database(':memory:')
  initSchema(conn)
  return conn
}

function objects(conn) {
  const rows = conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')").all()
  return {
    tables: new Set(rows.filter((r) => r.type === 'table').map((r) => r.name)),
    views: new Set(rows.filter((r) => r.type === 'view').map((r) => r.name)),
  }
}

const count = (conn, sql) => conn.prepare(sql).get().c

// ---- sanitize ----
const s = require('../../student-backend/services/sanitize')

// ---- recoveryKey ----
const {
  normalizePhrase, formatPhrase, deriveRestoreHash, safeEqualHash, pickPhrase, verifyRestoreHash,
} = require('../../student-backend/services/recoveryKey')

// ---- businessRules / utils/sql ----
const { assertLeaveWindow } = require('../../student-backend/services/businessRules')
const { now, isDateStr } = require('../../student-backend/utils/sql')

// =========================================================================
// schema
// =========================================================================
test('建表：四个合并表存在，旧单例表全部退化为只读视图', () => {
  const conn = fresh()
  const { tables, views } = objects(conn)
  MERGED_TABLES.forEach((t) => assert.ok(tables.has(t), `缺少合并表 ${t}`))
  LOGICAL_VIEWS.forEach((v) => assert.ok(views.has(v), `缺少逻辑视图 ${v}`))
  DROPPED_TABLES.forEach((t) => assert.ok(!tables.has(t), `旧表 ${t} 仍以物理表存在`))
  conn.close()
})

test('播种：槽位行数与默认配置正确', () => {
  const conn = fresh()
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM schedule_slots'), 2)
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM duty_slots'), 5)
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM seat_slots'), 4)
  // 学期不再默认播种：首次进入由用户填写学期日期后再创建
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM semesters'), 0)

  // 逻辑名读取（经视图）应拿到默认值
  const duty = conn.prepare('SELECT days, items, settings FROM duty_settings').get()
  // days 必须按模式分键（{daily,big}）：日常值日的列名是星期几，大扫除的列名是分组名，
  // 共用一份数组时大扫除没法表达「第一大组负责扫地」。读入口见 services/dutyConfig.js。
  const dutyDays = JSON.parse(duty.days)
  assert.equal(dutyDays.daily.length, 5)
  assert.deepEqual(dutyDays.daily, ['周一', '周二', '周三', '周四', '周五'])
  assert.ok(Array.isArray(dutyDays.big), 'days.big 应是数组')
  // 大扫除的列名是派生的（组数的纯函数）→ big 分键不存列名
  assert.deepEqual(dutyDays.big, [], 'days.big 不应存列名（列名由配置派生）')
  // settings 是按模式分键的模式配置（大扫除的周期/星期几/任务分组/数量）
  const dutySettings = JSON.parse(duty.settings)
  assert.equal(typeof dutySettings.daily, 'object')
  assert.equal(typeof dutySettings.big, 'object')
  assert.equal(dutySettings.big.groupType, 'big')
  assert.equal(dutySettings.big.groupCount, 3)
  // items 必须是按模式分键的结构（{daily,big}）：services/dutyMode.unpackMode 只认这种，
  // 播种成扁平数组时全新库的值日页一个项目都看不到。
  const dutyItems = JSON.parse(duty.items)
  assert.equal(dutyItems.daily.length, 3)
  assert.equal(dutyItems.big.length, 3)
  assert.equal(dutyItems.daily[0].name, '擦黑板')

  const seat = conn.prepare('SELECT mode, rows, cols FROM seat_layout').get()
  assert.deepEqual({ ...seat }, { mode: 'single', rows: 6, cols: 7 })

  const draft = conn.prepare('SELECT saved_at FROM duty_draft').get()
  assert.equal(draft.saved_at, '') // 无草稿
  conn.close()
})

// C04-03：列类型曾经有三层口径 —— DDL `年龄 INTEGER` / table_meta「文字」（种子省略了
// data_type，全落默认值）/ 前端 DEFAULT_FIELDS「整数」。真正决定入库校验口径的是
// table_meta，所以元数据说「文字」，年龄就永远不做整数校验。
test('table_meta 的列类型必须与 DDL 亲和一致（年龄=整数、金额=小数）', () => {
  const conn = fresh()
  for (const table of ['students', 'fee_records']) {
    const ddl = conn.prepare(`PRAGMA table_info(${table})`).all()
    const meta = conn.prepare('SELECT column_name, data_type FROM table_meta WHERE table_name = ?').all(table)
    assert.ok(meta.length > 0, `${table} 没有播种 table_meta`)
    for (const m of meta) {
      const col = ddl.find((c) => c.name === m.column_name)
      assert.ok(col, `${table}.${m.column_name} 在 DDL 里不存在（元数据与表结构漂移）`)
      const decl = String(col.type || '').toUpperCase()
      if (decl.includes('INT')) {
        assert.equal(m.data_type, '整数', `${table}.${m.column_name} 的 DDL 是 ${col.type}，元数据却是「${m.data_type}」`)
      } else if (decl.includes('REAL') || decl.includes('NUMERIC')) {
        assert.equal(m.data_type, '小数', `${table}.${m.column_name} 的 DDL 是 ${col.type}，元数据却是「${m.data_type}」`)
      }
    }
  }
  // 这两个列是这次修的具体项
  const meta = conn.prepare('SELECT table_name, column_name, data_type FROM table_meta').all()
  const typeOf = (t, c) => (meta.find((m) => m.table_name === t && m.column_name === c) || {}).data_type
  assert.equal(typeOf('students', '年龄'), '整数')
  assert.equal(typeOf('fee_records', '收支金额'), '小数')
  assert.equal(typeOf('fee_records', '收支时间'), '日期')
  conn.close()
})

// C04-03 的行为面：即便元数据播错（老库仍是「文字」），列级规则也必须挡住非整数
test('sanitizeField：年龄只接受整数，空值归一为 null', () => {
  assert.equal(s.sanitizeField('12', 'students', '年龄'), 12)
  assert.equal(s.sanitizeField(12, 'students', '年龄'), 12)
  assert.equal(s.sanitizeField('', 'students', '年龄'), null)
  assert.equal(s.sanitizeField(null, 'students', '年龄'), null)
  assert.throws(() => s.sanitizeField('abc', 'students', '年龄'), /需要数字|需要整数/)
  assert.throws(() => s.sanitizeField('12.5', 'students', '年龄'), /需要整数/)
  assert.throws(() => s.sanitizeField(-1, 'students', '年龄'), /不能小于/)
  assert.throws(() => s.sanitizeField(999, 'students', '年龄'), /不能大于/)
})

// 收据字段两种形状都要认：老数据是路径字符串数组，新结构带原始文件名/大小/类型。
// 只认字符串会让「点确定」直接报「第 1 个路径应为文本」——收据一条也存不进去。
test('sanitizeField：收据接受路径文本与 {path,name,size,kind} 两种形状', () => {
  const obj = [{ path: '/uploads/a.jpg', name: '运动会发票.jpg', size: 1024, kind: 'image' }]
  assert.deepEqual(s.sanitizeField(obj, 'fee_records', '收据'), obj)
  assert.deepEqual(s.sanitizeField(['/uploads/b.jpg'], 'fee_records', '收据'), ['/uploads/b.jpg'])
  // 空值剔除；非法对象与穿越路径仍要报错（放宽形状 ≠ 放宽安全性）
  assert.deepEqual(s.sanitizeField(['', null], 'fee_records', '收据'), [])
  assert.throws(() => s.sanitizeField([{ foo: 1 }], 'fee_records', '收据'), /应为路径文本/)
  assert.throws(() => s.sanitizeField([{ path: '/uploads/../x.txt' }], 'fee_records', '收据'), /不能包含/)
})

test('students：is_provisional 列 + 临时同名唯一索引', () => {  const conn = fresh()
  const cols = conn.prepare('PRAGMA table_info(students)').all().map((c) => c.name)
  assert.ok(cols.includes('is_provisional'), '缺少 is_provisional 列')

  // 正式学生允许重名（真实班级里可能就有同名）
  conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('张三')
  conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('张三')
  assert.equal(count(conn, "SELECT COUNT(*) c FROM students WHERE 姓名 = '张三'"), 2)

  // 临时学生同名只允许一条：这是「多处同时输入同一个名字」不产生重复记录的硬保证
  conn.prepare('INSERT INTO students (姓名, is_provisional) VALUES (?, 1)').run('李四')
  assert.throws(
    () => conn.prepare('INSERT INTO students (姓名, is_provisional) VALUES (?, 1)').run('李四'),
    /UNIQUE/i
  )

  // 正式与临时同名是允许的（临时只是「还没转正的同名学生」）
  conn.prepare('INSERT INTO students (姓名) VALUES (?)').run('李四')
  assert.equal(count(conn, "SELECT COUNT(*) c FROM students WHERE 姓名 = '李四'"), 2)
  conn.close()
})

test('写入走物理表、读取走视图；视图本身不可写', () => {
  const conn = fresh()
  const cells = JSON.stringify([[{ course: '数学' }]])
  conn.prepare("UPDATE schedule_slots SET cells = ? WHERE kind = 'current'").run(cells)

  assert.equal(conn.prepare('SELECT cells FROM schedule').get().cells, cells)
  // master 与 current 互不影响
  assert.equal(conn.prepare('SELECT cells FROM master_schedule').get().cells, '[]')

  // 只读视图：直接 UPDATE 必须被 SQLite 拒绝，确保写路径只能走 slotStore
  assert.throws(() => conn.prepare("UPDATE schedule SET cells = '[]'").run(), /view/i)
  conn.close()
})

test('domain_history：payload JSON 正确映射到三域历史视图', () => {
  const conn = fresh()
  const seatPayload = {
    mode: 'single', rows: 2, cols: 2,
    seats: [[1, null], [null, 2]],
    aisleCols: [], groupsConfig: [], settings: { showAisle: false },
  }
  conn.prepare('INSERT INTO domain_history (domain, week_start, snap_date, mode, payload) VALUES (?,?,?,?,?)')
    .run('seat', '2026-10-19', '2026-10-20', 'single', JSON.stringify(seatPayload))

  const seat = conn.prepare('SELECT * FROM seat_history WHERE snap_date = ?').get('2026-10-20')
  assert.equal(seat.week_start, '2026-10-19')
  assert.equal(seat.mode, 'single')
  assert.equal(seat.rows, 2)
  assert.deepEqual(JSON.parse(seat.seats), [[1, null], [null, 2]])
  assert.deepEqual(JSON.parse(seat.aisle_cols), [])
  assert.deepEqual(JSON.parse(seat.settings), { showAisle: false })

  conn.prepare('INSERT INTO domain_history (domain, week_start, snap_date, mode, payload) VALUES (?,?,?,?,?)')
    .run('duty', '2026-10-19', '2026-10-19', 'daily', JSON.stringify({ cells: { 扫地: { 周一: ['张三'] } }, settings: {} }))
  const duty = conn.prepare('SELECT cells FROM duty_history WHERE mode = ?').get('daily')
  assert.deepEqual(JSON.parse(duty.cells), { 扫地: { 周一: ['张三'] } })

  conn.prepare('INSERT INTO domain_history (domain, week_start, snap_date, mode, payload) VALUES (?,?,?,?,?)')
    .run('schedule', '2026-10-19', '', '', JSON.stringify({ cells: [[{ course: '语文' }]], settings: { days: ['周一'] } }))
  const sched = conn.prepare('SELECT cells, settings FROM schedule_history WHERE week_start = ?').get('2026-10-19')
  assert.deepEqual(JSON.parse(sched.cells), [[{ course: '语文' }]])
  assert.deepEqual(JSON.parse(sched.settings), { days: ['周一'] })
  conn.close()
})

test('initSchema 遇到「同名对象是表不是视图」的老库不抛错（B05-06）', () => {
  // 老库里 schedule / seat_layout 这些名字曾经是**表**。SQLite 的 DROP VIEW IF EXISTS
  // 只抑制「不存在」，不抑制「类型不对」——会直接抛 use DROP TABLE to delete table，
  // 整个 initSchema 在批量 exec 里中断，库打不开且错误指不到具体名字。
  const conn = new Database(':memory:')
  // 造一个「名字占住但类型是表」的老库
  conn.exec("CREATE TABLE schedule (id INTEGER PRIMARY KEY, junk TEXT)")
  conn.exec("CREATE TABLE seat_layout (id INTEGER PRIMARY KEY, junk TEXT)")
  conn.exec("CREATE TABLE duty_layout (id INTEGER PRIMARY KEY, junk TEXT)")
  assert.doesNotThrow(() => initSchema(conn), 'initSchema 不该因为同名表而中断')
  // 建完仍然是视图（老表被替换掉），且形状符合预期
  const kinds = Object.fromEntries(
    conn.prepare("SELECT name, type FROM sqlite_master WHERE name IN ('schedule','seat_layout','duty_layout')").all()
      .map((r) => [r.name, r.type]),
  )
  assert.equal(kinds.schedule, 'view')
  assert.equal(kinds.seat_layout, 'view')
  assert.equal(kinds.duty_layout, 'view')
  conn.close()
})

test('initSchema 幂等：二次执行不重复播种、不丢已有数据', () => {
  const conn = fresh()
  const cells = JSON.stringify([[{ course: '语文' }]])
  conn.prepare("UPDATE schedule_slots SET cells = ? WHERE kind = 'current'").run(cells)

  initSchema(conn)

  assert.equal(count(conn, 'SELECT COUNT(*) c FROM schedule_slots'), 2)
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM duty_slots'), 5)
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM seat_slots'), 4)
  assert.equal(count(conn, 'SELECT COUNT(*) c FROM semesters'), 0)
  assert.equal(conn.prepare('SELECT cells FROM schedule').get().cells, cells)
  // 视图仍然可用
  assert.equal(conn.prepare('SELECT COUNT(*) c FROM duty_layout').get().c, 1)
  conn.close()
})

test('slotStore：逻辑名映射与可写列白名单', () => {
  assert.equal(store.isDoc('duty_layout'), true)
  assert.equal(store.isDoc('seat_weight'), true)
  assert.equal(store.isDoc('students'), false) // 动态表不归 slotStore 管

  assert.deepEqual(store.columnsOf('schedule').sort(), ['cells', 'settings'])
  assert.deepEqual(
    store.columnsOf('seat_layout').sort(),
    ['aisle_cols', 'cols', 'groups_config', 'mode', 'rows', 'seats', 'settings'],
  )
  assert.deepEqual(store.columnsOf('duty_draft').sort(), ['cells', 'conditions', 'saved_at', 'settings'])
  assert.deepEqual(store.columnsOf('duty_weight').sort(), ['settings', 'weights'])
})

// =========================================================================
// sanitize
// =========================================================================
test('cleanText：换行归一、去零宽/控制字符、trim、超长截断', () => {
  assert.equal(s.cleanText('  a\r\nb  '), 'a\nb')          // \r\n → \n 且去首尾空白
  assert.equal(s.cleanText('a\u200bb'), 'ab')               // 去零宽字符
  assert.equal(s.cleanText('a\u0000b'), 'ab')               // 去控制字符
  assert.equal(s.cleanText('x'.repeat(s.MAX_TEXT_LEN + 10)).length, s.MAX_TEXT_LEN)
})

test('normBool：true/1 → 1，false/0 → 0，非法报错', () => {
  assert.equal(s.normBool(true), 1)
  assert.equal(s.normBool('1'), 1)
  assert.equal(s.normBool('true'), 1)
  assert.equal(s.normBool(false), 0)
  assert.equal(s.normBool('0'), 0)
  assert.equal(s.normBool(''), 0)
  assert.equal(s.normBool(null), 0)
  // 纯空白串 trim 后是 ''，此前和 'true' 一起落到 return 1 —— 一个空格就把开关打开了
  assert.equal(s.normBool('   '), 0)
  assert.equal(s.normBool('\t\n'), 0)
  assert.throws(() => s.normBool('maybe', 'x'))
})

test('normNumber：空 → null，非法报错，可转数字则归一', () => {
  assert.equal(s.normNumber('', 'x'), null)
  assert.equal(s.normNumber(null, 'x'), null)
  assert.equal(s.normNumber('3.5', 'x'), 3.5)
  assert.throws(() => s.normNumber('abc', 'x'))
})

test('normInt：整数列拒绝小数与非法数字', () => {
  assert.equal(s.normInt('3', 'x'), 3)
  assert.equal(s.normInt(3, 'x'), 3)
  assert.equal(s.normInt('', 'x'), null)
  assert.equal(s.normInt(null, 'x'), null)
  assert.throws(() => s.normInt('1.5', 'x'), /需要整数/)
  assert.throws(() => s.normInt(1.5, 'x'), /需要整数/)
  assert.throws(() => s.normInt('abc', 'x'), /需要数字/)
})

test('cleanByType：整数列对字符串与数字都强制整数（1.5 不再放过）', () => {
  assert.equal(s.cleanByType('3', '整数', 'x'), 3)
  assert.equal(s.cleanByType(3, '整数', 'x'), 3)
  assert.throws(() => s.cleanByType('1.5', '整数', 'x'), /需要整数/)
  assert.throws(() => s.cleanByType(1.5, '整数', 'x'), /需要整数/)
  assert.equal(s.cleanByType('1.25', '小数', 'x'), 1.25)
  assert.equal(s.cleanByType('  文本 ', '文字', 'x'), '文本')
})

test('roundTo：按十进制舍入，消除二进制浮点误差', () => {
  assert.equal(s.roundTo(1.005, 2), 1.01)
  assert.equal(s.roundTo(2.675, 2), 2.68)
  assert.equal(s.roundTo(0.1 + 0.2, 2), 0.3)
  assert.equal(s.roundTo(12.345, 2), 12.35)
  assert.equal(s.roundTo(123.456, 1), 123.5)
  assert.equal(s.roundTo(10, 2), 10)
  assert.equal(s.roundTo(1.4, 0), 1)
})

test('sanitizeField：分值/成员数等非数字被拒，NaN 不再静默落库', () => {
  assert.equal(s.sanitizeField('5.5', 'score_records', '分值'), 5.5)
  assert.throws(() => s.sanitizeField('abc', 'score_records', '分值'), /需要数字/)
  assert.throws(() => s.sanitizeField(NaN, 'score_records', '分值'), /需要数字/)
  assert.throws(() => s.sanitizeField(100001, 'score_records', '分值'), /不能大于/)
  assert.throws(() => s.normNumber('abc', '成员数'), /需要数字/)
  assert.throws(() => s.normNumber(NaN, '成员数'), /需要数字/)
})

test('better-sqlite3 绑定 NaN 会静默落成 NULL（故必须在入库前拦下）', () => {
  // 事实性用例：证明「缺了前置拒绝就会丢值」——NaN 绑定不报错，但 score 变成 NULL
  const conn = new Database(':memory:')
  conn.exec('CREATE TABLE t (score REAL, note TEXT)')
  conn.prepare('INSERT INTO t (score, note) VALUES (?, ?)').run(NaN, 'abc')
  const row = conn.prepare('SELECT score, typeof(score) AS ty FROM t').get()
  assert.deepEqual({ ...row }, { score: null, ty: 'null' })
  conn.close()
})

test('strictDate：合法日期归一 YYYY-MM-DD，非法/越界年份拒绝', () => {
  assert.equal(s.strictDate('2026/1/5', 'd'), '2026-01-05')
  assert.equal(s.strictDate('2026-1-5 9:08', 'd'), '2026-01-05 09:08')
  assert.equal(s.strictDate('', 'd'), null)
  assert.throws(() => s.strictDate('2026-2-30', 'd'))   // 不存在的日期
  assert.throws(() => s.strictDate('1999-1-1', 'd'))    // 年份越界
  assert.throws(() => s.strictDate('not-a-date', 'd'))
})

test('cleanPath：允许盘符前缀，拒绝「..」与非法字符', () => {
  assert.equal(s.cleanPath('C:\\a\\b', 'p'), 'C:\\a\\b')
  assert.equal(s.cleanPath('', 'p'), null)
  assert.throws(() => s.cleanPath('../etc', 'p'))
  assert.throws(() => s.cleanPath('a<b', 'p'))
})

test('sanitizeField：命中列级规则（枚举 / 数值范围与精度 / 布尔）', () => {
  assert.equal(s.sanitizeField('收入', 'fee_records', '收支类型'), '收入')
  assert.throws(() => s.sanitizeField('转账', 'fee_records', '收支类型'))
  assert.equal(s.sanitizeField('12.345', 'fee_records', '收支金额'), 12.35) // decimals=2
  assert.throws(() => s.sanitizeField('-1', 'fee_records', '收支金额'))     // min=0
  assert.equal(s.sanitizeField('1', 'countdowns', '包含这一天'), 1)
  assert.equal(s.sanitizeField(true, 'countdowns', '包含这一天'), 1)
})

test('sanitizeField：课表/座位/值日等逻辑表名规则仍然生效', () => {
  // 这些逻辑表已物理合并为槽位表，但 COLUMN_RULES 仍以逻辑名索引
  assert.doesNotThrow(() => s.sanitizeField([[{ course: '语文' }]], 'schedule', 'cells'))
  assert.throws(() => s.sanitizeField('not-json', 'schedule', 'cells'))

  assert.doesNotThrow(() => s.sanitizeField([[1, '张三'], [null, 2]], 'seat_layout', 'seats'))
  assert.throws(() => s.sanitizeField([1, 2, 3], 'seat_layout', 'seats'))

  assert.doesNotThrow(() => s.sanitizeField({ daily: { 扫地: { 周一: ['张三'] } }, big: {} }, 'duty_layout', 'cells'))
  assert.throws(() => s.sanitizeField('[]', 'duty_layout', 'cells')) // 值日 cells 必须是对象
  // 单模式/旧版整块不再接受：读取侧只认 {daily,big} 打包结构
  assert.throws(() => s.sanitizeField({ 扫地: { 周一: ['张三'] } }, 'duty_layout', 'cells'))

  assert.doesNotThrow(() => s.sanitizeField({ days: ['周一'], items: [] }, 'duty_weight', 'weights'))
  assert.throws(() => s.sanitizeField([], 'duty_weight', 'weights'))
})

test('normalizeSeats：二维数组原样通过；扁平对象数组规范化为二维', () => {
  assert.deepEqual(s.normalizeSeats([[1, '张三'], [null, 2]]), [[1, '张三'], [null, 2]])
  assert.deepEqual(
    s.normalizeSeats([{ row: 1, col: 2, student_id: 5 }, { row: 2, col: 1, name: '李四' }]),
    [[null, 5], ['李四', null]],
  )
  assert.throws(() => s.normalizeSeats([{ row: 0, col: 1, student_id: 1 }]))
})

test('normalizeSeats：坐标与行列数超限直接拒绝（防 OOM）', () => {
  // 扁平数组不能按超大 row/col 分配矩阵
  assert.throws(() => s.normalizeSeats([{ row: 51, col: 1, student_id: 1 }]), /超出上限/)
  assert.throws(() => s.normalizeSeats([{ row: 1, col: 31, student_id: 1 }]), /超出上限/)
  // 二维数组同样受 50×30 上限约束
  assert.throws(() => s.normalizeSeats(Array.from({ length: 51 }, () => [])), /行数超出上限/)
  assert.throws(() => s.normalizeSeats([Array(31).fill(null)]), /列数超出上限/)
  // 上限本身合法
  assert.equal(s.normalizeSeats([{ row: 50, col: 30, student_id: 1 }])[49][29], 1)
})

// =========================================================================
// 鉴权：recover token 的接口白名单
// =========================================================================
test('isRecoverScopeAllowed：只放行改密与登出，其余路径一律拒绝', () => {
  const { isRecoverScopeAllowed } = require('../../student-backend/middleware/auth')
  const req = (method, originalUrl) => ({ method, originalUrl })
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password')), true)
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password?x=1')), true)
  // 登出放行的必须是与 routes/auth.js 注册一致的路径。authRoutes 挂在 app.use('/api', ...) 下，
  // 真实路径是 /api/logout；此前白名单写 /api/auth/logout，与前端同步写错，
  // 导致这条放行规则从未生效过（请求先 404 了），本用例当时把错的当成了预期值。
  assert.equal(isRecoverScopeAllowed(req('POST', '/api/logout')), true)
  assert.equal(isRecoverScopeAllowed(req('POST', '/api/auth/logout')), false)
  assert.equal(isRecoverScopeAllowed(req('GET', '/api/students')), false)
  assert.equal(isRecoverScopeAllowed(req('POST', '/api/account/export')), false)
  // 尾斜杠要归一后再比：Express 默认非严格路由，`PUT /api/account/password/` 会命中**同一个**
  // 改密 handler（已实测 200），白名单却按精确串匹配 → 请求进得来但被判越权，
  // recover 流程永久 401、用户彻底卡死。归一只是多放行这一个字符串，不是前缀匹配。
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password/')), true)
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password//')), true)
  // 路径穿越/编码/方法混淆都不能借白名单前缀绕过（归一化不做路径解析）
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password/../export')), false)
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password/../export/')), false)
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password/../../admin')), false)
  assert.equal(isRecoverScopeAllowed(req('PUT', '/api/account/password%2F')), false)
  assert.equal(isRecoverScopeAllowed(req('DELETE', '/api/account/password')), false)
  assert.equal(isRecoverScopeAllowed(req('DELETE', '/api/account/password/')), false)
})

// =========================================================================
// AI 子助手：只读工具白名单（执行侧强制校验，不能只靠下发的工具清单）
// =========================================================================
test('isSubagentToolAllowed：只读工具放行，写操作/提问/导出/递归子助手一律拒绝', () => {
  const { SUBAGENT_TOOL_NAMES, isSubagentToolAllowed } = require('../../student-backend/routes/ai/ai.subagent-tools')
  for (const n of ['query', 'aggregate', 'resolve_student', 'search_all', 'run_checks', 'describe_table', 'teaching_week', 'get_time']) {
    assert.equal(isSubagentToolAllowed(n), true)
  }
  for (const n of ['save_memory', 'undo_change', 'ask_user', 'propose_write', 'propose_delete_many', 'export_file', 'export_image', 'snapshot_create', 'run_subagent', 'web_search', '', null]) {
    assert.equal(isSubagentToolAllowed(n), false)
  }
  // 名单本身也不得混入任何写操作（防止后续新增只读工具时误加写工具）
  const forbidden = /^(propose_|save_memory|undo_change|ask_user|export_|snapshot_|run_subagent|web_search)/
  assert.deepEqual([...SUBAGENT_TOOL_NAMES].filter((n) => forbidden.test(n)), [])
})

// =========================================================================
// 动态表：renameColumn 的列名白名单（oldName 同样会拼进 SQL，必须校验）
// =========================================================================
test('renameColumn：旧列名/新列名都拒绝注入与保留字段', () => {
  const ts = require('../../student-backend/services/tableService')
  // 只校验 newName 时，下面这条会闭合引号并在 SQL 中追加 RENAME/DROP
  assert.throws(() => ts.renameColumn('students', '姓名" TO "zzz", RENAME COLUMN "学号', 'x'), /字段名不合法/)
  // 其它注入形态与非法字符同样拒绝
  assert.throws(() => ts.renameColumn('students', '姓名; DROP TABLE students', 'x'), /字段名不合法/)
  // 新列名仍按原规则校验：保留字段、空串、带空格都不行
  assert.throws(() => ts.renameColumn('students', '姓名', 'id'), /字段名不合法/)
  assert.throws(() => ts.renameColumn('students', '姓名', 'new name'), /字段名不合法/)
  assert.throws(() => ts.renameColumn('students', '', 'x'), /缺少参数/)
  assert.throws(() => ts.renameColumn('students', '姓名', ''), /缺少参数/)
})

// =========================================================================
// 动态表：tableService 的表名白名单（纵深防御，防止新调用方漏白名单造成注入）
// =========================================================================
test('tableService：只接受白名单内的表名', () => {
  const ts = require('../../student-backend/services/tableService')
  assert.throws(() => ts.queryAll('students; DROP TABLE users'), /表名不合法/)
  assert.throws(() => ts.renameColumn('evil_table', 'a', 'b'), /表名不合法/)
  assert.throws(() => ts.reorderRows('sqlite_master', [1]), /表名不合法/)
})



// =========================================================================
// recoveryKey
// =========================================================================
test('normalizePhrase 只保留汉字（去掉序号/空格/标点）', () => {
  assert.equal(normalizePhrase('1.山  2.水, 3.风'), '山水风')
  assert.equal(normalizePhrase('  山水风  '), '山水风')
  assert.equal(normalizePhrase('abc123'), '')
})

test('formatPhrase 按「1.字  2.字」输出，与 normalize 结果对应', () => {
  assert.equal(formatPhrase('山水风'), '1.山  2.水  3.风')
  // 抄写时混入序号与空格也应还原成同一串
  assert.equal(formatPhrase('1.山 2.水'), '1.山  2.水')
})

test('deriveRestoreHash 稳定、带版本前缀，且不同短语不同哈希', () => {
  const h1 = deriveRestoreHash('山水风')
  const h2 = deriveRestoreHash('山水风')
  // 格式：'restore:<版本>:<64位hex>' —— 版本前缀让将来换算法时能识别旧值（批 16 / B04-07）
  assert.match(h1, /^restore:v\d+:[0-9a-f]{64}$/)
  assert.equal(h1, h2)
  assert.notEqual(h1, deriveRestoreHash('山水雨'))
})

test('safeEqualHash 常数时间比较：仅字符串相等才 true', () => {
  const h = deriveRestoreHash('山水风')
  assert.equal(safeEqualHash(h, h), true)
  assert.equal(safeEqualHash(h, h.slice(0, -1) + '0'), false)
  assert.equal(safeEqualHash(h, null), false)
  assert.equal(safeEqualHash(undefined, h), false)
})

test('verifyRestoreHash：新格式与历史裸 hex 都能校验通过（旧恢复词不能失效）', () => {
  const crypto = require('crypto')
  const phrase = '山水风'
  // 新格式：带版本前缀
  assert.equal(verifyRestoreHash(phrase, deriveRestoreHash(phrase)), true)
  // 历史格式：裸 sha256 hex（批 16 之前发出的恢复词就是这种）
  const legacy = crypto.createHash('sha256').update('restore:' + phrase).digest('hex')
  assert.equal(verifyRestoreHash(phrase, legacy), true)
  // 错误短语一律拒绝
  assert.equal(verifyRestoreHash('山水雨', deriveRestoreHash(phrase)), false)
  assert.equal(verifyRestoreHash('山水雨', legacy), false)
  // 脏输入不炸
  assert.equal(verifyRestoreHash(phrase, null), false)
  assert.equal(verifyRestoreHash(phrase, ''), false)
})

test('pickPhrase 生成 12 个汉字', () => {
  const p = pickPhrase()
  assert.equal(p.length, 12)
  assert.match(p, /^[\u4e00-\u9fa5]{12}$/)
})

// =========================================================================
// businessRules / utils/sql
// =========================================================================
test('assertLeaveWindow：结束时间必须晚于开始时间', () => {
  assert.doesNotThrow(() => assertLeaveWindow('2026-10-17 08:00', '2026-10-17 12:00'))
  assert.doesNotThrow(() => assertLeaveWindow('2026-10-17', '2026-10-18')) // 仅日期按 00:00:00 比较
  assert.throws(() => assertLeaveWindow('2026-10-17 12:00', '2026-10-17 08:00'))
  assert.throws(() => assertLeaveWindow('2026-10-17 08:00', '2026-10-17 08:00'))
  // 任一缺失则不校验
  assert.doesNotThrow(() => assertLeaveWindow('', '2026-10-17'))
  assert.doesNotThrow(() => assertLeaveWindow('2026-10-17', ''))
})

test('now：输出 YYYY-MM-DD HH:mm 本地时间', () => {
  const str = now()
  assert.match(str, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  assert.equal(str, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`)
})

test('isDateStr：只接受真实存在的 YYYY-MM-DD，挡住快照的幽灵周', () => {
  assert.equal(isDateStr('2026-10-28'), true)
  assert.equal(isDateStr('2024-02-29'), true)          // 闰年 2 月 29 日存在
  assert.equal(isDateStr(' 2026-10-28 '), true)        // 前后空白容忍
  assert.equal(isDateStr('2026-02-29'), false)         // 非闰年不存在
  assert.equal(isDateStr('2026-13-01'), false)         // 月份越界
  assert.equal(isDateStr('2026-00-10'), false)
  assert.equal(isDateStr('2026-10-32'), false)
  assert.equal(isDateStr('2026-1-1'), false)           // 必须补零
  assert.equal(isDateStr('2026-10-28T00:00:00'), false)
  assert.equal(isDateStr('2026-10-28 00:00'), false)
  assert.equal(isDateStr(''), false)
  assert.equal(isDateStr(null), false)
  assert.equal(isDateStr(20261028), false)
})

// =========================================================================
// 账号名规则与注册草稿（P1-05）
// =========================================================================
test('usernameRules：注册与改名共用同一套长度/字符规则', () => {
  const { USERNAME_MIN, USERNAME_MAX, normalizeUsername, usernameError } =
    require('../../student-backend/services/usernameRules')
  assert.equal(USERNAME_MIN, 2)
  assert.equal(USERNAME_MAX, 30)
  assert.equal(normalizeUsername('  张三  '), '张三')
  assert.equal(normalizeUsername(null), '')
  // 合法
  assert.equal(usernameError('张三'), '')
  assert.equal(usernameError('abc_2024'), '')
  assert.equal(usernameError('a@b.c-d'), '')
  assert.equal(usernameError('x'.repeat(30)), '')
  // 长度
  assert.match(usernameError('张'), /长度/)
  assert.match(usernameError('x'.repeat(31)), /长度/)
  assert.match(usernameError('   '), /长度/)
  assert.match(usernameError(undefined), /长度/)
  // 字符白名单：路径分隔符、控制字符、emoji 都不行
  assert.match(usernameError('张三/李四'), /非法字符/)
  assert.match(usernameError('张三\\李四'), /非法字符/)
  assert.match(usernameError('张三:李四'), /非法字符/)
  assert.match(usernameError('张三\n李四'), /非法字符/)
  assert.match(usernameError('😀😀'), /非法字符/)
})

test('pendingRegs：草稿超过容量淘汰最旧，不再无上限堆积', () => {
  const pending = require('../../student-backend/services/pendingRegs')
  pending._reset()
  const ids = []
  for (let i = 0; i < pending.PENDING_MAX + 3; i++) ids.push(pending.put({ username: `u${i}` }))

  assert.equal(pending.size(), pending.PENDING_MAX, '容量必须卡在上限')
  for (let i = 0; i < 3; i++) {
    assert.equal(pending.get(ids[i]), undefined, '最旧的草稿应被淘汰')
  }
  assert.deepEqual(pending.get(ids[3]), { username: 'u3' })
  assert.deepEqual(pending.get(ids[ids.length - 1]), { username: `u${ids.length - 1}` })

  pending.remove(ids[ids.length - 1])
  assert.equal(pending.size(), pending.PENDING_MAX - 1)
  pending._reset()
  assert.equal(pending.size(), 0)
})

// =========================================================================
// dutyCells：值日表结构遍历（P1-07 / B04-07）
// =========================================================================
test('dutyCells：daily/big 打包结构的统计与清理', () => {
  const { countDutyRefs, removeDutyName } = require('../../student-backend/services/dutyCells')

  const packed = {
    daily: { 扫地: { 周一: ['张三', '李四'] } },
    big: { 大扫除: { 周五: ['张三'] } },
  }
  assert.equal(countDutyRefs(packed, '张三'), 2, 'daily 与 big 都要统计')
  assert.equal(removeDutyName(packed, '张三'), 2, 'daily 与 big 都要清理')
  assert.deepEqual(packed, {
    daily: { 扫地: { 周一: ['李四'] } },
    big: { 大扫除: { 周五: [] } },
  })
})

test('dutyCells：空/数组/畸形输入不抛错', () => {
  const { dutyRoots, countDutyRefs, removeDutyName } = require('../../student-backend/services/dutyCells')
  assert.deepEqual(dutyRoots(null), [])
  assert.deepEqual(dutyRoots([]), [])
  assert.deepEqual(dutyRoots({}), [])
  assert.equal(countDutyRefs(null, '张三'), 0)
  assert.equal(countDutyRefs({}, '张三'), 0)
  assert.equal(countDutyRefs({ daily: 'oops' }, '张三'), 0)
  assert.equal(removeDutyName({ daily: 'oops' }, '张三'), 0)
  // 非打包结构不再识别（不做旧版兼容）：统计与清理都命中不了
  const notPacked = { 扫地: { 周一: ['张三'] }, daily: {} }
  assert.equal(countDutyRefs(notPacked, '张三'), 0)
})

test('dutyMode/dutyCells：打包结构的解包与宽容度', () => {
  const { toModeMap } = require('../../student-backend/services/dutyMode')
  const { countDutyRefs, removeDutyName } = require('../../student-backend/services/dutyCells')

  // 按模式打包：逐模式解包
  const packed = { daily: { 扫地: { 周一: ['李四'] } }, big: {} }
  assert.deepEqual(toModeMap(packed), { daily: { 扫地: { 周一: ['李四'] } }, big: {} })
  assert.equal(countDutyRefs(packed, '李四'), 1)

  // 另一个模式为 null / 畸形时仍按模式打包解包（保持原有宽容度）
  const halfBroken = { daily: { 扫地: { 周一: ['王五'] } }, big: null }
  assert.deepEqual(toModeMap(halfBroken).daily, { 扫地: { 周一: ['王五'] } })
  assert.equal(countDutyRefs(halfBroken, '王五'), 1)

  // 非打包结构（旧版整块）不再兼容：解包为空，统计/清理落空
  const legacy = { 扫地: { 周一: ['张三'] } }
  assert.deepEqual(toModeMap(legacy), { daily: {}, big: {} })
  assert.equal(countDutyRefs(legacy, '张三'), 0)
  assert.equal(removeDutyName(legacy, '张三'), 0)
})

test('dutyMode.unpackMode：空值形态随字段契约（items 回 []、cells 回 {}）', () => {
  const { unpackMode } = require('../../student-backend/services/dutyMode')
  // items 的模式值是数组：缺失/旧结构/畸形都必须回 [] —— 回 {} 会让前端 items.forEach 崩掉
  const packedItems = { daily: [{ name: '扫地', count: 1 }], big: [] }
  assert.deepEqual(unpackMode(packedItems, 'daily', []), [{ name: '扫地', count: 1 }])
  assert.deepEqual(unpackMode(packedItems, 'big', []), [])
  assert.deepEqual(unpackMode(null, 'daily', []), []) // 缺失
  assert.deepEqual(unpackMode('[{"name":"旧结构"}]', 'daily', []), []) // 旧版整块（数组）不识别，读为空
  assert.deepEqual(unpackMode('{"daily":{}}', 'daily', []), []) // 模式值形态不对（对象冒充数组）
  // cells 的模式值是对象：默认空形态 {} 行为不变
  const packedCells = { daily: { 扫地: { 周一: ['李四'] } }, big: {} }
  assert.deepEqual(unpackMode(packedCells, 'daily'), { 扫地: { 周一: ['李四'] } })
  assert.deepEqual(unpackMode(packedCells, 'big'), {})
  assert.deepEqual(unpackMode(null, 'daily'), {})
  assert.deepEqual(unpackMode('[1,2]', 'daily'), {}) // 数组冒充对象也回 {}
})

test.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} })
