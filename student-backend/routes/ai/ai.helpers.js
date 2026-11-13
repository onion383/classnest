const { getFields } = require('../../db');
const aiStore = require('../../services/aiStore');

// 列值归一化：对象/数组按 JSON 文本、布尔按 1/0、其余按字符串，用于「是否与当前内容相同」的比较。
// 布尔归一为 1/0 是为了与 sqlite 里 INTEGER 列（如 toolbox_enabled / auto_apply）存的数值一致。
function normColVal(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  const t = s.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try { const p = JSON.parse(t); if (p && typeof p === 'object') return JSON.stringify(p); } catch (_) { /* 非 JSON 文本 */ }
  }
  return s;
}

// 写库时序列化列值：对象/数组须转成 JSON 文本（sqlite 不能直接绑定对象），
// 布尔转为 1/0（否则会被当文本写入，破坏 INTEGER 列语义）。
function serializeColVal(v) {
  if (v != null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// 表列名缓存与其失效逻辑已下沉到 services/aiStore.js（M12-B7）；
// 对外仍从本模块导出，调用方 import 路径不变。
const { tableColumns, clearTableColumnsCache } = aiStore;

// 回灌给模型的工具结果上限：查询/导出类工具可能返回整张大表，
// 全量塞进 history 会撑爆上下文并让后续请求变慢甚至失败。
const MAX_TOOL_RESULT_CHARS = 12000;
function toolResultContent(result) {
  let text;
  try { text = JSON.stringify(result); } catch (_) { text = JSON.stringify({ error: '工具结果无法序列化' }); }
  if (typeof text !== 'string') text = String(text);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return text.slice(0, MAX_TOOL_RESULT_CHARS)
    + `\n…（工具结果过长，已截断；原长度 ${text.length} 字符。需要完整数据请缩小查询范围或分页）`;
}

// 表在列表页「实际展示的列」（与界面保持一致）：优先取 table_meta 中登记的列；
// 未登记时退回「除 id / position 外的所有列」——避免把 position、外键、created_at 等内部列露出来。
function displayColumns(table) {
  const fields = getFields(table);
  if (fields && fields.length) return fields.map((f) => f.name);
  return tableColumns(table).filter((c) => c !== 'id' && c !== 'position');
}


// 收尾对账：纯文本轮（模型本轮没输出任何 tool_calls）却在正文里声称「已调用工具／已生成产物」。
// 这类话没有结构化证据，不能让它原样成为最终答案、再被下一轮当成既成事实。
// 只认完成态动作声明；能力描述（「我可以调用 query 工具」）与提问不算。
const TOOL_ACTION_RE = /(?:已|已经|刚刚?|曾)(?:经)?[^。！？\n]{0,8}(?:调用|使用|执行)(?:了|过)?[^。！？\n]{0,12}工具|(?:调用|使用|执行)(?:了|过)[^。！？\n]{0,12}工具/;
const PRODUCT_RE = /(?:已|已经|刚刚?|为您|为你)[^。！？\n]{0,8}(?:生成|绘制|渲染|展示|导出|保存|写入)[^。！？\n]{0,12}(?:图表|柱状图|饼图|折线图|统计表|表格|文件|图片|记忆)/;

function hasUnbackedToolClaim(text, steps) {
  const t = String(text || '');
  if (!TOOL_ACTION_RE.test(t) && !PRODUCT_RE.test(t)) return false;
  // 本轮只要有过一次工具调用（不论成功失败），「调用过工具」就是有据可依的。
  // 失败步骤也算：模型说的是「调用」，不是「调用成功」。
  const called = (steps || []).some((s) => s && s.kind === 'tool' && s.status !== 'running');
  return !called;
}

module.exports = { normColVal, serializeColVal, tableColumns, displayColumns, clearTableColumnsCache, toolResultContent, hasUnbackedToolClaim };
