// =========================================================================
// duty-settings-hydrate.test.js —— 值日设置弹窗「首次打开即初始化」
// 运行：npm run test:units
//
// 故障（2026-11-11）：重启后第一次打开「值日设置」，星期一个都没勾、劳动项目全空，
// 和表格里已有的设置对不上；关掉再开一次就正常。
// 根因：父组件用 `v-if="settingsMounted"` 懒挂载，而 settingsMounted 是在 visible 变 true
// 的同一个 flush 里置真的 —— 首次挂载时 props.visible 已经是 true，没有 false→true 的变化，
// 不带 immediate 的 watch 一次都不会跑，本地副本停在空数组。
//
// 判据读真实源码：去掉 immediate 即红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const FE = 'student-frontend/src'
const DUTY_VIEW = `${FE}/views/DutyView.vue`
const SETTINGS_DIALOG = `${FE}/components/dialogs/DutySettingsDialog.vue`
const WEIGHT_DIALOG = `${FE}/components/dialogs/DutyWeightAlgorithmDialog.vue`

// 去掉注释再匹配：注释里也可能写到 `watch(...)`，会制造假绿
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

test('父组件是「懒挂载」：settingsMounted 由 visible 变 true 触发', () => {
  const s = stripComments(read(DUTY_VIEW))
  // 前提断言：若哪天改成常驻挂载，本文件的 immediate 判据就失去意义，需要一起复核
  assert.match(s, /v-if="settingsMounted"/, '值日设置弹窗应按 mounted 标记懒挂载')
  assert.match(s, /watch\(\(\) => settingsVisible\.value, v => \{ if \(v\) settingsMounted\.value = true \}\)/)
})

test('值日设置弹窗：visible watch 必须 immediate（首次挂载时 visible 已为 true）', () => {
  const s = stripComments(read(SETTINGS_DIALOG))
  // watch 回调里是本地副本初始化（localDays / localItems / localConfig）
  assert.match(s, /localDays\.value = \[\.\.\.props\.days\]/)
  assert.match(s, /localItems\.value = props\.items\.map/)
  // 关键判据：这个 watch 必须带 { immediate: true }，否则首次打开看到的全是空
  assert.match(
    s,
    /watch\(\(\) => props\.visible,[\s\S]{0,2000}?\}, \{ immediate: true \}\)/,
    'DutySettingsDialog 的 visible watch 缺少 immediate：懒挂载首次打开不会初始化'
  )
})

test('权重算法弹窗：visible watch 同样必须 immediate', () => {
  const s = stripComments(read(WEIGHT_DIALOG))
  assert.match(s, /watch\(\(\) => props\.visible, \(v\) => \{ if \(v\) resetDefaults\(\) \}, \{ immediate: true \}\)/)
  // 父组件也是懒挂载，所以前提同值日设置弹窗
  const view = stripComments(read(DUTY_VIEW))
  assert.match(view, /v-if="weightAlgoMounted"/)
})
