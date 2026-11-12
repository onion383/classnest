// =========================================================================
// thumb-cache-policy.test.js —— 缩略图缓存的淘汰策略
//
// 背景（实测发现）：旧 evict 用 `map.size - MAX_KEEP` 决定淘汰数量，而 map.size
// 里混着大量 '' 标记（批量接口没拿到缩略图时写的占位）。攒够几千个之后，
// 每次滚动都会把几乎所有非可见 blob 一次撤光 —— 滚回去重新 createObjectURL、
// <img> 的 src 又变一次 → 闪。这正是该模块开头注释说务必避免的现象。
//
// 本用例锁五件事：
//   ① 标记再多也不许影响真 blob 的淘汰判据；
//   ② 真 blob 超标时只撤差额，按 LRU 最旧先撤；
//   ③ 可见区的 blob 与标记一律不动；
//   ④ 空闲收缩按 IDLE_KEEP，不按 MAX_KEEP；
//   ⑤ '' 标记自己也有上限，不会被无限攒着。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '../..')
const {
  MAX_KEEP, IDLE_KEEP, MISS_MAX, planEviction,
} = require('../../student-frontend/src/utils/thumbCachePolicy.js')

function blobMap(n, prefix = 'b') {
  const m = new Map()
  const last = new Map()
  for (let i = 0; i < n; i++) {
    m.set(`${prefix}${i}`, `blob:${prefix}${i}`)
    last.set(`${prefix}${i}`, i + 1)   // 序号越大越新
  }
  return { m, last }
}
function withMarkers({ m, last }, n) {
  for (let i = 0; i < n; i++) {
    m.set(`m${i}`, '')
    last.set(`m${i}`, 10000 + i)
  }
  return { m, last }
}
const run = (m, last, opts = {}) => planEviction({
  urls: m, keepIds: new Set(), liveCount: [...m.values()].filter(Boolean).length,
  lastUsed: last, ...opts,
})

test('常量口径：真 blob 上限 / 空闲目标 / 标记上限', () => {
  assert.equal(MAX_KEEP, 1500)
  assert.equal(IDLE_KEEP, 300)
  assert.equal(MISS_MAX, 3000)
  assert.ok(IDLE_KEEP < MAX_KEEP, '空闲必须比滚动中收得更紧')
})

test('核心：几千个 miss 标记混入，但真 blob 没超标 → 一个 blob 都不许撤', () => {
  const s = withMarkers(blobMap(1500), 10000)
  const plan = run(s.m, s.last)
  assert.equal(plan.dropBlobs.length, 0, '旧实现这里会撤掉 1497 个 blob，导致回滚全量重取并闪')
  assert.equal(plan.dropMarkers.length, 10000 - MISS_MAX, '标记自己仍要按上限收')
})

test('真 blob 超标：只撤差额，且按 LRU 从最旧的开始', () => {
  const s = withMarkers(blobMap(MAX_KEEP + 40), 0)
  const plan = run(s.m, s.last)
  assert.equal(plan.dropBlobs.length, 40)
  assert.deepEqual(plan.dropBlobs.map((d) => d.id), Array.from({ length: 40 }, (_, i) => `b${i}`),
    '撤的必须是序号最小的那 40 张')
  assert.equal(plan.dropMarkers.length, 0, '标记没超标就不碰')
})

test('可见区的 blob 与标记一律不动', () => {
  const s = withMarkers(blobMap(MAX_KEEP + 40), MISS_MAX + 20)
  const keep = new Set(['b0', 'b1', 'm0', 'm1'])
  const plan = planEviction({
    urls: s.m, keepIds: keep, liveCount: [...s.m.values()].filter(Boolean).length,
    lastUsed: s.last,
  })
  assert.equal(plan.dropBlobs.length, 40, '可见的 2 张从候选中排除，仍要撤够差额')
  assert.ok(!plan.dropBlobs.some((d) => keep.has(d.id)))
  assert.ok(!plan.dropMarkers.some((d) => keep.has(d.id)))
  assert.equal(plan.dropMarkers.length, 20)
})

test('空闲收缩：目标按 IDLE_KEEP，不是 MAX_KEEP', () => {
  const s = blobMap(1000)
  const rolling = run(s.m, s.last)
  assert.equal(rolling.dropBlobs.length, 0, '滚动中 1000 < 1500，不撤')
  const idle = run(s.m, s.last, { idle: true })
  assert.equal(idle.dropBlobs.length, 1000 - IDLE_KEEP, '空闲要收到 300 张')
})

test('空闲收缩不会把可见区撤掉：可见数超过目标时只撤非可见的', () => {
  const s = blobMap(500)
  const keep = new Set([...s.m.keys()].slice(0, 400))
  const plan = planEviction({
    urls: s.m, keepIds: keep, liveCount: 500, lastUsed: s.last, idle: true,
  })
  assert.equal(plan.dropBlobs.length, 100, '只能撤那 100 张非可见的')
  assert.ok(plan.dropBlobs.every((d) => !keep.has(d.id)))
})

test('标记超上限：按最旧先撤；没超标时一个都不动', () => {
  const under = withMarkers(blobMap(0), MISS_MAX)
  assert.equal(run(under.m, under.last).dropMarkers.length, 0)
  const over = withMarkers(blobMap(0), MISS_MAX + 5)
  const plan = run(over.m, over.last)
  assert.equal(plan.dropMarkers.length, 5)
  assert.deepEqual(plan.dropMarkers.map((d) => d.id), ['m0', 'm1', 'm2', 'm3', 'm4'])
})

test('接线：useThumbBatch 用纯函数算淘汰、删 miss 标记、并挂空闲收缩', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/useThumbBatch.js'), 'utf8')
  assert.match(src, /planEviction\(\{[\s\S]*?liveCount: liveUrls\.size/,
    '判据必须是真 blob 数，不能是 urls.size / map.size')
  assert.match(src, /miss\.delete\(d\.id\)/,
    "删 '' 标记时必须连 miss 一起删，否则该照片滚回视口会永久空白")
  assert.match(src, /armIdle\(idleShrink, IDLE_AFTER_MS\)/, '每次可见区变化都要重排空闲收缩')
  assert.match(src, /d\.defer\(\)/, '防抖定时器必须走 disposables 的 defer')
  assert.ok(!/cands\.slice\(0,\s*map\.size\s*-\s*MAX_KEEP\)/.test(src), '旧的按 map.size 计数不许回来')
  assert.match(src, /armIdle\.cancel\(\)/, '切相册与卸载都要取消空闲收缩')
})
