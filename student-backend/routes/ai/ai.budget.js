// =========================================================================
// ai.budget.js —— AI 调用预算闸门（主对话与子助手共用同一份）
//
// 审查 v4 · B03-10：原先「子助手并行 4×6 轮流式 LLM 无 token/成本上限」，
// 而根因比「没写上限」更靠前一层：
//
//   1) 子助手调用 consumeStream 时**把返回的 usage 直接丢弃**（只解构了
//      text/toolCalls/reasoning）→ 子助手烧掉多少 token，主对话完全不知道；
//   2) 主对话的 token 统计只统计自己那几轮 consumeStream → 子助手的消耗
//      既不进统计、也没人能据此判断「该不该继续」；
//   3) 于是「上限」无处可依 —— 不是忘了写数字，是**没有统一的记账口径**。
//
// 修法：把「记账 + 限额 + 是否还能继续」收成一处（createBudget），
//   主对话与子助手共用同一个实例；子助手每轮把 usage 记到同一本账上，
//   超限即中止后续子助手调用，并把已用量的汇总回传给调用方。
//
// 单一事实来源：限额全在 BUDGET_LIMITS 里，改这里即可，别在别处散写数字。
// =========================================================================

// 限额（按「一次用户请求」为口径，不是按整个会话）
const BUDGET_LIMITS = {
  // 单次请求内，全部 AI 调用（含子助手）累计 token 上限。
  // 参照 CONTEXT_WINDOW_TOKENS=64000（ai.memory.js）：单轮上下文就可能几万 token，
  // 12 轮工具循环叠加子助手，很容易冲到几十万。给一个明确的硬顶，
  // 避免「模型自己无限循环调工具」把成本和等待时间放大到不可控。
  maxTotalTokens: 400000,
  // 单次请求内允许的子助手调用次数上限（run_subagent 一次最多 4 个任务 × 6 轮）
  maxSubagentCalls: 24,
  // 单个任务内允许的工具调用轮数上限（子助手内部循环）
  maxSubagentRounds: 6,
};

// 创建一个预算闸门。
//   maxTotalTokens   累计 token 上限
//   maxSubagentCalls 子助手调用次数上限
//   maxSubagentRounds 单任务内轮数上限
function createBudget(limits = {}) {
  const maxTotalTokens = num(limits.maxTotalTokens, BUDGET_LIMITS.maxTotalTokens);
  const maxSubagentCalls = num(limits.maxSubagentCalls, BUDGET_LIMITS.maxSubagentCalls);
  const maxSubagentRounds = num(limits.maxSubagentRounds, BUDGET_LIMITS.maxSubagentRounds);

  let totalTokens = 0;
  let subagentCalls = 0;
  const bySource = { main: 0, subagent: 0 };

  return {
    // 记一笔用量。usage 形如 { prompt_tokens, completion_tokens, total_tokens }
    add(usage, source = 'main') {
      if (!usage) return 0;
      const t = tokenCount(usage);
      totalTokens += t;
      bySource[source] = (bySource[source] || 0) + t;
      return totalTokens;
    },
    // 累计 token 是否已达上限
    exceeded() {
      return totalTokens >= maxTotalTokens;
    },
    // 子助手还能不能再发起一次调用
    allowSubagent() {
      return subagentCalls < maxSubagentCalls && !this.exceeded();
    },
    countSubagent() {
      subagentCalls += 1;
      return subagentCalls;
    },
    // 单个任务内还能不能再跑一轮
    allowRound() {
      return !this.exceeded();
    },
    total() { return totalTokens; },
    subagentCalls() { return subagentCalls; },
    bySource() { return { ...bySource }; },
    limits() {
      return { maxTotalTokens, maxSubagentCalls, maxSubagentRounds };
    },
    // 超限时给模型看的说明（要写清「已达上限、不要再继续调工具」）
    note() {
      return `已达到本次请求的用量上限（累计 ${totalTokens} token，上限 ${maxTotalTokens}）。`
        + '请基于已获得的信息直接给出结论，不要再调用任何工具。';
    },
  };
}

// 从 usage 里取 token 数：优先 total_tokens，其次 prompt+completion 兜底。
// 服务商不一定回 usage（老模型/部分代理），此时按 0 计 —— 不能凭空估算，
// 否则会把「没上报」当成「用了很多」。
function tokenCount(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;
  const p = Number(usage.prompt_tokens) || 0;
  const c = Number(usage.completion_tokens) || 0;
  return p + c;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { createBudget, tokenCount, BUDGET_LIMITS };
