// =========================================================================
// bundle-restore.test.js —— v3 备份包落盘：能测的必须测到，因为它动的是整库 + 全部文件
//
// 事故面（这条链路最怕的四种）：
//   ① 包里没有某个目录 → 把本机那个目录清空（「只含库文件的小包」= 收据全丢）
//   ② 包是坏的 / 缺库文件 → 已经换掉了一半，新旧混在一起
//   ③ 解不出来就把临时目录留在用户数据目录里（GB 级残留）
//   ④ 登录中恢复和新机恢复各写一份落盘逻辑 → 一份改了、另一份没改
//
// 判据：每个用例都断言「失败时本机数据一格没动」，而不只是「报错了」。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-restore-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = WORK

// ---- 假 dbManager：落点全指向 WORK 下的子目录，写库/钥匙解密只记调用 ----
const calls = []
const fakeDbManager = {
  dataDir: WORK,
  uploadsDir: path.join(WORK, 'uploads'),
  trashDir: path.join(WORK, 'album-trash'),
  skillsDir: (slug) => path.join(WORK, 'ai-skills', slug),
  snapshotsDir: (slug) => path.join(WORK, 'snapshots', slug),
  decryptBundleKey: (args) => {
    calls.push({ fn: 'decryptBundleKey', args })
    if (args.password === 'wrong') throw new Error('密码不正确，无法解开备份包')
    return Buffer.from('fake-db-key-32-bytes-long-xxxxx')
  },
  restoreBundle: (args) => {
    calls.push({ fn: 'restoreBundle', args })
    return { slug: args.slug, username: args.username }
  },
  writeMemory: (slug, text) => { calls.push({ fn: 'writeMemory', slug, text }) },
}
const dbManagerPath = require.resolve(path.join(ROOT, 'student-backend/dbManager/dbManager.js'))
require.cache[dbManagerPath] = {
  id: dbManagerPath,
  filename: dbManagerPath,
  loaded: true,
  exports: fakeDbManager,
}

const { writeBundle } = require('../../student-backend/services/backupArchive')
const { receiveAndVerify, applyVerifiedBundle, dropTmp } = require('../../student-backend/services/bundleRestore')

let seq = 0
function dir(name) {
  const p = path.join(WORK, `t${++seq}-${name}`)
  fs.mkdirSync(p, { recursive: true })
  return p
}

// 造一个真 zip：db/ 下放个假库文件，按需附带若干用户目录
async function makeBundle({ slug = '@aaaaaaaaaaaa', username = '张三', encrypted = true, dirs = [] } = {}) {
  const src = dir('src')
  const dbFile = path.join(src, 'x.db')
  fs.writeFileSync(dbFile, '假库内容')
  const plan = {
    meta: { version: 3, slug, username, encrypted, key: 'k' },
    files: [{ name: 'db/x.db', path: dbFile }],
    texts: [{ name: 'memory.md', data: '# 记忆' }],
    dirs: dirs.map((d) => ({ prefix: d.prefix, dir: d.dir })),
  }
  const zipPath = path.join(src, 'bundle.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeBundle(plan, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  return zipPath
}

// 模拟 multer 的落地上传文件
function asUpload(zipPath) {
  const p = dir('upload') + '/file.zip'
  fs.copyFileSync(zipPath, p)
  return { path: p, originalname: 'backup.zip' }
}

async function unpack(zipPath) {
  const recv = await receiveAndVerify(asUpload(zipPath))
  return recv
}

function seed(dirPath, files) {
  fs.mkdirSync(dirPath, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dirPath, name), body)
}

// ---------------------------------------------------------------------------
// ① 正常包：库、目录、记忆全落盘，旧目录进 .bak
// ---------------------------------------------------------------------------
test('正常包：库写入、目录替换、旧内容进 .bak（不删）、memory 覆盖', async () => {
  calls.length = 0
  const up = dir('bundle-uploads')
  seed(up, { '收据A.pdf': '新收据' })
  const zip = await makeBundle({ dirs: [{ prefix: 'uploads', dir: up }] })
  // 本机已有旧收据：恢复后必须能在 .bak 里找回来
  seed(fakeDbManager.uploadsDir, { '旧收据.pdf': '旧内容' })

  const recv = await unpack(zip)
  const out = await applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: {} })

  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '收据A.pdf'), 'utf8'), '新收据')
  assert.ok(!fs.existsSync(path.join(fakeDbManager.uploadsDir, '旧收据.pdf')), '旧目录应被换走')
  const bak = out.dirs.find((d) => d.dir === 'uploads').backup
  assert.equal(fs.readFileSync(path.join(bak, '旧收据.pdf'), 'utf8'), '旧内容', '旧内容必须留在 .bak 里，不能删')

  const restored = calls.find((c) => c.fn === 'restoreBundle')
  assert.ok(restored, '必须调用 restoreBundle 落库')
  assert.equal(restored.args.slug, '@aaaaaaaaaaaa')
  // 2-11 之后：传 srcPath（解包目录里现成的库文件），不再读进内存转 base64
  assert.ok(typeof restored.args.srcPath === 'string', '应传 srcPath 而不是 base64')
  assert.equal(fs.readFileSync(restored.args.srcPath, 'utf8'), '假库内容', '库内容要逐字节带过去')
  assert.equal(restored.args.data, undefined, '不再走 base64 中转（100MB 库会白占约 230MB 堆）')
  assert.ok(restored.args.dbKey, '加密包必须解出库钥匙')
  assert.equal(calls.filter((c) => c.fn === 'writeMemory').length, 1)
  dropTmp(recv.tmpDir, null)
})

// ---------------------------------------------------------------------------
// ② 包里没有这个目录 → 本机那个目录原样保留（最典型的静默数据丢失）
// ---------------------------------------------------------------------------
test('包里没有 uploads → 本机 uploads 原样保留，绝不清空', async () => {
  calls.length = 0
  const zip = await makeBundle({ dirs: [] })
  seed(fakeDbManager.uploadsDir, { '现有的.pdf': '不能丢' })

  const recv = await unpack(zip)
  const out = await applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: {} })

  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '现有的.pdf'), 'utf8'), '不能丢')
  assert.equal(out.dirs.find((d) => d.dir === 'uploads'), undefined, '没内容就不该报告替换过')
  dropTmp(recv.tmpDir, null)
})

test('包里 uploads 是空目录 → 同样不替换（空目录等于没有）', async () => {
  calls.length = 0
  const empty = dir('empty-uploads')
  const zip = await makeBundle({ dirs: [{ prefix: 'uploads', dir: empty }] })
  seed(fakeDbManager.uploadsDir, { '现有的.pdf': '不能丢' })

  const recv = await unpack(zip)
  await applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: {} })

  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '现有的.pdf'), 'utf8'), '不能丢')
  dropTmp(recv.tmpDir, null)
})
// 注：ZIP 本身不保存空目录条目，所以「空目录」在真实包里表现为路径压根不存在，
// `length > 0` 与只判 isDirectory() 在这条用例上是**等价变异**（删掉前者不会变红）。
// 保留 length > 0 是为了手工构造的包（或未来改用别的归档格式）也不清空现有目录。

test('包里没有 memory.md → 不覆盖现有记忆（别把 AI 记忆清空）', async () => {
  calls.length = 0
  const src = dir('no-memory')
  const dbFile = path.join(src, 'x.db')
  fs.writeFileSync(dbFile, '假库内容')
  const zipPath = path.join(src, 'b.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeBundle({
    meta: { version: 3, slug: '@aaaaaaaaaaaa', username: '张三', encrypted: false },
    files: [{ name: 'db/x.db', path: dbFile }],
  }, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))

  const recv = await receiveAndVerify(asUpload(zipPath))
  await applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: {} })
  assert.equal(calls.filter((c) => c.fn === 'writeMemory').length, 0, '包里没有记忆就不该调 writeMemory')
  dropTmp(recv.tmpDir, null)
})

// ---------------------------------------------------------------------------
// ③ 坏包 / 缺库文件：报错，且本机数据一格没动
// ---------------------------------------------------------------------------
test('包里没有 db/ 库文件 → 报错，且一个目录都没替换', async () => {
  calls.length = 0
  const src = dir('no-db')
  const pkgUploads = dir('no-db-package-uploads')
  seed(pkgUploads, { '新.pdf': 'x' })
  const zipPath = path.join(src, 'b.zip')
  const ws = fs.createWriteStream(zipPath)
  // 故意只有 uploads、没有 db/ —— 用来证「先确认库文件存在，再动目录」这个顺序
  await writeBundle({
    meta: { version: 3, slug: '@aaaaaaaaaaaa', username: '张三' },
    texts: [{ name: 'memory.md', data: 'x' }],
    dirs: [{ prefix: 'uploads', dir: pkgUploads }],
  }, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))

  seed(fakeDbManager.uploadsDir, { '现有的.pdf': '不能丢' })

  const recv = await receiveAndVerify(asUpload(zipPath))
  await assert.rejects(
    () => applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: {} }),
    /没有数据库文件/,
  )
  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '现有的.pdf'), 'utf8'), '不能丢')
  assert.ok(!fs.existsSync(path.join(fakeDbManager.uploadsDir, '新.pdf')), '报错前不许替换目录')
  assert.equal(calls.find((c) => c.fn === 'restoreBundle'), undefined, '缺库文件时绝不能先落库')
  dropTmp(recv.tmpDir, null)
})

test('加密包密码错误 → 抛错，库与目录都没动', async () => {
  calls.length = 0
  const up = dir('wrong-pwd-uploads')
  seed(up, { '新.pdf': 'x' })
  const zip = await makeBundle({ dirs: [{ prefix: 'uploads', dir: up }] })
  seed(fakeDbManager.uploadsDir, { '现有的.pdf': '不能丢' })

  const recv = await unpack(zip)
  await assert.rejects(
    () => applyVerifiedBundle({ ...recv, slug: '@aaaaaaaaaaaa', username: '张三', body: { password: 'wrong' } }),
    /密码不正确/,
  )
  assert.equal(calls.find((c) => c.fn === 'restoreBundle'), undefined)
  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '现有的.pdf'), 'utf8'), '不能丢')
  dropTmp(recv.tmpDir, null)
})

test('包里的文件被篡改 → receiveAndVerify 就失败，本机数据不受影响', async () => {
  const zip = await makeBundle({ dirs: [] })
  // 把 zip 尾部改写：中央目录/条目内容坏掉，校验或解压必然失败
  const buf = fs.readFileSync(zip)
  buf[buf.length - 60] = buf[buf.length - 60] ^ 0xff
  const broken = path.join(dir('broken'), 'b.zip')
  fs.writeFileSync(broken, buf)

  seed(fakeDbManager.uploadsDir, { '现有的.pdf': '不能丢' })
  await assert.rejects(() => receiveAndVerify(asUpload(broken)))
  assert.equal(fs.readFileSync(path.join(fakeDbManager.uploadsDir, '现有的.pdf'), 'utf8'), '不能丢')
})

// ---------------------------------------------------------------------------
// ④ 临时目录不留在用户数据目录里
// ---------------------------------------------------------------------------
test('解包失败时临时目录被清掉（不在数据目录留 GB 级残骸）', async () => {
  const broken = path.join(dir('bad'), 'b.zip')
  fs.writeFileSync(broken, 'this is not a zip at all')

  const before = fs.readdirSync(WORK).filter((n) => n.startsWith('.restore-'))
  await assert.rejects(() => receiveAndVerify(asUpload(broken)))
  const after = fs.readdirSync(WORK).filter((n) => n.startsWith('.restore-'))
  assert.equal(after.length, before.length, '.restore-* 临时目录必须清干净')
})

test('dropTmp 同时清临时目录与上传文件，且对 null 不抛', () => {
  const t = dir('drop-tmp')
  const f = path.join(dir('drop-file'), 'x.zip')
  fs.writeFileSync(f, 'x')
  dropTmp(t, f)
  assert.ok(!fs.existsSync(t))
  assert.ok(!fs.existsSync(f))
  assert.doesNotThrow(() => dropTmp(null, null))
})

// ---------------------------------------------------------------------------
// ⑤ 接线：两个恢复入口共用同一份落盘逻辑（这是本文件存在的理由）
// ---------------------------------------------------------------------------
test('接线：两个恢复入口都走 bundleRestore，路由里没有任何自己写库的实现', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/account.js'), 'utf8')
  assert.match(src, /require\('\.\.\/services\/bundleRestore'\)/, '必须引用共享 service')
  assert.equal((src.match(/applyVerifiedBundle\(/g) || []).length, 2, '两个入口各调一次，不能有一处自己实现')
  assert.equal((src.match(/receiveAndVerify\(/g) || []).length, 2, '解包校验也必须是同一个入口')

  // v2 的 /restore 与 /restore-offline 已下线（v6 性能专题 · 2-11：整库 base64 读进内存）。
  // 判据相应收紧：路由层不许再出现任何直接写库的调用，且两个旧入口不能回潮。
  assert.equal((src.match(/dbManager\.restoreBundle\(/g) || []).length, 0,
    '路由里不许自己写库，必须走 bundleRestore service')
  assert.equal(src.indexOf("router.post('/restore',"), -1, 'v2 /restore 已下线，不应回潮')
  assert.equal(src.indexOf("router.post('/restore-offline'"), -1, 'v2 /restore-offline 已下线，不应回潮')
})

test('接线：离线入口在动数据之前卡住 slug 格式与覆盖确认', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/account.js'), 'utf8')
  const at = src.indexOf("router.post('/restore-zip-offline'")
  assert.ok(at > 0, '缺少离线恢复路由')
  const applyAt = src.indexOf('applyVerifiedBundle(', at)
  assert.ok(applyAt > at, '离线入口没有调用落盘')
  const head = src.slice(at, applyAt) // 只看「拿到包之后、动数据之前」这一段

  // bundle.json 在用户手里，可以被改。slug 会被拼进 ai-skills/<slug>、snapshots/<slug>，
  // 所以格式校验必须在落盘之前 —— 不能指望下游 restoreBundle 兜底（那是最后一道）。
  assert.match(head, /\^@\[0-9a-f\]\{12\}\$/, '缺少 slug 格式校验：恶意包里可以写 ../../ 之类')
  assert.match(head, /needConfirm/, '缺少覆盖确认：本机已有同账号时不许静默覆盖')
  assert.match(head, /protect === 1/, '缺少超级隐私拦截：离线恢复等于绕开隐私保护')
})
