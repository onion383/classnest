// =========================================================================
// ai-batch-cascade-undo.test.js —— AI 批量删学生的级联撤销（1-4 / 第二轮 N2）
//
// 原缺陷：AI apply-batch 删学生时调用 purgeStudentRelations 清了 7 处关联，
// 却丢弃返回值；前端 _pushUndoForBatch 一律登记 row_delete（只恢复主表）。
// 撤销后学生回来了，但请假/加分/座位/值日/小组/班干部 6 类关联永久丢失。
// 对照：界面删除路径（student-cascade-delete.test.js）早已登记 student_cascade_delete，
// 撤销执行器 (undo.executors.js:513) 也已存在 —— 正是「一处修了、AI 路径没修」。
//
// 判据：
//   ① 契约：purge 返回的快照字段 == 执行器 undo 需要的 payload 字段；
//   ② 后端接线：delete 分支保留 purge 返回值并带 undoType；
//   ③ 前端接线：_pushUndoForBatch 据 undoType 登记 student_cascade_delete，payload 含 student；
//   ④ 变异反证：抹掉后端返回或前端登记，对应判据必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const BACK_SRC = 'student-backend/routes/ai/ai.dataRoutes.js'
const FRONT_SRC = 'student-frontend/src/composables/ai/aiExec.js'

function bodyBetween(src, startRe, endRe) {
  const lines = src.split(/\r?\n/)
  const s = lines.findIndex((l) => startRe.test(l))
  assert.ok(s >= 0, `未找到起始 ${startRe}`)
  const out = []
  for (let i = s; i < lines.length; i += 1) {
    out.push(lines[i])
    if (i > s && endRe.test(lines[i])) break
  }
  return out.join('\n')
}

// ————————————————————————— ① 契约层 —————————————————————————

test('快照契约：purge 返回值含执行器 undo 需要的全部字段', () => {
  const src = read('student-backend/services/studentRelations.js')
  const fn = bodyBetween(src, /function purgeStudentRelations\s*\(/, /^}/)
  const outBlock = fn.slice(fn.indexOf('const out = {'), fn.indexOf('};', fn.indexOf('const out = {')))
  // 执行器 undo 用到：student（前端补）、四类 Rows、seatCells、dutySlots
  for (const key of ['leaveRows', 'scoreRows', 'groupRows', 'cadreRows', 'seatCells', 'dutySlots']) {
    assert.match(outBlock, new RegExp(key), `purge 快照缺 ${key}，前端登记级联撤销会丢字段`)
  }
  // 执行器 undo 把整个 payload 交给 restoreStudentCascade（四类 Rows 在 store 内消费），
  // 另单独处理 seatCells/dutySlots（JSON 网格必须与行插入同一事务）。
  const ex = read('student-backend/routes/undo/undo.executors.js')
  const undo = bodyBetween(ex, /student_cascade_delete:\s*\{/, /^\s*redo\s*\(/)
  assert.match(undo, /restoreStudentCascade\(payload\)/, '执行器未把快照交给级联恢复 store')
  assert.match(undo, /seatCells/, '执行器未恢复座位')
  assert.match(undo, /dutySlots/, '执行器未恢复值日')
  // store 的级联恢复确实消费四类 Rows
  const undoStore = read('student-backend/services/undoStore.js')
  for (const key of ['leaveRows', 'scoreRows', 'groupRows', 'cadreRows']) {
    assert.match(undoStore, new RegExp(key), `级联恢复 store 没消费 ${key}`)
  }
})

// ————————————————————————— ② 后端接线 —————————————————————————

function backendWiringOk(src) {
  const srcClean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  if (!/=\s*purgeStudentRelations\s*\(/.test(srcClean)) return { ok: false, why: '丢弃了 purge 返回值' }
  if (!/purged[^\n]*undoType|undoType[^\n]*student_cascade_delete/.test(srcClean)) {
    return { ok: false, why: 'delete 结果没带 undoType 标记' }
  }
  if (!/student_cascade_delete/.test(srcClean)) return { ok: false, why: '未出现 student_cascade_delete' }
  return { ok: true }
}

test('后端：AI 批量删学生保留 purge 快照并标 undoType', () => {
  const r = backendWiringOk(read(BACK_SRC))
  assert.equal(r.ok, true, r.why)
})

// ————————————————————————— ③ 前端接线 —————————————————————————

function frontWiringOk(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const m = clean.match(/if \(r\.action === 'delete'\)[\s\S]{0,900}?\n\s*\}/)
  if (!m) return { ok: false, why: '未找到 delete 分支' }
  const branch = m[0]
  if (!/undoType === 'student_cascade_delete'/.test(branch)) return { ok: false, why: 'delete 分支没识别 undoType' }
  if (!/_pushUndo\('student_cascade_delete'/.test(branch)) return { ok: false, why: '没登记 student_cascade_delete' }
  if (!/student:\s*r\.row/.test(branch)) return { ok: false, why: 'payload 缺 student 字段' }
  if (!/\.\.\.r\.purged/.test(branch)) return { ok: false, why: 'payload 没展开 purged 快照' }
  return { ok: true }
}

test('前端：AI 批量结果据 undoType 登记级联撤销，payload 含 student + purged', () => {
  const r = frontWiringOk(read(FRONT_SRC))
  assert.equal(r.ok, true, r.why)
})

// ————————————————————————— ④ 变异反证 —————————————————————————

test('变异反证：后端抹掉返回值、前端抹掉登记，判据都必须失败', () => {
  const back = read(BACK_SRC).replace(/let purged = null;/, 'let purged = null; // mutated')
    .replace(/purged = purgeStudentRelations/, '/*x*/ purgeStudentRelations')
  assert.equal(backendWiringOk(back).ok, false, '后端判据假绿：抹掉返回值仍判 PASS')

  const front = read(FRONT_SRC).replace(/_pushUndo\('student_cascade_delete'/, "_pushUndo('ROW_DELETE_MUTATED'")
  assert.equal(frontWiringOk(front).ok, false, '前端判据假绿：抹掉级联登记仍判 PASS')
})
