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
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBackendDb, ROOT, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

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

  aiConfigStore = require(abs('student-backend/services/aiConfigStore'))
  aiPrivacy = require(abs('student-backend/services/aiPrivacy'))
  tools = require(abs('student-backend/routes/ai/ai.tools/tools'))
  readScopeMod = require(abs('student-backend/services/aiReadScope'))
  aiConfigStore.ensureSeed()

  aiConfigRouter = require(abs('student-backend/routes/ai/ai.config.js'))
  await fx.mount('/api/ai', aiConfigRouter)
})

test.after(() => fx.close())

function setClosed(tables) {
  aiConfigStore.setPrivacy({ closed_tables: tables })
  aiPrivacy.privacy.invalidate()
  readScopeMod.readScope.effectiveReadTables() // 触发一次读，确认不抛
}

// ---------- §4 纯函数 ----------
test('§4.0 人读目录与 READ_TABLES 键集一致（新增表必须补中文名，否则界面会退回英文说明）', () => {
  const { READ_TABLES, READ_TABLE_LABELS } = require(abs('student-backend/routes/ai/ai.constants'))
  assert.deepEqual(Object.keys(READ_TABLE_LABELS).sort(), Object.keys(READ_TABLES).sort(), '两处键集必须一模一样')
  for (const [key, v] of Object.entries(READ_TABLE_LABELS)) {
    assert.ok(v.label && /[\u4e00-\u9fa5]/.test(v.label), `${key} 缺中文名`)
    assert.ok(v.hint && /[\u4e00-\u9fa5]/.test(v.hint), `${key} 缺解释`)
    assert.ok(!/[A-Za-z]/.test(v.label + v.hint), `${key} 的中文名/解释里混进了英文标识`)
  }
})

test('§4.2 makeWriteScope 纯函数：只读拦写、不支持写的表不算「只读」', () => {
  const { makeWriteScope } = require(abs('student-backend/services/aiWriteScope'))
  const canWrite = (t) => t === 'students' || t === 'scores'
  const ws = makeWriteScope({ readReadonly: () => ['students'], supportsWrite: canWrite })
  assert.equal(ws.isTableWritable('students'), false, '设了只读就写不了')
  assert.equal(ws.isTableWritable('scores'), true, '没设只读的白名单表照常可写')
  assert.equal(ws.isTableWritable('groups'), false, '本就不支持写入的表不能写')
  assert.match(ws.readonlyError('students').error, /只读/)
  // 变异反证：只读清单清空后必须放行，否则上面那条只是「永远 false」
  const ws2 = makeWriteScope({ readReadonly: () => [], supportsWrite: canWrite })
  assert.equal(ws2.isTableWritable('students'), true)
})

test('§4.1 filterReadTables 纯函数：剔除被关表，不改原对象', () => {
  const { READ_TABLES, filterReadTables } = require(abs('student-backend/routes/ai/ai.constants'))
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

test('§4 describe_table：被关表明确报错；MCP 表清单不再跟着 AI 的开关走', async () => {
  setClosed(['fee_records'])
  const d = await tools.runTool('describe_table', { table: 'fee_records' }, { slug: SLUG })
  assert.match(d.result.error, /设置/)
  // 权限拆分后 MCP 有自己的那份配置：AI 侧关掉一张表，不该让它从外部客户端的
  // 表清单里消失（反过来也一样）。MCP 侧关表生效由 mcp-read-scope.test.js 钉住。
  const mcp = require(abs('student-backend/services/mcpTools'))
  const list = mcp.listTables()
  assert.equal(list.ok, true)
  const keys = list.tables.map((t) => t.key)
  assert.ok(keys.includes('fee_records'), 'MCP 权限独立：AI 关表不影响外部客户端看到的表')
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
  const sub = fs.readFileSync(abs('student-backend/routes/ai/ai.tools/tools.subagent.js'), 'utf8')
  const execSrc = fs.readFileSync(abs('student-backend/routes/ai/ai.tools/tools.executors/executors.query.js'), 'utf8')
  assert.match(sub, /runTool/, '子助手必须走统一 runTool')
  // @pin student-backend/routes/ai/ai.tools/tools.executors/executors.query.js#runQuery
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
  const src = fs.readFileSync(abs('student-backend/routes/ai/ai.tools/tools.executors/executors.js'), 'utf8')
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
  // 界面用的人读目录：中文名 + 解释；英文表名只在 key 里流转，不上界面（2026-11-17 定）
  const t0 = g.json.data.tables[0]
  assert.equal(t0.key, 'students', 'key 仍是 closed_tables 的取值')
  assert.ok(t0.label && t0.hint, '每条都带中文名与解释')
  assert.match(t0.label, /^[\u4e00-\u9fa5]+$/, '中文名优先：label 纯中文')
  assert.ok(g.json.data.tables.every((t) => /[\u4e00-\u9fa5]/.test(t.label) && t.hint), '每张表都有中文名与解释')
  assert.ok(g.json.data.tables.every((t) => !/[A-Za-z]/.test(t.label + t.hint)), '界面上不出现英文表名/列名')

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

test('§6 单表权限档：完全禁止 / 只读 / 读写，且写闸门真的拦得住', async () => {
  aiConfigStore.setPrivacy({ closed_tables: [], readonly_tables: [] })

  // 默认档位刻意保持改造前行为：能写的表=读写（提案仍需确认），不能写的表=只读
  const g = await fx.call('GET', '/api/ai/privacy')
  const byKey = Object.fromEntries(g.json.data.tables.map((t) => [t.key, t]))
  assert.equal(byKey.students.level, 'write', '学生名单可写，默认读写')
  assert.equal(byKey.students.writable, true)
  assert.equal(byKey.groups.level, 'read', '不支持写入的表默认只读')
  assert.equal(byKey.groups.writable, false)

  // 只读：落 readonly_tables，写工具被拦，读不受影响
  const p1 = await fx.call('PUT', '/api/ai/privacy', { table: 'students', level: 'read' })
  assert.equal(p1.status, 200)
  assert.ok(p1.json.data.readonly_tables.includes('students'), '只读记在 readonly_tables')
  assert.ok(!p1.json.data.closed_tables.includes('students'), '两套清单互斥')
  const blocked = await tools.runTool('propose_write', { table: 'students', operation: 'add', data: { 姓名: '测试甲' } })
  assert.equal(blocked.result.ok, false, '只读表的写提案必须被拒')
  assert.match(String(blocked.result.error), /只读/)
  const stillRead = await tools.runTool('query', { table: 'students' })
  assert.ok(!stillRead.result.error, '只读不影响读取')

  // 完全禁止：同时进 closed_tables（读闸门）和 readonly_tables（写闸门），读写都拦
  const p2 = await fx.call('PUT', '/api/ai/privacy', { table: 'students', level: 'none' })
  assert.ok(p2.json.data.closed_tables.includes('students'))
  assert.ok(p2.json.data.readonly_tables.includes('students'), '完全禁止必须同时断写（#5）：写闸门只看 readonly_tables')
  const noRead = await tools.runTool('query', { table: 'students' })
  assert.match(String(noRead.result.error || ''), /关闭/)
  const noWrite = await tools.runTool('propose_write', { table: 'students', operation: 'add', data: { 姓名: '测试乙' } })
  assert.equal(noWrite.result.ok, false, '完全禁止的表写提案必须被拒（过去只断读、写能过）')

  // 非法输入一律 400：不支持写的表设「读写」、不存在的表、未知档位
  assert.equal((await fx.call('PUT', '/api/ai/privacy', { table: 'groups', level: 'write' })).status, 400)
  assert.equal((await fx.call('PUT', '/api/ai/privacy', { table: 'not_a_table', level: 'read' })).status, 400)
  assert.equal((await fx.call('PUT', '/api/ai/privacy', { table: 'students', level: 'admin' })).status, 400)

  // 还原默认，别影响后续用例
  await fx.call('PUT', '/api/ai/privacy', { table: 'students', level: 'write' })
  aiConfigStore.setPrivacy({ closed_tables: [], readonly_tables: [] })
})

test('§6 前端：AI 助手标题栏一级入口 + 设置页已移除 + 三条文案', () => {
  // 入口位置：AI 助手页标题栏「数据保护」按钮 → 独立弹窗（2026-11-17 定：不进设置页、也不塞进数据管理弹窗）
  const ai = fs.readFileSync(abs('student-frontend/src/views/AiAssistant.vue'), 'utf8')
  assert.match(ai, /import\('\.\.\/components\/dialogs\/AiPrivacyDialog\.vue'\)/, '弹窗按需加载已声明')
  assert.match(ai, /function openPrivacy\(\)/, '有打开函数')
  assert.match(ai, /@click="openPrivacy"/, '标题栏按钮已接线到打开函数')
  assert.match(ai, /<AiPrivacyDialog v-if="privacyOpened"/, '首次打开才渲染（懒加载口径与数据管理弹窗一致）')
  // 按钮必须在「数据管理」之前（视觉顺序：未启用 · 数据保护 · 数据管理 · 设置）
  const iBtn = ai.indexOf('@click="openPrivacy"')
  const iDm = ai.indexOf('@click="openDataManage"')
  assert.ok(iBtn > 0 && iDm > 0 && iBtn < iDm, '数据保护按钮排在数据管理左侧')
  // 弹窗外壳只装面板，不重复实现开关逻辑
  const dlg = fs.readFileSync(abs('student-frontend/src/components/dialogs/AiPrivacyDialog.vue'), 'utf8')
  assert.match(dlg, /<AiPrivacyPanel\s*\/>/, '弹窗内挂载面板')
  assert.ok(!/axios\./.test(dlg), '读写逻辑留在面板，外壳不碰接口')
  // 数据管理弹窗必须退出：否则同一份设置在两个入口各有一份，改一个不知道另一个
  const dm = fs.readFileSync(abs('student-frontend/src/components/data-manage/DataManageDialog.vue'), 'utf8')
  assert.ok(!/AiPrivacyPanel/.test(dm), '数据管理弹窗不再挂载面板')
  // 设置页必须彻底退出：挂载、锚点、内部索引都不能留（留着就是滚不到的死链）
  const sv = fs.readFileSync(abs('student-frontend/src/views/SettingsView/SettingsView.vue'), 'utf8')
  assert.ok(!/AiPrivacyPanel/.test(sv), '设置页不再引用面板')
  assert.ok(!/settings-section-aiprivacy/.test(sv), '设置页不再有该锚点')
  assert.ok(!/aiprivacy/.test(sv), '设置页不再有该分区索引')
  // 全局搜索索引同步移除（原先指向的设置页锚点已不存在）
  const sd = fs.readFileSync(abs('student-frontend/src/config/searchData.js'), 'utf8')
  assert.ok(!/aiprivacy/.test(sd), '全局搜索索引已移除')
  // 面板文案：长说明收进 ⓘ（AppHelp），常驻区只剩标题与开关
  const panel = fs.readFileSync(abs('student-frontend/src/components/data-manage/AiPrivacyPanel.vue'), 'utf8')
  const toggles = fs.readFileSync(abs('student-frontend/src/components/data-manage/PrivacyToggles.vue'), 'utf8')
  const list = fs.readFileSync(abs('student-frontend/src/components/data-manage/TableScopeList.vue'), 'utf8')
  const api = fs.readFileSync(abs('student-frontend/src/composables/usePrivacyConfig.js'), 'utf8')

  // 面板只做排版：三个共享件各管一段，读写归 composable（否则 MCP 面板要抄第二份判定）
  assert.match(panel, /import PrivacyToggles from '\.\/PrivacyToggles\.vue'/, '混淆项走共享组件')
  assert.match(panel, /import TableScopeList from '\.\/TableScopeList\.vue'/, '按表权限走共享组件')
  assert.match(panel, /usePrivacyConfig\(\)/, '读写走同一个 composable')
  assert.ok(!/axios\./.test(panel), '面板自己不发请求（回到各写一份的老路）')

  // 两条长说明各就各位：总开关的在面板，三档的在表清单
  assert.match(panel, /import AppHelp from '\.\.\/base\/AppHelp\.vue'/, 'ⓘ 用的是项目现成的 AppHelp')
  assert.match(panel, /:text="switchHelp"/, '总开关说明收进 ⓘ')
  assert.match(list, /import AppHelp from '\.\.\/base\/AppHelp\.vue'/, '表清单也用它')
  assert.match(list, /:text="help"/, '三档说明收进 ⓘ')
  // 弹窗 z-index 是 10005，气泡必须更高，否则被遮在弹窗下面
  assert.match(panel, /:z-index="10007"/, 'ⓘ 层级高于弹窗')
  assert.match(list, /:z-index="10007"/, '表清单的 ⓘ 同样要高过弹窗')
  assert.match(panel, /只保护已入库的值/)
  assert.match(panel, /图片和自由文本管不住/)
  assert.match(list, /明确拒绝，不是返回空结果/)

  // 英文表名只做 key/取值，不许插值到界面
  assert.ok(!/\{\{\s*t\.key\s*\}\}/.test(list), '不把英文表名插值到界面')
  // 表格列必须能压缩，否则长解释会把弹窗撑出横向滚动条（截图里的问题）
  assert.match(list, /max-h-72 overflow-y-auto overflow-x-hidden/, '纵向滚动、横轴不滚')
  // 滚动条走项目自带的细滑块（不是原生条）：
  //   容器 .app-custom-scroll 把原生纵向条收成 0 宽；父级必须 relative（覆盖层按 offsetTop 定位）；
  //   覆盖层与容器是同级。三者缺一都会出现「两条滚动条」或「条飘到别处」。
  assert.match(list, /import CustomScrollbar from '\.\.\/base\/CustomScrollbar\.vue'/, '引入自带滚动条')
  assert.match(list, /ref="listRef"[^>]*app-custom-scroll/, '滚动容器挂了 ref 与 app-custom-scroll')
  assert.match(list, /<CustomScrollbar :target="listRef"[^>]*\/>/, '覆盖层绑的是同一个容器')
  assert.match(list, /class="relative ai-glass-panel/, '外套必须是定位父级：滚动条覆盖层按 offsetTop 定位')
  assert.match(list, /const listRef = ref\(null\)/, 'listRef 已声明')
  assert.ok(!/sm:grid-cols-2/.test(list), '表清单是单列排布（两列时解释被截断）')
  assert.match(list, /min-w-0/, '列表项允许收缩')

  // 读写的是接口，不是 localStorage；两种 scope 各走各的端点（AI 与 MCP 各一份配置）
  assert.match(api, /axios\.get\(url\)/, '请求地址由 scope 决定，不再写死 /api/ai/privacy')
  assert.match(api, /scope === 'mcp' \? '\/api\/mcp\/privacy' : '\/api\/ai\/privacy'/, '两种 scope 的端点必须分开')
  for (const [name, src] of [['面板', panel], ['勾选项', toggles], ['表清单', list], ['composable', api]]) {
    assert.ok(!/localStorage/.test(src), `${name}不能把设置存 localStorage`)
  }
  // 保存成功不弹常驻提示（开关/勾选框本身就是反馈），只有失败才提示
  assert.ok(!/已保存，下次对话起生效/.test(panel + api), '「已保存」提示已去掉')
  assert.ok(!/const saved = ref/.test(panel + api), 'saved 状态一并删净，不留死代码')
  assert.match(panel, /v-if="error"/, '失败提示保留')

  // 敏感信息混淆：三个混淆项
  assert.match(toggles, /敏感信息混淆/)
  // 总开关关掉时下面的设置照常显示：不能整块 v-if 收起来（收起来后看不见自己配过什么）
  assert.ok(!/v-if="cfg\.enabled"/.test(panel), '下方设置不再随总开关整块消失')
  assert.match(panel, /<TableScopeList\s+:tables="cfg\.tables"/, '表权限区始终在（没有条件渲染）')
  assert.match(toggles, /v-if="masterOff"[^>]*>总开关未开启，暂不生效/, '混淆项关闭时就地标注不生效')

  // 每张表一个权限下拉，三档齐全；不能写的表由后端 writable 收窄成两档
  assert.match(list, /import AppSelect from '\.\.\/base\/AppSelect\.vue'/, '用项目现成的下拉组件')
  assert.match(list, /\{ value: 'none', label: '完全禁止' \}/)
  assert.match(list, /\{ value: 'read', label: '只读' \}/)
  assert.match(list, /\{ value: 'write', label: '读写' \}/)
  assert.match(list, /return writableOf\(t\) \? LEVEL_OPTIONS : LEVEL_OPTIONS\.slice\(0, 2\)/, '不可写的表只给两档')
  // 每张表必然有一档：「未选择」不是合法状态，level 缺失时按能力退回默认档（能写=读写）。
  // 之前下拉直接绑 t.level，后端进程没重启（老接口不带 level）时整列显示占位文案「请选择」。
  assert.match(list, /:model-value="levelOf\(t\)"/, '下拉绑的是兜底后的档位，不是裸 t.level')
  assert.ok(!/:model-value="t\.level"/.test(list), '不能再直接绑裸 t.level（会退回占位文案）')
  assert.match(api, /export function levelOf\(t\)/, '档位兜底只留一份实现')
  assert.match(api, /return writableOf\(t\) \? 'write' : 'read'/, '缺档位时默认读写（不可写的表退回只读）')

  // 闪动的根因：等待回包期间 busy 触发重渲染，把受控勾选框按回旧值。
  // 现在改成「先改本地再发请求」，并且不再用 busy 禁用控件。
  assert.ok(!/:disabled="busy"/.test(panel + api), '不再用 busy 禁用控件（那会让开关闪一下）')
  assert.match(api, /cfg\.value = \{ \.\.\.cfg\.value, \[key\]: value \}/, '先改本地（乐观更新）')
  assert.match(api, /seqByKey\.get\(key\) !== seq/, '连点时只认最后一次回包')
})
