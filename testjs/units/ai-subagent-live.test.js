// =========================================================================
// ai-subagent-live.test.js —— 子助手轨迹实时下发 + 缩进 + 聊天气泡复制豁免
//
// 背景：子助手的思维链原先在 consumeStream 里逐片产生、却只把整段结果攒到
// run_subagent 结束才下发，界面上「做完才冒出来」。现在改成一份轨迹源同时供
// 实时增量事件和最终全量步骤使用，done 事件整体覆盖实时结构，不重复、不跳变。
//
// 分工：行为判据一律 require 真实源码（含真跑 runOneSubagent），
// 源码判据守住跨端接线，避免「纯函数全绿、但没人调用」的假绿。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..', '..')
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'ai-subagent-live-unit-' + process.pid)

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const SUB = 'student-backend/routes/ai/ai.tools/tools.subagent.js'
const CONV = 'student-backend/routes/ai/ai.conversations.js'
const CHAT = 'student-frontend/src/composables/ai/aiChat.js'
const VIEW = 'student-frontend/src/components/ai/AiChatMessages.vue'
const INDEX = 'student-frontend/src/styles/index.css'

const { makeTraceSink, runOneSubagent } = require(path.join(ROOT, SUB))

// ---------------------------------------------------------------------------
// 行为判据：轨迹源
// ---------------------------------------------------------------------------

test('轨迹源：思维链分片按轮合并、工具步骤按序插入，增量事件带齐定位字段', () => {
  const events = []
  const sink = makeTraceSink(2, (p) => events.push(p))
  sink.reason(0, '先看')
  sink.reason(0, '数据')
  sink.tool(0, '查询数据')
  sink.reason(1, '再核对')
  sink.tool(1, '校验')
  assert.deepStrictEqual(sink.steps, [
    { kind: 'reason', text: '先看数据' },
    { kind: 'tool', title: '查询数据' },
    { kind: 'reason', text: '再核对' },
    { kind: 'tool', title: '校验' },
  ])
  assert.strictEqual(events.length, 5, '每个分片/工具步骤都要下发一次')
  assert.deepStrictEqual(events[0], { index: 2, round: 0, kind: 'reason', text: '先看' })
  assert.deepStrictEqual(events[2], { index: 2, round: 0, kind: 'tool', title: '查询数据' })
  assert.ok(events.every((e) => e.index === 2), '并行子助手靠 index 区分，不能丢')
  assert.ok(events.every((e) => typeof e.round === 'number'), '前端按 round 合并分片')
})

test('轨迹源：单轮思考最多 600 字，与最终落库的截断口径一致；空片段不产生空步骤', () => {
  const long = '想'.repeat(1000)
  const sink = makeTraceSink(0, null)
  sink.reason(0, '')
  assert.strictEqual(sink.steps.length, 0, '空片段不能造出一条空的思考步骤')
  sink.reason(0, long)
  sink.reason(0, '补充')
  assert.strictEqual(sink.steps.length, 1)
  assert.strictEqual(sink.steps[0].text, long.slice(0, 600), '实时增量与全量 trace 必须同样截到 600 字')
  sink.reason(1, '第二轮')
  assert.strictEqual(sink.steps.length, 2, '新一轮是另一条思考，不与上一轮合并')
})

test('子助手真跑：思维链增量回调被接上，落库步骤与轨迹源是同一份', async () => {
  const llm = require(path.join(ROOT, 'student-backend/routes/ai/ai.llm.js'))
  const orig = llm.consumeStream
  let sawCallback = false
  llm.consumeStream = async (cfg, history, onDelta, onReasoning) => {
    sawCallback = typeof onReasoning === 'function'
    if (onReasoning) { onReasoning('先查'); onReasoning('再核对') }
    return {
      text: JSON.stringify({ task: 't', result: 1, basis: 'b', count: 1, samples: [], error: '', needs_user_decision: [] }),
      toolCalls: [], reasoning: '先查再核对', usage: null,
    }
  }
  try {
    const sink = makeTraceSink(0, null)
    const out = await runOneSubagent(
      { provider: 'deepseek', api_key: 'k', base_url: 'http://x', model: 'm' },
      { name: '核查员', task: '查一下' },
      { blocks: [] },
      sink
    )
    assert.strictEqual(sawCallback, true, 'consumeStream 的思维链增量回调不能还是 null')
    assert.deepStrictEqual(sink.steps, [{ kind: 'reason', text: '先查再核对' }])
    assert.strictEqual(out.__steps, sink.steps, 'done 下发的全量必须与实时增量同源')
  } finally {
    llm.consumeStream = orig
  }
})

// ---------------------------------------------------------------------------
// 源码判据：跨端接线
// ---------------------------------------------------------------------------

test('接线：主循环把子助手增量挂到当前工具步骤，并以独立事件类型下发', () => {
  const src = read(CONV)
  assert.match(src, /ctx\.emitSub\s*=\s*\(p\)\s*=>/, 'ctx 上要有下发函数')
  assert.match(src, /send\(\{\s*type:\s*'sub_step'/, '必须发 sub_step 事件，不能复用主对话的 reasoning')
  assert.match(src, /ctx\.stepId\s*=\s*sid/, '事件要挂在真实的工具步骤 id 上')
  assert.match(src, /stepId:\s*ctx\.stepId/, '事件体里要带 stepId')
  assert.match(src, /subSteps:\s*out\.trace/, 'done 全量轨迹仍要挂在主步骤上')
})

test('接线：每个子任务一个轨迹源，事件带子任务名，失败分支用同源步骤兜底', () => {
  const src = read(SUB)
  assert.match(src, /makeTraceSink\(i,\s*emitSub/, '并行子任务要各自一个轨迹源')
  assert.match(src, /emitSub\(\{ \.\.\.p, name:/, '增量事件要带子任务名，防四个子助手串组')
  assert.match(src, /runOneSubagent\(cfg, t, ctx, sinks\[i\]\)/, '轨迹源要真的传给子助手')
  assert.match(src, /:\s*sinks\[i\]\.steps/, '被 catch 接住的子任务要用同源步骤兜底')
  assert.match(src, /\(d\) => sink\.reason\(i, d\)/, '增量回调要接上轨迹源')
  assert.match(src, /reasoning_content: reasoning/, '展示截断不能破坏上游思考模式的完整回传')
})

test('接线：前端按步骤 id + 子任务索引追加，done 用全量覆盖去重', () => {
  const src = read(CHAT)
  assert.match(src, /evt\.type === 'sub_step'/, '要有独立事件分支')
  assert.match(src, /s\.id === evt\.stepId/, '按主步骤 id 找宿主')
  assert.match(src, /host\.subSteps\[idx\]/, '按子任务 index 分组')
  assert.match(src, /x\._round === evt\.round/, '同轮思维链分片合并成一条')
  assert.match(src, /last\.steps = \(last\.steps \|\| \[\]\)\.slice\(0, base\)\.concat\(evt\.steps\)/, 'done 全量覆盖仍在，实时结构不会残留重复')
})

// ---------------------------------------------------------------------------
// 源码判据：展示与复制豁免
// ---------------------------------------------------------------------------

test('展示：子助手轨迹整体再缩进一点，步骤行相对分组标题再缩进，流式思考有高度上限', () => {
  const src = read(VIEW)
  assert.ok(src.includes('class="mt-1 ml-6 space-y-1"'), '轨迹整体从 ml-5 往右挪一点')
  assert.ok(src.includes('gap-1.5 pl-2 text-[12px] leading-5'), '步骤行相对「子助手 · 名字」再缩进')
  assert.match(src, /s\.kind === 'reason' \? 'max-h-40 overflow-auto'/, '实时增长的思考文本不能把过程块撑爆')
  assert.match(src, /stepLabel\(s\)/, '子步骤仍复用主过程的分类标签')
})

test('复制：只豁免 AI 回复与用户提问两种气泡，全局禁止选择保持不变', () => {
  const view = read(VIEW)
  const index = read(INDEX)
  assert.match(index, /html, body\s*\{[^}]*user-select:\s*none/s, '全局仍禁止选中，不能整页放开')
  const block = view.match(/\.user-bubble,\s*\.assistant-bubble\s*\{[^}]*\}/)
  assert.ok(block, '要有只针对两种聊天气泡的豁免规则')
  // 必须行首锚定：只写 /user-select:\s*text/ 会被下一行 -webkit-user-select 的子串冒充，
  // 把「标准声明被删掉」漏成全绿（变异反证 D 抓到过这个假阴性）。
  assert.match(block[0], /^\s*user-select:\s*text/m, '气泡内允许选中')
  assert.match(block[0], /^\s*-webkit-user-select:\s*text/m, 'Chromium 前缀也要一起放开')
  assert.ok(!/\*\s*\{[^}]*user-select:\s*text/s.test(view), '不能写成整页放开')
})

test('复制：选中文本后原生右键菜单确实提供复制项', () => {
  const front = read('student-frontend/src/main.js')
  const main = read('electron/main/main.js')
  assert.match(front, /hasSelection/, '前端要按选中态触发原生菜单')
  assert.match(main, /opts\.hasSelection\)[\s\S]{0,200}role: 'copy'/, '主进程要给出复制项')
})
