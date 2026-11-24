// =========================================================================
// probe-gating.test.js —— 探针闸门的「登记」契约（X1-02）
//
// 探针的价值是把回归变成非零退出，但前提是它真的被跑。过去 IPC 四件套
// （guard / policy / usage / contract）都没进 run-probes 白名单，改坏了也没人发现。
//
// 这里锁两件事：
//   1) 白名单里的每个脚本都真实存在；
//   2) IPC 四件套必须在白名单里（新增/删除探针时先看这里，别悄悄移出去）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const RUNNER = path.join(ROOT, 'testjs', 'run-probes.cjs')

function whitelist() {
  const src = fs.readFileSync(RUNNER, 'utf8')
  const m = src.match(/const PROBES = \[([\s\S]*?)\]/)
  assert.ok(m, 'run-probes.cjs 里找不到 PROBES 白名单')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

test('探针白名单：登记项都是真实存在的脚本', () => {
  const list = whitelist()
  assert.ok(list.length > 0, '白名单不能为空')
  for (const rel of list) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `白名单登记的探针不存在：${rel}`)
  }
})

test('探针白名单：IPC 四件套必须被 npm test 跑到', () => {
  const list = whitelist()
  for (const name of [
    'ipc-guard-probe.cjs',
    'ipc-policy-probe.cjs',
    'ipc-usage-probe.cjs',
    'main-ipc-contract-probe.cjs',
  ]) {
    assert.ok(
      list.some((rel) => rel.endsWith('/' + name)),
      `IPC 探针 ${name} 不在 run-probes 白名单里（X1-02：失败不会让自动化变红）`
    )
  }
})
