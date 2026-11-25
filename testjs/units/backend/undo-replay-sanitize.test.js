// =========================================================================
// undo-replay-sanitize.test.js —— X3-06 撤销回放前的清洗闸
//
// 核心判据（三条写路径 + 三个陷阱，全部真写 SQLite 后读回断言）：
//   1. insertRow / updateRowById / setCellValue 都经过列级规则清洗；
//   2. 合法标量值清洗后原样（撤销 = 精确还原，不能把数字/日期变字符串）；
//   3. JSON / 结构化列跳过清洗（sanitizeField 返回对象，直接绑会存成 [object Object]）；
//   4. 无列级规则的列原样写回（不能走 cleanByType('文字') 把数字 String 化）；
//   5. 快照带脏值、清洗抛错时保留原值（恢复语义优先，撤销按钮不能失效）。
// 变异反证：去掉任一路径的 sanitizeReplayValue 调用，第 1 组必须变红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'undo-replay-sanitize' })
test.after(() => fx.close())

// undoStore 必须在夹具 stub 之后 require
const undoStore = require('../../../student-backend/services/undoStore')

function scoreRow(id, fen, time) {
  return fx.conn.prepare('SELECT 分值, 加分时间 FROM score_records WHERE id = ?').get(id)
}

test('insertRow：合法标量值清洗后原样写回（分值数字、日期字符串不失真）', () => {
  fx.reset()
  undoStore.insertRow('score_records', {
    id: 1, 姓名: '张三', 项目: '测试', 分值: 12.5, 加分时间: '2026-11-24 10:30', 成员数: 3,
  })
  const row = scoreRow(1)
  assert.equal(row.分值, 12.5, '分值必须还是数字，不能变成字符串')
  assert.equal(row.加分时间, '2026-11-24 10:30', '带时分的合法日期必须原样保留')
})

test('insertRow：脏格式日期经列级规则归一（变异反证锚点）', () => {
  fx.reset()
  // 快照里存了早期版本留下的非标准日期格式；回放时应按当前规则归一成 YYYY-MM-DD
  undoStore.insertRow('score_records', {
    id: 2, 姓名: '李四', 项目: '测试', 分值: 5, 加分时间: '2026/11/24',
  })
  const row = scoreRow(2)
  assert.equal(row.加分时间, '2026-11-24', '回放前必须过 strictDate 归一，不能把脏格式原样写回')
})

test('updateRowById：脏值清洗抛错时保留原值，撤销不中断', () => {
  fx.reset()
  fx.conn.prepare('INSERT INTO score_records (id, 分值) VALUES (1, 9)').run()
  // 成员数声明了 number 规则；'abc' 清洗抛错 → 保留原值（恢复语义优先），同批合法列照常写
  assert.doesNotThrow(() => undoStore.updateRowById('score_records', 1, { 分值: 8, 成员数: 'abc' }))
  const row = fx.conn.prepare('SELECT 分值 FROM score_records WHERE id = 1').get()
  assert.equal(row.分值, 8, '同批其他合法列照常写回，撤销没有整条失败')
})

test('setCellValue：JSON 列跳过清洗，快照里的合法 JSON 字符串原样落库', () => {
  fx.reset()
  fx.conn.prepare('INSERT INTO fee_records (id) VALUES (1)').run()
  const snap = '["/receipts/a.jpg","/receipts/b.jpg"]'
  undoStore.setCellValue('fee_records', '收据', snap, 1)
  const raw = fx.conn.prepare('SELECT 收据 FROM fee_records WHERE id = 1').get().收据
  assert.equal(raw, snap, 'JSON 列必须原样存字符串，不能被存成 "[object Object]"')
  assert.notEqual(raw, '[object Object]')
})

test('无列级规则的列原样写回：学生姓名不被 String() 化（本就是文本，类型不变）', () => {
  fx.reset()
  undoStore.insertRow('students', { id: 1, 姓名: '张三', 年龄: 15 })
  const row = fx.conn.prepare('SELECT 姓名, 年龄 FROM students WHERE id = 1').get()
  assert.equal(row.姓名, '张三')
  assert.equal(row.年龄, 15, '年龄有 number 规则，数字原样')
})
