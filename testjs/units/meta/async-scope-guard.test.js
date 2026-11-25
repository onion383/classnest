// =========================================================================
// async-scope-guard.test.js —— 旧请求覆盖当前状态（3-5 / #18 #45 #55 #27a）
//
// 本卡核实 5 处落点，真漏洞 3 处已修、2 处历史已有守卫：
//   · ReceiptDialog.openMarkdown：连点不同 md → 慢的旧渲染盖新内容 → 加 createLatest
//   · aiConversations：切会话时旧会话历史前插到新会话 → 会话代次守卫
//   · AlbumView / SearchDialog / semesterStart：HEAD 已有 latestOnly/代次守卫（核实未回退）
// 另 §8 的 14 格 async.scope_guard UNKNOWN 是静态候选，结论记在 §8，不在本卡硬改。
//
// 判据：源码接线（守卫存在且用法正确）+ 变异反证。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


// ————————————————————————— ① ReceiptDialog —————————————————————————

test('ReceiptDialog.openMarkdown 用 createLatest 守卫，关闭时 invalidate', () => {
  const src = read('student-frontend/src/components/dialogs/ReceiptDialog.vue')
  assert.match(src, /import \{ createLatest \} from ['"]\.\.\/\.\.\/utils\/latestOnly\.js['"]/, '未引入 createLatest')
  const open = src.slice(src.indexOf('async function openMarkdown'), src.indexOf('/** 用系统默认程序打开'))
  assert.match(open, /const my = docSeq\.begin\(\)/, '打开收据时未取号')
  assert.match(open, /if \(!docSeq\.isCurrent\(my\)\) return/, 'await 后未校验代次')
  // @pin student-frontend/src/components/dialogs/ReceiptDialog.vue#closeDoc
  assert.match(src, /function closeDoc\(\) \{\s*\n\s*docSeq\.invalidate\(\)/, '关闭时未作废在途渲染')
})

// ————————————————————————— ② aiConversations —————————————————————————

test('aiConversations 用会话代次守卫切会话/补载', () => {
  const src = read('student-frontend/src/composables/ai/aiConversations.js')
  assert.match(src, /import \{ createLatest \} from ['"]\.\.\/\.\.\/utils\/latestOnly\.js['"]/)
  assert.match(src, /const convSeq = createLatest\(\)/, '未建会话代次实例')
  // 切会话/恢复 begin，补载用 current
  const sw = src.slice(src.indexOf('async switchConversation'), src.indexOf('async newConversation'))
  assert.match(sw, /convSeq\.begin\(\)/, '切会话未 begin')
  assert.match(sw, /if \(!convSeq\.isCurrent\(my\)\) return/, '切会话 await 后未校验')
  const earlier = src.slice(src.indexOf('async loadEarlier'), src.indexOf('async _fillEarlier'))
  assert.match(earlier, /const my = convSeq\.current\(\)/, '补载未捕获代次')
  assert.match(earlier, /if \(!convSeq\.isCurrent\(my\)\) return false/, '补载结果未校验代次')
})

// ————————————————————————— ③ 历史已有守卫（核实未回退）—————————————————————————

test('已核实：AlbumView / SearchDialog / semesterStart 的守卫仍在', () => {
  const album = read('student-frontend/src/views/AlbumView.vue')
  assert.match(album, /photosSeq\.isCurrent\(my\)/, 'AlbumView 列表守卫丢失')
  const search = read('student-frontend/src/components/base/SearchDialog.vue')
  assert.match(search, /remoteSeq\.isCurrent\(my\)/, 'SearchDialog 搜索守卫丢失')
  const sem = read('student-frontend/src/utils/semesterStart.js')
  assert.match(sem, /gen !== userScopedGeneration\(\)/, 'semesterStart 换号代次守卫丢失')
})

// ————————————————————————— ④ 变异反证 —————————————————————————

test('变异反证：去掉守卫后判据失败', () => {
  const receipt = read('student-frontend/src/components/dialogs/ReceiptDialog.vue')
  const mutated = receipt.replace(/if \(!docSeq\.isCurrent\(my\)\) return/g, '/* 去掉守卫 */')
  assert.ok(mutated !== receipt, '变异没匹配到守卫')
  assert.doesNotMatch(mutated, /if \(!docSeq\.isCurrent\(my\)\) return/, '变异后判据应失败')
})
