// =========================================================================
// duty-mode-snapshot.test.js —— 值日切模式不写旧数据到新模式（3-7 / #50）
//
// 原缺陷：createSerialSaver 的 saveFn 在防抖后延迟读全局 dutyMode/cells，切模式期间
// reloadAll 改了全局 → 旧编辑以新模式落库。修法：request(payload) 传提交时快照，
// saveFn 用快照；DutyView 三个 saver 的 persist 传 {cells/weights, mode} 快照。
//
// 判据：① 行为：真跑 serialSaver，request 后改外部状态，saveFn 收到的是快照；
//       ② 接线：DutyView 三个 saver 用 snap、persist 传快照；③ 变异反证。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createSerialSaver } = require(abs('student-frontend/src/utils/serialSaver.js'))

test('行为：request 传快照后，防抖期间改外部状态，saveFn 仍收到固定快照', async () => {
  let saved = null
  const saver = createSerialSaver((snap) => { saved = snap }, { quietMs: 5 })
  let globalMode = 'daily'
  let globalCells = { a: 1 }
  // 提交时固定快照
  const p = saver.request({ cells: globalCells, mode: globalMode })
  // 防抖期间模拟切模式 + reloadAll 改了全局
  globalMode = 'big'
  globalCells = { b: 2 }
  await p
  assert.deepEqual(saved, { cells: { a: 1 }, mode: 'daily' }, '必须用提交时快照，不能读被切模式改过的全局')
})

test('行为：不传 payload 时保持旧行为（saveFn 自己读最新，兼容 useSeatGrid）', async () => {
  let seen = null
  const saver = createSerialSaver(() => { seen = globalVal }, { quietMs: 5 })
  let globalVal = 1
  const p = saver.request()
  globalVal = 2
  await p
  assert.equal(seen, 2, '无快照时 saveFn 仍读到最新值（向后兼容）')
})

test('接线：DutyView 三个 saver 用 snap，persist 传快照', () => {
  const src = read('student-frontend/src/views/DutyView.vue')
  assert.match(src, /createSerialSaver\(\(snap\) => axios\.put\(`\$\{API_BASE\}\/duty`/, 'activeSaver 未用 snap')
  assert.match(src, /activeSaver\.request\(\{ cells: activeCells\.value, mode: dutyMode\.value \}\)/)
  assert.match(src, /masterSaver\.request\(\{ cells: masterCells\.value, mode: dutyMode\.value \}\)/)
  assert.match(src, /weightSaver\.request\(\{ weights: dutyWeights\.value, mode: dutyMode\.value \}\)/)
})

test('变异反证：saveFn 改回读全局后判据失败', () => {
  const src = read('student-frontend/src/views/DutyView.vue')
  const mutated = src
    .replace(/activeSaver\.request\(\{ cells: activeCells\.value, mode: dutyMode\.value \}\)/, 'activeSaver.request()')
    .replace(/masterSaver\.request\(\{ cells: masterCells\.value, mode: dutyMode\.value \}\)/, 'masterSaver.request()')
  assert.ok(mutated !== src, '变异没匹配到快照传参')
  assert.doesNotMatch(mutated, /activeSaver\.request\(\{ cells: activeCells\.value, mode: dutyMode\.value \}\)/, '变异后判据应失败')
})
