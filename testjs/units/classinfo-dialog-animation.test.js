// =========================================================================
// classinfo-dialog-animation.test.js —— 班级设置弹窗必须走通用 dialog 动画
//
// 事故面：该弹窗曾自写一套 scale(0.985) 的 scoped 动画盖掉通用 dialogCardIn，
// 进场近乎看不出，且各主题观感不一致（glass 有回弹、base/glass2 没有）。
// 判据盯住「不自建覆盖 + 仍挂通用 dialog-card + 仍引入通用动画样式」。
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '../../student-frontend/src/components/dialogs/ClassInfoDialog.vue')
const s = fs.readFileSync(SRC, 'utf8')

test('班级设置弹窗挂通用 dialog-card，由 DialogShell 的 Transition 驱动', () => {
  const root = s.match(/<div class="([^"]*dialog-card[^"]*)"/)
  assert.ok(root, '弹窗卡片必须带 dialog-card 才有通用进/离场动画')
  assert.doesNotMatch(root[1], /class-switch-card/, '私有的 class-switch-card 已删，不应残留')
})

test('不再用 scoped 动画覆盖通用动画', () => {
  assert.doesNotMatch(s, /classSwitchCardIn|classSwitchCardOut/, '自写的极轻微动画必须删掉')
  assert.doesNotMatch(s, /@keyframes[^{]*classSwitch/, '不该再留自定义关键帧')
  const style = s.slice(s.indexOf('<style scoped>'))
  assert.doesNotMatch(style, /\.dialog-card\s*\{[^}]*animation/, '不能给 dialog-card 再写 animation 覆盖通用规则')
})

test('仍引入通用动画样式并提供通用卡片动画所需的类', () => {
  assert.match(s, /import '\.\.\/\.\.\/styles\/dialog-transition\.css'/, '必须引入通用动画样式')
  assert.match(s, /<DialogShell[\s\S]*?visible="visible"/, '外层仍由 DialogShell 的 Transition 统一驱动')
})
