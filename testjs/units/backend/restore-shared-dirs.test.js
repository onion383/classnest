// =========================================================================
// restore-shared-dirs.test.js —— 恢复单班备份不覆盖全局共享文件（1-8 / #11）
//
// 原缺陷：备份把 uploads / album-trash / receipt-trash 这些**全局共享**目录
// 打进单班包；恢复时 dirPlanOf 用同样的全局目录作 dest，replaceDir 整体替换，
// 于是恢复 A 班旧备份会让 B 班引用的收据/上传/回收文件凭空消失。
// 修法：共享目录改 merge（同名覆盖、不删包里没有的）；per-slug 目录仍整体替换。
// =========================================================================
const path = require('node:path')
const { abs } = require('#testjs/paths')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { loadMutated } = require('#testjs/units/_mechanism.cjs')

const backendRequire = createRequire(abs('student-backend/package.json'))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-restore-shared-'))
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (_) {} })
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'restore-shared-test-key'
process.env.DATA_DIR = WORK

// ---- 假 dbManager：落点指向 WORK 子目录 ----
const fakeDbManager = {
  dataDir: WORK,
  uploadsDir: path.join(WORK, 'uploads'),
  trashDir: path.join(WORK, 'album-trash'),
  receiptTrashDir: path.join(WORK, 'receipt-trash'),
  skillsDir: (slug) => path.join(WORK, 'ai-skills', slug),
  snapshotsDir: (slug) => path.join(WORK, 'snapshots', slug),
  decryptBundleKey: () => Buffer.from('fake-db-key-32-bytes-long-xxxxx'),
  restoreBundle: (a) => ({ slug: a.slug, username: a.username }),
  writeMemory: () => {},
}
const dbManagerPath = require.resolve(abs('student-backend/dbManager/dbManager.js'))
require.cache[dbManagerPath] = { id: dbManagerPath, filename: dbManagerPath, loaded: true, exports: fakeDbManager }

const { mergeDir, replaceDir } = require('../../../student-backend/services/backupArchive')
const { dirPlanOf } = require('../../../student-backend/services/bundleRestore')
const w = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

// ————————————————————————— ① 行为层：mergeDir —————————————————————————

test('mergeDir：合并共享目录，保留目标是包里没有的文件（B 班数据不丢）', () => {
  const root = path.join(WORK, 'merge-case')
  const src = path.join(root, 'src'); const dest = path.join(root, 'dest')
  // 包里（A 班备份）：一份新收据 + 一张同名文件（要覆盖）
  w(path.join(src, 'receipt-A.pdf'), 'A班新收据')
  w(path.join(src, 'shared.png'), 'new')
  // 目标（本机现有）：B 班的收据 + 同名文件（旧内容）
  w(path.join(dest, 'receipt-B.pdf'), 'B班收据')
  w(path.join(dest, 'shared.png'), 'old')

  const n = mergeDir(src, dest)

  assert.equal(n, 2)
  assert.equal(fs.readFileSync(path.join(dest, 'receipt-B.pdf'), 'utf8'), 'B班收据', '包里没有的 B 班文件必须保留')
  assert.equal(fs.readFileSync(path.join(dest, 'receipt-A.pdf'), 'utf8'), 'A班新收据', 'A 班文件应合入')
  assert.equal(fs.readFileSync(path.join(dest, 'shared.png'), 'utf8'), 'new', '同名文件应被包内版本覆盖')
})

test('mergeDir：递归子目录也合并，不改动无关文件', () => {
  const root = path.join(WORK, 'merge-nested')
  const src = path.join(root, 'src'); const dest = path.join(root, 'dest')
  w(path.join(src, '2026/Jan/a.png'), 'a')
  w(path.join(dest, '2025/Dec/old.png'), 'old')
  mergeDir(src, dest)
  assert.ok(fs.existsSync(path.join(dest, '2026/Jan/a.png')))
  assert.ok(fs.existsSync(path.join(dest, '2025/Dec/old.png')), '子目录里的旧文件不能被删')
})

test('对照：replaceDir 确实会整体替换（证明为何共享目录不能用它）', () => {
  const root = path.join(WORK, 'replace-case')
  const src = path.join(root, 'src'); const dest = path.join(root, 'dest')
  w(path.join(src, 'A.txt'), 'a')
  w(path.join(dest, 'B.txt'), 'b')
  replaceDir(src, dest, 123)
  assert.ok(!fs.existsSync(path.join(dest, 'B.txt')), 'replaceDir 会删掉 B 班文件 —— 这正是 #11 的根因')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('dirPlanOf：三个全局共享目录标 merge，per-slug 目录不标', () => {
  const plan = dirPlanOf('@aaaaaaaaaaaa')
  const byPrefix = Object.fromEntries(plan.map((p) => [p.prefix, p]))
  for (const shared of ['uploads', 'album-trash', 'receipt-trash']) {
    assert.equal(byPrefix[shared].merge, true, `${shared} 是共享目录，必须 merge 不替换`)
  }
  for (const perSlug of ['ai-skills', 'snapshots']) {
    assert.ok(!byPrefix[perSlug].merge, `${perSlug} 按 slug 隔离，应整体替换`)
  }
})

// 注释剥离必须是词法级的（T07-09）：裸 `/\/\/[^\n]*/g` 会把 'http://...' 这类
// 字符串里的 `//` 也当注释删掉，后续正则窗口被错误裁剪 → 漏检。
// 保守做法：先摘块注释，再只摘**行首**的 `//` 注释（字符串里的 `//` 不会在行首）。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '')
}

// 接线判据抽成纯函数，便于把变异后的源码回喂同一判据（T07-02），
// 而不是「变异完只断言副作用、不复跑判据」。
function wiringGuard(source) {
  const src = stripComments(source)
  const sharedMerged = /it\.merge[\s\S]{0,120}mergeDir\(src, it\.dest\)/.test(src)
  const perSlugReplaced = /replaceDir\(src, it\.dest, stamp\)/.test(src)
  return {
    ok: sharedMerged && perSlugReplaced,
    why: sharedMerged ? (perSlugReplaced ? '' : 'per-slug 目录未走 replaceDir') : '共享目录未走 mergeDir',
  }
}

test('applyVerifiedBundle 对共享目录走 merge、对 per-slug 走 replace（接线）', () => {
  const src = fs.readFileSync(abs('student-backend/services/bundleRestore.js'), 'utf8')
  const r = wiringGuard(src)
  assert.ok(r.ok, r.why)
})

test('变异反证：真模块里把 uploads 改成覆盖语义，dirPlanOf 行为必须变', () => {
  const slug = '@aaaaaaaaaaaa'
  const realPlan = Object.fromEntries(dirPlanOf(slug).map((p) => [p.prefix, p]))
  assert.equal(realPlan.uploads.merge, true, '基线必须通过，否则反证无意义')
  // N1-28：不再只改本地字符串副本，而是变异真实模块后调真函数。
  const mutated = loadMutated('student-backend/services/bundleRestore.js', (s) => {
    const out = s.replace("{ prefix: 'uploads', dest: dbManager.uploadsDir, merge: true }",
      "{ prefix: 'uploads', dest: dbManager.uploadsDir, merge: false }")
    if (out === s) throw new Error('变异没匹配到 uploads 的 merge 标记')
    return out
  })
  const mutatedPlan = Object.fromEntries(mutated.dirPlanOf(slug).map((p) => [p.prefix, p]))
  assert.equal(mutatedPlan.uploads.merge, false, '判据假绿：共享目录改覆盖后行为仍不变')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：dirPlanOf 去掉 merge 标记后，接线判据必须失败', () => {
  const plan = dirPlanOf('@x')
  const mutated = plan.map((p) => p.merge ? { prefix: p.prefix, dest: p.dest } : p)
  assert.ok(mutated.every((p) => !p.merge), '变异后不应再有 merge 标记')
  const byPrefix = Object.fromEntries(mutated.map((p) => [p.prefix, p]))
  assert.ok(!byPrefix.uploads.merge, '变异后共享目录失去 merge —— 判据应判失败')
})
