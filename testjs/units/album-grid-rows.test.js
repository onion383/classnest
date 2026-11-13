// =========================================================================
// album-grid-rows.test.js —— 相册「组内按行虚拟滚动」
//
// 用户现象：「一天的照片特别多就特别卡，一天不多就不卡」「已经上了虚拟滚动啊」。
// 原因：原虚拟滚动只裁剪到**日期分组**，组内 v-for 全量渲染，一天几千张就有几千个格子。
// 本文件钉住两件事：
//   A. 行裁剪的算术是对的（位置、切片、高度预留、边界）
//   B. 模板真的用了裁剪结果（「纯函数写对了」≠「有人在用它」）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const FRONT = path.join(ROOT, 'student-frontend')
const MODULE = path.join(FRONT, 'src/utils/albumGridRows.js')
const VIEW = path.join(FRONT, 'src/views/AlbumView.vue')
const TIMELINE = path.join(FRONT, 'src/composables/usePhotoTimeline.js')
const read = (p) => fs.readFileSync(p, 'utf8')

let visibleGridRows = null
test.before(async () => {
  ;({ visibleGridRows } = await import(pathToFileURL(MODULE).href))
})

const BASE = {
  offset: 0, count: 5000, scrollTop: 0, clientH: 600,
  cols: 6, cell: 200, gap: 12, header: 40, buffer: 900, extraRows: 1,
}
const photosOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
const cellCount = (r) => r.rows.reduce((a, x) => a + x.photos.length, 0)

test('一天 5000 张：DOM 里只留一屏附近的几十个格子，不是 5000 个', () => {
  const r = visibleGridRows({ ...BASE, photos: photosOf(5000) })
  const n = cellCount(r)
  assert.ok(n > 0, '一个格子都没渲染')
  assert.ok(n < 5000 / 10, `渲染了 ${n} 张，等于没做组内虚拟滚动`)
  assert.ok(r.rows.length <= 15, `渲染了 ${r.rows.length} 行，缓冲带没生效`)
  assert.equal(r.allRows, Math.ceil(5000 / 6))
  // 高度必须按全部 5000 张预留，否则滚动条会自己跳
  assert.equal(r.contentH, r.allRows * 200 + (r.allRows - 1) * 12)
})

test('第 0 行是前 6 张、top=0；行 top 严格按 rowH 递增', () => {
  const r = visibleGridRows({ ...BASE, photos: photosOf(5000) })
  assert.deepEqual(r.rows[0].photos.map(p => p.id), [1, 2, 3, 4, 5, 6])
  assert.equal(r.rows[0].top, 0)
  for (let i = 1; i < r.rows.length; i++) {
    assert.equal(r.rows[i].top - r.rows[i - 1].top, 212)
  }
})

test('滚到组中部时渲染的是中部那些行，不是从头开始', () => {
  const rowH = 212
  const scrollTop = 100 * rowH // 第 100 行附近
  const r = visibleGridRows({ ...BASE, photos: photosOf(5000), scrollTop })
  assert.ok(r.rows[0].n > 90, `第一行仍是 ${r.rows[0].n}，滚到底部却没有跟着滚`)
  assert.ok(r.rows[r.rows.length - 1].n < 115, '缓冲带过大，等于没裁剪')
  assert.equal(r.rows[0].photos[0].id, r.rows[0].n * 6 + 1)
  assert.ok(r.rows.every(row => row.n >= 90 && row.n < 115))
})

test('组整体在视口下方：只保留边界的一行，不把整组铺开', () => {
  const r = visibleGridRows({ ...BASE, photos: photosOf(3000), offset: 200000 })
  assert.ok(r.rows.length <= 2, `渲染了 ${r.rows.length} 行`)
  assert.ok(cellCount(r) < 20)
})

test('还没加载（photos=null）：高度照样预留，不渲染任何格子', () => {
  const r = visibleGridRows({ ...BASE, photos: null })
  assert.equal(r.loaded, false)
  assert.deepEqual(r.rows, [])
  assert.equal(r.contentH, Math.ceil(5000 / 6) * 200 + (Math.ceil(5000 / 6) - 1) * 12)
})

test('count 比实际加载的多（扫描时刚删过）：空行跳过，高度仍按 count', () => {
  const r = visibleGridRows({ ...BASE, photos: photosOf(12) })
  assert.equal(r.allRows, Math.ceil(5000 / 6))
  assert.equal(cellCount(r), 12, '只有两行有照片，不该渲染 834 个空格子')
  assert.equal(r.rows.length, 2)
})

test('count 与 photos.length 不一致时，以 count 为准（和 groupHeight 同源）', () => {
  // 扫描期间日期索引落后于实际照片数：layout 按 count=6 只给这一组留一行，
  // 行裁剪若按 12 张算两行，内容就会溢出到下一组的 top 上。
  const r = visibleGridRows({ ...BASE, count: 6, photos: photosOf(12), buffer: 2000 })
  assert.equal(r.allRows, 1)
  assert.equal(r.contentH, 200)
  assert.equal(cellCount(r), 6)
})

test('最后一行不满时只切到实际张数', () => {
  const r = visibleGridRows({ ...BASE, count: 8, photos: photosOf(8), buffer: 2000 })
  assert.equal(r.allRows, 2)
  assert.deepEqual(r.rows[1].photos.map(p => p.id), [7, 8])
  assert.equal(cellCount(r), 8)
})

test('模板真的按行渲染，没有退回整组 v-for', () => {
  const code = read(VIEW)
  assert.match(code, /v-for="v in renderedGroups"/, '外层必须用 renderedGroups')
  assert.match(code, /v-for="row in v\.rows"/, '必须按行渲染')
  assert.match(code, /v-for="p in row\.photos"/, '格子只能来自当前行')
  assert.ok(!/v-for="p in \(v\.g\.photos \|\| \[\]\)"/.test(code),
    '退回了整组 v-for —— 一天几千张又会全部挂进 DOM')
  assert.match(code, /:style="\{ top: row\.top \+ 'px' \}"/, '行必须绝对定位到算出来的位置')
  assert.match(code, /:style="\{ height: v\.contentH \+ 'px' \}"/, '内容区高度必须按总行数撑住滚动条')
  assert.match(code, /shrink-0/, '显式分行后格子不能被 flex 压缩')
})

test('几何常量与列数来自 usePhotoTimeline，不许两处各写一份', () => {
  const code = read(VIEW)
  assert.match(code, /cols, cell, gridGeom,/, '必须从时间线拿到 cols/cell/几何常量')
  assert.match(code, /scrollTop: st, clientH: h, cols: c, cell: sz, \.\.\.gridGeom/,
    '行裁剪必须用同一套参数，两处各写 12/40/900 迟早对不上滚动条')
  const tl = read(TIMELINE)
  assert.match(tl, /gridGeom: \{ gap: GAP, header: HEADER, buffer: BUFFER \}/,
    '时间线必须导出几何常量')
  // 高度公式必须与 groupHeight 同源：HEADER + rows*cell + (rows-1)*GAP
  assert.match(tl, /return HEADER \+ \(rows \? rows \* cell\.value \+ \(rows - 1\) \* GAP : 0\)/,
    'groupHeight 的公式变了，albumGridRows.contentH 也要跟着改')
})
