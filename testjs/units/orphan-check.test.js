// =========================================================================
// orphan-check.test.js —— 只读孤儿检查器的可信度（v6 §0-4）
//
// 为什么需要这条：一个「永远返回 0」的检查器看起来最安全，也最容易是假的。
// 所以它自带 --selftest（种 6 条已知孤儿），这里把它挂进 CI：
// 一旦有人改坏判定逻辑，自证会失败 → 这条测试变红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '../..')
const TOOL = path.join(ROOT, 'testjs/tools/orphan-check.cjs')

test('自证：6 类孤儿各一条，检查器必须全部报出来', () => {
  const out = execFileSync('node', [TOOL, '--selftest'], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, /合计孤儿：6/, '孤儿总数对不上 —— 检查器判定逻辑被改坏了')
  for (const t of ['score_records', 'leave_records', 'cadre_members', 'group_members', 'duty_slots.cells', 'seat_slots.seats']) {
    assert.match(out, new RegExp(`✗ ${t.replace('.', '\\.')}`), `${t} 应当报出孤儿`)
  }
  assert.match(out, /自证通过/)
})

test('不存在的文件直接报错退出（不静默返回 0）', () => {
  assert.throws(() => execFileSync('node', [TOOL, 'no-such-file.db'], { cwd: ROOT, stdio: 'pipe' }), /Command failed|状态码/)
})
