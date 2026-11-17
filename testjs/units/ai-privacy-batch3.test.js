// =========================================================================
// ai-privacy-batch3.test.js —— AI 数据保护第 3 批：全出口补齐
//
// 清单 §3.2 memory/summary、§3.2b toolTrace、§3.2c 技能 md、§3.3 用户消息、
// §3.5 正文 + 思维链流式反查（主对话与子助手）、坑6 摘要 transcript、坑5 提示措辞。
// 判据钉的是「发给模型的请求」与「下发给界面的 SSE」两份文本：前者无真值，
// 后者无代号、且过程块 detail 仍是真值。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-privacy-b3', currentSlug: '@b3' })
const conn = fx.conn
const SLUG = '@b3'
const NAME = '张三'
const PHONE = '13812345678'
const TOKEN_RE = /[SP]-[0-9a-z]{6,10}/gi

let dbm
let aiPrivacy
let aiConfigStore
let aiConversationStore

function sse(chunks) {
  return chunks.map((c) => 'data: ' + JSON.stringify(c)).join('\n') + '\ndata: [DONE]\n\n'
}
const delta = (txt) => ({ choices: [{ delta: { content: txt } }] })
const reason = (txt) => ({ choices: [{ delta: { reasoning_content: txt } }] })
const toolCall = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })

// 用一段一次性 SSE 流替换 global.fetch，收集每次发往模型的请求体；
// 非模型请求（夹具自己的 127.0.0.1）透传给真 fetch。
function mockModel(frames) {
  const requests = []
  const realFetch = global.fetch
  let n = 0
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, opts)
    if (String(url).includes('/chat/completions')) {
      requests.push(JSON.parse(opts.body))
      const frame = frames[Math.min(n++, frames.length - 1)]
      return {
        ok: true,
        body: { getReader() { let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: Buffer.from(frame, 'utf8') } } } } },
      }
    }
    return realFetch(url, opts)
  }
  return {
    requests,
    restore: () => { global.fetch = realFetch },
  }
}

test.before(async () => {
  conn.prepare("UPDATE ai_settings SET enabled = 1, privacy_json = ? WHERE id = 1")
    .run(JSON.stringify({ enabled: true, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [] }))
  conn.prepare("INSERT INTO ai_models (name, provider, base_url, model, api_key, is_active, reasoning) VALUES ('t', 'deepseek', 'http://mock.local/v1', 'm', 'k', 1, 1)").run()
  conn.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 家长联系电话) VALUES (1, '001', '初二', '3班', ?, ?)").run(NAME, PHONE)

  dbm = require(path.join(ROOT, 'student-backend/dbManager/dbManager'))
  aiPrivacy = require(path.join(ROOT, 'student-backend/services/aiPrivacy'))
  aiConfigStore = require(path.join(ROOT, 'student-backend/services/aiConfigStore'))
  aiConversationStore = require(path.join(ROOT, 'student-backend/services/aiConversationStore'))
  aiConfigStore.ensureSeed()

  // §3.2 记忆 + §3.2c 技能：写入真名真号，应被出站替换
  dbm.writeMemory(SLUG, `老师偏好：有事找 ${NAME}，电话 ${PHONE}`)
  dbm.writeSkill(SLUG, '找人', `见到 ${NAME} 就先打 ${PHONE} 确认`)

  const express = backendRequire('express')
  const outer = express.Router()
  outer.use((req, _res, next) => { req.user = { dbSlug: SLUG }; next() })
  outer.use(require(path.join(ROOT, 'student-backend/routes/ai/ai.conversations.js')))
  await fx.mount('/api/ai', outer)
})

test.after(() => fx.close())

// 造一条含真值 detail 的历史助手消息，供 buildToolTrace 读取
function seedToolTrace() {
  const cid = aiConversationStore.createConversation('t').lastInsertRowid
  const detail = JSON.stringify({ rows: [{ 姓名: NAME, 家长联系电话: PHONE }] })
  const processJson = JSON.stringify({
    steps: [{ id: 's1', kind: 'tool', title: '查询数据', tool: 'query', status: 'done', detail }],
  })
  aiConversationStore.insertMessage(cid, 'user', '查一下学生', '', '')
  aiConversationStore.insertMessage(cid, 'assistant', '查到 1 人', processJson, '')
  return cid
}

test('§3.2 / 3.2c / 3.2b：system 里记忆、技能、工具轨迹都无真值', async () => {
  const cid = seedToolTrace()
  const final = sse([delta('已处理')])
  const mock = mockModel([final])
  let res
  try {
    res = await fx.call('POST', '/api/ai/chat/stream', {
      conversationId: cid, webSearch: false, skills: ['找人'], messages: [],
    })
  } finally {
    mock.restore()
  }
  assert.equal(res.status, 200, res.text.slice(0, 200))
  assert.ok(mock.requests.length >= 1)
  const system = mock.requests[0].messages.find((m) => m.role === 'system').content
  assert.ok(!system.includes(NAME), '记忆/技能/轨迹里不能有真名')
  assert.ok(!system.includes(PHONE), '记忆/技能/轨迹里不能有真号')
  assert.ok(system.includes('数据保护模式已开启'), '坑5：隐私措辞必须在')
  assert.match(system, /此前轮次的实际工具调用记录/, '轨迹段落必须在（证明确实覆盖了它）')
  assert.match(system, /<skill name="找人">/, '技能正文确实被注入了（否则上面的"无真值"是假绿）')
})

test('§3.2b 过程块 detail 仍是真值：toolDetailText 源头没被改', async () => {
  const frames = sse([
    toolCall('c1', 'query', { table: 'students' }),
    delta('查到 1 人'),
  ])
  const mock = mockModel([frames])
  let res
  try {
    res = await fx.call('POST', '/api/ai/chat/stream', {
      conversationId: 0, webSearch: false, messages: [{ role: 'user', content: '查学生' }],
    })
  } finally {
    mock.restore()
  }
  assert.equal(res.status, 200, res.text.slice(0, 200))
  const evts = res.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((o) => o && o.type)
  const toolStep = evts.filter((e) => e.type === 'step').map((e) => e.step).find((s) => s && s.kind === 'tool' && s.status === 'done')
  assert.ok(toolStep, '前置：本轮应有工具过程块')
  assert.ok(toolStep.detail.includes(NAME), '过程块 detail 必须是真名（用户看真值）')
  assert.ok(toolStep.detail.includes(PHONE), '过程块 detail 必须是真号')
  // 同一轮发给模型的 tool 结果却是代号（主闸门），两者并存才是对的
  const toolMsg = mock.requests[1] && mock.requests[1].messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg && !toolMsg.content.includes(NAME), '发给模型的工具结果应是代号')
})

test('§3.3 用户消息：老师亲口打的姓名/电话出站替换', async () => {
  const final = sse([delta('收到')])
  const mock = mockModel([final])
  try {
    await fx.call('POST', '/api/ai/chat/stream', {
      conversationId: 0, webSearch: false,
      messages: [{ role: 'user', content: `请给 ${NAME} 打电话 ${PHONE}` }],
    })
  } finally {
    mock.restore()
  }
  assert.ok(mock.requests.length >= 1)
  const userMsg = mock.requests[0].messages.find((m) => m.role === 'user')
  assert.ok(!userMsg.content.includes(NAME), '发给模型的用户消息不能有真名')
  assert.ok(!userMsg.content.includes(PHONE), '发给模型的用户消息不能有真号')
  assert.match(userMsg.content, TOKEN_RE, '应替换为代号')
})

test('§3.5 正文 + 思维链流式反查：SSE 两类事件无代号，最终正文含真名，落库 reasoning 原样', async () => {
  const maps = aiPrivacy.privacy.buildMap(SLUG)
  const alias = maps.nameToAlias.get(NAME)
  // 模型在思维链和正文里都复述代号（且被切成多片，验证 hold-back）
  const frames = sse([
    reason('先查 ' + alias.slice(0, 4)),
    reason(alias.slice(4) + ' 的记录'),
    delta('结论：' + alias.slice(0, 3)),
    delta(alias.slice(3) + ' 请假 2 次'),
  ])
  const mock = mockModel([frames])
  let res
  try {
    res = await fx.call('POST', '/api/ai/chat/stream', {
      conversationId: 0, webSearch: false, messages: [{ role: 'user', content: '查请假' }],
    })
  } finally {
    mock.restore()
  }
  assert.equal(res.status, 200, res.text.slice(0, 200))
  const evts = res.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((o) => o && o.type)
  const reasonJoined = evts.filter((e) => e.type === 'reasoning').map((e) => e.text).join('')
  const deltaJoined = evts.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  const done = evts.find((e) => e.type === 'done')
  assert.ok(reasonJoined.length > 0 && deltaJoined.length > 0, '前置：两类事件都要有内容')
  assert.ok(!TOKEN_RE.test(reasonJoined), '思维链 SSE 拼接后不能有代号')
  assert.ok(!TOKEN_RE.test(deltaJoined), '正文 SSE 拼接后不能有代号')
  assert.ok(deltaJoined.includes(NAME), '正文 SSE 应显示真名')
  assert.ok(done && done.reply.includes(NAME), 'done 的最终正文（前端落库那份）必须是真名')
  // 落库到过程的思维链步骤也应是真值
  const reasonStep = done.steps.find((s) => s.kind === 'reason')
  assert.ok(reasonStep && reasonStep.text.includes(NAME), '过程块思维链应显示真名')
})

test('坑6 摘要 transcript：压缩请求的 fetch 不含真名真号', async () => {
  const cid = aiConversationStore.createConversation('compress').lastInsertRowid
  // 造超过 CONTEXT_KEEP_RECENT(6) 条消息，触发压缩
  for (let i = 0; i < 9; i++) {
    aiConversationStore.insertMessage(cid, 'user', `第${i}条 ${NAME} ${PHONE}`, '', '')
    aiConversationStore.insertMessage(cid, 'assistant', `答复${i} ${NAME}`, '', '')
  }
  const rows = aiConversationStore.listMessages(cid).filter((r) => r.role === 'user' || r.role === 'assistant')
  const { compressConversation, CONTEXT_KEEP_RECENT } = require(path.join(ROOT, 'student-backend/routes/ai/ai.memory.js'))
  const cfg = { url: 'http://mock.local/v1/chat/completions', api_key: 'k', provider: 'deepseek' }
  const requests = []
  const realFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      requests.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ choices: [{ message: { content: '摘要' } }] }) }
    }
    return realFetch(url, opts)
  }
  try {
    await compressConversation(cfg, cid, rows, 0, SLUG)
  } finally {
    global.fetch = realFetch
  }
  assert.ok(CONTEXT_KEEP_RECENT === 6)
  assert.ok(requests.length >= 1, '压缩应发起一次独立 fetch')
  const body = JSON.stringify(requests[0].messages)
  assert.ok(!body.includes(NAME), '摘要 transcript 不能有真名')
  assert.ok(!body.includes(PHONE), '摘要 transcript 不能有真号')
})

test('关闭开关后：system 与消息都保留真值（零拷贝），确认没有过度加工', async () => {
  const prev = aiConfigStore.readPrivacy()
  aiConfigStore.setPrivacy({ enabled: false })
  aiPrivacy.privacy.invalidate(SLUG)
  try {
    const final = sse([delta('ok')])
    const mock = mockModel([final])
    try {
      await fx.call('POST', '/api/ai/chat/stream', {
        conversationId: 0, webSearch: false, messages: [{ role: 'user', content: NAME + PHONE }],
      })
    } finally {
      mock.restore()
    }
    const sys = mock.requests[0].messages.find((m) => m.role === 'system').content
    const usr = mock.requests[0].messages.find((m) => m.role === 'user').content
    assert.ok(sys.includes(NAME), '关闭时记忆不替换')
    assert.ok(usr.includes(NAME) && usr.includes(PHONE), '关闭时消息不替换')
    assert.ok(!sys.includes('数据保护模式已开启'), '关闭时不能出现隐私措辞')
  } finally {
    aiConfigStore.setPrivacy({ enabled: true })
    aiPrivacy.privacy.invalidate(SLUG)
  }
})
