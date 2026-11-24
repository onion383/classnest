// =========================================================================
// write-scope-closed.test.js —— 「完全禁止」必须同时阻断写入（1-5 / #5 / M1）
//
// 原缺陷：setTableLevel('none') 只写 closed_tables，而写闸门 aiWriteScope
// 只看 readonly_tables。于是「完全禁止」的表读被 aiReadScope 拦住，写提案
// 却照常放行 —— 老师以为锁死了，AI/MCP 仍能改数据。
//
// 修法两层：
//   ① setTableLevel('none') 同时写 closed + readonly（隐私档配置层）；
//   ② makeWriteScope 的 readonlyTables() 合并 closed_tables（写闸门层），
//      这样连「历史配置只有 closed、没 readonly」的存量数据也拦得住。
// 判据：纯函数行为 + 两层接线 + 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

// aiWriteScope → aiConfigStore → dbManager，加载时需主密钥；隔离目录避免写真实数据
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-write-scope-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'write-scope-test-key'
process.env.DATA_DIR = DATA_DIR
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ } })

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const WS = 'student-backend/services/aiWriteScope.js'
const SHARED = 'student-backend/routes/ai/privacy.shared.js'
const canWrite = (t) => ['students', 'scores'].includes(t)

// ————————————————————————— ① 行为层（纯函数） —————————————————————————

test('写闸门：只有 closed、没有 readonly 的表仍不可写（存量数据兜底）', () => {
  const { makeWriteScope } = require(path.join(ROOT, WS))
  const ws = makeWriteScope({
    readReadonly: () => [],
    readClosed: () => ['students'],
    supportsWrite: canWrite,
  })
  assert.equal(ws.isTableWritable('students'), false, '完全禁止的表不能提交写提案')
  assert.equal(ws.isTableWritable('scores'), true, '未被禁止的表仍可写')
  assert.ok(ws.readonlyTables().includes('students'), '执行端用 readonlyTables().includes 检查，必须含 closed')
  assert.match(ws.readonlyError('students').error, /完全禁止/, '命中 closed 时文案应说「完全禁止」而非「只读」')
})

test('写闸门：readonly 与 closed 合并去重，任一 reader 抛错不影响另一张清单', () => {
  const { makeWriteScope } = require(path.join(ROOT, WS))
  const ws = makeWriteScope({
    readReadonly: () => { throw new Error('boom') },
    readClosed: () => ['students', 'students'],
    supportsWrite: canWrite,
  })
  assert.deepEqual(ws.readonlyTables(), ['students'], 'readonly 读取失败也不能让 closed 兜底失效')
  assert.equal(ws.isTableWritable('students'), false)
})

test('MCP 侧写闸门有独立的 closed 来源', () => {
  const { makeWriteScope } = require(path.join(ROOT, WS))
  const ai = makeWriteScope({ readReadonly: () => [], readClosed: () => ['students'], supportsWrite: canWrite })
  const mcp = makeWriteScope({ readReadonly: () => [], readClosed: () => [], supportsWrite: canWrite })
  assert.equal(ai.isTableWritable('students'), false)
  assert.equal(mcp.isTableWritable('students'), true, 'AI 侧关表不应连带锁死 MCP 侧（两侧独立配置）')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('隐私档：none 同时写 closed 与 readonly', () => {
  const src = read(SHARED)
  const m = src.match(/if \(lv === 'none'\)[^\n]*/)
  assert.ok(m, '未找到 none 档分支')
  assert.match(m[0], /closed\.add/, 'none 要写 closed（读闸门）')
  assert.match(m[0], /ro\.add/, 'none 要写 readonly（写闸门）')
})

test('写闸门单例：MCP 与 AI 两侧都接了 closed 来源', () => {
  const src = read(WS)
  const hits = [...src.matchAll(/readClosed:\s*\(\)\s*=>/g)]
  assert.equal(hits.length, 2, `应有两个单例接 closed（AI + MCP），实际 ${hits.length}`)
})

// ————————————————————————— ③ 变异反证 —————————————————————————

// 把源码变异后重新编译成模块：require 走原目录，变异体真的执行原逻辑（T08-02）。
function loadMutated(rel, transform) {
  const abs = path.join(ROOT, rel)
  const src = read(rel)
  const out = transform(src)
  assert.notEqual(out, src, '变异未匹配到目标代码')
  const m = new Module(abs, null)
  m.filename = abs
  m.paths = Module._nodeModulePaths(path.dirname(abs))
  m._compile(out, abs)
  return m.exports
}

test('变异反证：抹掉写闸门的 closed 合并后，判据必须失败', () => {
  // 原 bug 形态：readonlyTables() 不再合并 closed_tables → 完全禁止的表仍可写
  const mutated = loadMutated(WS, (s) => s.replace(
    'return [...new Set([...listOf(readReadonly), ...closedTables()])]',
    'return [...new Set(listOf(readReadonly))]',
  ))
  const ws = mutated.makeWriteScope({
    readReadonly: () => [],
    readClosed: () => ['students'],
    supportsWrite: canWrite,
  })
  assert.equal(ws.isTableWritable('students'), true,
    '变异后完全禁止的表仍可写 —— 这正是原 bug；正例判据「不可写」必然失败')
})
