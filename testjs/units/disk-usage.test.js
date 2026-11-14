// =========================================================================
// disk-usage.test.js —— 性能面板「空间管理」的磁盘归账
//
// 分两层：
//   A. classifyEntry（纯函数）：库文件 / 缩略图 / 上传 / 日志 / 其他 的边界
//   B. scanDiskUsage（真扫临时目录）：七类字节数与合计，缩略图目录与日志目录
//      在数据目录之外时补扫、不重复计
//
// 跑法：node --test testjs/units/disk-usage.test.js
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  scanDiskUsage, classifyEntry, logFilePaths, resetAppSizeCache,
} = require('../../electron/main/main.disk-usage')

const SLUG = '@1310e52f7763'

// ---------- A. 归类 ----------
test('classifyEntry：当前账号库（含 -wal/-shm）归「该账号」', () => {
  assert.equal(classifyEntry('@1310e52f7763.db', SLUG), 'currentAccount')
  assert.equal(classifyEntry('@1310e52f7763.db-wal', SLUG), 'currentAccount')
  assert.equal(classifyEntry('@1310e52f7763.db-shm', SLUG), 'currentAccount')
})

test('classifyEntry：其他账号库归「其他账号」，大小写不敏感', () => {
  assert.equal(classifyEntry('@75ecd9191d48.db', SLUG), 'otherAccounts')
  assert.equal(classifyEntry('@75ECD9191D48.db', SLUG), 'otherAccounts')
  // 登录态没给出 slug 时不能把别人的库算到当前账号头上
  assert.equal(classifyEntry('@1310e52f7763.db', ''), 'otherAccounts')
})

test('classifyEntry：缩略图 / 上传 / 日志 / 其他各归各位', () => {
  assert.equal(classifyEntry('album-thumbs', SLUG), 'thumbs')
  // 班费收据等共享用户文件 + 两个回收站，统一归「上传文件」，不再混进「其他」
  assert.equal(classifyEntry('uploads', SLUG), 'uploads')
  assert.equal(classifyEntry('album-trash', SLUG), 'uploads')
  assert.equal(classifyEntry('receipt-trash', SLUG), 'uploads')
  // 日志单独成类，但只认固定文件名，别的 .log 不替他做主
  assert.equal(classifyEntry('backend.log', SLUG), 'logs')
  assert.equal(classifyEntry('desktop-layer.log', SLUG), 'logs')
  assert.equal(classifyEntry('debug.log', SLUG), 'other')
  assert.equal(classifyEntry('index.db', SLUG), 'other')
  // 不是 12 位十六进制的 @ 前缀文件不能被当成账号库
  assert.equal(classifyEntry('@notaslug.db', SLUG), 'other')
})

// ---------- B. 真扫目录 ----------
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes))
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-usage-'))
  const appDir = path.join(root, 'app')
  const dataDir = path.join(root, 'data')
  write(path.join(appDir, 'app.exe'), 100)
  write(path.join(appDir, 'resources', 'app.asar'), 200)
  write(path.join(appDir, 'resources', 'ffmpeg', 'ffmpeg.exe'), 300)

  // v2 分层布局：core / content / cache / logs
  const core = path.join(dataDir, 'core')
  const content = path.join(dataDir, 'content')
  const cache = path.join(dataDir, 'cache')
  const logs = path.join(dataDir, 'logs')
  write(path.join(core, `${SLUG}.db`), 100)
  write(path.join(core, `${SLUG}.db-wal`), 50)
  write(path.join(core, '@75ecd9191d48.db'), 200)
  write(path.join(core, 'index.db'), 10)
  write(path.join(content, 'uploads', 'a.png'), 30)
  write(path.join(content, 'album-trash', SLUG, 'trash.jpg'), 40)
  write(path.join(logs, 'backend.log'), 20)
  write(path.join(cache, 'album-thumbs', SLUG, '1.jpg'), 70)
  return { root, appDir, dataDir, cache, logs }
}

test('scanDiskUsage：七类字节数与合计', async () => {
  resetAppSizeCache()
  const { root, appDir, dataDir, cache } = makeFixture()
  try {
    const u = await scanDiskUsage({
      appDir, dataDir, thumbsDir: path.join(cache, 'album-thumbs'), slug: SLUG,
    })
    assert.equal(u.app, 600, '软件本体应递归包含 resources 子目录')
    assert.equal(u.currentAccount, 150, '当前账号 = 库文件 + wal')
    assert.equal(u.otherAccounts, 200)
    assert.equal(u.uploads, 70, '上传 = uploads 30 + album-trash 40')
    assert.equal(u.thumbs, 70)
    assert.equal(u.logs, 20)
    assert.equal(u.other, 10, '其他只剩 index.db')
    assert.equal(u.total, 600 + 150 + 200 + 70 + 70 + 20 + 10)
    // 各段相加必须等于 total，否则图例占比加起来不是 100%
    assert.equal(
      u.app + u.currentAccount + u.otherAccounts + u.uploads + u.thumbs + u.logs + u.other,
      u.total,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scanDiskUsage：缩略图目录在数据目录之外时单独补扫，且不重复计', async () => {
  resetAppSizeCache()
  const { root, appDir, dataDir } = makeFixture()
  const externalThumbs = path.join(root, 'external-thumbs')
  write(path.join(externalThumbs, SLUG, 'x.jpg'), 500)
  try {
    const u = await scanDiskUsage({
      appDir, dataDir, thumbsDir: externalThumbs, slug: SLUG,
    })
    // cache/album-thumbs（70）仍按名字归「缩略图」，外部目录（500）再补进来
    assert.equal(u.thumbs, 570, '内部残留 + 外部目录都要算，且各算一次')
    assert.equal(u.other, 10, '补扫不能把 uploads/index.db 也吞进其他')
    assert.equal(u.uploads, 70)
    assert.equal(
      u.app + u.currentAccount + u.otherAccounts + u.uploads + u.thumbs + u.logs + u.other, u.total,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scanDiskUsage：数据目录之外的日志单独补算，且同目录不重复计', async () => {
  resetAppSizeCache()
  const { root, appDir, dataDir, logs } = makeFixture()
  // 模拟应用级日志：desktop-layer.log 在 userData 根、startup.log 在 userData/data
  const userData = path.join(root, 'userData')
  write(path.join(userData, 'desktop-layer.log'), 5)
  write(path.join(userData, 'data', 'startup.log'), 7)
  // 非固定名的 .log 不进「日志」
  write(path.join(userData, 'notes.log'), 999)
  try {
    const u = await scanDiskUsage({
      appDir,
      dataDir,
      thumbsDir: path.join(dataDir, 'cache', 'album-thumbs'),
      // logs/ 层已扫过 backend.log；这里故意再传一次 dataDir/logs 验证去重
      logDirs: [logs, path.join(userData, 'data'), userData],
      slug: SLUG,
    })
    assert.equal(u.logs, 20 + 5 + 7, 'logs 层 20 + desktop-layer 5 + startup 7，且不重复')
    assert.equal(u.other, 10, 'notes.log 不在数据目录也不在固定名清单，不计入日志与其他')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('logFilePaths：只列四个固定日志、按目录去重', () => {
  const dataDir = path.resolve(os.tmpdir(), 'x-data')
  const userData = path.resolve(os.tmpdir(), 'x-user')
  const files = logFilePaths(dataDir, [userData, dataDir, userData])
  assert.equal(files.length, 8, '两个目录 × 四个固定日志，重复目录只算一次')
  assert.ok(files.every((f) => ['backend.log', 'inp.log', 'startup.log', 'desktop-layer.log'].includes(path.basename(f))))
  assert.equal(files.filter((f) => f.startsWith(dataDir)).length, 4)
  assert.equal(files.filter((f) => f.startsWith(userData)).length, 4)
})

test('scanDiskUsage：数据目录不存在时给出零结果而不是抛错', async () => {
  resetAppSizeCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-usage-empty-'))
  try {
    const u = await scanDiskUsage({
      appDir: path.join(root, 'nope-app'),
      dataDir: path.join(root, 'nope-data'),
      thumbsDir: path.join(root, 'nope-thumbs'),
      slug: SLUG,
    })
    assert.equal(u.total, 0)
    assert.equal(u.app, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scanDiskUsage：软件本体体积进程内只扫一次（缓存命中后同一目录返回同一值）', async () => {
  resetAppSizeCache()
  const { root, appDir, dataDir } = makeFixture()
  try {
    const first = await scanDiskUsage({ appDir, dataDir, slug: SLUG })
    // 扫描后往安装目录加文件：命中缓存时不应反映新增体积（安装目录运行期不变）
    write(path.join(appDir, 'extra.bin'), 1000)
    const second = await scanDiskUsage({ appDir, dataDir, slug: SLUG })
    assert.equal(second.app, first.app, '同一安装目录第二次应直接取缓存')
    resetAppSizeCache()
    const third = await scanDiskUsage({ appDir, dataDir, slug: SLUG })
    assert.equal(third.app, first.app + 1000, '缓存清掉后应重新扫出新增文件')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
