// =========================================================================
// theme-contrast.test.js —— 主题文字对比度闸门（WCAG AAA + 三级梯度）
//
// 背景：审查 v8 · N5-16 的对比度项此前被跳过。本闸门把「看完还给改回去」的路堵上：
//   · 三档文字都必须过 AAA 正文线 7:1（12–13px 小字享受不到大字号豁免）；
//   · 三档之间要留出可感知的梯度，不能都压在 7:1 挤成一层：
//       弱化 ≈ 7:1（底线） < 次要 ≈ 9.5:1 < 正文 ≥ 12:1
//   · 玻璃主题的「面」是半透明，按滑块 0% / 默认 40% / 100% 三档各算一次取最差值，
//     并对背景图之外的页面底色做混合 —— 与 styles/theme-glass*.css 的实现口径一致。
//
// 唯一做不到 12:1 的是 glass 夜间：它的悬浮面 #354a73 本身就偏亮，
// 白字在它上面物理上限只有 8.83:1，因此该场景按 8.5 / 7.3 / 7.0 的紧凑梯度验收。
//
// 所有色值都从 CSS 现读，不在这里写死；改坏任一 token 即红。
// =========================================================================
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { abs } = require('#testjs/paths')
const test = require('node:test')
const assert = require('node:assert/strict')

// ---- CSS 解析：取出 :root 作用域内的自定义属性 ----
function parseBlocks(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const stack = []
  let buf = ''
  let cur = { selector: '', decls: {} }
  for (const ch of css) {
    if (ch === '{') {
      stack.push(cur)
      cur = { selector: buf.trim(), decls: {} }
      buf = ''
    } else if (ch === '}') {
      out.push(cur)
      cur = stack.pop() || { selector: '', decls: {} }
      buf = ''
    } else if (ch === ';') {
      const m = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([\s\S]+)$/.exec(buf)
      if (m) cur.decls[m[1]] = m[2].trim()
      buf = ''
    } else {
      buf += ch
    }
  }
  return out
}

const cache = new Map()
function blocksOf(file) {
  if (!cache.has(file)) {
    const url = pathToFileURL(abs(`student-frontend/src/styles/${file}`))
    cache.set(file, parseBlocks(fs.readFileSync(url, 'utf8')))
  }
  return cache.get(file)
}

const has = (sel, s) => sel.includes(s)
const isRoot = (s) => s.trim() === ':root'

const SCENES = [
  {
    id: 'default',
    label: 'theme.css 默认层',
    files: ['theme.css'],
    match: isRoot,
    expect: { muted: 7, secondary: 9, primary: 12 },
  },
  {
    id: 'base-day',
    label: 'base 日间',
    files: ['theme.css', 'theme-base.css', 'theme-base-accent.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="base"') && !has(s, 'data-mode="night"')),
    expect: { muted: 7, secondary: 9, primary: 12 },
  },
  {
    id: 'base-night',
    label: 'base 夜间',
    files: ['theme.css', 'theme-base.css', 'theme-base-accent.css', 'theme-base-night.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="base"') &&
      (!has(s, 'data-mode="night"') || has(s, '[data-mode="night"]'))),
    expect: { muted: 7, secondary: 9, primary: 12 },
  },
  {
    id: 'glass-day',
    label: 'glass 日间',
    files: ['theme.css', 'theme-glass.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="glass"') && !has(s, 'data-mode="night"')),
    expect: { muted: 7, secondary: 9, primary: 12 },
  },
  {
    id: 'glass-night',
    label: 'glass 夜间',
    files: ['theme.css', 'theme-glass.css', 'theme-glass-night.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="glass"') &&
      (!has(s, 'data-mode="night"') || has(s, '[data-mode="night"]'))),
    // 悬浮面 #354a73 的物理上限 8.83:1，只能紧凑梯度
    expect: { muted: 7, secondary: 7.3, primary: 8.5 },
  },
  {
    id: 'glass2-day',
    label: 'glass2 日间',
    files: ['theme.css', 'theme-glass2.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="glass2"') && !has(s, 'data-mode="night"')),
    expect: { muted: 7, secondary: 9, primary: 12 },
  },
  {
    id: 'glass2-night',
    label: 'glass2 夜间',
    files: ['theme.css', 'theme-glass2.css', 'theme-glass2-night.css'],
    match: (s) => isRoot(s) || (has(s, 'data-theme="glass2"') &&
      (!has(s, 'data-mode="night"') || has(s, '[data-mode="night"]'))),
    // glass2 的玻璃浓度可拉到 100%，不透明时表面最亮，按那一档验收
    expect: { muted: 7, secondary: 9, primary: 10.5 },
  },
]

// ---- 取值：var() 链 / rgba / calc 全部解析 ----
function resolveExpr(expr, vars, slider, seen = new Set()) {
  let s = String(expr)
  s = s.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fb) => {
    if (name === '--glass-opacity' || name === '--g2-a') return String(slider)
    if (seen.has(name) || vars[name] == null) return fb != null ? fb : '0'
    const next = new Set(seen); next.add(name)
    return resolveExpr(vars[name], vars, slider, next)
  })
  s = s.replace(/calc\(([^()]*)\)/g, (_, inner) => {
    const parts = inner.split(/([+-])/).map((p) => p.trim()).filter(Boolean)
    let acc = parseFloat(parts[0])
    for (let i = 1; i < parts.length; i += 2) {
      const n = parseFloat(parts[i + 1])
      acc = parts[i] === '+' ? acc + n : acc - n
    }
    return String(acc)
  })
  s = s.replace(/clamp\(([^)]*)\)/g, (_, inner) => {
    const n = inner.split(',').map((x) => parseFloat(resolveExpr(x, vars, slider)))
    return String(Math.min(Math.max(n[0], n[1]), n[2]))
  })
  return s
}

function parseColor(text, vars, slider, seen = new Set()) {
  const raw = resolveExpr(text, vars, slider, seen).trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(raw)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  const fn = /^rgba?\(([\s\S]+)\)$/i.exec(raw)
  if (fn) {
    const n = fn[1].split(/[,/]/).map((x) => x.trim())
    const to = (x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x))
    return { r: to(n[0]), g: to(n[1]), b: to(n[2]), a: n[3] != null ? Math.min(1, parseFloat(n[3])) : 1 }
  }
  return null
}

const blend = (fg, bg) => ({
  r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
  g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
  b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
})
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

// 玻璃浓度滑块的三个采样点：全透明 / 默认 / 全不透明
const SLIDERS = [0, 0.4, 1]
const TIERS = [
  ['--color-text', 'text'],
  ['--color-text-secondary', 'secondary'],
  ['--color-text-muted', 'muted'],
]
const SURFACES = ['--color-bg', '--color-surface', '--color-surface-hover']

function collect(files, matcher) {
  const vars = {}
  for (const f of files) {
    for (const b of blocksOf(f)) if (matcher(b.selector)) Object.assign(vars, b.decls)
  }
  return vars
}

for (const sc of SCENES) {
  const vars = collect(sc.files, sc.match)

  test(`${sc.label}：弱化 / 次要 / 正文 三档都过 AAA，且梯度不塌`, () => {
    const worst = {}
    for (const slider of SLIDERS) {
      const bg = parseColor(vars['--color-bg'], vars, slider)
      assert.ok(bg, `${sc.label} 取不到 --color-bg`)
      const surfaces = {}
      for (const s of SURFACES) {
        const c = parseColor(vars[s], vars, slider)
        if (c) surfaces[s] = c.a != null && c.a < 1 ? blend(c, bg) : c
      }
      for (const [token, tier] of TIERS) {
        const fg = parseColor(vars[token], vars, slider)
        assert.ok(fg, `${sc.label} 取不到 ${token}`)
        for (const [s, bgc] of Object.entries(surfaces)) {
          const r = ratio(fg, bgc)
          const key = `${tier}/${s}`
          if (!(key in worst) || r < worst[key].r) worst[key] = { r, token, s, slider }
        }
      }
    }
    // 每档取所有底面里最低的那个比值
    const minOf = (tier) => Object.entries(worst)
      .filter(([k]) => k.startsWith(`${tier}/`))
      .map(([, v]) => v)
      .reduce((a, v) => (v.r < a.r ? v : a))
    const t = minOf('text'), s = minOf('secondary'), m = minOf('muted')
    const min = (v) => v.token.replace('--color-', '') + ' vs ' + v.s.replace('--color-', '') + `（slider=${v.slider}）`

    assert.ok(m.r >= sc.expect.muted, `${sc.label} 弱化文字 ${min(m)} 只有 ${m.r.toFixed(2)}:1（应 ≥ ${sc.expect.muted}）`)
    assert.ok(s.r >= sc.expect.secondary, `${sc.label} 次要文字 ${min(s)} 只有 ${s.r.toFixed(2)}:1（应 ≥ ${sc.expect.secondary}）`)
    assert.ok(t.r >= sc.expect.primary, `${sc.label} 正文 ${min(t)} 只有 ${t.r.toFixed(2)}:1（应 ≥ ${sc.expect.primary}）`)
    // 梯度：次要必须明显高于弱化，正文必须明显高于次要
    assert.ok(s.r - m.r >= 0.2, `${sc.label} 次要(${s.r.toFixed(2)}) 与弱化(${m.r.toFixed(2)}) 梯度不足，层级会糊成一层`)
    assert.ok(t.r - s.r >= 0.5, `${sc.label} 正文(${t.r.toFixed(2)}) 与次要(${s.r.toFixed(2)}) 梯度不足`)
  })
}

// 说明：语义色 / 主色属于「主题色」，按产品要求保持原值、不纳入 AAA 闸门；
// 本测试只守三档文字（正文 / 次要 / 弱化）的对比度与梯度。
