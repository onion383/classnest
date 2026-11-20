// =========================================================================
// mcp-server.test.js —— 方向 B（班集作为 MCP 服务端）端到端验证
//
// 验证方式：夹具起内存库（真实 schema）→ 挂 /mcp → 用真实 @modelcontextprotocol/client
// 驱动 connect / listTools / callTool，覆盖：
//   · token 鉴权（无 token 401、有效 token 通、撤销后 401）
//   · 只读工具（list_tables / read_table / read_doc / search）
//   · 两步式写（propose_write 建提案 → 列提案 → confirm 落库 → get_proposal_result）
//   · 批量写（propose_batch：一条提案 = 一批操作；任一条失败整批回滚）
//   · 提案人读视图：中文表名 + 改前→改后，不泄英文表名
//   · 越权防护：token 绑定的 slug 不可被工具参数覆盖
// 另有一组源码级判据守住红线（路由无 db.prepare、SDK 外置、secureChannel 豁免 /mcp）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { createBackendDb } = require('./_db-express-fixture.cjs')
const { closeServer } = require('../tools/closeServer.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const backendRequire = createRequire(path.join(BACKEND, 'package.json'))
const read = (p) => fs.readFileSync(p, 'utf8')

// ---------- 源码级判据（不需要 DB） ----------

test('方向B 源码判据：/mcp 端点有 opt-in 启用门禁（默认关，token 合法也进不来）', () => {
  const srv = read(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
  // authMcp 里 verify 通过后必须再读 mcp_enabled 决定放行，不能只靠 token
  assert.match(srv, /verify\(token\)/, '先校验 token')
  assert.match(srv, /readMcpEnabled\(\)/, '再读启用开关')
  assert.match(srv, /withDb\(v\.slug[\s\S]{0,120}readMcpEnabled/, '门禁读的是 token 绑定库的开关')
  assert.match(srv, /403/, '未启用返回 403 区分于 token 无效的 401')
  const cfg = read(path.join(BACKEND, 'services/aiConfigStore.js'))
  assert.match(cfg, /mcp_enabled[\s\S]{0,80}catch[\s\S]{0,40}return false/, '读不到开关时按未启用处理，不误开门')
  // schema 默认 0（opt-in）
  const schema = read(path.join(BACKEND, 'schema/schema.ai.js'))
  assert.match(schema, /mcp_enabled INTEGER DEFAULT 0/, 'MCP 默认关闭')
})

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

test('方向B 源码判据：提案卡片不渲染英文表名', () => {
  // 判据跟着实现走：提案卡片从 McpSettingsPanel 拆进了 McpProposalsDialog
  // （面板只留一行「MCP 提案 · N 条待确认」，明细在弹窗里）。判据该盯人看到卡片的地方。
  const panel = read(path.join(ROOT, 'student-frontend/src/components/data-manage/McpProposalsDialog.vue'))
  // 之前卡片直接插值 p.table / p.operation（students · update_row），老师没法判断该不该确认
  assert.ok(!/\{\{\s*p\.table\s*\}\}/.test(panel), '卡片不许直接渲染 p.table（英文表名）')
  assert.ok(!/\{\{\s*p\.operation\s*\}\}/.test(panel), '卡片不许直接渲染英文 operation')
  assert.match(panel, /op\.table_label/, '表名用后端翻好的中文名')
  assert.match(panel, /fieldText\(op, f\)/, '字段改动用「改前 → 改后」展示')
  // 视觉层级：标题必须是后端算出来的「操作 · 表名」，不能是调用方自填的 label。
  // label 可被伪造（写「修正错别字」而实际删一行），只能作为小字元信息出现。
  assert.match(panel, /summaryOf\(p\)/, '标题用 summaryOf 算出的中文操作摘要')
  assert.ok(!/\{\{\s*p\.label\s*\|\|/.test(panel), 'label 不许再当标题兜底')
  assert.match(panel, /确认删除/, '删除类的确认按钮要写明「删除」，不能还是「确认执行」')
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
  // MCP 服务是 opt-in（ai_settings.mcp_enabled 默认 0）：内存库要把开关打开，
  // 否则 authMcp 门禁会 403，所有工具测试都进不去。
  const fx = createBackendDb({ label: 'mcp-server' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名) VALUES ('2026001', '测试同学')`)
    c.exec('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1')
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

  // 这个文件测工具语义，不测限流：默认「10 条提案/分钟 + 积压 30 条」会被下面十几个
  // 提案用例撞上（它们本来就是连发）。限流由 mcp-rate-limit.test.js 单独覆盖，
  // 这里把写的闸门放大，测完复位。
  const rate = backendRequire(path.join(BACKEND, 'services/mcpRateLimit.js'))
  rate._setLimitsForTest({ write: { perMin: 999, pendingMax: 999 } })

  let base
  t.after(() => { tokenStore.verify = origVerify; dbManager.withDb = origWithDb; rate._resetForTest(); fx.close() })

  await t.test('挂载 /mcp 路由', async () => {
    // 夹具要求传 router 实例（stub 装好后 require）
    const mcpServer = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
    base = await fx.mount('/mcp', mcpServer.router)
  })

  // 启用门禁：关掉后，带有效 token 也进不来；重新打开恢复
  await t.test('opt-in 门禁：关闭时有效 token 被拒 403，开启后放行', async () => {
    const callMcp = () => fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer test-token-12345678' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    fx.conn.exec('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1')
    const off = await callMcp()
    assert.equal(off.status, 403, '未启用时带有效 token 也被门禁挡下')
    fx.conn.exec('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1')
    const on = await callMcp()
    assert.notEqual(on.status, 403, '开启后门禁放行（进入 SDK，可能是 200 或工具层响应）')
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
    assert.deepEqual(names, ['get_proposal_result', 'list_tables', 'propose_batch', 'propose_write', 'read_doc', 'read_table', 'search'])
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

  await t.test('批量提案：一条提案 = 一批操作，确认一次全落库', async () => {
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      label: '导入 2 名学生',
      ops: [
        { table: 'students', operation: 'add', data: { 学号: '2026101', 姓名: '批量甲' } },
        { table: 'students', operation: 'add', data: { 学号: '2026102', 姓名: '批量乙' } },
      ],
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    assert.equal(p.op_count, 2, '一条提案承载 2 条操作')
    assert.equal(p.status, 'pending')

    // 提案阶段仍未落库
    const pendingRead = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    assert.ok(!JSON.parse(pendingRead.content[0].text).rows.some((row) => row['姓名'] === '批量甲'))

    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const decision = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(decision.status, 'confirmed', JSON.stringify(decision))
    assert.equal(decision.result.count, 2, '一次确认执行了 2 条')

    const after = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    const rows = JSON.parse(after.content[0].text).rows
    assert.ok(rows.some((row) => row['姓名'] === '批量甲'))
    assert.ok(rows.some((row) => row['姓名'] === '批量乙'))
  })

  await t.test('批量提案原子性：第 2 条执行失败则整批回滚（第 1 条也不落库）', async () => {
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      ops: [
        { table: 'students', operation: 'add', data: { 学号: '2026201', 姓名: '原子甲' } },
        // id 不存在：提案阶段只校验 id>0 能过，执行到这一条才失败
        { table: 'students', operation: 'update', id: 999999, data: { 姓名: '不存在的人' } },
      ],
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))

    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const decision = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(decision.status, 'failed', JSON.stringify(decision))
    assert.match(decision.result.error, /第 2 条失败/)
    assert.equal(decision.result.failed_index, 1)

    // 反证点：rollback 没生效的话「原子甲」会被悄悄写进去
    const after = await client.callTool({ name: 'read_table', arguments: { table: 'students' } })
    assert.ok(
      !JSON.parse(after.content[0].text).rows.some((row) => row['姓名'] === '原子甲'),
      '整批必须回滚：第 1 条也不能落库'
    )
  })

  await t.test('批量提案：任一条不合法就整批拒绝，不建提案', async () => {
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      ops: [
        { table: 'students', operation: 'add', data: { 学号: '2026301', 姓名: '合法甲' } },
        { table: 'groups', operation: 'add', data: { name: '不在写白名单的表' } },
      ],
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, false)
    assert.match(p.error, /第 2 条/)
    assert.ok(!p.proposal_id, '不建半成品提案')
  })

  await t.test('空改动提案：提交阶段就拒，不留没有 diff 的卡片', async () => {
    const sid = fx.conn.prepare("SELECT id FROM students WHERE 学号 = '2026001'").get().id
    const call = async (args) => JSON.parse((await client.callTool({ name: 'propose_write', arguments: args })).content[0].text)
    // 变异反证：去掉 checkOp 里的空改动守卫，下面每一条都会拿到 proposal_id
    const assertEmpty = (p) => {
      assert.equal(p.ok, false, JSON.stringify(p))
      assert.match(p.error, /可写字段/)
      assert.ok(!p.proposal_id, '不建半成品提案')
    }
    // 四种「执行时什么都不会写进去」的形态：不传 data / 空对象 / 只有 id / 字段名不属于这张表
    assertEmpty(await call({ table: 'students', operation: 'add' }))
    assertEmpty(await call({ table: 'students', operation: 'update', id: sid, data: {} }))
    assertEmpty(await call({ table: 'students', operation: 'update', id: sid, data: { id: 1 } }))
    assertEmpty(await call({ table: 'students', operation: 'update', id: sid, data: { 不存在的列: 'x' } }))

    // 批量里混一条空的 → 整批拒（与逐条校验同一份口径）
    const b = await client.callTool({ name: 'propose_batch', arguments: { ops: [
      { table: 'students', operation: 'add', data: { 学号: '2026501', 姓名: '该被整批拒' } },
      { table: 'students', operation: 'add', data: {} },
    ] } })
    const pb = JSON.parse(b.content[0].text)
    assert.equal(pb.ok, false, JSON.stringify(pb))
    assert.match(pb.error, /第 2 条/)
    assert.ok(!pb.proposal_id)

    // 反证另一侧：合法提案照常建，守卫没把门关死
    const okOne = await call({ table: 'students', operation: 'add', data: { 学号: '2026502', 姓名: '守卫放行' } })
    assert.equal(okOne.ok, true, JSON.stringify(okOne))
    assert.ok(okOne.proposal_id)
  })

  await t.test('提案人读视图：中文表名 + 改前→改后，不带英文表名', async () => {
    const row = fx.conn.prepare("SELECT id FROM students WHERE 姓名 = '测试同学'").get()
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      label: '改名',
      ops: [{ table: 'students', operation: 'update', id: row.id, data: { 姓名: '测试同学改' } }],
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))

    const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
    const view = backendRequire(path.join(BACKEND, 'services/mcpProposalView.js'))
    const d = view.describe(store.get(p.proposal_id))
    assert.equal(d.op_count, 1)
    assert.equal(d.ops[0].table_label, '学生名单', '表名必须是中文')
    assert.equal(d.ops[0].op_label, '修改', '操作名已中文化')
    assert.equal(d.ops[0].missing, false)
    const f = d.ops[0].fields.find((x) => x.col === '姓名')
    assert.ok(f, '要列出被改的字段')
    assert.equal(f.before, '测试同学')
    assert.equal(f.after, '测试同学改')

    // 这个对象会被界面直接渲染：英文表名一旦出现就等于没翻。
    // 每条 op 上的 operation（add/update/delete）是给前端分支用的代码值，不是展示文案，保留。
    assert.equal(d.table, undefined, '外层不下发英文表名 key')
    assert.equal(d.operation, undefined, '外层不下发英文 operation（可读名在 op_label）')
    const json = JSON.stringify(d)
    assert.ok(!/students|leave_records|score_records/.test(json), '视图里不许出现英文表名')
  })

  await t.test('越权防护：工具参数里的 slug 被忽略', async () => {
    const r = await client.callTool({ name: 'read_table', arguments: { table: 'students', slug: 'another-class' } })
    const payload = JSON.parse(r.content[0].text)
    // 仍读到本库种子数据，说明 params.slug 没有生效
    assert.equal(payload.ok, true)
    assert.ok(payload.rows.some((row) => row['姓名'] === '测试同学'))

    // 顺带锁住 MCP 侧的访问记录：外部客户端读一次就要留一条（source=mcp、带令牌名），
    // 否则「谁读了什么」在界面上永远是空的。
    const log = fx.conn.prepare("SELECT * FROM access_log WHERE source = 'mcp' ORDER BY log_id DESC").get()
    assert.ok(log, 'MCP 读表必须落一条访问记录')
    assert.equal(log.tool, 'read_table')
    assert.equal(log.target, 'students')
    assert.equal(log.actor, 'test', '令牌名要记下来（verify 返回的 label）')
    assert.equal(log.result, 'ok')
    assert.match(log.detail, /行/, 'detail 要能看出读了多少行')
  })

  await t.test('自动执行：开启后直接落库，并留下一条「自动执行」记录', async () => {
    // 本文件其余用例都假定「提案要人工确认」，所以这里单独开一次、跑完立刻复位，
    // 避免把后面的用例变成另一个语义。
    const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))
    const prev = aiConfigStore.readMcpPrefs().auto_confirm
    aiConfigStore.setMcpPrefs({ auto_confirm: true })
    try {
      const r = await client.callTool({ name: 'propose_write', arguments: {
        table: 'students', operation: 'add', data: { 学号: '2026999', 姓名: '自动执行同学' },
      } })
      const payload = JSON.parse(r.content[0].text)
      assert.equal(payload.status, 'confirmed', '开自动执行后不该再回 pending')
      assert.equal(payload.auto, true)

      // 数据真的进去了：从 MCP 再读一次能看见
      const rows = JSON.parse((await client.callTool({ name: 'read_table', arguments: { table: 'students' } })).content[0].text)
      assert.ok(rows.rows.some((x) => x['姓名'] === '自动执行同学'), '自动执行必须真的写库')

      // 老师唯一能看到「它自己改了数据」的地方就是访问记录
      const log = fx.conn.prepare("SELECT * FROM access_log WHERE source = 'mcp' AND tool = 'propose_write' ORDER BY log_id DESC").get()
      assert.ok(log, '自动执行必须落一条访问记录')
      assert.match(log.detail, /自动执行/, '要和人工确认区分开')
      assert.equal(log.result, 'ok')
      assert.equal(log.actor, 'test')
    } finally {
      aiConfigStore.setMcpPrefs({ auto_confirm: prev })
    }
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
      assert.deepEqual(names, ['get_proposal_result', 'list_tables', 'propose_batch', 'propose_write', 'read_doc', 'read_table', 'search'])
      const r = await stdioClient.callTool({ name: 'read_table', arguments: { table: 'students' } })
      const p = JSON.parse(r.content[0].text)
      assert.equal(p.ok, true)
      assert.ok(p.rows.some((x) => x['姓名'] === '测试同学'))
    } finally {
      await stdioClient.close()
    }
  })

  await t.test('幂等：同一提案重复确认只写一次（变异反证：去掉抢占会写两遍）', async () => {
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'add', data: { 学号: '20264001', 姓名: '幂等一次' },
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))

    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const first = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(first.status, 'confirmed', JSON.stringify(first))

    // 变异反证点：第二次确认必须被拒。若退回「读 pending→写库→改状态」的老顺序，
    // 第二次会再 insert 一行「幂等一次」，下面计数断言就会失败。
    const twice = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(twice.ok, false, '重复确认必须返回冲突')
    assert.equal(twice.error && /状态|处理/.test(twice.error), true, '冲突要说明原因')
    const n = fx.conn.prepare('SELECT COUNT(*) AS c FROM students WHERE 姓名 = ?').get('幂等一次').c
    assert.equal(n, 1, '同名只写了一次')
  })

  await t.test('幂等：确认与拒绝争用同一提案，只有一个生效', async () => {
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'add', data: { 学号: '20264002', 姓名: '竞态一次' },
    } })
    const p = JSON.parse(r.content[0].text)
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const decide = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(decide.status, 'confirmed')
    // 已确认后再拒绝：拿不到锁，不能把状态翻成 rejected（否则结果和已落库的数据矛盾）
    const reject = mcpProposalExec.confirm(p.proposal_id, 'reject')
    assert.equal(reject.ok, false, '已确认的提案不能被拒绝覆盖')
    const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
    assert.equal(store.get(p.proposal_id).status, 'confirmed', '状态保持 confirmed')
  })

  await t.test('批量执行失败后定稿 failed，不留在 processing 卡死', async () => {
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      ops: [
        { table: 'students', operation: 'add', data: { 学号: '20264003', 姓名: '失败批甲' } },
        { table: 'students', operation: 'update', id: 999998, data: { 姓名: '不存在' } },
      ],
    } })
    const p = JSON.parse(r.content[0].text)
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'failed')
    const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
    const after = store.get(p.proposal_id)
    assert.equal(after.status, 'failed', '失败也定稿，别停在 processing 让老师反复点')
    assert.ok(after.result && after.result.error, '失败原因写回提案供查询')
    // 重试也被拒（已 failed 不是 pending），不会二次执行那半批
    assert.equal(mcpProposalExec.confirm(p.proposal_id, 'confirm').ok, false)
  })

  await t.test('processing 超时可重抢：进程崩溃卡住的提案能被救回（变异反证：去掉超时分支会卡死）', async () => {
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'add', data: { 学号: '20264004', 姓名: '崩溃救回' },
    } })
    const p = JSON.parse(r.content[0].text)
    const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    // 模拟：抢占后进程崩溃，状态停在 processing、decided_at 是 11 分钟前（超过 10 分钟阈值）
    fx.conn.prepare("UPDATE mcp_proposals SET status = 'processing', decided_at = ? WHERE proposal_id = ?")
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), p.proposal_id)
    // 变异反证：claim 若只认 pending，这条会返回冲突、数据不落库
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    assert.ok(fx.conn.prepare('SELECT 1 FROM students WHERE 姓名 = ?').get('崩溃救回'), '救回后数据落库')
  })

  await t.test('学生引用：MCP 写加减分只填名册外姓名 → 自动建临时学生并回填 student_id（变异反证：去掉认人会留孤儿行）', async () => {
    const name = '名册外MCP同学'
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'score_records', operation: 'add',
      data: { 姓名: name, 类型: '加分', 项目: '测验', 分值: 1, 原因: 'MCP认人测试', 加分时间: '2026-11-18 10:00' },
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    const row = fx.conn.prepare('SELECT student_id FROM score_records WHERE 原因 = ?').get('MCP认人测试')
    assert.ok(row, '加分记录落库')
    assert.ok(row.student_id > 0, '认人回填了 student_id（去掉 applyRowStudentRef 这里会是 NULL）')
    const stu = fx.conn.prepare('SELECT id, is_provisional FROM students WHERE 姓名 = ?').get(name)
    assert.ok(stu, '名册外姓名建了临时学生')
    assert.equal(stu.is_provisional, 1, '标记成临时学生')
    assert.equal(row.student_id, stu.id, '记录指向新建的临时学生')
  })

  await t.test('学生引用：MCP 改学生名 → 关联表同步改名（变异反证：去掉级联会留旧名）', async () => {
    fx.conn.prepare('INSERT INTO students (学号, 姓名) VALUES (?, ?)').run('20269901', '改名同学甲')
    const sid = fx.conn.prepare('SELECT id FROM students WHERE 学号 = ?').get('20269901').id
    fx.conn.prepare('INSERT INTO score_records (student_id, 姓名, 原因) VALUES (?, ?, ?)').run(sid, '改名同学甲', 'MCP改名级联测试')
    fx.conn.prepare('INSERT INTO leave_records (student_id, 姓名) VALUES (?, ?)').run(sid, '改名同学甲')
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'update', id: sid, data: { 姓名: '改名同学乙' },
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    assert.ok(fx.conn.prepare('SELECT 1 FROM students WHERE id = ? AND 姓名 = ?').get(sid, '改名同学乙'), '主表改成新名')
    assert.ok(fx.conn.prepare('SELECT 1 FROM score_records WHERE student_id = ? AND 姓名 = ?').get(sid, '改名同学乙'), '加分表按 id 同步改名')
    assert.ok(fx.conn.prepare('SELECT 1 FROM leave_records WHERE student_id = ? AND 姓名 = ?').get(sid, '改名同学乙'), '请假表按 id 同步改名')
  })

  await t.test('学生引用：MCP 删学生 → 连带清关联（变异反证：去掉 purge 会留孤儿）', async () => {
    fx.conn.prepare('INSERT INTO students (学号, 姓名) VALUES (?, ?)').run('20269902', '待删同学')
    const sid = fx.conn.prepare('SELECT id FROM students WHERE 学号 = ?').get('20269902').id
    fx.conn.prepare('INSERT INTO leave_records (student_id, 姓名, 备注) VALUES (?, ?, ?)').run(sid, '待删同学', 'MCP删学生·有id')
    // 关键反证行：老数据常常只有姓名、student_id 为空。外键 ON DELETE CASCADE 只按 id 级联，
    // 这行它管不到——只有 purgeStudentRelations 按姓名匹配的分支能清。夹具开了 foreign_keys=1，
    // 如果这里只造有 id 的行，就算把 purge 整段删掉测试照样绿（假绿）。
    fx.conn.prepare('INSERT INTO leave_records (student_id, 姓名, 备注) VALUES (?, ?, ?)').run(null, '待删同学', 'MCP删学生·仅姓名')
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'delete', id: sid,
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    assert.ok(!fx.conn.prepare('SELECT 1 FROM students WHERE id = ?').get(sid), '主表已删')
    assert.ok(!fx.conn.prepare("SELECT 1 FROM leave_records WHERE 备注 = 'MCP删学生·有id'").get(), '有 id 的关联已清')
    assert.ok(!fx.conn.prepare("SELECT 1 FROM leave_records WHERE 备注 = 'MCP删学生·仅姓名'").get(), '仅姓名、无 id 的历史关联也被清（外键级联做不到，只有 purge 能抓）')
  })

  await t.test('撤销登记：MCP 确认后写 undo_history（origin=提案id），按 origin 撤销回到改前', async () => {
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'update', id: fx.conn.prepare("SELECT id FROM students WHERE 学号 = '2026001'").get().id,
      data: { 姓名: '撤销测试改名后' },
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    // 写入事务内必须自己落一条 row_update；origin 就是提案 id（跨会话可整批撤销）
    const rec = fx.conn.prepare('SELECT * FROM undo_history WHERE origin = ?').get(p.proposal_id)
    assert.ok(rec, '撤销记录已落库')
    assert.equal(rec.type, 'row_update')
    assert.equal(rec.key, 'students')
    assert.equal(rec.dir, 1, '在可撤销侧')
    const payload = JSON.parse(rec.payload)
    assert.equal(payload.oldRow['姓名'], '测试同学', '快照含改前整行')
    assert.equal(payload.newRow['姓名'], '撤销测试改名后', '快照含改后整行')
    // 对外回执不能带内部整行快照（撑爆外部 AI 上下文）
    assert.ok(!('_records' in d.result) && !('_undoBefore' in d.result), '内部快照字段已剥离')

    const { undoOriginBatch } = backendRequire(path.join(BACKEND, 'routes/undo/undo.records.js'))
    const u = await undoOriginBatch(p.proposal_id)
    assert.equal(u.ok, true, JSON.stringify(u))
    assert.equal(u.count, 1)
    assert.equal(fx.conn.prepare('SELECT 姓名 FROM students WHERE 学号 = ?').get('2026001').姓名, '测试同学', '撤销后回到改前姓名')
  })

  await t.test('撤销登记：批量提案一次确认 → 一条 origin 下多条记录 → 一次撤销整批回退', async () => {
    const r = await client.callTool({ name: 'propose_batch', arguments: {
      label: '撤销批量测试',
      ops: [
        { table: 'students', operation: 'add', data: { 学号: '20269801', 姓名: '撤销批量甲' } },
        { table: 'students', operation: 'add', data: { 学号: '20269802', 姓名: '撤销批量乙' } },
      ],
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    const recs = fx.conn.prepare('SELECT * FROM undo_history WHERE origin = ? ORDER BY id').all(p.proposal_id)
    assert.equal(recs.length, 2, '一批两条各登记一条')
    assert.ok(recs.every((x) => x.type === 'row_insert'), '都是 row_insert')
    // 回执仍只留定位信息（老契约），完整快照不进对外结果
    assert.equal(d.result.count, 2)
    assert.ok(!('_records' in d.result))

    const { undoOriginBatch } = backendRequire(path.join(BACKEND, 'routes/undo/undo.records.js'))
    const u = await undoOriginBatch(p.proposal_id)
    assert.equal(u.ok, true, JSON.stringify(u))
    assert.equal(u.count, 2, '一次撤销回退整批，不用按两次')
    const left = fx.conn.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号 IN ('20269801','20269802')").get().c
    assert.equal(left, 0, '两条新增都被撤销')
  })

  await t.test('撤销登记：删学生用 student_cascade_delete 整包，撤销恢复主表+仅姓名关联', async () => {
    fx.conn.prepare('INSERT INTO students (学号, 姓名) VALUES (?, ?)').run('20269803', '撤销删同学')
    const sid = fx.conn.prepare('SELECT id FROM students WHERE 学号 = ?').get('20269803').id
    fx.conn.prepare('INSERT INTO leave_records (student_id, 姓名, 备注) VALUES (?, ?, ?)').run(null, '撤销删同学', '撤销删·仅姓名')
    const r = await client.callTool({ name: 'propose_write', arguments: {
      table: 'students', operation: 'delete', id: sid,
    } })
    const p = JSON.parse(r.content[0].text)
    assert.equal(p.ok, true, JSON.stringify(p))
    const mcpProposalExec = backendRequire(path.join(BACKEND, 'services/mcpProposalExec.js'))
    const d = mcpProposalExec.confirm(p.proposal_id, 'confirm')
    assert.equal(d.status, 'confirmed', JSON.stringify(d))
    const rec = fx.conn.prepare('SELECT * FROM undo_history WHERE origin = ?').get(p.proposal_id)
    assert.ok(rec, '撤销记录已落库')
    // 删学生必须整包登记，不能用 row_delete（否则 purge 掉的关联撤不回来）
    assert.equal(rec.type, 'student_cascade_delete')
    const payload = JSON.parse(rec.payload)
    assert.equal(payload.student.id, sid, 'payload 含被删学生整行')
    assert.equal(payload.leaveRows.length, 1, 'payload 含被 purge 的关联快照')

    const { undoOriginBatch } = backendRequire(path.join(BACKEND, 'routes/undo/undo.records.js'))
    const u = await undoOriginBatch(p.proposal_id)
    assert.equal(u.ok, true, JSON.stringify(u))
    assert.ok(fx.conn.prepare('SELECT 1 FROM students WHERE id = ?').get(sid), '主表恢复')
    assert.ok(fx.conn.prepare("SELECT 1 FROM leave_records WHERE 备注 = '撤销删·仅姓名'").get(), '仅姓名的关联也随整包恢复')
  })

  await t.test('断开客户端', async () => { if (client) await client.close() })
})

// ---------- 鉴权 / 解析顺序 ----------

test('方向B 安全：/mcp 先鉴权、后解析请求体（未授权不分配 body 内存）', async (t) => {
  // 只挂 router、**故意不挂全局 express.json**：与 app.js 对 /mcp 让路后的真实形态一致。
  // 变异反证：把 parseMcpJson 挪到 authMcp 之前，第一条会变成 400（解析错误）而不是 401。
  const express = backendRequire('express')
  const fx = createBackendDb({ label: 'mcp-auth-order' })
  fx.reset({ seed: (c) => c.exec('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1') })

  const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))
  const origReadMcpEnabled = aiConfigStore.readMcpEnabled
  // 这条测的是「鉴权在前、解析在后」，启用门禁已在上面 e2e 覆盖，这里直接放行，
  // 免得多建一个夹具时读到上一个夹具关闭后的库（catch → 403）而干扰判据。
  aiConfigStore.readMcpEnabled = () => true
  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const origVerify = tokenStore.verify
  tokenStore.verify = (tok) => tok === 'order-token-1234'
    ? { ok: true, slug: 'default', id: 'order', label: 'order' }
    : { ok: false }

  const srv = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
  const app = express()
  app.use('/mcp', srv.router)
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  const url = `http://127.0.0.1:${server.address().port}/mcp`

  t.after(async () => {
    tokenStore.verify = origVerify
    dbManager.withDb = origWithDb
    // 必须等它真的收尾：close() 只是「不再接受新连接」，keep-alive 连接还挂着会把
    // 这个测试进程的退出拖到超时（run-units 那边表现为「文件跑完了却不结束」）。
    await closeServer(server)
    fx.close()
  })

  await t.test('无 token 的畸形 JSON 回 401（不是 400）', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc": "2.0", "id": 1, ', // 截断的 JSON：先解析就会 400
    })
    assert.equal(res.status, 401)
  })

  await t.test('有 token 时 router 自己解析 body，正常走通（不依赖全局解析器）', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP 要求客户端同时声明 json 与 SSE，缺了 SDK 回 406
        accept: 'application/json, text/event-stream',
        Authorization: 'Bearer order-token-1234',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(res.status, 200, `期望 200，实际 ${res.status}`)
    const text = await res.text()
    assert.match(text, /list_tables/, '工具列表要能返回，说明 body 被解析了')
  })
})
