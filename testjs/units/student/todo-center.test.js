// =========================================================================
// todo-center.test.js —— 标题栏「N 项待处理」胶囊的接线判据
//
// 原来只有销假一个铃铛，直接写死在 App.vue 里。现在抽成共用通知中心：
//   TodoBell（胶囊）→ TodoCenterDialog（点开列表）→ 两个「去处理」跳转。
// 失效方式都是「看起来还在，但数字不更新 / 点进去没反应」，所以逐段盯住。
// =========================================================================
const { test } = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC = abs('student-frontend/src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

test('无待办就不显示胶囊：TodoBell 自己按 total 条件渲染', () => {
  const s = read('components/base/TodoBell.vue')
  assert.match(s, /v-if="total > 0"/, '没有待办时应整个不渲染，不是显示「0 项」')
  assert.match(s, /total: \{ type: Number, default: 0 \}/, '总数必须由外部传入，不能在组件里写死')
  assert.match(s, /@click="\$emit\('open'\)"/)
  assert.doesNotMatch(s, /v-if="true"/, '不能保留「永远渲染」的调试写法')
})

test('通知中心聚合两类待办，total 是各项数量之和', () => {
  const s = read('composables/useTodoCenter.js')
  const at = s.indexOf('const items = computed')
  assert.ok(at > 0, '找不到 items 汇总')
  const end = s.indexOf('const total = computed', at)
  assert.ok(end > at)
  const body = s.slice(at, end)
  assert.equal((body.match(/out\.push\(/g) || []).length, 2, '销假 + 临时学生，少一类胶囊就漏报')
  assert.match(body, /key: 'overdue'/)
  assert.match(body, /key: 'provisional'/)
  assert.match(body, /namesOf\(overdueRows\.value, '姓名'\)/, '销假名单要复用铃铛的同一份数据，不能另算口径')
  const t = s.slice(end)
  assert.match(t, /reduce\(\(n, item\) => n \+ item\.count, 0\)/, '胶囊总数必须等于两类之和')
})

test('通知中心每条是一张毛玻璃卡（不是靠下边框分隔的裸列表）', () => {
  const s = read('components/dialogs/TodoCenterDialog.vue')
  // 玻璃配方必须走 bg-surface/XX 而不是 bg-white/XX：前者读 --color-surface，夜间自动变深；
  // 后者是给 AI 面板的浅色玻璃，放到通知中心会在夜间留一块白板。
  assert.match(s, /bg-surface\/55/, '卡片走主题表面色')
  assert.ok(!/bg-white\/55/.test(s), '不用浅色玻璃配方')
  assert.ok(!/border-b border-border last:border-b-0/.test(s), '原来的下边框分隔已去掉，改由卡片间隙分隔')
})

test('App.vue 已换成共用胶囊，旧的销假专属铃铛清干净', () => {
  const s = read('App.vue')
  assert.match(s, /<TodoBell v-if="\$route\.path !== '\/login'" :total="todoTotal" @open="todoOpen = true" \/>/)
  assert.match(s, /<TodoCenterDialog[\s\S]*?:items="todoItems"[\s\S]*?@go="goToTodo"/)
  assert.doesNotMatch(s, /tb-bell/, '旧铃铛的模板与样式都删掉，不能留下两套入口')
  assert.doesNotMatch(s, /overdueCount/, '销假计数不再单独喂给标题栏')
})

test('通知窗常驻挂载 + 复用通用 dialog 动画，关闭才有离场过渡', () => {
  const app = read('App.vue')
  // 根因：原来写 v-if="chromeReady && todoOpen"，关窗瞬间整个组件被卸载，
  // 内部 <Transition> 的 leave 动画根本没机会跑。改成常驻挂载、由 :visible 驱动。
  const mount = app.match(/<TodoCenterDialog[\s\S]*?\/>/)
  assert.ok(mount, '找不到 TodoCenterDialog 挂载点')
  assert.match(mount[0], /v-if="chromeReady"\s*$/m, '必须常驻挂载（只受 chromeReady 控制），不能在关窗时卸载组件')
  assert.doesNotMatch(mount[0], /&&\s*todoOpen/, '挂载条件不能带 todoOpen，否则离场动画被跳过')
  assert.match(mount[0], /:visible="todoOpen"/, '显隐必须交给内部 Transition 的 visible')

  const s = read('components/dialogs/TodoCenterDialog.vue')
  // N5-11 后统一由 DialogShell 提供通用 dialog 过渡（Teleport + Transition + 焦点管理）
  assert.match(s, /<DialogShell[^>]*:visible="visible"/, '复用 DialogShell（含通用 dialog 过渡与焦点管理）')
  assert.match(s, /class="[^"]*dialog-card[^"]*"/, '卡片带 dialog-card 才有进出场的回弹缩放')
  assert.match(s, /import '\.\.\/\.\.\/styles\/dialog-transition\.css'/, '组件自治：自己引入通用动画样式')
})

test('两个「去处理」都接上：销假回请假页，临时学生回班级页', () => {
  const s = read('App.vue')
  const at = s.indexOf('function goToTodo')
  assert.ok(at > 0, '找不到跳转处理')
  const body = s.slice(at, at + 500)
  assert.match(body, /key === 'provisional'/)
  assert.match(body, /path: '\/students', query: \{ provisional: '1' \}/)
  assert.match(body, /path: '\/leaves', query: \{ overdue: '1' \}/)
  assert.match(body, /todoOpen\.value = false/, '点了要去处理就把通知窗关掉')
})

test('班级页接到 query 后直接开临时学生弹窗（KeepAlive 下也要生效）', () => {
  const s = read('views/ClassroomView.vue')
  assert.match(s, /watch\(\(\) => route\.query\.provisional/)
  assert.match(s, /if \(v === '1'\) provisionalOpen\.value = true/)
  assert.match(s, /\{ immediate: true \}/, '复用实例不会重跑 onMounted，必须 immediate')
})

test('通知中心与两个组件都能被加载（模块接线没断）', async () => {
  for (const p of [
    'composables/useTodoCenter.js',
    'components/base/TodoBell.vue',
    'components/dialogs/TodoCenterDialog.vue',
  ]) {
    const stat = fs.statSync(path.join(SRC, p))
    assert.ok(stat.size > 100, `${p} 不能是空壳`)
  }
  const m = await import(pathToFileURL(path.join(SRC, 'composables/useTodoCenter.js')).href)
  assert.equal(typeof m.useTodoCenter, 'function')
  assert.equal(typeof m.startTodoCenter, 'function')
  assert.equal(typeof m.refreshProvisionalStudents, 'function')
})
