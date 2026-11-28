#!/usr/bin/env node
// mutations-gate.cjs —— 变异反证与 @pin 推断机的可选闸门（V10-T02b-03）
//
// 为什么是可选：mutate-sweep* 会改写工作树源文件再还原，跟日常批验证并存会
// 跟并行会话打架（SIGKILL 后甚至残留坏代码）。所以默认不跑，只在显式
// `node testjs/tools/verify-batch.mjs --with-mutations` 时由 verify-batch 调。
//
// 判据：
//   · 两个 mutate-sweep：命中漏网（exit 1）或锚点未找到（脚本内计为失败）→ 本闸非零；
//   · pin-spread：报告模式，只输出可补锚点统计，不拦闸（覆盖基线口径待定）。
//
// 退出码：0 = 两个 sweep 全抓到；1 = 有漏网/锚点失效；2 = 脚本自身崩溃。
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const STEPS = [
  { name: 'mutate-sweep', file: 'testjs/tools/mutate-sweep.cjs' },
  { name: 'mutate-sweep-b19', file: 'testjs/tools/mutate-sweep-b19.cjs' },
  { name: 'pin-spread（报告模式）', file: 'testjs/tools/pin-spread.cjs' },
]

let failed = false
for (const step of STEPS) {
  console.log(`\n──── ${step.name} ────`)
  const r = spawnSync(process.execPath, [path.join(ROOT, step.file)], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status === null) {
    console.error(`  ${step.name} 启动失败：${r.error && r.error.message}`)
    process.exit(2)
  }
  // pin-spread 恒 0（报告模式）；两个 sweep 非零即失败。
  if (r.status !== 0 && !step.name.startsWith('pin-spread')) failed = true
}

if (failed) {
  console.error('\n变异闸门失败：有漏网或锚点失效')
  process.exit(1)
}
console.log('\n变异闸门通过：两个 sweep 全部精确捕获')
