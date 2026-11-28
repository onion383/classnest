// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// mcp-read-scope.test.js —— U7：按表「完全禁止 AI 读取」在 MCP 三处读入口强制执行
//
// 为什么要专门测：mcpTools 的 read_table / read_doc / search 此前只查原始白名单
// READ_TABLES，没接 readScope.isTableReadable；结果 list_tables 里看不到的表，
// 外部 AI 猜到表名仍可读（能力边界被绕过）。这里用真实 MCP 客户端走三条工具链，
// 做变异反证：同一张表「关→拒、开→通」，证明拒绝确实是闸门造成的，不是假绿。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')
const SLUG = 'mcp-read-scope'

test('方向B U7：按表读闸门作用于 MCP 的 read_table / read_doc / search', async (t) => {
  const { Client, StreamableHTTPClientTransport } = backendRequire('@modelcontextprotocol/client')

  const fx = createBackendDb({ label: 'mcp-read-scope' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名) VALUES ('2026001', '张三')`)
    // schedule 物理表：kind='current' 的行供 read_doc('schedule') 读（见 slotStore.SPEC）
    try { c.exec(`INSERT INTO schedule (kind, cells, settings) VALUES ('current', '{}', '{}')`) } catch (_) {}
    c.prepare('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1').run()
    // 关掉隐私混淆，专测按表闸门；closed_tables 先空（后面用 setPrivacy 变异）
    c.prepare("UPDATE ai_settings SET mcp_privacy_json = ? WHERE id = 1").run(JSON.stringify({
      enabled: false, closed_tables: [], readonly_tables: [],
    }))
  } })

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const origVerify = tokenStore.verify
  tokenStore.verify = (tok) => tok === 'scope-token'
    ? { ok: true, slug: SLUG, id: 'scope', label: 'scope' }
    : { ok: false }
  const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))

  let client
  t.after(async () => {
    if (client) await client.close()
    tokenStore.verify = origVerify
    dbManager.withDb = origWithDb
    fx.close()
  })

  await t.test('挂载 /mcp 并连接', async () => {
    const srv = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
    srv._resetForTest()
    const base = await fx.mount('/mcp', srv.router)
    client = new Client({ name: 'read-scope-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: 'Bearer scope-token' } },
    }))
  })

  function closed(tables) {
    aiConfigStore.setMcpPrivacy({ closed_tables: tables })
  }
  async function call(name, args) {
    const r = await client.callTool({ name, arguments: args })
    return JSON.parse(r.content[0].text)
  }

  await t.test('read_table：关 students 被拒（错误含「设置」），开→通', async () => {
    closed(['students'])
    const denied = await call('read_table', { table: 'students' })
    assert.equal(denied.ok, false, '被关的表读不到')
    assert.match(denied.error, /设置/, '错误要指明去设置里重新开启，不能让模型以为查无数据')

    closed([])
    const allowed = await call('read_table', { table: 'students' })
    assert.equal(allowed.ok, true, '变异反证：开回后同一张表能读到')
    assert.ok(allowed.rows.some((r) => r['学号'] === '2026001'), '读到真实数据，拒绝确实是闸门造成的')
  })

  await t.test('read_doc：关 schedule 被拒，开→通', async () => {
    closed(['schedule'])
    const denied = await call('read_doc', { table: 'schedule' })
    assert.equal(denied.ok, false, '被关的整块表读不到')
    assert.match(denied.error, /设置/)

    closed([])
    const allowed = await call('read_doc', { table: 'schedule' })
    assert.equal(allowed.ok, true, '变异反证：开回后能读到 doc')
  })

  await t.test('search：关 students 后结果无 students 组，开→有', async () => {
    closed(['students'])
    const denied = await call('search', { q: '张三' })
    assert.equal(denied.ok, true, '搜索本身不报错')
    assert.ok(!(denied.groups || []).some((g) => g.table === 'students'), '被关表的分组不出现在搜索结果里')

    closed([])
    const allowed = await call('search', { q: '张三' })
    assert.ok((allowed.groups || []).some((g) => g.table === 'students'), '变异反证：开回后 students 组回来')
  })

  await t.test('派生组不被误伤：readGateError 只对 READ_TABLES 的表生效', () => {
    const code = path.join(BACKEND, 'services/mcpTools.js')
    const src = require('node:fs').readFileSync(code, 'utf8')
    const fn = src.slice(src.indexOf('function readGateError('), src.indexOf('// 列出可读的表'))
    assert.match(fn, /hasOwnProperty\.call\(READ_TABLES/, '闸门先判该表在白名单里')
    assert.match(fn, /mcpReadScope\.isTableReadable/, '再走 MCP 自己那份权限判定')
  })
})
