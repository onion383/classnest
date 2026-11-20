// =========================================================================
// mcp-rate-limit.test.js —— 方向 B：工具调用频率闸门
//
// 覆盖：
//   · 读 / 搜索 / 写各走自己的 60 秒桶（搜索被拒不影响读，读被拒不影响写）
//   · 写只算「真的建出提案」的：参数错被拒的不占额度，否则 AI 改两遍字段名就自锁
//   · 写还有积压上限：老师不处理，速率重置后照样进不来；拒绝一条立刻恢复
//   · 被挡的请求必须落一条 access_log（result=denied），否则界面上看不见「被挡了几百次」
// 阈值用 _setLimitsForTest 压小，避免为了测边界真发 160 次请求。
// 变异反证：把 wrap 里的 rate.check 拆掉，前四组断言会全部变绿（说明测的是闸门本身）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const BACKEND = path.join(ROOT, 'student-backend')
const SLUG = 'mcp-rate'

const TEST_LIMITS = {
  read: { perMin: 3, label: '读取' },
  search: { perMin: 2, label: '搜索' },
  write: { perMin: 2, pendingMax: 2, label: '提案提交' },
}

test('方向B 限流：读/搜索/写各走自己的桶，写还看老师的待确认积压', async (t) => {
  const { Client, StreamableHTTPClientTransport } = backendRequire('@modelcontextprotocol/client')

  const fx = createBackendDb({ label: 'mcp-rate' })
  fx.reset({ seed: (c) => {
    c.exec(`INSERT INTO students (学号, 姓名) VALUES ('2026001', '限流同学')`)
    c.exec('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1')
  } })

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const origVerify = tokenStore.verify
  tokenStore.verify = (tok) => tok === 'rate-token-1234'
    ? { ok: true, slug: SLUG, id: 'rate', label: 'rate' }
    : { ok: false }

  const rate = backendRequire(path.join(BACKEND, 'services/mcpRateLimit.js'))
  const store = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
  const resetLimits = () => { rate._resetForTest(); rate._setLimitsForTest(TEST_LIMITS) }
  resetLimits()

  let client, base
  t.after(async () => {
    if (client) await client.close()
    tokenStore.verify = origVerify
    dbManager.withDb = origWithDb
    rate._resetForTest()
    fx.close()
  })

  await t.test('挂载 /mcp 并连接', async () => {
    const srv = backendRequire(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'))
    srv._resetForTest()
    base = await fx.mount('/mcp', srv.router)
    client = new Client({ name: 'rate-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: 'Bearer rate-token-1234' } },
    }))
  })

  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text)

  await t.test('搜索有自己的桶：2 次正常，第 3 次被拒且带 retry_after', async () => {
    assert.equal((await call('search', { q: '限流' })).ok, true)
    assert.equal((await call('search', { q: '限流' })).ok, true)
    const third = await call('search', { q: '限流' })
    assert.equal(third.ok, false, JSON.stringify(third))
    assert.match(third.error, /搜索过于频繁/)
    assert.ok(third.retry_after > 0, '要告诉客户端多久后重试，否则它只会立刻重试')
  })

  await t.test('读的额度独立：搜索撞墙不影响 read_table（反证：共用桶的话这里第一次就拒）', async () => {
    const r = await call('read_table', { table: 'students' })
    assert.equal(r.ok, true, JSON.stringify(r))
  })

  await t.test('读 3 次后第 4 次被拒', async () => {
    assert.equal((await call('read_table', { table: 'students' })).ok, true)
    assert.equal((await call('read_table', { table: 'students' })).ok, true)
    const fourth = await call('read_table', { table: 'students' })
    assert.equal(fourth.ok, false, JSON.stringify(fourth))
    assert.match(fourth.error, /读取过于频繁/)
  })

  await t.test('被限流的请求要留痕（access_log · denied）', async () => {
    const row = fx.conn.prepare("SELECT * FROM access_log WHERE source = 'mcp' AND result = 'denied' ORDER BY log_id DESC").get()
    assert.ok(row, '被挡的请求必须能查到，否则界面上看不出被挡过')
    assert.equal(row.tool, 'read_table')
    assert.match(row.reason, /频繁/)
  })

  await t.test('写：参数错的不占额度，真建出 2 条后第 3 条被拒', async () => {
    // 反证点：若失败提交也计数，下面第一条合法的就会被拒（AI 改两遍字段名就自锁）
    const bad = await call('propose_write', { table: 'students', operation: 'add', data: {} })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /可写字段/)

    const p1 = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026701', 姓名: '限流甲' } })
    assert.equal(p1.ok, true, JSON.stringify(p1))
    const p2 = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026702', 姓名: '限流乙' } })
    assert.equal(p2.ok, true, JSON.stringify(p2))
    const p3 = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026703', 姓名: '限流丙' } })
    assert.equal(p3.ok, false, JSON.stringify(p3))
    assert.match(p3.error, /提案提交过于频繁/)
  })

  await t.test('积压上限：速率重置后仍然拦，老师拒掉一条立刻恢复', async () => {
    resetLimits() // 清空 60 秒窗口：此时只剩「待确认 2 条」这一层能挡
    const blocked = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026704', 姓名: '积压丙' } })
    assert.equal(blocked.ok, false, JSON.stringify(blocked))
    assert.match(blocked.error, /待确认/)
    assert.match(blocked.error, /不要立即重试/, '文案要劝住 AI，否则它会疯狂重试')

    const pending = fx.conn.prepare("SELECT proposal_id FROM mcp_proposals WHERE status = 'pending' LIMIT 1").get()
    store.decide(pending.proposal_id, 'rejected', { message: '测试拒绝' })

    const after = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026705', 姓名: '积压丁' } })
    assert.equal(after.ok, true, JSON.stringify(after))
  })

  await t.test('超过 24 小时的 pending 不占额度（僵尸提案不该卡住老师）', async () => {
    resetLimits()
    // 把现存 pending 全部推到 25 小时前
    fx.conn.prepare("UPDATE mcp_proposals SET created_at = ? WHERE status = 'pending'")
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())
    // 反证点：若 countPendingSince 不过滤时间，这里会因为「积压满」被拒
    const ok = await call('propose_write', { table: 'students', operation: 'add', data: { 学号: '2026706', 姓名: '僵尸不占位' } })
    assert.equal(ok.ok, true, JSON.stringify(ok))
  })
})
