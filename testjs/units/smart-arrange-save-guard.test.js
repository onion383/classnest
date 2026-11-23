// =========================================================================
// smart-arrange-save-guard.test.js —— 智能排表保存失败不能提示成功（4-6 / #43）
//
// 原缺陷：applySmartArrangement 直接 `await grid.saveSeats(nextSeats)`，不看返回值。
// saveSeats 保存失败时**不抛错**（内部提示并 load() 回滚界面），只返回 false ——
// 于是失败路径照样登记撤销快照、弹绿色「已应用智能排表」，用户以为座位已生效（库里还是旧的）。
// catch 里那段「失败却提示成功」的旧代码之前已改，但真正的失败（不抛错的那种）没被拦住。
//
// 判据：
//   ① 接线：saveSeats 的返回值必须被接收，且失败时在「登记撤销 / 成功提示」之前 return；
//   ② 同族：Excel 导入的同类调用也保持 if (!ok) return（防一边修一边漏）；
//   ③ 变异反证：去掉失败分支后，判据必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SRC = 'student-frontend/src/views/SeatView.vue'
const src = fs.readFileSync(path.join(ROOT, SRC), 'utf8')

function blockOf(startMarker, endMarker) {
  const s = src.indexOf(startMarker)
  assert.ok(s >= 0, `未找到 ${startMarker}`)
  const e = src.indexOf(endMarker, s)
  assert.ok(e > s, `未找到 ${startMarker} 之后的 ${endMarker}`)
  return src.slice(s, e)
}

test('智能排表：接收 saveSeats 返回值，失败时不登记撤销、不提示成功', () => {
  const body = blockOf('async function applySmartArrangement', '// 导入确认弹窗')
  const call = body.indexOf('const ok = await grid.saveSeats(nextSeats)')
  assert.ok(call >= 0, 'saveSeats 的返回值必须被接收（否则失败无从判断）')
  const guard = body.indexOf('if (!ok) return')
  assert.ok(guard > call, 'saveSeats 之后必须有 if (!ok) return')
  const rec = body.indexOf('recordGridSnapshotUndo(')
  const ok = body.indexOf("notifySuccess('已应用智能排表')")
  assert.ok(rec > guard, '登记撤销必须在失败分支之后')
  assert.ok(ok > guard, '成功提示必须在失败分支之后')
})

test('同族：Excel 导入同样按返回值短路（不能只修智能排表）', () => {
  const body = blockOf('async function onImportData', 'async function applySmartArrangement')
  assert.match(body, /const ok = await grid\.saveSeats\(next\)[\s\S]{0,80}if \(!ok\) return/,
    '导入路径也要在 saveSeats 失败时短路')
})

test('变异反证：去掉失败分支后，判据必须失败', () => {
  const body = blockOf('async function applySmartArrangement', '// 导入确认弹窗')
  const mutated = body.replace(/if \(!ok\) return\r?\n/, '')
  assert.ok(mutated !== body, '变异没匹配到失败分支')
  assert.doesNotMatch(mutated, /if \(!ok\) return/, '变异后判据应失败')
  // 变异后 saveSeats 的返回值仍被接收，但没有任何地方使用它 —— 正是原来的 bug 形态
  assert.match(mutated, /const ok = await grid\.saveSeats\(nextSeats\)/)
})
