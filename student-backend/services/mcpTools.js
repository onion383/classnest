// =========================================================================
// mcpTools.js —— 方向 B 暴露给外部 AI 客户端的工具实现（与传输层解耦）
//
// 所有 handler 都在 dbManager.withDb(slug, ...) 上下文内被调用（由 routes/mcp 包装），
// 因此复用 db Proxy / aiStore / slotStore 与本地 AI 工具是同一口径。
//
// 写操作只「生成提案」，不落库——与本地 propose_* 同一原则；真正的写入在老师
// 于班集 UI 确认后由 mcpProposalExec.confirm 执行。
// =========================================================================

const { db } = require('../db');
const aiStore = require('./aiStore');
const store = require('./slotStore');
const { runSearch } = require('./searchQuery');
const { READ_TABLES, WRITE_TABLES } = require('../routes/ai/ai.constants');
const { readScope } = require('./aiReadScope');
const proposals = require('./mcpProposalStore');
const { toolResultContent } = require('../routes/ai/ai.helpers');

const MAX_ROWS = 200;

function ok(data) { return { ok: true, ...(data || {}) }; }
function fail(error) { return { ok: false, error: String(error) }; }

// 列出可读的表（供外部 AI 知道有哪些数据）。slug 由其 token 绑定，此处不返回。
function listTables() {
  // §4.2：list_tables 与其它读表入口共用同一个有效表集，被关的表不再列出
  const out = Object.entries(readScope.effectiveReadTables()).map(([key, description]) => ({ key, description }));
  // 标注哪些可写（仍需提案确认）
  for (const t of out) t.writable = Object.prototype.hasOwnProperty.call(WRITE_TABLES, t.key);
  return ok({ tables: out, note: '写操作需先 propose_write,由老师在班集内确认后执行' });
}

// 读一张行式表：白名单校验 + 行数上限 + 列裁剪由 search 的口径决定，这里直接读全列。
function readTable({ table, limit, offset } = {}) {
  const key = String(table || '');
  if (!Object.prototype.hasOwnProperty.call(READ_TABLES, key)) return fail(`不可读的表：${key}`);
  // 整块 JSON 表走 getDoc，不按行读
  if (store.isDoc(key)) return readDoc({ table: key });
  const cap = Math.max(1, Math.min(MAX_ROWS, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  try {
    // 表名来自白名单 key，非用户输入拼接，安全
    const rows = db.prepare(`SELECT * FROM "${key}" LIMIT ? OFFSET ?`).all(cap, off);
    const total = aiStore.tableColumns(key) ? db.prepare(`SELECT COUNT(*) AS n FROM "${key}"`).get().n : rows.length;
    return ok({ table: key, rows, total, limit: cap, offset: off, truncated: rows.length >= cap });
  } catch (e) {
    return fail(`读取失败：${e.message}`);
  }
}

// 读整块 JSON 文档（课表/座位/值日等单例表）
function readDoc({ table } = {}) {
  const key = String(table || '');
  if (!store.isDoc(key)) return fail(`不是整块文档表：${key}`);
  const doc = store.getDoc(key);
  if (!doc) return fail(`该表暂无数据：${key}`);
  return ok({ table: key, doc });
}

// 搜索：复用本地 AI 的 runSearch（白名单表 + 分页），口径完全一致。
function search({ q } = {}) {
  const query = String(q || '').trim();
  if (!query) return fail('缺少搜索词 q');
  try {
    return ok(runSearch({ q: query }));
  } catch (e) {
    return fail(`搜索失败：${e.message}`);
  }
}

// 提交写提案：只校验白名单与基本结构，不执行。
function proposeWrite({ table, operation, id, data, label } = {}) {
  const key = String(table || '');
  if (!Object.prototype.hasOwnProperty.call(WRITE_TABLES, key)) return fail(`该表不支持通过 MCP 写入：${key}`);
  const op = String(operation || '');
  if (!['add', 'update', 'delete'].includes(op)) return fail(`不支持的操作：${op}`);
  if (op !== 'add') {
    const rid = Number(id);
    if (!Number.isInteger(rid) || rid <= 0) return fail(`记录 id 无效：${id == null ? '' : id}`);
  }
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) return fail('data 必须是对象');
  const payload = { id: op === 'add' ? undefined : Number(id), data: data || {} };
  const proposalId = proposals.create({
    kind: 'row_write',
    label: String(label || `${WRITE_TABLES[key]} · ${op}`).slice(0, 200),
    table: key,
    operation: op,
    payload,
    requestedBy: 'mcp',
  });
  return ok({
    proposal_id: proposalId,
    status: 'pending',
    message: '提案已提交，等待老师在班集内确认。请用 get_proposal_result 查询结果。',
    hint: '本工具不会立即改动数据。',
  });
}

// 查询提案结果：外部 AI 隔一段时间回来取。
function getProposalResult({ proposal_id } = {}) {
  const p = proposals.get(proposal_id);
  if (!p) return fail('提案不存在或已过期清理');
  return ok({
    proposal_id: p.proposal_id,
    status: p.status,
    label: p.label,
    table: p.table,
    operation: p.operation,
    result: p.result,
    created_at: p.created_at,
    decided_at: p.decided_at,
  });
}

// 把结果序列化成回填文本（沿用本地 AI 工具的截断口径，防止撑爆上下文）
function toContent(result) {
  return toolResultContent(result);
}

module.exports = {
  listTables,
  readTable,
  readDoc,
  search,
  proposeWrite,
  getProposalResult,
  toContent,
  MAX_ROWS,
};
