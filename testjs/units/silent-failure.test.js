// =========================================================================
// silent-failure.test.js —— 静默失败/假成功（v8 审查 A-5：E02-07 / F02-02 / F02-06 / F02-10 / K03-14）
//
// 共同点：失败被当成「成功 / 空数据 / 用户取消」收尾，用户看不到也查不到。
// 判据：源码必须保留「失败 → 可见反馈 / 不关闭弹窗 / 回传真实条数」的分支。
// 变异反证：把 catch 改回 `_` 吞掉、把 customExport 改回无条件 close、
// 把 forwardDemand 改回 `return ids.length`，本文件必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('E02-07 app:// 静态资源缺文件回 404，不再返回错误流', () => {
  const src = read('electron/main/main.protocol.js')
  assert.match(src, /stream\.once\('open', resolve\)/)
  assert.match(src, /stream\.once\('error', reject\)/)
  assert.match(src, /status: notFound \? 404 : 500/)
  assert.match(src, /stream\.on\('error', \(\) => \{/)
})

test('F02-02 zip 导出的 customExport 必须回传 saved，取消不关弹窗', () => {
  const dlg = read('student-frontend/src/components/import-export/ExportExcel/ExportExcel.vue')
  assert.match(dlg, /const saved = await props\.customExport\(/)
  assert.match(dlg, /if \(saved\) \{\s*reportProgress\(100\)[\s\S]*?close\(\)/)
  assert.match(read('student-frontend/src/components/data-manage/DataExportPanel.vue'), /return saved/)
  assert.match(read('student-frontend/src/views/FeeManagement.vue'), /return saved/)
})

test('F02-06 聊天记录导出失败带出后端可读原因', () => {
  const src = read('student-frontend/src/components/data-manage/ExportChatDialog.vue')
  assert.match(src, /err\.response\.data\.error/)
  assert.match(src, /notifyError\(msg \? '导出失败：' \+ msg/)
})

test('F02-10 读取失败要给出错误反馈，不能伪装成空数据', () => {
  const dm = read('student-frontend/src/components/data-manage/DataManageDialog.vue')
  assert.match(dm, /loadConversations[\s\S]*?catch \(err\)[\s\S]*?notifyError\(errMsg\(err\)\)/)
  assert.match(dm, /loadSkills[\s\S]*?catch \(err\)[\s\S]*?notifyError\(errMsg\(err\)\)/)

  const chat = read('student-frontend/src/components/data-manage/ExportChatDialog.vue')
  assert.match(chat, /notifyError\(msg \? '读取聊天记录失败：' \+ msg/)

  const tokens = read('student-frontend/src/components/data-manage/McpTokensDialog.vue')
  assert.match(tokens, /notify\.error\([\s\S]*?读取令牌失败/)

  for (const rel of [
    'student-frontend/src/components/dialogs/DutyBackfillDialog.vue',
    'student-frontend/src/components/dialogs/SeatBackfillDialog.vue',
  ]) {
    const src = read(rel)
    assert.match(src, /let loadFailed = false/)
    assert.match(src, /if \(!list\.length && loadFailed\) useNotification\(\)\.error/)
    assert.match(src, /读取本周记录失败，请重试/)
  }
})

test('K03-14 forwardDemand 回传实际转发条数并记录被截数量', () => {
  const src = read('student-backend/scanWorker.js')
  assert.match(src, /const batch = ids\.slice\(0, 500\)/)
  assert.match(src, /ids\.length > batch\.length/)
  assert.match(src, /return batch\.length/)
  assert.doesNotMatch(src, /return ids\.length/)
})
