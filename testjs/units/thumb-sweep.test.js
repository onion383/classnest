// =========================================================================
// thumb-sweep.test.js —— 「回收孤儿微缩图」的对账与删除逻辑
// 运行：npm run test:units
//
// 红线：**只删「确定没人引用」的 jpg**。
//   · 库能打开 → 只删 id 不在 album_photos.id 集合里的
//   · 账号与库都没了（null）→ 整个 slug 目录是孤儿
//   · 库打不开（undefined / 抛错）→ 整个目录跳过，绝不把「读不到」当成「没有」
//   · 默认 apply=false 只读，一个文件都不许删
//   · 临时文件太新不删；非 .jpg 一律不动
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  sweepThumbOrphans, TEMP_MIN_AGE_MS,
} = require('../../student-backend/services/thumbSweep.js')

async function makeRoot(layout) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-sweep-'))
  for (const [rel, content] of Object.entries(layout)) {
    const p = path.join(root, rel)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, content)
  }
  return {
    root,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}
const exists = async (p) => fsp.access(p).then(() => true).catch(() => false)

test('默认只读对账：统计出孤儿，但一个文件都不删', async () => {
  const { root, cleanup } = await makeRoot({
    '@a/1.jpg': 'a'.repeat(100),
    '@a/2.jpg': 'b'.repeat(100),
    '@a/3.jpg': 'c'.repeat(100),
  })
  try {
    const r = await sweepThumbOrphans(root, { getLiveIds: async () => new Set([1, 3]) })
    assert.equal(r.orphans, 1)
    assert.equal(r.bytes, 100)
    assert.equal(r.deleted, 0, 'dryRun 不许删文件')
    assert.ok(await exists(path.join(root, '@a/2.jpg')))
  } finally { await cleanup() }
})

test('apply=true 只删缺索引的那张，正在用的原封不动', async () => {
  const { root, cleanup } = await makeRoot({
    '@a/1.jpg': 'a'.repeat(100),
    '@a/2.jpg': 'b'.repeat(200),
    '@a/3.jpg': 'c'.repeat(300),
    '@b/1.jpg': 'd'.repeat(400),
  })
  try {
    const getLiveIds = async (slug) => slug === '@a' ? new Set([1, 3]) : new Set([1])
    const r = await sweepThumbOrphans(root, { getLiveIds, apply: true })
    assert.equal(r.orphans, 1)
    assert.equal(r.deleted, 1)
    assert.equal(r.freed, 200)
    assert.equal(r.failed, 0)
    assert.equal(await exists(path.join(root, '@a/2.jpg')), false)
    for (const rel of ['@a/1.jpg', '@a/3.jpg', '@b/1.jpg']) {
      assert.ok(await exists(path.join(root, rel)), `${rel} 不该被动`)
    }
  } finally { await cleanup() }
})

test('账号与库文件都没了（null）→ 整个 slug 目录判为孤儿', async () => {
  const { root, cleanup } = await makeRoot({
    '@gone/1.jpg': 'x',
    '@gone/2.jpg': 'y',
    '@alive/1.jpg': 'z',
  })
  try {
    const getLiveIds = async (slug) => slug === '@gone' ? null : new Set([1])
    const r = await sweepThumbOrphans(root, { getLiveIds })
    assert.equal(r.orphans, 2)
    assert.equal(r.slugs.find(s => s.slug === '@gone').reason, '账号已删除')
    const r2 = await sweepThumbOrphans(root, { getLiveIds, apply: true })
    assert.equal(r2.deleted, 2)
    assert.ok(await exists(path.join(root, '@alive/1.jpg')))
  } finally { await cleanup() }
})

test('库打不开（undefined / 抛错）→ 整个目录跳过，不许按空集删光', async () => {
  const { root, cleanup } = await makeRoot({
    '@locked/1.jpg': 'x',
    '@locked/2.jpg': 'y',
    '@broken/1.jpg': 'z',
    '@ok/1.jpg': 'w',
  })
  try {
    const getLiveIds = async (slug) => {
      if (slug === '@locked') return undefined
      if (slug === '@broken') throw new Error('DB_LOCKED')
      return new Set([1])
    }
    const r = await sweepThumbOrphans(root, { getLiveIds, apply: true })
    assert.equal(r.deleted, 0, '隐私库未解锁时删掉任何一张都是灾难')
    assert.equal(r.skipped.length, 2)
    assert.equal(r.orphans, 0)
    for (const rel of ['@locked/1.jpg', '@locked/2.jpg', '@broken/1.jpg', '@ok/1.jpg']) {
      assert.ok(await exists(path.join(root, rel)), `${rel} 必须保留`)
    }
  } finally { await cleanup() }
})

test('genThumb 崩溃残留的临时文件：太新不删、够老才删', async () => {
  const { root, cleanup } = await makeRoot({
    '@a/1.jpg': 'live',
    '@a/7.abc123.jpg': 'crash-leftover',
  })
  try {
    const getLiveIds = async () => new Set([1])
    const fresh = await sweepThumbOrphans(root, { getLiveIds, apply: true, now: Date.now() })
    assert.equal(fresh.orphans, 0, '刚写的临时文件可能正在生成，不能删')
    assert.ok(await exists(path.join(root, '@a/7.abc123.jpg')))

    const stale = await sweepThumbOrphans(root, {
      getLiveIds, apply: true, now: Date.now() + TEMP_MIN_AGE_MS + 1000,
    })
    assert.equal(stale.orphans, 1)
    assert.equal(stale.deleted, 1)
    assert.equal(await exists(path.join(root, '@a/7.abc123.jpg')), false)
    assert.ok(await exists(path.join(root, '@a/1.jpg')))
  } finally { await cleanup() }
})

test('根目录旧扁平结构 jpg 回收，非 jpg 与更深一层目录不动', async () => {
  const { root, cleanup } = await makeRoot({
    '12.jpg': 'legacy',
    'notes.txt': 'not ours',
    '@a/nested/9.jpg': 'deep',
    '@a/1.jpg': 'live',
  })
  try {
    const r = await sweepThumbOrphans(root, { getLiveIds: async () => new Set([1]), apply: true })
    assert.equal(r.legacyRoot, 1)
    assert.equal(r.deleted, 1)
    assert.equal(await exists(path.join(root, '12.jpg')), false)
    for (const rel of ['notes.txt', '@a/nested/9.jpg', '@a/1.jpg']) {
      assert.ok(await exists(path.join(root, rel)), `${rel} 不该被动`)
    }
  } finally { await cleanup() }
})

test('目录不存在 / 幂等：不抛，第二次回收为 0', async () => {
  const { root, cleanup } = await makeRoot({ '@a/9.jpg': 'orphan' })
  try {
    const getLiveIds = async () => new Set([1])
    const first = await sweepThumbOrphans(root, { getLiveIds, apply: true })
    assert.equal(first.deleted, 1)
    const second = await sweepThumbOrphans(root, { getLiveIds, apply: true })
    assert.equal(second.orphans, 0)
    assert.equal(second.deleted, 0)
    const missing = await sweepThumbOrphans(path.join(root, 'no-such-dir'), { getLiveIds })
    assert.equal(missing.orphans, 0)
  } finally { await cleanup() }
})
