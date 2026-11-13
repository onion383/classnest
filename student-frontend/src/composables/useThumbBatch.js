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
import { streamThumbBatch } from '../utils/albumMedia'
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
// 「批量没拿到」的标记保留多久（毫秒）。
//
// 为什么必须有这个期限：流式响应里没回来的 id 可能只是「后端排队生成中」，
// 原来的实现把它直接写进一个永久 Set —— 于是这张图在整场会话里只能走单张接口，
// 后端后来早就生成好了也永远不会再进批量。
// 15 秒的依据：后端一屏图正常 1~2 秒出完；就算赶上扫描在跑，十几秒也够了。
// 过期后允许重新进批量，命中缓存就是零成本。
const MISS_TTL_MS = 15000
// 缓存上限与淘汰策略都在 utils/thumbCachePolicy.js（纯函数、可 node 单测）。
// 这里更正一个过时估算：实测 21,808 张缩略图 / 247MB，平均 11.6KB 一张，
// 所以 MAX_KEEP=1500 实际约 17MB，不是旧注释写的 75MB。

export function useThumbBatch(getVisibleIds, options = {}) {
  const enabled = options.enabled !== false
  // 「这批没拿到」的有效期。允许测试传入更短的值 —— 默认 15 秒，单测等不起。
  const missTtlMs = options.missTtlMs > 0 ? options.missTtlMs : MISS_TTL_MS
  // photoId → 三态值：
  //   undefined  批量还没结果（调用方应「先不渲染」）
  //   ''         服务端没缓存这张缩略图，放弃批量、走单张接口
  //   'blob:…'   已就绪，直接用
  const urls = ref(new Map())
  // 正在请求中的 id 集合（避免重复请求同一批）
  const inflight = new Set()
  // photoId → 第一次被判定「这批没拿到」的时刻。
  // 带时间戳而不是用 Set：这些 id 只是「这次没给我」，不是「服务端永远没有」，
  // 过了 MISS_TTL_MS 就要允许重新进批量（否则一次排队 = 整场会话只能走单张）。
  const miss = new Map()
  // photoId → 最近一次被读取时的序号，仅用于 LRU 淘汰。普通 Map（非响应式）：
  // 在 getter 里写响应式状态会让渲染触发自己，死循环。
  const lastUsed = new Map()
  let useSeq = 0

  let timer = 0
  let destroyed = false
  // 连续「整批没拿到」的次数，成功一次即归零。到 RETRY_MAX 就回落单张。
  let failStreak = 0
  // 当前这一次批量请求的中断器。发起新一批前先 abort 旧的：用户已经滑走了，
  // 旧那批图没人再看，继续跑只会占着服务端的生成配额 —— 新的视口因此排不上队。
  let inflightCtl = null
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

  /* 过期的「这批没拿到」标记要放行。
   *
   * 这些 id 只是这次没给我（后端排队 / 被 abort），不是服务端永远没有。
   * 不放行的话，一张图只要赶上一次排队，整场会话就固定走单张接口 ——
   * 后端后来早就把图生成好了，批量却再也不问它。
   *
   * 只删 urls 里仍是 '' 的：已经被 blob 覆盖的值不能动（那是正常结果）。
   *
   * 单张已经显示成功的那些**不在 miss 里**（`markLoaded` 会把计时抹掉），
   * 所以这里根本遍历不到它们 —— 不需要额外用一个「已成功」集合去豁免。
   * urls 里的 '' 仍然让 load() 跳过它们，src 不会被换成 blob 重新解码。 */
  function sweepExpiredMisses() {
    if (!miss.size) return
    const now = Date.now()
    let changed = false
    const next = new Map(urls.value)
    for (const [id, ts] of miss) {
      if (now - ts < missTtlMs) continue
      miss.delete(id)
      if (next.get(id) === '') {
        next.delete(id)
        changed = true
      }
    }
    if (changed) urls.value = next
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
    // 新一批开工前，把上一批掐掉（插队语义）：用户已经滑到别处，
    // 上一批的图没人看，让它继续跑只会占服务端配额、把这一批挤到后面。
    if (inflightCtl) inflightCtl.abort()
    inflightCtl = new AbortController()
    const signal = inflightCtl.signal
    // 先把整批 id 全部标成 inflight，再开始逐 chunk 请求。
    // 只在循环内逐 chunk 标记的话，第二个并发 run()（定时重试/滚动触发）在第一个 chunk
    // 还没返回时看不到后面 chunk 的 id，会把同一批图重复请求一遍（审查 v5 · V5-018）。
    want.forEach(id => inflight.add(id))

    for (let i = 0; i < want.length; i += CHUNK) {
      const chunk = want.slice(i, i + CHUNK)
      try {
        /* 收到一张就上屏一张。这是流式响应的全部意义：后端生成一屏图要
         * 1~2 秒（单张 4000×3000 原图解码就 80ms，是 CPU 物理下限，不是调参能解决的），
         * 但用户不必等最后一张才知道有图 —— 第一张约 200ms 就到。
         * 攒起来等流结束再统一写，就等于没改。 */
        const res = await streamThumbBatch(chunk, signal, (id, blob) => {
          if (destroyed) return
          const u = URL.createObjectURL(blob)
          liveUrls.add(u)
          const next = new Map(urls.value)
          next.set(id, u)
          urls.value = next
        })
        // 被后来的批次掐断了：已经收到的那些留在 urls 里（用户滑回来能直接看到，
        // 没必要为了「这批作废」把已上屏的图撤掉）；没收到的仍是 undefined，
        // 谁需要它们，谁会在新的可见区里重新排一次。
        // 注意必须排在 `if (!res)` 之前 —— abort 也会让 fetch 抛错返回 null，
        // 直接当成「没拿到」会白排一次重试，还会把 failStreak 加上去。
        if (signal.aborted) {
          // 还没轮到的 chunk 仍然挂在 inflight 上，不在这里摘掉的话，
          // 这些 id 之后每一轮 load() 都会被 inflight 跳过 —— 等于永久缺图。
          want.forEach(id => inflight.delete(id))
          return
        }
        if (destroyed) return
        // null = 这次没拿到（网络断 / 后端 5xx / 响应解析失败），跟「服务端确实没这张」
        // 是两回事。**失败时不写任何状态**：这些 id 仍是 undefined，不在 urls 也不在 miss，
        // 下一次 run()（滚动、切换相册、下面的自动重试）自然会重新请求一遍。
        //
        // 以前的写法是把失败也折成空 Map，再统一写 miss + ''，等于一次抖动就把这些 id
        // 永久判成「没有缩略图」——批量预取对它们彻底失效，后半程只能逐张回落。
        if (!res) {
          failStreak++
          if (failStreak > RETRY_MAX) {
            // 连续失败到上限：放弃批量、回落单张。此时写 '' 是这张 id 的**第一次**赋值，
            // 调用方把 <img> src 定成单张 URL，之后不会再被 blob 改第二次（不会重解码闪动）。
            const next = new Map(urls.value)
            for (const id of chunk) {
              miss.set(id, Date.now())
              next.set(id, '')
            }
            urls.value = next
          } else {
            scheduleRetry()
          }
          continue
        }
        failStreak = 0
        // 流里没回来的 id：服务端这次确实没有（源文件没了 / 生成失败 / 还在子进程排队）。
        // 写入空串（而不是留 undefined）是为了把「还在拿」和「放弃批量」区分开 ——
        // 否则调用方会一直等，格子永远是空的。
        //
        // 用「urls 里有没有值」判断，而不是数收到了几条：abort 之前收到的那些
        // 已经写进 urls 了，这里再写 '' 会把刚上屏的图撤掉。
        const next = new Map(urls.value)
        for (const id of chunk) {
          if (!next.has(id)) {
            miss.set(id, Date.now())
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
    // 先把过期的「这批没拿到」放行，再收集 want —— 否则过期标记永远等不到
    // 下一次机会（load 里 miss.has(id) 直接跳过，连想都不用想）。
    sweepExpiredMisses()
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
    // 用**完整序列**做依赖，不用「长度 + 首尾」：
    // 顺序现在是有意义的 —— 调用方把视口内的排前面（后端按请求顺序生成），
    // 只比首尾会把「同一屏内重排序」当成没变化。n 最多几十个数字，
    // 每 80ms 才 join 一次，成本可忽略。
    return ids.length ? ids.join(',') : ''
  }, () => schedule())

  // 清理钩子两个作用域都挂：组件内走 onBeforeUnmount；在组件外被（测试/工具）调用时
  // onBeforeUnmount 注册不了，会留下 watch 与定时器继续排期（审查 v5 · V5-015）。
  // cleanup 幂等，两个钩子在组件里同时触发也没有副作用。
  function cleanup() {
    if (destroyed) return
    destroyed = true
    if (timer) { clearTimeout(timer); timer = 0 }
    if (inflightCtl) { inflightCtl.abort(); inflightCtl = null }
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
    /* 单张接口已经成功把这张图显示出来了 → 抹掉「这批没拿到」的计时。
     * 不抹的话：15 秒后 miss 过期，sweep 把 urls 里的 '' 删掉，这张图重新进批量、
     * 拿到 blob，而 <img> 的 src 从「单张 URL」变成「blob:」，浏览器会重新解码、画面闪一下。
     * 抹掉计时后 sweep 遍历不到它，urls 里的 '' 也让 load() 跳过，两者一起保证「不再换 src」。
     * 图本来就好好的，不该因为「后台优化」而闪。 */
    markLoaded: (photoId) => {
      if (photoId == null) return
      miss.delete(photoId)
    },
    // 清空所有缓存（切换相册时用）：连同重试定时器一起停掉，
    // 否则上一本相册排的那次 run() 会落到新相册的可见区上，白发一轮请求。
    clear: () => {
      if (timer) { clearTimeout(timer); timer = 0 }
      // 切相册：上一本还没跑完的批量请求必须掐掉，否则它的图会落到新相册上（错图）
      if (inflightCtl) { inflightCtl.abort(); inflightCtl = null }
      armIdle.cancel()   // 上一本相册排的收缩不能落到新相册的可见区上
      // 新相册的 photoId 会重用，miss / urls / inflight 都要清干净
      revokeAll(); miss.clear(); inflight.clear(); lastUsed.clear(); failStreak = 0
    },
  }
}
