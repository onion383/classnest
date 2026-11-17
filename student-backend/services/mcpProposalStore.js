// =========================================================================
// mcpProposalStore.js —— MCP 外部写提案的持久层（方向 B）
//
// 调用方必须已在 dbManager.withDb(slug, ...) 上下文内——本模块用 db Proxy，
// 与 aiStore / slotStore 同一口径，SQL 只在这里出现，路由不碰 db.prepare。
//
// 提案只存「意图」（表/操作/payload），真正的写入由 confirm 服务复用既有链路完成。
// =========================================================================

const crypto = require('crypto');
const { db } = require('../db');
const { safeJson } = require('../utils/json');

// 提案最长保留时长：超过的 pending 视为过期，confirm 时拒绝执行。
// 外部 AI 可能隔很久才回来取结果，不能让一条陈旧的写意图无限期悬着。
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function create({ kind, label, table, operation, payload, requestedBy }) {
  const proposalId = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  db.prepare(`INSERT INTO mcp_proposals
    (proposal_id, kind, label, table_name, operation, payload, requested_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(
      proposalId,
      String(kind || 'row_write').slice(0, 40),
      String(label || '').slice(0, 200),
      String(table || '').slice(0, 60),
      String(operation || '').slice(0, 40),
      JSON.stringify(payload == null ? {} : payload),
      String(requestedBy || 'mcp').slice(0, 80),
      now.toISOString()
    );
  return proposalId;
}

// 只返回白名单列，不把 payload 里的 json 字符串暴露给不需要的调用方时可选 withPayload=false。
function get(proposalId, { withPayload = true } = {}) {
  const row = db.prepare('SELECT * FROM mcp_proposals WHERE proposal_id = ?').get(String(proposalId || ''));
  if (!row) return null;
  const out = {
    proposal_id: row.proposal_id,
    kind: row.kind,
    label: row.label,
    table: row.table_name,
    operation: row.operation,
    requested_by: row.requested_by,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    result: safeJson(row.result, null),
  };
  if (withPayload) out.payload = safeJson(row.payload, {});
  // 惰性过期：读取时若 pending 超过 24h，标记为 expired（不改变 payload，仅状态）
  if (row.status === 'pending' && Date.now() - Date.parse(row.created_at) > MAX_AGE_MS) {
    db.prepare(`UPDATE mcp_proposals SET status = 'expired', decided_at = ? WHERE proposal_id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), row.proposal_id);
    out.status = 'expired';
  }
  return out;
}

function list({ status, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = status
    ? db.prepare('SELECT proposal_id, kind, label, table_name, operation, status, created_at, decided_at FROM mcp_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(String(status), cap)
    : db.prepare('SELECT proposal_id, kind, label, table_name, operation, status, created_at, decided_at FROM mcp_proposals ORDER BY created_at DESC LIMIT ?').all(cap);
  return rows.map((r) => ({
    proposal_id: r.proposal_id,
    kind: r.kind,
    label: r.label,
    table: r.table_name,
    operation: r.operation,
    status: r.status,
    created_at: r.created_at,
    decided_at: r.decided_at,
  }));
}

// 仅当仍是 pending 才能改状态——防止「确认」和「拒绝」并发时双重执行。
// 返回是否成功抢占（true 表示本次调用真正改了状态）。
function decide(proposalId, status, result) {
  const decidedAt = new Date().toISOString();
  const r = db.prepare(`UPDATE mcp_proposals SET status = ?, result = ?, decided_at = ?
    WHERE proposal_id = ? AND status = 'pending'`)
    .run(String(status), result == null ? null : JSON.stringify(result), decidedAt, String(proposalId || ''));
  return r.changes > 0;
}

module.exports = { create, get, list, decide, MAX_AGE_MS };
