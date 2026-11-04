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
import { ref, onBeforeUnmount, watch } from 'vue'
import { fetchThumbBatch } from '../utils/albumMedia'

// 可视区变化后多久发一次批量请求（毫秒）
const DEBOUNCE_MS = 120
// 整批失败后的自动重试间隔：失败时不在 urls 里留任何标记，只排一次 run()。
// 等到 800ms 而不是 120ms，是给「后端刚重启 / 网络刚恢复」留出时间，避免连着撞墙。
const RETRY_DELAY_MS = 800
// 连续整批失败的上限：到顶就回落单张（见 load 里的注释），别让格子一直空着。
const RETRY_MAX = 2
// 一次批量请求最多带多少张
const CHUNK = 100
// 已生成 objectURL 的缩略图最多保留多少张（LRU 上限）
// 512px / q82 的 JPEG blob 约 40~60KB，1500 张 ≈ 75MB，够滚过好几个屏幕还不用重取。
const MAX_KEEP = 1500

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

  function revokeAll() {
    for (const u of liveUrls) {
      try { URL.revokeObjectURL(u) } catch (_) {}
    }
    liveUrls.clear()
    urls.value = new Map()
  }

  // 内存回收：只在超过 MAX_KEEP 时按 LRU 淘汰，且绝不碰当前可见区。
  //
  // 原先的做法是「只保留此刻可见的，其余立刻 revoke」。它省内存，但代价是：
  // 往回滚一屏，那些 objectURL 已经没了 → <img> 从 blob 退回 http URL → 120ms 后
  // 批量再做一批新 objectURL → src 又变回 blob。**同一个 <img> 的 src 变了两次**，
  // 浏览器每次都当作「换了一张图」，清帧重解码，画面上就是「图片在格子里跳 / 闪」。
  // 现在改成延迟淘汰：src 一旦定下就不再变，闪动的根就没了。
  function evict(keepIds) {
    const map = urls.value
    if (map.size <= MAX_KEEP) return
    const cands = []
    for (const [id, u] of map) {
      if (!u) continue                    // '' 标记体积极小，留着免得重复请求
      if (keepIds.has(id)) continue       // 可见区的元素还挂在 DOM 上，撤掉必闪
      cands.push(id)
    }
    if (!cands.length) return
    cands.sort((a, b) => (lastUsed.get(a) || 0) - (lastUsed.get(b) || 0))
    const drop = cands.slice(0, map.size - MAX_KEEP)
    if (!drop.length) return
    const next = new Map(map)
    for (const id of drop) {
      const u = next.get(id)
      try { URL.revokeObjectURL(u) } catch (_) {}
      liveUrls.delete(u)
      next.delete(id)
      lastUsed.delete(id)
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

    for (let i = 0; i < want.length; i += CHUNK) {
      const chunk = want.slice(i, i + CHUNK)
      chunk.forEach(id => inflight.add(id))
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
    if (immediate) { run(); return }
    timer = setTimeout(() => { timer = 0; run() }, DEBOUNCE_MS)
  }

  // 整批失败后的自动重试：不写任何缓存状态，只把 run() 再排一次。
  // 复用同一个 timer，所以 onBeforeUnmount / clear 已有的清理逻辑同时覆盖它。
  function scheduleRetry() {
    if (!enabled || destroyed) return
    if (timer) { clearTimeout(timer); timer = 0 }
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

  onBeforeUnmount(() => {
    destroyed = true
    if (timer) { clearTimeout(timer); timer = 0 }
    revokeAll()
  })

  return {
    // 取某张照片的缩略图地址，三态返回（调用方按 undefined / '' / blob 分别处理）：
    //   undefined → 批量还没结果，先别给 <img> 设 src
    //   ''        → 批量拿不到，调用方回落到单张 /thumb 接口
    //   'blob:…'  → 直接用
    thumbUrlFor: (photoId) => {
      const u = urls.value.get(photoId)
      // 每次读取都刷新 LRU 时间戳：渲染顺序 ≈ 用户实际看的顺序
      if (u) lastUsed.set(photoId, ++useSeq)
      return u
    },
    // 手动触发一次：立即执行（切换相册、首次加载完照片时用，不等防抖）
    refresh: () => schedule(true),
    // 清空所有缓存（切换相册时用）
    // 清空所有缓存（切换相册时用）：连同重试定时器一起停掉，
    // 否则上一本相册排的那次 run() 会落到新相册的可见区上，白发一轮请求。
    clear: () => {
      if (timer) { clearTimeout(timer); timer = 0 }
      revokeAll(); miss.clear(); inflight.clear(); lastUsed.clear(); failStreak = 0
    },
  }
}
