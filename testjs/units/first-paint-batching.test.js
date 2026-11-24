// =========================================================================
// first-paint-batching.test.js —— 首屏并发编排（v8 · F07-10）
//
// 事故面：设置页挂载同 tick 发 10 条左右请求、课表页 mount 连历史周一起拉，
//         首屏 INP 被后台请求挤占。
// 判据：
//   ① 设置页：非首屏区块统一进 deferredSettingsLoads，onMounted 只发首屏必需项；
//   ② deferred 清单在首帧后（requestIdleCallback / setTimeout）逐条执行；
//   ③ 课表页：onMounted 不再拉历史周，切到「历史」页签的 watch 仍然会拉。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { ROOT } = require('./_db-express-fixture.cjs')
const { analyze, findFunction, scriptBlocks, walk } = require('../_source-scan.cjs')

function callArgRange(ast, calleeName) {
  let found = null
  walk(ast, (node) => {
    if (found) return
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === calleeName && node.arguments[0]) {
      found = { start: node.arguments[0].start, end: node.arguments[0].end }
    }
  })
  return found
}

function varDeclRange(ast, name) {
  let found = null
  walk(ast, (node) => {
    if (found) return
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name) {
      found = { start: node.start, end: node.end }
    }
  })
  return found
}

test('设置页：非首屏请求进延迟清单，首屏只发必需项', () => {
  const src = scriptBlocks(fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/views/SettingsView/SettingsView.vue'), 'utf8'))
  const ast = analyze(src).ast

  const list = varDeclRange(ast, 'deferredSettingsLoads')
  assert.ok(list, '找不到 deferredSettingsLoads 清单')
  const listText = src.slice(list.start, list.end)
  for (const name of ['loadUsbAutoOpen', 'loadDataDirs', 'loadSecurityLevel', 'loadLoginPolicy', 'loadStartup', 'loadDiskUsage']) {
    assert.match(listText, new RegExp(name), `${name} 必须在延迟清单里`)
  }

  const mount = callArgRange(ast, 'onMounted')
  assert.ok(mount, '找不到 onMounted')
  const mountText = src.slice(mount.start, mount.end)
  assert.match(mountText, /runDeferredLoads\(deferredSettingsLoads\)/, 'onMounted 必须把清单交给延迟执行器')
  for (const name of ['loadUsbAutoOpen', 'loadDataDirs', 'loadSecurityLevel', 'loadLoginPolicy', 'loadStartup', 'loadDiskUsage']) {
    assert.ok(!mountText.includes(`ctx.${name}(`), `${name} 不能在 onMounted 同 tick 直接发`)
  }

  const runner = findFunction(ast, 'runDeferredLoads')
  assert.ok(runner, '找不到 runDeferredLoads')
  const runnerText = src.slice(runner.start, runner.end)
  assert.match(runnerText, /runAfterFirstPaint\(next\)/, '必须等首帧后再发下一条')
})

test('课表页：首屏不拉历史周，切页签仍会拉', () => {
  const src = scriptBlocks(fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/views/ScheduleView/ScheduleView.vue'), 'utf8'))
  const ast = analyze(src).ast
  const mount = callArgRange(ast, 'onMounted')
  assert.ok(mount, '找不到 onMounted')
  assert.ok(!src.slice(mount.start, mount.end).includes('fetchHistoryWeeks'), 'onMounted 不能拉历史周')

  let watchHistory = null
  walk(ast, (node) => {
    if (watchHistory) return
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'watch') return
    const arg = node.arguments[0]
    if (!arg || arg.start == null) return
    const text = src.slice(arg.start, arg.end)
    if (text.includes('activeTab') && src.slice(node.start, node.end).includes('fetchHistoryWeeks')) {
      watchHistory = node
    }
  })
  assert.ok(watchHistory, '切到历史页签时必须仍触发 fetchHistoryWeeks')
})
