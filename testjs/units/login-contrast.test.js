// =========================================================================
// login-contrast.test.js —— 登录页文字对比度，按 WCAG 算，不靠肉眼
//
// 为什么要有这条：登录页是**唯一直接压在背景图上**的一屏，卡片是半透明玻璃，
// 所以「文字色 vs 卡片实际颜色」取决于用户的玻璃透明度与背景图明暗 ——
// 换一台机器（换背景图）就可能从「能看清」变成「整片糊」。截图反馈的正是这个。
//
// 关键：所有颜色**从 CSS 现读**，不在这里写死。
// 早先版本把色值硬编码在断言里 —— 改 CSS 时测试照样全绿，那等于没测
// （变异反证连续三条不红才发现）。
//
// 阈值：正文 ≥ 6:1、次要小字 ≥ 4.5:1（WCAG AA 正文）。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const GLASS = fs.readFileSync(path.join(ROOT, 'student-frontend/src/styles/theme-glass.css'), 'utf8')
const NIGHT = fs.readFileSync(path.join(ROOT, 'student-frontend/src/styles/theme-night.css'), 'utf8')

// ---- CSS 取值 ----
function block(css, selector) {
  const i = css.indexOf(selector)
  if (i < 0) return null
  const start = css.indexOf('{', i)
  if (start < 0) return null
  const end = css.indexOf('}', start)
  if (end < 0) return null
  return css.slice(start + 1, end)
}
function decl(blockText, prop) {
  if (!blockText) return null
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`).exec(blockText)
  return m ? m[1].trim() : null
}
// 从 `rgba(30, 44, 74, clamp(0.62, calc(...), 1))` 里分别取出颜色与 alpha 下限
function rgbaParts(value) {
  if (!value) return null
  const c = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/.exec(value)
  if (!c) return null
  const a = /(?:clamp|max)\(\s*([\d.]+)\s*,/.exec(value)
  return { rgb: [+c[1], +c[2], +c[3]], alpha: a ? parseFloat(a[1]) : null }
}
const plainColor = (v) => (v || '').replace('!important', '').trim()

// ---- WCAG ----
const hex = (h) => {
  const s = h.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16))
}
const lin = (c) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
const blend = (rgb, alpha, dstHex) => {
  const d = hex(dstHex)
  return rgb.map((c, i) => Math.round(c * alpha + d[i] * (1 - alpha)))
}

// 背景图取样：最暗（夜空）与最亮（亮云）
const BG_DARK = '#10233f'
const BG_LIGHT = '#cbd5e1'

const DAY_CARD_SEL = ':root:is([data-theme="glass"]):not([data-mode="night"]) .login-bg .bg-surface'
const DAY_MUTED_SEL = ':root:is([data-theme="glass"]):not([data-mode="night"]) .login-bg .login-card .text-text-muted'
const NIGHT_CARD_SEL = ':root[data-mode="night"][data-theme="glass"] .login-bg .bg-surface'
const NIGHT_MUTED_SEL = ':root[data-mode="night"][data-theme="glass"] .login-bg .login-card .text-text-muted'
const LOGIN_CARD_SEL = ':root:is([data-theme="glass"]) .login-glow > .login-card'

test('白天：卡片有白度下限，且透明度拉到最低时正文/次要文字仍可读', () => {
  const parts = rgbaParts(decl(block(GLASS, DAY_CARD_SEL), 'background-color'))
  assert.ok(parts, '找不到白天登录卡片的背景色声明（选择器或写法变了）')
  assert.equal(parts.rgb.join(','), '255,255,255', '登录卡片底色应为白')
  assert.ok(parts.alpha !== null, '登录卡片底色没有 clamp/max 下限 —— 用户把透明度调低时会掉到不可读')
  assert.ok(parts.alpha >= 0.6, `白度下限只有 ${parts.alpha}，太低`)

  const card = blend(parts.rgb, parts.alpha, BG_DARK)
  const bodyText = ratio(hex('#1e293b'), card)
  const mutedHex = plainColor(decl(block(GLASS, DAY_MUTED_SEL), 'color'))
  assert.ok(mutedHex.startsWith('#'), `找不到白天登录页次要文字的显式色，实际拿到「${mutedHex}」`)
  const muted = ratio(hex(mutedHex), card)
  assert.ok(bodyText >= 6, `正文对比度只有 ${bodyText.toFixed(2)}:1（应 ≥ 6）`)
  assert.ok(muted >= 4.5, `「忘记密码？」对比度只有 ${muted.toFixed(2)}:1（应 ≥ 4.5）`)
})

test('白天：全局 --color-text-muted 在同样底上确实不够 —— 这就是要单独覆盖的原因', () => {
  const parts = rgbaParts(decl(block(GLASS, DAY_CARD_SEL), 'background-color'))
  const card = blend(parts.rgb, parts.alpha, BG_DARK)
  const globalMuted = ratio(hex('#64748b'), card) // theme-glass.css 的 --color-text-muted
  assert.ok(globalMuted < 4.5, `如果全局 muted 已经达标（${globalMuted.toFixed(2)}:1），登录页那条覆盖就是多余的`)
})

test('白天：亮背景图上不会过曝（文字仍够深）', () => {
  const parts = rgbaParts(decl(block(GLASS, DAY_CARD_SEL), 'background-color'))
  const card = blend(parts.rgb, 1, BG_LIGHT) // 用户把透明度拉满 = 几乎纯白
  assert.ok(ratio(hex('#1e293b'), card) >= 12, '纯白底上正文应当极清晰')
  const mutedHex = plainColor(decl(block(GLASS, DAY_MUTED_SEL), 'color'))
  assert.ok(ratio(hex(mutedHex), card) >= 8, '纯白底上次要文字也应达标')
})

test('夜间：登录卡片必须是深底，浅色文字才成立', () => {
  const parts = rgbaParts(decl(block(NIGHT, NIGHT_CARD_SEL), 'background-color'))
  assert.ok(parts, '夜间登录卡片缺显式深底 —— 会与通用 .bg-surface 同优先级，只靠加载顺序')
  assert.ok(lum(parts.rgb) < 0.1, '夜间登录卡片底色不够深')
  const card = blend(parts.rgb, parts.alpha, BG_DARK)
  const bodyText = ratio(hex('#e6ecf5'), card)
  const mutedHex = plainColor(decl(block(NIGHT, NIGHT_MUTED_SEL), 'color'))
  assert.ok(mutedHex.startsWith('#'), `找不到夜间登录页次要文字色，实际拿到「${mutedHex}」`)
  const muted = ratio(hex(mutedHex), card)
  assert.ok(bodyText >= 7, `夜间正文对比度只有 ${bodyText.toFixed(2)}:1`)
  assert.ok(muted >= 4.5, `夜间次要文字对比度只有 ${muted.toFixed(2)}:1`)
})

test('登录卡片必须抬到 .login-glow::after 的受光层之上', () => {
  // 两者 z-index 都是 auto，::after 排在卡片之后 → 那层白色渐变会盖住文字
  const z = decl(block(GLASS, LOGIN_CARD_SEL), 'z-index')
  assert.equal(z, '1', '登录卡片没有抬 z-index，受光渐变会把文字洗淡')
})

test('白天与夜间的登录规则互不串台', () => {
  assert.ok(GLASS.includes(DAY_CARD_SEL), '白天登录卡片规则没有排除夜间模式')
  assert.ok(GLASS.includes(DAY_MUTED_SEL), '次要文字加深没有排除夜间模式')
  assert.ok(NIGHT.includes(NIGHT_CARD_SEL), '夜间登录卡片规则缺失')
  assert.ok(NIGHT.includes(NIGHT_MUTED_SEL), '夜间次要文字规则缺失')
})
