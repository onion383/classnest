// =========================================================================
// mcp-privacy-split.test.js —— 数据保护「分权」：AI 与 MCP 各一份配置
//
// 背景：两者曾经共用 ai_settings.privacy_json——给外部客户端收紧一张表，
// 会连带把老师自己的 AI 助手锁住；反过来在助手页开个脱敏，外部客户端也一起
// 被混淆。拆成两列（privacy_json / mcp_privacy_json）之后，这份测试钉住：
//   1. 表级权限（完全禁止 / 只读）两边互不影响
//   2. 脱敏总开关两边互不影响（同一个 seed、同一份名册，只是开关各读各的）
//   3. 报错文案指到各自该去的设置位置（否则老师按提示找不到）
//   4. /api/mcp/privacy 只写 mcp 那一列
// 变异反证：把 mcpReadScope 换回 readScope，第 1 条立刻红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const BACKEND = path.join(ROOT, 'student-backend')
const SLUG = 'privacy-split'
const SEED = 'b'.repeat(64)

test('数据保护分权：AI 与 MCP 各一份配置，互不影响', async (t) => {
  const fx = createBackendDb({ label: 'privacy-split' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名, 家长联系电话) VALUES ('2026001', '张三', '13812345678')`)
    c.prepare('UPDATE ai_settings SET privacy_seed = ? WHERE id = 1').run(SEED)
    // 故意错开两边：AI 关掉 students 且脱敏关着；MCP 没关任何表、脱敏开着。
    // 任一侧照抄另一侧的值，下面的断言都会立刻发现。
    c.prepare('UPDATE ai_settings SET privacy_json = ? WHERE id = 1').run(JSON.stringify({
      enabled: false, hide_phone: true, hide_path: true, hide_album: true,
      closed_tables: ['students'], readonly_tables: [],
    }))
    c.prepare('UPDATE ai_settings SET mcp_privacy_json = ? WHERE id = 1').run(JSON.stringify({
      enabled: true, hide_phone: true, hide_path: true, hide_album: true,
      closed_tables: [], readonly_tables: [],
    }))
  } })

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()

  const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))
  const { readScope, mcpReadScope } = backendRequire(path.join(BACKEND, 'services/aiReadScope.js'))
  const { writeScope, mcpWriteScope } = backendRequire(path.join(BACKEND, 'services/aiWriteScope.js'))
  const { privacy } = backendRequire(path.join(BACKEND, 'services/aiPrivacy.js'))

  t.after(() => {
    dbManager.withDb = origWithDb
    privacy.invalidate()
    fx.close()
  })

  await t.test('表级：AI 关掉 students，MCP 照样能读', () => {
    assert.equal(readScope.isTableReadable('students'), false, 'AI 侧确实关了')
    assert.equal(mcpReadScope.isTableReadable('students'), true, 'MCP 有自己那份，不受影响')
  })

  await t.test('表级：反过来 MCP 关表，AI 助手不受影响', () => {
    aiConfigStore.setPrivacy({ closed_tables: [] })
    aiConfigStore.setMcpPrivacy({ closed_tables: ['students'] })
    assert.equal(mcpReadScope.isTableReadable('students'), false, 'MCP 关了')
    assert.equal(readScope.isTableReadable('students'), true, 'AI 这边开着，不会被连带')
    // 还原成初始状态，后面的用例要基于「AI 关 / MCP 开」
    aiConfigStore.setPrivacy({ closed_tables: ['students'] })
    aiConfigStore.setMcpPrivacy({ closed_tables: [] })
  })

  await t.test('只读档也各管各的', () => {
    aiConfigStore.setPrivacy({ readonly_tables: ['score_records'] })
    aiConfigStore.setMcpPrivacy({ readonly_tables: [] })
    assert.equal(writeScope.isTableWritable('score_records'), false, 'AI 侧设了只读')
    assert.equal(mcpWriteScope.isTableWritable('score_records'), true, 'MCP 侧仍可提交提案')
    aiConfigStore.setPrivacy({ readonly_tables: [] })
  })

  await t.test('脱敏总开关各读各的（同一份 seed/名册，只换开关）', () => {
    privacy.invalidate()
    // AI 关着 → 原样；MCP 开着 → 代号
    const ai = privacy.substitute({ n: '张三', p: '13812345678' }, SLUG)
    const mcp = privacy.substitute({ n: '张三', p: '13812345678' }, SLUG, 'mcp')
    assert.equal(ai.n, '张三', 'AI 侧总开关关着，原样返回')
    assert.equal(ai.p, '13812345678')
    assert.match(String(mcp.n), /^S-[0-9a-f]{6,}/, 'MCP 侧总开关开着，姓名换代号')
    assert.match(String(mcp.p), /^P-[0-9a-f]{6,}/, '电话换代号')

    // 反过来：AI 开、MCP 关
    aiConfigStore.setPrivacy({ enabled: true })
    aiConfigStore.setMcpPrivacy({ enabled: false })
    privacy.invalidate()
    const ai2 = privacy.substitute({ n: '张三' }, SLUG)
    const mcp2 = privacy.substitute({ n: '张三' }, SLUG, 'mcp')
    assert.match(String(ai2.n), /^S-/, 'AI 开了就换代号')
    assert.equal(mcp2.n, '张三', 'MCP 关着就原样')
  })

  await t.test('报错文案指向各自的设置入口', () => {
    assert.match(readScope.closedError('students').error, /AI 数据保护/, 'AI 侧引导到「AI 数据保护」')
    assert.match(mcpReadScope.closedError('students').error, /MCP 服务管理|MCP 数据权限/, 'MCP 侧引导到 MCP 那块的设置')
    assert.match(mcpWriteScope.readonlyError('score_records').error, /MCP 数据权限/, '只读也说是 MCP 的权限')
  })

  await t.test('/api/mcp/privacy 只写 mcp 那一列', async () => {
    const router = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.routes.js'))
    await fx.mount('/api/mcp', router)

    const before = aiConfigStore.readPrivacy()
    const put = await fx.call('PUT', '/api/mcp/privacy', { enabled: false })
    assert.equal(put.status, 200, put.text)
    assert.equal(aiConfigStore.readMcpPrivacy().enabled, false, 'MCP 那份被改了')
    assert.equal(aiConfigStore.readPrivacy().enabled, before.enabled, 'AI 那份一个字没动')

    // 单表改档同样只落在 MCP
    const lv = await fx.call('PUT', '/api/mcp/privacy', { table: 'score_records', level: 'none' })
    assert.equal(lv.status, 200, lv.text)
    assert.deepEqual(aiConfigStore.readMcpPrivacy().closed_tables, ['score_records'])
    assert.deepEqual(aiConfigStore.readPrivacy().closed_tables, before.closed_tables, 'AI 的关表清单不变')

    const g = await fx.call('GET', '/api/mcp/privacy')
    assert.equal(g.status, 200)
    assert.equal(g.json.data.enabled, false)
    assert.ok(Array.isArray(g.json.data.tables) && g.json.data.tables.length, '要下发表清单给面板')
  })

  await t.test('迁移链已经补上独立的列', () => {
    const cols = fx.conn.prepare('PRAGMA table_info(ai_settings)').all().map((c) => c.name)
    assert.ok(cols.includes('mcp_privacy_json'), '老库打开时补列 + 快照，见 schema.ai.js')
  })
})
