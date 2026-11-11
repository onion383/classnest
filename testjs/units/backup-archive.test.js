// =========================================================================
// backup-archive.test.js —— 备份包 v3 的「带全了什么」（v6 · N2-02）
//
// 事故：v2 的整库备份只带库文件 + AI 长期记忆，收据原件/AI 技能/回收站/快照全不在包里。
// 换机恢复出来是个「收据打不开」的库，而且界面不会告诉用户少了什么。
//
// 判据：① 库文件（含 -wal/-shm）、用户目录、AI 记忆都在包内
//       ② manifest 每项的 size/sha256 与实际内容一致（还原端要靠它逐项校验）
//       ③ 缩略图这类派生数据不入包，但必须写进 omitted（不能让用户以为漏了）
//       ④ 条目名仍过 sanitizeEntryName（恶意名字写不出包）
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const yauzl = backendRequire('yauzl')
const { writeBundle } = require('../../student-backend/services/backupArchive')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-v3-'))
const dir = (p) => { const d = path.join(tmp, p); fs.mkdirSync(d, { recursive: true }); return d }

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    const out = []
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      zip.on('error', reject)
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e)
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks) })
            zip.readEntry()
          })
          rs.on('error', reject)
        })
      })
      zip.on('end', () => resolve(out))
      zip.readEntry()
    })
  })
}

test('包里带全了库 + 用户目录 + 记忆，manifest 逐项可校验', async () => {
  // 造一份「数据目录」：uploads 两层、ai-skills、receipt-trash、一个 db 文件
  const uploads = dir('uploads')
  fs.writeFileSync(path.join(uploads, '收据A.pdf'), Buffer.from('%PDF-1.4 假装是收据'))
  fs.mkdirSync(path.join(uploads, '2026'), { recursive: true })
  fs.writeFileSync(path.join(uploads, '2026', '收据B.png'), crypto.randomBytes(4096))
  const skills = dir('ai-skills/@abc')
  fs.writeFileSync(path.join(skills, '习惯.md'), '# 技能')
  const trash = dir('receipt-trash')
  fs.writeFileSync(path.join(trash, '20261111-旧收据.pdf'), 'x')
  const dbDir = dir('db')
  const dbFile = path.join(dbDir, '@abc.db')
  fs.writeFileSync(dbFile, '假库')
  fs.writeFileSync(`${dbFile}-wal`, '假wal')

  const zipPath = path.join(tmp, 'bundle.zip')
  const ws = fs.createWriteStream(zipPath)
  const stats = await writeBundle({
    meta: { version: 3, slug: '@abc' },
    files: [
      { name: 'db/@abc.db', path: dbFile },
      { name: 'db/@abc.db-wal', path: `${dbFile}-wal` },
      { name: 'db/不存在.db', path: path.join(dbDir, 'nope.db') },
    ],
    texts: [{ name: 'memory.md', data: 'AI 长期记忆' }],
    dirs: [
      { prefix: 'uploads', dir: uploads },
      { prefix: 'ai-skills', dir: skills },
      { prefix: 'receipt-trash', dir: trash },
      { prefix: 'snapshots', dir: path.join(tmp, '不存在') },
    ],
  }, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))

  const entries = await readZip(zipPath)
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  for (const want of ['bundle.json', 'manifest.json', 'db/@abc.db', 'db/@abc.db-wal', 'memory.md',
    'uploads/收据A.pdf', 'uploads/2026/收据B.png', 'ai-skills/习恢.md'.replace('恢', '惯'), 'receipt-trash/20261111-旧收据.pdf']) {
    assert.ok(byName.has(want), `包里缺少 ${want}`)
  }
  assert.equal(byName.has('db/不存在.db'), false, '不存在的文件跳过，不能留空条目')

  const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'))
  assert.equal(manifest.version, 3)
  assert.equal(manifest.fileCount, 7, `清单项数不对：${manifest.fileCount}`)
  assert.equal(manifest.fileCount, stats.files)
  assert.equal(manifest.totalBytes, stats.totalBytes)
  assert.ok(manifest.omitted.some((x) => /album-thumbs/.test(x)), '缩略图必须写进 omitted，否则用户以为漏备份了')

  // 逐项核对 sha256 与字节数 —— 还原端就靠这份清单判断「恢复全了没有」
  for (const rec of manifest.files) {
    const buf = byName.get(rec.path)
    assert.ok(buf, `清单里的 ${rec.path} 不在包里`)
    assert.equal(rec.size, buf.length, `${rec.path} 字节数不符`)
    assert.equal(rec.sha256, crypto.createHash('sha256').update(buf).digest('hex'), `${rec.path} sha256 不符`)
  }
})

test('恶意文件名写不出包：条目名仍被净化', async () => {
  const f = path.join(tmp, 'x.txt')
  fs.writeFileSync(f, 'x')
  const zipPath = path.join(tmp, 'evil.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeBundle({ meta: {}, files: [{ name: '../../逃逸.txt', path: f }] }, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  const names = (await readZip(zipPath)).map((e) => e.name)
  assert.ok(names.includes('逃逸.txt'), `期望净化成 逃逸.txt，实际 ${names.join(',')}`)
  assert.ok(!names.some((n) => n.includes('..')), '包内不能出现 .. 段')
})

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ }
})
