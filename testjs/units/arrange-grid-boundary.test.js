// =========================================================================
// arrange-grid-boundary.test.js —— 智能排表弹窗的「网格 ↔ dense」边界
// 运行：npm run test:units
//
// 背景：异形网格改造后，库里 seats 是**网格**（走廊是真实列），而排表算法按 dense
// 坐标工作（只保留座位列、连续下标）——`%2 == 0 为同桌` 这类判据才能在任意走廊
// 布局下继续成立。这条边界只有进出两个口子：
//   进：baseSeats = toDenseSeats(网格)
//   出：buildSeatsOut() = fromDenseSeats(dense)
//   看：buildPreviewRows() 按网格列渲染，走廊列回填成「走廊」单元格
//
// 判据（这三条任一错都不会报错，只会「座位静默错位」或「学生坐进走廊」）：
//   1. 落库结果是网格：走廊列恒 null，座位按座位列序号顺序填回
//   2. 预览是网格视角：列数 = 网格列数，走廊列是合并单元格，数据落在座位列上
//   3. 行走廊行在预览里只读且不跨行，不会把下方座位吃掉
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadOptions = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.options.js',
)).href)
const loadGeom = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/composables/useSeatGrid.geometry.js',
)).href)

// 单桌 3 个座位列 + 2 条走廊 = 网格 5 列
const SEAT = 0
const AISLE = 1
const COLS = 5
const FLAT_TYPES = [
  [SEAT, AISLE, SEAT, AISLE, SEAT],
  [SEAT, AISLE, SEAT, AISLE, SEAT],
]

function makeCtx(geom, { rows, cols, types, dense }) {
  return {
    rows: { value: rows },
    // 算法侧宽度 = 座位列数
    cols: { value: geom.seatColumnIndices(cols, types).length },
    gridCols: { value: cols },
    gridTypes: { value: geom.normalizeTypes(types, rows, cols) },
    gridToDense: { value: geom.gridToDenseCols(cols, types) },
    previewSeats: { value: dense },
  }
}

test('落库结果是网格：走廊列恒 null，座位按座位列序号填回', async () => {
  const geom = await loadGeom()
  const { useSmartArrangementOptions } = await loadOptions()
  const dense = [
    [{ id: 1, 姓名: '甲' }, { id: 2, 姓名: '乙' }, { id: 3, 姓名: '丙' }],
    [{ id: -1, 姓名: '新同学' }, null, null],
  ]
  const ctx = makeCtx(geom, { rows: 2, cols: COLS, types: FLAT_TYPES, dense })
  const out = useSmartArrangementOptions(ctx, {}).buildSeatsOut()

  assert.deepEqual(out[0], [1, null, 2, null, 3], '座位按座位列顺序落在 0/2/4 列，走廊列是 null')
  assert.deepEqual(out[1], ['新同学', null, null, null, null], '负 id 的新同学存姓名；空位与走廊都是 null')
})

test('预览是网格视角：列数 = 网格列数，走廊列合并成一条，数据落在座位列上', async () => {
  const geom = await loadGeom()
  const { useSmartArrangementOptions } = await loadOptions()
  const dense = [
    [{ id: 1, 姓名: '甲' }, { id: 2, 姓名: '乙' }, { id: 3, 姓名: '丙' }],
    [null, null, null],
  ]
  const ctx = makeCtx(geom, { rows: 2, cols: COLS, types: FLAT_TYPES, dense })
  const rowsOut = useSmartArrangementOptions(ctx, {}).buildPreviewRows(dense)

  assert.equal(rowsOut[0]._isPodium, true, '首行是讲台')
  assert.ok(rowsOut.every(r => r._isPodium || r._isReadonly), '预览整表只读（弹窗里改格子不会进结果）')
  assert.equal(rowsOut[1].cells.length, COLS, '预览列数必须等于网格列数（走廊是真实列）')
  assert.equal(rowsOut[1].cells[0].course, '甲')
  assert.equal(rowsOut[1].cells[0]._studentId, 1, '候选框靠 _studentId 区分同名正式/临时学生')
  assert.equal(rowsOut[1].cells[2].course, '乙')
  assert.equal(rowsOut[1].cells[4].course, '丙')
  // 走廊列：首行一条 rowspan 贯通，其余行占位隐藏
  assert.equal(rowsOut[1].cells[1]._isAisle, true)
  assert.equal(rowsOut[1].cells[1]._aisleRowSpan, 2, '竖走廊只有首行带 rowspan')
  assert.equal(rowsOut[1].cells[1].course, '走廊')
  assert.equal(rowsOut[2].cells[1]._isAisleHidden, true, '第二行的走廊格占位隐藏')
})

test('行走廊行：预览里只读、不跨行，不会吃掉下方座位', async () => {
  const geom = await loadGeom()
  const { useSmartArrangementOptions } = await loadOptions()
  // 第 2 行整行走廊（异形教室里的过道）
  const types = [
    [SEAT, AISLE, SEAT, AISLE, SEAT],
    [AISLE, AISLE, AISLE, AISLE, AISLE],
    [SEAT, AISLE, SEAT, AISLE, SEAT],
  ]
  const dense = [
    [{ id: 1, 姓名: '甲' }, { id: 2, 姓名: '乙' }, { id: 3, 姓名: '丙' }],
    [null, null, null],
    [{ id: 4, 姓名: '丁' }, null, null],
  ]
  const ctx = makeCtx(geom, { rows: 3, cols: COLS, types, dense })
  const rowsOut = useSmartArrangementOptions(ctx, {}).buildPreviewRows(dense)

  const aisleRow = rowsOut[2]
  assert.equal(aisleRow._isAisleRow, true, '整行走廊要标记出来')
  assert.equal(aisleRow._isReadonly, true, '行走廊行不可编辑/不可拖动（拖了会让走廊与数据错位）')
  assert.equal(aisleRow.cells[0]._aisleRowSpan, 0, '行走廊格不能带 rowspan')
  assert.equal(aisleRow.cells[0].course, '走廊', '整行走廊只在首格写「走廊」二字')
  assert.equal(aisleRow.cells[2].course, '', '其余格留空')
  // 下方座位不受影响
  assert.equal(rowsOut[3].cells[0].course, '丁')
  assert.equal(rowsOut[2].cells[0]._aisleRowSpan === 3, false, '行走廊不能贯通三行')
})

test('往返一致：网格 → dense → 网格 幂等（走廊里的数据不会被搬到座位列上）', async () => {
  const geom = await loadGeom()
  const grid = [[1, null, 2, null, 3], [4, null, 5, null, null]]
  const dense = geom.toDenseSeats(grid, COLS, FLAT_TYPES)
  assert.deepEqual(dense, [[1, 2, 3], [4, 5, null]], '压掉走廊列后座位列连续排列')
  assert.deepEqual(geom.fromDenseSeats(dense, 2, COLS, FLAT_TYPES), grid, '展开回网格要与原网格逐格相同')
})
