// =========================================================================
// thumb-purge.test.js —— 「清理图片微缩图」的文件删除逻辑
// 运行：npm run test:units
//
// 这个功能的红线只有一条：**只删缩略图文件，别的一概不动**。
// 索引（album_photos 行、thumb_path、thumb_v）由调用方保证不动，本测试只管文件层：
//   · 该删的（{THUMB_DIR}/{slug}/{id}.jpg、旧扁平结构的 {THUMB_DIR}/{id}.jpg）全部删掉
//   · 不该删的（slug 子目录本身、更深一层的东西）留着
//   · 删不掉的（被占用）计入 failed，不中断其它文件
//   · 目录不存在 / 空目录 → 返回 0，不抛
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { purgeThumbFiles, collectTargets } = require('../../student-backend/services/thumbPurge.js')

// 造一个临时缩略图目录，返回 { root, cleanup }
async function makeRoot(layout) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-purge-'))
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

test('删掉所有账号子目录里的缩略图，并如实回报数量与字节数', async () => {
  const { root, cleanup } = await makeRoot({
    '@1310e52f7763/1.jpg': 'a'.repeat(100),
    '@1310e52f7763/2.jpg': 'b'.repeat(200),
    '@a7c3d91b0e42/1.jpg': 'c'.repeat(300),
  })
  try {
    const out = await purgeThumbFiles(root)
    assert.equal(out.files, 3)
    assert.equal(out.bytes, 600)
    assert.equal(out.failed, 0)
    // 文件真的没了
    assert.deepEqual((await fsp.readdir(path.join(root, '@1310e52f7763'))), [])
  } finally {
    await cleanup()
  }
})

test('账号子目录本身保留（下次生成不用再 mkdir）', async () => {
  const { root, cleanup } = await makeRoot({ '@aaaa/1.jpg': 'x' })
  try {
    await purgeThumbFiles(root)
    const entries = await fsp.readdir(root, { withFileTypes: true })
    assert.equal(entries.length, 1)
    assert.ok(entries[0].isDirectory(), 'slug 子目录不应被删除')
  } finally {
    await cleanup()
  }
})

test('旧扁平结构（根目录直接放 {id}.jpg）也一起清', async () => {
  const { root, cleanup } = await makeRoot({
    '7.jpg': 'a'.repeat(10),
    '@bbbb/8.jpg': 'b'.repeat(20),
  })
  try {
    const out = await purgeThumbFiles(root)
    assert.equal(out.files, 2)
    assert.equal(out.bytes, 30)
    assert.deepEqual((await fsp.readdir(root)).filter((n) => n.endsWith('.jpg')), [])
  } finally {
    await cleanup()
  }
})

test('只清一层：更深的目录不动（不是我们放的东西就别替用户删）', async () => {
  const { root, cleanup } = await makeRoot({
    '@cccc/1.jpg': 'a',
    '@cccc/nested/keep.jpg': 'b',
  })
  try {
    const targets = await collectTargets(root)
    assert.equal(targets.length, 1, `不应收集到嵌套文件，实际：${targets.map((p) => path.relative(root, p)).join(',')}`)
    await purgeThumbFiles(root)
    assert.ok(fs.existsSync(path.join(root, '@cccc/nested/keep.jpg')), '嵌套目录里的文件必须保留')
  } finally {
    await cleanup()
  }
})

test('幂等：清完再清一次返回全 0', async () => {
  const { root, cleanup } = await makeRoot({ '@dddd/1.jpg': 'abc' })
  try {
    const first = await purgeThumbFiles(root)
    assert.equal(first.files, 1)
    const second = await purgeThumbFiles(root)
    assert.deepEqual(second, { files: 0, bytes: 0, failed: 0 })
  } finally {
    await cleanup()
  }
})

test('目录不存在 / 传空 → 返回全 0，不抛（缩略图目录可能还没建）', async () => {
  assert.deepEqual(await purgeThumbFiles(path.join(os.tmpdir(), 'thumb-purge-nonexistent-xyz')), { files: 0, bytes: 0, failed: 0 })
  assert.deepEqual(await purgeThumbFiles(''), { files: 0, bytes: 0, failed: 0 })
  assert.deepEqual(await purgeThumbFiles(null), { files: 0, bytes: 0, failed: 0 })
})

test('删不掉的文件计入 failed（被占用），其它照删不误', async () => {
  const { root, cleanup } = await makeRoot({
    '@eeee/1.jpg': 'a',
    '@eeee/2.jpg': 'b',
  })
  // 用一个目录的 unlink mock 模拟「有一个文件被占用」：不动真实权限，跨平台稳定
  const target = path.join(root, '@eeee', '1.jpg')
  const origUnlink = fsp.unlink
  let blocked = false
  fsp.unlink = async (p) => {
    if (path.resolve(String(p)) === path.resolve(target)) {
      blocked = true
      const err = new Error('EBUSY: resource busy or locked')
      err.code = 'EBUSY'
      throw err
    }
    return origUnlink(p)
  }
  try {
    const out = await purgeThumbFiles(root)
    assert.ok(blocked, 'mock 没命中：被挡的那个文件没被尝试删除')
    assert.equal(out.failed, 1)
    assert.equal(out.files, 1, '另一个文件必须照常删掉')
    assert.ok(fs.existsSync(target), '被占用的文件仍然在')
  } finally {
    fsp.unlink = origUnlink
    await cleanup()
  }
})
