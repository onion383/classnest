// =========================================================================
// thumb-cache.test.js —— 缩略图缓存（合并自 thumb-batch / thumb-cache-policy / thumb-idle）
//
// 三个文件其实是同一个子系统的三层，各起一次 Vite、各写一遍样板，散在目录里很难找。
// 合并后按层分区，**用例一条没删**：
//   A. 淘汰策略（纯函数，node 直接跑）
//   B. 批量接口契约（fetchThumbBatch 的失败语义 + useThumbBatch 不写脏状态）
//   C. 空闲收缩集成（真的跑定时器）
//
// 前端是 ESM + 无扩展名导入，B/C 两层借 Vite 的 SSR 模块加载器；A 层是纯函数，
// 直接 require 就行。Vite 服务器全文件只起一次。
//
// 跑法：node --test testjs/units/thumb-cache.test.js
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const FRONT = path.join(ROOT, 'student-frontend')
const VITE_ENTRY = path.join(FRONT, 'node_modules', 'vite', 'dist', 'node', 'index.js')
const { loadVue } = require('./_vue-loader.cjs')
const {
  MAX_KEEP, IDLE_KEEP, MISS_MAX, IDLE_AFTER_MS, planEviction,
} = require('../../student-frontend/src/utils/thumbCachePolicy.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 5000, step = 25) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await sleep(step)
  }
}

// 造**流式**批量响应：每帧「id(4 字节小端) + len(4 字节小端) + JPEG len 字节」。
// 服务端生成一张写一张，所以 body 用 ReadableStream 表示；chunkSize 控制
// 「一帧被切成几块到达」，用来验证前端增量解析（真实网络下帧一定会跨块）。
function batchResponse(pairs, opts = {}) {
  const frames = pairs.map(({ id, size }) => {
    const b = Buffer.alloc(8 + size)
    b.writeUInt32LE(id, 0)
    b.writeUInt32LE(size, 4)
    b.fill(0x2a, 8)
    return b
  })
  const all = Buffer.concat(frames)
  const chunkSize = opts.chunkSize || all.length || 1
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < all.length; i += chunkSize) {
        c.enqueue(new Uint8Array(all.subarray(i, i + chunkSize)))
      }
      c.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
}

// 收集 streamThumbBatch 的结果（它的第三个参数是逐张回调，不是收集器）
async function collectBatch(ids, signal) {
  const got = new Map()
  const r = await media.streamThumbBatch(ids, signal, (id, blob) => got.set(id, blob))
  return { r, got }
}

let viteServer = null
let media = null
let useThumbBatch = null
let realFetch = null

test.before(async () => {
  // secureChannel 的 safe() 会读 window.__SECURE_CHANNEL__
  globalThis.window = globalThis.window || { __SECURE_CHANNEL__: false }
  realFetch = globalThis.fetch
  const { createServer } = await import(pathToFileURL(VITE_ENTRY).href)
  viteServer = await createServer({
    root: FRONT,
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  media = await viteServer.ssrLoadModule('/src/utils/albumMedia.js')
  ;({ useThumbBatch } = await viteServer.ssrLoadModule('/src/composables/useThumbBatch.js'))
})
test.after(async () => {
  globalThis.fetch = realFetch
  if (viteServer) await viteServer.close()
})

/* ========================= A. 淘汰策略（纯函数） =========================
 * 锁住那个真 bug：旧 evict 用 map.size - MAX_KEEP 决定淘汰数，而 map.size 里
 * 混着大量 '' 标记，导致每次滚动把几乎所有非可见 blob 一次撤光。 */
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
  assert.match(src, /armIdle\.cancel\(\)/, '切相册与卸载都要取消空闲收缩')
  assert.ok(!/cands\.slice\(0,\s*map\.size\s*-\s*MAX_KEEP\)/.test(src), '旧的按 map.size 计数不许回来')
})

/* ========================= B. 批量接口契约 =========================
 * fetchThumbBatch 把「请求失败」和「服务端确实没有这张缩略图」塌成空 Map 的话，
 * useThumbBatch 会把所有失败 id 永久写进 miss + ''，一次网络抖动就让批量预取
 * 对它们彻底失效（实测 0.19ms/张 掉回 2.43ms/张）。 */
test('缩略图批量：失败与「服务端没有」必须可区分，且失败可重试', async (t) => {
  await t.test('网络异常 → null（不是「成功但零张」）', async () => {
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal((await collectBatch([1, 2])).r, null)
  })

  await t.test('后端 5xx → null', async () => {
    globalThis.fetch = async () => new Response('boom', { status: 500 })
    assert.equal((await collectBatch([1, 2])).r, null)
  })

  await t.test('成功但一张也没有 → ok + 零张（这才是「服务端确实没有」）', async () => {
    globalThis.fetch = async () => batchResponse([])
    const { r, got } = await collectBatch([1, 2])
    assert.equal(r, 'ok', '正常结束的流必须返回 ok，与失败区分开')
    assert.equal(got.size, 0)
  })

  await t.test('成功且两张都在 → 两条、值是 Blob', async () => {
    globalThis.fetch = async () => batchResponse([{ id: 1, size: 16 }, { id: 2, size: 16 }])
    const { got } = await collectBatch([1, 2])
    assert.equal(got.size, 2)
    assert.ok(got.get(1) instanceof Blob)
  })

  // 流式的核心契约：帧自带 id、允许乱序、允许跨块到达。
  // 这三条任一破了，前端就会「少图 / 串图 / 整批解析失败」。
  await t.test('帧自带 id：乱序返回也能按 id 落位（不靠请求顺序对位）', async () => {
    globalThis.fetch = async () => batchResponse([{ id: 2, size: 8 }, { id: 1, size: 8 }])
    const { got } = await collectBatch([1, 2])
    assert.deepEqual([...got.keys()].sort(), [1, 2], '乱序帧必须都解析出来')
  })

  await t.test('一帧被切成多块到达（chunkSize=1，逐字节喂）仍能解析', async () => {
    globalThis.fetch = async () => batchResponse([{ id: 7, size: 20 }, { id: 8, size: 12 }], { chunkSize: 1 })
    const { got } = await collectBatch([7, 8])
    assert.equal(got.size, 2, '跨块截断的帧必须被拼回来，否则真实网络下大量丢图')
    assert.equal(got.get(7).size, 20)
  })

  await t.test('收到一张立刻回调，不等流结束', async () => {
    let ctrl = null
    const stream = new ReadableStream({ start(c) { ctrl = c } })
    globalThis.fetch = async () => new Response(stream, { status: 200 })
    const seen = []
    const done = media.streamThumbBatch([1, 2], undefined, (id) => seen.push(id))
    const one = Buffer.alloc(8 + 4)
    one.writeUInt32LE(1, 0); one.writeUInt32LE(4, 4)
    ctrl.enqueue(new Uint8Array(one))
    await waitFor(() => seen.length === 1)
    assert.deepEqual(seen, [1], '第一帧到达就必须回调，否则「流式」只是把整包拆成两段')
    ctrl.close()
    await done
  })

  await t.test('组合式：首批失败不写任何状态，网络恢复后自己拿到', async () => {
    const visible = [11, 12]
    // 组件外调用 composable 必须包在 effectScope 里：否则它内部的 watch 没有所属作用域，
    // 测试结束后仍会随 visible 变化继续排期（审查 v5 · V5-015）。
    const { effectScope } = await loadVue()
    const scope = effectScope()
    let batch = null
    scope.run(() => { batch = useThumbBatch(() => visible) })
    try {
      globalThis.fetch = async () => { throw new Error('offline') }
      batch.refresh()
      await sleep(250)
      // 关键断言：失败时既不写 ''（否则 src 定死单张 URL）、也不写 miss（否则永久跳过）
      assert.equal(batch.thumbUrlFor(11), undefined,
        '失败被写进了缓存状态 —— 这批 id 会在整场会话里永久退出批量预取')

      globalThis.fetch = async () => batchResponse([{ id: 11, size: 24 }, { id: 12, size: 24 }])
      const u = await waitFor(() => {
        const v = batch.thumbUrlFor(11)
        return typeof v === 'string' && v.startsWith('blob:') ? v : null
      })
      assert.ok(u.startsWith('blob:'), '网络恢复后应自动重试并拿到 blob')
    } finally {
      batch.clear()
      scope.stop()
    }
  })
})

/* ========================= C. 空闲收缩集成 =========================
 * 纯策略单测证明「算得对」，这条证明「定时器真的会跑」。 */
test('空闲 2 秒后主动收缩：非可见的最旧 blob 被撤销，可见区保持不动', async () => {
  const { ref, effectScope } = await loadVue()
  const ALL = 350
  const allIds = Array.from({ length: ALL }, (_, i) => i + 1)
  const visible = ref(allIds)
  const scope = effectScope()
  let batch
  scope.run(() => { batch = useThumbBatch(() => visible.value) })

  // 服务端按请求里的 id 回 blob，不回多余的（真实批量接口就是这个语义）
  globalThis.fetch = async (_url, opts) => {
    const ids = JSON.parse(opts.body).ids
    return batchResponse(ids.map((id) => ({ id, size: 16 })))
  }

  try {
    batch.refresh()
    await waitFor(() => typeof batch.thumbUrlFor(ALL) === 'string' && batch.thumbUrlFor(ALL).startsWith('blob:'), 8000)
    assert.ok(batch.thumbUrlFor(ALL).startsWith('blob:'), '350 张都该拿到 blob')

    // 把可见区缩到前 10 张，触发一次滚动（只防抖，不收缩）
    visible.value = allIds.slice(0, 10)
    await sleep(300)
    assert.equal(batch.thumbUrlFor(11).startsWith('blob:'), true, '滚动中不该撤（350 < MAX_KEEP）')

    // 等到空闲收缩触发
    await sleep(IDLE_AFTER_MS + 400)
    const dropped = allIds.filter((id) => batch.thumbUrlFor(id) === undefined)
    assert.equal(dropped.length, ALL - IDLE_KEEP,
      `应撤掉 ${ALL - IDLE_KEEP} 张：真 blob 从 350 收到 300，可见的 10 张已在 350 里、不重复减`)
    assert.equal(batch.thumbUrlFor(1).startsWith('blob:'), true, '可见区的不能动')
    assert.equal(batch.thumbUrlFor(10).startsWith('blob:'), true, '可见区的不能动')
    assert.equal(batch.thumbUrlFor(ALL).startsWith('blob:'), true, '最近加载的应被 LRU 保留')
  } finally {
    batch.clear()
    scope.stop()
  }
})

// ---------------------------------------------------------------------------
// D. 「这批没拿到」不是「服务端永远没有」（2026-11-13）
//
// 流式响应里没回来的 id 原来被写进一个**永久** Set：一次「排队生成中」
// 就让这张图整场会话只能走单张接口，后端后来生成好了也不会再被问一次。
// 现在标记带有效期（MISS_TTL_MS=15s，测试可注入更短值），过期后允许重新进批量；
// 但「单张已经显示成功」的要永久退出（markLoaded）——否则 blob 会换掉 src、重新解码闪一下。
// ---------------------------------------------------------------------------
test('缩略图批量：「这批没拿到」过期后会重新进批量，已成功的永不再问', async () => {
  // useThumbBatch / batchResponse 都是本文件模块级的（Vite SSR 加载，见文件头）
  const { effectScope } = await loadVue()

  const scope = effectScope()
  const requested = []
  let batch = null
  scope.run(() => {
    // TTL 注入 60ms：默认 15 秒，单测等不起
    batch = useThumbBatch(() => [11], { missTtlMs: 60 })
  })
  try {
    // 空流 = 这批一张都没给（等价于「排队生成中」），不是「服务端确实没有」
    globalThis.fetch = async (_url, init) => {
      requested.push(...JSON.parse(init.body).ids)
      return batchResponse([])
    }

    batch.refresh()
    // 等「写进缓存」而不是「请求已发出」：fetch 被调用在前，解析流、写 urls 在后
    await waitFor(() => batch.thumbUrlFor(11) === '')
    assert.deepEqual(requested, [11])

    // 没过期：再 refresh 也不该重新问（否则每次滚动都在重复请求同一批）
    batch.refresh()
    await sleep(120)
    assert.equal(requested.length, 1, '标记未过期时不该重复请求')

    // 过期 + 再 refresh → 重新进批量
    batch.refresh()
    await waitFor(() => requested.length >= 2, 2000)
    assert.ok(requested.length >= 2, '「这批没拿到」过期后必须允许重新进批量（否则一次排队 = 整场只走单张）')
    // 等这一轮流写回 urls：真实场景里 <img> 只有在 urls 已是 '' 时才会渲染并触发 @load，
    // 所以 markLoaded 一定发生在批量结果落地之后。测试若不等就会构造出真实的竞态。
    await waitFor(() => batch.thumbUrlFor(11) === '')

    // 单张已经成功显示过 → 抹掉计时，即使过了 TTL 也不再重新进批量
    batch.markLoaded(11)
    const before = requested.length
    await sleep(120)
    batch.refresh()
    await sleep(200)
    assert.equal(requested.length, before, 'markLoaded 之后不该再进批量（会把 src 从单张换成 blob，重新解码闪一下）')
  } finally {
    batch.clear()
    scope.stop()
  }
})
