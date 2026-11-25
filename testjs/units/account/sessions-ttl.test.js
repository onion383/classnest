// =========================================================================
// sessions-ttl.test.js —— 会话名单的活动时间与清理（V5-009）正反用例
//
// 原实现：at 只在 create 时写一次，has() 不刷新 → 持续使用 35 天的会话
// 会在下一次 prune（任意一次登录触发）时被当成弃用会话删掉，用户被强制登出。
// 修复后 at = 最后一次活动时间，并且按 1 小时节流落盘。
//
//   正常：久未活动的会话被 has 命中 → at 刷新
//   正常：节流窗口内重复 has → 不重复刷新（避免每请求写文件）
//   正例：持续活跃 40 天的会话 → 登录触发 prune 后仍保留
//   反例：40 天完全没活动的会话 → prune 清理
//   异常：空 sid / 不存在的 sid → false；损坏记录 → 能判活并修复 at
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')

// 隔离 dataDir：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-sessions-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'sessions-ttl-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写到真实数据目录')

const sessions = require(path.join(BACKEND, 'services', 'sessions'))
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

test('正常：久未活动的会话被 has 命中后 at 刷新为当前时间', () => {
  const oldAt = Date.now() - 10 * DAY
  sessions.__test_insert('active-old', 1, oldAt)
  assert.strictEqual(sessions.has('active-old'), true)
  const rec = sessions.__test_get('active-old')
  assert.strictEqual(typeof rec.at, 'number')
  assert.ok(rec.at > oldAt, 'at 必须被刷新（否则 35 天后会被误清）')
  assert.ok(Math.abs(rec.at - Date.now()) < 5000, `at 应接近当前时间，实际 ${rec.at}`)
  assert.strictEqual(rec.userId, 1, '刷新 at 不能丢掉 userId')
})

test('正常：节流窗口内重复 has 不再写盘（at 保持不变）', () => {
  sessions.__test_insert('active-now', 2, Date.now())
  const before = sessions.__test_get('active-now').at
  assert.strictEqual(sessions.has('active-now'), true)
  assert.strictEqual(sessions.has('active-now'), true)
  assert.strictEqual(sessions.__test_get('active-now').at, before, '1 小时内不应反复刷新 at')
})

test('正例：持续活跃 40 天的会话，登录触发 prune 后仍保留', () => {
  sessions.__test_insert('long-active', 3, Date.now() - 40 * DAY)
  // 模拟「一直在用」：每次请求都会 has，从而刷新 at
  assert.strictEqual(sessions.has('long-active'), true)
  // 此时任意一次登录会触发 prune
  sessions.create(3)
  assert.strictEqual(sessions.has('long-active'), true, '活跃会话不能被当成弃用会话清掉')
})

test('反例：40 天完全没活动的会话会被 prune 清掉', () => {
  sessions.__test_insert('idle-40d', 4, Date.now() - 40 * DAY)
  // 不调用 has，直接登录触发 prune
  sessions.create(4)
  assert.strictEqual(sessions.has('idle-40d'), false, '真正弃用的会话应被清理，否则名单只增不减')
})

test('异常输入：空 / 不存在的 sid 一律 false', () => {
  assert.strictEqual(sessions.has(''), false)
  assert.strictEqual(sessions.has(null), false)
  assert.strictEqual(sessions.has(undefined), false)
  assert.strictEqual(sessions.has('no-such-sid'), false)
})

test('异常数据：损坏的 at 记录仍判活，并被修复成数字', () => {
  sessions.__test_insert('corrupted', 5, 'not-a-number')
  assert.strictEqual(sessions.has('corrupted'), true)
  const rec = sessions.__test_get('corrupted')
  assert.strictEqual(typeof rec.at, 'number', '损坏的 at 应被修复')
  assert.strictEqual(rec.userId, 5)
})

test('revoke 后立即失效（刷新活动时间不能改变吊销语义）', () => {
  sessions.__test_insert('to-revoke', 6, Date.now())
  assert.strictEqual(sessions.has('to-revoke'), true)
  assert.strictEqual(sessions.revoke('to-revoke'), true)
  assert.strictEqual(sessions.has('to-revoke'), false)
})

// 按记录算清理期：登录保持天数改成按账号可配之后（services/authPolicy），
// 同一个名单文件里要同时容纳 6 天的记录与 185 天的记录。用单一常量就会有一半账号算错。
test('按账号算清理期：短天数账号先被清，默认账号不受影响', () => {
  const authPolicy = require(path.join(BACKEND, 'services', 'authPolicy'))
  const base = require(path.join(BACKEND, 'dbManager', 'dbManager.base'))

  // 一个配成 1 天的账号（清理期 = 1+5 = 6 天）与一个没配过的账号（默认 30 天 → 35 天）
  authPolicy.setDays('shortkeeper', 1)
  base.registryUpsert('@short', 'shortkeeper', '', 1)

  sessions.__test_insert('short-idle-7d', 7, Date.now() - 7 * DAY, '@short')
  sessions.__test_insert('default-idle-7d', 8, Date.now() - 7 * DAY)

  sessions.create(9) // 任意一次登录触发 prune

  assert.strictEqual(sessions.has('short-idle-7d'), false, '1 天配置 → 清理期 6 天，7 天没活动应被清掉')
  assert.strictEqual(sessions.has('default-idle-7d'), true, '默认 30 天 → 清理期 35 天，7 天没活动仍应保留')
})

test.after(() => {
  // 只写了 .sessions.json，没有打开的库连接；直接清目录
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})

// 让 node:test 在所有用例结束后再退出，避免残留的模块句柄拖住进程。
// 注意这里锁的是**默认账号**的基线（30+5），不是 prune 实际使用的值 ——
// 实际值是每条记录按自己账号的天数现算，见上一条用例。
test.after(() => {
  assert.ok(sessions.SESSION_TTL_MS === 35 * DAY, '默认账号的清理期基线应为 35 天')
})
