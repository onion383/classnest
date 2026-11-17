// =========================================================================
// mcpProposalExec.js —— 执行已确认的 MCP 写提案（方向 B）
//
// 与 routes/ai/ai.dataRoutes.js 的 apply-batch「行式表」分支同构，复用同一组
// service 原语（aiStore / sanitizeField / validateRow），SQL 只在 store 里。
// 首版只放行「行式表」增删改（WRITE_TABLES 白名单）；整块 JSON 表（课表/座位/值日）
// 的写入涉及快照与几何联动，暂不通过 MCP 暴露——需要时再按 ai.dataRoutes 的 doc 分支补。
//
// 调用方必须已在 dbManager.withDb(slug, ...) 内。执行与状态抢占在同一调用中完成，
// 由 mcpProposalStore.decide 的「仅 pending 可改」保证幂等。
// =========================================================================

const { db } = require('../db');
const aiStore = require('./aiStore');
const { sanitizeField } = require('./sanitize');
const { validateRow } = require('./businessRules');
const { getFields } = require('../db');
const { WRITE_TABLES } = require('../routes/ai/ai.constants');
const proposals = require('./mcpProposalStore');

function colType(table, col) {
  const meta = getFields(table) || [];
  const f = meta.find((x) => x.name === col);
  return f && f.type ? f.type : '文字';
}

function serializeVal(v) {
  if (v != null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// 执行一条行式写操作。返回 { ok, ... } 或 { error }，不抛。
function runRowOp(op) {
  const table = String((op && op.table) || '');
  if (!Object.prototype.hasOwnProperty.call(WRITE_TABLES, table)) {
    return { error: `该表不支持通过 MCP 写入：${table || '未指定'}` };
  }
  const action = String((op && op.operation) || '');
  const cols = aiStore.tableColumns(table);
  const data = op.data && typeof op.data === 'object' && !Array.isArray(op.data) ? op.data : {};

  if (action === 'add') {
    const row = {};
    for (const k of Object.keys(data)) {
      if (k === 'id' || !cols.includes(k)) continue;
      row[k] = sanitizeField(data[k], table, k, colType(table, k));
    }
    const keys = Object.keys(row);
    if (!keys.length) return { error: '新增缺少可写字段' };
    if (cols.includes('position') && row.position === undefined) row.position = aiStore.maxPosition(table) + 1;
    try {
      validateRow(table, row);
    } catch (e) { return { error: e.message }; }
    const info = aiStore.insertRow(table, keys, keys.map((k) => serializeVal(row[k])));
    return { ok: true, action: 'add', table, id: Number(info.lastInsertRowid) };
  }

  const id = Number(op.id);
  if (!Number.isInteger(id) || id <= 0) return { error: `记录 id 无效：${op.id == null ? '' : op.id}` };
  const existing = aiStore.findRow(table, id);
  if (!existing) return { error: `表中没有 id=${id} 的行` };

  if (action === 'update') {
    const changes = {};
    for (const k of Object.keys(data)) {
      if (k === 'id' || !cols.includes(k) || data[k] === undefined) continue;
      changes[k] = sanitizeField(data[k], table, k, colType(table, k));
    }
    const keys = Object.keys(changes);
    if (!keys.length) return { error: '修改缺少可写字段' };
    try {
      validateRow(table, changes, existing);
    } catch (e) { return { error: e.message }; }
    const before = {};
    keys.forEach((k) => { before[k] = existing[k]; });
    aiStore.updateColumns(table, id, keys, keys.map((k) => serializeVal(changes[k])));
    return { ok: true, action: 'update', table, id, before, after: changes };
  }

  if (action === 'delete') {
    try {
      validateRow(table, {}, existing);
    } catch (e) { return { error: e.message }; }
    aiStore.deleteRow(table, id);
    return { ok: true, action: 'delete', table, id, deleted: existing };
  }

  return { error: `不支持的操作：${action}` };
}

// 确认执行：抢占状态 → 单事务执行 → 写回结果。
// 返回 { ok, status, result } 或 { ok:false, error }。
function confirm(proposalId, decision) {
  const p = proposals.get(proposalId);
  if (!p) return { ok: false, error: '提案不存在' };
  if (p.status !== 'pending') return { ok: false, error: `提案当前状态为 ${p.status}，无法再处理` };

  if (decision === 'reject') {
    proposals.decide(proposalId, 'rejected', { message: '用户拒绝' });
    return { ok: true, status: 'rejected', result: { message: '用户拒绝' } };
  }
  if (decision !== 'confirm') return { ok: false, error: '无效的决议' };

  let result;
  try {
    result = db.transaction(() => {
      if (p.kind !== 'row_write') return { error: `暂不支持执行此提案类型：${p.kind}` };
      const op = { table: p.table, operation: p.operation, ...(p.payload || {}) };
      return runRowOp(op);
    })();
  } catch (e) {
    result = { error: e.message };
  }

  const status = result && result.ok ? 'confirmed' : 'failed';
  proposals.decide(proposalId, status, result);
  return { ok: true, status, result };
}

module.exports = { confirm, runRowOp };
