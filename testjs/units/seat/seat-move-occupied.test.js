// =========================================================================
// seat-move-occupied.test.js —— 候选选中已入座学生：原位清空 + 新位落人
//
// 座位表编辑格时，已入座的学生不再从候选里剔除，而是标注「已排座：第X行 第Y座」。
// 选中后同一个人会短暂占两格，relocateDuplicateSeats 以本次变化的格为新位置，
// 清掉原格；姓名串（历史手输）不参与，免得两个同名字符串被误清。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const GEO = abs('student-frontend/src/composables/useSeatGrid.geometry.js')
const GRID = abs('student-frontend/src/components/tables/GridView/GridView.vue')
const SEAT = abs('student-frontend/src/composables/useSeatGrid.js')
const geo = () => import(pathToFileURL(GEO).href)

test('移动：同一 id 占两格时，清掉旧格、保留新格', async () => {
  const seats = [[7, null, 3], [null, 7, null]]
  // changed = 新格 (1,1) 刚被填成 7；旧格 (0,0) 没变
  const { seats: out, moved } = (await geo()).relocateDuplicateSeats(seats, [[1, 1]], [])
  assert.equal(out[1][1], 7, '新格保留')
  assert.equal(out[0][0], null, '旧格必须清空')
  assert.equal(out[0][2], 3, '其他学生不动')
  assert.equal(moved.length, 1, '记录一次移动')
  assert.deepEqual([moved[0].fromRow, moved[0].fromCol], [0, 0])
})

test('姓名串不参与移动（两个同名字符串不能互相清）', async () => {
  const { seats: out, moved } = (await geo()).relocateDuplicateSeats([['张三', '张三']], [[0, 1]], [])
  assert.equal(out[0][0], '张三')
  assert.equal(out[0][1], '张三')
  assert.equal(moved.length, 0)
})

test('原地编辑（只有一个格有这个 id）不产生移动', async () => {
  const { seats: out, moved } = (await geo()).relocateDuplicateSeats([[7, null]], [[0, 0]], [])
  assert.equal(out[0][0], 7)
  assert.equal(moved.length, 0)
})

test('位置标签：只标数字 id，按座位列序号编号（走廊不算座号）', async () => {
  const seats = [[7, null, null, 9]]
  const cols = 4
  const types = [[0, 1, 1, 0]] // 中间两列是走廊
  const rows = [{ name: '第1行' }]
  const out = (await geo()).occupiedSeatLabels(seats, cols, types, rows, [7, 9])
  assert.equal(out[7], '第1行 第1座')
  assert.equal(out[9], '第1行 第2座', '走廊列不占座号')
})

test('无匹配项时给「新增临时学生」入口，且只对学生候选', () => {
  const src = fs.readFileSync(GRID, 'utf8')
  assert.match(src, /新增临时学生/, '无匹配时要有新增入口')
  const body = src.slice(src.indexOf('const canCreateProvisional'), src.indexOf('const methods'))
  assert.match(body, /!props\.candidateIdField\) return false/, '课表等没有 id 字段的候选不显示')
  assert.match(body, /filteredCandidates\.value\.length === 0/, '只在无匹配时显示')
  const create = src.slice(src.indexOf('createProvisional()'), src.indexOf('saveEditCell()', src.indexOf('createProvisional()')) + 40)
  assert.match(create, /saveEditCell\(\)/, '点它直接保存当前姓名，由后端建临时学生')
})

test('接线：座位表传位置标注，GridView 显示且不剔除', () => {
  const seatSrc = fs.readFileSync(SEAT, 'utf8')
  assert.match(seatSrc, /currentEditOccupied/, '座位 composable 要有占用标注状态')
  assert.match(seatSrc, /occupiedSeatLabels\(/, '要算位置标签')
  assert.match(seatSrc, /relocateDuplicateSeats\(/, 'onCellsUpdate 要调移动纯函数')
  // 关键：候选剔除集合必须清空，否则已入座的人根本不出现在候选里
  assert.match(seatSrc, /currentEditExcludeIds\.value\s*=\s*\[\]/, '座位表不能再剔除已入座学生')

  const viewSrc = fs.readFileSync(abs('student-frontend/src/views/SeatView.vue'), 'utf8')
  assert.equal((viewSrc.match(/:candidateOccupied=/g) || []).length, 2, '活动表 + 模板表都要传标注')

  const gridSrc = fs.readFileSync(GRID, 'utf8')
  assert.match(gridSrc, /candidateOccupied: \{ type: Object/, 'GridView 要接标注 prop')
  assert.match(gridSrc, /已排座 \{\{ getCandidateSeat\(item\) \}\}/, '候选里要显示已排座标签')
})
