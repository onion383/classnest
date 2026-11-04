// =========================================================================
// thumb-batch.test.js —— 缩略图批量预取的失败语义（审查 v4 · P0）
//
// 问题：fetchThumbBatch 把「请求失败」和「服务端确实没有这张缩略图」塌成同一种结果
// （空 Map），useThumbBatch 于是把所有失败 id 都写进 miss + ''，永久判死。
// 后果不是「格子空白」（单张 /thumb 会回落），而是**批量预取对这些 id 静默失效**：
// 一次网络抖动之后，后半程全靠逐张请求，实测 0.19ms/张 掉回 2.43ms/张。
//
// 修法：失败返回 null（可重试），成功返回 Map（空 Map = 服务端确实没有）。
// 这个测试就是钉住这条契约，以及「失败不许写任何缓存状态」。
//
// 跑法：node --test testjs/units/thumb-batch.test.js
// 前端是 ESM + 无扩展名导入，node 直接 import 不了，这里借 Vite 的 SSR 模块加载器。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..', '..')
const FRONT = path.join(ROOT, 'student-frontend')
const VITE_ENTRY = path.join(FRONT, 'node_modules', 'vite', 'dist', 'node', 'index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 4000, step = 25) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await sleep(step)
  }
}

// 造批量响应：X-Thumb-Ids 给出 id 顺序，body 是「4 字节小端长度 + JPEG 字节」逐张拼接
function batchResponse(pairs, idsHeader) {
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
      'X-Thumb-Ids': idsHeader !== undefined ? idsHeader : pairs.map((p) => p.id).join(','),
    },
  })
}

test('缩略图批量：失败与「服务端没有」必须可区分，且失败可重试', async (t) => {
  // 前端模块依赖浏览器全局：secureChannel 的 safe() 会读 window.__SECURE_CHANNEL__
  globalThis.window = globalThis.window || { __SECURE_CHANNEL__: false }

  const { createServer } = await import(pathToFileURL(VITE_ENTRY).href)
  const server = await createServer({
    root: FRONT,
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  const media = await server.ssrLoadModule('/src/utils/albumMedia.js')
  const { useThumbBatch } = await server.ssrLoadModule('/src/composables/useThumbBatch.js')
  const realFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = realFetch
    await server.close()
  })

  await t.test('网络异常 → null（不是空 Map）', async () => {
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await media.fetchThumbBatch([1, 2]), null)
  })

  await t.test('后端 5xx → null', async () => {
    globalThis.fetch = async () => new Response('boom', { status: 500 })
    assert.equal(await media.fetchThumbBatch([1, 2]), null)
  })

  await t.test('成功但一张也没有 → 空 Map（这才是「服务端确实没有」）', async () => {
    globalThis.fetch = async () => batchResponse([], '')
    const r = await media.fetchThumbBatch([1, 2])
    assert.ok(r instanceof Map, '成功必须是 Map')
    assert.equal(r.size, 0)
  })

  await t.test('成功且两张都在 → Map 两条、值是 Blob', async () => {
    globalThis.fetch = async () => batchResponse([{ id: 1, size: 16 }, { id: 2, size: 16 }])
    const r = await media.fetchThumbBatch([1, 2])
    assert.equal(r.size, 2)
    assert.ok(r.get(1) instanceof Blob)
  })

  await t.test('组合式：首批失败不写任何状态，网络恢复后自己拿到', async () => {
    const visible = [11, 12]
    const batch = useThumbBatch(() => visible)
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
    batch.clear()
  })
})
