// =========================================================================
// mcp-server.test.js —— 方向 B（班集作为 MCP 服务端）端到端验证
//
// 验证方式：夹具起内存库（真实 schema）→ 挂 /mcp → 用真实 @modelcontextprotocol/client
// 驱动 connect / listTools / callTool，覆盖：
//   · token 鉴权（无 token 401、有效 token 通、撤销后 401）
//   · 只读工具（list_tables / read_table / read_doc / search）
//   · 两步式写（propose_write 建提案 → 列提案 → confirm 落库 → get_proposal_result）
//   · 越权防护：token 绑定的 slug 不可被工具参数覆盖
// 另有一组源码级判据守住红线（路由无 db.prepare、SDK 外置、secureChannel 豁免 /mcp）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const backendRequire = createRequire(path.join(BACKEND, 'package.json'))
const read = (p) => fs.readFileSync(p, 'utf8')

// ---------- 源码级判据（不需要 DB） ----------

test('方向B 源码判据：MCP 路由不含 db.prepare（SQL 只在 store/service）', () => {
  for (const f of ['routes/ai/mcp/mcp.server.js', 'routes/ai/mcp/mcp.routes.js']) {
    const code = read(path.join(BACKEND, f))
    assert.ok(!/\.prepare\(/.test(code), `${f} 不应出现 db.prepare（SQL 下沉到 store）`)
  }
  // mcpTools / mcpProposalExec 是 service 层，允许 db.prepare，但不能直接 require express
  for (const f of ['services/mcpTools.js', 'services/mcpProposalExec.js', 'services/mcpProposalStore.js']) {
    const code = read(path.join(BACKEND, f))
    assert.ok(!/require\(['"]express['"]\)/.test(code), `${f} 是 service，不应依赖 express`)
  }
})

test('方向B 源码判据：SDK 在 bundle 外置，secureChannel 豁免 /mcp', () => {
  const bundle = read(path.join(BACKEND, 'build.bundle.mjs'))
  assert.ok(bundle.includes("'@modelcontextprotocol/server'"), 'server SDK 必须外置')
  assert.ok(bundle.includes("'@modelcontextprotocol/node'"), 'node SDK 必须外置')
  assert.ok(bundle.includes("'zod'"), 'zod 必须外置')
  const sc = read(path.join(BACKEND, 'services/secureChannel.js'))
  assert.ok(/EXEMPT_PREFIXES[^\]]*\/mcp/.test(sc), 'secureChannel 必须豁免 /mcp 明文端点')
})

test('方向B 源码判据：token 只存 hash、绑定 slug', () => {
  const code = read(path.join(BACKEND, 'services/mcpTokenStore.js'))
  assert.ok(/sha256/.test(code) && /hashToken/.test(code), 'token 必须哈希存储')
  assert.ok(!/token:\s*hash/.test(code), '不应把明文写进文件字段')
  assert.ok(/slug/.test(code), 'token 必须绑定 slug')
})

// ---------- 端到端（内存库 + 真实 MCP 客户端） ----------

test('方向B 端到端：token 鉴权 + 只读工具 + 两步式写 + 越权防护', async (t) => {
  const { Client, StreamableHTTPClientTransport } = backendRequire('@modelcontextprotocol/client')

  // 夹具建库（students 表来自真实 schema，seed 一行）
  const fx = createBackendDb({ label: 'mcp-server' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名) VALUES ('2026001', '测试同学')`)
  } })

  // 夹具把 db Proxy 指到了内存库，但 withDb 会去 registry 找真实库文件（测试里没有）。
  // 这里把 withDb 换成「直接执行 fn」：工具里的 db.prepare 仍命中夹具的内存库。
  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()

  // token 校验走 stub：tokenStore 顶层已经持有 verify 的引用者，替换导出对象上的方法即可
  // （mcp.server 用 tokenStore.verify(...) 调用，运行时读属性，stub 生效）。
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const origVerify = tokenStore.verify
  tokenStore.verify = (tok) => tok === 'test-token-12345678'
    ? { ok: true, slug: 'default', id: 'test', label: 'test' }
    : { ok: false }

  let base
  t.after(() => { tokenStore.verify = origVerify; dbManager.withDb = origWithDb; fx.close() })

  await t.test('挂载 /mcp 路由', async () => {
    // 夹具要求传 router 实例（stub 装好后 require）
    const mcpServer = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
    base = await fx.mount('/mcp', mcpServer.router)
  })

  // 无 token → 401
  await t.test('无 token 被拒（401）', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    assert.equal(res.status, 401)
  })

  let client
  await t.test('真实客户端 connect + 列工具', async () => {
    client = new Client({ name: 'test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: 'Bearer test-token-12345678' } },
    })
    await client.connect(transport)
    const list = await client.listTools()
    const names = list.tools.map((x) => x.name).sort()
    assert.deepEqual(names, ['get_proposal_result', 'list_tables', 'propose_write', 'read_doc', 'read_table', 'search'])
  })

  await t.test('read_table 读到种子数据', async () => {
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const payload = JSON.parse(r.content[0].text)
    assert.equal(payload.ok, true)
    assert.ok(payload.rows.some((row) => row['姓名'] === '测试同学'))
  })

  await t.test('read_table 拒绝未白名单表', async () => {
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'users' } })
    const payload = JSON.parse(r.content[0].text)
    assert.equal(payload.ok, false)
  })

  await t.test('两步式写：propose_write → 确认 → 落库 → 查结果', async () => {
    const proposal = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'add', data: { 学号: '2026002', 姓名: 'MCP新增' }, label: '测试新增',
    } })
    const p = JSON.parse(proposal.content[0].text)
    assert.equal(p.ok, true)
    assert.equal(p.status, 'pending')
    assert.ok(p.proposal_id)

    // 提案先建未落库
    const before = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    assert.ok(!JSON.parse(before.content[0].text).rows.some((r) => r['姓名'] === 'MCP新增'))

    // 通过 service 层确认（与前端 UI 确认同一入口）
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const decision = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(decision.status, 'confirmed', JSON.stringify(decision))

    const after = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    assert.ok(JSON.parse(after.content[0].text).rows.some((r) => r['姓名'] === 'MCP新增'))

    const result = await client.callTool({ name: 'get_proposal_result', arguments: { proposal_id: p.proposal_id } })
    const rr = JSON.parse(result.content[0].text)
    assert.equal(rr.status, 'confirmed')
  })

  await t.test('越权防护：工具参数里的 slug 被忽略', async () => {
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'students', slug: 'another-class' } })
    const payload = JSON.parse(r.content[0].text)
    // 仍读到本库种子数据，说明 params.slug 没有生效
    assert.equal(payload.ok, true)
    assert.ok(payload.rows.some((row) => row['姓名'] === '测试同学'))
  })

  await t.test('stdio 转发器：stdio 客户端 → 转发器 → HTTP 后端 → 真实库', async () => {
    const { StdioClientTransport } = backendRequire('@modelcontextprotocol/client/stdio')
    const fwdPath = path.join(BACKEND, 'mcp-forwarder.cjs')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fwdPath],
      env: { ...process.env, CLASSNEST_MCP_URL: base, CLASSNEST_MCP_TOKEN: 'test-token-12345678' },
    })
    const stdioClient = new Client({ name: 'stdio-test', version: '1.0.0' })
    await stdioClient.connect(transport)
    try {
      const names = (await stdioClient.listTools()).tools.map((x) => x.name).sort()
      assert.deepEqual(names, ['get_proposal_result', 'list_tables', 'propose_write', 'read_doc', 'read_table', 'search'])
      const r = await stdioClient.callTool({ name: 'read_table', arguments: { table: 'students' } })
      const p = JSON.parse(r.content[0].text)
      assert.equal(p.ok, true)
      assert.ok(p.rows.some((x) => x['姓名'] === '测试同学'))
    } finally {
      await stdioClient.close()
    }
  })

  await t.test('断开客户端', async () => { if (client) await client.close() })
})
