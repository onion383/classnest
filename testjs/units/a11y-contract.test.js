// =========================================================================
// a11y-contract.test.js —— 档 C-3「可访问性」的回归判据
//
//   F01-03 Tabs 缺 tablist/tab 角色与方向键
//   F01-04 MediaViewer 纯鼠标、无键盘
//   F01-05 ClippedText 只能点、键盘打不开
//   F01-06 AppSelect 触发器/选项缺 ARIA（= N5-18）
//   F01-07 ContextMenu 键盘进不去、禁用项照样执行
//   N5-11 DialogShell 缺 role=dialog/aria-modal、焦点陷阱与还原
//   N5-12 NotificationToast 无 live role
//   N5-13 表单控件无可访问名（本批：登录/注册）
//   N5-14 div 做链接（本批：看板 10 处 + 登录 4 个假锚点）
//   N5-15 图片缺 alt（本批：查看器大图）
//   N5-16 主题对比度 —— 视觉决策，未做（登记）
//   N5-17 index.html lang="en"
//
// 手法：真实源码静态判据 + 从 .vue 抽函数体用 new Function 真跑。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 抽出 `function name(...) { ... }` 的函数体（花括号配平；找不到直接失败） */
function extractFnBody(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}(`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

const TABS = 'student-frontend/src/components/base/Tabs.vue'
const SELECT = 'student-frontend/src/components/base/AppSelect.vue'
const MENU = 'student-frontend/src/components/base/ContextMenu.vue'
const SHELL = 'student-frontend/src/components/base/DialogShell.vue'
const TOAST = 'student-frontend/src/components/base/NotificationToast.vue'
const VIEWER = 'student-frontend/src/components/base/MediaViewer.vue'
const CLIP = 'student-frontend/src/components/ClippedText.vue'
const DASH = 'student-frontend/src/views/DashboardView.vue'
const LOGIN = 'student-frontend/src/views/Login.vue'
const INDEX = 'student-frontend/index.html'

test('[静态] F01-03 Tabs 有 tablist/tab 角色、roving tabindex 与方向键处理', () => {
  const src = read(TABS)
  assert.match(src, /role="tablist"/)
  assert.match(src, /role="tab"/)
  assert.match(src, /:aria-selected="modelValue === tab\.value"/)
  assert.match(src, /:tabindex="modelValue === tab\.value \? 0 : -1"/)
  assert.match(src, /@keydown="onKeydown"/)
})

test('[行为] F01-03 Tabs 的方向键/Home/End 会切标签并把焦点带过去', () => {
  const src = read(TABS)
  const run = new Function('props', 'emit', 'e', extractFnBody(src, 'onKeydown'))
  const tabs = [{ value: 'a' }, { value: 'b' }, { value: 'c' }]
  const mkEvent = (key) => {
    const focused = []
    const buttons = tabs.map((t) => ({ focus: () => focused.push(t.value) }))
    return {
      key,
      prevented: false,
      preventDefault() { this.prevented = true },
      currentTarget: { querySelectorAll: () => buttons },
      focused,
    }
  }
  const emitInto = (out) => (ev, v) => out.push([ev, v])

  const out1 = []
  const e1 = mkEvent('ArrowRight')
  run({ tabs, modelValue: 'a' }, emitInto(out1), e1)
  assert.deepEqual(out1, [['update:modelValue', 'b']])
  assert.deepEqual(e1.focused, ['b'], '焦点应跟到新标签')

  const out2 = []
  const e2 = mkEvent('ArrowLeft')
  run({ tabs, modelValue: 'a' }, emitInto(out2), e2)
  assert.deepEqual(out2, [['update:modelValue', 'c']], '左键从第一项回绕到最后一项')

  const out3 = []
  run({ tabs, modelValue: 'b' }, emitInto(out3), mkEvent('Home'))
  assert.deepEqual(out3, [['update:modelValue', 'a']])

  const out4 = []
  run({ tabs, modelValue: 'b' }, emitInto(out4), mkEvent('End'))
  assert.deepEqual(out4, [['update:modelValue', 'c']])
})

test('[静态] F01-06 / N5-18 AppSelect 触发器与选项都有 ARIA，且支持 ariaLabel 补名', () => {
  const src = read(SELECT)
  assert.match(src, /:aria-expanded="open"/)
  assert.match(src, /aria-haspopup="listbox"/)
  assert.match(src, /:aria-label="ariaLabel \|\| undefined"/)
  assert.match(src, /ariaLabel: \{ type: String, default: '' \}/)
  assert.match(src, /role="option"/)
  assert.match(src, /:aria-selected="opt\.value === resolved\?\.value"/)
  assert.match(src, /:aria-disabled="opt\.disabled \? 'true' : undefined"/)
})

test('[静态] F01-07 ContextMenu 打开进焦点、方向键移动、Esc 关闭、禁用项不执行', () => {
  const src = read(MENU)
  assert.match(src, /@keydown="onKeydown"/)
  assert.match(src, /:aria-disabled="item\.disabled \? 'true' : undefined"/)
  assert.match(src, /@click="pick\(item\)"/)
  assert.match(src, /lastFocus = document\.activeElement/)
  assert.match(src, /lastFocus\.focus\(\)/)
  assert.match(src, /function onKeydown\(e\)/)
  assert.match(src, /function pick\(item\)[\s\S]{0,120}if \(!item \|\| item\.disabled\) return/)
  // 方向键必须跳过禁用项
  assert.match(src, /aria-disabled.*=== 'true'[\s\S]{0,120}next = \(next \+ step \+ items\.length\) % items\.length/)
})

test('[静态] F01-05 ClippedText 可聚焦、Enter/Space 打开、浮窗走统一 DialogShell', () => {
  const src = read(CLIP)
  assert.match(src, /:role="isLong \? 'button' : undefined"/)
  assert.match(src, /:tabindex="isLong \? 0 : undefined"/)
  assert.match(src, /@keydown\.enter\.prevent="isLong && \(open = true\)"/)
  assert.match(src, /@keydown\.space\.prevent="isLong && \(open = true\)"/)
  // N5-11：不再手写遮罩，改由 DialogShell 提供 role=dialog/aria-modal/焦点陷阱，
  // 标题通过 label 传给 dialog 的可访问名
  assert.match(src, /<DialogShell[^>]*:label="title"/)
  assert.match(src, /@overlay="close"/)
})

test('[静态] N5-11 DialogShell 有 dialog 语义、打开聚焦、Tab 陷阱、关闭还原', () => {
  const src = read(SHELL)
  assert.match(src, /role="dialog"/)
  assert.match(src, /aria-modal="true"/)
  assert.match(src, /ref="overlayEl"/)
  assert.match(src, /lastFocus = document\.activeElement/)
  assert.match(src, /first\.focus\(\)/)
  assert.match(src, /function trapTab\(e\)/)
  assert.match(src, /if \(isTopDialog\(self\)\) trapTab\(e\)/)
  assert.match(src, /const list = focusables\(root\)/)
})

test('[静态] F01-04 MediaViewer 有 dialog 语义、打开聚焦、←/→/Esc 与图片 alt', () => {
  const src = read(VIEWER)
  assert.match(src, /role="dialog"\s+aria-modal="true"\s+aria-label="媒体查看器"/)
  assert.match(src, /@keydown="onKeydown"/)
  assert.match(src, /function onKeydown\(e\)/)
  assert.match(src, /e\.key === 'ArrowLeft'/)
  assert.match(src, /e\.key === 'ArrowRight'/)
  assert.match(src, /:alt="current && current\.name \? current\.name : '图片预览'"/)
  assert.match(src, /rootEl\.value\.focus\(\)/)
})

test('[静态] N5-12 通知有 role=alert/status，关闭按钮有可访问名', () => {
  const src = read(TOAST)
  assert.match(src, /:role="item\.type === 'error' \? 'alert' : 'status'"/)
  assert.match(src, /aria-live="polite"/)
  assert.match(src, /aria-label="关闭提示"/)
  assert.match(src, /aria-hidden="true"/)
})

test('[静态] N5-17 页面语言是中文', () => {
  assert.match(read(INDEX), /<html lang="zh-CN">/)
})

test('[静态] N5-14 看板 10 个 div 链接可聚焦、Enter/Space 可触发，且有可见焦点', () => {
  const src = stripComments(read(DASH))
  const links = src.match(/role="link" tabindex="0"/g) || []
  assert.ok(links.length >= 10, `看板的 stat-link(3) + card-link(7) 都要补，实际 ${links.length} 处`)
  assert.match(src, /@keydown="onCardKeydown"/)
  assert.match(src, /function onCardKeydown\(e\)[\s\S]{0,400}?el\.click\(\)/)
  assert.match(src, /\.card-link:focus-visible,[\s\S]{0,120}?\.stat-link:focus-visible/)
})

test('[静态] N5-14 登录页的 4 个假锚点都能用键盘触发', () => {
  const src = stripComments(read(LOGIN))
  const anchors = src.match(/<a class="cursor-pointer underline[^>]*>/g) || []
  assert.equal(anchors.length, 4, `登录页假锚点应有 4 个，实际 ${anchors.length}`)
  for (const a of anchors) {
    assert.match(a, /role="button"/)
    assert.match(a, /tabindex="0"/)
    assert.match(a, /@keydown\.enter\.prevent=/)
    assert.match(a, /@keydown\.space\.prevent=/)
  }
})

test('[静态] N5-13 登录/注册的输入框都有可访问名', () => {
  const src = stripComments(read(LOGIN))
  const inputs = src.match(/<input[^>]*>/g) || []
  const loginForm = inputs.filter((i) => /placeholder="(账号|密码|确认密码)/.test(i))
  assert.ok(loginForm.length >= 5, '至少要覆盖登录 2 个 + 注册 3 个')
  for (const i of loginForm) {
    assert.match(i, /aria-label="[^"]+"/, `输入框缺 aria-label：${i}`)
  }
})

// F01-06 / N5-18 的调用侧收口：AppSelect 触发器里只有当前值/占位符，
// 不传 ariaLabel 时读屏只能听到「30 天」「请选择」，听不出这是哪个设置项。
// 组件本身早有 ariaLabel prop（上一条用例），这里闸住所有调用点。
test('[静态] N5-18 所有 AppSelect 调用点都传了 aria-label', () => {
  const SRC = path.join(ROOT, 'student-frontend', 'src')
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.vue')) files.push(p)
    }
  }
  walk(SRC)
  assert.ok(files.length > 0, '没扫到任何 .vue 文件，路径不对')

  const missing = []
  for (const file of files) {
    if (file.endsWith(path.join('base', 'AppSelect.vue'))) continue
    const src = fs.readFileSync(file, 'utf8')
    const re = /<AppSelect\b/g
    let m
    while ((m = re.exec(src))) {
      // 注释里的用法示例不算调用点
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const lineEnd = src.indexOf('\n', m.index)
      const lineText = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd)
      if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue
      // 引号感知地取到标签结尾（属性值里可能有 > 或换行）
      let i = m.index + m[0].length
      let q = null
      for (; i < src.length; i++) {
        const c = src[i]
        if (q) { if (c === q) q = null; continue }
        if (c === '"' || c === "'") { q = c; continue }
        if (c === '>') break
      }
      const tag = src.slice(m.index, i + 1)
      if (!/(^|\s):?aria-?label\s*=/i.test(tag)) {
        const line = src.slice(0, m.index).split('\n').length
        missing.push(`${path.relative(ROOT, file)}:${line}`)
      }
    }
  }
  assert.deepEqual(missing, [], `以下 AppSelect 调用点缺 aria-label：\n${missing.join('\n')}`)
})
