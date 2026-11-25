// =========================================================================
// auth-expired-clears-user.test.js —— 401 失效必须换「人」，不能只丢 token（v7 §5-2）
//
// 原来的 onAuthExpired 只调 clearToken()：localStorage 里的 token 没了，
// 但 currentUser 与用户级模块缓存（开学日、仪表盘快照……）原封不动，
// 用户作用域代次也没有 +1。后果有两层：
//   · 在途请求拿到 401 之前发出的响应，回来时仍被判断为「属于当前用户」，写回缓存；
//   · 更严重的是下一个登录的人：setAuth 不换代次，别人的缓存会被当成自己的数据。
// 路由守卫与登出入口早就走的 clearAuth()（v4 B11-13），401 这一路是漏的。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = require('#testjs/paths').FE
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
const urlOf = (rel) => pathToFileURL(path.join(FRONTEND, rel)).href

// 取源码里 onAuthExpired 的回调体（从 `onAuthExpired:` 到下一个顶层选项 `onUnreachable:`）
function authExpiredBlock(src) {
  const start = src.indexOf('onAuthExpired:')
  assert.ok(start > 0, 'main.js 里找不到 onAuthExpired 接线')
  const end = src.indexOf('onUnreachable:', start)
  assert.ok(end > start, 'onAuthExpired 之后应紧跟 onUnreachable（选项顺序变了，本判据需同步）')
  return src.slice(start, end)
}

test('§5-2 接线：main.js 的 401 处理走 clearAuth，不再只清 token', () => {
  const block = authExpiredBlock(readSrc('src/main.js'))
  assert.match(block, /clearAuth\(\)/, '401 必须调用 clearAuth()：连 currentUser 与用户级缓存一起作废、代次 +1')
  assert.doesNotMatch(block, /\bclearToken\(\)/, '不能只清 token —— 这正是本卡要修的行为')
  assert.match(block, /clearMediaToken\(\)/, '媒体凭据与登录同 sid，401 时也要清（否则死 token 继续拼进图片 URL）')
})

test('§5-2 一致性：路由守卫与登出入口同样用 clearAuth（三个入口同一口径）', () => {
  assert.match(readSrc('src/router/index.js'), /clearAuth\(\)/, '路由守卫遇到过期 token 应走 clearAuth')
  assert.match(readSrc('src/components/base/AccountDialog.vue'), /clearAuth\(\)/, '登出入口应走 clearAuth')
})

test('§5-2 行为：clearAuth 清 token + 用户 + 用户级缓存，并让代次 +1', async () => {
  // authStorage 在函数体内访问 localStorage，测试里注入一个内存实现即可
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
  }
  const cache = await import(urlOf('src/utils/userScopedCache.js'))
  const auth = await import(urlOf('src/utils/authStorage.js'))

  let resetCalls = 0
  cache.registerUserScopedReset(() => { resetCalls++ })

  auth.setAuth('tok-abc', { id: 7, name: '甲' })
  assert.equal(auth.getToken(), 'tok-abc')
  assert.equal(auth.getCurrentUser().name, '甲')
  const gen0 = cache.userScopedGeneration()

  auth.clearAuth()

  assert.equal(auth.getToken(), '', 'token 必须清掉')
  assert.equal(auth.getCurrentUser(), null, 'currentUser 必须清掉（否则下一个人会看到上一个人的身份）')
  assert.equal(cache.userScopedGeneration(), gen0 + 1, '换人必须让用户作用域代次 +1（在途请求靠它判断归属）')
  assert.ok(resetCalls > 0, '登记过的用户级缓存必须被清（开学日 / 仪表盘快照等）')
})

test('§5-2 对照：只调 clearToken 不足以作废旧身份（证明这条判据有区分力）', async () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
  }
  const cache = await import(urlOf('src/utils/userScopedCache.js'))
  const auth = await import(urlOf('src/utils/authStorage.js'))

  auth.setAuth('tok-xyz', { id: 9, name: '乙' })
  const gen0 = cache.userScopedGeneration()

  auth.clearToken()  // 旧实现

  assert.equal(auth.getToken(), '', 'token 确实没了')
  assert.notEqual(auth.getCurrentUser(), null, '但身份还在 —— 这正是 401 路径原来的状态')
  assert.equal(cache.userScopedGeneration(), gen0, '代次也没动，在途响应仍会被认成当前用户')
})
