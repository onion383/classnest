// =========================================================================
// ai-limits.test.js —— AI 链路边界校验 / 预算闸门 行为测试
//
// 覆盖审查 v4 的 B03-06 / B03-07 / B03-08 / B03-10 / B03-11
//
// 与 testjs/probe/ai-limits-probe.cjs 的分工：
//   探针 = 静态判据（源码结构）；本单测 = **行为判据**（真跑代码）。
//   本单测一律 require **真实源码**，不复现逻辑（复现逻辑的单测改坏源码不变 → 必假绿）。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const TMP = path.join(os.tmpdir(), 'ai-limits-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || TMP

const { normalizeToolCalls } = require(path.join(ROOT, 'student-backend/routes/ai/ai.llm.js'))
const snap = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.snapshot.js'))
const { createBudget, BUDGET_LIMITS } = require(path.join(ROOT, 'student-backend/routes/ai/ai.budget.js'))

// ---------------------------------------------------------------------------
// B03-06：tool_call 边界收口
// ---------------------------------------------------------------------------

test('B03-06 空 id 的 tool_call 被补上合成 id，不再是空串', () => {
  const out = normalizeToolCalls([{ id: '', name: 'query', args: '{}' }])
  assert.strictEqual(out.length, 1)
  assert.ok(out[0].id, 'id 不能为空串（空串 tool_call_id 会让上游 400）')
  assert.strictEqual(out[0].name, 'query')
  assert.strictEqual(out[0].arguments, '{}')
})

test('B03-06 空 name 的 tool_call 被丢弃（无法执行，留着只会让上游收到非法 tool_calls）', () => {
  const out = normalizeToolCalls([
    { id: 'a', name: '', args: '{}' },
    { id: 'b', name: '   ', args: '{}' },
    { id: 'c', name: 'query', args: '{}' },
  ])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].name, 'query')
})

test('B03-06 重复 id 被去重（上游按 id 配对 tool 结果，重复会错乱）', () => {
  const out = normalizeToolCalls([
    { id: 'dup', name: 'query', args: '{}' },
    { id: 'dup', name: 'aggregate', args: '{}' },
  ])
  assert.strictEqual(out.length, 2)
  assert.notStrictEqual(out[0].id, out[1].id)
})

test('B03-06 正常 tool_call 原样透传（不改变已有行为）', () => {
  const out = normalizeToolCalls([{ id: 'call_abc', name: 'propose_write', args: '{"table":"x"}' }])
  assert.deepStrictEqual(out, [{ id: 'call_abc', name: 'propose_write', arguments: '{"table":"x"}' }])
})

test('B03-06 空数组与脏输入不炸', () => {
  assert.deepStrictEqual(normalizeToolCalls([]), [])
  assert.deepStrictEqual(normalizeToolCalls(null), [])
  assert.deepStrictEqual(normalizeToolCalls([null, undefined]), [])
})

test('B03-06 累积阶段的 tool 名取「首个非空」而非累加（分片下发不能拼成 queryquery）', async () => {
  // 走真实 consumeStream：喂一段把同一 function 名分两片下发的 SSE，
  // 断言最终 tool 名是完整的 'query' 而不是 'queryquery'。
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"que","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ry","arguments":"{\\"a\\":1}"}}]}}]}',
    'data: [DONE]',
    '',
  ];
  const out = await consumeStreamWith(chunks);
  assert.strictEqual(out.toolCalls.length, 1);
  assert.strictEqual(out.toolCalls[0].name, 'query', '分片下发的工具名必须是完整名');
  assert.strictEqual(out.toolCalls[0].id, 'c1');
})

test('B03-06 整名重复下发时不累加（否则拼成 queryquery，模型不认这个工具）', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"query","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"query","arguments":"{\\"a\\":1}"}}]}}]}',
    'data: [DONE]',
    '',
  ];
  const out = await consumeStreamWith(chunks);
  assert.strictEqual(out.toolCalls.length, 1);
  assert.strictEqual(out.toolCalls[0].name, 'query', '重复下发的整名不能被累加');
})

// 用桩掉的 fetch 跑真实 consumeStream，返回它解析出的结果
async function consumeStreamWith(chunks) {
  const body = chunks.join('\n');
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        const bytes = Buffer.from(body, 'utf8');
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  });
  try {
    const { consumeStream } = require(path.join(ROOT, 'student-backend/routes/ai/ai.llm.js'));
    return await consumeStream(
      { provider: 'deepseek', api_key: 'k', base_url: 'http://x', model: 'm' },
      [{ role: 'user', content: 'hi' }],
      null, null, null, []
    );
  } finally {
    global.fetch = origFetch;
  }
}

// ---------------------------------------------------------------------------
// B03-07：快照标识唯一性
// ---------------------------------------------------------------------------

test('B03-07 同一时间戳重复创建时得到不同标识（不会互相覆盖）', () => {
  const stamp = '20261104-120000.123'
  const first = snap.nextSnapshotName([], stamp)
  const second = snap.nextSnapshotName([first], stamp)
  const third = snap.nextSnapshotName([first, second], stamp)
  assert.strictEqual(first, stamp)
  assert.notStrictEqual(second, first)
  assert.notStrictEqual(third, second)
  assert.ok(snap.SNAPSHOT_NAME_RE.test(second), '后缀形式也必须匹配校验用的正则')
  assert.ok(snap.SNAPSHOT_NAME_RE.test(third))
})

test('B03-07 快照标识正则同时接受旧格式与新格式（还原提案入参校验共用它）', () => {
  assert.ok(snap.SNAPSHOT_NAME_RE.test('20261104-120000'), '旧格式（秒级）必须仍被接受')
  assert.ok(snap.SNAPSHOT_NAME_RE.test('20261104-120000.123'), '毫秒格式')
  assert.ok(snap.SNAPSHOT_NAME_RE.test('20261104-120000-2'), '序号后缀格式')
  assert.ok(!snap.SNAPSHOT_NAME_RE.test('not-a-snapshot'))
  assert.ok(!snap.SNAPSHOT_NAME_RE.test('20261104-120000.12'), '毫秒必须三位')
})

test('B03-07 排序键按真实时间而非字符串（否则 -2 会排到下一秒之前，清理时删错文件）', () => {
  const a = snap.snapshotSortKey('20261104-120000.123')
  const b = snap.snapshotSortKey('20261104-120000-2')
  const c = snap.snapshotSortKey('20261104-120001.000')
  assert.ok(a < c, '同一秒内的快照应早于下一秒')
  assert.ok(b < c, '带序号后缀的同一秒快照也必须早于下一秒')
})

test('B03-07 列表排序真的走排序键（纯字符串排序会把同秒的第 2 份排到第 1 份前面）', () => {
  // 行为判据：把 snapshotFiles 的排序结果与「按排序键排」的期望逐项比对。
  // 用桩替换 fs.readdirSync 与 dbManager.snapshotsDir，避免依赖真实磁盘与数据库。
  //
  // 关键：这组数据必须让「纯字符串排序」与「按时间排序」**产生分歧** ——
  // '120000' 与 '120000-2' 都是 120000 秒内的两份（后者是第 2 份、更新），
  // 但纯字符串比较里 '-' 大于结束符 → '120000-2' 反而更大 → 倒序后被排到前面（错）。
  const fsMod = require('fs');
  const dbMod = require(path.join(ROOT, 'student-backend/dbManager/dbManager.js'));
  const origReaddir = fsMod.readdirSync;
  const origDir = dbMod.snapshotsDir;
  const names = [
    '20261104-120000.db',
    '20261104-120000-2.db',
    '20261104-115959.000.db',
  ];
  fsMod.readdirSync = () => names.slice();
  dbMod.snapshotsDir = () => 'X';
  try {
    const got = snap.snapshotFiles('slug').map((n) => n.replace(/\.db$/, ''));
    assert.deepStrictEqual(got, [
      '20261104-120000-2',
      '20261104-120000',
      '20261104-115959.000',
    ], '同一秒内的第 2 份必须排在第 1 份之前（更新在前）');
    // 反证：纯字符串排序会给出不同结果 —— 确认这条判据真的有效
    const pure = names.slice().sort().reverse();
    assert.notDeepStrictEqual(pure, got.map((n) => n + '.db'),
      '本组数据必须能区分两种排序，否则判据太松（假绿）');
  } finally {
    fsMod.readdirSync = origReaddir;
    dbMod.snapshotsDir = origDir;
  }
})

// ---------------------------------------------------------------------------
// B03-11：客户端取消信号贯穿到工具执行层
// ---------------------------------------------------------------------------

test('B03-11 web_search 的请求信号同时含超时与客户端断开（用户中断后不必等满 30s）', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.js'), 'utf8')
  const body = src.slice(src.indexOf('async function runWebSearch'))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  assert.ok(/AbortSignal\.any\(\s*\[\s*timeout\s*,\s*clientSignal\s*\]\s*\)/.test(fn),
    'web_search 必须把客户端信号与超时组合起来')
  assert.ok(/ctx\s*&&\s*ctx\.signal/.test(fn), '必须从 ctx 取客户端信号')
  assert.ok(!/AbortSignal\.timeout\(30000\)\s*,\s*\n?\s*\}\s*,\s*\n\s*\}\)/.test(fn), '不得再单独用固定超时')
})

test('B03-11 客户端信号已 abort 时，web_search 立即失败而不是等满超时', async () => {
  const exec = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.js'))
  const ac = new AbortController()
  ac.abort()
  const t0 = Date.now()
  const out = await exec.runWebSearch({ query: '测试' }, { cfg: { provider: 'deepseek', api_key: 'k' }, signal: ac.signal })
  const dt = Date.now() - t0
  assert.ok(out && out.error, '应返回错误而不是正常结果')
  assert.ok(dt < 2000, `应立即返回，实际耗时 ${dt}ms`)
})

// ---------------------------------------------------------------------------
// B03-08：会话不存在与「没有会话」两种语义必须区分
// ---------------------------------------------------------------------------

test('B03-08 /chat/stream 对不存在的会话明确报错，而不是静默回退', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.conversations.js'), 'utf8')
  assert.ok(/conversationId\s*&&\s*!convCtx/.test(src), '必须显式判别「传了 id 但查不到」')
  assert.ok(/code:\s*'conversation_missing'/.test(src), '错误必须带可识别的 code，供前端自愈')
  // 原有 conversationExists 辅助函数不能被删（其它 5 处路由在用）
  assert.ok(/function conversationExists\(id\)/.test(src))
  const uses = (src.match(/conversationExists\(/g) || []).length
  assert.ok(uses >= 5, `conversationExists 的调用点不应减少，当前 ${uses}`)
})

test('B03-08 前端收到 conversation_missing 会清掉失效的会话 id（否则每次发送都失败）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/ai/aiChat.js'), 'utf8')
  assert.ok(/evt\.code\s*===\s*'conversation_missing'/.test(src), '必须识别该 code')
  assert.ok(/ctx\.conversationId\.value\s*=\s*null/.test(src), '必须清掉失效的 conversationId')
})

// ---------------------------------------------------------------------------
// B03-10：统一预算闸门（主对话与子助手共用）
// ---------------------------------------------------------------------------

test('B03-10 预算闸门：累计 token 超限后报告超限', () => {
  const b = createBudget({ maxTotalTokens: 100 })
  assert.strictEqual(b.exceeded(), false)
  b.add({ total_tokens: 60 })
  assert.strictEqual(b.exceeded(), false)
  b.add({ total_tokens: 60 })
  assert.strictEqual(b.exceeded(), true)
  assert.ok(b.total() >= 100)
})

test('B03-10 预算闸门：子助手调用次数超限被拦住', () => {
  const b = createBudget({ maxSubagentCalls: 2 })
  assert.strictEqual(b.allowSubagent(), true)
  b.countSubagent()
  assert.strictEqual(b.allowSubagent(), true)
  b.countSubagent()
  assert.strictEqual(b.allowSubagent(), false)
})

test('B03-10 预算闸门：限额来自单一来源且为正数', () => {
  for (const [k, v] of Object.entries(BUDGET_LIMITS)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} 必须是正数，实际 ${v}`)
  }
})

test('B03-10 consumeStream 把 usage 交给预算闸门记账（子助手用量不再被丢弃）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.subagent.js'), 'utf8')
  assert.ok(/usage/.test(src), '子助手必须处理 consumeStream 返回的 usage')
  assert.ok(/budget/.test(src), '子助手必须走统一预算闸门')
})

test('B03-10 子助手的 usage 真的记进了同一本账（不是只处理了一下就丢掉）', async () => {
  // 行为判据：桩掉 consumeStream 返回带 usage 的结果，真跑 runOneSubagent，
  // 断言预算闸门的累计 token 增加了 —— 原实现把 usage 直接丢弃，账本纹丝不动。
  const llmPath = require.resolve(path.join(ROOT, 'student-backend/routes/ai/ai.llm.js'));
  const llm = require(llmPath);
  const origConsume = llm.consumeStream;
  llm.consumeStream = async () => ({
    text: JSON.stringify({ task: 't', result: 1, basis: 'b', count: 1, samples: [], error: '', needs_user_decision: [] }),
    toolCalls: [],
    reasoning: '',
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
  });
  try {
    const sub = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.subagent.js'));
    const budget = createBudget();
    const before = budget.total();
    await sub.runOneSubagent(
      { provider: 'deepseek', api_key: 'k', base_url: 'http://x', model: 'm' },
      { name: '核查员', task: '查一下' },
      { budget, blocks: [] }
    );
    assert.strictEqual(budget.total() - before, 1500,
      '子助手这一轮的 1500 token 必须记进共享账本（原先被直接丢弃）');
    assert.strictEqual(budget.bySource().subagent, 1500, '用量要能区分来源');
  } finally {
    llm.consumeStream = origConsume;
  }
})

test('B03-10 子助手超轮数时也要把用量带回来（不能静默丢）', async () => {
  const llmPath = require.resolve(path.join(ROOT, 'student-backend/routes/ai/ai.llm.js'));
  const llm = require(llmPath);
  const origConsume = llm.consumeStream;
  let calls = 0;
  llm.consumeStream = async () => {
    calls += 1;
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: 'query', arguments: '{}' }],
      reasoning: '',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  };
  try {
    const sub = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.subagent.js'));
    const budget = createBudget({ maxSubagentRounds: 2 });
    const out = await sub.runOneSubagent(
      { provider: 'deepseek', api_key: 'k', base_url: 'http://x', model: 'm' },
      { name: '核查员', task: '查一下' },
      { budget, blocks: [] }
    );
    assert.strictEqual(calls, 2, '轮数上限必须真的生效');
    assert.ok(out.error, '超轮数要给出错误');
    assert.strictEqual(out.tokens, 30, '超轮数时已用的 30 token 也要报出来');
    assert.strictEqual(budget.total(), 30, '同样要记进共享账本');
  } finally {
    llm.consumeStream = origConsume;
  }
})
