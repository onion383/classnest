// =========================================================================
// activities-import-undo-key.test.js —— 切标签撤销记错历史栈（3-9 / #49）
//
// 原缺陷：onImportData 导入 await 期间用户切标签，recordRowsBatchInsert 用动态
// resolveKey()（读 activeTab）→ 活动导入的撤销记进 countdowns 栈。
// 修法：异步前捕获稳定 undoKey，登记用它。
//
// 判据：源码接线 + 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/ActivitiesView.vue'), 'utf8')
const body = src.slice(src.indexOf('async function onImportData'), src.indexOf('function goAlbum'))

test('onImportData 异步前捕获稳定 undoKey，登记用捕获值', () => {
  const cap = body.indexOf('const undoKey = resolveKey()')
  const req = body.indexOf('await axios.post')
  const rec = body.indexOf('recordRowsBatchInsert(')
  assert.ok(cap >= 0, '未捕获稳定 undoKey')
  assert.ok(cap < req, 'undoKey 必须在异步请求之前捕获')
  assert.match(body, /recordRowsBatchInsert\(undoKey, res\.data\?\.created\)/, '登记要用捕获的 undoKey')
  assert.ok(rec > req, '登记在异步之后')
})

test('resolveKey 本身仍是动态的（快捷键按当前 tab 走，不能改它）', () => {
  assert.match(src, /const resolveKey = \(\) => \(activeTab\.value === 'countdown' \? 'countdowns' : 'activities'\)/)
})

test('变异反证：改回动态 resolveKey 后判据失败', () => {
  const mutated = body.replace('recordRowsBatchInsert(undoKey, res.data?.created)', 'recordRowsBatchInsert(resolveKey(), res.data?.created)')
  assert.ok(mutated !== body, '变异没匹配到登记调用')
  assert.doesNotMatch(mutated, /recordRowsBatchInsert\(undoKey,/, '变异后判据应失败')
})
