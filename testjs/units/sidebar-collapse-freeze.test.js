// =========================================================================
// sidebar-collapse-freeze.test.js —— 折叠侧栏时表格内部不许逐帧重排
//
// 背景（2026-11-15）：Sidebar.vue 的 `transition: width 0.15s` 让主内容区逐帧变宽，
// 表格文字每帧重新换行、列宽每帧重新求解 —— 用户看到的就是「一顿一顿」。
// 实机定位：关掉「动画效果」后折叠不卡 → 坐实是逐帧宽度过渡，不是数据量/主题。
//
// 采用的做法（用户定稿）：
//   ① 折叠期间把 <table> 宽度钉在**起始**宽度，容器照旧变宽但表格内部不排布，
//      结束撤掉后按终态一次性排布；
//   ② 表格内容同时淡出，露出外层容器本身就是的那块玻璃（空状态同款），
//      结束后 160ms opacity 淡入复原。**不新造玻璃配方、不叠 backdrop-filter**：
//      DynamicTable.vue 的 .dt-empty 注释里明确否过「玻璃上再盖一层模糊会变浊」。
//   ③ 遮罩范围只在 .table-scroll-wrapper 内，**不是全屏/整个内容区**。
//
// 边界：GridView 不在选择器里（本轮只解列表型表格）；no-animations 跳过整个窗口。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const FILES = {
  sidebar: 'student-frontend/src/components/layout/Sidebar.vue',
  app: 'student-frontend/src/App.vue',
  css: 'student-frontend/src/styles/index.css',
}
function read(key) {
  return fs.readFileSync(path.join(ROOT, FILES[key]), 'utf8')
}

function assertFreeze(sources) {
  const { sidebar, app, css } = sources

  // ① 触发：方向 class + defer 排期 + 余量覆盖 150ms + 关动画跳过
  const fnAt = sidebar.indexOf('function toggleCollapsed(')
  assert.ok(fnAt > 0, 'toggleCollapsed 必须存在')
  const body = sidebar.slice(fnAt, sidebar.indexOf('\n}', fnAt) + 2)
  assert.match(body, /classList\.add\(MASK_CLASS, collapsed\.value \? MASK_DIR_COLLAPSED : MASK_DIR_EXPANDED\)/,
    '必须按折叠/展开方向发 class（CSS 靠它算起始宽度）')
  assert.match(body, /endCollapseMask\(clearMask, MASK_MS\)/, '必须有定时收尾')
  assert.match(body, /no-animations/, '关掉动画效果时必须跳过整个窗口')
  assert.match(sidebar, /const endCollapseMask = d\.defer\(\)/,
    '连点必须靠 defer 自动取消上一次排期（timeout 会留下多个定时器）')
  assert.match(sidebar, /import \{ useDisposables \} from '\.\.\/\.\.\/utils\/disposables\.js'/,
    '定时器必须走 disposables')
  const ms = /const MASK_MS = (\d+)/.exec(sidebar)
  assert.ok(ms && Number(ms[1]) >= 150, '窗口必须覆盖侧栏 150ms 过渡')

  // ② 遮罩只在表格范围内：App.vue 不许再出现全屏遮罩层
  assert.ok(!/sidebar-collapse-mask/.test(app),
    '不许回到「整个内容区一层遮罩」的写法（用户明确否过）')
  assert.ok(!/sidebar-collapse-mask/.test(css), '全屏遮罩样式必须已撤掉')

  // ③ 冻结 + 淡出：取布局变动窗口那一段，别扫到文件里其它 backdrop-filter
  const segAt = css.indexOf('布局变动窗口：表格冻结 + 内容淡出')
  assert.ok(segAt > 0, '布局变动窗口段必须存在')
  const seg = css.slice(segAt, css.indexOf('/* ====', segAt + 10) > 0
    ? css.indexOf('/* ====', segAt + 10)
    : css.length)
  assert.match(seg, /transition: opacity 160ms ease/, '复原必须走 160ms opacity 淡入')
  assert.match(seg, /html:is\(\.sidebar-collapsing, \.window-resizing\)/, '两个触发源必须共用同一条规则')
  assert.match(seg, /:is\(\.table-scroll-wrapper, \.grid-view-container\)/, '列表型 / 网格型表格必须都命中')
  assert.match(seg, /opacity: 0;[\s\S]*?transition-duration: 0ms/,
    '盖上要瞬时，否则淡出那 160ms 里还是能看见重排')
  assert.match(seg, /width: var\(--table-freeze-w\)/, '表格宽度必须由冻结变量钉住')
  assert.match(seg, /--table-freeze-w: calc\(100vw - 240px - 48px\)/, '折叠方向必须给出起始宽度')
  assert.match(seg, /--table-freeze-w: calc\(100vw - 64px - 48px\)/, '展开方向必须给出起始宽度')
  assert.match(seg, /--table-freeze-w: var\(--win-freeze-w\)/, '拖窗口必须用 JS 实测的起始宽度')
  assert.match(seg, /overflow-x: hidden/, '展开 / 缩窗方向表格比容器宽，必须临时收掉横向滚动条')
  assert.match(seg, /html\.no-animations:not\(\.window-resizing\)/,
    '关动画时折叠要兜底保持可见，但拖窗口不能被一起跳过')
  // 只匹配「带 ASCII 冒号的 CSS 声明」：注释里说明「不叠 backdrop-filter」用的是全角标点，
  // 用裸关键字会把自己的注释判成假红（变异反证 M5 插的是真声明，仍会被抓）。
  assert.ok(!/backdrop-filter\s*:|color-mix\s*\(|content-visibility\s*:|display\s*:\s*none/.test(seg),
    '不许自造玻璃配方、不许用隐藏子树的方式冻结（玻璃是外层容器现成的）')
}

function sources() {
  return { sidebar: read('sidebar'), app: read('app'), css: read('css') }
}

test('折叠侧栏时表格内部必须冻结并只淡出表格自身', () => {
  assertFreeze(sources())
})

// 变异反证：每条判据都要能抓到「改回老写法 / 改错方向」。
test('变异反证 M1：丢掉方向 class 必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace(
    'root.classList.add(MASK_CLASS, collapsed.value ? MASK_DIR_COLLAPSED : MASK_DIR_EXPANDED)',
    'root.classList.add(MASK_CLASS)',
  )
  assert.throws(() => assertFreeze(s), /必须按折叠\/展开方向发 class/)
})

test('变异反证 M2：defer 换成 timeout 必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace('const endCollapseMask = d.defer()', 'const endCollapseMask = d.timeout()')
  assert.throws(() => assertFreeze(s), /连点必须靠 defer/)
})

test('变异反证 M3：no-animations 分支删掉必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace(
    "if (document.documentElement.classList.contains('no-animations')) {",
    'if (false) {',
  )
  assert.throws(() => assertFreeze(s), /关掉动画效果时必须跳过/)
})

test('变异反证 M4：不钉表格宽度必须被抓', () => {
  const s = sources()
  s.css = s.css.replace('  --table-freeze-w: calc(100vw - 240px - 48px);', '  /* 不钉宽度 */')
  assert.throws(() => assertFreeze(s), /折叠方向必须给出起始宽度/)
})

test('变异反证 M5：自造 backdrop-filter 玻璃配方必须被抓', () => {
  const s = sources()
  s.css = s.css.replace(
    ':is(.table-scroll-wrapper, .grid-view-container) table {\n  transition: opacity 160ms ease;',
    ':is(.table-scroll-wrapper, .grid-view-container) table {\n  backdrop-filter: blur(14px);\n  transition: opacity 160ms ease;',
  )
  assert.throws(() => assertFreeze(s), /不许自造玻璃配方/)
})

test('变异反证 M6：回到全屏遮罩必须被抓', () => {
  const s = sources()
  s.app = s.app.replace(
    '        <CustomScrollbar :target="mainScrollRef" />',
    '        <CustomScrollbar :target="mainScrollRef" />\n        <div class="sidebar-collapse-mask"></div>',
  )
  assert.throws(() => assertFreeze(s), /不许回到「整个内容区一层遮罩」/)
})
