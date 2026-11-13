const express = require('express');
const aiConversationStore = require('../../services/aiConversationStore');
const dbManager = require('../../dbManager/dbManager');
const { currentSettings } = require('./ai.config');
const { buildSystemPrompt, consumeStream, getMainTools } = require('./ai.llm');
const { toolResultContent, hasUnbackedToolClaim } = require('./ai.helpers');
// 工具执行器惰性加载：仅在执行工具/取工具信息时才 require
const tools = () => require('./ai.tools/tools');
const { loadConversationContext, compressConversation, CONTEXT_COMPRESS_AT, compressingConvs } = require('./ai.memory');
const { createBudget } = require('./ai.budget');
// 安全通道：SSE 逐帧封包（仅在加密会话下生效，否则明文直通）
const { encodeStreamEvent } = require('../../services/secureChannel');

const router = express.Router();

// 会话是否存在：写消息/删会话/读消息前统一校验。
// 不做这一步时，向不存在的会话追加消息会留下孤儿行（SQLite 未开外键约束），
// 读消息则返回空列表，前端无法区分「新会话」与「会话已被删除」。
function conversationExists(id) {
  return aiConversationStore.exists(id);
}

// ---------------------------------------------------------------------------
// 对话记录持久化
// ---------------------------------------------------------------------------

// POST /api/ai/conversations —— 新建会话，body: { title? }
router.post('/conversations', (req, res) => {
    const title = (req.body && req.body.title) || '新对话';
  const info = aiConversationStore.createConversation(title);
  res.json({ success: true, id: info.lastInsertRowid, title });
});

// GET /api/ai/conversations —— 会话列表（按最近更新排序）
router.get('/conversations', (req, res) => {
  try {
    const rows = aiConversationStore.listConversations();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ai/conversations/:id —— 删除会话（含其消息）
router.delete('/conversations/:id', (req, res) => {
    if (!conversationExists(req.params.id)) return res.status(404).json({ error: '会话不存在' });
  aiConversationStore.deleteConversation(req.params.id);
  res.json({ success: true });
});

// 消息行反序列化：过程块 / 附件按 JSON 字符串落库，返回前解析成对象
function parseMessageRows(rows) {
  return rows.map((r) => {
    const { process_json: pj, attachments_json: aj, ...rest } = r;
    let process = null;
    if (pj) { try { process = JSON.parse(pj); } catch (_) { process = null; } }
    let attachments = [];
    if (aj) { try { const p = JSON.parse(aj); if (Array.isArray(p)) attachments = p; } catch (_) { /* 忽略损坏记录 */ } }
    return { ...rest, process, attachments };
  });
}

// GET /api/ai/conversations/:id/messages —— 读取某会话的历史消息
// 取法：
//   1) limit=N            —— 最近 N 条（升序返回），用于恢复/切换会话时快速呈现；
//   2) limit=N&before_id=X —— id < X 的更早 N 条（升序返回），用于上翻补载更早的历史；
//   3) 不传 limit         —— 返回全部（兼容旧调用）。
// 响应附 hasMore：是否仍有更早的消息未返回，前端据此决定是否继续上翻加载。
router.get('/conversations/:id/messages', (req, res) => {
  try {
    if (!conversationExists(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    const limit = Number(req.query.limit);
    const beforeId = Number(req.query.before_id);
    const hasLimit = Number.isInteger(limit) && limit > 0;
    if (!hasLimit) {
      const all = aiConversationStore.listMessagesForUi(req.params.id);
      return res.json({ success: true, data: parseMessageRows(all), hasMore: false });
    }
    // 多取 1 条探测是否还有更早的：倒序里的第 limit+1 条即该批最早一条，升序后落在首位
    const rows = aiConversationStore.listMessagesPage(req.params.id, { beforeId, limit });
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(1) : rows; // 丢弃多取的探测条（升序首位＝最早者）
    res.json({ success: true, data: parseMessageRows(kept), hasMore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/conversations/:id/messages —— 追加一条消息；默认截断过长历史
router.post('/conversations/:id/messages', (req, res) => {
  try {
    if (!conversationExists(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    const { role, content, process, attachments } = req.body;
    if (!role || typeof content !== 'string') return res.status(400).json({ error: '缺少消息内容' });
    // 过程块（步骤 / 思维链 / 耗时）以 JSON 字符串落库
    let processJson = '';
    if (process) { try { processJson = JSON.stringify(process); } catch (_) { processJson = ''; } }
    // 本轮上传的文件（{name, text}）随消息落库，后续轮次仍可读取（完整上下文）
    let attachmentsJson = '';
    if (Array.isArray(attachments) && attachments.length) {
      try { attachmentsJson = JSON.stringify(attachments.filter((a) => a && a.name && a.text)); } catch (_) { attachmentsJson = ''; }
    }
    const info = aiConversationStore.insertMessage(req.params.id, role, content, processJson, attachmentsJson);
    aiConversationStore.touch(req.params.id);
    if (role === 'user') {
      // 用第一条用户消息作标题
      aiConversationStore.autoTitle(req.params.id, content);
    }
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/ai/conversations/:id/messages/:mid —— 覆盖更新一条消息的正文与过程块
// 用于「反馈轮次并入原助手消息」：后续轮次的输出继续写回同一条助手消息，时间轴保持连续
router.put('/conversations/:id/messages/:mid', (req, res) => {
  try {
    if (!conversationExists(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    const { content, process } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: '缺少消息内容' });
    let processJson = '';
    if (process) { try { processJson = JSON.stringify(process); } catch (_) { processJson = ''; } }
    aiConversationStore.updateMessage(req.params.id, req.params.mid, content, processJson);
    aiConversationStore.touch(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ai/conversations/:id/messages/last-assistant —— 重试前移除最近一条助手回复
router.delete('/conversations/:id/messages/last-assistant', (req, res) => {
    const row = aiConversationStore.lastAssistantId(req.params.id);
  if (row) aiConversationStore.deleteMessage(row.id);
  res.json({ success: true, removed: !!row });
});

// POST /api/ai/conversations/:id/messages/delete —— 回退本轮时按消息 id 精确删除（body: { ids }）
router.post('/conversations/:id/messages/delete', (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!ids.length) return res.json({ success: true, removed: 0 });
    const info = aiConversationStore.deleteMessages(req.params.id, ids);
    aiConversationStore.touch(req.params.id);
    res.json({ success: true, removed: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/ai/chat/stream —— body: { messages, attachments, conversationId }
//   消息落库由前端另行负责；conversationId 存在时，后端按会话从库中重建完整上下文
//   （全量历史消息 + 历史附件），并用已有摘要裁剪较早部分，接近上下文上限时自动压缩。
router.post('/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(encodeStreamEvent(req, obj))}\n\n`); } catch (_) {} };

  // 心跳帧：上游模型停顿、或工具执行很久时，网关/代理会把「没有字节流动」的连接
  // 判成空闲并断开，前端只能干等且分不清「还在算」和「已经死了」。
  // SSE 里以 ':' 开头的是注释帧，客户端会忽略，不影响协议（审查 v4 · B03-02）。
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch (_) {} }, 15000);
  if (heartbeat.unref) heartbeat.unref();
  const stopHeartbeat = () => clearInterval(heartbeat);
  res.on('close', stopHeartbeat);
  res.on('finish', stopHeartbeat);

  // 客户端断开（用户点「中断」或关闭页面）时 res 会触发 close：
  //   - 标记 clientGone，让下方循环及时停止、不再调用模型
  //   - 该信号传给 consumeStream，同步 abort 上游 fetch，避免白跑
  // 断开后写入 res 可能触发 'error'（EPIPE），这里吞掉，避免未捕获异常
  res.on('error', () => {});
  const clientGone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) clientGone.abort(); });

  let s;
  try { s = currentSettings(); } catch (_) {}
  if (!s || !s.enabled || !s.api_key) {
    send({ type: 'err', message: '尚未启用 / 配置 AI，请先在【系统设置 → AI 助手设置】填写并启用' });
    return res.end();
  }

  // 完整上下文：优先按会话从数据库重建（含全量历史消息与历史附件），并用已有摘要裁剪较早部分；
  // 无会话（conversationId 为 0）时回退到前端本次带来的消息与附件。
  //
  // 审查 v4 · B03-08：原先只要 loadConversationContext 返回 null 就回退到请求体消息，
  // 而它返回 null 的**唯一**含义是「会话不存在」（ai.memory.js:75）。
  // 于是「会话已被删除 / id 传错」被静默当成「新建会话」处理 —— 前端拿到回复却
  // 写不回任何会话（persistMessage 对不存在的会话会 404 被吞掉），用户看到的是
  // 「这轮对话凭空消失」。这里改成显式区分两种语义。
  const conversationId = Number(req.body && req.body.conversationId) || 0;
  let convCtx = conversationId ? loadConversationContext(conversationId) : null;
  if (conversationId && !convCtx) {
    // 传了会话 id 但库里查不到 → 会话已被删除或 id 无效，明确报错而不是静默降级。
    // code 让前端能识别并自愈（清掉失效的 conversationId，下次发送自动新建会话）。
    send({ type: 'err', code: 'conversation_missing', message: '当前对话已被删除或不存在，请新建对话后重试' });
    return res.end();
  }
  let messages = convCtx ? convCtx.messages : req.body.messages;
  if (!Array.isArray(messages)) { send({ type: 'err', message: '缺少消息' }); return res.end(); }
  let attachments = convCtx
    ? convCtx.attachments
    : (Array.isArray(req.body.attachments) ? req.body.attachments : []);

  // 安全网：上一轮实际用量已超过阈值时先同步压缩，避免本轮直接撑爆上下文
  if (convCtx && convCtx.lastPromptTokens > CONTEXT_COMPRESS_AT && !compressingConvs.has(conversationId)) {
    compressingConvs.add(conversationId);
    try {
      if (await compressConversation(s, conversationId, convCtx.effectiveRows, convCtx.upto)) {
        convCtx = loadConversationContext(conversationId);
        messages = convCtx.messages;
        attachments = convCtx.attachments;
      }
    } catch (_) { /* 压缩失败不阻塞对话 */ }
    finally { compressingConvs.delete(conversationId); }
  }

  // 本轮启用的技能（md 指令文件）：前端按「/」选中的技能名，读取内容注入系统提示
  const skills = dbManager.readSkills(req.user && req.user.dbSlug, req.body.skills);
  // 跨轮补证据：把此前轮次实际执行过的工具步骤追加到系统提示末尾。
  // 只用一段文本，不改消息序列形状（不插入中间 system 消息、不重放 tool_calls），
  // 因此对所有上游接口都兼容；没有历史工具记录时 toolTrace 为空串，零影响。
  const systemText = buildSystemPrompt(req.user && req.user.dbSlug, attachments, convCtx && convCtx.summary, skills)
    + (convCtx ? convCtx.toolTrace : '');
  const history = [{ role: 'system', content: systemText }, ...messages];
  let proposal = null;
  let ask = null;
  let exportFile = null;
  let exportImage = null;
  let answerText = ''; // 仅最终轮的正文；中间轮（调用工具那几轮）的草稿文本归入过程块
  const blocks = [];   // record 表格 / chart 图表数据块（拼到正文末尾，前端渲染）
  // 联网搜索开关：仅当请求未显式关闭（webSearch === false）时下发 web_search 工具
  const webSearchOn = !!(req.body && req.body.webSearch !== false);
  const ctx = { blocks, slug: req.user && req.user.dbSlug, images: tools().latestUserImages(messages), attachments, signal: clientGone.signal, cfg: s };
  // 子助手轨迹实时下发：增量事件挂到当前工具步骤 id 上，前端据此把片段追加到那一格过程块。
  // 只在工具执行期间有 stepId，没有宿主步骤时不下发（避免前端收到孤儿事件）。
  ctx.stepId = null;
  ctx.emitSub = (p) => {
    if (!ctx.stepId) return;
    send({ type: 'sub_step', stepId: ctx.stepId, ...p });
  };
  // 预算闸门：主对话与子助手共用同一本账（审查 v4 · B03-10）。
  // 超限后不再继续调用模型，把已有信息收尾成最终回答，避免「模型自己无限循环调工具」。
  const budget = createBudget();
  ctx.budget = budget;
  const steps = [];    // 过程块：本轮所有步骤（过程文本 / 工具调用）
  let stepSeq = 0;
  const startedAt = Date.now();
  // 本轮对话累计 token（含工具调用的所有轮次；服务未返回用量时保持 0）
  const tokenTotal = { prompt: 0, completion: 0, total: 0 };
  let maxPromptTokens = 0; // 单次调用最大的 prompt token（判断是否接近上下文上限）
  const donePayload = () => {
    afterRound();
    // 收尾对账：本轮没有任何工具调用记录，正文却声称「已调用／已生成产物」。
    // 不改写模型原文（保留可追溯性），补一条由系统给出、基于 steps 的事实说明，
    // 让「我调用了工具」不再是一句无证据的最终结论。
    const claimNote = hasUnbackedToolClaim(answerText, steps)
      ? '\n\n> 系统核对：本轮没有实际的工具调用记录，上文中「已调用工具／已生成产物」的说法没有依据。'
      : '';
    return {
      reply: tools().appendBlocks(answerText + claimNote, blocks), steps, ms: Date.now() - startedAt,
      // tokens 取统一预算闸门的累计值（含子助手消耗）——原先只统计主对话自己那几轮
      tokens: budget.total() || tokenTotal.total,
      promptTokens: tokenTotal.prompt, completionTokens: tokenTotal.completion,
    };
  };

  // 每轮结束时：记录本轮实际用量；若已达上下文阈值，后台摘要较早消息并持久化（不阻塞本次响应）
  function afterRound() {
    if (!conversationId || maxPromptTokens <= 0) return;
    try { aiConversationStore.setLastPromptTokens(conversationId, maxPromptTokens); } catch (_) {}
    if (!convCtx || maxPromptTokens <= CONTEXT_COMPRESS_AT || compressingConvs.has(conversationId)) return;
    compressingConvs.add(conversationId);
    const rows = convCtx.effectiveRows;
    const upto = convCtx.upto;
    setImmediate(async () => {
      try { await compressConversation(s, conversationId, rows, upto); }
      catch (_) { /* 后台压缩失败忽略，下次再试 */ }
      finally { compressingConvs.delete(conversationId); }
    });
  }

  // 消息落库统一由前端的 POST /conversations/:id/messages 负责（含图片多模态、错误提示），
  // 这里不再重复写入，否则刷新后同一轮回答会出现两条。

  try {
    // 工具链轮次上限：只要模型持续调用工具就继续，直到模型自己给出最终回答；上限仅作防死循环兜底
    for (let r = 0; r < 12; r++) {
      if (clientGone.signal.aborted) return res.end();
      // 预算闸门：累计用量超限就不再调模型（再调一次也是超限），
      // 直接把已有信息收尾，并告知模型/用户已达上限（B03-10）
      if (budget.exceeded()) {
        const note = budget.note();
        send({ type: 'note', text: note });
        // 让模型看到「已达上限」这条约束，好让它在下一句给出收尾结论
        history.push({ role: 'system', content: note });
        answerText = answerText || '';
        send({ type: 'done', ...donePayload() });
        return res.end();
      }
      const { text, toolCalls, reasoning, usage } = await consumeStream(
        s,
        history,
        (d) => send({ type: 'delta', text: d }),
        (d) => send({ type: 'reasoning', text: d }),
        clientGone.signal,
        getMainTools(s, webSearchOn)
      );
      if (usage) {
        maxPromptTokens = Math.max(maxPromptTokens, usage.prompt_tokens || 0);
        tokenTotal.prompt += usage.prompt_tokens || 0;
        tokenTotal.completion += usage.completion_tokens || 0;
        tokenTotal.total += usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        // 记入统一预算闸门（含子助手消耗的那部分，见 ai.budget.js）
        budget.add(usage, 'main');
      }

      // 思考（思维链）作为时间轴上的一个步骤：插在本轮的工具/文本步骤之前，
      // 这样前端的过程块里「思考 / 工具」会按时间交替出现，而不是把思维链堆在最上面
      if (reasoning) {
        const reasonStep = { id: 'r' + (++stepSeq), kind: 'reason', text: reasoning, status: 'done' };
        steps.push(reasonStep);
        send({ type: 'step', step: reasonStep });
      }

      if (toolCalls && toolCalls.length) {
        // 中间轮的草稿文本归入过程块：前端收到后清空正文，把它作为一条「过程文本」步骤
        if (text) {
          const textStep = { id: 'p' + (++stepSeq), kind: 'text', text };
          steps.push(textStep);
          send({ type: 'commit_process', text });
        }
        history.push({
          role: 'assistant',
          content: text || '',
          // 带 tools 的思考模式要求把思维链原样回传，否则后续轮次可能报错
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
        });
        for (const tc of toolCalls) {
          const info = tools().TOOL_INFO[tc.name] || { running: '正在调用工具…', done: '调用工具' };
          const sid = 's' + (++stepSeq);
          ctx.stepId = sid;
          const t0 = Date.now();
          send({ type: 'step', step: { id: sid, kind: 'tool', title: info.running, status: 'running' } });
          let args = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch (_) {}
          const out = await tools().runTool(tc.name, args, ctx);
          if (out.proposal) proposal = out.proposal;
          if (out.ask) ask = out.ask;
          const result = out.result;
          history.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent(result) });
          // 工具执行结束 → 更新同一步骤为 done/error，并附上摘要与耗时
          const step = {
            id: sid,
            kind: 'tool',
            // 工具名随步骤一起落库（前端过程块不用它，但 loadConversationContext
            // 要靠它把「界面标题」还原成模型能对应上的真实工具调用记录）。
            tool: tc.name,
            title: info.done,
            status: result && result.error ? 'error' : 'done',
            summary: tools().toolSummary(tc.name, result),
            detail: tools().toolDetailText(result),
            // 子助手的思考 / 工具轨迹：挂在 run_subagent 这一步下，随 steps 落库，刷新后仍在
            ...(Array.isArray(out.trace) && out.trace.length ? { subSteps: out.trace } : {}),
            ms: Date.now() - t0,
          };
          steps.push(step);
          send({ type: 'step', step });
          // 导出文件：把规格下发给前端（前端负责生成文件并弹系统保存对话框），本轮继续让模型收尾
          if (out.exportFile) {
            exportFile = out.exportFile;
            send({ type: 'export_file', exportFile });
          }
          // 导出图片：把图片规格下发给前端（前端用 html2canvas 渲染成 PNG 并弹系统保存对话框）
          if (out.exportImage) {
            exportImage = out.exportImage;
            send({ type: 'export_image', exportImage });
          }
          // 若本轮出现写提案，下发提案并停止继续推理
          if (proposal) {
            send({ type: 'proposal', proposal });
            send({ type: 'done', ...donePayload() });
            return res.end();
          }
          // 出现提问：下发问题与选项，停止本轮，等用户点选后作为新一轮消息继续
          if (ask) {
            send({ type: 'ask', ask });
            send({ type: 'done', ...donePayload() });
            return res.end();
          }

        }
        continue;
      }

      // 纯文本轮：本轮文本即为最终正文（已通过 delta 流式发出）
      answerText = text || '';
      send({ type: 'done', ...donePayload() });
      return res.end();
    }
    send({ type: 'done', ...donePayload() });
    return res.end();
  } catch (err) {
    // 客户端已断开（用户中断）：静默结束，不回报错也不写 SSE
    if (clientGone.signal.aborted) return res.end();
    send({ type: 'err', message: err.message || 'AI 请求失败' });
    return res.end();
  }
});


module.exports = router;
