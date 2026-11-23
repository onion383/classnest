// =========================================================================
// backup-key-scrypt.test.js —— 备份包口令派生必须是有 salt 的 scrypt
//
// 根因：导出备份的库钥匙用单次 SHA-256('bundle:'+密码) 派生，拿到包可离线高速猜口令；
// 同项目的隐私库早已用 scrypt(N=2^17 + 随机 salt + 参数随包)，唯独备份包漏改。
// 产品尚未正式发布，无需兼容旧包：v4 直接换 scrypt，缺 salt 的旧包明确拒绝。
//
// 判据：①真跑 wrap/unwrap 往返（正确口令解出、错误口令失败、换 salt 失败）；
//       ②真跑 decryptBundleKey：缺 salt 拒绝、正确字段解出；
//       ③静态核验导出端接线（salt/params 入 meta、版本 4、无旧 SHA-256 残留）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const BACKEND = path.join(ROOT, 'student-backend')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'backup-scrypt-unit-key'
process.env.DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'backup-scrypt-'))
process.on('exit', () => { try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }) } catch (_) {} })
const base = backendRequire(path.join(BACKEND, 'dbManager/dbManager.base.js'))

const KEY = 'a-very-real-32-byte-database-key-value'
const PWD = '正确口令'

test('scrypt 包裹往返：正确口令解出、错误口令与换 salt 都失败', () => {
  const salt = base.newPrivacySalt()
  const params = base.SCRYPT_PARAMS
  const wrapped = base.wrapKeyByPrivacySecret(KEY, PWD, salt, params)
  assert.equal(base.unwrapKeyByPrivacySecret(wrapped, PWD, salt, params), KEY)
  assert.throws(() => base.unwrapKeyByPrivacySecret(wrapped, '错误口令', salt, params))
  const otherSalt = base.newPrivacySalt()
  assert.notEqual(salt, otherSalt)
  assert.throws(() => base.unwrapKeyByPrivacySecret(wrapped, PWD, otherSalt, params), 'salt 不同必须解不出')
})

test('salt 随机：同一口令两次包裹的 salt 与密文都不同', () => {
  const s1 = base.newPrivacySalt()
  const s2 = base.newPrivacySalt()
  assert.notEqual(s1, s2, 'salt 不能固定，否则彩虹表可复用')
  const w1 = base.wrapKeyByPrivacySecret(KEY, PWD, s1, base.SCRYPT_PARAMS)
  const w2 = base.wrapKeyByPrivacySecret(KEY, PWD, s2, base.SCRYPT_PARAMS)
  assert.notEqual(w1, w2)
})

test('decryptBundleKey：新字段解出；缺 salt 的旧包被拒绝', () => {
  const salt = base.newPrivacySalt()
  const p = base.serializeScryptParams(base.SCRYPT_PARAMS)
  const wrapped = base.wrapKeyByPrivacySecret(KEY, PWD, salt, base.SCRYPT_PARAMS)
  assert.equal(base.decryptBundleKey({
    wrappedByPassword: wrapped, password: PWD, passwordSalt: salt, kdfParamsPassword: p,
  }), KEY)

  // 旧 v3 包只有 wrappedByPassword，没有 salt → 明确拒绝，绝不退回弱 KDF
  assert.throws(() => base.decryptBundleKey({ wrappedByPassword: wrapped, password: PWD }),
    /缺少口令派生盐|旧格式包已不支持/)
})

test('静态：导出端写 salt/params、版本 4；源码无单次 SHA-256 包裹', () => {
  const account = fs.readFileSync(path.join(BACKEND, 'routes/account.js'), 'utf8')
  assert.match(account, /newPrivacySalt\(\)/, '导出必须生成随机 salt')
  assert.match(account, /keyFields\.passwordSalt\s*=/, 'salt 必须写进 keyFields → meta')
  assert.match(account, /keyFields\.kdfParamsPassword\s*=/, '参数必须写进 keyFields → meta')
  assert.match(account, /wrapKeyByPrivacySecret\(bundle\.key/, '必须用 scrypt 包裹库钥匙')
  assert.match(account, /version:\s*4/, '包版本必须升到 4')
  assert.ok(!/wrapKeyBySecret/.test(account), '不许再用旧 SHA-256 包裹')

  const baseSrc = fs.readFileSync(path.join(BACKEND, 'dbManager/dbManager.base.js'), 'utf8')
  const noComments = baseSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!/function deriveBundleWrapKey/.test(noComments), '旧派生函数必须删除')
  assert.ok(!/createHash\('sha256'\)\.update\('bundle:'/.test(noComments), '不许再有单次 SHA-256 口令派生')
  assert.match(noComments, /unwrapKeyByPrivacySecret\(wrappedByPassword/, '恢复端必须用 scrypt 解包')

  const archive = fs.readFileSync(path.join(BACKEND, 'services/backupArchive.js'), 'utf8')
  assert.match(archive, /meta\.version !== 4/, '必须拒收旧版包')

  const restore = fs.readFileSync(path.join(BACKEND, 'services/bundleRestore.js'), 'utf8')
  assert.match(restore, /passwordSalt:\s*meta\.passwordSalt/, '恢复端必须透传 salt')
  assert.match(restore, /kdfParamsPassword:\s*meta\.kdfParamsPassword/, '恢复端必须透传参数')
})
