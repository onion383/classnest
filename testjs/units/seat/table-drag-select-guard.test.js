// =========================================================================
// table-drag-select-guard.test.js —— 动态表格的三处交互陷阱（v7 §5-6）
//
// ① 筛选态全选：原实现整体替换 selectedRowKeys，取消全选时把被过滤掉的已选行
//    一起清空（全选也会丢掉它们）；
// ② 新增行期间全局 Enter：任何按钮聚焦时都会先 emit saveNewRow，浏览器随后又原生
//    click 一次 → 按一下保存两遍（请假页并发建两条记录）；
// ③ 过滤后拖拽：表格抛的是可见列表下标，父级直接拿去 splice 完整数组 → 挪错行，
//    还会改动用户看不见的行。
// ③ 的落位算法抽成了纯函数 utils/rowReorder.js，这里跑真实源码。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { analyze, findFunction, scriptBlocks } = require('#testjs/source-scan')

const SRC = abs('student-frontend/src')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const loadReorder = () => import(pathToFileURL(path.join(SRC, 'utils/rowReorder.js')).href)

// 取具名函数/对象方法的函数体。
// 为什么不用 src.slice(indexOf('function toggleAllSelect()'), +900)：
// 固定 900 字符窗口在函数变长/前面加注释后就切不全（假红），而短函数又会把后面的
// 同名代码带进来（漏报）。AST 直接给出函数节点范围，与缩进、空格、代码长度无关。
function bodyOf(src, name) {
  const { ast } = analyze(src)
  const fn = findFunction(ast, name)
  assert.ok(fn, `找不到 ${name}`)
  return src.slice(fn.bodyStart, fn.bodyEnd)
}

// ———————————————— ① 全选只增删可见行 ————————————————

test('§5-6：筛选态全选不再整体替换已选集合（隐藏行的选择保住）', () => {
  const src = read('components/tables/DynamicTable/DynamicTable.vue')
  const body = bodyOf(scriptBlocks(src), 'toggleAllSelect')
  assert.doesNotMatch(body, /selectedRowKeys\.value\s*=\s*ctx\.isAllSelected\.value\s*\?\s*\[\s*\]\s*:/,
    '旧的「全选=替换 / 取消=清空」写法必须消失')
  assert.match(body, /filter\s*\(\s*k\s*=>\s*!drop\.has\(\s*k\s*\)\s*\)/, '取消全选要只摘掉可见行')
  assert.match(body, /next\.add\(\s*k\s*\)/, '全选要并上可见行而不是替换')
})

// ———————————————— ② 全局 Enter 不抢按钮 ————————————————

test('§5-6：全局 Enter 遇到任意按钮都让位给原生 click（不再按文案判断）', () => {
  const src = read('components/tables/DynamicTable/DynamicTable.vue')
  const body = bodyOf(scriptBlocks(src), 'handleGlobalEnter')
  assert.match(body, /t\s*&&\s*t\.tagName\s*===\s*'BUTTON'\s*\)\s*return/, '任何按钮聚焦时都要 return')
  assert.doesNotMatch(body, /tagName\s*===\s*'BUTTON'\s*&&\s*\/取消\//,
    '不应再靠按钮文案判断 —— 保存/筛选/删除按钮同样会双发（只看了注释不算通过）')
})

// ———————————————— ③ 拖拽落位按行对象定位 ————————————————

const row = (id, name, extra = {}) => ({ id, _rowKey: `id:${id}`, 姓名: name, ...extra })
const ids = (rows) => rows.map((r) => r.id)

test('§5-6：过滤态向下拖 —— 只挪被拖行，隐藏行位置不动', async () => {
  const { moveRowByAnchor } = await loadReorder()
  const A = row(1, 'A'), X = row(2, '隐藏行X'), B = row(3, 'B')
  const full = [A, X, B]
  const display = [A, B]  // 搜索把 X 过滤掉了
  // 用户把 B 拖到 A 前面：表格抛 1→0
  const out = moveRowByAnchor(full, display, 1, 0)
  assert.deepEqual(ids(out), [3, 1, 2], 'B 到最前，A 顺移，隐藏的 X 仍在原相对位置（第 3）')
  assert.deepEqual(ids(full), [1, 2, 3], '不得原地修改传入数组')
})

test('§5-6：过滤态向上拖 —— 落点在隐藏行之前也不会把隐藏行挪走', async () => {
  const { moveRowByAnchor } = await loadReorder()
  const A = row(1, 'A'), X = row(2, 'X'), B = row(3, 'B')
  const full = [A, X, B]
  const display = [A, B]
  // 把 A 拖到 B 的位置：表格抛 0→1
  const out = moveRowByAnchor(full, display, 0, 1)
  assert.deepEqual(ids(out), [2, 3, 1], 'A 落到 B 之后；X 前移到最前但没被「拖」')
})

test('§5-6：没有过滤时行为与旧的按下标 splice 完全一致', async () => {
  const { moveRowByAnchor } = await loadReorder()
  const full = [row(1, 'A'), row(2, 'B'), row(3, 'C'), row(4, 'D')]
  const display = full.slice()
  // 旧实现：取出 1 插到 3
  const oldWay = full.slice()
  const [m] = oldWay.splice(1, 1)
  oldWay.splice(3, 0, m)
  assert.deepEqual(ids(moveRowByAnchor(full, display, 1, 3)), ids(oldWay))
  assert.deepEqual(ids(moveRowByAnchor(full, display, 3, 0)), [4, 1, 2, 3])
})

test('§5-6：新增行 / 找不到的行不参与落位（返回 null，不写库）', async () => {
  const { moveRowByAnchor } = await loadReorder()
  const full = [row(1, 'A')]
  const newRow = { _rowKey: 'new', _isNew: true }
  assert.equal(moveRowByAnchor(full, [newRow, full[0]], 0, 1), null, '新增行还没有 id，拖它没有意义')
  assert.equal(moveRowByAnchor(full, [row(9, 'Z'), full[0]], 0, 1), null, '不在完整数组里的行直接放弃')
})

test('§5-6：多选整批移动按落点行定位（隐藏行不被当成落点）', async () => {
  const { moveRowsByAnchor } = await loadReorder()
  const A = row(1, 'A'), X = row(2, 'X'), B = row(3, 'B'), C = row(4, 'C')
  const full = [A, X, B, C]
  const display = [A, B, C]
  // 选中 A、B，拖到 C 之后（display 下标 2，向下）
  const out = moveRowsByAnchor(full, display, ['id:1', 'id:3'], 2, true)
  assert.deepEqual(ids(out), [2, 4, 1, 3], 'A、B 整批放到 C 之后；隐藏行 X 留在最前')
})

test('§5-6：多选向上拖到第一行之前', async () => {
  const { moveRowsByAnchor } = await loadReorder()
  const A = row(1, 'A'), X = row(2, 'X'), B = row(3, 'B'), C = row(4, 'C')
  const full = [A, X, B, C]
  const display = [A, B, C]
  const out = moveRowsByAnchor(full, display, ['id:4'], 0, false)
  assert.deepEqual(ids(out), [4, 1, 2, 3], 'C 到最前')
})

test('§5-6：多选落点行本身在被移动集合里时仍能算出位置（不返回 null）', async () => {
  const { moveRowsByAnchor } = await loadReorder()
  const A = row(1, 'A'), B = row(2, 'B'), C = row(3, 'C')
  const full = [A, B, C]
  const display = [A, B, C]
  // 选中 A、B，落点是 B（自己人）→ 落点在 otherRows 里找不到 → 放到末尾
  const out = moveRowsByAnchor(full, display, ['id:1', 'id:2'], 1, true)
  assert.deepEqual(ids(out), [3, 1, 2])
})

test('§5-6 接线：useTableCRUD 走 rowReorder 的纯函数（不再用可见下标直接 splice）', () => {
  const src = read('composables/useTableCRUD.js')
  assert.match(src, /from '\.\.\/utils\/rowReorder\.js'/, '必须复用统一落位算法')
  assert.match(src, /moveRowByAnchor\(rows\.value, displayRows\.value/, 'onSwapRows 要按行对象定位')
  assert.match(src, /moveRowsByAnchor\(rows\.value, displayRows\.value/, '多选移动同样')
  assert.doesNotMatch(src, /records\.splice\(fromIndex, 1\)/, '旧的「可见下标当完整下标」写法应已消失')
})

// ———————————————— ④ 拖拽中断必须能清掉上一次残留 ————————————————
// 窗口外松开 / 切窗口失焦时没有 mouseup，旧实现把 mousemove/mouseup 与虚影留在 window 上：
// 再拖就叠在旧位移上，组件卸载也拿不到这些监听（v7 §5-6 / #22a）。

function handleDownBody(src, name) {
  return bodyOf(src, name)
}

test('§5-6：GridView 的列拖动入口与行拖动同样有「先中止上一次」的兜底', () => {
  const src = read('components/tables/GridView/GridView.drag.js')
  assert.match(handleDownBody(src, 'onColHandleDown'), /_abortColDrag\s*\(\s*\)/,
    '列拖动入口必须兜底清理（原来只有行拖动有）')
  // 中止函数的「移除监听」与「复位状态」必须在同一个函数体里，不能再靠 900 字符窗口
  const abortCol = bodyOf(src, '_abortColDrag')
  assert.match(abortCol, /window\s*\.\s*removeEventListener\s*\(\s*'mousemove'/, '_abortColDrag 必须真的移除 window 监听')
  assert.match(abortCol, /colDragIdx\s*\.\s*value\s*=\s*null/, '中止后要复位拖动状态')
})

test('§5-6：DynamicTable 的行/列拖动入口都兜底，且中止函数不提交换位', () => {
  const src = read('components/tables/DynamicTable/DynamicTable.drag.js')
  assert.match(handleDownBody(src, 'onRowHandleDown'), /_abortRowDrag\s*\(\s*\)/, '行拖动入口要兜底')
  assert.match(handleDownBody(src, 'onColHandleDown'), /_abortColDrag\s*\(\s*\)/, '列拖动入口要兜底')
  // 中止函数体内不能 emit swapRows / swapColumns —— 那会把一次中断变成一次真实换位
  const abortRow = bodyOf(src, '_abortRowDrag')
  assert.doesNotMatch(abortRow, /swapRows/, '_abortRowDrag 只清理，不提交')
  const abortCol = bodyOf(src, '_abortColDrag')
  assert.doesNotMatch(abortCol, /swapColumns/, '_abortColDrag 只清理，不提交')
})
