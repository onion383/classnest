// =========================================================================
// ai-tool-evidence.test.js —— AI 工具调用证据：跨轮可见 + 收尾对账
//
// 根因：一次请求里的 assistant.tool_calls / role:'tool' 结果只活在该请求的
// history 数组里；ai_messages 只存 content + process_json（界面过程块摘要），
// 且 loadConversationContext 原先连 process_json 都没 SELECT。于是下一轮模型
// 只看得到「用户说了什么 + 自己答了什么」，无从判断自己调过哪些工具，
// 只能照着提示词话术补写叙事（「我已调用图表工具」）。
//
// 分工：本单测一律 require **真实源码**（不复现逻辑），再加源码判据守住接线，
// 避免「纯函数全绿、但没人调用」的假绿。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const TMP = path.join(os.tmpdir(), 'ai-tool-evidence-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || TMP

const memory = require(path.join(ROOT, 'student-backend/routes/ai/ai.memory.js'))
const helpers = require(path.join(ROOT, 'student-backend/routes/ai/ai.helpers.js'))
const { buildToolTrace } = memory
const { hasUnbackedToolClaim } = helpers

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const toolStep = (title, status = 'done', summary = '') => ({
  id: 's1', kind: 'tool', title, status, summary,
})

// ---------------------------------------------------------------------------
// 行为判据：跨轮工具记录
// ---------------------------------------------------------------------------

test('没有历史工具步骤时 toolTrace 为空串，不往系统提示里塞无意义段落', () => {
  assert.strictEqual(buildToolTrace([]), '')
  assert.strictEqual(buildToolTrace([{ role: 'user', content: '帮我画个图' }]), '')
  assert.strictEqual(buildToolTrace([
    { id: 1, role: 'assistant', process_json: JSON.stringify({ steps: [{ kind: 'reason', text: '想一想' }] }) },
  ]), '')
})

test('历史工具步骤被还原成事实清单，并明确标注「不代表本轮已调用」', () => {
  const rows = [{
    id: 7, role: 'assistant',
    process_json: JSON.stringify({ steps: [toolStep('绘制图表', 'done', '5 项数据'), toolStep('查询数据', 'done', '共 5 条记录')] }),
  }]
  const out = buildToolTrace(rows)
  assert.ok(out.includes('此前轮次的实际工具调用记录'))
  assert.ok(out.includes('绘制图表'), '要能看到真实执行过的工具名')
  assert.ok(out.includes('5 项数据'), '要带上过程摘要')
  assert.ok(out.includes('消息 #7'), '要带上时序定位')
  assert.ok(out.includes('不代表本轮已调用任何工具'), '必须切断「历史调用 = 本轮调用」的误推')
})

test('失败的工具步骤标为失败；损坏的 process_json 不抛异常', () => {
  const rows = [
    { id: 1, role: 'assistant', process_json: '{ 坏掉的 JSON' },
    { id: 2, role: 'assistant', process_json: JSON.stringify({ steps: [toolStep('绘制图表', 'error', '缺少图表数据')] }) },
    { id: 3, role: 'assistant', process_json: JSON.stringify({ steps: [toolStep('查询数据', 'running')] }) },
  ]
  const out = buildToolTrace(rows)
  assert.ok(out.includes('失败'))
  assert.ok(out.includes('缺少图表数据'))
  assert.ok(!out.includes('· 消息 #3'), 'running 的步骤不算已执行')
  assert.ok(!out.includes('· 消息 #1'), '损坏的记录要整条跳过')
})

test('工具记录最多保留最近 20 条，长会话不会把系统提示撑爆', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1, role: 'assistant',
    process_json: JSON.stringify({ steps: [toolStep('查询数据', 'done', `第 ${i + 1} 次`)] }),
  }))
  const out = buildToolTrace(rows)
  assert.ok(!out.includes('· 消息 #1：'), '最早的记录应被裁掉')
  assert.ok(out.includes('· 消息 #25：'), '最新的记录必须保留')
  assert.strictEqual((out.match(/· 消息 #/g) || []).length, 20)
})

// ---------------------------------------------------------------------------
// 行为判据：收尾对账（本轮没调用却说调用了）
// ---------------------------------------------------------------------------

test('无工具步骤 + 完成态调用声明 → 判定为无证据声明', () => {
  assert.strictEqual(hasUnbackedToolClaim('我已调用图表工具，下面是结论。', []), true)
  assert.strictEqual(hasUnbackedToolClaim('调用了 query 工具后统计如下。', []), true)
  assert.strictEqual(hasUnbackedToolClaim('已为你生成图表，请看。', []), true)
  assert.strictEqual(hasUnbackedToolClaim('已经导出文件到桌面。', []), true)
})

test('能力描述 / 纯结论 / 提问不算声明，不能误伤正常回复', () => {
  assert.strictEqual(hasUnbackedToolClaim('我可以调用 query 工具来查数据。', []), false)
  assert.strictEqual(hasUnbackedToolClaim('病假最多，共 3 人；事假 1 人。', []), false)
  assert.strictEqual(hasUnbackedToolClaim('你想让我调用哪个工具？', []), false)
  assert.strictEqual(hasUnbackedToolClaim('', []), false)
  assert.strictEqual(hasUnbackedToolClaim(null, []), false)
})

test('本轮只要有过工具步骤（含失败），「调用过工具」就有据可依', () => {
  assert.strictEqual(hasUnbackedToolClaim('我已调用图表工具。', [toolStep('绘制图表')]), false)
  assert.strictEqual(hasUnbackedToolClaim('我已调用图表工具。', [toolStep('绘制图表', 'error')]), false)
  // 只有过程文本 / 思考步骤，不算工具调用
  assert.strictEqual(hasUnbackedToolClaim('我已调用图表工具。', [{ kind: 'text', text: '我先查一下' }]), true)
  assert.strictEqual(hasUnbackedToolClaim('我已调用图表工具。', [toolStep('绘制图表', 'running')]), true)
})

// ---------------------------------------------------------------------------
// 源码判据：确认三处接线真的落地（纯函数全绿但没人用 = 假绿）
// ---------------------------------------------------------------------------

test('上下文重建确实读 process_json，且 toolTrace 被拼进系统提示', () => {
  const mem = read('student-backend/routes/ai/ai.memory.js')
  const conv = read('student-backend/routes/ai/ai.conversations.js')
  assert.ok(/SELECT id, role, content, process_json, attachments_json FROM ai_messages/.test(mem),
    'loadConversationContext 必须 SELECT process_json')
  assert.ok(/toolTrace: buildToolTrace\(effectiveRows\)/.test(mem), '返回体必须带 toolTrace')
  assert.ok(/\+ \(convCtx \? convCtx\.toolTrace : ''\)/.test(conv), '系统提示必须拼接 toolTrace')
  assert.ok(/module\.exports\.buildToolTrace/.test(mem), 'buildToolTrace 必须导出')
})

test('donePayload 真的调用了对账函数，且 require 已接上', () => {
  const conv = read('student-backend/routes/ai/ai.conversations.js')
  const hlp = read('student-backend/routes/ai/ai.helpers.js')
  assert.ok(/const \{[^}]*hasUnbackedToolClaim[^}]*\} = require\('\.\/ai\.helpers'\)/.test(conv),
    'ai.conversations.js 必须从 ai.helpers 解构出 hasUnbackedToolClaim')
  assert.ok(/hasUnbackedToolClaim\(answerText, steps\)/.test(conv), 'donePayload 必须做收尾对账')
  assert.ok(/module\.exports\s*=\s*\{[^}]*hasUnbackedToolClaim/.test(hlp), '纯函数必须导出')
})

test('收尾不再无条件宣称「前端已渲染」，且系统提示新增禁止声明规则', () => {
  const tools = read('student-backend/routes/ai/ai.tools/tools.js')
  const llm = read('student-backend/routes/ai/ai.llm.js')
  assert.ok(!/前端已把图表渲染出来|前端已把完整数据渲染为表格/.test(tools),
    '工具结果不得再替模型断言「已渲染」')
  assert.ok(/不要在正文里声称自己调用过工具/.test(llm), '系统提示必须明确禁止凭空声明工具调用')
})

test('前端 _blocks 按内容重算，不再因缓存早退吞掉图表块', () => {
  const conv = read('student-frontend/src/composables/ai/aiConversations.js')
  assert.ok(!/msg\.content \|\| msg\._blocks\)/.test(conv), '不能再用「_blocks 存在就 return」')
  const hits = conv.match(/msg\._blocksSrc === msg\.content|m\._blocksSrc === m\.content/g) || []
  assert.strictEqual(hits.length, 2, '_computeHtml 与 _computeAllHtml 都要按内容比对')
  assert.ok(/msg\._blocksSrc = msg\.content/.test(conv) && /m\._blocksSrc = m\.content/.test(conv),
    '重算后必须记下渲染时的正文')
})

// ---------------------------------------------------------------------------
// 结构化工具轨迹：真实工具名 + 结果明细，以及「持久化 → 发给 AI」全链路
// ---------------------------------------------------------------------------

test('持久化的是真实工具调用记录：工具名、状态、摘要、结果明细都在', () => {
  const rows = [{
    id: 10, role: 'assistant',
    process_json: JSON.stringify({
      steps: [{
        id: 's1', kind: 'tool', tool: 'show_chart', title: '绘制图表',
        status: 'done', summary: '5 项数据', detail: '{"ok":true,"displayed":true}',
      }],
    }),
  }, {
    id: 11, role: 'assistant',
    // 旧记录没有 tool 字段，必须仍能还原，不能被丢掉
    process_json: JSON.stringify({
      steps: [{ id: 's2', kind: 'tool', title: '绘制图表', status: 'done', summary: '3 项数据' }],
    }),
  }]
  const out = buildToolTrace(rows)
  assert.ok(out.includes('绘制图表[show_chart]'), '必须给出真实工具名，而不是只有中文标题')
  assert.ok(out.includes('displayed'), '必须带上工具返回结果明细')
  assert.ok(out.includes('5 项数据'), '必须带上过程摘要')
  assert.ok(out.includes('· 消息 #11：绘制图表（'), '旧格式退回界面标题，历史会话照样可读')
})

test('全链路判据：产生 → 下发 → 落库 → 重建上下文 → 发给模型', () => {
  const conv = read('student-backend/routes/ai/ai.conversations.js')
  const chat = read('student-frontend/src/composables/ai/aiChat.js')
  const msgs = read('student-frontend/src/composables/ai/aiMessages.js')
  const mem = read('student-backend/routes/ai/ai.memory.js')
  assert.ok(/tool: tc\.name/.test(conv), '① 工具步骤必须带真实工具名')
  assert.ok(/type: 'done', \.\.\.donePayload\(\)/.test(conv), '② done 事件必须携带 steps')
  assert.ok(/last\.steps = /.test(chat), '③ 前端必须接收 done 里的 steps')
  assert.ok(/steps: m\.steps \|\| \[\]/.test(msgs), '④ buildProc 必须把 steps 原样写进过程块')
  assert.ok(/persistMessage\('assistant', last\.content/.test(chat), '⑤ 助手消息必须落库')
  assert.ok(/SELECT id, role, content, process_json, attachments_json FROM ai_messages/.test(mem),
    '⑥ 重建上下文必须把 process_json 读回来')
  assert.ok(/toolTrace: buildToolTrace\(effectiveRows\)/.test(mem)
    && /convCtx\.toolTrace/.test(conv), '⑦ 还原成记录并拼进系统提示发给模型')
})
