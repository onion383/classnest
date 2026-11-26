#!/usr/bin/env node
// run-all.js —— 全板块串跑总闸：units → behavior → probe → smoke（冒烟最后，它最重）
//
// 用法：
//   node testjs/run-all.js          全量（含冒烟），打包前用
//   node testjs/run-all.js --fast   快测（units + behavior + probe），每次提交用（即 npm test）
//   其余参数（--only= / --skip= / --bail）原样透传给各板块 runner
//
// 各板块打印自己的 per-file 明细与汇总；本脚本只负责串联与板块级记分。
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const passThrough = args.filter((a) => a !== '--fast')

const boards = [
  // 守卫台账先跑：它是纯静态扫描（~0.2s），失败信息最具体（哪个文件第几行加了散点守卫），
  // 放在最前面可以最快给出「这次提交是否在给测试资产加债」的结论。
  { name: '守卫台账 guards', script: 'tools/guard-ledger.cjs' },
  { name: '单元 units', script: 'run-units.js' },
  { name: '行为 behavior', script: 'run-behavior.js' },
  // 探针必须进快测：它们是外键/守卫这类「只有故意改坏才看得见」的判据，
  // 不进 npm test 就等于没有闸门（v8 · T01-01）。
  { name: '探针 probe', script: 'run-probes.cjs' },
  // tools 审计（V9-I-04 三类缺口里真正没进总闸的一类）：这些是纯静态、
  // 命中即报的守卫，已清到 0 违规才挂进来。radius-audit 仍有硬编码圆角存量，
  // 不进拦截闸（另行清理）；文档核验与覆盖度审计已在 CI 独立步骤里拦截，
  // 不在本总闸重复跑（npm run docs:verify / check:coverage 各自非零即失败）。
  { name: '审计 comment', script: 'tools/comment-audit.js' },
  { name: '审计 模板绑定', script: 'tools/template-binding-audit.mjs' },
  { name: '审计 Vapor 组件', script: 'tools/component-vapor-audit.mjs' },
]
if (!fast) boards.push({ name: '冒烟 smoke', script: 'run-smoke.cjs' })

const results = []
const t0 = Date.now()
for (const b of boards) {
  const t = Date.now()
  const r = spawnSync(process.execPath, [path.join(__dirname, b.script), ...passThrough], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  })
  results.push({ name: b.name, ok: r.status === 0, ms: Date.now() - t })
}

console.log('\n========================================================')
console.log(fast ? '板块汇总（快测）：' : '板块汇总（全量）：')
for (const x of results) {
  console.log(`  ${x.ok ? '✓' : '✗'} ${x.name.padEnd(16)} ${x.ok ? 'PASS' : 'FAIL'}  (${x.ms}ms)`)
}
console.log(`合计 ${Date.now() - t0}ms`)
process.exit(results.every((x) => x.ok) ? 0 : 1)
