// =========================================================================
// backup-restore.test.js —— 备份包还原侧（v6 · N2-02 后半）
//
// 还原是整个软件里最危险的操作：它会覆盖当前库。所以判据围绕「什么时候才允许动现有文件」：
//   ① 先解包 + 校验，任何问题（缺项 / 内容被改 / 名字不安全）都在这一步失败，现有文件一个不动
//   ② 校验通过才换目录，旧目录改名成 .bak-<stamp>，不删
//   ③ 接线：handler 里三步的顺序不能反（先校验、再恢复库、最后换目录）
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const { writeBundle, extractAndVerify, replaceDir, isUnsafeName, verifyManifest } = require('../../student-backend/services/backupArchive')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'))
const mk = (p) => { const d = path.join(tmp, p); fs.mkdirSync(d, { recursive: true }); return d }

async function makeBundle() {
  const uploads = mk('src/uploads')
  fs.writeFileSync(path.join(uploads, '收据A.pdf'), '%PDF 假收据')
  const dbDir = mk('src/db')
  const dbFile = path.join(dbDir, '@abc.db')
  fs.writeFileSync(dbFile, Buffer.from('假库内容'))
  const zipPath = path.join(tmp, 'bundle.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeBundle({
    meta: { version: 3, slug: '@abc', encrypted: false, key: null },
    files: [{ name: 'db/@abc.db', path: dbFile }],
    dirs: [{ prefix: 'uploads', dir: uploads }],
  }, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  return zipPath
}

test('正常包：解包 + 校验通过，内容与包一致', async () => {
  const zipPath = await makeBundle()
  const dest = mk('out1')
  const { meta, manifest, entries } = await extractAndVerify(zipPath, dest)
  assert.equal(meta.slug, '@abc')
  assert.equal(manifest.fileCount, 2, '清单应含库文件 + 收据')
  assert.ok(entries >= 4, '解出的条目数应包含 bundle.json / manifest.json')
  assert.equal(fs.readFileSync(path.join(dest, 'uploads/收据A.pdf'), 'utf8'), '%PDF 假收据')
  assert.equal(fs.readFileSync(path.join(dest, 'db/@abc.db'), 'utf8'), '假库内容')
})

const manifestOf = (dest) => JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))

test('内容被篡改（大小变了）：校验失败，且说清哪个文件', async () => {
  const zipPath = await makeBundle()
  const dest = mk('out2')
  await extractAndVerify(zipPath, dest)
  const target = path.join(dest, 'uploads/收据A.pdf')
  fs.writeFileSync(target, Buffer.concat([fs.readFileSync(target), Buffer.from('X')]))
  const problems = await verifyManifest(dest, manifestOf(dest))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /大小不符/)
})

test('sha256 对不上（大小相同）也能查出来', async () => {
  const zipPath = await makeBundle()
  const dest = mk('out4')
  await extractAndVerify(zipPath, dest)
  const target = path.join(dest, 'uploads/收据A.pdf')
  const flipped = Buffer.from(fs.readFileSync(target))
  flipped[0] = flipped[0] === 0x25 ? 0x26 : 0x25 // 改一个字节，长度不变
  fs.writeFileSync(target, flipped)
  const problems = await verifyManifest(dest, manifestOf(dest))
  assert.ok(problems.some((p) => /内容校验失败/.test(p)), `应报内容校验失败，实际 ${problems.join('；')}`)
})

test('缺文件：清单里有、包里没有 → 明确报缺哪个', async () => {
  const zipPath = await makeBundle()
  const dest = mk('out5')
  await extractAndVerify(zipPath, dest)
  fs.rmSync(path.join(dest, 'uploads/收据A.pdf'))
  const problems = await verifyManifest(dest, manifestOf(dest))
  assert.ok(problems.some((p) => /缺少文件/.test(p)))
})

test('不安全的条目名一律判不安全（盘符 / 绝对路径 / .. / 空）', () => {
  for (const bad of ['../x', 'a/../../b', 'C:\\x', '/etc/passwd', 'a/./b', '']) {
    assert.equal(isUnsafeName(bad), true, `应判不安全：${JSON.stringify(bad)}`)
  }
  for (const ok of ['uploads/收据.pdf', 'db/@abc.db', '记忆.md']) {
    assert.equal(isUnsafeName(ok), false, `应判安全：${ok}`)
  }
})

test('换目录：旧目录改名成 .bak，不删数据', () => {
  const live = mk('live/uploads')
  fs.writeFileSync(path.join(live, '旧收据.pdf'), 'old')
  const src = mk('incoming/uploads')
  fs.writeFileSync(path.join(src, '新收据.pdf'), 'new')

  const bak = replaceDir(src, live, 111)
  assert.ok(bak && bak.endsWith('.bak-111'), '旧目录必须留备份路径')
  assert.equal(fs.existsSync(path.join(bak, '旧收据.pdf')), true, '旧数据不能丢')
  assert.equal(fs.readFileSync(path.join(live, '新收据.pdf'), 'utf8'), 'new')
  assert.equal(fs.existsSync(path.join(live, '旧收据.pdf')), false)
})

test('接线：「先校验 → 再恢复库 → 最后换目录」的顺序不能反', () => {
  // 落盘逻辑已下沉到 services/bundleRestore.js（两个恢复入口共用），
  // 所以顺序要在两层分别看：路由里「先 receive 后 apply」，service 里「先写库后换目录」。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const routeSrc = strip(fs.readFileSync(path.join(ROOT, 'student-backend/routes/account.js'), 'utf8'))
  for (const name of ["router.post('/restore-zip'", "router.post('/restore-zip-offline'"]) {
    const at = routeSrc.indexOf(name)
    assert.ok(at > -1, `缺少 ${name}`)
    const verifyAt = routeSrc.indexOf('receiveAndVerify(', at)
    const applyAt = routeSrc.indexOf('applyVerifiedBundle(', at)
    assert.ok(verifyAt > at && applyAt > verifyAt, `${name} 必须先解包校验、再落盘（反了会覆盖完才发现包是坏的）`)
  }

  const svcSrc = strip(fs.readFileSync(path.join(ROOT, 'student-backend/services/bundleRestore.js'), 'utf8'))
  const dbAt = svcSrc.indexOf('dbManager.restoreBundle(')
  const dirAt = svcSrc.indexOf('replaceDir(')
  assert.ok(dbAt > -1 && dirAt > dbAt, '目录替换必须在库恢复之后（库坏了就不该动文件）')
})

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ }
})
