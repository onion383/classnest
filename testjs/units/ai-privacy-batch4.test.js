// =========================================================================
// ai-privacy-batch4.test.js —— AI 数据保护第 4 批：按表关闭 + web_search 拦截 + 前端设置
//
// 清单 §4：effectiveReadTables 单点、query/aggregate/search_all/describe_table/
//          list_tables/子助手执行层六处共用一个有效表集；被关表明确报错（含「设置」）。
// 清单 §5：隐私模式下 web_search 遇代号直接拒绝，不发起 fetch。
// 清单 §6：GET/PUT /api/ai/privacy 读写 ai_settings；前端面板 + 两处索引 + 三条文案。
// 判据不靠印象：纯函数 + 变异反证 + 源码钉子。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-privacy-b4', currentSlug: '@b4' })
const conn = fx.conn
const SLUG = '@b4'

let aiConfigStore
let aiPrivacy
let tools
let aiConfigRouter
let readScopeMod

const PRIVACY_ON = JSON.stringify({ enabled: true, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [] })

test.before(async () => {
  conn.prepare('UPDATE ai_settings SET enabled = 1, privacy_json = ? WHERE id = 1').run(PRIVACY_ON)
  conn.prepare("INSERT INTO ai_models (name, provider, base_url, model, api_key, is_active, reasoning) VALUES ('t', 'deepseek', 'http://mock.local/v1', 'm', 'k', 1, 0)").run()

  aiConfigStore = require(path.join(ROOT, 'student-backend/services/aiConfigStore'))
  aiPrivacy = require(path.join(ROOT, 'student-backend/services/aiPrivacy'))
  tools = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools'))
  readScopeMod = require(path.join(ROOT, 'student-backend/services/aiReadScope'))
  aiConfigStore.ensureSeed()

  aiConfigRouter = require(path.join(ROOT, 'student-backend/routes/ai/ai.config.js'))
  await fx.mount('/api/ai', aiConfigRouter)
})

test.after(() => fx.close())

function setClosed(tables) {
  aiConfigStore.setPrivacy({ closed_tables: tables })
  aiPrivacy.privacy.invalidate()
  readScopeMod.readScope.effectiveReadTables() // 触发一次读，确认不抛
}

// ---------- §4 纯函数 ----------
test('§4.1 filterReadTables 纯函数：剔除被关表，不改原对象', () => {
  const { READ_TABLES, filterReadTables } = require(path.join(ROOT, 'student-backend/routes/ai/ai.constants'))
  const before = Object.keys(READ_TABLES).length
  const eff = filterReadTables(READ_TABLES, ['fee_records', 'students'])
  assert.ok(!eff.fee_records && !eff.students)
  assert.equal(Object.keys(eff).length, before - 2)
  assert.equal(Object.keys(READ_TABLES).length, before, '原常量不许被改')
  // 非法 closed_tables（非数组）当作全开
  assert.equal(Object.keys(filterReadTables(READ_TABLES, null)).length, before)
})

// ---------- §4 单点：六处读表入口共用有效表集 ----------
test('§4 query/aggregate：关掉 fee_records 后明确报错且文案含「设置」', async () => {
  setClosed(['fee_records'])
  const q = await tools.runTool('query', { table: 'fee_records' }, { slug: SLUG })
  assert.equal(q.result.ok, undefined)
  assert.match(q.result.error, /设置/)
  assert.match(q.result.error, /fee_records/)
  const ag = await tools.runTool('aggregate', { table: 'fee_records', metrics: [{ fn: 'count' }] }, { slug: SLUG })
  assert.match(ag.result.error, /设置/)
  // 未关的表照常可读（不是「全关死」）
  const ok = await tools.runTool('query', { table: 'students' }, { slug: SLUG })
  assert.ok(!ok.result.error, JSON.stringify(ok.result).slice(0, 160))
  setClosed([])
})

test('§4 describe_table：被关表明确报错；list_tables 不再列出该表', async () => {
  setClosed(['fee_records'])
  const d = await tools.runTool('describe_table', { table: 'fee_records' }, { slug: SLUG })
  assert.match(d.result.error, /设置/)
  const mcp = require(path.join(ROOT, 'student-backend/services/mcpTools'))
  const list = mcp.listTables()
  assert.equal(list.ok, true)
  const keys = list.tables.map((t) => t.key)
  assert.ok(!keys.includes('fee_records'), 'list_tables 里不能再出现被关的表')
  assert.ok(keys.includes('students'), '其它表仍要列出')
  setClosed([])
})

test('§4 search_all：显式指定被关表报错，默认全查时静默剔除', async () => {
  setClosed(['score_records'])
  const explicit = await tools.runTool('search_all', { query: '张', tables: ['score_records'] }, { slug: SLUG })
  assert.match(explicit.result.error, /设置/)
  const all = await tools.runTool('search_all', { query: '张' }, { slug: SLUG })
  assert.ok(!all.result.error, JSON.stringify(all.result).slice(0, 160))
  assert.ok(!all.result.tables.includes('score_records'), '默认全查时不能扫被关的表')
  setClosed([])
})

test('§4 子助手执行层：关掉的表经 subagent 的 query 也被拦（同一 runTool 路径）', async () => {
  setClosed(['fee_records'])
  // 子助手执行走的是 tools.runTool，直接验证这条路径上的 executor 已拦；
  // 另用源码判据钉住「子助手白名单与 query 共用同一套 executor」，防止将来分叉。
  const q = await tools.runTool('query', { table: 'fee_records' }, { slug: SLUG })
  assert.match(q.result.error, /设置/)
  const sub = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.subagent.js'), 'utf8')
  const execSrc = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.query.js'), 'utf8')
  assert.match(sub, /runTool/, '子助手必须走统一 runTool')
  assert.match(execSrc, /readScope\.isTableReadable\(table\)/, 'runQuery 必须挂按表关闭守卫')
  setClosed([])
})

// ---------- §5 web_search ----------
test('§5 隐私模式：web_search 遇代号直接拒绝且不发起 fetch', async () => {
  setClosed([])
  aiConfigStore.setPrivacy({ enabled: true })
  aiPrivacy.privacy.invalidate()
  const realFetch = global.fetch
  let fetched = 0
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, opts)
    fetched += 1
    throw new Error('不应该发起外部搜索请求')
  }
  try {
    const r = await tools.runTool('web_search', { query: 'S-a3f1c9 学籍' }, { slug: SLUG })
    assert.equal(r.result.ok, false)
    assert.match(r.result.error, /不含学生|代号/)
    assert.equal(fetched, 0, '代号搜索必须在不发请求前就被拦下')
    // 正常搜索词放行（只拦代号，不拦普通词）
    const plain = await tools.runTool('web_search', { query: 'weather today' }, { slug: SLUG })
    assert.equal(plain.result.ok, false, '无 DeepSeek 正确配置时仍可能失败，但不能是「代号」类拒绝')
    assert.ok(!/不含学生|代号/.test(plain.result.error || ''), '普通词不能被代号守卫误拦')
  } finally { global.fetch = realFetch }
})

test('§5 隐私关闭时：代号不被 web_search 守卫拦（守卫跟随总开关）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.js'), 'utf8')
  assert.match(src, /aiPrivacy\.enabled\(ctx && ctx\.slug\) && hasUnrestoredToken\(query\)/, '守卫必须受隐私总开关约束')
  // 源码钉住：拒绝分支在 fetch 之前（否则拦了个寂寞）
  const atGuard = src.indexOf('联网搜索无法使用学生代号')
  const atFetch = src.indexOf("fetch('https://api.deepseek.com/v1/tools/search'")
  assert.ok(atGuard > 0 && atFetch > 0 && atGuard < atFetch, '拒绝必须在 fetch 之前')
})

// ---------- §6 前端设置 API ----------
test('§6 GET/PUT /api/ai/privacy：读写 ai_settings，状态刷新后保持', async () => {
  aiConfigStore.setPrivacy({ enabled: false, hide_phone: true, closed_tables: ['fee_records'] })
  const g = await fx.call('GET', '/api/ai/privacy')
  assert.equal(g.status, 200, g.text.slice(0, 200))
  assert.equal(g.json.success, true)
  assert.equal(g.json.data.enabled, false)
  assert.deepEqual(g.json.data.closed_tables, ['fee_records'])
  assert.ok(Array.isArray(g.json.data.tables) && g.json.data.tables.length > 0, '表清单由后端下发')

  const p = await fx.call('PUT', '/api/ai/privacy', { enabled: true, hide_phone: false, closed_tables: ['fee_records', 'not_a_table'], evil: 1 })
  assert.equal(p.status, 200, p.text.slice(0, 200))
  assert.equal(p.json.data.enabled, true)
  assert.equal(p.json.data.hide_phone, false)
  assert.deepEqual(p.json.data.closed_tables, ['fee_records'], '未知表名必须被过滤掉')
  assert.equal(p.json.data.evil, undefined, '未知字段不得透传')

  // 换一次 GET，确认确实落库（不是只在内存里改）
  const g2 = await fx.call('GET', '/api/ai/privacy')
  assert.equal(g2.json.data.enabled, true)
  assert.equal(g2.json.data.hide_phone, false)
  aiConfigStore.setPrivacy({ enabled: true, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [] })
})

test('§6 前端：面板挂载 + 两处索引 + 三条文案 + 三条文案源码钉子', () => {
  const sv = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/SettingsView/SettingsView.vue'), 'utf8')
  assert.match(sv, /import AiPrivacyPanel/, '面板已引入')
  assert.match(sv, /<AiPrivacyPanel\s*\/>/, '面板已挂载')
  assert.match(sv, /settings-section-aiprivacy/, '区块锚点存在')
  // 两处索引（SettingsView 内部搜索）
  assert.match(sv, /key:\s*'aiprivacy'/, '分区列表已加')
  assert.match(sv, /section:\s*'aiprivacy'/, '搜索词列表已加')
  // 全局搜索索引也同步
  const sd = fs.readFileSync(path.join(ROOT, 'student-frontend/src/config/searchData.js'), 'utf8')
  assert.match(sd, /key:\s*'aiprivacy'/, '全局搜索分区已加')
  // 面板三条文案
  const panel = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/data-manage/AiPrivacyPanel.vue'), 'utf8')
  assert.match(panel, /只保护已入库的值/)
  assert.match(panel, /图片和自由文本管不住/)
  assert.match(panel, /关闭某张表后，AI 会失去/)
  // 面板读写的是 /api/ai/privacy，不是 localStorage
  assert.match(panel, /axios\.get\('\/api\/ai\/privacy'\)/)
  assert.ok(!/localStorage/.test(panel), '设置不能存 localStorage')
})
