// =========================================================================
// pattern-sweep.test.js —— 模式扫描探针的**行为测试**（接进 CI）
//
// 为什么放在 behavior 板块：
//   testjs/probe/ 下的脚本按项目约定是「手动运行」层（要真实桌面 / 较长耗时），
//   CI 不会跑。而模式扫描是**纯静态文本扫描**（毫秒级、无环境依赖），
//   它的价值恰恰在于「每次提交都跑」—— 否则同类漏网还是会溜过去。
//   所以这里把同一份判据包成 behavior 测试，让 `npm run test:behavior` 自动守住。
//
//   单一来源：判据只写在 testjs/probe/pattern-sweep-probe.cjs 里，
//   本文件只 require 它并断言结果 —— **不复现逻辑**（复现逻辑 = 两份判据会漂移）。
//
// 用法：npm run test:behavior
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const probe = require(path.join(__dirname, '..', 'probe', 'pattern-sweep-probe.cjs'))

test('模式扫描：全仓无未登记的新漏网', () => {
  const r = probe.runSweep({ silent: true })
  const detail = r.perPattern
    .filter((p) => p.newHits.length)
    .map((p) => `[${p.key}] ` + p.newHits.map((h) => h.rel + ':' + h.line).join(', '))
    .join('\n')
  assert.strictEqual(r.failures, 0,
    '以下模式出现了未登记的命中（要么修掉，要么在探针里登记为已知/豁免）：\n' + detail)
})

test('模式扫描：白名单已清空（修完后探针是纯回归资产）', () => {
  const r = probe.runSweep({ silent: true })
  const stale = r.perPattern.flatMap((p) => p.staleKnown)
  assert.strictEqual(stale.length, 0,
    '这些白名单项在源码里已经不存在了（应已修，请从探针的 known 里删掉）：\n' + stale.join('\n'))
})

test('模式扫描：探针自身有 8 个模式且判据非空', () => {
  // 探针本身写空了 → 会永远绿灯，等于没有守。
  // 这里守住「模式数量」与「每个模式都有可执行的 detect」。
  assert.ok(probe.PATTERNS.length >= 8, `模式数量不应少于 8（当前 ${probe.PATTERNS.length}）`)
  for (const p of probe.PATTERNS) {
    assert.ok(p.key && p.desc, `模式缺少 key/desc：${JSON.stringify(p.key)}`)
    assert.strictEqual(typeof p.detect, 'function', `模式 ${p.key} 缺 detect`)
    assert.ok(Array.isArray(p.known), `模式 ${p.key} 缺 known 数组`)
    assert.ok(Array.isArray(p.exemptFiles), `模式 ${p.key} 缺 exemptFiles 数组`)
    assert.ok(Array.isArray(p.exempt), `模式 ${p.key} 缺 exempt 数组`)
  }
})
