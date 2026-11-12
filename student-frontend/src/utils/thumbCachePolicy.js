// =========================================================================
// thumbCachePolicy.js —— 缩略图缓存的淘汰策略（纯函数，可 node 单测）
//
// 为什么从 useThumbBatch 里抽出来：淘汰逻辑写错不会报错，只会「滚回去时图片闪」
// 或者「内存一路挂着不回落」。原来的 bug 正是这个：
//
//   const drop = cands.slice(0, map.size - MAX_KEEP)
//
// map.size 里混着大量 '' 标记（批量接口没拿到缩略图时写的占位），而 MAX_KEEP
// 说的是「真 blob 数」。一旦攒够几千个 '' 标记，每次滚动都会把几乎所有非可见
// blob 一次撤光 —— 滚回去只能重新 createObjectURL，<img> 的 src 又变一次，
// 正是这个文件开头那段注释说务必避免的闪动源头。
//
// 所以这里把「判据」和「候选」分开：判据只看真 blob 数，'' 标记单独按条数封顶。
// =========================================================================

// 滚动中允许挂多少个 objectURL。真实缩略图平均 11.6KB（实测 21,808 张 / 247MB），
// 1500 张 ≈ 17MB。注意别再沿用旧的「40~60KB/张」估算，那个数字已经过时。
export const MAX_KEEP = 1500
// 空闲（滚动停止）后收缩到多少张真 blob。300 张 ≈ 3.5MB，够覆盖视口 + 缓冲。
export const IDLE_KEEP = 300
// '' 标记单独封顶：它不是 blob、不占 liveUrls，但也不能无限攒（否则会让任何按
// map.size 的判据失真，且拖慢每次 evict 的遍历）。单条只有 id + 空串，很便宜。
export const MISS_MAX = 3000
// 滚动停止多久算空闲
export const IDLE_AFTER_MS = 2000

/**
 * 算出这一轮该淘汰谁。纯函数：不改 Map、不碰 URL、不触发响应式。
 *
 * @param {Object}  p
 * @param {Map}     p.urls      id → ''（回落单张）| 'blob:…'（就绪）
 * @param {Set}     p.keepIds   当前可见的 id —— 一律不动（撤掉必闪）
 * @param {number}  p.liveCount 当前真 blob 数（调用方 liveUrls.size，唯一判据）
 * @param {Map}     [p.lastUsed] id → 最近使用序号，用于 LRU
 * @param {boolean} [p.idle]     true = 空闲收缩（目标 IDLE_KEEP）
 * @returns {{ dropBlobs: Array<{id, u}>, dropMarkers: Array<{id}> }}
 */
export function planEviction({ urls, keepIds, liveCount, lastUsed, idle = false }) {
  const usedOf = (id) => (lastUsed && lastUsed.get(id)) || 0
  const blobs = []
  const markers = []
  let markerTotal = 0

  for (const [id, u] of urls) {
    if (u === '') markerTotal++
    if (keepIds.has(id)) continue          // 可见区的元素还挂在 DOM 上，撤掉必闪
    if (u) blobs.push({ id, u, used: usedOf(id) })
    else if (u === '') markers.push({ id, used: usedOf(id) })
  }
  const byOldest = (a, b) => a.used - b.used
  blobs.sort(byOldest)
  markers.sort(byOldest)

  // ① 真 blob：只按「真 blob 数」判超标，绝不用 urls.size
  const target = idle ? IDLE_KEEP : MAX_KEEP
  const blobOver = Math.max(0, (Number(liveCount) || 0) - target)
  // ② '' 标记：单独按条数封顶
  const missOver = Math.max(0, markerTotal - MISS_MAX)

  return {
    dropBlobs: blobs.slice(0, blobOver),
    dropMarkers: markers.slice(0, missOver),
  }
}
