// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// shape-errors.test.js —— 响应形状 / 失败与空结果区分（v8 审查 B-5）
//
// 覆盖：F06-03（关联预览失败不得当无关联）、K01-14（DB_LOCKED → 401）、
//       K03-01/02/03（不存在 id 必须 404）、Q2-07（座位快照带 types）。
// 变异反证：把 catch 改回空吞 / 去掉 changes 判 0 / 快照退回纯数组，本文件必须红。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const path = require('node:path')


test('F06-03 学生删除：关联预览失败必须提示并中止，不能当「无关联」直删', () => {
  const src = read('student-frontend/src/views/ClassroomView.vue')
  const fn = src.slice(src.indexOf('async function deleteStudent'), src.indexOf('const finish = async'))
  assert.match(fn, /catch \(err\) \{[\s\S]*?notifyError\([\s\S]*?return/)
  assert.doesNotMatch(fn, /预览失败按/, '不能保留「失败按无关联处理」的注释与行为')
})

test('K01-14 导出：DB_LOCKED 归一为 401', () => {
  const src = read('student-backend/routes/account.js')
  const fn = src.slice(src.indexOf('async function resolveExportKeying'), src.indexOf('function') === -1 ? undefined : src.indexOf('// 备份导出 v3'))
  assert.match(fn, /code === 'DB_LOCKED'/)
  assert.match(fn, /status: 401/)
  assert.match(fn, /exportBundle\(slug\)/)
})

test('K03-01/02/03：按 id 写/删不存在时必须 404', () => {
  // V9-2-5：buildUpdate/removeById 移进 writeWithUndo 事务（见 () => buildUpdate(...)），
  // 前缀不再是 const result =，但「用 buildUpdate 写 + changes===0→404」两要素不变。
  const scores = read('student-backend/routes/scores.js')
  assert.match(scores, /=> buildUpdate\('score_records', row, req\.params\.id\),[\s\S]*?changes === 0\) return res\.status\(404\)/)

  const leaves = read('student-backend/routes/leaves.js')
  assert.match(leaves, /=> buildUpdate\('leave_records', row, req\.params\.id\),[\s\S]*?changes === 0\) return res\.status\(404\)/)
  assert.match(leaves, /=> leaveStore\.removeById\([\s\S]*?changes === 0\) return res\.status\(404\)/)

  const cadres = read('student-backend/routes/cadres.js')
  // V9-2-5：删除移进 writeWithUndo 事务，404 改为 findMember 预检 + 事务内 changes===0 双保险
  assert.match(cadres, /const existing = cadreStore\.findMember\(id\);[\s\S]*?res\.status\(404\)/)
  const cadreStore = read('student-backend/services/cadreStore.js')
  assert.match(cadreStore, /function deleteMember\(id\) \{[\s\S]*?return db\.prepare\('DELETE FROM cadre_members/)
})

test('X1-03 IPC invoke 拒绝时必须 reject，不能 resolve(undefined)', () => {
  const src = read('electron/main/main.ipc-auth.js')
  const handle = src.slice(src.indexOf('ipcMain.handle = '), src.indexOf('ipcMain.on = '))
  assert.match(handle, /if \(!checkSender\(channel, event\)\) throw new Error\('IPC 通道未授权'\)/)
  assert.doesNotMatch(handle, /checkSender\(channel, event\)\) return undefined/)
})

test('X3-02 分组维度请求体不再上送后端没有的 name_rule', () => {
  const src = read('student-frontend/src/views/GroupManageView.vue')
  assert.doesNotMatch(src, /body: JSON\.stringify\(addDimForm\)/)
  assert.doesNotMatch(src, /body: JSON\.stringify\(form\)/)
  assert.match(src, /name: addDimForm\.name, leader_title: addDimForm\.leader_title/)
  assert.match(src, /name: form\.name, leader_title: form\.leader_title/)
})

test('F07-05 课表 adjustCells 双向对齐：超长行要裁掉', () => {
  const src = read('student-frontend/src/views/ScheduleView/ScheduleView.common.js')
  assert.match(src, /return row\.slice\(0, dayCount\)/)
})

test('F07-03 权重交换：含走廊或空位格的行/列都不可交换', () => {
  const src = read('student-frontend/src/views/SeatView.vue')
  assert.match(src, /const blockedRow = \(r\) => \(weightTypes\.value\[r\] \|\| \[\]\)\.some\(v => v === CELL\.AISLE \|\| v === CELL\.BLANK\)/)
  assert.match(src, /const colBlocked = \(c\) =>[\s\S]*?CELL\.AISLE \|\| line\[c\] === CELL\.BLANK/)
})

test('K02-05 MCP 工具错误对外脱敏，业务错误保留', () => {
  // mcp.server 会拉起 dbManager（要求主密钥 / 数据目录），这里给隔离的最小环境
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'shape-errors-test-key'
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'cn-shape-errors')
  const { publicToolError } = require('../../../student-backend/routes/ai/mcp/mcp.server')
  assert.equal(publicToolError('未找到该数据表'), '未找到该数据表')
  assert.match(publicToolError('SQLITE_ERROR: no such table: x'), /内部错误/)
  assert.match(publicToolError('ENOENT: no such file, open C:\\Users\\a\\db.sqlite'), /内部错误/)
  assert.match(publicToolError('    at foo (D:\\app\\x.js:10:3)'), /内部错误/)
})

test('Q2-07 座位整块快照必须带 types（否则撤销无法回写几何）', () => {
  const src = read('student-frontend/src/views/SeatView.vue')
  // @pin student-frontend/src/views/SeatView.vue#gridSnapshotOf
  assert.match(src, /function gridSnapshotOf\(grid\)/)
  assert.match(src, /types: \(grid\.types\.value \|\| \[\]\)\.map/)
  const calls = src.match(/recordGridSnapshotUndo\('座位表'[\s\S]{0,220}?\)/g) || []
  assert.ok(calls.length >= 4, `四处整块登记都要用快照对象，实际 ${calls.length}`)
  for (const c of calls) {
    assert.doesNotMatch(c, /before, next, '从表格导入'/, '不能退回只传 seats 数组')
    assert.doesNotMatch(c, /before, nextSeats, '智能排表'/, '不能退回只传 seats 数组')
  }
})
