// =========================================================================
// dev-subwindow-identity.test.js —— dev 子窗口加载前必须校验页面身份
//
// 根因：loadUrlWithRetry 只认 HTTP 200 就 loadURL；dev 端口被别的程序占住时，
// 加载的是第三方页面，而 preload 已注入 window.electron（含 get-master-key）——
// 能力暴露给陌生页面。主窗口的 pollViteAndNavigate 有 looksLikeOurVite 校验，
// 子窗口（setup/migration/widget/desktop-widget）漏了同一道防线。
// 修法：抽 looksLikeOurVitePage（认 Vite 的 type=module src=/src/ 入口），
// loadUrlWithRetry 校验响应体，不过就继续重试、绝不导航。
//
// 判据：①真跑 looksLikeOurVitePage 验本项目各 dev 页面通过、第三方页面被拒；
//       ②静态核验 loadUrlWithRetry 在 loadURL 前校验、失败走 retry 不导航。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const LOADER = abs('electron/main/main.dev-loader.js')
const src = fs.readFileSync(LOADER, 'utf8')
const { extractFunctionInner } = require('#testjs/units/_mechanism.cjs')

function loadChecker() {
  return new Function('html', extractFunctionInner(src, 'looksLikeOurVitePage'))
}

test('真跑身份校验：本项目各 dev 子页面通过', () => {
  const check = loadChecker()
  const pages = ['widget', 'setup', 'migration', 'desktop-widget']
  for (const name of pages) {
    const html = fs.readFileSync(abs(`student-frontend/${name}.html`), 'utf8')
    assert.equal(check(html), true, `${name}.html 应被识别为本项目页面`)
  }
  // index.html 走主窗口的另一条判据，但子页面判据也应认它的 Vite 入口
  assert.equal(check(fs.readFileSync(abs('student-frontend/index.html'), 'utf8')), true)
})

test('真跑身份校验：第三方页面 / 假 200 一律拒绝', () => {
  const check = loadChecker()
  for (const html of [
    '<html><body>别人的网站</body></html>',
    '<script type="module" src="/attacker/main.js"></script>', // 不是 /src/ 前缀
    '<script src="/src/main.js"></script>', // 缺 type=module
    '',
  ]) {
    assert.equal(check(html), false, `第三方页面必须拒绝：${html.slice(0, 40)}`)
  }
})

test('静态：loadUrlWithRetry 校验响应体后才 loadURL，失败走 retry 不导航', () => {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(noComments, /looksLikeOurVitePage\(body\)/, '必须用身份校验判定响应体')
  assert.match(noComments, /res\.statusCode !== 200 \|\| !looksLikeOurVitePage\(body\)/, 'HTTP 状态与身份都要校验')
  // 导航必须在校验分支之后：loadURL 的位置晚于身份判断
  const checkAt = noComments.indexOf('!looksLikeOurVitePage(body)')
  const navAt = noComments.indexOf('win.loadURL(url)')
  assert.ok(checkAt > 0 && navAt > checkAt, '必须先校验身份再导航')
  // 失败分支走 retry（重试/报错），不能残留直接 loadURL
  assert.match(noComments, /if \(res\.statusCode !== 200[\s\S]{0,160}retry\(/, '校验失败走 retry')
  // 主窗口那条防线仍在
  assert.match(noComments, /looksLikeOurVite\(body\)/, '主窗口 pollViteAndNavigate 的校验不能丢')
})

test('四个调用点仍传 dev 子页面 URL，校验覆盖全部子窗口', () => {
  const main = fs.readFileSync(abs('electron/main/main.js'), 'utf8')
  const widget = fs.readFileSync(abs('electron/main/main.widget.js'), 'utf8')
  assert.match(main, /loadUrlWithRetry\(win, ports\.frontendOrigin \+ '\/migration\.html'\)/)
  assert.match(main, /loadUrlWithRetry\(win, ports\.frontendOrigin \+ '\/setup\.html'\)/)
  assert.match(widget, /loadUrlWithRetry\(widgetWindow, ports\.frontendOrigin \+ '\/widget\.html'\)/)
  assert.match(widget, /loadUrlWithRetry\(win, desktopWidgetUrl\(\)\)/)
})
