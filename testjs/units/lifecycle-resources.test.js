// =========================================================================
// lifecycle-resources.test.js —— 定时器 / 监听器的「创建处 = 销毁处」守卫
//                                （v6 性能专题 · 1-11 + 1-13）
//
// 背景：这两张卡原本是「逐处改成 d.interval / d.listen」。现场复查发现清单列的
//   10 处定时器**全部已成对清理**（含 onActivated/onDeactivated 暂停语义），
//   监听器也没有确认缺失的——数量差都是 `{ once: true }`、元素级、或入口级单例。
//   逐处重写属于纯 churn，回归风险大于收益。所以本卡真正的产物是这道守卫：
//   **新增的资源必须自带释放**，靠规则而不是靠人记。
//
// 规则：
//   ① 定时器：出现 `setInterval(` 就必须有 `clearInterval(`（或走 `d.interval(` 登记）；
//   ② 监听器：`addEventListener(` 的每一处都要被 `removeEventListener(` / `.listen(` /
//      `{ once: true }` / `{ signal }` 之一覆盖；
//   ③ 豁免只给「应用/窗口级单例」，且每个豁免项都必须仍然需要豁免（防止过期白名单）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')

// 应用/窗口级单例：它们的生命周期就是页面或窗口本身，没有「卸载」这一刻。
// 只登记**规则会判红、但确实不能/不需要释放**的位置；每一项都会被「豁免表不过期」反向校验。
const WHITELIST = {
  'main.js': '应用入口：页面生命周期 = 应用生命周期',
  'subwindows/widget/main.js': '工具箱窗口入口，随窗口销毁',
  'subwindows/desktop-widget/main.js': '桌面组件入口，随窗口销毁',
  'utils/inpProbe.js': '仅开发模式的页面级探针，不提供停止入口（进程内单例）',
  'utils/dialogOverlayPulse.js': '遮罩点击的事件委托，初始化一次、页面级',
  'composables/useElasticScroll.js': '当前整体停用（见 main.js 注释）；重新启用前必须补成对移除',
}

const count = (src, re) => (src.match(re) || []).length

// 纯函数：从源码文本算出「未覆盖资源」。测试用它同时审计真实文件与注入样本。
// 监听器只审 window / document 级：元素级监听随元素销毁自动回收，不构成泄漏
//（`table.addEventListener('pointerdown')` 这类导出期临时元素就是典型）。
function audit(src) {
  const timers = count(src, /setInterval\(/g)
  const timerClears = count(src, /clearInterval\(/g)
  const timerRegistered = count(src, /\.interval\(/g)
  const globalAdds = count(src, /(?:window|document(?:\.body)?)\.addEventListener\(/g)
  const listenerClears = count(src, /removeEventListener\(/g)
  const listenerRegistered = count(src, /\.listen\(/g)
  const once = count(src, /\{\s*once:\s*true/g)
  const signal = count(src, /\{\s*signal|\bAbortSignal\b/g)
  const covered = listenerClears + listenerRegistered + once + signal
  return {
    timers,
    uncoveredTimers: timers > 0 && timerClears === 0 && timerRegistered === 0 ? 1 : 0,
    listeners: globalAdds,
    uncoveredListeners: Math.max(0, globalAdds - covered),
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(SRC, p).split(path.sep).join('/')

test('定时器：setInterval 必须成对清理或走 disposables 登记', () => {
  const bad = []
  for (const file of walk(SRC)) {
    const key = rel(file)
    if (WHITELIST[key]) continue
    const r = audit(fs.readFileSync(file, 'utf8'))
    if (r.uncoveredTimers) bad.push(key)
  }
  assert.deepEqual(bad, [], `以下文件有 setInterval 却没有 clearInterval / d.interval：${bad.join(', ')}`)
})

test('监听器：addEventListener 必须被移除、登记、once 或 signal 覆盖', () => {
  const bad = []
  for (const file of walk(SRC)) {
    const key = rel(file)
    if (WHITELIST[key]) continue
    const r = audit(fs.readFileSync(file, 'utf8'))
    if (r.uncoveredListeners > 0) bad.push(`${key}（未覆盖 ${r.uncoveredListeners}）`)
  }
  assert.deepEqual(bad, [], `以下文件有未覆盖的 addEventListener：${bad.join('，')}`)
})

test('豁免表不过期：每一项都存在，且当前确实需要豁免', () => {
  for (const key of Object.keys(WHITELIST)) {
    const file = path.join(SRC, key)
    assert.ok(fs.existsSync(file), `豁免项「${key}」已不存在，必须从白名单删除`)
    const r = audit(fs.readFileSync(file, 'utf8'))
    assert.ok(
      r.uncoveredTimers > 0 || r.uncoveredListeners > 0,
      `豁免项「${key}」现在已经被覆盖，必须从白名单删除`,
    )
  }
})

test('守卫自证：故意注入的裸监听 / 裸定时器必须被判红', () => {
  const bad = 'window.addEventListener("click", fn)\nsetInterval(tick, 1000)'
  const r = audit(bad)
  assert.equal(r.uncoveredListeners, 1)
  assert.equal(r.uncoveredTimers, 1)

  const good = 'window.addEventListener("click", fn); window.removeEventListener("click", fn)\nd.interval(tick, 1000)'
  const g = audit(good)
  assert.equal(g.uncoveredListeners, 0)
  assert.equal(g.uncoveredTimers, 0)

  const once = 'document.addEventListener("transitionend", fn, { once: true })'
  assert.equal(audit(once).uncoveredListeners, 0, 'once 监听无需显式移除')

  // 元素级监听随元素销毁，不算泄漏（导出期临时 <table> 就是这种）
  const elementLevel = 'table.addEventListener("pointerdown", fn)'
  assert.equal(audit(elementLevel).uncoveredListeners, 0, '元素级监听不计入全局泄漏')
})
