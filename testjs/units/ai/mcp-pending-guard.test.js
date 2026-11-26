// =========================================================================
// mcp-pending-guard.test.js —— MCP 提案积压的原子守卫（V9-I-05/06）
//
// 闸门 checkPending 在 await 工具执行之前，并发提案可以都通过那道检查；
// mcpProposalStore.create 里的同步计数是最后一道防线。本文件独占 fixture，
// 不与 mcp-rate-limit.test.js 共享模块缓存（那个文件顶层已 require 过 store）。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')
const fx = createBackendDb({ label: 'mcp-pending-guard' })
const proposals = backendRequire(abs('student-backend/services/mcpProposalStore.js'))
test.after(() => fx.close())

test('积压到上限后，第 31 条提案被原子拒绝且不能落库', () => {
  fx.reset()
  const make = (id) => proposals.create({
    kind: 'row_write', table: 'students', operation: 'update',
    payload: { id }, requestedBy: 'test',
  })
  for (let i = 1; i <= 30; i++) make(i)
  assert.throws(
    () => make(99),
    (e) => e.code === 'MCP_PENDING_FULL' && e.status === 400,
    '积压达上限时 create 必须原子拒绝'
  )
  const n = fx.conn.prepare("SELECT COUNT(*) AS n FROM mcp_proposals WHERE status = 'pending'").get().n
  assert.equal(n, 30, '被拒的那条不能落库')
})

test('变异反证：去掉守卫后同一判据必须失败', () => {
  const src = require('node:fs').readFileSync(BACKEND + '/services/mcpProposalStore.js', 'utf8')
  const guard = /if \(pending >= PENDING_HARD_MAX\)/
  // @pin student-backend/services/mcpProposalStore.js#create
  assert.match(src, guard, '前置：真实源码有原子守卫')
  const mutated = src.replace(guard, 'if (false)')
  assert.doesNotMatch(mutated, guard, '变异后判据必须失败')
})
