// =========================================================================
// splash-ring-shadow.test.js —— 占位加载页圈圈不能被 Tailwind .ring 工具类套上黑框
//
// 事故面：占位页 <svg class="ring"> 的 ring 是 splash.css 私有类名，恰好撞上 Tailwind
// 的 .ring 工具类。主 CSS 非阻塞加载，加载完成那一刻 Tailwind .ring 命中这个 svg，
// 用 currentcolor 画一圈 box-shadow（深色下就是黑框），紧接着占位页被移除 —— 表现为
// 「最后一刻圈圈外冒出黑框」。判据盯住撞名仍在时必须有更高特异性的守卫。
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '../../student-frontend')
const css = fs.readFileSync(path.join(SRC, 'splash/splash.css'), 'utf8')
const html = fs.readFileSync(path.join(SRC, 'splash/splash.html'), 'utf8')

test('占位页圈圈仍用 class="ring"（撞名前提成立）', () => {
  assert.match(html, /<svg class="ring"/, '圈圈标记变了则本判据失效，需重新评估')
})

test('splash.css 用更高特异性显式关掉 .ring 的 box-shadow', () => {
  // Tailwind .ring 是 0-1-0；守卫必须 0-2-0（.app-splash .ring）才压得住
  assert.match(
    css,
    /\.app-splash \.ring\s*\{[^}]*box-shadow:\s*none/,
    '缺少 .app-splash .ring { box-shadow: none } 守卫，Tailwind .ring 会给圈圈画黑框',
  )
})

test('切到夜间后圈圈的描边规则还在，守卫没误伤主题配色', () => {
  assert.match(css, /:root\[data-mode="night"\][^{]*\.app-splash \.ring circle:not\(\.spin\)/)
  assert.match(css, /:root\[data-mode="night"\][^{]*\.app-splash \.ring \.spin/)
})
