// =========================================================================
// ai-privacy-wiring.test.js —— AI 数据保护第 2 批：存储开关 + 最小闭环接线
//
// 清单 §1（两列 / 种子 / 读取）、§1.2b（导出守卫）、§3.1（工具结果主闸门）、
// §3.4（工具入参还原）、§7（端到端 / 写入 / 未知代号 / MCP 不半生效）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-privacy-wiring', currentSlug: '@privacy' })
const conn = fx.conn
const SEED_TEXT = 'f'.repeat(64)

let aiConfigStore
let aiPrivacy
let tools
let toolResultContent
let savedSeed = ''

function sse(chunks) {
  return chunks.join('\n') + '\n'
}

test.before(async () => {
  conn.prepare("UPDATE ai_settings SET enabled = 1, privacy_json = ? WHERE id = 1")
    .run(JSON.stringify({ enabled: true, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [] }))
  conn.prepare("INSERT INTO ai_models (name, provider, base_url, model, api_key, is_active, reasoning) VALUES ('t', 'deepseek', 'http://mock.local/v1', 'm', 'k', 1, 0)").run()
  conn.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 家长联系电话) VALUES (1, '001', '初二', '3班', '张三', '13812345678')").run()

  aiConfigStore = require(path.join(ROOT, 'student-backend/services/aiConfigStore'))
  aiPrivacy = require(path.join(ROOT, 'student-backend/services/aiPrivacy'))
  tools = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools'))
  ;({ toolResultContent } = require(path.join(ROOT, 'student-backend/routes/ai/ai.helpers')))
  savedSeed = aiConfigStore.ensureSeed()

  await fx.mount('/api/data', 'student-backend/routes/dataExport.js')
  // 路由用 req.user.dbSlug 取 slug；夹具不注入登录态，这里补一层中间件
  const express = backendRequire('express')
  const outer = express.Router()
  outer.use((req, _res, next) => { req.user = { dbSlug: '@privacy' }; next() })
  outer.use(require(path.join(ROOT, 'student-backend/routes/ai/ai.conversations.js')))
  await fx.mount('/api/ai', outer)
})

test.after(() => fx.close())

test('§1 旧库升级后两列齐全，种子懒生成且单飞，坏 JSON 回退默认', () => {
  const cols = conn.prepare('PRAGMA table_info(ai_settings)').all().map((c) => c.name)
  assert.ok(cols.includes('privacy_seed') && cols.includes('privacy_json'))
  assert.match(savedSeed, /^[0-9a-f]{64}$/)
  assert.equal(aiConfigStore.ensureSeed(), savedSeed, '二次调用必须读到同一个值')
  assert.equal(aiConfigStore.readPrivacy().enabled, true, '写入→读出往返')

  conn.prepare("UPDATE ai_settings SET privacy_json = '{bad'").run()
  assert.equal(aiConfigStore.readPrivacy().enabled, false, '坏 JSON 回退默认，不抛')
  conn.prepare('UPDATE ai_settings SET privacy_json = ?').run(JSON.stringify({ enabled: true }))
})

test('§1.2b 种子不进导出：应用设置表不含列名也不含 64 位 hex', async () => {
  conn.prepare('UPDATE ai_settings SET privacy_seed = ?').run(SEED_TEXT)
  try {
    const r = await fx.call('POST', '/api/data/sources', { keys: ['settings'] })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    const text = JSON.stringify(r.json)
    assert.ok(!text.includes('privacy_seed'), '导出表不能出现这个设置项')
    assert.ok(!text.includes(SEED_TEXT), '导出表不能出现种子明文')
  } finally {
    conn.prepare('UPDATE ai_settings SET privacy_seed = ?').run(savedSeed)
  }
})

test('§3.1 主闸门：传 slug 才替换；MCP 不传 slug 保持原样', () => {
  const out = toolResultContent({ rows: [{ 姓名: '张三', 家长联系电话: '13812345678' }] }, '@privacy')
  assert.ok(!out.includes('张三'))
  assert.ok(!out.includes('13812345678'))
  assert.match(out, /S-[0-9a-f]{6}/)
  assert.match(out, /P-[0-9a-f]{6}/)
  assert.match(toolResultContent({ rows: [{ 姓名: '张三' }] }), /张三/, '不传 slug 时零变化')

  const mcp = fs.readFileSync(path.join(ROOT, 'student-backend/services/mcpTools.js'), 'utf8')
  assert.match(mcp, /toolResultContent\(result\)/, 'MCP 方向 B 本批不接，不许悄悄带上 slug')
})

test('§3.4 入站还原：提案落库前是真值，未知代号被拒，MCP 侧不还原', async () => {
  const m = aiPrivacy.privacy.buildMap('@privacy')
  const alias = m.nameToAlias.get('张三')
  const token = m.phoneToToken.get('13812345678')
  assert.ok(alias && token, '前置：映射表里有张三和号码')

  const out = await tools.runTool('propose_write', {
    operation: 'update', table: 'students',
    data: { id: 1, changes: { 姓名: alias, 家长联系电话: token } },
  }, { slug: '@privacy' })
  assert.equal(out.result.ok, true, JSON.stringify(out.result).slice(0, 200))
  assert.equal(out.proposal.data.changes.姓名, '张三')
  assert.equal(out.proposal.data.changes.家长联系电话, '13812345678')
  assert.ok(!JSON.stringify(out.proposal).includes(alias), '确认卡片上不能出现代号')

  const bad = await tools.runTool('propose_write', {
    operation: 'update', table: 'students', data: { id: 1, changes: { 姓名: 'P-zzzzzz' } },
  }, { slug: '@privacy' })
  assert.equal(bad.result.ok, false, '认不出的代号必须拒绝')
  assert.match(bad.result.error, /无法识别/)
  assert.ok(!bad.proposal, '拒绝时不能生成提案')

  const noSlug = await tools.runTool('propose_write', {
    operation: 'update', table: 'students', data: { id: 1, changes: { 姓名: alias } },
  }, {})
  assert.equal(noSlug.proposal.data.changes.姓名, alias, 'MCP 侧不带 slug，保持原样')

  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.js'), 'utf8')
  const atRestore = src.indexOf('privacy.restore(args')
  // 派发函数已改名为 dispatchTool：runTool 现在是外层壳（先派发、再记数据访问记录），
  // 还原仍然留在派发函数内部的第一行，判据跟着它走。
  const atNormalize = src.indexOf('function dispatchTool')
  assert.ok(atNormalize > 0, '派发入口必须仍叫 dispatchTool')
  assert.ok(atRestore > atNormalize && atRestore < src.indexOf("case 'propose_write'"), '还原必须在派发/规范化之前')
})

test('§7 端到端：一轮真实对话里工具结果不含真名/真号', async () => {
  const toolFrame = sse([
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'query', arguments: '{"table":"students"}' } }] } }] }),
    'data: [DONE]',
  ])
  const finalFrame = sse([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '查到 1 人' } }] }),
    'data: [DONE]',
  ])
  const requests = []
  const realFetch = global.fetch
  let n = 0
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, opts) // 夹具自己的请求
    if (String(url).includes('/chat/completions')) {
      requests.push(JSON.parse(opts.body))
      return {
        ok: true,
        body: { getReader() { let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: Buffer.from(n++ === 0 ? toolFrame : finalFrame, 'utf8') } } } } },
      }
    }
    return realFetch(url, opts)
  }
  let res
  try {
    res = await fx.call('POST', '/api/ai/chat/stream', {
      conversationId: 0, webSearch: false, messages: [{ role: 'user', content: '查一下学生' }],
    })
  } finally {
    global.fetch = realFetch
  }
  assert.equal(res.status, 200, res.text.slice(0, 300))
  assert.ok(requests.length >= 2, '应该有一轮工具调用 + 一轮收尾')
  const toolMsg = requests[1].messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg, '第二轮请求里要有 role:tool 的结果')
  assert.ok(!toolMsg.content.includes('张三'), '工具结果不能把真名发给模型')
  assert.ok(!toolMsg.content.includes('13812345678'), '工具结果不能把真号发给模型')
  assert.match(toolMsg.content, /S-[0-9a-f]{6}/)
})
