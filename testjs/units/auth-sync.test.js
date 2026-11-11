// =========================================================================
// auth-sync.test.js —— 跨窗口登录态同步（v6 · 2-3b 缺口）
//
// 背景：各窗口共享一份 localStorage，但各有独立 JS 上下文。主窗口登出/换号时，
// 其它窗口只收到一条 storage 事件。这段判定过去被抄在两个子窗口入口里：
//   · 桌面组件按 userId|dbSlug|sid 判身份（续期不清缓存，V5-044）；
//   · 工具箱只看 key 就 reset —— 滑动续期也会清掉它的用户级缓存；
//   · 主窗口没有监听 —— 别的窗口换号时代次不 +1，在途请求还能把旧数据写回缓存。
//
// 这里验证统一后的 authSync：
//   · 续期（同一身份换 token）→ 只让窗口重读 token，不清缓存、不广播；
//   · 登出/换号 → 先清缓存（代次 +1）再广播，顺序不能反；
//   · 三个窗口入口都走同一个 installAuthSync，不再各自解析 JWT。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.join(__dirname, '../../student-frontend')
const urlOf = (rel) => pathToFileURL(path.join(FRONTEND, rel)).href
const readSrc = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

// 造一个合法 JWT（只关心 payload，签名段随意）：解码走的是真实 utils/jwt.js
function jwt(payload) {
  return 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s'
}
const TOKEN_A = jwt({ userId: 1, dbSlug: 'class-a', sid: 'sid-a' })
const TOKEN_A2 = jwt({ userId: 1, dbSlug: 'class-a', sid: 'sid-a', exp: 1 }) // 同一会话，仅续期
const TOKEN_B = jwt({ userId: 2, dbSlug: 'class-b', sid: 'sid-b' })

// 假 window：只实现 storage 监听与事件派发，并可手动触发事件
function makeTarget() {
  const listeners = new Set()
  const events = []
  return {
    addEventListener(type, fn) { if (type === 'storage') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'storage') listeners.delete(fn) },
    dispatchEvent(ev) { events.push(ev); return true },
    fire(ev) { for (const fn of [...listeners]) fn(ev) },
    events,
    get listenerCount() { return listeners.size },
  }
}

let authSync
test.before(async () => {
  authSync = await import(urlOf('src/utils/authSync.js'))
})

test('authIdentity：账号 + 库 + 会话三项组成身份，空/坏 token 视为未登录', () => {
  assert.equal(authSync.authIdentity(TOKEN_A), '1|class-a|sid-a')
  assert.equal(authSync.authIdentity(TOKEN_B), '2|class-b|sid-b')
  assert.equal(authSync.authIdentity(''), '')
  assert.equal(authSync.authIdentity(null), '')
  assert.equal(authSync.authIdentity('not-a-jwt'), '')
})

test('滑动续期：同一身份换 token 不清缓存、不广播，只通知窗口重读 token', () => {
  const target = makeTarget()
  const calls = []
  authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => calls.push('reset'),
    notify: () => calls.push('notify'),
    onTokenChanged: (t) => calls.push('token:' + t),
    onIdentityChanged: (x) => calls.push('identity:' + x.next),
  })

  target.fire({ key: 'token', newValue: TOKEN_A2 })

  assert.deepEqual(calls, ['token:' + TOKEN_A2], '续期既不能清缓存，也不能广播登出事件')
})

test('换号：先清缓存（代次 +1）再广播，最后才通知业务组件', () => {
  const target = makeTarget()
  const calls = []
  const changes = []
  authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => calls.push('reset'),
    notify: () => calls.push('notify'),
    onTokenChanged: () => calls.push('token'),
    onIdentityChanged: (x) => { calls.push('identity'); changes.push(x) },
  })

  target.fire({ key: 'token', newValue: TOKEN_B })

  // 顺序固定：组件若在代次递增前重拉，结果会被判成「旧代次响应」而丢弃
  assert.deepEqual(calls, ['token', 'reset', 'notify', 'identity'])
  assert.deepEqual(changes, [{ previous: '1|class-a|sid-a', next: '2|class-b|sid-b' }])
})

test('登出：token 被移除（newValue=null）也要清缓存并广播', () => {
  const target = makeTarget()
  const calls = []
  authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => calls.push('reset'),
    notify: () => calls.push('notify'),
  })

  target.fire({ key: 'token', newValue: null })

  assert.deepEqual(calls, ['reset', 'notify'])
})

test('无关键与空事件：主题等 app-* 键不得触发登录态清理', () => {
  const target = makeTarget()
  const calls = []
  authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => calls.push('reset'),
    notify: () => calls.push('notify'),
    onTokenChanged: () => calls.push('token'),
  })

  target.fire({ key: 'app-theme', newValue: 'glass' })
  target.fire({ key: null, newValue: null })
  target.fire({})
  target.fire(null)

  assert.deepEqual(calls, [])
})

test('卸载函数移除监听：重复安装不会叠加多份', () => {
  const target = makeTarget()
  let resets = 0
  const dispose = authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => { resets += 1 },
    notify: () => {},
  })
  assert.equal(target.listenerCount, 1)

  dispose()
  assert.equal(target.listenerCount, 0)
  target.fire({ key: 'token', newValue: TOKEN_B })
  assert.equal(resets, 0, '卸载后不得再响应跨窗口登录态变化')
})

test('接线：三个窗口入口都走 installAuthSync，且不再各自实现判定', () => {
  const main = readSrc('src/main.js')
  const widget = readSrc('src/subwindows/widget/main.js')
  const desktop = readSrc('src/subwindows/desktop-widget/main.js')

  for (const [name, src] of [['主窗口', main], ['工具箱', widget], ['桌面组件', desktop]]) {
    assert.match(src, /installAuthSync\(/, `${name}入口必须安装跨窗口登录态监听`)
  }

  // 旧的各写一份必须消失：工具箱曾只看 key 就 reset（续期也会误清）
  assert.doesNotMatch(widget, /resetUserScopedCaches\s*\(/, '工具箱不应再自己清缓存')
  assert.doesNotMatch(desktop, /function authIdentity|resetUserScopedCaches\s*\(/,
    '桌面组件不应再自己解析 JWT 比对身份')
})

test('事件名同源：notify 广播的 AUTH_CHANGED_EVENT 来自 authStorage', async () => {
  const storage = await import(urlOf('src/utils/authStorage.js'))
  const target = makeTarget()
  authSync.createAuthSync({
    target,
    readToken: () => TOKEN_A,
    resetCaches: () => {},
  })

  target.fire({ key: 'token', newValue: TOKEN_B })
  assert.equal(target.events.length, 1, '换号应广播一次')
  assert.equal(target.events[0].type, storage.AUTH_CHANGED_EVENT,
    '广播事件名必须与组件监听的一致，否则清数据永远不触发')
})
