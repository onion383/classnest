// =========================================================================
// duty-student-id.test.js —— P2-2：值日格存学生 id
//
// 这一条做四件事，每件都有独立判据：
//   ① 写入：格子里允许是学生 id（正整数）或姓名（老数据 / 名册外的人）
//   ② 改名：id 格不用动 —— 这是最实在的收益，改名不再需要遍历整张值日表
//   ③ 删除学生：按 id 精确清，同名的另一个人（字符串格或另一个 id）不受影响
//
// 另外守一条**容易静默失效**的：账本一次产出两份（byId / byName）。指数展示按 byId
// （两个同名各算各的），排表按 byName（pipeline 内部一律以姓名为标识）。任何一份算错
// 都不报错 —— byId 错会让同名的人共用一份成绩，byName 错会让排表越排越不均。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'duty-student-id' })
test.after(() => fx.close())

const { countDutyRefs, collectDutyRefs, removeDutyName, renameDutyName } = require('../../../student-backend/services/dutyCells')
const { validateRow } = require('../../../student-backend/services/businessRules')
const { sanitizeField } = require('../../../student-backend/services/sanitize')
const { clearDutySlots } = require('../../../student-backend/services/studentRelations')

const SRC = abs('student-frontend/src')
const loadIndex = () => import(pathToFileURL(path.join(SRC, 'utils/dutyIndex.js')).href)

const wrap = (list) => ({ daily: { 擦黑板: { 周一: list } }, big: {} })
const wrap2 = (list) => ({ daily: { 倒垃圾: { 周一: list } }, big: {} })

// ============ ① 三态匹配 ============

test('id 格与姓名格都算「这个人的引用」', () => {
  const cells = wrap([16, '张三', '', 46])
  // 传 id + 姓名：数字格按 id 命中、字符串格按姓名命中
  assert.equal(countDutyRefs(cells, '张三', 16), 2, '应命中 16 与「张三」两格')
  assert.equal(collectDutyRefs(cells, '张三', 16).length, 2)
  // id 不同、姓名不同 → 该 id 只命中自己那一格
  assert.equal(countDutyRefs(cells, '张三', 46), 2, '46 与「张三」都算 46 这个人的引用')
})

test('同名两人：只给 id 时精确到人，不误伤另一个', () => {
  // 两个都叫「张子涵」，一个按 id 存、一个按姓名存
  const cells = wrap([16, '张子涵'])
  assert.equal(countDutyRefs(cells, '张子涵', 16), 2, '16 号本人：id 格 + 同名字符串格都算')
  const removed = removeDutyName(cells, '张子涵', 16)
  assert.equal(removed, 2)
  assert.deepEqual(cells.daily.擦黑板.周一, [], '两格都清掉（删的是这个人，连他名下的字符串格一起）')

  // 只给 id、不给姓名 → 只清 id 格，字符串格留给另一个人
  const cells2 = wrap([16, '张子涵'])
  assert.equal(removeDutyName(cells2, '', 16), 1, '空姓名时不能把同名的字符串格一起清掉')
  assert.deepEqual(cells2.daily.擦黑板.周一, ['张子涵'])
})

test('老数据（只有字符串）行为完全不变', () => {
  const cells = wrap([' 张三 ', '李四'])
  assert.equal(countDutyRefs(cells, '张三'), 1, 'trim 后比较的既有口径要保留')
  assert.equal(removeDutyName(cells, '张三'), 1)
  assert.deepEqual(cells.daily.擦黑板.周一, ['李四'])
})

test('改名：只改字符串格，id 格原样不动（这就是存 id 的收益）', () => {
  const cells = wrap([16, '张三', '李四'])
  const changed = renameDutyName(cells, '张三', '张三丰')
  assert.equal(changed, 1, '只有字符串那一格需要改')
  assert.deepEqual(cells.daily.擦黑板.周一, [16, '张三丰', '李四'], 'id 格不该被改写')
})

// ============ ② 写入校验 ============

test('保存值日：id 与姓名混排能存，非法元素被拒', () => {
  fx.reset()
  // 元素级校验在 sanitize 里（validateRow 只管项目名/人数/列名这些业务规则）
  const ok = sanitizeField(wrap2([16, '张三']), 'duty_layout', 'cells')
  assert.deepEqual(ok.daily.倒垃圾.周一, [16, '张三'], 'id 与姓名混排必须原样存下来')
  // 空字符串是合法的「这格没人」，必须放过
  assert.doesNotThrow(() => sanitizeField(wrap2(['', 16]), 'duty_layout', 'cells'))

  for (const bad of [[{ name: '张三' }], [1.5], [0], [-1], [true]]) {
    assert.throws(
      () => sanitizeField(wrap(bad), 'duty_layout', 'cells'),
      /只能放姓名或学生 id/,
      `${JSON.stringify(bad)} 既不是 id 也不是姓名，必须拒绝`,
    )
  }
})

test('保存值日：数字 id 不会被当成姓名去建临时学生', () => {
  fx.reset()
  const before = fx.conn.prepare('SELECT COUNT(*) c FROM students').get().c
  validateRow('duty_layout', { cells: JSON.stringify(wrap2([16, 46])) })
  const after = fx.conn.prepare('SELECT COUNT(*) c FROM students').get().c
  assert.equal(after, before, '把 id 拿去 resolve 会建出一批名叫「16」的临时学生')
})

// ============ ③ 双账本：byId 分开同名、byName 给排表、unresolved 兜底 ============

test('byId：两个同名 id 各算各的，不合并成一个数', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const rows = [{ cells: { 擦黑板: { 周一: [16, 46] } } }]
  const weights = { 擦黑板: { 周一: 2 } }
  const r = accumulateDutyIndex(rows, weights, {
    resolveName: () => '张子涵',
    resolveId: (v) => v,
  })
  assert.deepEqual(r.byId, { 16: 2, 46: 2 }, '同名两人必须各算各的；合并就是他做的事记到我头上')
  assert.equal(r.byName['张子涵'], 4, '姓名账本仍要合并：排表按姓名查，这里少了就排不均')
  assert.deepEqual(r.unresolved, {})
})

test('byName：排表账本与旧行为逐字一致（不传 resolveName 时）', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const rows = [{ cells: { 扫地: { 周二: ['甲', '乙', ''] } } }, { cells: { 扫地: { 周二: ['甲', 0] } } }]
  const weights = { 扫地: { 周二: 1 } }
  const r = accumulateDutyIndex(rows, weights)
  assert.deepEqual(r.byName, { 甲: 2, 乙: 1 }, '0 / 空串不是人，不能记账')
  assert.deepEqual(r.byId, {}, '一个 id 都没解析出来')
  assert.deepEqual(r.unresolved, { 甲: 2, 乙: 1 }, '认不出 id 的人进 unresolved，展示时才列得出来')
})

test('历史字符串能唯一折算成 id 时进 byId，同名歧义进 unresolved', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const uniq = new Map([['唯一', 7]])
  const rows = [{ cells: { a: { 周一: ['唯一', '同名'] } } }]
  const weights = { a: { 周一: 1 } }
  const r = accumulateDutyIndex(rows, weights, {
    resolveName: (v) => String(v),
    resolveId: (v) => (typeof v === 'number' ? v : (uniq.get(v) ?? null)),
  })
  assert.deepEqual(r.byId, { 7: 1 }, '唯一命中的历史姓名要折算成 id')
  assert.deepEqual(r.unresolved, { 同名: 1 }, '同名的历史字符串认不出是谁，只能单独记')
  assert.equal(r.byName['同名'], 1, '排表账本仍然要算到他')
})

test('旧调用（第三参直接传函数）不会失联', async () => {
  const { accumulateDutyIndex } = await loadIndex()
  const r = accumulateDutyIndex([{ cells: { a: { 周一: [1] } } }], { a: { 周一: 1 } }, () => '甲')
  assert.equal(r.byName['甲'], 1)
})

// ============ ④ 删学生走 id ============

test('删学生：清掉 id 格，同名的另一个 id 保留', () => {
  fx.reset()
  fx.conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(16, '张子涵')
  fx.conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(46, '张子涵')
  fx.conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify(wrap2([16, 46, '张子涵'])))

  clearDutySlots({ id: 16, 姓名: '张子涵' })

  const saved = JSON.parse(fx.conn.prepare("SELECT cells FROM duty_slots WHERE kind='current'").get().cells)
  // 16 那一格清掉；46 保留；字符串「张子涵」分不清是谁，同样算 16 的引用被清掉
  assert.deepEqual(saved.daily.倒垃圾.周一, [46], '只剩 46 号——不能把另一个同名的人也抹掉')
})
