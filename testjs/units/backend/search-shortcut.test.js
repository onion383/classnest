// =========================================================================
// search-shortcut.test.js —— 全局搜索快捷键 Ctrl/Cmd+K 的判据
// 纯函数判定 + App.vue 接线；变异反证确认「判定逻辑改坏 / 接线删掉」都能被抓到。
// =========================================================================
const { test } = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC = abs('student-frontend/src')
const APP = fs.readFileSync(path.join(SRC, 'App.vue'), 'utf8')

test('纯函数：Ctrl+K / Cmd+K 命中，大小写与非 k 键不命中', async () => {
  const { isGlobalSearchShortcut } = await import(pathToFileURL(path.join(SRC, 'utils/searchShortcut.js')).href)
  const k = (over = {}) => ({ key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true })), true, 'Ctrl+K')
  assert.equal(isGlobalSearchShortcut(k({ metaKey: true })), true, 'Cmd+K')
  assert.equal(isGlobalSearchShortcut(k({ key: 'K', ctrlKey: true })), true, '大小写不敏感')
  assert.equal(isGlobalSearchShortcut(k()), false, '无修饰键不命中')
  assert.equal(isGlobalSearchShortcut(k({ key: 'j', ctrlKey: true })), false, '别的键不命中')
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, shiftKey: true })), false, '带 Shift 不命中')
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, altKey: true })), false, '带 Alt 不命中')
  assert.equal(isGlobalSearchShortcut(null), false, '空事件不炸')
  // V9-F01-05：输入框 / 可编辑区里不抢快捷键
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, target: { tagName: 'INPUT' } })), false, '输入框里不弹搜索')
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, target: { tagName: 'TEXTAREA' } })), false)
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, target: { isContentEditable: true, tagName: 'DIV' } })), false)
  assert.equal(isGlobalSearchShortcut(k({ ctrlKey: true, target: { tagName: 'DIV' } })), true, '普通区域仍要响应')
})

test('App.vue 接线：登录页屏蔽、阻止默认行为、预取并打开搜索弹窗', () => {
  const fn = APP.match(/function onGlobalSearchKeydown\(e\)[\s\S]*?\n\}/)
  assert.ok(fn, '找不到快捷键处理函数')
  assert.match(fn[0], /route\.path === '\/login'/, '登录页不响应')
  assert.match(fn[0], /isGlobalSearchShortcut\(e\)/, '复用纯函数判定')
  assert.match(fn[0], /e\.preventDefault\(\)/, '拦掉浏览器默认的 Ctrl+K')
  assert.match(fn[0], /preloadSearchDialog\(\)/, '打开前预取组件')
  assert.match(fn[0], /searchOpen\.value = true/, '置开搜索弹窗')
})

test('App.vue 接线：再按一次收起搜索弹窗（toggle）', () => {
  const fn = APP.match(/function onGlobalSearchKeydown\(e\)[\s\S]*?\n\}/)
  assert.ok(fn, '找不到快捷键处理函数')
  const body = fn[0]
  assert.match(body, /if \(searchOpen\.value\)[\s\S]*?searchOpen\.value = false[\s\S]*?return/, '已开时先收起并提前返回')
  // 关闭分支必须 return 在预取之前，否则每次收起都白触发一次组件预取
  const closeAt = body.search(/searchOpen\.value = false/)
  const preloadAt = body.search(/preloadSearchDialog\(\)/)
  const openAt = body.search(/searchOpen\.value = true/)
  assert.ok(closeAt < preloadAt && preloadAt < openAt, '顺序应为：收起分支 → 预取 → 打开')
})

test('App.vue 用 disposables 注册全局监听（卸载自动摘）', () => {
  assert.match(APP, /disposables\.listen\(window, 'keydown', onGlobalSearchKeydown\)/, '必须登记进 disposables')
  assert.match(APP, /import \{ isGlobalSearchShortcut \} from '\.\/utils\/searchShortcut\.js'/)
})
