// =========================================================================
// album-photo-pages.test.js —— 相册照片「日期分页」的纯逻辑（v6 性能专题 · 2-23）
//
// 这些函数决定「滚到哪里补哪一段」，写错的表现都很隐蔽：
//   · 日期步进差一天 → 同一页反复请求同一个日期，滚动永远加载不出来
//   · 锚点落在已加载的组上 → 每次滚都白拿一整页重复数据
//   · 合并时连已加载的组一起覆盖 → 正在显示的缩略图 objectURL 失效、画面闪白
//   · 组头张数在未加载时显示 0 → 用户以为那天没照片
// 所以每条规则各锁一个用例。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const { ref } = require(path.join(ROOT, 'student-frontend/node_modules/vue'))
const { usePhotoTimeline } = require('../../student-frontend/src/composables/usePhotoTimeline.js')

const {
  UNKNOWN_DATE, nextDayOf, pageBefore, groupCountOf,
  firstUnloadedIndex, mergePhotoGroups, buildGroupPlaceholders, syncGroupPlaceholders,
  selectionCount, buildVirtualAlbumBody,
} = require('../../student-frontend/src/composables/albumPhotoPages.js')

test('nextDayOf：跨月/跨年/闰年都要对', () => {
  assert.equal(nextDayOf('2026-11-12'), '2026-11-13')
  assert.equal(nextDayOf('2026-11-30'), '2026-12-01')
  assert.equal(nextDayOf('2026-12-31'), '2027-01-01')
  assert.equal(nextDayOf('2024-02-28'), '2024-02-29', '闰年 2 月有 29 日')
  assert.equal(nextDayOf('2024-02-29'), '2024-03-01')
  assert.equal(nextDayOf('2025-02-28'), '2025-03-01', '平年 2 月直接到 3 月')
})

test('nextDayOf：非法输入返回空串，不抛也不返回 NaN', () => {
  assert.equal(nextDayOf('not-a-date'), '')
  assert.equal(nextDayOf(''), '')
})

test('pageBefore：普通日期取下一天；未知时间组用大日期兜底', () => {
  assert.equal(pageBefore('2026-11-12'), '2026-11-13')
  assert.equal(pageBefore(UNKNOWN_DATE), '9999-12-31', '未知组没有日期，要用「比所有日期都大」的值把尾页取回来')
  assert.equal(pageBefore(''), '9999-12-31')
})

test('groupCountOf：照片没加载时也必须是真数，不能显示 0', () => {
  assert.equal(groupCountOf({ date: '2026-11-12', count: 42, photos: null }), 42, '未加载按索引张数')
  assert.equal(groupCountOf({ date: '2026-11-12', count: 42, photos: [{}, {}] }), 42, 'count 优先')
  assert.equal(groupCountOf({ date: '2026-11-12', photos: [{}, {}, {}] }), 3, '没有 count 时退回实际行数（选照片弹窗走这条）')
  assert.equal(groupCountOf({ date: '2026-11-12', photos: null }), 0)
  assert.equal(groupCountOf(null), 0)
})

test('firstUnloadedIndex：返回第一个缺口，跳过已加载的', () => {
  const g = [
    { date: 'd1', photos: [] },
    { date: 'd2', photos: [] },
    { date: 'd3', photos: null },
    { date: 'd4', photos: null },
  ]
  assert.equal(firstUnloadedIndex(g, 0), 2)
  assert.equal(firstUnloadedIndex(g, 2), 2)
  assert.equal(firstUnloadedIndex(g, 3), 3)
})

test('firstUnloadedIndex：全部加载完返回 -1；越界索引夹紧；空数组 -1', () => {
  assert.equal(firstUnloadedIndex([{ photos: [] }, { photos: [] }], 0), -1)
  assert.equal(firstUnloadedIndex([{ photos: [] }, { photos: null }], 999), 1, 'fromIndex 超出末尾要夹回最后一个')
  assert.equal(firstUnloadedIndex([{ photos: null }], -5), 0)
  assert.equal(firstUnloadedIndex([], 0), -1)
  assert.equal(firstUnloadedIndex(null, 0), -1)
})

test('mergePhotoGroups：只填未加载的组，已加载的连引用都不换', () => {
  const loaded = [{ id: 1 }]
  const groups = [
    { date: 'd1', count: 2, photos: loaded },
    { date: 'd2', count: 2, photos: null },
    { date: 'd3', count: 1, photos: null },
  ]
  const filled = mergePhotoGroups(groups, [
    { date: 'd1', photos: [{ id: 9 }] },   // 已加载 → 必须忽略
    { date: 'd2', photos: [{ id: 2 }, { id: 3 }] },
  ])
  assert.equal(filled, 1, '只填了 d2')
  assert.equal(groups[0].photos, loaded, '已加载的组必须保持原引用（否则缩略图会重新绑定、画面闪白）')
  assert.deepEqual(groups[1].photos.map((p) => p.id), [2, 3])
  assert.equal(groups[2].photos, null, '这一页没覆盖到的组仍是未加载')
})

test('mergePhotoGroups：不新增也不删除分组（分组只由日期索引决定）', () => {
  const groups = [{ date: 'd1', count: 1, photos: null }]
  mergePhotoGroups(groups, [
    { date: 'd1', photos: [{ id: 1 }] },
    { date: 'dX', photos: [{ id: 2 }] },  // 索引里没有的日期 → 不能凭空长出一组
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].photos.length, 1)
})

test('mergePhotoGroups：张数以实际行数为准，空页也算已加载', () => {
  const groups = [{ date: 'd1', count: 5, photos: null }]
  mergePhotoGroups(groups, [{ date: 'd1', photos: [{ id: 1 }] }])
  assert.equal(groups[0].count, 1, '索引与行数不等时按真数修正，高度才对')

  const g2 = [{ date: 'd1', count: 3, photos: null }]
  mergePhotoGroups(g2, [{ date: 'd1', photos: [] }])
  assert.deepEqual(g2[0].photos, [], '空数组也是「已加载」，否则会反复请求同一天')
})

test('mergePhotoGroups：空输入不改动已有数据', () => {
  const groups = [{ date: 'd1', count: 1, photos: null }]
  assert.equal(mergePhotoGroups(groups, []), 0)
  assert.equal(mergePhotoGroups(groups, null), 0)
  assert.equal(groups[0].photos, null)
})

test('buildGroupPlaceholders：空日期归「未知时间」，count 转数字，photos 以 null 占位', () => {
  const g = buildGroupPlaceholders([
    { date: '2026-11-12', count: 3 },
    { date: '', count: '7' },
  ])
  assert.deepEqual(g, [
    { date: '2026-11-12', count: 3, photos: null, dirty: false },
    { date: UNKNOWN_DATE, count: 7, photos: null, dirty: false },
  ])
  assert.deepEqual(buildGroupPlaceholders(null), [])
})

/* ===== 对账：扫描期间每 800ms 刷新一次也不能让格子重挂 =====
 * 这是「后台扫描时前端一闪一闪」的直接判据：整表重建会让所有 <img> 卸载重挂。 */
test('syncGroupPlaceholders：日期和张数都没变时，复用同一个对象（连 photos 数组都不换）', () => {
  const photos = [{ id: 1 }, { id: 2 }]
  const old = [{ date: 'd1', count: 2, photos }, { date: 'd2', count: 1, photos: null }]
  const next = syncGroupPlaceholders(old, [{ date: 'd1', count: 2 }, { date: 'd2', count: 1 }])
  assert.equal(next[0], old[0], '必须是同一个对象，否则整组 DOM 会重建')
  assert.equal(next[0].photos, photos, 'photos 数组也不能换')
  assert.equal(next[1], old[1])
  assert.equal(next[0].dirty, undefined, '张数没变不该标 dirty')
})

test('syncGroupPlaceholders：张数变了 → 保留旧照片但标 dirty（等重取，不立刻清空）', () => {
  const photos = [{ id: 1 }]
  const old = [{ date: 'd1', count: 1, photos }]
  const next = syncGroupPlaceholders(old, [{ date: 'd1', count: 3 }])
  assert.equal(next[0], old[0])
  assert.equal(next[0].count, 3, '高度要按新张数立刻修正')
  assert.equal(next[0].photos, photos, '旧照片先留着 —— 置 null 会让这一组瞬间变空（又闪一下）')
  assert.equal(next[0].dirty, true, '标 dirty 才会被重新拉取')
})

test('syncGroupPlaceholders：还没加载过的组张数变了，不必标 dirty（它本来就要加载）', () => {
  const old = [{ date: 'd1', count: 1, photos: null, dirty: false }]
  const next = syncGroupPlaceholders(old, [{ date: 'd1', count: 9 }])
  assert.equal(next[0].count, 9)
  assert.equal(next[0].dirty, false)
})

test('syncGroupPlaceholders：新日期建占位、消失的日期整组移除', () => {
  const old = [{ date: 'd1', count: 1, photos: [{ id: 1 }] }]
  const next = syncGroupPlaceholders(old, [{ date: 'd0', count: 2 }, { date: 'd1', count: 1 }])
  assert.deepEqual(next.map((g) => g.date), ['d0', 'd1'], '顺序完全由日期索引决定')
  assert.equal(next[0].photos, null)
  assert.equal(next[1], old[0])
  // 日期被删光（照片真被删了）
  assert.deepEqual(syncGroupPlaceholders(old, []), [])
})

test('dirty 组会被 firstUnloadedIndex 选中，并在合并后清掉 dirty', () => {
  const photos = [{ id: 1 }]
  const groups = [{ date: 'd1', count: 2, photos, dirty: true }]
  assert.equal(firstUnloadedIndex(groups, 0), 0, '有照片但张数变了，仍要重取')
  const filled = mergePhotoGroups(groups, [{ date: 'd1', photos: [{ id: 1 }, { id: 2 }] }])
  assert.equal(filled, 1)
  assert.equal(groups[0].dirty, false, '重取完必须清 dirty，否则每轮都会再请求一次')
  assert.equal(groups[0].count, 2)
  assert.equal(firstUnloadedIndex(groups, 0), -1)
})

/* ===== 布局高度：分页不能改变总高度 =====
 * 这是「滚动条不会随加载一下一下变长」的直接判据。
 * 总高度由 usePhotoTimeline 的 layout 算出，它按 count 预留（不是 photos.length）——
 * 一旦有人把 groupHeight 改回按 photos.length 算，未加载的组高度就变成 40px，
 * 加载一页总高度涨一大截，用户滚到一半滚动条自己跳。 */
test('布局高度：未加载的组按 count 预留，加载照片后总高度一个像素都不变', () => {
  const groups = ref([
    { date: 'd1', count: 100, photos: null },
    { date: 'd2', count: 3, photos: null },
  ])
  const t = usePhotoTimeline(groups)
  const before = t.totalH.value
  // 默认 6 列 / 格宽 150 / 标题 40 / 组间距 12（usePhotoTimeline 的 options 默认值）
  assert.equal(t.layout.value.items[0].h, 40 + Math.ceil(100 / 6) * 150 + (Math.ceil(100 / 6) - 1) * 12,
    '100 张要按 17 行预留，不能按「还没加载」算成 0 行')
  assert.ok(before > 1000)

  groups.value[0].photos = Array.from({ length: 100 }, (_, i) => ({ id: i }))
  groups.value[1].photos = [{ id: 1 }, { id: 2 }, { id: 3 }]
  assert.equal(t.totalH.value, before, '照片到货后总高度必须完全不变')
})

/* ===== 接线：哪条路径对账、哪条路径重建 =====
 * 纯函数测对了不代表调用点接对了 —— 上一版就是把「刷新」也接成整表重建，
 * 结果扫描期间每 800ms 全部格子卸载重挂，用户看到整片闪。 */
test('接线：同一相册刷新走对账，换相册才重建', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/AlbumView.vue'), 'utf8')
  assert.match(src, /sameAlbum \? syncGroupPlaceholders\(groups\.value, rows\) : buildGroupPlaceholders\(rows\)/,
    '刷新必须对账（复用分组对象），否则扫描期间整片闪；换相册必须重建，否则会显示上一本的照片')
  assert.match(src, /groupsAlbumId === albumId/, '对账前必须判断是不是同一本相册')
})

/* ===== 选照片弹窗的「选择描述」（方案 C）=====
 * 全选 = 一个标记，不是一万个 id。这里锁住「已选张数」和「提交体」两个口径，
 * 因为写错了不会报错 —— 会静默建成一个空相册或少拷一半。 */
test('selectionCount：显式勾选 / 整册 / 整册带排除', () => {
  assert.equal(selectionCount(null, 100), 0)
  assert.equal(selectionCount({ allOfAlbum: false, ids: [1, 2, 3] }, 100), 3)
  assert.equal(selectionCount({ allOfAlbum: false, ids: new Set([1, 2, 3]) }, 100), 3, '弹窗内部用 Set')
  assert.equal(selectionCount({ allOfAlbum: true, exclude: [] }, 100), 100)
  assert.equal(selectionCount({ allOfAlbum: true, exclude: [7, 8] }, 100), 98)
  assert.equal(selectionCount({ allOfAlbum: true, exclude: [7, 8] }, 1), 0, '不许出现负数')
})

test('buildVirtualAlbumBody：整册只传源相册 + 排除项', () => {
  assert.deepEqual(buildVirtualAlbumBody('整册副本', {
    albumId: 3, allOfAlbum: true, ids: [], exclude: [11, 12],
  }), { kind: 'virtual', name: '整册副本', all_from: 3, exclude: [11, 12] })
  assert.ok(!('photos' in buildVirtualAlbumBody('整册副本', { albumId: 3, allOfAlbum: true, exclude: [] })),
    '整册模式不能把 id 列表也带上')
})

test('buildVirtualAlbumBody：逐张选仍传 photos（老路径不坏）', () => {
  assert.deepEqual(buildVirtualAlbumBody('精选', { allOfAlbum: false, ids: [4, 5] }),
    { kind: 'virtual', name: '精选', photos: [{ photo_id: 4 }, { photo_id: 5 }] })
  assert.equal(buildVirtualAlbumBody('空', { allOfAlbum: false, ids: [] }), null, '一张没选不许提交')
  assert.equal(buildVirtualAlbumBody('空', null), null)
})

/* ===== 接线：整册语义必须贯通「弹窗 → 父组件 → 后端」 ===== */
test('接线：弹窗交回选择描述、父组件用纯函数构造提交体、恢复勾选不过滤已加载', () => {
  const fs = require('node:fs')
  const picker = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/dialogs/AlbumPhotoPickerDialog.vue'), 'utf8')
  const dialog = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/dialogs/NewAlbumDialog.vue'), 'utf8')

  assert.match(picker, /emit\('confirm', \{[\s\S]*?allOfAlbum: allOfAlbum\.value[\s\S]*?total: totalCount\.value/,
    '全选必须交回「描述」，不是照片对象数组')
  assert.match(dialog, /:initial="picked"/, '父组件要把上次的选择原样回传给弹窗')
  // 这一条最关键：分页后不能用「照片已加载」过滤掉用户的勾选
  assert.ok(!/photoMap\.has\(id\)/.test(picker), '恢复勾选不许按 photoMap（没加载的照片会被静默丢掉）')
  assert.match(dialog, /buildVirtualAlbumBody\(name\.value\.trim\(\), sel\)/, '提交体必须走单源纯函数')
})
