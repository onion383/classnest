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
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

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

test('后端：媒体凭据只放行静态资源，业务 API 必须拒绝', async () => {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-media-'))
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'media-credential-test-key'
  process.env.DATA_DIR = DATA_DIR
  try {
    const auth = require(path.join(ROOT, 'student-backend/middleware/auth.js'))
    const sessions = require(path.join(ROOT, 'student-backend/services/sessions.js'))
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
