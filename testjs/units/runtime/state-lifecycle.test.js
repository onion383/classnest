// =========================================================================
// state-lifecycle.test.js —— 模块状态 / 用户级重置（v8 审查 B-6）
//
// 覆盖：F04-01+Q2-13（撤销状态换号复位）、K01-01（退出先收子进程）、
//       K01-02（取消保留续扫断点）、F05-02（后端探活结果必须判）、
//       F06-06（活动加载只认最后一次）、F06-08（登录口令清空）、
//       F02-04（推理开关回滚数据模型）、F04-05（保存队列随用户作废）、
//       SUPP-03（翻页失败回退页码）。
// 变异反证：去掉任一登记/守卫，对应断言即红。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


test('F04-01 / Q2-13：useUndo 的跳过名单与撤销状态登记到用户级清理', () => {
  const src = read('student-frontend/src/composables/useUndo.js')
  assert.match(src, /import \{ registerUserScopedReset \} from '\.\.\/utils\/userScopedCache\.js'/)
  const fn = src.slice(src.indexOf('registerUserScopedReset(() => {'), src.indexOf('})', src.indexOf('registerUserScopedReset(() => {')))
  for (const key of ['resetUndoSkips()', 'activeCtx = null', '_lastProbe = { key: \'\', at: 0 }', 'undoState.busy = false']) {
    assert.ok(fn.includes(key), `换号清理缺少 ${key}`)
  }
})

test('K01-01：SIGTERM 先通知扫描子进程再退出', () => {
  const src = read('student-backend/app.js')
  const fn = src.slice(src.indexOf("process.on('SIGTERM'"), src.indexOf("process.on('exit'"))
  assert.match(fn, /require\('\.\/scanWorker'\)\.shutdown\(\)/)
  assert.match(fn, /currentServer\.close\(\(\) => finish\(\)\)/)
})

test('K01-02：扫描取消时保留断点行（三处 persistScanClear 前都有取消守卫）', () => {
  const src = read('student-backend/albumScan.js')
  const guards = src.match(/if \(task\.cancelled\) return;/g) || []
  assert.ok(guards.length >= 3, `三条扫描路径都要判取消，实际 ${guards.length} 处`)
  const clears = src.match(/persistScanClear\(conn, albumId, task\.token\)/g) || []
  assert.ok(clears.length >= 3)
})

test('F05-02：引导收尾必须判 waitBackend 返回值', () => {
  const src = read('student-frontend/src/subwindows/setup/Setup.vue')
  // @pin student-frontend/src/subwindows/setup/Setup.vue#waitBackend
  assert.match(src, /const backendReady = await waitBackend\(\)/)
  assert.match(src, /if \(!backendReady\) \{[\s\S]*?errorMsg\.value = '后端尚未就绪，请稍后重试'/)
})

test('F06-06：活动/倒计时加载只认最后一次', () => {
  const src = read('student-frontend/src/views/ActivitiesView.vue')
  assert.match(src, /const loadAllGuard = createLatest\(\)/)
  const fn = src.slice(src.indexOf('async function loadAll()'), src.indexOf('async function refreshActivities'))
  assert.match(fn, /const token = loadAllGuard\.begin\(\)/)
  assert.match(fn, /if \(!loadAllGuard\.isCurrent\(token\)\) return false/)
})

test('F06-08：登录成功/失败都清空口令', () => {
  const src = read('student-frontend/src/views/Login.vue')
  const fn = src.slice(src.indexOf('function login()'), src.indexOf('function register()'))
  const clears = fn.match(/password\.value = ''/g) || []
  assert.ok(clears.length >= 2, `成功与失败分支都要清空，实际 ${clears.length} 处`)
})

test('F02-04：推理开关失败回滚数据模型，不只回滚 DOM', () => {
  const src = read('student-frontend/src/components/dialogs/AiSettingsDialog.vue')
  const fn = src.slice(src.indexOf('async function toggleReasoning'), src.indexOf('// 添加模型成功后的回调'))
  assert.match(fn, /m\.reasoning = !on/)
})

test('F04-05：桌面挂件保存队列随用户重置，并在执行时复查 appsLoaded', () => {
  const src = read('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')
  const reset = src.slice(src.indexOf('function resetBusinessState()'), src.indexOf('function onAuthChanged()'))
  assert.match(reset, /appsSaveQueue = Promise\.resolve\(\)/)
  const put = src.slice(src.indexOf('const put = () =>'), src.indexOf('appsSaveQueue = appsSaveQueue.catch'))
  assert.match(put, /if \(!appsLoaded\.value\) return undefined/)
})

test('SUPP-03：翻页失败回退页码并恢复加载更多', () => {
  const src = read('student-frontend/src/components/base/SearchDialog.vue')
  const fn = src.slice(src.indexOf('async function fetchRemoteSearch'), src.indexOf('function showMoreRemote'))
  assert.match(fn, /remotePage\.value = Math\.max\(0, remotePage\.value - 1\)/)
  assert.match(fn, /remoteHasMore\.value = true/)
})
