const express = require('express');
const dbManager = require('../../dbManager/dbManager');
const aiConversationStore = require('../../services/aiConversationStore');
const { resolveEndpoint } = require('./ai.config');

const router = express.Router();

// ---------------- 上下文压缩（长对话自动摘要） ----------------
// 模型上下文窗口与压缩阈值：当最近一轮实际 prompt 用量达到窗口的 90% 时触发压缩
const CONTEXT_WINDOW_TOKENS = 64000;
const CONTEXT_COMPRESS_AT = Math.floor(CONTEXT_WINDOW_TOKENS * 0.9);
// 压缩时保留的最近消息条数（不参与摘要，保证近期细节不丢）
const CONTEXT_KEEP_RECENT = 6;
// 正在压缩中的会话集合，避免同一会话并发摘要
const compressingConvs = new Set();

// 把一条消息的 content 转为纯文本（多模态时只取文字部分）
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((p) => p && p.type === 'text');
    const hasImg = content.some((p) => p && p.type === 'image_url');
    return (t && t.text) || (hasImg ? '（图片）' : '');
  }
  return '';
}

// 把「用户 / 助手」消息序列拼成给摘要模型的文字稿
function messagesToTranscript(list) {
  return list
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${contentToText(m.content)}`)
    .filter((s) => s.replace(/^(用户|助手)：/, '').trim().length > 0)
    .join('\n');
}

// 调用模型把「旧摘要 + 新增对话」合并成一份新摘要（不带工具）
async function summarizeConversation(cfg, prevSummary, chunk) {
  const { url, model } = resolveEndpoint(cfg);
  const transcript = messagesToTranscript(chunk).slice(0, 200000);
  const sys = '你是对话摘要助手。请把用户与助手的对话压缩成简洁的要点摘要，保留关键事实、已达成的结论、用户的偏好与约束、以及尚未完成的事项；不要编造、不要添加对话中不存在的信息。只输出摘要正文，不要标题也不要客套话。';
  const user = (prevSummary ? `已有的摘要：\n${prevSummary}\n\n` : '')
    + `请把下面这段新增对话合并进摘要（保持时间顺序与要点）：\n${transcript}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.2 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`摘要接口返回 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return (text || '').trim();
}

// 压缩：把「summary_upto 之后、最近 CONTEXT_KEEP_RECENT 条之前」的消息并入摘要并持久化
//   effectiveRows 为该会话按 id 升序、且已排除更早摘要覆盖范围与空消息后的消息
async function compressConversation(cfg, conversationId, effectiveRows, upto) {
  if (!conversationId || !Array.isArray(effectiveRows) || effectiveRows.length <= CONTEXT_KEEP_RECENT) return false;
  const cutoff = effectiveRows[effectiveRows.length - CONTEXT_KEEP_RECENT - 1];
  if (!cutoff || cutoff.id <= (upto || 0)) return false;
  const chunk = effectiveRows.filter((r) => r.id <= cutoff.id);
  if (!chunk.length) return false;
  const conv = aiConversationStore.getSummary(conversationId);
  const summary = await summarizeConversation(cfg, (conv && conv.summary) || '', chunk);
  if (!summary) return false;
  aiConversationStore.updateSummary(conversationId, summary, cutoff.id);
  return true;
}

// 把落库的过程块还原成模型能读到的「事实清单」。
//
// 背景：一次请求里的工具调用（assistant.tool_calls + role:'tool' 结果）只活在那个请求的
// history 数组里，res.end() 后就没了；ai_messages 只存 content + process_json，而
// process_json 是给界面过程块用的摘要（title/summary/status），不是 tool_calls。
// 于是下一轮重建上下文时，模型只看得到「用户说了什么 + 自己答了什么」，无从判断自己
// 到底调过哪些工具 —— 只能照着系统提示词里「图表由前端渲染」这类话术补写叙事。
//
// 不重放成 tool_calls：上游要求 tool_call_id 与 role:'tool' 严格配对，重放还会让模型
// 误以为旧结果本轮仍可消费。这里只给一段明确标注为「此前轮次」的自然语言记录，
// 追加在系统提示末尾，消息序列形状不变（不插入中间 system 消息，兼容所有上游）。
function buildToolTrace(rows) {
  const lines = [];
  for (const r of rows || []) {
    if (r.role !== 'assistant' || !r.process_json) continue;
    let proc;
    try { proc = JSON.parse(r.process_json); } catch (_) { continue; }
    const steps = Array.isArray(proc && proc.steps) ? proc.steps : [];
    const used = steps.filter((s) => s && s.kind === 'tool' && s.status !== 'running');
    if (!used.length) continue;
    const parts = used.map((s) => {
      // 新版步骤带 tool（真实工具名）与 detail（工具结果明细）；旧记录没有 tool 时
      // 退回界面标题，历史会话照样能读出来。
      const title = String(s.title || '工具').slice(0, 30);
      const name = String(s.tool || '').trim().slice(0, 40);
      const label = name ? `${title}[${name}]` : title;
      const state = s.status === 'error' ? '失败' : '已执行';
      const summary = String(s.summary || '').trim().slice(0, 60);
      const detail = String(s.detail || '').trim().slice(0, 60);
      return `${label}（${state}${summary ? '，' + summary : ''}${detail ? '；' + detail : ''}）`;
    });
    lines.push(`· 消息 #${r.id}：${parts.join('、')}`.slice(0, 300));
  }
  if (!lines.length) return '';
  return '\n\n【此前轮次的实际工具调用记录】以下是系统在此前对话中确实执行过的工具步骤，'
    + '供你回答「刚才调了什么／做过什么」。它们属于过去的轮次，不代表本轮已调用任何工具；'
    + '本轮是否调用过工具，只以本轮实际收到的工具返回结果为准。\n'
    + lines.slice(-20).join('\n');
}

// 依据会话 id 从数据库重建「完整上下文」：全量历史消息 + 历史附件 + 工具调用记录，并按已有摘要裁剪较早部分
//   返回 { summary, upto, lastPromptTokens, messages, attachments, effectiveRows, toolTrace }；会话不存在返回 null
function loadConversationContext(conversationId) {
  const conv = aiConversationStore.getMeta(conversationId);
  if (!conv) return null;
  const upto = conv.summary_upto || 0;
  const all = aiConversationStore.listMessages(conversationId);
  const effectiveRows = [];
  for (const r of all) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    if (r.id <= upto) continue; // 已被摘要覆盖，不再逐条发送
    let content = r.content || '';
    if (typeof content === 'string' && content.startsWith('[')) {
      try { const p = JSON.parse(content); if (Array.isArray(p)) content = p; } catch (_) { /* 解析失败按纯文本 */ }
    }
    // 跳过没有正文的助手消息（提问轮 / 占位），避免模型收到空消息
    if (r.role === 'assistant' && !contentToText(content).trim() && !(Array.isArray(content) && content.length)) continue;
    effectiveRows.push({ id: r.id, role: r.role, content, process_json: r.process_json, attachments_json: r.attachments_json });
  }
  const messages = effectiveRows.map((r) => ({ role: r.role, content: r.content }));
  const attachments = [];
  for (const r of effectiveRows) {
    if (r.role !== 'user' || !r.attachments_json) continue;
    try {
      const list = JSON.parse(r.attachments_json);
      if (Array.isArray(list)) {
        list.forEach((a) => { if (a && a.name && a.text) attachments.push({ name: a.name, text: a.text, messageId: r.id }); });
      }
    } catch (_) { /* 忽略损坏的附件记录 */ }
  }
  return {
    summary: conv.summary || '', upto, lastPromptTokens: conv.last_prompt_tokens || 0,
    messages, attachments, effectiveRows, toolTrace: buildToolTrace(effectiveRows),
  };
}

// GET /api/ai/memory —— 读取当前班主任的长期记忆（md 原文）
router.get('/memory', (req, res) => {
    res.json({ success: true, data: { content: dbManager.readMemory(req.user && req.user.dbSlug) } });
});

// PUT /api/ai/memory —— 覆盖写入长期记忆，body: { content }
router.put('/memory', (req, res) => {
    dbManager.writeMemory(req.user && req.user.dbSlug, req.body && req.body.content);
  res.json({ success: true, message: '已保存' });
});


module.exports = router;
module.exports.CONTEXT_WINDOW_TOKENS = CONTEXT_WINDOW_TOKENS;
module.exports.CONTEXT_COMPRESS_AT = CONTEXT_COMPRESS_AT;
module.exports.CONTEXT_KEEP_RECENT = CONTEXT_KEEP_RECENT;
module.exports.compressingConvs = compressingConvs;
module.exports.loadConversationContext = loadConversationContext;
module.exports.buildToolTrace = buildToolTrace;
module.exports.compressConversation = compressConversation;
