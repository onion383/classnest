// =========================================================================
// lifecycle-dispose-probe.cjs —— 「资源必须随作用域释放」的回归探针
//
// 背景（v4 审查 P2 · 批 11/12）：
//   一类共同 bug：**资源创建处与销毁处不相邻**，靠人脑记住配对，于是漏一处就永久泄漏。
//   本项目原先 onScopeDispose 全库零使用、onBeforeUnmount 与 onUnmounted 两种钩子混用，
//   没有任何统一表达。典型漏点：
//     · SearchDialog：关弹窗后 debounce 定时器照跑、白白发一次搜索，在途请求也不中止
//     · Note.vue：拖拽途中卸载 → document 上的 mousemove/mouseup 永久残留
//     · Note.vue：截屏/保存是异步链，卸载后仍写 ref、仍 emit
//     · Migration.vue：完成后 700ms 的 dismiss 定时器，卸载后仍发 IPC
//     · DesktopWidget.vue：调试监听器写成匿名函数 → 结构上就不可能被移除
//     · useRowFocus：定位重试是定时器链，没人能取消
//     · 用户作用域：模块级缓存（信道会话、网格预览的学生名映射）不随登出失效
//
// 这个探针做什么：
//   静态断言「该走底座的资源确实走了底座」，让「又写回裸 setTimeout / 匿名监听器」
//   变成可检测的失败，而不是靠人记得。
//
// ⚠️ 判据只卡**已迁移过的那些点**，不是全库扫 setTimeout —— 全库扫会把
//   「一次性、不需要清理」的合理写法（Promise 里的 sleep 等）也报出来。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'student-frontend', 'src')

let failures = 0
function assert(cond, msg, okMsg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  } else {
    console.log('  ✓ ' + (okMsg || msg))
  }
}

// 去注释版：用于「不应出现某写法」这类判据——
// 注释里残留的字符串会让判据假绿（2026-11-04 反向验证时踩到）。
function readCode(rel) {
  return stripComments(read(rel))
}

function read(rel) {
  const p = path.join(SRC, rel)
  if (!fs.existsSync(p)) {
    failures++
    console.error(`  ✗ 文件不存在：${rel}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

// 取出某个函数体内的一小段（按大括号配平），用来只看「注册点所在的那段代码」
// 注意：函数签名里的默认值可能有花括号（如 { tries = 25 } = {}），
// 所以先跳过括号内的花括号，只取**括号深度为 0** 的那个才是函数体。
function bodyOf(src, anchor) {
  const i = src.indexOf(anchor)
  if (i < 0) return ''
  let paren = 0
  let open = -1
  for (let k = i + anchor.length - 1; k < src.length; k++) {
    const c = src[k]
    if (c === '(' || c === '[') paren++
    else if (c === ')' || c === ']') paren--
    else if (c === '{' && paren === 0) { open = k; break }
    else if (c === ';' && paren === 0) return ''
  }
  if (open < 0) return ''
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') {
      depth--
      if (depth === 0) return src.slice(open, k + 1)
    }
  }
  return ''
}

// 去掉注释后再判断（注释里提到某个 API 名不等于在用它）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

console.log('\n【1】底座本身')
{
  const src = readCode('utils/disposables.js')
  assert(src.length > 0, 'utils/disposables.js 必须存在（这是本批的根因修复载体）')
  assert(/export function createDisposables\(\)/.test(src), '底座必须导出 createDisposables()')
  assert(/export function useDisposables\(\)/.test(src), '底座必须导出 useDisposables()')
  assert(/onScopeDispose\(/.test(src), 'useDisposables 必须用 onScopeDispose 挂到作用域上')
  // 红线：不得引入组件实例代理 API（注释里提到名字不算在用）
  const code = stripComments(src)
  assert(!/getCurrentInstance\s*\(/.test(code) && !/inst\.proxy/.test(code) && !/\$refs\b/.test(code) && !/\$el\b/.test(code),
    '底座不得使用组件实例代理（本项目已全库清零），只能用作用域 API')
}

console.log('\n【2】SearchDialog：关闭弹窗必须撤掉定时器并中止在途请求')
{
  const src = readCode('components/base/SearchDialog.vue')
  assert(/useDisposables\(\)/.test(src), 'SearchDialog 必须使用 disposables 底座')
  const sched = bodyOf(src, 'function scheduleRemoteSearch(')
  assert(!/setTimeout\(/.test(sched),
    'scheduleRemoteSearch 里不能再有裸 setTimeout（应走可替换的防抖调度器）',
    'scheduleRemoteSearch 的定时器已走底座的防抖调度器')
  assert(/scheduleRemote\(/.test(sched), '应调用防抖调度器排期')
  const stop = bodyOf(src, 'function stopRemoteSearch(')
  assert(/scheduleRemote\.cancel\(\)/.test(stop), '关闭时必须取消还没触发的排期')
  assert(/abortRemote\(\)/.test(stop), '关闭时必须中止在途请求')
  // 关闭钩子必须真的被调用
  assert(/props\.visible[\s\S]{0,120}stopRemoteSearch\(\)/.test(src),
    'visible 变 false 时必须调 stopRemoteSearch()（否则关掉弹窗仍会白白发一次搜索）')
}

console.log('\n【3】Note.vue：拖拽监听器与异步链')
{
  const src = readCode('subwindows/widget/Note.vue')
  assert(/useDisposables\(\)/.test(src), 'Note.vue 必须使用 disposables 底座')
  const drag = bodyOf(src, 'function onToolbarDragStart(')
  assert(!/document\.addEventListener\(/.test(drag),
    '拖拽监听器不能直接 addEventListener（拖拽中卸载就永久残留）',
    '拖拽监听器已走底座的 listen（卸载时自动移除）')
  assert(/disposables\.listen\(/.test(drag), '拖拽监听器必须经底座登记')
  assert(/disposed/.test(src), 'Note.vue 必须有卸载标志（异步链每步 await 后都要看它）')
  const shot = bodyOf(src, 'async function loadScreenshot(')
  assert(/if \(disposed\) return/.test(shot), '截屏链在 await 之后必须检查卸载标志')
  const save = bodyOf(src, 'async function startSave(')
  assert(/if \(disposed\) return/.test(save), '保存链在 await 之后必须检查卸载标志')
  // 匿名监听器：结构上不可移除
  assert(!/addEventListener\([^,]+,\s*(\(|function)/.test(src),
    'Note.vue 不应有匿名监听器（无法 removeEventListener）',
    'Note.vue 没有匿名监听器')
}

console.log('\n【4】Migration.vue：完成后的 dismiss 定时器')
{
  const src = readCode('subwindows/migration/Migration.vue')
  assert(/useDisposables\(\)/.test(src), 'Migration.vue 必须使用 disposables 底座')
  const dismiss = src.match(/setTimeout\(\(\)\s*=>\s*window\.electron\?\.send\(SEND\.MIGRATION_DISMISS/g)
  assert(!dismiss, 'dismiss 定时器不能是裸 setTimeout（卸载后仍发 IPC）',
    'dismiss 定时器已走底座')
  assert(/disposables\.timeout\([\s\S]{0,80}MIGRATION_DISMISS/.test(src), 'dismiss 应由底座排期')
}

console.log('\n【5】DesktopWidget.vue：调试监听器必须具名可移除')
{
  const src = readCode('subwindows/desktop-widget/DesktopWidget.vue')
  assert(/useDisposables\(\)/.test(src), 'DesktopWidget.vue 必须使用 disposables 底座')
  const anon = src.match(/addEventListener\([^,]+,\s*(\(|function)/g)
  assert(!anon, '不应有匿名监听器（结构上无法移除）',
    '所有监听器都是具名的，可被底座移除')
  assert(/disposables\.listen\(/.test(src), '窗口级监听必须经底座登记')
  // 登录态变化 → 业务数据作废
  assert(/AUTH_CHANGED_EVENT/.test(src), '必须监听登录态变化事件')
  const reset = bodyOf(src, 'function resetBusinessState(')
  assert(/schedule\.value\s*=/.test(reset) && /students\.value\s*=/.test(reset),
    '登录态变化时必须清空业务数据（课表/学生等），否则旧用户数据外露')
  const main = readCode('subwindows/desktop-widget/main.js')
  assert(/AUTH_CHANGED_EVENT/.test(main), '主进程入口必须在 token 变化时广播登录态变化')
  assert(/resetUserScopedCaches\(\)/.test(main),
    'token 变化时本窗口的用户级缓存也要作废（登出只清了主窗口那份注册表）')
}

console.log('\n【6】useRowFocus：定位重试链必须可取消')
{
  const src = readCode('composables/useRowFocus.js')
  assert(/export function createRowFocusHost\(/.test(src), '必须提供 createRowFocusHost（带作用域资源表）')
  const focus = bodyOf(src, 'export function focusRowWhenReady(')
  assert(/return \(\) =>/.test(focus), 'focusRowWhenReady 必须返回取消函数')
  assert(/cancelled/.test(focus), '重试链必须有取消标志')
  const apply = bodyOf(src, 'export function applyRouteRowFocus(')
  assert(/host\._register/.test(apply), '定位过程必须登记到宿主（卸载时统一拆）')
  // 11 个页面必须用新的宿主工厂
  const pages = [
    'components/CadreManage.vue', 'views/ActivitiesView.vue', 'views/AlbumView.vue',
    'views/ClassroomView.vue', 'views/DutyView.vue', 'views/FeeManagement.vue',
    'views/GroupManageView.vue', 'views/LeaveManagement.vue', 'views/ScheduleView/ScheduleView.vue',
    'views/ScoreManagement.vue', 'views/SeatView.vue',
  ]
  let bad = []
  for (const p of pages) {
    const s = readCode(p)
    if (!/createRowFocusHost\(route, router\)/.test(s)) bad.push(p)
    if (!/import \{[^}]*createRowFocusHost[^}]*\} from/.test(s)) bad.push(p + '(缺导入)')
  }
  assert(bad.length === 0, '这些页面必须用 createRowFocusHost：' + bad.join(', '),
    `${pages.length} 个页面的定位宿主都带上了作用域资源表`)
}

console.log('\n【7】动画收尾定时器（useRowSortDrag / GroupManageView）')
{
  const drag = readCode('composables/useRowSortDrag.js')
  assert(/useDisposables\(\)/.test(drag), 'useRowSortDrag 必须使用 disposables 底座')
  assert(!/setTimeout\(done, ROW_MS\)/.test(drag), '行消失的收尾定时器不能是裸 setTimeout')
  assert(/disposables\.timeout\(done, ROW_MS\)/.test(drag), '行消失的收尾定时器应由底座排期')

  const gm = readCode('views/GroupManageView.vue')
  assert(/useDisposables\(\)/.test(gm), 'GroupManageView 必须使用 disposables 底座')
  const bare = gm.match(/^\s*setTimeout\(/gm)
  assert(!bare, 'GroupManageView 不应有裸 setTimeout（动画收尾未落盘）',
    'GroupManageView 的定时器都已落到底座')
}

console.log('\n【8】用户作用域资源必须登记')
{
  const sec = readCode('composables/secureChannel.js')
  assert(/registerUserScopedReset\(/.test(sec),
    '信道会话必须登记到用户级清理表（换号后仍持旧会话密钥）')
  assert(/sessionGen/.test(sec), '必须用会话代次防止在途握手在登出后把会话写回')

  const grid = readCode('components/tables/AiGridPreview.vue')
  assert(/registerUserScopedReset\(/.test(grid),
    '网格预览的学生名映射必须登记（否则换号看到上一个用户的姓名）')

  const auth = readCode('utils/authStorage.js')
  assert(/AUTH_CHANGED_EVENT/.test(auth), '必须导出登录态变化事件名（跨窗口用）')
}

console.log('\n【9】反向豁免：停用模块不纳入判据')
{
  // useElasticScroll 整体停用（main.js 里调用已注释），它的匿名 resize 监听不是活泄漏，
  // 不该被这条探针报出来——但也不许悄悄复活。
  const main = read('main.js')
  assert(/\/\/\s*startElasticScroll\(\)/.test(main),
    'useElasticScroll 仍应保持停用（勿当性能问题去优化再启用）')
}

console.log('')
if (failures) {
  console.error(`生命周期资源探针：${failures} 条判据未通过`)
  process.exit(1)
}
console.log('生命周期资源探针：全部判据通过')
