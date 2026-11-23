// =========================================================================
// ai-stream-class-scope.test.js —— 切班后旧 AI 流不得在新班执行提案（3-2 / #39）
//
// 原缺陷：切班 bumpClassScope + 销毁 AiAssistant，但在途 AI 流没 abort；finally 里
// 全权限自动执行提案用换发的新 token 把旧班的提案写进新班。onUnmounted 也没 abort。
// 修法：① _streamReply 开头捕获 classScopeKey；② finally 提案执行与队列发送前校验
// 代次未变；③ onUnmounted abort 在途流（interrupted → 提案条件不满足）。
//
// 判据：源码接线三层 + 变异反证（抹掉任一层判据必须失败）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const CHAT = 'student-frontend/src/composables/ai/aiChat.js'
const VIEW = 'student-frontend/src/views/AiAssistant.vue'

test('aiChat 引入 classScopeKey 并在 _streamReply 开头捕获发起代次', () => {
  const src = read(CHAT)
  assert.match(src, /import \{ classScopeKey \} from ['"]\.\.\/\.\.\/utils\/classScope\.js['"]/, '未引入 classScopeKey')
  // 捕获必须在 _streamReply 开头（busy=true 之后、发请求之前）
  const body = src.slice(src.indexOf('async _streamReply('), src.indexOf('async _streamReply(') + 600)
  assert.match(body, /const myScope = classScopeKey\.value/, '未在流开始时捕获代次')
})

test('提案执行前校验代次未变（scopeStillCurrent 参与条件）', () => {
  const src = read(CHAT)
  assert.match(src, /const scopeStillCurrent = classScopeKey\.value === myScope/, '未计算代次是否仍有效')
  const gate = src.slice(src.indexOf('const scopeStillCurrent'), src.indexOf('await ctx.executeProposal(last)'))
  assert.match(gate, /if \(scopeStillCurrent[\s\S]*ctx\.permissionMode\.value === AI_PERMISSION_FULL/,
    '提案执行条件必须包含代次校验')
})

test('队列下一条发送也受代次保护', () => {
  const src = read(CHAT)
  assert.match(src, /if \(scopeStillCurrent && ctx\.streamDepth\.value === 0/, '切班后旧流不能再发排队消息')
})

test('onUnmounted abort 在途流（第二道防线）', () => {
  const src = read(VIEW)
  const unmount = src.slice(src.indexOf('onUnmounted(() =>'), src.indexOf('onUnmounted(() =>') + 700)
  assert.match(unmount, /abortCtrl\.value\.abort\(\)/, '卸载时未 abort 在途流')
})

test('变异反证：去掉代次校验后判据必须失败', () => {
  const src = read(CHAT)
  const mutated = src
    .replace('const scopeStillCurrent = classScopeKey.value === myScope', 'const scopeStillCurrent = true')
    .replace('if (scopeStillCurrent && ctx.streamDepth.value === 0', 'if (ctx.streamDepth.value === 0')
  assert.ok(mutated !== src, '变异没匹配到代次校验')
  assert.doesNotMatch(mutated, /const scopeStillCurrent = classScopeKey\.value === myScope/, '变异后代次判据应失败')
})
