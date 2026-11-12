// =========================================================================
// secure-channel-idle-sweep.test.js —— 安全通道空闲期清扫（v6 性能专题 · 1-5）
//
// 验收点：
//   ① 过期会话会被清掉、未过期的不动（now 可注入，测试直接推进时钟）；
//   ② 清扫定时器幂等、unref（不拖住进程退出）、可停；
//   ③ 接线：只有 initMaster 成功（安全通道真的启用）才启动清扫。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const sc = require(path.join(ROOT, 'student-backend/services/secureChannel.js'))

const MASTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

function clientPub() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return ecdh.getPublicKey().toString('base64')
}

test('过期会话被清掉，未过期的保持不动', () => {
  sc.initMaster(MASTER)
  const { sessionId } = sc.performHandshake(clientPub())
  assert.equal(sc.sessionCount(), 1)

  // 未到期：清完仍在
  sc.cleanupSessions(Date.now())
  assert.equal(sc.sessionCount(), 1)

  // 推进到 TTL 之后：必须被清掉
  sc.cleanupSessions(Date.now() + sc.SESSION_TTL_MS + 1)
  assert.equal(sc.sessionCount(), 0)

  sc.destroySession(sessionId)
})

test('清扫定时器：幂等、unref、可停', () => {
  sc.initMaster(MASTER)
  const a = sc.startIdleSweep(20)
  const b = sc.startIdleSweep(20)
  assert.equal(a, b, '重复启动必须复用同一个定时器')
  assert.equal(typeof a.unref, 'function')
  assert.equal(a.hasRef(), false, 'unref 后不能拖住进程退出')
  assert.doesNotThrow(() => sc.sweepNow())
  sc.stopIdleSweep()
  sc.stopIdleSweep()
  assert.equal(sc.IDLE_SWEEP_MS, 60 * 1000)
})

test('接线：安全通道启用时才启动清扫，请求路径上的清扫保留作兜底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/services/secureChannel.js'), 'utf8')
  assert.match(src, /function initMaster[\s\S]{0,220}startIdleSweep\(\)/, 'initMaster 成功后才启动周期清扫')
  assert.match(src, /setInterval\(\(\) => sweepNow\(\), intervalMs\)/)
  assert.match(src, /\.unref\(\)/)
  // 兜底仍在：握手与凭据校验路径上的清扫不能被删掉
  assert.match(src, /performHandshake[\s\S]{0,1200}cleanupSessions\(\)/, '握手路径上的兜底清扫不能被删掉')
  assert.match(src, /cleanupNonces\(\);\s*\n\s*if \(usedNonces\.has\(n\)\)/)
})
