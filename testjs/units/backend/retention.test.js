// =========================================================================
// retention.test.js —— 账号数据管理（AI 聊天记录 / 历史快照）
//
// 核心判据：**默认永久，系统绝不自己删数据**。
//   1. 空库读策略 = 五类都 forever（含 V9-5-6 新加的 conversations）；
//   2. 坏 JSON / 非法策略值一律退回 forever（不因为脏配置意外开删）；
//   3. 策略写入只接受白名单值，只记偏好、不触发任何删除；
//   4. deleteAll() 只由显式调用触发；autoClean() 默认永久时空操作，选档位后清超期行；
//   5. 占用统计读真实 LENGTH，明细按 id 倒序限量。
// 反证：若把 readPolicy 默认值改成 '7d'，第 1 条必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'retention' })
test.after(() => fx.close())

const retention = require('../../../student-backend/services/retentionStore')

// 相对日期：OLD 恒超期、NEW 恒在 7d 档内。曾用写死 2026-11-20 当「新数据」，
// 跨过该日期+7 天后测试假红（2026-11-27 撞上）——时间炸弹，勿再写死。
const sqlDate = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ')
const OLD = sqlDate(365)
const NEW = sqlDate(2)

function seed() {
  const c = fx.reset()
  c.prepare("INSERT INTO ai_conversations (id, title) VALUES (1, '测试会话')").run()
  c.prepare("INSERT INTO ai_messages (conversation_id, role, content, process_json, attachments_json, created_at) VALUES (1,'user','你好','{}','',?)").run(OLD)
  c.prepare("INSERT INTO ai_messages (conversation_id, role, content, process_json, attachments_json, created_at) VALUES (1,'assistant','回答','{}','',?)").run(NEW)
  c.prepare("INSERT INTO domain_history (domain, week_start, snap_date, payload, created_at) VALUES ('seat','2026-01-05','2026-01-01','{\"seats\":[]}',?)").run(OLD)
  c.prepare("INSERT INTO domain_history (domain, week_start, snap_date, payload, created_at) VALUES ('seat','2026-11-23','2026-11-20','{\"seats\":[1]}',?)").run(NEW)
  return c
}

test('默认策略：五类都是永久（反证锚点）', () => {
  fx.reset()
  assert.deepEqual(retention.readPolicy(), {
    messages: 'forever', history: 'forever', conversations: 'forever',
    albumTrash: 'forever', receiptTrash: 'forever',
  })
})

test('坏配置/非法值一律退回永久，绝不意外开启自动删', () => {
  const c = fx.reset()
  c.prepare("UPDATE ai_settings SET retention_json = ? WHERE id = 1").run('{oops')
  assert.deepEqual(retention.readPolicy(), {
    messages: 'forever', history: 'forever', conversations: 'forever',
    albumTrash: 'forever', receiptTrash: 'forever',
  })
  c.prepare("UPDATE ai_settings SET retention_json = ? WHERE id = 1").run('{"messages":"1d","history":"forever"}')
  assert.equal(retention.readPolicy().messages, 'forever', '白名单外的值必须退回永久')
})

test('写策略只记偏好，不删任何数据', () => {
  const c = seed()
  const before = c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n
  const next = retention.writePolicy({ messages: '7d' })
  assert.equal(next.messages, '7d')
  const after = c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n
  assert.equal(after, before, '只改偏好不能删行')
})

test('占用统计读真实长度；明细按 id 倒序且限量', () => {
  seed()
  const s = retention.stats()
  assert.equal(s.messages.count, 2)
  assert.equal(s.history.count, 2)
  assert.ok(s.messages.bytes > 0 && s.history.bytes > 0)
  const list = retention.list('messages', 1)
  assert.equal(list.length, 1, 'limit 生效')
  assert.equal(list[0].conversationId, 1)
  assert.deepEqual(retention.list('bogus', 10), [], '未知类型返回空')
})

test('删除全部：只删该类，不影响另一类', () => {
  const c = seed()
  const r1 = retention.deleteAll('messages')
  assert.equal(r1.deleted, 2)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 0)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM domain_history').get().n, 2, '删聊天记录不能动历史快照')
  const r2 = retention.deleteAll('history')
  assert.equal(r2.deleted, 2)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM domain_history').get().n, 0)
})

test('预览只读不删；applyNow 按新档位立即清超期', () => {
  const c = seed()
  const before = c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n
  const p = retention.preview({ messages: '7d', history: 'forever' })
  assert.equal(p.messages, 1, '预览应算出 1 条超期')
  assert.equal(p.history, 0, '永久档位预览为 0')
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, before, '预览绝不能删数据')
  const done = retention.applyNow({ messages: '7d', history: 'forever' })
  assert.equal(done.messages, 1)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, before - 1)
})

test('applyNow 两类 SQL 删除同事务（V9-K04-03 防半截清理）', () => {
  const c = seed()
  const src = fs.readFileSync(path.join(__dirname, '../../../student-backend/services/retentionStore.js'), 'utf8')
  const body = src.slice(src.indexOf('function applyNow'), src.indexOf('// 恢复收据'))
  // @pin student-backend/services/retentionStore.js#applyNow
  assert.match(body, /db\.transaction\(\s*\(\)\s*=>\s*\{/, 'applyNow 必须把 SQL 删除包进一个事务')
  // 行为：两类都设超期时同批清掉，且 failed 字段总是回传
  const done = retention.applyNow({ messages: '7d', history: '7d' })
  assert.equal(done.messages, 1)
  assert.equal(done.history, 1)
  assert.equal(done.failed, 0, '失败数必须回传，不能吞掉')
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 1)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM domain_history').get().n, 1)
})

test('自动清理：默认永久时空操作；设了 7 天只删超期行', () => {
  const c = seed()
  // 默认永久：autoClean 不能删任何东西
  const r0 = retention.autoClean('messages')
  assert.equal(r0.deleted, 0)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 2)
  // 设 7 天：1 月旧行被清，11 月的保留
  retention.writePolicy({ messages: '7d' })
  const r1 = retention.autoClean('messages')
  assert.equal(r1.deleted, 1)
  assert.deepEqual(
    c.prepare('SELECT content FROM ai_messages ORDER BY id').all().map(x => x.content),
    ['回答'],
  )
  // 历史快照默认仍是永久，不受影响
  const r2 = retention.autoClean('history')
  assert.equal(r2.deleted, 0)
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM domain_history').get().n, 2)
})

// ---- 回收站（文件目录）----
// 夹具把 DATA_DIR 指到独占临时目录，下面写的文件绝不会进真实数据目录。
function seedTrash() {
  const fs = require('node:fs')
  const path = require('node:path')
  const dirs = [require('../../../student-backend/dbManager/dbManager').trashDir,
                require('../../../student-backend/dbManager/dbManager').receiptTrashDir]
  const names = []
  for (const dir of dirs) {
    // 用例之间清场，只删普通文件（上一个用例留的链接不算）
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) fs.rmSync(path.join(dir, e.name), { force: true })
    }
    const old = path.join(dir, `old-${names.length}.bin`)
    fs.writeFileSync(old, 'x'.repeat(10))
    const t = Date.now() - 30 * 86400000
    fs.utimesSync(old, new Date(t), new Date(t))
    const fresh = path.join(dir, `fresh-${names.length}.bin`)
    fs.writeFileSync(fresh, 'y'.repeat(4))
    names.push({ dir, old, fresh })
  }
  return names
}

test('回收站默认永久：统计读到文件，autoClean 一个都不删', () => {
  const seeded = seedTrash()
  const s = retention.stats()
  assert.equal(s.albumTrash.count, 2, '相册回收站：旧 + 新共 2 个文件')
  assert.equal(s.receiptTrash.count, 2, '收据回收站：旧 + 新共 2 个文件')
  assert.ok(s.albumTrash.bytes >= 14)
  assert.deepEqual(retention.autoClean('albumTrash'), { deleted: 0, days: null }, '文件类无写入路径自动清理')
  assert.deepEqual(retention.autoClean('receiptTrash'), { deleted: 0, days: null })
  for (const x of seeded) {
    assert.ok(require('node:fs').existsSync(x.old) && require('node:fs').existsSync(x.fresh))
  }
})

test('回收站档位：预览只读、确定只删超期、不碰另一类', () => {
  const seeded = seedTrash()
  const p = retention.preview({ messages: 'forever', history: 'forever', albumTrash: '7d', receiptTrash: 'forever' })
  assert.equal(p.albumTrash, 1, '超期的 30 天前文件应被预览到')
  assert.equal(p.receiptTrash, 0, '永久档位预览为 0')
  assert.ok(require('node:fs').existsSync(seeded[0].old), '预览绝不能删文件')

  const done = retention.applyNow({ messages: 'forever', history: 'forever', albumTrash: '7d', receiptTrash: 'forever' })
  assert.equal(done.albumTrash, 1, '只删相册回收站的超期文件')
  assert.ok(!require('node:fs').existsSync(seeded[0].old), '超期文件已删')
  assert.ok(require('node:fs').existsSync(seeded[0].fresh), '新文件必须保留')
  assert.ok(require('node:fs').existsSync(seeded[1].old), '收据回收站不受影响')
})

test('回收站清空：只删文件保留目录，符号链接不跟随不删除', () => {
  const seeded = seedTrash()
  const fs = require('node:fs')
  const path = require('node:path')
  // 目录外的文件：只通过链接可达，删链接不能把它删掉
  const outside = path.join(require('node:os').tmpdir(), `retention-outside-${process.pid}.bin`)
  fs.writeFileSync(outside, 'outside')
  const link = path.join(seeded[0].dir, 'escape.link')
  try { fs.symlinkSync(outside, link) } catch (_) { /* 平台不支持时只测文件删除 */ }
  const linkWorks = fs.existsSync(link)

  const r = retention.deleteAll('albumTrash')
  assert.equal(r.deleted, 2, '两个普通文件被清空')
  assert.equal(retention.stats().albumTrash.count, 0)
  assert.ok(fs.existsSync(seeded[0].dir), '目录本身保留（撤销路径仍需可用）')
  assert.ok(fs.existsSync(seeded[1].old), '只清一类')
  assert.ok(fs.existsSync(outside), '目录外文件不能被删')
  if (linkWorks) assert.ok(fs.existsSync(link), '符号链接不跟随也不删')
  fs.rmSync(outside, { force: true })
  if (linkWorks) fs.rmSync(link, { force: true })
})

// ---- 回收站预览定位与收据恢复 ----
test('预览定位：只认相对 key，../ 与绝对路径与符号链接全拒', () => {
  seedTrash()
  const dbm = require('../../../student-backend/dbManager/dbManager')
  const dir = dbm.receiptTrashDir
  // list 返回带 key 的条目，key 可用于安全定位
  const listed = retention.list('receiptTrash')
  assert.ok(listed.length >= 2)
  assert.ok(listed.every(x => typeof x.key === 'string' && x.key.length > 0), 'list 必须给每条带 key')
  const fresh = listed.find(x => x.name.startsWith('fresh-'))
  assert.ok(retention.findTrashFile('receiptTrash', fresh.key), '合法 key 能定位')

  assert.equal(retention.findTrashFile('receiptTrash', '../db-master.key'), null, '上跳拒绝')
  assert.equal(retention.findTrashFile('receiptTrash', '/etc/passwd'), null, '绝对路径拒绝')
  assert.equal(retention.findTrashFile('receiptTrash', 'sub/../../x'), null, '含 .. 段拒绝')
  assert.equal(retention.findTrashFile('receiptTrash', ''), null, '空 key 拒绝')

  // 符号链接：即便指向目录内的文件也不跟随
  const target = path.join(dir, 'fresh-1.bin')
  const linkName = 'escape-link.bin'
  const link = path.join(dir, linkName)
  try { fs.symlinkSync(target, link) } catch (_) { /* 平台不支持则跳过 */ }
  if (fs.existsSync(link)) {
    assert.equal(retention.findTrashFile('receiptTrash', linkName), null, '符号链接拒绝')
    fs.rmSync(link, { force: true })
  }
})

test('V9-K04-01 相册回收站按 slug 分桶：list 的 key 必须带前缀且能定位', () => {
  const dbm = require('../../../student-backend/dbManager/dbManager')
  const dir = dbm.trashDir // albumTrash 走 dbManager.trashDir，receiptTrash 才走 receiptTrashDir
  // 清场后造两个 slug 桶，各放一个同名文件
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true })
    else if (e.isFile()) fs.rmSync(path.join(dir, e.name), { force: true })
  }
  for (const slug of ['class-a', 'class-b']) {
    const bucket = path.join(dir, slug)
    fs.mkdirSync(bucket, { recursive: true })
    fs.writeFileSync(path.join(bucket, '12_照片.jpg'), slug)
  }
  const listed = retention.list('albumTrash')
  const keys = listed.map(x => x.key).sort()
  assert.deepEqual(keys, ['class-a/12_照片.jpg', 'class-b/12_照片.jpg'], 'key 必须带 slug 前缀，不能只剩文件名')
  for (const item of listed) {
    assert.ok(retention.findTrashFile('albumTrash', item.key), `key=${item.key} 必须能定位到真实文件`)
  }
})

test('V9-K03-02 回收站预览 MIME：svg 不内联返回', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../student-backend/routes/retention.js'), 'utf8')
  const mimeBlock = src.slice(src.indexOf('const MIME = {'), src.indexOf('function mimeOf'))
  assert.doesNotMatch(mimeBlock, /svg\s*:/, '回收站内容不可信，MIME 白名单不得含 image/svg+xml')
  // @pin student-backend/routes/retention.js#mimeOf
  assert.match(src, /application\/octet-stream/, '未知扩展必须回落二进制下载而非内联')
})

test('收据恢复：搬回 uploads 还原原名；同名冲突拒绝；坏归档名拒绝', () => {
  const dbm = require('../../../student-backend/dbManager/dbManager')
  const dir = dbm.receiptTrashDir
  const uploads = dbm.uploadsDir
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile()) fs.rmSync(path.join(dir, f.name), { force: true })
  }
  const archived = '1700000000000-123456-照片.jpg'
  const src = path.join(dir, archived)
  fs.writeFileSync(src, 'receipt-bytes')
  const target = path.join(uploads, '照片.jpg')
  fs.rmSync(target, { force: true }) // 清掉可能的残留

  const ok = retention.restoreReceipt(archived)
  assert.equal(ok.ok, true)
  assert.equal(ok.name, '照片.jpg', '去掉归档前缀还原原名')
  assert.ok(fs.existsSync(target), '文件搬回 uploads')
  assert.ok(!fs.existsSync(src), '回收站里不再有')
  assert.equal(fs.readFileSync(target, 'utf8'), 'receipt-bytes')

  // 同名冲突：再放一份同名归档，目标已存在时拒绝覆盖
  fs.writeFileSync(src, 'another')
  const conflict = retention.restoreReceipt(archived)
  assert.equal(conflict.ok, false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'receipt-bytes', '不能覆盖新文件')

  // 归档名不符合 {stamp}-{rand}-{name} 时拒绝，不猜
  assert.equal(retention.restoreReceipt('random-file.jpg').ok, false)
  fs.rmSync(src, { force: true })
  fs.rmSync(target, { force: true })
})
