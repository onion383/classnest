// =========================================================================
// access-log.test.js —— 数据访问记录（schema.log.js / accessLogStore / 接口）
//
// 这张表的三个卖点都是「出事时唯一能拿出来的证据」，所以每条都必须真的被断言到：
//   ① 来源隔离：AI 面板只看 ai、MCP 面板只看 mcp（串了就等于把两边的隐私混一起看）
//   ② 被拒单列：撞上「按表关闭」要记 denied，且能和普通失败分开（证明防护真的生效）
//   ③ 裁剪与合并：keep 生效、per_day 只是查看方式（不改已落库的记录）
//
// 手法：公共夹具（_db-express-fixture）—— 真内存库 + 真 router + 真 HTTP。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'access-log', extraDbExports: { renumber: () => {} } })

// 夹具装好 stub 之后再 require（store 顶层 require('../db') 会持有代理）
const accessLog = require('../../student-backend/services/accessLogStore')
const dbManager = require('../../student-backend/dbManager/dbManager')

// 夹具把 db Proxy 指到了内存库，但 withDb 会去 registry 找真实库文件（测试里没有）。
// 这里把 withDb 换成「直接执行 fn」：路由里的 db.prepare 仍命中夹具的内存库。
// 与 mcp-server.test.js 同一手法 —— 不为此在测试里造一个假账号库。
const origWithDb = dbManager.withDb

test.before(async () => {
  dbManager.withDb = (_slug, fn) => fn()
  await fx.mount('/api/access-log', 'student-backend/routes/accessLog.js')
})
test.after(() => { dbManager.withDb = origWithDb; fx.close() })

function rec(patch) {
  accessLog.record({ source: 'ai', tool: 'query', target: 'students', detail: '2 行', amount: 2, ...patch })
}

test('来源隔离：AI 面板看不到 MCP 的记录，反之亦然', async () => {
  fx.reset()
  rec({ source: 'ai', actor: '整理班费' })
  rec({ source: 'mcp', actor: '办公机' })

  const ai = await fx.call('GET', '/?source=ai')
  assert.equal(ai.status, 200)
  assert.equal(ai.json.logs.length, 1, 'AI 列表只能有一条')
  assert.equal(ai.json.logs[0].source, 'ai')
  assert.equal(ai.json.logs[0].actor, '整理班费')

  const mcp = await fx.call('GET', '/?source=mcp')
  assert.equal(mcp.json.logs.length, 1)
  assert.equal(mcp.json.logs[0].source, 'mcp')
})

test('被拒与失败分开记：denied 能单独筛出来，摘要不把两者混成一个数', async () => {
  fx.reset()
  rec({ result: 'ok' })
  rec({ result: 'denied', reason: '该表已在设置中关闭 AI 读取（students）' })
  rec({ result: 'failed', reason: '读取失败：no such column' })

  const all = await fx.call('GET', '/?source=ai')
  assert.deepEqual(all.json.logs.map((l) => l.result).sort(), ['denied', 'failed', 'ok'])

  const bad = await fx.call('GET', '/?source=ai&onlyAbnormal=1')
  assert.deepEqual(bad.json.logs.map((l) => l.result).sort(), ['denied', 'failed'], '只筛异常时应有两条')

  const summary = all.json.summary
  assert.equal(summary.total, 3)
  assert.equal(summary.denied, 1, '被拒只算 denied')
  assert.equal(summary.failed, 1, '工具报错算 failed，不能算成被拒')
})

test('保留条数生效：改小立刻裁剪，越界值夹回合法区间', async () => {
  fx.reset()
  // 默认 500，先堆到 130 条
  for (let i = 0; i < 130; i += 1) rec({ target: `t${i}` })
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 130)

  // 改小到 100 必须**立即**裁剪（不用等下一次读表才生效）
  const put = await fx.call('PUT', '/config', { keep: 100 })
  assert.equal(put.status, 200)
  assert.equal(put.json.config.keep, 100)
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 100, '改小后应立刻只剩 100 条')

  const list = await fx.call('GET', '/?source=ai&limit=1')
  assert.equal(list.json.logs[0].target, 't129', '留下的是最新的那条')

  // keep 越界要被夹回合法区间（0 是「永久」哨兵，下面单独测）
  const low = await fx.call('PUT', '/config', { keep: 1 })
  assert.equal(low.json.config.keep, 100)
})

test('永久保留：keep=0 不裁剪，后续写入也不静默删；改回有限值立刻裁到上限', async () => {
  fx.reset()
  for (let i = 0; i < 130; i += 1) rec({ target: `t${i}` })

  const forever = await fx.call('PUT', '/config', { keep: 0 })
  assert.equal(forever.status, 200)
  assert.equal(forever.json.config.keep, 0, '0 必须作为「永久」放行，不能被夹回 100')
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 130, '设永久时一条都不能删')

  // 写入后的自动裁剪也得跳过永久，否则下一次读表时记录就被悄悄清空了
  rec({ target: 'after-forever' })
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 131, '永久模式下写入不得触发裁剪')

  // 从永久改回有限值：立即裁剪（和从 500 改到 100 同一条路径）
  const back = await fx.call('PUT', '/config', { keep: 100 })
  assert.equal(back.json.config.keep, 100)
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 100, '改回有限值应立刻裁到 100 条')
})

test('per_day 只是查看方式：同一天同工具同目标合并成一条，计数与合计行数都保留', async () => {
  fx.reset()
  rec({ target: 'students', amount: 2, detail: '2 行' })
  rec({ target: 'students', amount: 3, detail: '3 行' })
  rec({ target: 'fee_records', amount: 1, detail: '1 行' })

  const perCall = await fx.call('GET', '/?source=ai')
  assert.equal(perCall.json.logs.length, 3, '默认每次调用一条')

  await fx.call('PUT', '/config', { granularity: 'per_day' })
  const merged = await fx.call('GET', '/?source=ai')
  assert.equal(merged.json.granularity, 'per_day')
  assert.equal(merged.json.logs.length, 2, 'students 的两条应合并，fee_records 单独一条')
  const students = merged.json.logs.find((l) => l.target === 'students')
  assert.equal(students.count, 2, '合并后要报调用次数')
  assert.equal(students.amount, 5, '合并后行数要能相加')

  // 切回逐条：已落库的记录一条没少（合并只是视图）
  await fx.call('PUT', '/config', { granularity: 'per_call' })
  const back = await fx.call('GET', '/?source=ai')
  assert.equal(back.json.logs.length, 3, '合并不得删除原始记录')

  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM access_log').get().n, 3)
})

test('清空只清自己这一侧；不指定 source 一律拒绝', async () => {
  fx.reset()
  rec({ source: 'ai' })
  rec({ source: 'mcp' })

  const bad = await fx.call('DELETE', '/')
  assert.equal(bad.status, 400, '不带 source 的清空必须被拒')

  const ok = await fx.call('DELETE', '/?source=ai')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.removed, 1)
  const mcp = await fx.call('GET', '/?source=mcp')
  assert.equal(mcp.json.logs.length, 1, 'MCP 的记录不能被 AI 面板清掉')
})

test('结构约定：只记元信息，不存数据内容', () => {
  const cols = fx.conn.prepare('PRAGMA table_info(access_log)').all().map((c) => c.name)
  assert.deepEqual(cols.sort(), [
    'actor', 'amount', 'created_at', 'detail', 'log_id', 'reason', 'result', 'source', 'target', 'tool',
  ])
  // 没有 payload / content 这类整块数据列 —— 记录不是第二份数据库
  assert.equal(cols.some((c) => /payload|content|body|json/i.test(c)), false)
})

// 埋点必须真的接在工具派发上：只测 store / 接口是假绿 —— 记录写进去了，
// 但工具调用根本不记，界面上永远是空的。
test('AI 读工具真的会落一条记录（source=ai、带对话标题、行数可数）', async () => {
  fx.reset()
  const tools = require('../../student-backend/routes/ai/ai.tools/tools')
  // 已经在本轮 withDb 内的情形：currentSlug 与 ctx.slug 一致 → 直接写，不再套一层 withDb
  const origSlug = dbManager.currentSlug
  dbManager.currentSlug = () => 'default'
  const out = await tools.runTool('query', { table: 'students' }, { slug: 'default', convTitle: '整理班费', blocks: [] })
  dbManager.currentSlug = origSlug

  assert.ok(!out.result.error, '前置：查询本身要成功 ' + JSON.stringify(out.result).slice(0, 160))
  const row = fx.conn.prepare("SELECT * FROM access_log WHERE source = 'ai'").get()
  assert.ok(row, 'AI 读表必须落一条访问记录（否则界面永远是空的）')
  assert.equal(row.tool, 'query')
  assert.equal(row.target, 'students')
  assert.equal(row.actor, '整理班费', '要记下是哪次对话读的')
  assert.equal(row.result, 'ok')
  assert.ok(row.amount >= 0 && row.detail.includes('行'), 'detail 要能看出读了多少行')

  // 写类工具不进访问记录：写入的痕迹在「更改审查」，重复记一遍只会让两份口径打架
  await tools.runTool('propose_write', { operation: 'add', table: 'students', data: { 姓名: '新同学' } },
    { slug: 'default', convTitle: '整理班费', blocks: [] })
  const writes = fx.conn.prepare("SELECT COUNT(*) AS n FROM access_log WHERE tool LIKE 'propose%'").get().n
  assert.equal(writes, 0, '写类工具不该进访问记录')
})

// 「被拒」是这一页存在的核心理由：证明老师关掉的那张表确实挡住了 AI，
// 而不是关了个寂寞。所以关闭后必须落 denied，不能混进 failed。
test('按表关闭时第一次读取记 denied（而不是 failed）', async () => {
  fx.reset()
  const cfgStore = require('../../student-backend/services/aiConfigStore')
  cfgStore.setPrivacy({ closed_tables: ['students'] })
  const tools = require('../../student-backend/routes/ai/ai.tools/tools')
  const origSlug = dbManager.currentSlug
  dbManager.currentSlug = () => 'default'
  const out = await tools.runTool('query', { table: 'students' }, { slug: 'default', convTitle: '排座位', blocks: [] })
  dbManager.currentSlug = origSlug

  assert.match(String(out.result.error || ''), /设置/, '前置：错误文案要指明去设置里开（判据 §4）')
  const row = fx.conn.prepare("SELECT * FROM access_log WHERE source = 'ai'").get()
  assert.ok(row, '被拒也要留痕')
  assert.equal(row.result, 'denied', '被拒必须单列成 denied')
  assert.equal(row.tool, 'query')
  assert.match(row.reason, /设置/, '被拒原因要能看懂是「被设置挡下」')

  const s = await fx.call('GET', '/?source=ai')
  assert.equal(s.json.summary.denied, 1)
  assert.equal(s.json.summary.failed, 0, '被拒不能算进失败')
})

// ---------------------------------------------------------------------------
// 写入：与读合成同一条时间线，但**不复制数据** —— 已执行的写来自 undo_history
// （「设置 → 更改审查」那份权威记录），未执行的写来自 mcp_proposals。
// 两侧仍然各看各的：AI 列表里不该出现 MCP 的写，反之亦然。
// ---------------------------------------------------------------------------

const undoStore = require('../../student-backend/services/undoStore')
const proposalStore = require('../../student-backend/services/mcpProposalStore')

// origin 决定 source：32 位 hex = MCP 提案 id，其余非空 = AI 助手
function pushAiWrite(label, origin = 'ai-1700000000000-abc123') {
  return undoStore.push({ key: 'students', type: 'row_update', label, payload: { id: 1 }, origin })
}

test('写入进时间线：AI 的写只在 AI 侧，MCP 的写只在 MCP 侧', async () => {
  fx.reset()
  pushAiWrite('修改学生姓名')
  undoStore.push({
    key: 'fee_records', type: 'row_update', label: '改班费金额', payload: { id: 2 },
    origin: '0123456789abcdef0123456789abcdef',
  })

  const ai = await fx.call('GET', '/?source=ai')
  const aiWrites = ai.json.logs.filter((l) => l.kind === 'write')
  assert.equal(aiWrites.length, 1, 'AI 侧只该看到 AI 的写')
  assert.equal(aiWrites[0].detail, '修改学生姓名')
  assert.equal(aiWrites[0].target, 'students')
  assert.equal(ai.json.summary.writes, 1, '摘要要报写入次数')

  const mcp = await fx.call('GET', '/?source=mcp')
  const mcpWrites = mcp.json.logs.filter((l) => l.kind === 'write')
  assert.equal(mcpWrites.length, 1, 'MCP 侧只该看到 MCP 的写')
  assert.equal(mcpWrites[0].target, 'fee_records')
})

test('一次动作的多条撤销记录折成一行（否则批量导入会刷一屏）', async () => {
  fx.reset()
  const origin = 'ai-1700000000001-batch'
  for (const name of ['甲', '乙', '丙']) {
    undoStore.push({ key: 'students', type: 'row_insert', label: `新增学生 ${name}`, payload: { id: 1 }, origin })
  }

  const r = await fx.call('GET', '/?source=ai')
  const writes = r.json.logs.filter((l) => l.kind === 'write')
  assert.equal(writes.length, 1, '同一 origin 的 3 条必须折成一步')
  assert.equal(writes[0].count, 3, '折叠后要保留条数')
})

test('撤销过的写仍留在时间线里，标成「已撤销」而不是消失', async () => {
  fx.reset()
  const id = pushAiWrite('删除学生')
  fx.conn.prepare('UPDATE undo_history SET dir = 0 WHERE id = ?').run(id)

  const r = await fx.call('GET', '/?source=ai')
  const w = r.json.logs.find((l) => l.kind === 'write')
  assert.ok(w, '撤销过不等于没发生过，仍要能看到')
  assert.equal(w.result, 'undone')
  // 「仅看被拒与失败」不该把「已撤销」混进来（那不是异常）
  const bad = await fx.call('GET', '/?source=ai&onlyAbnormal=1')
  assert.equal(bad.json.logs.filter((l) => l.kind === 'write').length, 0)
})

test('MCP 待确认提案出现在 MCP 侧（pending），且不进 AI 侧', async () => {
  fx.reset()
  proposalStore.create({
    kind: 'row_write', label: '把张三的班费改成 50', table: 'fee_records',
    operation: 'update', payload: { id: 1, data: {} }, requestedBy: 'mcp',
  })

  const mcp = await fx.call('GET', '/?source=mcp')
  const p = mcp.json.logs.find((l) => l.kind === 'proposal')
  assert.ok(p, '待确认提案要出现在 MCP 时间线里')
  assert.equal(p.result, 'pending')
  assert.equal(mcp.json.summary.pending, 1, '摘要要报待确认条数')

  const ai = await fx.call('GET', '/?source=ai')
  assert.equal(ai.json.logs.filter((l) => l.kind === 'proposal').length, 0, 'AI 侧没有提案概念')
})

test('清空只清读取记录，写入一条都不能动（否则就没法回退了）', async () => {
  fx.reset()
  rec({ source: 'ai' })
  pushAiWrite('修改学生姓名')

  const del = await fx.call('DELETE', '/?source=ai')
  assert.equal(del.status, 200)
  assert.equal(del.json.removed, 1, '只删掉 1 条读记录')

  const r = await fx.call('GET', '/?source=ai')
  assert.equal(r.json.logs.filter((l) => l.kind === 'read').length, 0)
  assert.equal(r.json.logs.filter((l) => l.kind === 'write').length, 1, '写入记录必须还在')
  assert.equal(fx.conn.prepare('SELECT COUNT(*) AS n FROM undo_history').get().n, 1)
})
