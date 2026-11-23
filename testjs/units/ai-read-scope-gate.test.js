// =========================================================================
// ai-read-scope-gate.test.js —— AI 读权限闸门覆盖派生读工具（1-6 / #38）
//
// 原缺陷：读闸门只在 query.js 内部与 describe_table 各自做；delete_impact /
// show_record / propose_* 等工具读库并把真实姓名/id 存在性回给模型时完全没闸门
// —— 老师设了「完全禁止」仍被读走。
// 修法：dispatchTool 顶部统一 readableBlockedError，读类/派生读工具派发前一律
// 查 closed_tables；impact.js 入口自带一份（防御深度）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-read-gate-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'read-gate-test-key'
process.env.DATA_DIR = DATA_DIR
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ } })

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { makeReadScope } = require(path.join(ROOT, 'student-backend/services/aiReadScope'))

// ————————————————————————— ① 行为层（读闸门纯函数） —————————————————————————

test('读闸门：closed 的表不可读，其余表可读', () => {
  const rs = makeReadScope({ readClosed: () => ['students'] })
  assert.equal(rs.isTableReadable('students'), false)
  assert.equal(rs.isTableReadable('score_records'), true, '未被关闭的表仍可读')
  assert.match(rs.closedError('students').error, /关闭/)
})

// ————————————————————————— ② 接线层：统一分发闸门 —————————————————————————

function dispatchSrc() {
  return read('student-backend/routes/ai/ai.tools/tools.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

test('dispatchTool 在派发前调用统一读闸门', () => {
  const src = dispatchSrc()
  const d = src.slice(src.indexOf('async function dispatchTool'))
  const gateCall = d.indexOf('readableBlockedError(name, args)')
  const switchAt = d.indexOf('switch (name)')
  assert.ok(gateCall > 0 && switchAt > 0 && gateCall < switchAt,
    '读闸门必须在 switch 派发之前')
})

test('读闸门映射覆盖过去漏掉的派生读工具与提案类工具', () => {
  const src = dispatchSrc()
  const map = src.slice(src.indexOf('const READ_TOOL_TABLE_REFS'), src.indexOf('function readableBlockedError'))
  for (const tool of ['delete_impact', 'show_record']) {
    assert.match(map, new RegExp(`\\b${tool}\\s*:`), `${tool} 未在读闸门映射中`)
  }
  // 提案类复用写映射（完全禁止的表既不能读也不能写）
  assert.match(map, /\.\.\.WRITE_TOOL_TABLE_REFS/, '提案类工具未纳入读闸门')
  // query/describe_table 自带闸门，不能被统一闸门重复挡（返回契约不同）
  assert.doesNotMatch(map, /\bquery\s*:/, 'query 自带闸门，重复挡会改坏返回契约')
  assert.doesNotMatch(map, /\bdescribe_table\s*:/, 'describe_table 自带闸门')
})

test('delete_impact 执行器入口自带读闸门（防御深度）', () => {
  const src = read('student-backend/routes/ai/ai.tools/tools.executors/executors.impact.js')
  assert.match(src, /readScope/, 'impact 执行器未接 readScope')
  const fn = src.slice(src.indexOf('function runDeleteImpact'))
  assert.match(fn, /isTableReadable/, 'runDeleteImpact 入口没检查表可读性')
})

test('proposal 执行器接了 readScope（提案生成前的派生读受约束）', () => {
  const src = read('student-backend/routes/ai/ai.tools/tools.executors/executors.proposal.js')
  assert.match(src, /readScope/, 'proposal 执行器未接 readScope')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：抹掉分发闸门后，接线判据必须失败', () => {
  const src = dispatchSrc()
  const mutated = src.replace('const readErr = readableBlockedError(name, args);', 'const readErr = /*MUTATED*/ null;')
  assert.ok(mutated !== src, '变异没匹配到分发闸门调用')
  const d = mutated.slice(mutated.indexOf('async function dispatchTool'))
  assert.ok(!/readableBlockedError\(name, args\)[\s\S]*?if \(readErr\)/.test(d.slice(0, d.indexOf('switch (name)'))),
    '分发闸门抹掉后判据仍判 PASS —— 假绿')
})
