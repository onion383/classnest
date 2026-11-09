// =========================================================================
// db-master-key.test.js —— DB 主密钥 safeStorage 异步化（Electron 46 适配）的行为断言
//
// 背景：45 把 safeStorage 同步 API 标为 deprecated、46 移除。同步版靠「先查缓存再赋值」
// 天然幂等；改异步后若不加单飞，启动 fork 与后端自动重连可能各生成一把新钥匙，
// 后者写回 db-master.key 会让原有加密库再也打不开。这是本轮最高风险的路径。
//
// 手法：跑真实 electron/main/main.config.js，只把 require('electron') 换成替身。
// 替身**故意不提供**任何同步方法 —— 若产品代码还调用同步 API，会 TypeError 走进兜底，
// 加密调用计数对不上即判失败（能区分「改了」与「没改」，不是复现逻辑的假绿）。
//
// 运行：npm run test:units -- --only=db-master-key
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const CONFIG = path.join(ROOT, 'electron/main/main.config.js')
const BACKEND = path.join(ROOT, 'electron/main/main.backend.js')
const ENTRY = path.join(ROOT, 'electron/main/main.js')
const PREFIX = 'enc:'
const electronId = require.resolve('electron')
const configId = require.resolve(CONFIG)
const HEX64 = /^[0-9a-f]{64}$/i
const tempDirs = []

// 每个用例独立 userData + 独立模块实例（dbMasterKey 是模块级缓存，不清会串用例）
function loadConfig(opts = {}) {
  let userData = opts.userData
  if (!userData) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'classnest-dbmaster-'))
    tempDirs.push(userData)
  }
  const state = {
    availCalls: 0,
    encCalls: 0,
    decCalls: 0,
    available: opts.available !== false,
    shouldReEncrypt: !!opts.shouldReEncrypt,
    decryptThrows: !!opts.decryptThrows,
    decryptResult: opts.decryptResult,
  }
  const fakeElectron = {
    app: { getPath: () => userData, getAppPath: () => ROOT },
    safeStorage: {
      isAsyncEncryptionAvailable: async () => { state.availCalls++; return state.available },
      encryptStringAsync: async (s) => { state.encCalls++; return Buffer.from(PREFIX + s, 'utf8') },
      decryptStringAsync: async (blob) => {
        state.decCalls++
        if (state.decryptThrows) throw new Error('模拟 DPAPI 解密失败')
        if (state.decryptResult !== undefined) return state.decryptResult
        const raw = blob.toString('utf8')
        return {
          result: raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : '',
          shouldReEncrypt: state.shouldReEncrypt,
        }
      },
    },
  }
  const prev = require.cache[electronId]
  require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: fakeElectron }
  delete require.cache[configId]
  let mod
  try {
    mod = require(configId)
  } finally {
    if (prev) require.cache[electronId] = prev
    else delete require.cache[electronId]
  }
  return { mod, state, userData, keyFile: path.join(userData, 'data', 'db-master.key') }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const syncCallPat = /safeStorage\s*\.\s*(isEncryptionAvailable|encryptString|decryptString)\s*\(/g

test.after(() => {
  // 每个用例都建了独立 userData，跑完必须清掉，别把临时密钥目录泄漏到系统 temp
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* 句柄延迟 */ }
  }
  delete require.cache[configId]
  delete require.cache[electronId]
})

test('首启：只用异步 API 生成并加密写盘 64 位 hex 主密钥', async () => {
  const { mod, state, keyFile } = loadConfig()
  const key = await mod.getDbMasterKey()
  assert.match(key, HEX64)
  assert.equal(state.availCalls, 1, 'isAsyncEncryptionAvailable 应只查一次')
  assert.equal(state.encCalls, 1, '应经 encryptStringAsync 写盘')
  assert.equal(state.decCalls, 0)
  assert.ok(fs.existsSync(keyFile), '密文文件应落盘')
  assert.equal(fs.readFileSync(keyFile, 'utf8'), PREFIX + key)
})

test('二次加载：解密旧密文复用同一把钥匙，不重新生成', async () => {
  const first = loadConfig()
  const key1 = await first.mod.getDbMasterKey()
  const second = loadConfig({ userData: first.userData })
  const key2 = await second.mod.getDbMasterKey()
  assert.equal(key2, key1, '换钥匙会让已有加密库打不开')
  assert.equal(second.state.decCalls, 1)
  assert.equal(second.state.encCalls, 0, '已有密文时不应重新加密')
})

test('并发：多个调用共用单飞 Promise，只解析一次、同一把钥匙', async () => {
  const { mod, state } = loadConfig()
  const [a, b, c] = await Promise.all([
    mod.getDbMasterKey(),
    mod.getDbMasterKey(),
    mod.getDbMasterKey(),
  ])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.match(a, HEX64)
  assert.equal(state.availCalls, 1, '并发不应重复初始化')
  assert.equal(state.encCalls, 1, '并发不应写出第二把钥匙')
  assert.equal(await mod.getDbMasterKey(), a, '解析完成后应命中缓存')
  assert.equal(state.availCalls, 1)
})

test('shouldReEncrypt：明文不变，先备份再用新密文写回', async () => {
  const first = loadConfig()
  const key1 = await first.mod.getDbMasterKey()
  const original = fs.readFileSync(first.keyFile, 'utf8')

  const second = loadConfig({ userData: first.userData, shouldReEncrypt: true })
  const key2 = await second.mod.getDbMasterKey()
  assert.equal(key2, key1, '密钥轮换不得改变主密钥明文')
  assert.equal(second.state.encCalls, 1, '应重新加密一次')
  const backups = fs.readdirSync(path.dirname(first.keyFile)).filter((n) => n.startsWith('db-master.key.bak-'))
  assert.equal(backups.length, 1, '覆盖前应留一份备份')
  assert.equal(fs.readFileSync(path.join(path.dirname(first.keyFile), backups[0]), 'utf8'), original)
  assert.equal(fs.readFileSync(first.keyFile, 'utf8'), PREFIX + key1, '写回的密文仍应解出同一把钥匙')
})

test('解密失败：备份成功则重新生成并写盘；备份失败则只用运行期随机值、绝不覆盖原密文', async () => {
  const first = loadConfig()
  await first.mod.getDbMasterKey()
  const original = fs.readFileSync(first.keyFile, 'utf8')

  const okBackup = loadConfig({ userData: first.userData, decryptThrows: true })
  const regenerated = await okBackup.mod.getDbMasterKey()
  assert.match(regenerated, HEX64)
  assert.notEqual(regenerated, original.slice(PREFIX.length))
  const backups = fs.readdirSync(path.dirname(first.keyFile)).filter((n) => n.startsWith('db-master.key.bak-'))
  assert.ok(backups.length >= 1, '重新生成前必须备份旧密文')

  // 备份也失败：本次只能用运行期随机值，文件一个字节都不许动。
  // 注意此时 keyFile 已是上一子场景「备份成功→重新生成」写出的新密文，故以调用前快照为准。
  const before = fs.readFileSync(first.keyFile, 'utf8')
  const realCopy = fs.copyFileSync
  fs.copyFileSync = () => { throw new Error('模拟备份失败') }
  try {
    const badBackup = loadConfig({ userData: first.userData, decryptThrows: true })
    const fallback = await badBackup.mod.getDbMasterKey()
    assert.match(fallback, HEX64)
    assert.equal(badBackup.state.encCalls, 0, '走兜底时不应写盘')
    assert.equal(fs.readFileSync(first.keyFile, 'utf8'), before, '本次调用前后密文必须原样保留')
  } finally {
    fs.copyFileSync = realCopy
  }
})

test('异步解密返回空结果：当失败处理，绝不返回空密钥', async () => {
  const first = loadConfig()
  await first.mod.getDbMasterKey()
  const bad = loadConfig({ userData: first.userData, decryptResult: { result: '', shouldReEncrypt: false } })
  const key = await bad.mod.getDbMasterKey()
  assert.match(key, HEX64, '空值必须走重新生成，不能拿空串去 fork 后端')
})

test('safeStorage 不可用：返回运行期随机值、不落明文文件', async () => {
  const { mod, state, keyFile } = loadConfig({ available: false })
  const key = await mod.getDbMasterKey()
  assert.match(key, HEX64)
  assert.equal(state.encCalls, 0)
  assert.equal(fs.existsSync(keyFile), false)
})

test('静态对账：产品代码零同步调用；fork 两条分支都用预取的 dbKey；入口有预热', () => {
  const configSrc = stripComments(fs.readFileSync(CONFIG, 'utf8'))
  assert.equal((configSrc.match(syncCallPat) || []).length, 0, '同步 API 在 46 会移除，不许残留')
  assert.ok(/await safeStorage\.isAsyncEncryptionAvailable\(\)/.test(configSrc))
  assert.ok(/await safeStorage\.decryptStringAsync\(/.test(configSrc))
  assert.ok(/await safeStorage\.encryptStringAsync\(/.test(configSrc))

  const backendSrc = stripComments(fs.readFileSync(BACKEND, 'utf8'))
  assert.ok(/async function compileBackendProcess\(\)/.test(backendSrc), 'fork 前必须能 await 主密钥')
  assert.ok(/const dbKey = await getDbMasterKey\(\)/.test(backendSrc))
  assert.equal((backendSrc.match(/DB_MASTER_KEY: dbKey/g) || []).length, 2, 'dev 与打包两条分支都要改')
  assert.equal((backendSrc.match(/DB_MASTER_KEY: getDbMasterKey\(\)/g) || []).length, 0)

  const entrySrc = stripComments(fs.readFileSync(ENTRY, 'utf8'))
  assert.ok(/void getDbMasterKey\(\)/.test(entrySrc), 'ready 后应与建窗并行预热，别等 fork 才解析')
})
