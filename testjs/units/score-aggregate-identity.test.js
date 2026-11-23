// =========================================================================
// score-aggregate-identity.test.js —— 成绩统计按身份聚合，不按姓名（v7 §5-4 / #20）
//
// 事故面：个人加分统计与「今日加分人数」原先用姓名当 key。名册里两个「张子涵」
// 各自加的分会被合成一条，人数也只算一个 —— 数字看着正常，其实把两个人算成了一个人。
// 记录本身带 student_id（后端写入时回填），所以聚合按 id 走，姓名只用于显示；
// 只有历史记录没有 id 时才退回姓名。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC = path.join(__dirname, '../../student-frontend/src')
const load = () => import(pathToFileURL(path.join(SRC, 'utils/scoreAggregate.js')).href)

const rec = (o) => ({ 类型: '加分', 分值: 1, 姓名: '', 学号: '', student_id: null, ...o })

test('§5-4：同名两个学生按 id 各自成行，分值不合并', async () => {
  const { aggregatePersonal } = await load()
  const rows = aggregatePersonal([
    rec({ 姓名: '张子涵', 学号: '2026001', student_id: 11, 分值: 2 }),
    rec({ 姓名: '张子涵', 学号: '2026002', student_id: 12, 分值: 5 }),
    rec({ 姓名: '张子涵', 学号: '2026001', student_id: 11, 分值: 3 }),  // 1 号再加 3
  ], 'add')

  assert.equal(rows.length, 2, '两个同名学生必须各占一行（旧实现会合并成一行 10 分）')
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(byKey['id:11'].value, 5, '1 号：2 + 3')
  assert.equal(byKey['id:12'].value, 5, '2 号：5')
  // 显示层要能区分：同名时补学号，否则两行一模一样
  assert.equal(byKey['id:11'].name, '张子涵（2026001）')
  assert.equal(byKey['id:12'].name, '张子涵（2026002）')
})

test('§5-4：今日人数按身份去重 —— 同名两人算两个', async () => {
  const { countDistinctPeople } = await load()
  const same = countDistinctPeople([
    rec({ 姓名: '张子涵', student_id: 11 }),
    rec({ 姓名: '张子涵', student_id: 12 }),
    rec({ 姓名: '张子涵', student_id: 11 }),  // 同一人的第二条
  ])
  assert.equal(same, 2, '两个 id → 2 人；旧实现按姓名去重只会得到 1')
})

test('§5-4：没有 student_id 的历史记录退回按姓名聚合（不丢数据）', async () => {
  const { aggregatePersonal, countDistinctPeople } = await load()
  const legacy = [
    rec({ 姓名: '李四', student_id: null, 分值: 1 }),
    rec({ 姓名: '李四', student_id: null, 分值: 2 }),
  ]
  const rows = aggregatePersonal(legacy, 'add')
  assert.equal(rows.length, 1, '没有 id 时同样的姓名只能当同一个人')
  assert.equal(rows[0].value, 3)
  assert.equal(rows[0].key, 'name:李四', 'key 要落到 name: 形态，与值日排表同一套值域')
  assert.equal(countDistinctPeople(legacy), 1)
})

test('§5-4：同一个人有 id 行与无 id 行时不会被当成两个人（有 id 的优先成行，无 id 行独立）', async () => {
  const { aggregatePersonal } = await load()
  const rows = aggregatePersonal([
    rec({ 姓名: '王五', student_id: 7, 分值: 4 }),
    rec({ 姓名: '王五', student_id: null, 分值: 1 }),  // 历史行，无法确定是不是同一个人
  ], 'add')
  // 两条 key 不同（id:7 与 name:王五），保守地分开统计比错误合并好；
  // 这里钉住的是「不会因为姓名相同就把历史行并进已绑定行」。
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.key).sort(), ['id:7', 'name:王五'])
})

test('§5-4：扣分 / 净分口径与旧实现一致', async () => {
  const { aggregatePersonal } = await load()
  const data = [
    rec({ 姓名: '甲', student_id: 1, 类型: '加分', 分值: 6 }),
    rec({ 姓名: '甲', student_id: 1, 类型: '扣分', 分值: 2 }),
  ]
  assert.equal(aggregatePersonal(data, 'add')[0].value, 6)
  assert.equal(aggregatePersonal(data, 'sub')[0].value, 2)
  assert.equal(aggregatePersonal(data, 'net')[0].value, 4)
})

test('§5-4：分值为 0 的行不出现（与旧实现的 filter 一致），_max 供条形图用', async () => {
  const { aggregatePersonal } = await load()
  const rows = aggregatePersonal([
    rec({ 姓名: '甲', student_id: 1, 分值: 0 }),
    rec({ 姓名: '乙', student_id: 2, 分值: -3 }),  // 净分 -3
  ], 'net')
  assert.equal(rows.length, 1, '0 分的人不该出现在统计条里')
  assert.equal(rows[0].value, -3)
  assert.equal(rows[0]._max, 3, '_max 取绝对值最大，负数条形也要有长度')
})

test('§5-4 接线：ScoreManagement 的统计与人数都走 scoreAggregate（不回到按姓名聚合）', () => {
  const src = fs.readFileSync(path.join(SRC, 'views/ScoreManagement.vue'), 'utf8')
  assert.match(src, /from '\.\.\/utils\/scoreAggregate\.js'/, '必须复用统一聚合（否则两套口径并存）')
  assert.match(src, /aggregatePersonal\(scores\.value/, '个人统计行要走 aggregatePersonal')
  assert.match(src, /countDistinctPeople\(todayAddRecords\.value\)/, '今日加分人数要按身份去重')
  assert.match(src, /countDistinctPeople\(todaySubRecords\.value\)/, '今日扣分人数要按身份去重')
  assert.doesNotMatch(src, /byId\[name\]/, '旧的「按姓名 into map」写法应已消失')
})
