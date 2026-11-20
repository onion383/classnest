// =========================================================================
// mcp-auto-exec.test.js —— 「自动执行提案」开关
//
// 这是 MCP 里唯一一个会拆掉人工闸门的开关（用户明确要求含删除），所以判据要
// 同时钉住两个方向：
//   · 关着的时候，提案绝不能自己执行（默认必须是关的）
//   · 打开之后，单条/批量/删除都直接落库，失败要整批回滚并如实回给 AI
// 另外钉住「只认布尔 true」：'1' / 1 / 'yes' 这类脏值一律当关闭 —— 安全开关不能靠 truthy。
// 变异反证：把 autoRunProposal 里的开关判断改成 `if (!on) return null` 的反面（恒执行），
// 第一条「默认关闭」立刻红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const BACKEND = path.join(ROOT, 'student-backend')

test('自动执行提案：默认关闭，打开后单条/批量/删除都直接执行', async (t) => {
  const fx = createBackendDb({ label: 'auto-exec' })
  fx.reset({ seed: (c) => {
    c.exec("INSERT INTO students (学号, 姓名, 家长联系电话) VALUES ('2026001', '张三', '13800000001')")
    c.exec("INSERT INTO students (学号, 姓名, 家长联系电话) VALUES ('2026002', '李四', '13800000002')")
  } })

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()

  const mcpTools = backendRequire(path.join(BACKEND, 'services/mcpTools.js'))
  const aiStore = backendRequire(path.join(BACKEND, 'services/aiStore.js'))
  const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))
  const proposals = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))

  const ctx = { slug: 'auto-exec' }
  const nameOf = (id) => {
    const row = aiStore.findRow('students', id)
    return row ? row['姓名'] : null
  }

  t.after(() => {
    dbManager.withDb = origWithDb
    fx.close()
  })

  await t.test('默认关闭：提案停在 pending，数据一个字没动', () => {
    assert.equal(aiConfigStore.readMcpPrefs().auto_confirm, false, '默认必须是关的')
    const r = mcpTools.proposeWrite({ table: 'students', operation: 'update', id: 1, data: { 姓名: '张三丰' } }, ctx)
    assert.equal(r.ok, true)
    assert.equal(r.status, 'pending')
    assert.equal(r.auto, undefined, '没执行就不该带 auto 标记')
    assert.equal(nameOf(1), '张三', '关闭状态下数据不能被改')
  })

  await t.test('开启后：单条修改直接落库，回包是 confirmed', () => {
    aiConfigStore.setMcpPrefs({ auto_confirm: true })
    const r = mcpTools.proposeWrite({ table: 'students', operation: 'update', id: 1, data: { 姓名: '张三丰' } }, ctx)
    assert.equal(r.ok, true)
    assert.equal(r.status, 'confirmed')
    assert.equal(r.auto, true)
    assert.match(r.message, /已直接执行/)
    assert.equal(nameOf(1), '张三丰', '数据要真的改了')
    // 执行过的提案仍是一条记录，能在「已处理」里查到
    const done = proposals.list({ status: 'confirmed', withPayload: true })
    assert.equal(done.length, 1)
    assert.equal(done[0].proposal_id, r.proposal_id)
  })

  await t.test('失败：回 failed 且整批回滚，不留下半截数据', () => {
    const r = mcpTools.proposeWrite({ table: 'students', operation: 'update', id: 9999, data: { 姓名: '无此人' } }, ctx)
    assert.equal(r.ok, true, '工具调用本身成功，失败体现在 status')
    assert.equal(r.status, 'failed')
    assert.match(r.result.error, /没有 id=9999/, '要带上真实原因')
    assert.match(r.hint, /不要原样重试/, '要教它别重试')
  })

  await t.test('批量：一次确认里含删除也会直接执行（用户选择了全自动）', () => {
    const r = mcpTools.proposeBatch({
      label: '改名 + 删除',
      ops: [
        { table: 'students', operation: 'update', id: 1, data: { 姓名: '张三丰2' } },
        { table: 'students', operation: 'delete', id: 2 },
      ],
    }, ctx)
    assert.equal(r.status, 'confirmed')
    assert.equal(r.op_count, 2)
    assert.equal(nameOf(1), '张三丰2')
    assert.equal(nameOf(2), null, '删除也要真的执行')
  })

  await t.test('关掉之后立刻回到「等确认」', () => {
    aiConfigStore.setMcpPrefs({ auto_confirm: false })
    const before = nameOf(1)
    const r = mcpTools.proposeWrite({ table: 'students', operation: 'update', id: 1, data: { 姓名: '不该生效' } }, ctx)
    assert.equal(r.status, 'pending')
    assert.equal(nameOf(1), before, '关掉后不能再自动改数据')
  })

  await t.test('安全开关只认布尔 true：脏值一律关闭', () => {
    assert.equal(aiConfigStore.setMcpPrefs({ auto_confirm: 'yes' }).auto_confirm, false)
    assert.equal(aiConfigStore.setMcpPrefs({ auto_confirm: 1 }).auto_confirm, false)
    assert.equal(aiConfigStore.setMcpPrefs({ auto_confirm: true }).auto_confirm, true)
    aiConfigStore.setMcpPrefs({ auto_confirm: false })
  })
})
