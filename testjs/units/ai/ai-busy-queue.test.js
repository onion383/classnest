// =========================================================================
// ai-busy-queue.test.js —— 忙碌队列丢附件 + 部分失败无法撤回（3-4 / #17）
//
// 原缺陷①：send 入队只存 text，排队期间的附件/图片在 sendNextQueued 时丢失。
// 原缺陷②：aiExec 逐项写入把 undo ID 存局部变量，只在全部成功后赋给 proposal；
//   中途失败走 catch（executed=false + undoIds 未赋值）→ 已落盘的行无法撤回。
// 修法①：入队存 file，出队恢复 attachedFile；② undoIds 直接绑 proposal，
//   catch 里按 undoIds 长度标 partial + executed=true 保留撤回入口。
//
// 判据：源码接线 + 变异反证。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const CHAT = fs.readFileSync(abs('student-frontend/src/composables/ai/aiChat.js'), 'utf8')
const EXEC = fs.readFileSync(abs('student-frontend/src/composables/ai/aiExec.js'), 'utf8')

test('入队保留附件，出队恢复 attachedFile', () => {
  // 入队对象里有 file 字段
  const enqueue = CHAT.slice(CHAT.indexOf('ctx.queuedMessages.value.push('), CHAT.indexOf('ctx.input.value', CHAT.indexOf('ctx.queuedMessages.value.push(')))
  assert.match(enqueue, /file: file \|\| null/, '入队必须存附件')
  // 出队恢复
  assert.match(CHAT, /ctx\.attachedFile\.value = q\.file \|\| null/, '出队必须恢复附件')
})

test('aiExec 逐项写入的 undoIds 直接绑到 proposal（部分成功也留得住）', () => {
  assert.match(EXEC, /const undoIds = \(m\.proposal\.undoIds = Array\.isArray\(m\.proposal\.undoIds\)/,
    '逐项写入的 undoIds 要绑到 proposal，不能只存局部变量')
})

test('catch 按已登记撤销数标 partial，保留撤回入口', () => {
  const catchBody = EXEC.slice(EXEC.indexOf('} catch (err) {', EXEC.indexOf('async executeProposal')), EXEC.indexOf('const msg = err.response'))
  assert.match(catchBody, /const partial = Array\.isArray\(m\.proposal\.undoIds\) && m\.proposal\.undoIds\.length > 0/,
    '要按已成功项的撤销数判断部分成功')
  assert.match(catchBody, /m\.proposal\.executed = partial/, '部分成功要保留 executed=true')
  assert.match(catchBody, /m\.proposal\.partial = partial/, '要标 partial')
})

test('变异反证：恢复附件/保留 undoIds 去掉后判据失败', () => {
  const noFile = CHAT.replace('file: file || null,', '/* 丢附件 */')
  assert.ok(noFile !== CHAT, '变异没匹配到入队附件')
  assert.doesNotMatch(noFile, /file: file \|\| null/, '变异后附件判据应失败')
  const noBind = EXEC.replace('const undoIds = (m.proposal.undoIds = Array.isArray(m.proposal.undoIds) ? m.proposal.undoIds : [])', 'const undoIds = []')
  assert.ok(noBind !== EXEC, '变异没匹配到 undoIds 绑定')
  assert.doesNotMatch(noBind, /const undoIds = \(m\.proposal\.undoIds =/, '变异后撤销绑定判据应失败')
})
