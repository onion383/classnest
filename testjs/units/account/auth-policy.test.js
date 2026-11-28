// =========================================================================
// auth-policy.test.js —— 登录保持天数（按账号）的正反用例
//
// 这套配置在**每一个鉴权请求**的路径上（签发 / 续期 / 名单清理都读它），
// 所以三类错都必须被这条测试挡住：
//   1. 默认值错 → 老用户升级后行为突变（本来 30 天，变成别的）
//   2. 按账号隔离失效 → 改 A 的设置在 B 上生效（键用错维度：dbSlug vs username）
//   3. 派生值不自洽 → 续签窗口 ≥ 天数（每请求都续签）或 名单 TTL ≤ token 寿命
//      （活跃用户被踢下线，V5-009 的同一类错误）
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')

// 隔离 dataDir：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-auth-policy-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'auth-policy-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写到真实数据目录')

const authPolicy = require(path.join(BACKEND, 'services', 'authPolicy'))
// registryUpsert 只在 base 里（门面没转发），与 albumScan.test.js 同一用法：
// 单测直接借 base 往 index.db 登记几行，不走完整的建库流程
const base = require(path.join(BACKEND, 'dbManager', 'dbManager.base'))
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

test('默认：没配置过的账号一律 30 天（与改动前行为一致）', () => {
  assert.strictEqual(authPolicy.DEFAULT_DAYS, 30)
  assert.strictEqual(authPolicy.daysFor('never-configured'), 30)
  assert.strictEqual(authPolicy.daysFor(null), 30, '缺账号名（老 token）不能抛错，走默认')
  assert.strictEqual(authPolicy.daysFor(''), 30)
})

test('正常：写入后读回同值，且签发参数跟着变', () => {
  assert.strictEqual(authPolicy.setDays('alice', 7), 7)
  assert.strictEqual(authPolicy.daysFor('alice'), 7)
  assert.deepStrictEqual(authPolicy.signOptsFor('alice'), { expiresIn: '7d' })
  assert.strictEqual(authPolicy.mediaTtlFor('alice'), '7d')
})

test('按账号隔离：改一个账号不影响另一个', () => {
  authPolicy.setDays('bob', 90)
  assert.strictEqual(authPolicy.daysFor('bob'), 90)
  assert.strictEqual(authPolicy.daysFor('alice'), 7, 'alice 不能被 bob 的设置带跑')
})

test('归一：越界 / 非数字一律退回默认，不抛错也不落盘', () => {
  assert.strictEqual(authPolicy.normalizeDays(9999), 30)
  assert.strictEqual(authPolicy.normalizeDays(0), 30)
  assert.strictEqual(authPolicy.normalizeDays(-5), 30)
  assert.strictEqual(authPolicy.normalizeDays('abc'), 30)
  assert.strictEqual(authPolicy.normalizeDays(undefined), 30)
  // 边界值本身合法
  assert.strictEqual(authPolicy.normalizeDays(1), 1)
  assert.strictEqual(authPolicy.normalizeDays(365), 365)
  // 小数四舍五入到整数天
  assert.strictEqual(authPolicy.normalizeDays(15.4), 15)

  // setDays 返回的是**实际生效**值：界面据此显示，不会出现「选 999 显示 999」
  assert.strictEqual(authPolicy.setDays('carol', 9999), 30)
  assert.strictEqual(authPolicy.daysFor('carol'), 30)
})

test('派生：续签窗口 = 天数/4，且永远小于天数（否则每请求都续签）', () => {
  authPolicy.setDays('dave', 30)
  assert.strictEqual(authPolicy.slideWindowMs('dave'), 7.5 * DAY, '30 天 → 7.5 天，与改动前的 7 天基本一致')

  // 逐个档位验证窗口严格小于 token 寿命 —— 相等就退化成「每个请求都续签」
  for (const days of [1, 7, 15, 30, 90, 180, 365]) {
    authPolicy.setDays('edge', days)
    assert.ok(
      authPolicy.slideWindowMs('edge') < days * DAY,
      `${days} 天的续签窗口必须小于 ${days} 天（实际 ${authPolicy.slideWindowMs('edge') / DAY} 天）`
    )
  }

  // 下限 1 小时：1 天 → 6 小时，本来就不会触发下限，这里只锁住「不会变成 0」
  authPolicy.setDays('edge', 1)
  assert.ok(authPolicy.slideWindowMs('edge') >= HOUR)
})

test('派生：名单清理期严格大于 token 寿命（否则活跃用户被踢下线）', () => {
  for (const days of [1, 7, 30, 90, 365]) {
    authPolicy.setDays('edge', days)
    assert.strictEqual(authPolicy.sessionTtlMs('edge'), (days + 5) * DAY)
    assert.ok(
      authPolicy.sessionTtlMs('edge') > days * DAY,
      `${days} 天：名单清理期必须比 token 长，否则名单先清掉 = 强制登出`
    )
  }
  // 预筛用的最短清理期 = 1 天配置对应的 6 天
  assert.strictEqual(authPolicy.MIN_SESSION_TTL_MS, 6 * DAY)
})

test('改名：配置跟着账号名搬过去，旧键不残留', () => {
  authPolicy.setDays('old-name', 180)
  assert.strictEqual(authPolicy.renameKey('old-name', 'new-name'), true)
  assert.strictEqual(authPolicy.daysFor('new-name'), 180, '改名后不能退回默认 30 天')
  assert.strictEqual(authPolicy.daysFor('old-name'), 30, '旧名不能继续留着配置')

  // 没有配置的账号改名：无事发生，不报错
  assert.strictEqual(authPolicy.renameKey('no-such-account', 'whatever'), false)
  assert.strictEqual(authPolicy.renameKey('new-name', 'new-name'), false)
})

test('落盘：配置写进 core/.auth-policy.json，重启（重新加载）后还在', () => {
  authPolicy.setDays('persisted', 15)
  const raw = fs.readFileSync(dbManager.authPolicyPath, 'utf8')
  const obj = JSON.parse(raw)
  assert.strictEqual(obj.persisted.days, 15)
  assert.ok(obj.persisted.updatedAt > 0, '记录更新时间，便于排查「设置什么时候被改的」')
})

test('异常数据：文件损坏时按默认策略处理，不让所有人登不进去', () => {
  const p = dbManager.authPolicyPath
  const backup = fs.readFileSync(p, 'utf8')
  try {
    fs.writeFileSync(p, '{ this is not json', 'utf8')
    // 清缓存重新读盘，模拟「重启后读到坏文件」的那一刻
    authPolicy.__test_reload()
    assert.strictEqual(authPolicy.daysFor('anyone'), 30, '坏文件必须退回默认 30 天，而不是抛错 500')
    assert.deepStrictEqual(authPolicy.signOptsFor('alice'), { expiresIn: '30d' })
  } finally {
    fs.writeFileSync(p, backup, 'utf8')
    authPolicy.__test_reload()
  }
  // 恢复后原配置仍在（坏文件没有把好数据覆盖掉）
  assert.strictEqual(authPolicy.daysFor('alice'), 7)
})

test('按班级 slug 反查：未知 slug 退回默认；登记过的走账号配置', () => {
  // 未登记的 slug（班级已删/库损坏）
  assert.strictEqual(authPolicy.daysForSlug('no-such-slug'), 30)
  assert.strictEqual(authPolicy.daysForSlug(null), 30)

  // 登记一个班给 erin，再看按 slug 取到的天数
  authPolicy.setDays('erin', 90)
  base.registryUpsert('@erin-class1', 'erin', '', 1)
  assert.strictEqual(authPolicy.daysForSlug('@erin-class1'), 90)
  assert.strictEqual(authPolicy.sessionTtlMsForSlug('@erin-class1'), 95 * DAY)

  // 同一个账号的第二个班：天数跟着账号走，而不是跟着班走（切班不应改变设置）
  base.registryUpsert('@erin-class2', 'erin', '', 1)
  assert.strictEqual(authPolicy.daysForSlug('@erin-class2'), 90, '一个账号多个班必须共用同一套天数')
})

test('V10-K04-01：策略文件原子写——失败时原文件不动，不整体回退默认', () => {
  const file = dbManager.authPolicyPath
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ atomic_keep: { days: 120, updatedAt: 1 } }), { encoding: 'utf8', mode: 0o600 })
  const original = fs.readFileSync(file, 'utf8')

  // 假 fs：writeFileSync 成功写到 tmp，renameSync 抛错（模拟掉电/占用）
  let wroteTmp = ''
  const failing = {
    writeFileSync: (p, data) => { if (String(p).endsWith('.tmp')) wroteTmp = data },
    renameSync: () => { throw new Error(' simulated rename failure') },
    unlinkSync: () => {},
  }
  // console.warn 会打到测试输出，临时静音
  const realWarn = console.warn
  console.warn = () => {}
  try { authPolicy.__test_save(failing) } finally { console.warn = realWarn }

  assert.ok(wroteTmp, '必须先写临时文件')
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'rename 失败时原文件必须保持完整，不能被半截 JSON 覆盖')
  assert.equal(authPolicy.daysFor('atomic_keep'), 30, '缓存里仍是本次内存值（120 天不应被读回）')

  // 正常路径：真 save 用 rename，内容可解析且保留原账号
  authPolicy.__test_reload()
  assert.equal(authPolicy.daysFor('atomic_keep'), 120, '原文件完整就能读回 120 天')
})

test.after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})
