// =========================================================================
// mcp-privacy.test.js —— U6：数据保护真正作用于 MCP 读写（不是假开关）
//
// 覆盖：
//   · 出站：开启混淆后 read_table 返回代号，真名/真号不出现在外部 AI 看到的文本里
//   · 入站：外部 AI 用代号写回，提案里还原成真值（老师确认卡片显示真名）
//   · 守卫：提交库里没有的 S-/P- 代号被拒，不会把代号存进提案
//   · 关闭：开关关掉后出站是原值，行为与改造前一致
// 用真实 MCP 客户端 + 真实 aiPrivacy 单例（种子固定、名册来自夹具内存库）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const BACKEND = path.join(ROOT, 'student-backend')
const SEED = 'a'.repeat(64)
const SLUG = 'mcp-privacy'

test('方向B U6：混淆作用于 MCP 读写入站出站', async (t) => {
  const { Client, StreamableHTTPClientTransport } = backendRequire('@modelcontextprotocol/client')

  const fx = createBackendDb({ label: 'mcp-privacy' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名, 家长联系电话) VALUES ('2026001', '张三', '13812345678')`)
    c.prepare('UPDATE ai_settings SET mcp_enabled = 1, privacy_seed = ? WHERE id = 1').run(SEED)
    c.prepare("UPDATE ai_settings SET mcp_privacy_json = ? WHERE id = 1").run(JSON.stringify({
      enabled: true, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [], readonly_tables: [],
    }))
  } })

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const origVerify = tokenStore.verify
  tokenStore.verify = (tok) => tok === 'privacy-token-1234'
    ? { ok: true, slug: SLUG, id: 'privacy', label: 'privacy' }
    : { ok: false }

  const aiPrivacy = backendRequire(path.join(BACKEND, 'services/aiPrivacy.js'))
  const mcpProposalStore = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))

  let client, base
  t.after(async () => {
    if (client) await client.close()
    tokenStore.verify = origVerify
    dbManager.withDb = origWithDb
    aiPrivacy.privacy.invalidate(SLUG)
    fx.close()
  })

  await t.test('挂载 /mcp 并连接', async () => {
    const srv = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
    srv._resetForTest()
    base = await fx.mount('/mcp', srv.router)
    client = new Client({ name: 'privacy-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: 'Bearer privacy-token-1234' } },
    }))
  })

  await t.test('出站：read_table 返回代号，真名真号不出现', async () => {
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const row = p.rows.find((x) => x['学号'] === '2026001')
    assert.ok(row, '要读到这行')
    assert.ok(!JSON.stringify(row).includes('张三'), '真名不许出现在外部 AI 看到的文本里')
    assert.ok(!JSON.stringify(row).includes('13812345678'), '真号不许出现')
    assert.match(row['姓名'], /^S-[0-9a-f]{6,}/, '姓名换成 S- 代号')
    assert.match(String(row['家长联系电话']), /^P-[0-9a-f]{6,}/, '电话换成 P- 代号')
  })

  await t.test('入站：用代号写回，提案里还原成真值', async () => {
    // 先拿到这一行当前的代号（姓名列的别名）
    const before = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const alias = JSON.parse(before.content[0].text).rows.find((x) => x['学号'] === '2026001')['姓名']

    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'update', id: 1,
      data: { 姓名: alias }, label: '改名',
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    // 提案 payload 里存的必须是还原后的真名，不是代号
    const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
    const saved = store.get(p.proposal_id)
    assert.equal(saved.payload.data['姓名'], '张三', '提案里必须是真名，老师才判断得了')
  })

  await t.test('守卫：未识别代号被拒，不建提案', async () => {
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'update', id: 1,
      data: { 姓名: 'S-deadbeef' }, label: '恶意代号',
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, false)
    assert.match(p.error, /无法识别的代号/)
    assert.ok(!p.proposal_id, '不建半成品提案')
  })

  await t.test('出站：提案执行结果同样脱敏（get_proposal_result 不许漏真名）', async () => {
    // 执行结果里带 before/after 的字段真值、删除带整行 deleted —— 读接口给代号、
    // 结果接口却把真名还回去，等于开关白开。这里用「用代号改名」造一条真实结果来验。
    const before = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const alias = JSON.parse(before.content[0].text).rows.find((x) => x['学号'] === '2026001')['姓名']
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'update', id: 1, data: { 姓名: alias },
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))

    const exec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = exec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))

    const got = await client.callTool({ name: 'get_proposal_result', arguments: { proposal_id: p.proposal_id } })
    const text = got.content[0].text
    // 变异反证：getProposalResult 去掉 maskResult 后，这句会看到「张三」
    assert.ok(!text.includes('张三'), '提案结果里不许出现真名')
    const rr = JSON.parse(text)
    assert.equal(rr.status, 'confirmed')
    assert.match(String(rr.result.before['姓名']), /^S-[0-9a-f]{6,}/, 'before 里的姓名必须换成代号')
    assert.match(String(rr.result.after['姓名']), /^S-[0-9a-f]{6,}/, 'after 里的姓名必须换成代号')
  })

  await t.test('关闭混淆后出站是原值', async () => {
    fx.conn.prepare("UPDATE ai_settings SET mcp_privacy_json = ? WHERE id = 1").run(JSON.stringify({ enabled: false }))
    aiPrivacy.privacy.invalidate(SLUG)
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const row = JSON.parse(r.content[0].text).rows.find((x) => x['学号'] === '2026001')
    assert.equal(row['姓名'], '张三', '开关关掉后是真名')
    assert.equal(String(row['家长联系电话']), '13812345678')
  })
})
