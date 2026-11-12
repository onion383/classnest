// =========================================================================
// useThumbBatch.js —— 缩略图批量预取（性能优化）
//
// 背景：相册网格一次要显示几十上百张缩略图。逐个 <img> 请求受浏览器同源并发
// 连接数限制（HTTP/1.1 通常 6 条），往返开销占比很高。实测（后端已上内存缓存后）：
//   逐个并发 6      2.43 ms/张
//   批量每批 100 张  0.19 ms/张   （约 10 倍）
//
// 做法：可视区变化时，把当前可见的照片 id 一次性批量取回来，转成 objectURL
// 交给 <img> 用；取不到的那些（服务端没缓存的）回落到单张 /thumb 接口，
// 由服务端现场生成 —— 功能完全不变，只是把「N 次往返」压成「1 次往返 + 少量回落」。
//
// 生命周期注意：
//   · objectURL 必须 revoke，否则 blob 内存一直占着（切相册/销毁组件时要清）。
//   · 批量请求要防抖：滚动时可见区变化频繁，节流后再发。
//   · 同一批 id 重复请求要合并（用 inflight 标记）。
// =========================================================================
import { ref, onBeforeUnmount, onScopeDispose, getCurrentScope, watch } from 'vue'
import { fetchThumbBatch } from '../utils/albumMedia'
import { useDisposables } from '../utils/disposables.js'
import { IDLE_AFTER_MS, planEviction } from '../utils/thumbCachePolicy.js'

// 可视区变化后多久发一次批量请求（毫秒）
const DEBOUNCE_MS = 120
// 整批失败后的自动重试间隔：失败时不在 urls 里留任何标记，只排一次 run()。
// 等到 800ms 而不是 120ms，是给「后端刚重启 / 网络刚恢复」留出时间，避免连着撞墙。
const RETRY_DELAY_MS = 800
// 连续整批失败的上限：到顶就回落单张（见 load 里的注释），别让格子一直空着。
const RETRY_MAX = 2
// 一次批量请求最多带多少张
const CHUNK = 100
// 缓存上限与淘汰策略都在 utils/thumbCachePolicy.js（纯函数、可 node 单测）。
// 这里更正一个过时估算：实测 21,808 张缩略图 / 247MB，平均 11.6KB 一张，
// 所以 MAX_KEEP=1500 实际约 17MB，不是旧注释写的 75MB。

export function useThumbBatch(getVisibleIds, options = {}) {
  const enabled = options.enabled !== false
  // photoId → 三态值：
  //   undefined  批量还没结果（调用方应「先不渲染」）
  //   ''         服务端没缓存这张缩略图，放弃批量、走单张接口
  //   'blob:…'   已就绪，直接用
  const urls = ref(new Map())
  // 正在请求中的 id 集合（避免重复请求同一批）
  const inflight = new Set()
  // 已尝试过批量但没拿到的 id（这类直接走单张回落，不再进批量）
  const miss = new Set()
  // photoId → 最近一次被读取时的序号，仅用于 LRU 淘汰。普通 Map（非响应式）：
  // 在 getter 里写响应式状态会让渲染触发自己，死循环。
  const lastUsed = new Map()
  let useSeq = 0

  let timer = 0
  let destroyed = false
  // 连续「整批没拿到」的次数，成功一次即归零。到 RETRY_MAX 就回落单张。
  let failStreak = 0
  // 已创建但尚未 revoke 的 objectURL
  const liveUrls = new Set()

  /* 空闲收缩定时器走统一资源登记表：不能自己 setTimeout 再靠人脑记得 clear。
   * 必须用 defer 而不是 timeout —— d.timeout() 返回的「取消函数」只把清理项从表里
   * 摘掉、并不 clearTimeout（实测回调照跑），而空闲收缩是防抖语义，每次可见区变化
   * 都要真正取消上一次。defer 的 schedule() 每次会先清掉上一轮。 */
  const d = useDisposables()
  const armIdle = d.defer()
  function idleShrink() {
    if (destroyed) return
    evict(new Set(getVisibleIds() || []), { idle: true })
  }

  function revokeAll() {
    for (const u of liveUrls) {
      try { URL.revokeObjectURL(u) } catch (_) {}
    }
    liveUrls.clear()
    urls.value = new Map()
  }

  /* 内存回收：把「判据」和「候选」交给纯函数 planEviction 算，这里只执行。
   *
   * 原先是用「map.size 减去上限」决定淘汰数量 —— map.size 里混着大量
   * '' 标记（服务端没缓存缩略图时写的占位），而上限说的是真 blob 数。
   * 攒够几千个 '' 之后，每次滚动都会把几乎所有非可见 blob 一次撤光，
   * 滚回去只能重新 createObjectURL，<img> 的 src 又变一次 → 闪。
   *
   * 空闲收缩（idle=true）：滚动停止一会后主动降到 IDLE_KEEP，而不是一直挂到上限。
   * 安全前提：只撤「非可见」的。被撤的格子已经被虚拟滚动卸载了，
   * 回来时是新挂载的 <img>、src 是首次赋值，不属于「同一个 img 二次换 src」。 */
  function evict(keepIds, { idle = false } = {}) {
    const plan = planEviction({
      urls: urls.value, keepIds, liveCount: liveUrls.size, lastUsed, idle,
    })
    if (!plan.dropBlobs.length && !plan.dropMarkers.length) return
    const next = new Map(urls.value)
    for (const d of plan.dropBlobs) {
      try { URL.revokeObjectURL(d.u) } catch (_) {}
      liveUrls.delete(d.u)
      next.delete(d.id)
      lastUsed.delete(d.id)
    }
    for (const d of plan.dropMarkers) {
      // 连 miss 一起删：留着 miss 的话 load() 会跳过它，'' 标记永远补不回来，
      // 这张照片滚回视口时会一直是空白（thumbUrlFor 返回 undefined）。
      next.delete(d.id)
      miss.delete(d.id)
      lastUsed.delete(d.id)
    }
    urls.value = next
  }

  async function load(ids) {
    if (!enabled || destroyed) return
    const want = []
    for (const id of ids) {
      if (id == null) continue
      if (urls.value.has(id)) continue
      if (miss.has(id)) continue
      if (inflight.has(id)) continue
      want.push(id)
    }
    if (!want.length) return
    // 先把整批 id 全部标成 inflight，再开始逐 chunk 请求。
    // 只在循环内逐 chunk 标记的话，第二个并发 run()（定时重试/滚动触发）在第一个 chunk
    // 还没返回时看不到后面 chunk 的 id，会把同一批图重复请求一遍（审查 v5 · V5-018）。
    want.forEach(id => inflight.add(id))

    for (let i = 0; i < want.length; i += CHUNK) {
      const chunk = want.slice(i, i + CHUNK)
      try {
        const map = await fetchThumbBatch(chunk)
        if (destroyed) return
        // null = 这次没拿到（网络断 / 后端 5xx / 响应解析失败），跟「服务端确实没这张」
        // 是两回事。**失败时不写任何状态**：这些 id 仍是 undefined，不在 urls 也不在 miss，
        // 下一次 run()（滚动、切换相册、下面的自动重试）自然会重新请求一遍。
        //
        // 以前的写法是把失败也折成空 Map，再统一写 miss + ''，等于一次抖动就把这些 id
        // 永久判成「没有缩略图」——批量预取对它们彻底失效，后半程只能逐张回落。
        if (!map) {
          failStreak++
          if (failStreak > RETRY_MAX) {
            // 连续失败到上限：放弃批量、回落单张。此时写 '' 是这张 id 的**第一次**赋值，
            // 调用方把 <img> src 定成单张 URL，之后不会再被 blob 改第二次（不会重解码闪动）。
            const next = new Map(urls.value)
            for (const id of chunk) {
              miss.add(id)
              next.set(id, '')
            }
            urls.value = next
          } else {
            scheduleRetry()
          }
          continue
        }
        failStreak = 0
        const next = new Map(urls.value)
        for (const [id, blob] of map) {
          const u = URL.createObjectURL(blob)
          liveUrls.add(u)
          next.set(id, u)
        }
        // 这一批里没回来的 id：服务端不现场生成缩略图，所以批量永远拿不到它。
        // 写入空串（而不是留 undefined）是为了把「还在拿」和「放弃批量」区分开 ——
        // 否则调用方会一直等，格子永远是空的。
        for (const id of chunk) {
          if (!map.has(id)) {
            miss.add(id)
            next.set(id, '')
          }
        }
        urls.value = next
      } catch (_) {
        // 建 objectURL 之类的本地异常：同样不写状态，留给下次重试
      } finally {
        // 无论成功、失败、提前 return 还是异常，inflight 都必须清干净 ——
        // 漏掉一个 id 就等于它在这辈子都不会再进批量。
        chunk.forEach(id => inflight.delete(id))
      }
    }
  }

  async function run() {
    const ids = getVisibleIds() || []
    if (!ids.length) return
    await load(ids)
    // 拿完再看一眼总容量，超了才按 LRU 收一批（见 evict 的注释）
    evict(new Set(getVisibleIds() || []))
  }

  // immediate：切换相册 / 首次加载后立即拉。
  // 现在 <img> 不再用 HTTP 图垫底，等批量就等于「格子先空着」，
  // 那 120ms 防抖就成了纯粹的空白时间，没有必要。
  // 滚动时仍走防抖（watch 调的是不带参数的 schedule）。
  function schedule(immediate = false) {
    if (!enabled || destroyed) return
    if (timer) { clearTimeout(timer); timer = 0 }
    // 每次可见区变化都把「空闲收缩」重新排到 2 秒后；只要还在滚，就一直不触发
    armIdle(idleShrink, IDLE_AFTER_MS)
    if (immediate) { run(); return }
    timer = setTimeout(() => { timer = 0; run() }, DEBOUNCE_MS)
  }

  // 整批失败后的自动重试：不写任何缓存状态，只把 run() 再排一次。
  // 复用同一个 timer，所以 onBeforeUnmount / clear 已有的清理逻辑同时覆盖它。
  function scheduleRetry() {
    if (!enabled || destroyed) return
    if (timer) { clearTimeout(timer); timer = 0 }
    armIdle(idleShrink, IDLE_AFTER_MS)
    timer = setTimeout(() => { timer = 0; run() }, RETRY_DELAY_MS)
  }

  // 可视区 id 列表变化 → 调度一次批量预取。
  // 必须包一层：watch 会把 (newVal, oldVal) 传给回调，直接传 schedule 会让
  // newVal（一个字符串）被当成 immediate 参数，变成每次都立即发请求。
  watch(() => {
    const ids = getVisibleIds() || []
    // 只用「长度 + 首尾 id」做依赖判断，避免大数组每次都触发深比较
    return ids.length ? `${ids.length}:${ids[0]}:${ids[ids.length - 1]}` : ''
  }, () => schedule())

  // 清理钩子两个作用域都挂：组件内走 onBeforeUnmount；在组件外被（测试/工具）调用时
  // onBeforeUnmount 注册不了，会留下 watch 与定时器继续排期（审查 v5 · V5-015）。
  // cleanup 幂等，两个钩子在组件里同时触发也没有副作用。
  function cleanup() {
    if (destroyed) return
    destroyed = true
    if (timer) { clearTimeout(timer); timer = 0 }
    armIdle.cancel()
    d.dispose()
    revokeAll()
  }
  onBeforeUnmount(cleanup)
  if (getCurrentScope()) onScopeDispose(cleanup)

  return {
    // 取某张照片的缩略图地址，三态返回（调用方按 undefined / '' / blob 分别处理）：
    //   undefined → 批量还没结果，先别给 <img> 设 src
    //   ''        → 批量拿不到，调用方回落到单张 /thumb 接口
    //   'blob:…'  → 直接用
    thumbUrlFor: (photoId) => {
      const u = urls.value.get(photoId)
      // 每次读取都刷新 LRU 时间戳：渲染顺序 ≈ 用户实际看的顺序。
      // '' 标记也要记 —— 它同样参与淘汰，不记的话所有标记都停在 0，
      // 只能按插入顺序 FIFO 淘汰，刚看过的也可能被先撤掉。
      if (u !== undefined) lastUsed.set(photoId, ++useSeq)
      return u
    },
    // 手动触发一次：立即执行（切换相册、首次加载完照片时用，不等防抖）
    refresh: () => schedule(true),
    // 清空所有缓存（切换相册时用）
    // 清空所有缓存（切换相册时用）：连同重试定时器一起停掉，
    // 否则上一本相册排的那次 run() 会落到新相册的可见区上，白发一轮请求。
    clear: () => {
      if (timer) { clearTimeout(timer); timer = 0 }
      armIdle.cancel()   // 上一本相册排的收缩不能落到新相册的可见区上
      revokeAll(); miss.clear(); inflight.clear(); lastUsed.clear(); failStreak = 0
    },
  }
}
