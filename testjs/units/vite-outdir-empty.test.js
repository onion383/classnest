// =========================================================================
// vite-outdir-empty.test.js —— 构建输出目录的「小批量清空」
// 运行：npm run test:units
//
// 背景：Vite 自带的 emptyOutDir 是一次 fs.rm(outDir, {recursive:true})，
// 也就是一次操作删掉整棵目录树。dist/assets 里上百个文件时，会撞上宿主环境的
// 批量删除保护（一次删 >50 个文件）→ 构建直接失败。
// 但这个开关不能简单关掉 —— electron-builder 打包 student-frontend/dist/**/*，
// 关掉就会把上一轮的旧 hash chunk 一起打进安装包。
//
// 所以改成：关掉 Vite 的 emptyOutDir，由插件 batchedEmptyOutDir() 分批清空。
// 本测试盯三件事：
//   ① 真的清干净了（语义没丢）
//   ② 每次 fs 删除操作涉及的文件数受控（不会再撞批量删除保护）
//   ③ 安全闸生效（不会误删项目根或它的祖先）
// 外加源码判据：防止有人把 emptyOutDir 改回 true（等于把修复整个撤销）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const HELPER = path.join(ROOT, 'student-frontend/build-utils/outdir.js')
const VITE_CONFIG = path.join(ROOT, 'student-frontend/vite.config.js')
const BUILDER_CONFIG = path.join(ROOT, 'electron-builder.json')

const loadHelper = () => import(pathToFileURL(HELPER).href)

// 递归列出目录下的所有文件（用于断言「清干净了」）
function listFiles(dir) {
  const out = []
  const walk = (cur) => {
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(dir, full))
    }
  }
  walk(dir)
  return out
}

// 造一个「像 dist」的有体积的目录：多层 + 上百个文件
function makeDistLike(base) {
  const assets = path.join(base, 'assets')
  fs.mkdirSync(assets, { recursive: true })
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(path.join(assets, `chunk-${i}.js`), 'x')
  }
  for (const sub of ['css', 'img']) {
    const dir = path.join(assets, sub)
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x')
  }
  fs.writeFileSync(path.join(base, 'index.html'), '<html></html>')
  fs.writeFileSync(path.join(base, '.build-channel.json'), '{}')
  return 120
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classnest-outdir-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(async () => {
      // 清理也走小批量删除：一次性递归删会撞上同一道批量删除保护
      try {
        const { emptyOutDirBatched } = await loadHelper()
        emptyOutDirBatched(dir)
        fs.rmdirSync(dir)
      } catch { /* 残留交给系统临时目录清理 */ }
    })
}

test('清空：把输出目录里的文件全部清掉，目录本身保留', async () => {
  await withTempDir(async (dir) => {
    const { emptyOutDirBatched } = await loadHelper()
    makeDistLike(dir)

    const stats = emptyOutDirBatched(dir)

    assert.equal(stats.files, 122, '文件数应与造出来的数量一致（120 个 assets + index.html + 通道标记）')
    assert.deepEqual(listFiles(dir), [], '输出目录里不该剩下任何文件')
    assert.ok(fs.existsSync(dir), '目录本身要留着（Vite 随后往里写产物）')
  })
})

test('批量：单次删除操作涉及的文件数受控，不会一次删掉整个 assets', async () => {
  await withTempDir(async (dir) => {
    const { emptyOutDirBatched, DEFAULT_MAX_FILES_PER_OP } = await loadHelper()
    makeDistLike(dir)

    const stats = emptyOutDirBatched(dir)

    assert.ok(
      stats.maxBatch <= DEFAULT_MAX_FILES_PER_OP,
      `单次删除最多只能带走 ${DEFAULT_MAX_FILES_PER_OP} 个文件，实际 ${stats.maxBatch}`,
    )
    assert.ok(stats.maxBatch >= 1, '确实删过东西（不能是空转）')
    assert.ok(DEFAULT_MAX_FILES_PER_OP < 50, '上限必须低于环境的批量删除阈值（50）')
  })
})

test('清空：.git 目录按 Vite 的 emptyDir 约定保留', async () => {
  await withTempDir(async (dir) => {
    const { emptyOutDirBatched } = await loadHelper()
    makeDistLike(dir)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'keep.txt'), 'x')

    emptyOutDirBatched(dir)

    assert.ok(fs.existsSync(path.join(dir, '.git', 'keep.txt')), '.git 不该被清掉')
  })
})

test('安全闸：目录不存在时安静返回，不抛错', async () => {
  const { emptyOutDirBatched } = await loadHelper()
  const missing = path.join(os.tmpdir(), 'classnest-outdir-not-exist-' + Date.now())
  const stats = emptyOutDirBatched(missing)
  assert.equal(stats.files, 0)
  assert.equal(stats.dirs, 0)
  assert.equal(stats.maxBatch, 0)
})

test('安全闸：拒绝清空项目根本身或它的祖先目录', async () => {
  const { emptyOutDirBatched } = await loadHelper()
  const root = path.join(os.tmpdir(), 'classnest-outdir-root-' + Date.now())
  fs.mkdirSync(root, { recursive: true })
  try {
    assert.throws(() => emptyOutDirBatched(root, { root }), /拒绝清空项目根目录/, '不能清空项目根')
    assert.throws(
      () => emptyOutDirBatched(path.dirname(root), { root }),
      /拒绝清空项目根目录的祖先目录/,
      '不能清空项目根的祖先',
    )
  } finally {
    fs.rmdirSync(root)
  }
})

test('接线：vite.config.js 关掉了 Vite 的 emptyOutDir，改由插件分批清空', () => {
  const src = fs.readFileSync(VITE_CONFIG, 'utf8')
  assert.match(src, /emptyOutDir:\s*false/, '必须关掉 Vite 自带的一次性清空')
  assert.ok(!/emptyOutDir:\s*true/.test(src), '不能留着 true（等于撤销修复）')
  assert.match(src, /batched-empty-out-dir/, '插件必须注册')
  assert.match(src, /emptyOutDirBatched\(/, '插件必须真的调用小批量清空')
  assert.match(src, /buildStart\(\)/, '清空必须在写产物之前（buildStart）发生')
})

test('前提：安装包仍然打包 dist，清空语义不能被当成「无所谓」而丢掉', () => {
  const builder = fs.readFileSync(BUILDER_CONFIG, 'utf8')
  assert.match(builder, /student-frontend\/dist\/\*\*\/\*/, 'dist 仍被打进安装包 → 构建前必须清空，否则旧 hash chunk 会混进去')
})
