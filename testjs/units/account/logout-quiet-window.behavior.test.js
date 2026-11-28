// =========================================================================
// logout-quiet-window.behavior.test.js —— V10-U02-02：登出静默窗口的真行为用例
//
// 背景：主动登出后，在途请求 401 会被全局处理弹「登录已过期」，把用户的主动动作
// 说成出错。authStorage 用 markLoggingOut / isLoggingOut / clearLoggingOut 做静默窗口，
// setAuth 登录成功立即关窗。原 logout-toast.test.js 只做源码正则钉扎，接线被旁路也绿。
//
// 判据：真跑 authStorage 的静默窗口逻辑（剥掉 userScopedCache import、stub localStorage），
// 断言「标记 → 窗口内为真 → 超时为假 → 清掉为假 → setAuth 自动关窗」；
// 再用 loadMutated 变异反证：删掉 clearLoggingOut() 或反转 isLoggingOut 条件，判据必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { abs } = require('#testjs/paths')

const SRC = abs('student-frontend/src/utils/authStorage.js')
const raw = fs.readFileSync(SRC, 'utf8')

// 剥掉模块级 import（userScopedCache 依赖 vue），只留要测的纯状态逻辑。
// 用 data: URL 加载，避开 ESM 缓存；每次都是新模块，loggedOutAt 从 0 起。
const stripped = raw
  .replace(/^import .*$/gm, '')
  .replace(/\bresetUserScopedCaches\(\)/g, '/* stub: resetUserScopedCaches */')

function fakeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  }
}

async function load(mod) {
  const url = 'data:text/javascript;base64,' + Buffer.from(mod).toString('base64')
  return import(url)
}

async function fresh() {
  globalThis.localStorage = fakeStorage()
  return load(stripped)
}

test('静默窗口真跑：标记 → 窗口内真 → 超时假 → 清掉假', async () => {
  const m = await fresh()
  assert.equal(m.isLoggingOut(), false, '未标记时不在静默窗口')

  m.markLoggingOut()
  assert.equal(m.isLoggingOut(), true, '标记后应处于静默窗口')

  // 15s 窗口：把系统时间往前挪 16s，不真的 sleep
  const realNow = Date.now
  Date.now = () => realNow() + 16000
  try {
    assert.equal(m.isLoggingOut(), false, '超过 15s 窗口必须失效，否则真 401 会被吞')
  } finally { Date.now = realNow }

  m.markLoggingOut()
  m.clearLoggingOut()
  assert.equal(m.isLoggingOut(), false, 'clearLoggingOut 必须立刻关窗')
})

test('setAuth 登录成功自动关窗（真跑）', async () => {
  const m = await fresh()
  m.markLoggingOut()
  assert.equal(m.isLoggingOut(), true)
  m.setAuth('token-x', { name: 'teacher' })
  assert.equal(m.isLoggingOut(), false, 'setAuth 不清窗 → 新会话初期真实 401 被吞')
  assert.equal(m.getToken(), 'token-x', 'setAuth 仍要写入 token')
})

test('变异反证：删掉 setAuth 里的 clearLoggingOut()，判据必须红', async () => {
  const broken = stripped.replace(
    /setToken\(token\)\s*\n\s*setCurrentUser\(user\)\s*\n\s*\/\/ 重新登录成功[^\n]*\n\s*clearLoggingOut\(\)/,
    'setToken(token); setCurrentUser(user) /* mutated: 不清窗 */'
  )
  assert.notEqual(broken, stripped, '变异锚点没匹配上')
  globalThis.localStorage = fakeStorage()
  const m = await load(broken)
  m.markLoggingOut()
  m.setAuth('t', {})
  assert.equal(m.isLoggingOut(), true, '变异后窗口没关 → 原判据确实在防这件事')
})

test('变异反证：isLoggingOut 反转超时判断，判据必须红', async () => {
  const broken = stripped.replace(
    'return loggedOutAt > 0 && Date.now() - loggedOutAt < ms',
    'return loggedOutAt > 0 && Date.now() - loggedOutAt >= ms'
  )
  assert.notEqual(broken, stripped, '变异锚点没匹配上')
  globalThis.localStorage = fakeStorage()
  const m = await load(broken)
  m.markLoggingOut()
  assert.equal(m.isLoggingOut(), false, '变异后窗口内反而不生效 → 原判据确实在防这件事')
})
