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

// 判据抽成函数（T07-02）：正例与变异反证共用；变异体直接回喂同一入口。
function saveGuard(body) {
  const call = body.indexOf('const ok = await grid.saveSeats(nextSeats)')
  const guard = body.indexOf('if (!ok) return')
  const rec = body.indexOf('recordGridSnapshotUndo(')
  const tip = body.indexOf("notifySuccess('已应用智能排表')")
  const checks = { received: call >= 0, shortCircuit: guard > call, undoAfter: rec > guard, tipAfter: tip > guard }
  return { ok: Object.values(checks).every(Boolean), checks }
}

test('智能排表：接收 saveSeats 返回值，失败时不登记撤销、不提示成功', () => {
  const body = blockOf('async function applySmartArrangement', '// 导入确认弹窗')
  const r = saveGuard(body)
  assert.ok(r.ok, `失败分支接线不完整：${JSON.stringify(r.checks)}`)
})

test('同族：Excel 导入同样按返回值短路（不能只修智能排表）', () => {
  const body = blockOf('async function onImportData', 'async function applySmartArrangement')
  assert.match(body, /const ok = await grid\.saveSeats\(next\)[\s\S]{0,80}if \(!ok\) return/,
    '导入路径也要在 saveSeats 失败时短路')
})

test('变异反证：去掉失败分支后，判据必须失败', () => {
  const body = blockOf('async function applySmartArrangement', '// 导入确认弹窗')
  assert.equal(saveGuard(body).ok, true, '基线必须通过，否则反证无意义')
  const mutated = body.replace(/if \(!ok\) return\r?\n/, '')
  assert.ok(mutated !== body, '变异没匹配到失败分支')
  assert.equal(saveGuard(mutated).ok, false, '判据假绿：去掉失败短路仍判 PASS')
  // 变异后 saveSeats 的返回值仍被接收，但没有任何地方使用它 —— 正是原来的 bug 形态
  assert.match(mutated, /const ok = await grid\.saveSeats\(nextSeats\)/)
})
