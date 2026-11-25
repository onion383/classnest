// =========================================================================
// media-credential.test.js —— 静态资源凭据（V5-005）正反用例
//
// 背景：生产打包版页面是 file://，向 http://localhost:3000 取图属于跨站请求，
// SameSite=Lax 的 httpOnly Cookie 不会随 <img> 发送。明文模式原先「只靠 Cookie」，
// 背景图/相册图会在打包版里 401。修复后两种模式都用 scope=media 的受限凭据。
//
//   正例：resourceUrl 在任何模式下都追加 ?token=
//   反例：不得退回「明文模式裸 URL」的旧分支
//   后端：媒体凭据在 authStatic / 媒体路径合法，在业务 API 上必须被拒
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')


test('前端：resourceUrl 两种模式都追加媒体凭据，不再按 safe() 短路', () => {
  const src = read('student-frontend/src/utils/apiUrl.js')
  const fn = src.slice(src.indexOf('export function resourceUrl'))
  assert.ok(!/if \(!safe\(\)\) return url/.test(fn), '不允许保留「明文模式返回裸 URL」的旧分支')
  assert.ok(/localStorage\.getItem\(MEDIA_KEY\)/.test(fn), '必须读取媒体凭据')
  assert.ok(/token=\$\{encodeURIComponent\(token\)\}/.test(fn), '必须把凭据拼进查询串')
})

test('前端：明文模式也能刷新媒体凭据', () => {
  const src = read('student-frontend/src/utils/apiUrl.js')
  const fn = src.slice(src.indexOf('export function refreshMediaToken'), src.indexOf('export async function ensureMediaToken'))
  assert.ok(!/\|\| !safe\(\)/.test(fn), '明文模式下媒体凭据过期也必须能续（否则图片永久 401）')
  assert.ok(/getToken\(\)/.test(fn), '仍应以登录 token 作为刷新前提')
})

test('前端：媒体凭据登记进用户级清理表，clearAuth 一条链必清（F05-01 / N3-14）', () => {
  const src = read('student-frontend/src/utils/apiUrl.js')
  // @pin student-frontend/src/utils/apiUrl.js#apiUrl
  assert.ok(/import \{[^}]*registerUserScopedReset[^}]*\} from '\.\/userScopedCache\.js'/.test(src),
    'apiUrl 必须引入 registerUserScopedReset')
  // @pin student-frontend/src/utils/apiUrl.js#clearMediaToken
  assert.ok(/registerUserScopedReset\(clearMediaToken\)/.test(src),
    '媒体凭据必须登记到用户级清理表，否则路由守卫等新入口还会漏清')
  const auth = read('student-frontend/src/utils/authStorage.js')
  assert.ok(/function clearAuth\(\)[\s\S]*?resetUserScopedCaches\(\)/.test(auth),
    'clearAuth 必须调用 resetUserScopedCaches（登记表才会被触发）')
})

test('后端：凭证变更（改密/删号）联动撤销该班 MCP token（N3-04）', () => {
  const src = read('student-backend/services/credentialChange.js')
  // @pin student-backend/services/credentialChange.js#revokeAccountSessions
  assert.ok(/require\('\.\/mcpTokenStore'\)\.revokeBySlug\(s\)/.test(src),
    'revokeAccountSessions 必须联动 mcpTokenStore.revokeBySlug')
  const store = read('student-backend/services/mcpTokenStore.js')
  assert.ok(/function revokeBySlug\(slug\)/.test(store))
  assert.ok(/x\.slug !== slug \|\| x\.revoked_at/.test(store), '只撤销该班且未撤销的令牌')
  assert.ok(/module\.exports = \{[^}]*revokeBySlug/.test(store), '必须导出 revokeBySlug')
})

test('后端：媒体凭据只放行静态资源，业务 API 必须拒绝', async () => {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-media-'))
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'media-credential-test-key'
  process.env.DATA_DIR = DATA_DIR
  try {
    const auth = require(abs('student-backend/middleware/auth.js'))
    const sessions = require(abs('student-backend/services/sessions.js'))
    const sid = sessions.create(1)
    const mediaToken = auth.signMediaToken({ userId: 1, username: 'u', role: 'teacher', dbSlug: 'slug', sid })

    // 正例：静态资源路径允许 media
    const okUser = auth.verifyToken(mediaToken, { allowMedia: true })
    assert.strictEqual(okUser.scope, 'media')

    // 反例：业务 API 上 media 凭据必须被拒
    assert.throws(() => auth.verifyToken(mediaToken, { allowMedia: false }), /媒体凭据不可用于此接口/)

    // 反例：会话被吊销后，媒体凭据同时失效
    sessions.revoke(sid)
    assert.throws(() => auth.verifyToken(mediaToken, { allowMedia: true }), /会话已失效/)

    // 后端接线：authStatic（/api/background、/uploads）必须 allowMedia:true
    const mw = read('student-backend/middleware/auth.js')
    const staticFn = mw.slice(mw.indexOf('function authStatic'))
    assert.ok(/verifyToken\(token, \{ allowMedia: true \}\)/.test(staticFn), 'authStatic 必须接受媒体凭据，否则背景图无法加载')
  } finally {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* 句柄延迟 */ }
  }
})
