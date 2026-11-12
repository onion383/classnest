// =========================================================================
// thumb-idle.test.js —— 空闲收缩定时器（useThumbBatch 集成）
//
// 纯策略单测只能证明「算得对」，证明不了「定时器真的会跑」。
// 这里用真实的 composable：灌 350 张 blob → 把可见区缩到 10 张 →
// 停 2 秒 → 非可见的最旧一批应该被 revoke（thumbUrlFor 变 undefined），
// 而可见的 10 张必须纹丝不动。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const FRONT = path.join(ROOT, 'student-frontend')
const VITE_ENTRY = path.join(FRONT, 'node_modules', 'vite', 'dist', 'node', 'index.js')
const { loadVue } = require('./_vue-loader.cjs')

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

function batchResponse(pairs) {
  const frames = pairs.map(({ size }) => {
    const b = Buffer.alloc(4 + size)
    b.writeUInt32LE(size, 0)
    b.fill(0x2a, 4)
    return b
  })
  return new Response(Buffer.concat(frames), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Thumb-Ids': pairs.map((p) => p.id).join(','),
    },
  })
}

test('空闲 2 秒后主动收缩：非可见的最旧 blob 被撤销，可见区保持不动', async (t) => {
  globalThis.window = globalThis.window || { __SECURE_CHANNEL__: false }
  const { createServer } = await import(pathToFileURL(VITE_ENTRY).href)
  const server = await createServer({
    root: FRONT, configFile: false,
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
  })
  const { useThumbBatch } = await server.ssrLoadModule('/src/composables/useThumbBatch.js')
  const { IDLE_AFTER_MS, IDLE_KEEP } = await server.ssrLoadModule('/src/utils/thumbCachePolicy.js')
  const realFetch = globalThis.fetch
  t.after(async () => { globalThis.fetch = realFetch; await server.close() })

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
