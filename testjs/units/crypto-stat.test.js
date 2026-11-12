// =========================================================================
// crypto-stat.test.js —— 安全通道加解密分段计时（v6 性能专题 · 0-3）
//
// 这张卡的验收不是「加密变快」，而是「密码学成本能被归因」：
//   ① 有收集器时追加「名称 耗时/字节数」，没有时完全空转；
//   ② 只结算一次，异常路径重复 end 不会产生两条；
//   ③ 打点写入失败不影响请求；
//   ④ 打点确实挂在原语上，而不是只给首屏那一个调用点单独加。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.join(__dirname, '../../student-frontend')
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
const load = () => import(pathToFileURL(path.join(FRONTEND, 'src/utils/cryptoStat.js')).href)

test('没有收集器时完全空转，返回的函数可安全调用任意次', async () => {
  const { startCryptoStat } = await load()
  const end = startCryptoStat(null, '请求加密')
  assert.equal(typeof end, 'function')
  assert.doesNotThrow(() => { end(123); end() })
  const end2 = startCryptoStat({ phases: null }, '请求加密')
  assert.doesNotThrow(() => end2(1))
})

test('有收集器时追加一条「名称 耗时/字节数」，且只结算一次', async () => {
  const { startCryptoStat } = await load()
  const log = { phases: [] }
  const end = startCryptoStat(log, '响应解密')
  await new Promise((r) => setTimeout(r, 2))
  end(256)
  end(256)
  assert.equal(log.phases.length, 1)
  assert.match(log.phases[0], /^响应解密 \d+ms\/256B$/)
})

test('字节数缺失时只记耗时，不记 undefined', async () => {
  const { startCryptoStat } = await load()
  const log = { phases: [] }
  startCryptoStat(log, '凭据加密')()
  assert.equal(log.phases.length, 1)
  assert.match(log.phases[0], /^凭据加密 \d+ms$/)
})

test('收集器写入抛错时静默，不影响调用方', async () => {
  const { startCryptoStat } = await load()
  const log = {
    get phases() { throw new Error('收集器坏了') },
  }
  assert.doesNotThrow(() => startCryptoStat(log, '请求加密')(10))
})

test('打点挂在原语上：凭据 / 请求 / 响应三段 + 前后端接线', () => {
  const secure = read('src/composables/secureChannel.js')
  assert.match(secure, /startCryptoStat\(perf, '凭据加密'\)/)
  assert.match(secure, /startCryptoStat\(perf, '请求加密'\)/)
  assert.match(secure, /startCryptoStat\(perf, '响应解密'\)/)
  assert.match(secure, /applyAuthHeader\(headers, token, \{ forceToken = false, perf = null \}/)

  const axios = read('src/composables/secureAxios.js')
  assert.match(axios, /encryptBody\(d, config\.__perf\)/, '请求加密必须带首屏分段收集器')
  assert.match(axios, /decryptBody\(d\.d, res\.config && res\.config\.__perf\)/)
  assert.match(axios, /encryptBody\(cfg\.__origData, cfg\.__perf\)/, '重试路径同样要能归因')

  const http = read('src/utils/httpClient.js')
  assert.match(http, /perf: config\.__perf/, '凭据加密段必须拿到请求的收集器')

  const backend = fs.readFileSync(path.join(__dirname, '../../student-backend/services/secureChannel.js'), 'utf8')
  assert.match(backend, /PERF_SECURE/)
  assert.match(backend, /measureCrypto\('seal'/)
  assert.match(backend, /measureCrypto\('open'/)
})
