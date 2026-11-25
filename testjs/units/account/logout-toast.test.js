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
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


test('authStorage：静默窗口存在，且登录成功会立即解除', () => {
  const src = read('student-frontend/src/utils/authStorage.js')
  // @pin student-frontend/src/utils/authStorage.js#markLoggingOut
  assert.match(src, /function markLoggingOut\(/, '缺少「正在主动登出」标记')
  // @pin student-frontend/src/utils/authStorage.js#isLoggingOut
  assert.match(src, /function isLoggingOut\(/, '缺少静默窗口查询')
  // @pin student-frontend/src/utils/authStorage.js#markLoggingOut
  assert.match(src, /export \{[^}]*markLoggingOut[^}]*isLoggingOut/, '两个函数必须导出')
  // setAuth 里必须关窗口：登录成功还留着窗口 = 新会话头 8 秒的 401 全被吞
  const atSetAuth = src.indexOf('function setAuth(')
  const atClear = src.indexOf('clearLoggingOut()', atSetAuth)
  const atNext = src.indexOf('function clearAuth(', atSetAuth)
  assert.ok(atClear > atSetAuth && (atNext < 0 || atClear < atNext), 'setAuth 里必须调用 clearLoggingOut()')
})

test('全局 401 处理：登出窗口内直接静默，且早于清登录态', () => {
  const src = read('student-frontend/src/main.js')
  const atHandler = src.indexOf('onAuthExpired:')
  assert.ok(atHandler > 0, '没找到 onAuthExpired')
  const seg = src.slice(atHandler, src.indexOf('onUnreachable:', atHandler))
  const atQuiet = seg.indexOf('isLoggingOut()')
  // 清登录态可能是 clearToken()（只清 token）或 clearAuth()（连用户与用户级缓存一起清，
  // 401 路径自 v7 §5-2 起用后者）。判据只要求「清」发生在静默判断之后，不钉具体函数。
  const candidates = [seg.indexOf('clearToken()'), seg.indexOf('clearAuth()')].filter((i) => i >= 0)
  assert.ok(candidates.length > 0, '401 处理里没有清登录态（clearToken / clearAuth）')
  const atClearToken = Math.min(...candidates)
  assert.ok(atQuiet > 0, '登出窗口内必须静默（否则正常登出会弹「登录已过期」）')
  assert.ok(atQuiet < atClearToken, '静默判断必须在清登录态之前')
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
    // 先锚定「清登录态」确实存在，再比顺序：缺失时 indexOf 返回 -1 会让顺序断言恒真（T06-02）
    const atClear = src.indexOf('clearAuth()')
    assert.ok(atClear >= 0, `${rel} 登出入口没有 clearAuth()，无法确认清登录态发生在提示之前`)
    assert.ok(src.indexOf('已退出登录') > atClear, `${rel} 提示应在清登录态之后`)
  }
})
