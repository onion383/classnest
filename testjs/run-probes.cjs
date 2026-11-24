#!/usr/bin/env node
// =========================================================================
// run-probes.cjs —— 探针板块总闸
//
// 为什么要单独一层：探针的价值在于「发现问题就非零退出」，但过去它们散在
// testjs/probe 下、谁跑谁看输出，从不进 npm test。结果外键被放宽成静默脏写、
// 路由把 400 降成 500 时，自动化视角一直是绿的（v8 · T01-01 / Q4-02）。
//
// 约定：
//   · 只有「自带 assert + 失败 exit 非 0」且无 GUI 依赖的探针才登记进白名单；
//   · 未登记的探针不会被 npm test 执行（避免把需要 Electron/截屏的探针拖进 CI）；
//   · 任一探针非零退出 → 本板块失败 → npm test 失败。
//
// 跑法：node testjs/run-probes.cjs
// =========================================================================
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// 白名单：新增探针时先补断言与退出码，再登记到这里
const PROBES = [
  'testjs/probe/fk-reject-probe.cjs',
  // IPC 四件套（X1-02）：都自带断言 + 失败非零退出、不依赖 Electron 运行时
  'testjs/probe/ipc-guard-probe.cjs',
  'testjs/probe/ipc-policy-probe.cjs',
  'testjs/probe/ipc-usage-probe.cjs',
  'testjs/probe/main-ipc-contract-probe.cjs',
  // 写入路径审计：未建档 / 改名未重认 / 成员未回填 id 都必须让自动化变红（T02-07）
  'testjs/probe/student-write-paths-probe.cjs',
]

const results = []
const t0 = Date.now()
for (const rel of PROBES) {
  const t = Date.now()
  console.log(`\n----- probe: ${rel} -----`)
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, stdio: 'inherit' })
  const ok = r.status === 0
  results.push({ rel, ok, ms: Date.now() - t })
}

console.log('\n========================================================')
console.log('探针汇总：')
for (const x of results) {
  console.log(`  ${x.ok ? '✓' : '✗'} ${x.rel.padEnd(42)} ${x.ok ? 'PASS' : 'FAIL'}  (${x.ms}ms)`)
}
console.log(`合计 ${Date.now() - t0}ms`)
process.exit(results.every((x) => x.ok) ? 0 : 1)
