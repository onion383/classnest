// =========================================================================
// logout-toast.test.js —— 主动登出必须是「已退出登录」，不能变成红色「登录已过期」
//
// 事故面：登出那一刻前后会有在途请求（仪表盘刷新、通知中心轮询、媒体凭据续期），
// token 刚被吊销 → 必然 401 → 全局 401 处理弹出「操作失败 · 登录已过期，请重新登录」，
// 把用户主动的动作说成出错，还盖掉了正确的提示。
//
// 判据分两层：
//   ① 静默窗口的开关必须在 authStorage 里，且「重新登录成功」要立刻关掉它
//      （否则新会话初期的真实 401 会被一起吞掉）；
//   ② 两个登出入口（账户弹窗 / 设置页）都要先标记再发请求，并给出「已退出登录」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('authStorage：静默窗口存在，且登录成功会立即解除', () => {
  const src = read('student-frontend/src/utils/authStorage.js')
  assert.match(src, /function markLoggingOut\(/, '缺少「正在主动登出」标记')
  assert.match(src, /function isLoggingOut\(/, '缺少静默窗口查询')
  assert.match(src, /export \{[^}]*markLoggingOut[^}]*isLoggingOut/, '两个函数必须导出')
  // setAuth 里必须关窗口：登录成功还留着窗口 = 新会话头 8 秒的 401 全被吞
  const atSetAuth = src.indexOf('function setAuth(')
  const atClear = src.indexOf('clearLoggingOut()', atSetAuth)
  const atNext = src.indexOf('function clearAuth(', atSetAuth)
  assert.ok(atClear > atSetAuth && (atNext < 0 || atClear < atNext), 'setAuth 里必须调用 clearLoggingOut()')
})

test('全局 401 处理：登出窗口内直接静默，且早于清 token', () => {
  const src = read('student-frontend/src/main.js')
  const atHandler = src.indexOf('onAuthExpired:')
  assert.ok(atHandler > 0, '没找到 onAuthExpired')
  const seg = src.slice(atHandler, src.indexOf('onUnreachable:', atHandler))
  const atQuiet = seg.indexOf('isLoggingOut()')
  const atClearToken = seg.indexOf('clearToken()')
  assert.ok(atQuiet > 0, '登出窗口内必须静默（否则正常登出会弹「登录已过期」）')
  assert.ok(atQuiet < atClearToken, '静默判断必须在清 token 之前')
  assert.match(seg, /return/, '命中窗口要直接 return，不能继续弹提示/跳转')
})

test('两个登出入口：先标记再请求，并提示「已退出登录」', () => {
  for (const rel of [
    'student-frontend/src/components/base/AccountDialog.vue',
    'student-frontend/src/views/SettingsView/SettingsView.data.js',
  ]) {
    const src = read(rel)
    assert.match(src, /markLoggingOut\(\)/, `${rel} 没有标记「正在主动登出」`)
    assert.match(src, /已退出登录/, `${rel} 没有给出「已退出登录」提示`)
    const atMark = src.indexOf('markLoggingOut()')
    const atReq = src.indexOf('AUTH_API.logout')
    assert.ok(atMark > 0 && atReq > 0, `${rel} 缺少标记或登出请求`)
    assert.ok(atMark < atReq, `${rel} 必须先标记再发登出请求（请求本身可能 401）`)
    assert.ok(src.indexOf('已退出登录') > src.indexOf('clearAuth()'), `${rel} 提示应在清登录态之后`)
  }
})
