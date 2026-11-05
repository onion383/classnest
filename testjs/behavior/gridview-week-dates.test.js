// =========================================================================
// gridview-week-dates.test.js —— 「星期列表头带日期副行」的接线约定
//
// 运行：npm run test:behavior
//
// 背景：
//   GridView 的列头多了一行日期副行（周一 下面 2026.3.1）。
//   它由父组件通过 `col-dates` 传入，GridView 自己不认星期名 ——
//   传了就显示，不传就不显示（座位表的「列1/走廊」没有日期概念）。
//
//   这条测试锁的是**接线关系**，不是渲染细节：
//   · 课表：实行课表 / 一般课表 / 历史记录 三张表都要传
//   · 值日：当前值日 / 值日模板 / 值日记录 三张表都要传
//   · 值日项目权重表**不传**（它是「项目 × 权重」对照表，不是某一周的日程）
//
//   为什么不写成「页面上真有这段文字」：那要起浏览器，成本高且脆。
//   接线漏了 → 本测试挂 → 改回来，比等到有人肉眼发现日期没显示强。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '../../student-frontend/src')

function read(p) {
  return fs.readFileSync(path.join(SRC, p), 'utf8')
}

// GridView 的列头模板块（含日期副行的那段 th）
function gridViewHeaderBlock() {
  const s = read('components/tables/GridView/GridView.vue')
  const i = s.indexOf('v-for="(col, colIdx) in displayHeaders"')
  assert.ok(i > 0, 'GridView 里找不到列头 v-for 块')
  const j = s.indexOf('</tr>', i)
  assert.ok(j > i, 'GridView 列头块没有闭合')
  return s.slice(i, j)
}

test('GridView：列头渲染日期副行，且按表头文字（不是列下标）取日期', () => {
  const s = gridViewHeaderBlock()
  assert.ok(/class="grid-col-date"/.test(s), '列头里没有渲染日期副行')
  assert.ok(/colDateOf\(col\)/.test(s), '日期副行没有走 colDateOf(col)')
  // 按下标取日期 → 拖拽列之后文字与日期会张冠李戴。这里必须按文字取。
  assert.ok(!/colDates\s*\[\s*colIdx\s*\]/.test(s), '日期副行按列下标取值（拖拽后会错位）')
})

test('GridView：colDates 是可选 prop，不传就不显示日期', () => {
  const s = read('components/tables/GridView/GridView.vue')
  assert.ok(/colDates\s*:\s*\{\s*type:\s*Object\s*,\s*default:\s*\(\)\s*=>\s*\(\{\}\)/.test(s),
    'colDates prop 缺失或默认值不是空对象')
})

// 把一个文件里所有 <GridView ...> 块解析成 [{colHeaders, colDates}]。
// 只数「有几处 :col-dates」是不够的：把历史记录错绑成 dutyColDates 时数量不变、
// 测试照样通过 —— 必须比对**同一个 GridView 块内**两个绑定的配对关系。
//
// 绑定名两种写法都要认：课表页写 :colHeaders/:colDates（camelCase），
// 值日页写 :col-headers/:col-dates（kebab-case）。Vue 两种都接受，测试也得都认。
function gridViewBlocks(src) {
  const out = []
  const re = /<GridView\b/g
  let m
  while ((m = re.exec(src))) {
    // 从 <GridView 到该标签的 '>' 为止（属性里没有 '>'，够用）
    const end = src.indexOf('>', m.index)
    if (end < 0) continue
    const tag = src.slice(m.index, end)
    const pick = (name) => {
      const re2 = new RegExp(`:${name}\\s*=\\s*"([^"]+)"`)
      const hit = re2.exec(tag)
      return hit ? hit[1] : null
    }
    out.push({
      colHeaders: pick('colHeaders') || pick('col-headers'),
      colDates: pick('colDates') || pick('col-dates'),
      todayCol: pick('todayCol') || pick('today-col'),
    })
    re.lastIndex = end
  }
  return out
}

test('课表：实行课表 / 一般课表 / 历史记录 三张表都传了 colDates', () => {
  const s = read('views/ScheduleView/ScheduleView.vue')
  const blocks = gridViewBlocks(s)
  assert.equal(blocks.length, 3, `ScheduleView 期望 3 个 GridView，实际 ${blocks.length}`)
  const byHeaders = {}
  for (const b of blocks) byHeaders[b.colHeaders] = b.colDates
  assert.equal(byHeaders['activeColHeaders'], 'activeColDates', '实行课表没绑 activeColDates')
  assert.equal(byHeaders['masterColHeaders'], 'masterColDates', '一般课表没绑 masterColDates')
  assert.equal(byHeaders['historyColHeaders'], 'historyColDates', '历史记录没绑 historyColDates')
})

test('值日：当前值日 / 值日模板 / 值日记录 都传了 colDates，权重表不传', () => {
  const s = read('views/DutyView.vue')
  const blocks = gridViewBlocks(s)
  // 权重表用的是 :col-headers="weightColHeaders"，它**不该**有 colDates
  const weight = blocks.find(b => b.colHeaders === 'weightColHeaders')
  assert.ok(weight, '找不到值日项目权重表的 GridView（col-headers=weightColHeaders）')
  assert.equal(weight.colDates, null, '值日项目权重表不该显示日期副行')
  // 剩下三个：当前值日 / 值日模板 / 值日记录，都要绑
  const dated = blocks.filter(b => b.colDates)
  assert.equal(dated.length, 3, `期望 3 个 GridView 传了 colDates，实际 ${dated.length}`)
  for (const b of dated) {
    assert.ok(/^(dutyColDates|historyColDates)$/.test(b.colDates),
      `列头 ${b.colHeaders} 绑了意料之外的 colDates：${b.colDates}`)
  }
  const withHeaders = blocks.filter(b => b.colHeaders === 'settingsDays')
  assert.equal(withHeaders.length, 2, '当前值日 / 值日模板 两张表都该用 settingsDays 作列头')
  for (const b of withHeaders) {
    assert.equal(b.colDates, 'dutyColDates', '当前值日 / 值日模板 绑错了 colDates')
  }
  const hist = blocks.find(b => /historyDays/.test(b.colHeaders || ''))
  assert.ok(hist, '找不到值日记录的 GridView')
  assert.equal(hist.colDates, 'historyColDates', '值日记录绑错了 colDates')
})

test('日期副行的数据源统一走 weekDates.js（不在页面里各写一份换算）', () => {
  for (const f of ['views/ScheduleView/ScheduleView.vue', 'views/DutyView.vue']) {
    const s = read(f)
    assert.ok(/weekDates\.js/.test(s), `${f} 没有引用 utils/weekDates.js`)
    // 页面里不许出现裸的 Date 换算（那是「同一语义散在多处」的开始）
    assert.ok(!/new Date\(.*\)\.setDate/.test(s), `${f} 里有自己写的日期偏移换算`)
  }
})

// =========================================================================
// 「今天这一列」的高亮接线
// =========================================================================

test('GridView：todayCol 是可选 prop，不传就不高亮', () => {
  const s = read('components/tables/GridView/GridView.vue')
  assert.ok(/todayCol\s*:\s*\{\s*type\s*:\s*String\s*,\s*default\s*:\s*''\s*\}/.test(s),
    'todayCol prop 缺失或默认值不是空串')
  // 高亮必须同时作用于表头和该列的数据格，否则只是「今天那一列标题变色」。
  // 判据要查**模板里的绑定**，不能只查 CSS 里有这个类名 ——
  // 只查类名的话，把模板里的绑定删掉（只剩一段没人用的样式）照样通过。
  assert.ok(/grid-col-today/.test(s), '没有 grid-col-today 样式类')
  assert.ok(/grid-cell-today/.test(s), '没有 grid-cell-today 样式类（整列没高亮）')
  // 表头：th 的 class 绑定里要挂上 grid-col-today
  const thBlock = gridViewHeaderBlock()
  assert.ok(/grid-col-today/.test(thBlock), '表头 th 的 class 绑定里没有 grid-col-today')
  // 数据格：td 的 class 绑定里要挂上 grid-cell-today
  const tdBlock = s.slice(s.indexOf('data-data-cell'), s.indexOf('data-data-cell') + 1200)
  assert.ok(/grid-cell-today/.test(tdBlock), '数据格 td 的 class 绑定里没有 grid-cell-today')
  // 两处都必须按 todayColIdx 判定，而不是写死
  assert.ok(/todayColIdx/.test(thBlock), '表头高亮没有按 todayColIdx 判定')
  assert.ok(/todayColIdx/.test(tdBlock), '数据格高亮没有按 todayColIdx 判定')
})

test('GridView：「今天」按原始表头列下标定位（拖拽时表头文字会临时改写，按文字会跳）', () => {
  const s = read('components/tables/GridView/GridView.vue')
  assert.ok(/todayColIdx/.test(s), '没有 todayColIdx 计算属性')
  // 定位必须查 props.colHeaders（原始表头），不能查 displayHeaders（会被拖拽改写）
  const m = /const todayColIdx = computed\(\(\) => \{[\s\S]{0,400}?\}/.exec(s)
  assert.ok(m, 'todayColIdx 的定义没找到')
  assert.ok(/props\.colHeaders/.test(m[0]),
    'todayColIdx 没有查 props.colHeaders（应按原始表头定位，拖拽时才不会跳）')
  assert.ok(!/displayHeaders/.test(m[0]),
    'todayColIdx 查了 displayHeaders —— 拖拽时表头文字被临时改写，高亮会乱跳')
})

test('课表：实行课表 / 一般课表 传 today-col，历史记录不传（那是过去的周）', () => {
  const s = read('views/ScheduleView/ScheduleView.vue')
  const blocks = gridViewBlocks(s)
  const byHeaders = {}
  for (const b of blocks) byHeaders[b.colHeaders] = b
  assert.equal(byHeaders['activeColHeaders'].todayCol, 'todayName', '实行课表没传 today-col')
  assert.equal(byHeaders['masterColHeaders'].todayCol, 'todayName', '一般课表没传 today-col')
  assert.equal(byHeaders['historyColHeaders'].todayCol, null,
    '历史记录不该高亮「今天」—— 那一周是过去的周，今天不在里面')
  // todayName 必须来自 useWeekDates（跟着今天走，跨零点自动更新）
  assert.ok(/useWeekDates\(\)/.test(s), 'ScheduleView 没有用 useWeekDates')
  assert.ok(/\{ monday, todayName \} = useWeekDates\(\)/.test(s),
    'ScheduleView 没有从 useWeekDates 取 todayName')
})

test('值日：当前值日 / 值日模板 传 today-col，值日记录不传', () => {
  const s = read('views/DutyView.vue')
  const blocks = gridViewBlocks(s)
  const withHeaders = blocks.filter(b => b.colHeaders === 'settingsDays')
  assert.equal(withHeaders.length, 2, '当前值日 / 值日模板 两张表都该用 settingsDays 作列头')
  for (const b of withHeaders) {
    assert.equal(b.todayCol, 'todayName', '当前值日 / 值日模板 绑错了 today-col')
  }
  const hist = blocks.find(b => /historyDays/.test(b.colHeaders || ''))
  assert.ok(hist, '找不到值日记录的 GridView')
  assert.equal(hist.todayCol, null, '值日记录不该高亮「今天」')
  // 权重表本来就不该有日期和高亮
  const weight = blocks.find(b => b.colHeaders === 'weightColHeaders')
  assert.ok(weight, '找不到值日项目权重表的 GridView')
  assert.equal(weight.todayCol, null, '值日项目权重表不该高亮「今天」')
  assert.ok(/\{ monday, todayName \} = useWeekDates\(\)/.test(s),
    'DutyView 没有从 useWeekDates 取 todayName')
})
