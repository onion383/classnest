// =========================================================================
// albumPhotoPages.js —— 相册照片「日期分页」的纯逻辑
//
// 为什么单独成文件：这几条规则（同一天整组进出、未知时间组永远在最后、
// 组头张数不能因为还没加载就显示 0）恰恰是最容易写错的地方，而写在 .vue 里
// 就没法用 node 单测 —— 只能靠「构建通过」这种静态验证，而静态验证抓不到
// 顺序错误、抓不到「合并时把已加载的组又覆盖一遍」。
// 所以这里只放不碰 DOM、不碰 axios 的纯函数，AlbumView 只负责调用。
// =========================================================================

// 读不到 EXIF 的照片 photo_date 是空串，与后端约定用这一组兜底（同一个字符串，两处必须一致）
export const UNKNOWN_DATE = '未知时间'

// 日期 +1 天。
// before 参数是「不含」语义：要从某天开始倒序取，得传它的下一天。
// 用中午 12 点构造 —— 用 0 点会在夏令时切换那天落到「不存在的时间」上，
// 反过来算出来的日期可能差一天（Windows 上中国无夏令时，但别把这个前提写死）。
export function nextDayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  d.setDate(d.getDate() + 1)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 某个分组作为分页锚点时，请求要带的 before 值。
// 「未知时间」组没有日期，用一个排在所有日期之后的大日期把尾页取回来
// （后端只在没有更多日期可给时，才把未知组追加在最后一页）。
export function pageBefore(anchorDate) {
  if (!anchorDate || anchorDate === UNKNOWN_DATE) return '9999-12-31'
  return nextDayOf(anchorDate)
}

// 组头「N 张」：优先用日期索引给的总张数。
// 照片还没加载时 photos 是 null，此时不能显示 0 —— 那个日期确实有照片，只是还没取。
export function groupCountOf(g) {
  if (!g) return 0
  if (g.count != null) return g.count
  return g.photos ? g.photos.length : 0
}

// 从 fromIndex 起找第一个「还没照片、或张数变了需要重取」的组；全都就绪返回 -1。
// 锚点必须落在这个缺口上：从已就绪的组再请求一次会白拿一整页重复数据。
export function firstUnloadedIndex(groups, fromIndex = 0) {
  if (!groups || !groups.length) return -1
  let i = Math.max(0, Math.min(fromIndex, groups.length - 1))
  while (i < groups.length && groups[i].photos && !groups[i].dirty) i++
  return i < groups.length ? i : -1
}

// 把一页照片按 date 整组填进已存在的分组。返回实际填充的组数。
//
// 三个约束，每条都对应一个真实会出的错：
//   ① 只填「还没照片」或「被标记 dirty」的组 —— 已就绪的组再覆盖一次，会把滚动中
//      正在显示的图片换成新对象，缩略图 objectURL 的绑定跟着失效（画面闪白）。
//   ② 不新增、不删除分组 —— 分组来自日期索引，是布局的唯一依据。
//      多一组少一组，总高度就变了，滚动条会自己跳。
//   ③ 张数以实际行数为准 —— 索引与照片行同源，理论上相等；真不等只可能是扫描期间
//      有增删，按真数修正起码高度是对的。
export function mergePhotoGroups(groups, incoming) {
  if (!groups || !groups.length || !incoming || !incoming.length) return 0
  const byDate = new Map()
  for (const g of incoming) if (g && g.date) byDate.set(g.date, g)
  let filled = 0
  for (const g of groups) {
    if (g.photos && !g.dirty) continue
    const hit = byDate.get(g.date)
    if (!hit) continue
    g.photos = hit.photos || []
    g.count = g.photos.length
    g.dirty = false
    filled++
  }
  return filled
}

// 拆成「日期索引 → 分组占位」：photos 先留 null，高度按 count 预留
export function buildGroupPlaceholders(dateRows) {
  if (!Array.isArray(dateRows)) return []
  return dateRows.map((r) => ({
    date: r.date || UNKNOWN_DATE,
    count: Number(r.count) || 0,
    photos: null,
    dirty: false,
  }))
}

/* ===== 选照片弹窗的「选择描述」 =====
 * 为什么不是一个 id 数组：相册是分页加载的，没加载的照片前端根本没有对象/ id；
 * 「整册全选」更不该把一万个 id 拉过来再传回去。
 * 所以选择被描述成三件事：是不是整册、显式勾了哪些、整册里排除了哪些。
 * 展开动作在后端（POST /api/album 的 all_from）。 */

// 集合大小：兼容数组（提交/回传用）与 Set（弹窗内部用），免得为了算个数先摊平一次
function sizeOf(v) {
  if (!v) return 0
  if (Array.isArray(v)) return v.length
  if (typeof v.size === 'number') return v.size
  return 0
}

// 已选张数。整册时 = 总数 - 排除数；否则就是勾选数。
export function selectionCount(sel, total) {
  if (!sel) return 0
  if (!sel.allOfAlbum) return sizeOf(sel.ids)
  return Math.max(0, (Number(total) || 0) - sizeOf(sel.exclude))
}

// 构造「新建虚拟相册」的请求体。返回 null 表示没得提交（一张都没选）。
// 两种情况都只传 id 或「哪一册减哪些」—— 提交从来不需要照片对象。
export function buildVirtualAlbumBody(name, sel) {
  if (!sel) return null
  const body = { kind: 'virtual', name }
  if (sel.allOfAlbum) {
    body.all_from = sel.albumId
    body.exclude = sel.exclude || []
  } else {
    const ids = sel.ids || []
    if (!ids.length) return null
    body.photos = ids.map((id) => ({ photo_id: id }))
  }
  return body
}

/* 把新的日期索引「对账」进已有分组 —— 这是「后台扫描时整片闪」的修法。
 *
 * 原来的做法是每次刷新都用 buildGroupPlaceholders 重建：
 *   groups.value = 全新占位（photos 全是 null）
 * 扫描期间相册页每 800ms 拉一次，于是所有格子每 800ms 被卸载一次、再重建一次，
 * 图片跟着重挂、重解一遍 —— 用户看到的就是「一闪一闪」。
 *
 * 对账的三条规则：
 *   · 日期还在、张数没变  → 原样复用同一个对象（连同已加载的 photos 数组）。
 *     Vue 按 key 复用 DOM，一个格子都不会重挂。
 *   · 日期还在、张数变了  → 保留旧照片，只标 dirty，等下一页把它换掉。
 *     直接置 null 会让这一组瞬间变空（又是闪），而 dirty 换的是整个数组、
 *     元素 key 没变，Vue 只会插入/删除差异项。
 *   · 新出现的日期 → 建占位；消失的日期 → 整组移除（照片真被删了，该消失）。
 */
export function syncGroupPlaceholders(existing, dateRows) {
  if (!Array.isArray(dateRows)) return []
  const prev = new Map()
  for (const g of existing || []) prev.set(g.date, g)
  return dateRows.map((r) => {
    const date = r.date || UNKNOWN_DATE
    const count = Number(r.count) || 0
    const old = prev.get(date)
    if (!old) return { date, count, photos: null, dirty: false }
    if (old.count !== count) {
      old.count = count
      // 已经加载过的组才会因为张数变化需要重取；没加载的本来就是 dirty=false 的占位
      if (old.photos) old.dirty = true
    }
    return old
  })
}
