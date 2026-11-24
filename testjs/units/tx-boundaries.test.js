// =========================================================================
// tx-boundaries.test.js —— 事务边界（v8 审查 B-9：K01-06 / K01-08 / N3-13 / Q2-14）
//
// 判据（结构守卫，配合已有行为用例）：
//   K01-06 活动导入的序号读取 + 批量插入在同一 db.transaction 内；
//   K01-08 首添模型插入后走 activateModel 收敛，避免并发双 active；
//   N3-13 会话名单落盘走 tmp+rename，崩溃不留半截 JSON；
//   Q2-14 批量写逐项把 undoId 绑到 proposal（失败前已写项也能撤回）。
// 变异反证：把事务/原子写/逐项绑定改回去，本文件必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('K01-06 活动导入：maxPosition 与 insertMany 在同一事务内', () => {
  const src = read('student-backend/routes/activities.js')
  const fn = src.slice(src.indexOf("router.post('/import'"), src.indexOf('module.exports = router'))
  assert.match(fn, /db\.transaction\(\(\) => \{[\s\S]*maxPosition\('activities'\)[\s\S]*insertMany\(list\)[\s\S]*\}\)\(\)/,
    '序号读取与批量插入必须包进同一事务')
})

test('K01-08 首添模型：插入后走 activateModel 事务收敛', () => {
  const src = read('student-backend/routes/ai/ai.config.js')
  const fn = src.slice(src.indexOf("router.post('/models'"), src.indexOf("router.put('/models/:id/active'"))
  assert.match(fn, /if \(isActive\) aiConfigStore\.activateModel\(info\.lastInsertRowid\)/,
    '首个模型激活必须复用「先清其余再置目标」的事务')
})

test('N3-13 会话名单：落盘走 tmp + rename，不再直接截断写', () => {
  const src = read('student-backend/services/sessions.js')
  const fn = src.slice(src.indexOf('function save()'), src.indexOf('// 清理名单'))
  assert.match(fn, /const tmp = `\$\{file\}\.tmp-/)
  assert.match(fn, /fs\.writeFileSync\(tmp/)
  assert.match(fn, /fs\.renameSync\(tmp, file\)/)
  assert.doesNotMatch(fn, /fs\.writeFileSync\(FILE\(\)/)
})

test('P3-05 成绩导入：同批学号/姓名只解析一次（批内缓存）', () => {
  const src = read('student-backend/routes/scores.js')
  const fn = src.slice(src.indexOf("router.post('/import'"), src.indexOf('module.exports = router'))
  assert.match(fn, /const xuehaoCache = new Map\(\)/)
  assert.match(fn, /const nameCache = new Map\(\)/)
  assert.match(fn, /const byXuehao = resolveXuehao\(xuehao\)/)
  assert.match(fn, /const r = resolveName\(name\)/)
  assert.doesNotMatch(fn, /const byXuehao = scoreStore\.findStudentsByXuehao\(xuehao\)/, '不能每行都点查学号')
})

test('Q2-14 AI 批量写：逐项成功即把 undoId 绑到 proposal', () => {
  const src = read('student-frontend/src/composables/ai/aiExec.js')
  assert.match(src, /const undoIds = \(m\.proposal\.undoIds = /, 'undoIds 必须直接绑到 proposal')
  // 批量新增 / 批量删除两段都要逐项 push（全局至少两处，且不在「全部成功后才赋值」的分支里）
  const pushes = src.match(/if \(uid != null\) undoIds\.push\(uid\)/g) || []
  assert.ok(pushes.length >= 2, `批量新增与删除都要逐项绑定，实际 ${pushes.length} 处`)
  assert.match(src, /m\.proposal\.undoIds = undoIds/)
})
