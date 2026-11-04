// ===== run_subagent 工具：只读子助手（schema + 并行调度 + 契约解析） =====
// runTool 由 tools.js 门面提供；这里用惰性包装打破 tools ⇄ tools.subagent 的循环引用。
let runTool = (...args) => require('./tools').runTool(...args);
const { toolResultContent } = require('../ai.helpers');

// ===== run_subagent 工具：启动「只读子助手」并行处理独立子任务 =====
// 子助手在受限上下文（角色名 + 一句话任务 + 期望字段 + 口径）与受限工具子集
// （llm.js 的 SUBAGENT_TOOL_NAMES：只有查询/统计/校验类，无任何写入与提问工具）里跑，
// 只读、不改数据、不直连用户提问，按固定契约返回结构化结果。
const subagentTool = {
  type: 'function',
  function: {
    name: 'run_subagent',
    description: '启动 1~4 个「只读子助手」并行处理相互独立的核查子任务。适用：① 任务可拆成 3 个以上互不依赖的子问题（并行体检）；② 单次需扫过超过 500 行；③ 对关键数字做独立复核（让不带主上下文的子助手用原始数据重算）。子助手只读、不改数据、不会直接向老师提问（拿不准的事写入其返回的 needs_user_decision）。每个子任务返回 {task, result, basis, count, samples, error, needs_user_decision}，其中 basis/count 用于核对其查询范围。此调用不会改数据。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '要并行跑的子任务列表（1~4 个）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '子助手角色名，如「数据体检员」' },
              task: { type: 'string', description: '一句话目标' },
              returns: { type: 'string', description: '期望返回的字段/口径（可选）' },
              context: { type: 'string', description: '涉及的表名 + 口径（可选），如「结余=收入-支出，不含未报销」' },
            },
            required: ['name', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
};

const MAX_SUBAGENT_TASKS = 4;      // 一次最多并行几个子任务（控制成本与延迟）
// 单个子任务最多几轮推理（防死循环，与主循环口径一致）：
// 实际取值走统一预算闸门（ai.budget.js 的 BUDGET_LIMITS.maxSubagentRounds），
// 这里保留常量仅作兜底默认值，避免两处数字各写一份。
const MAX_SUBAGENT_ROUNDS = 6;

// 解析子助手返回的正文为契约对象：容错剥离 ```json 围栏，取首个 '{' 到最后一个 '}' 的片段；
// 解析失败则兜底成「未按契约返回」，避免把整段自然语言当成结果结构。
function parseSubagentResult(text, task) {
  const raw = String(text || '').trim();
  let body = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) body = body.slice(start, end + 1);
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) { /* 落到兜底 */ }
  return { task, result: raw, basis: '', count: 0, samples: [], error: '子助手未按契约返回 JSON', needs_user_decision: [] };
}

// 子助手只能调用「只读工具白名单」里的名字。
// 名单的唯一来源是 ai.subagent-tools.js（同一份也用于下发给模型的工具清单），
// 这里在执行侧再做一次强制校验：模型返回清单外的名字一律拒绝。
const { isSubagentToolAllowed } = require('../ai.subagent-tools');

// 单个子任务：独立上下文 + 受限只读工具子集，循环取数直至子助手给出最终 JSON
async function runOneSubagent(cfg, item, ctx) {
  const { consumeStream, buildSubagentPrompt, getSubagentTools } = require('../ai.llm');
  const name = String((item && item.name) || '数据核查员').slice(0, 40);
  const task = String((item && item.task) || '').trim();
  if (!task) {
    return { task: '', result: null, basis: '', count: 0, samples: [], error: '子任务缺少 task（目标）', needs_user_decision: [] };
  }
  const subTools = getSubagentTools();
  const history = [
    { role: 'system', content: buildSubagentPrompt({ name, task, returns: item.returns, context: item.context }) },
    { role: 'user', content: task },
  ];
  // 独立 blocks：子助手即便用到块类工具也不污染主对话正文
  const subCtx = { ...ctx, blocks: [] };
  // 统一预算闸门：与主对话共用同一本账（ctx.budget 由主对话注入）。
  // 子助手原先把 consumeStream 的 usage 直接丢弃 → 烧了多少 token 主对话完全不知道，
  // 既没法限、也没法报（审查 v4 · B03-10）。
  const budget = ctx && ctx.budget;
  // 轮数上限取自统一预算闸门（limits() 是方法，必须调用它拿值）
  const maxRounds = (budget && budget.limits && budget.limits().maxSubagentRounds) || MAX_SUBAGENT_ROUNDS;
  let usedTokens = 0;
  for (let i = 0; i < maxRounds; i++) {
    if (budget && budget.exceeded()) {
      return { task, result: null, basis: '', count: 0, samples: [], error: budget.note(), needs_user_decision: [] };
    }
    const { text, toolCalls, reasoning, usage } = await consumeStream(cfg, history, null, null, ctx && ctx.signal, subTools);
    // usage 记账：子助手的消耗必须计入同一本账，否则主对话的统计是残缺的
    if (usage) {
      if (budget) budget.add(usage, 'subagent');
      usedTokens += (usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)));
    }
    if (!toolCalls || !toolCalls.length) {
      const parsed = parseSubagentResult(text, task);
      parsed.tokens = usedTokens;
      return parsed;
    }
    history.push({
      role: 'assistant',
      content: text || '',
      // 带 tools 的思考模式要求把思维链原样回传，否则后续轮次可能报错
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
    });
    for (const tc of toolCalls) {
      let targs = {};
      try { targs = JSON.parse(tc.arguments || '{}'); } catch (_) {}
      let result;
      // 工具清单只是「告诉模型有哪些工具」，模型仍可能返回清单外的名字
      // （旧会话/换模型/被提示注入诱导）。子助手的只读边界必须在这里强制校验，
      // 否则 save_memory / undo_change / ask_user / propose_* 都能被子助手直接触发。
      if (!isSubagentToolAllowed(tc.name)) {
        result = { error: `子助手不允许调用「${tc.name}」：只读子助手只能使用查询/统计/校验类工具` };
      } else {
        try { result = (await runTool(tc.name, targs, subCtx)).result; }
        catch (e) { result = { error: e.message || '子助手工具执行失败' }; }
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent(result) });
    }
  }
  return { task, result: null, basis: '', count: 0, samples: [], error: '子助手超过最大轮数仍未给出结论', needs_user_decision: [], tokens: usedTokens };
}

// run_subagent：并行启动若干只读子助手，各自返回契约对象
async function runSubagent(args, ctx) {
  const { currentSettings } = require('../ai.config');
  const list = Array.isArray(args && args.tasks)
    ? args.tasks.filter((t) => t && typeof t === 'object' && !Array.isArray(t))
    : [];
  if (!list.length) return { results: [], error: '缺少子任务（tasks 不能为空，每项含 name/task）' };
  const cfg = currentSettings();
  if (!cfg || !cfg.api_key) return { results: [], error: '尚未启用 / 配置 AI，子助手无法运行' };
  // 预算闸门：与主对话共用（ctx.budget）。超限则不再启动子助手 —— 「上限」必须
  // 在**发起前**拦，否则并行启动的 4 个子助手会先把钱花掉（B03-10）。
  const budget = ctx && ctx.budget;
  if (budget && !budget.allowSubagent()) {
    return { results: [], count: 0, error: budget.note() };
  }
  let tasks = list.slice(0, MAX_SUBAGENT_TASKS);
  if (budget) {
    budget.countSubagent();
    // 本次允许的子任务数受「子助手调用次数」剩余额度约束
    const remain = Math.max(0, budget.limits().maxSubagentCalls - budget.subagentCalls());
    tasks = tasks.slice(0, remain);
    if (!tasks.length) return { results: [], count: 0, error: budget.note() };
  }
  const results = await Promise.all(tasks.map((t) =>
    runOneSubagent(cfg, t, ctx).catch((e) => ({
      task: String((t && t.task) || ''), result: null, basis: '', count: 0, samples: [],
      error: e.message || '子助手运行失败', needs_user_decision: [],
    }))
  ));
  // 用量汇总回传：主对话据此知道子助手烧了多少（原先完全不可见）
  const tokens = results.reduce((sum, r) => sum + ((r && r.tokens) || 0), 0);
  return { results, count: results.length, tokens };
}

module.exports = { subagentTool, runSubagent, runOneSubagent, isSubagentToolAllowed };
