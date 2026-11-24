// =========================================================================
// about-update-dialog.test.js —— 版本弹窗的手动安装入口
//
// 新方案：下载完成后不再「重启并安装」，改为「打开安装包」+「去发布页下载」，
// 并明确告知安装包未签名。判据同时核对模板绑定与 script 定义（Vapor 下模板
// 直接可见 setup 函数，但仍需防「@click 写了、函数没定义」的假绿）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.resolve(__dirname, '../../student-frontend/src/views/AboutView.vue')
const code = fs.readFileSync(FILE, 'utf8')
const script = code.slice(code.indexOf('<script setup'))

test('下载完成：两个入口都绑定且 script 里真有对应函数', () => {
  assert.match(code, /@click="installUpdate"/)
  assert.match(code, /@click="openReleasesPage"/)
  assert.match(script, /function installUpdate\(\)/)
  assert.match(script, /function openReleasesPage\(\)/)
  assert.match(script, /window\.electron\?\.send\(SEND\.UPDATE_INSTALL\)/)
})

test('发布页入口走系统浏览器，指向 Releases', () => {
  const fn = /function openReleasesPage\(\)\s*\{[\s\S]*?\n\}/.exec(script)
  assert.ok(fn, '找不到 openReleasesPage 函数体')
  assert.match(fn[0], /INVOKE\.OPEN_EXTERNAL/)
  assert.match(fn[0], /github\.com\/onion383\/classnest\/releases/)
})

test('摘要来源告警：asset-only / size-only 有短文案，模板会渲染', () => {
  assert.match(code, /v-if="digestWarnText"/)
  assert.match(script, /digestWarnText/)
  assert.match(script, /'asset-only'/)
  assert.match(script, /'size-only'/)
  assert.match(script, /s\.digestSource/)
})

test('文案：告知未签名；opened 状态有文案；旧静默安装文案清零', () => {
  assert.match(code, /安装包未签名/)
  assert.match(script, /case 'opened':/)
  assert.ok(!code.includes('重启并安装'))
  assert.ok(!code.includes('重启即可安装'))
})
