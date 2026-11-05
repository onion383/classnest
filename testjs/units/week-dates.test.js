// =========================================================================
// week-dates.test.js —— 「星期列 → 具体日期」换算的单元测试
// 运行：npm run test:units
// 说明：weekDates.js 是纯 ESM 模块，用 pathToFileURL + 动态 import() 加载。
//
// 覆盖的判据（每条都要能区分「改了」与「没改」）：
//   1. 日期标签格式：年.月.日，月日不补零
//   2. 基准是那一周的周一，周二~周五各偏移 1~4 天
//   3. 只取列表里出现的星期名（值日表的天数可配置，可能是「周三~周五」子集）
//   4. 跨月、跨年边界
//   5. 非法输入不产生 'NaN' 之类的脏标签
//   6. currentWeekDateMap 认的是「今天所在的那一周」
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadWeekDates = () => import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/utils/weekDates.js')).href)

// ===== 标签格式 =====
test('formatDateLabel 输出 年.月.日 且月日不补零', async () => {
  const { formatDateLabel } = await loadWeekDates()
  assert.equal(formatDateLabel('2026-03-01'), '2026.3.1')
  assert.equal(formatDateLabel('2026-12-25'), '2026.12.25')
  assert.equal(formatDateLabel('2026-01-09'), '2026.1.9')
})

test('formatDateLabel 对非法输入返回空串（不产生 NaN-NaN-NaN）', async () => {
  const { formatDateLabel } = await loadWeekDates()
  assert.equal(formatDateLabel(''), '')
  assert.equal(formatDateLabel(null), '')
  assert.equal(formatDateLabel(undefined), '')
  assert.equal(formatDateLabel('不是日期'), '')
  assert.equal(formatDateLabel('2026-13-45'), '')
})

test('formatDateLabel 拒绝「格式对但不存在的日期」（2 月 30 日）', async () => {
  const { formatDateLabel } = await loadWeekDates()
  // 只看正则的话 '2026-02-30' 能匹配上，但那天不存在
  assert.equal(formatDateLabel('2026-02-30'), '')
  assert.equal(formatDateLabel('2025-02-29'), '')  // 2025 不是闰年
  assert.equal(formatDateLabel('2024-02-29'), '2024.2.29')  // 闰年，这天存在
})

// ===== 整周映射 =====
test('buildWeekDateMap 从周一起算，周二到周五各偏移一天', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2026-03-02', ['周一', '周二', '周三', '周四', '周五'])
  assert.deepEqual(map, {
    '周一': '2026.3.2',
    '周二': '2026.3.3',
    '周三': '2026.3.4',
    '周四': '2026.3.5',
    '周五': '2026.3.6',
  })
})

test('buildWeekDateMap 支持到周日（值日表可配到周末）', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2026-03-02', ['周六', '周日'])
  assert.equal(map['周六'], '2026.3.7')
  assert.equal(map['周日'], '2026.3.8')
})

test('buildWeekDateMap 只给出列表里出现的星期名（子集）', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2026-03-02', ['周三', '周四', '周五'])
  assert.deepEqual(Object.keys(map), ['周三', '周四', '周五'])
  assert.equal(map['周三'], '2026.3.4')
  // 没在列表里的星期不出现在结果里（否则会给「不存在的列」编出日期）
  assert.equal(map['周一'], undefined)
})

test('buildWeekDateMap 跨月正确', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2026-01-26', ['周一', '周二', '周三', '周四', '周五'])
  assert.equal(map['周一'], '2026.1.26')
  assert.equal(map['周五'], '2026.1.30')
})

test('buildWeekDateMap 跨年正确（12月29日那一周）', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2025-12-29', ['周一', '周二', '周三', '周四', '周五'])
  assert.equal(map['周一'], '2025.12.29')
  assert.equal(map['周三'], '2025.12.31')
  assert.equal(map['周四'], '2026.1.1')
  assert.equal(map['周五'], '2026.1.2')
})

test('buildWeekDateMap 忽略非星期名（走廊等）', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  const map = buildWeekDateMap('2026-03-02', ['周一', '走廊', '周二'])
  assert.equal(map['走廊'], undefined)
  assert.equal(map['周一'], '2026.3.2')
})

test('buildWeekDateMap 基准非法时返回空对象（不编出假日期）', async () => {
  const { buildWeekDateMap } = await loadWeekDates()
  assert.deepEqual(buildWeekDateMap('', ['周一']), {})
  assert.deepEqual(buildWeekDateMap('乱码', ['周一']), {})
})

// ===== 当前周 =====
test('currentWeekDateMap 认的是「今天所在的那一周」的周一', async () => {
  const { currentWeekDateMap } = await loadWeekDates()
  const days = ['周一', '周二', '周三', '周四', '周五']
  // 2026-03-04 是周三 → 那一周的周一是 2026-03-02
  const wed = currentWeekDateMap(days, '2026-03-04')
  assert.equal(wed['周一'], '2026.3.2')
  assert.equal(wed['周三'], '2026.3.4')
  // 同周的周日仍属于同一周（周一不变）
  const sun = currentWeekDateMap(days, '2026-03-08')
  assert.equal(sun['周一'], '2026.3.2')
  // 下周一换周
  const nextMon = currentWeekDateMap(days, '2026-03-09')
  assert.equal(nextMon['周一'], '2026.3.9')
})

test('currentWeekDateMap 的 today 参数可注入（不依赖系统时钟）', async () => {
  const { currentWeekDateMap } = await loadWeekDates()
  // 周日归上一周（周一起点）：2026-03-08 是周日 → 周一是 2026-03-02
  const map = currentWeekDateMap(['周一'], '2026-03-08')
  assert.equal(map['周一'], '2026.3.2')
})

// ===== 星期名（判定「今天在哪一列」） =====
test('weekdayNameOf 把日期翻成星期名', async () => {
  const { weekdayNameOf } = await loadWeekDates()
  // 2026-03-02 是周一，往后依次到周日
  assert.equal(weekdayNameOf('2026-03-02'), '周一')
  assert.equal(weekdayNameOf('2026-03-03'), '周二')
  assert.equal(weekdayNameOf('2026-03-04'), '周三')
  assert.equal(weekdayNameOf('2026-03-05'), '周四')
  assert.equal(weekdayNameOf('2026-03-06'), '周五')
  assert.equal(weekdayNameOf('2026-03-07'), '周六')
  assert.equal(weekdayNameOf('2026-03-08'), '周日')
})

test('weekdayNameOf 拒绝非法日期（不编出星期名）', async () => {
  const { weekdayNameOf } = await loadWeekDates()
  assert.equal(weekdayNameOf(''), '')
  assert.equal(weekdayNameOf(null), '')
  assert.equal(weekdayNameOf('不是日期'), '')
  assert.equal(weekdayNameOf('2026-13-45'), '')
  assert.equal(weekdayNameOf('2026-02-30'), '')
})

test('weekdayNameOf 与 buildWeekDateMap 的星期口径一致（同一日期同一星期）', async () => {
  const { weekdayNameOf, buildWeekDateMap } = await loadWeekDates()
  // 用「那一周的周一」当基准：weekdayNameOf(周一 + n) 应等于该周的第 n 个星期名
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const monday = '2026-03-02'
  const map = buildWeekDateMap(monday, names)
  for (let i = 0; i < 7; i++) {
    const date = `2026-03-${String(2 + i).padStart(2, '0')}`
    assert.equal(weekdayNameOf(date), names[i])
    // buildWeekDateMap 给这个星期名的日期，必须正是这一天
    assert.equal(map[names[i]], `2026.3.${2 + i}`)
  }
})
