// =========================================================================
// login-throttle.test.js —— 登录失败节流与 /accounts 频控（A-2 · F06-01 / N3-02）
//
// 纯函数模块，用显式 now 推时间：不 sleep、不依赖真实时钟。
// 变异反证：把 SOFT/HARD 判断去掉后，下面的锁定断言必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const throttle = require('../../../student-backend/services/loginThrottle')

test('连续失败 5 次进入软锁 30 秒，窗口过期后重新计数', () => {
  throttle._resetForTest()
  const t0 = 1_000_000
  for (let i = 0; i < 4; i++) throttle.failLogin('u', '1.1.1.1', t0)
  assert.equal(throttle.checkLogin('u', '1.1.1.1', t0).ok, true, '4 次时还放行')
  throttle.failLogin('u', '1.1.1.1', t0)
  const locked = throttle.checkLogin('u', '1.1.1.1', t0)
  assert.equal(locked.ok, false, '第 5 次失败后必须锁定')
  assert.ok(locked.retryAfter > 0 && locked.retryAfter <= 30, `软锁时长异常：${locked.retryAfter}`)
  assert.match(locked.error, /频繁/)
  // 锁过期后放行
  assert.equal(throttle.checkLogin('u', '1.1.1.1', t0 + 31_000).ok, true)
  // 15 分钟窗口过期后计数归零（再错一次不应立刻又锁）
  throttle.failLogin('u', '1.1.1.1', t0 + 16 * 60_000)
  assert.equal(throttle.checkLogin('u', '1.1.1.1', t0 + 16 * 60_000).ok, true)
})

test('连续失败 10 次进入硬锁 15 分钟', () => {
  throttle._resetForTest()
  const t0 = 2_000_000
  for (let i = 0; i < 10; i++) throttle.failLogin('v', '2.2.2.2', t0)
  const locked = throttle.checkLogin('v', '2.2.2.2', t0)
  assert.equal(locked.ok, false)
  assert.ok(locked.retryAfter > 60, `硬锁应远长于软锁：${locked.retryAfter}`)
  assert.equal(throttle.checkLogin('v', '2.2.2.2', t0 + 14 * 60_000).ok, false, '14 分钟时仍锁定')
})

test('成功登录清零该账号+IP；其它 IP / 账号不受牵连', () => {
  throttle._resetForTest()
  const t0 = 3_000_000
  for (let i = 0; i < 5; i++) throttle.failLogin('w', '3.3.3.3', t0)
  assert.equal(throttle.checkLogin('w', '3.3.3.3', t0).ok, false)
  assert.equal(throttle.checkLogin('w', '4.4.4.4', t0).ok, true, '换 IP 不继承锁定')
  assert.equal(throttle.checkLogin('other', '3.3.3.3', t0).ok, true, '换账号不继承锁定')
  throttle.resetLogin('w', '3.3.3.3')
  assert.equal(throttle.checkLogin('w', '3.3.3.3', t0).ok, true, '成功登录后必须清零')
})

test('/accounts 按 IP 限 60 次/分钟，换 IP 独立', () => {
  throttle._resetForTest()
  const t0 = 4_000_000
  for (let i = 0; i < throttle.ACCOUNTS_PER_MIN; i++) {
    assert.equal(throttle.checkAccounts('5.5.5.5', t0).ok, true, `第 ${i + 1} 次应放行`)
  }
  const blocked = throttle.checkAccounts('5.5.5.5', t0)
  assert.equal(blocked.ok, false, '第 61 次必须 429')
  assert.ok(blocked.retryAfter > 0)
  assert.equal(throttle.checkAccounts('6.6.6.6', t0).ok, true, '其它 IP 不受影响')
  assert.equal(throttle.checkAccounts('5.5.5.5', t0 + 61_000).ok, true, '窗口过期后恢复')
})
