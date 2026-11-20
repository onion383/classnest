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
const { safeJson, packJson } = require('../utils/json');
const aiConfigStore = require('./aiConfigStore');

// 四种「已定稿」状态。界面把它们合并成一栏「已处理」，
// 但库里保留细分（失败和拒绝对排错意义完全不同）。
const DONE_STATUSES = ['confirmed', 'failed', 'rejected', 'expired'];

// 提案最长保留时长：超过的 pending 视为过期，confirm 时拒绝执行。
// 外部 AI 可能隔很久才回来取结果，不能让一条陈旧的写意图无限期悬着。
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// processing 是「已被某个确认请求抢占、正在执行」的中间态（见 claim）。
// 正常路径在同一事务内写入+定稿，不会停留；只有进程在事务中崩溃才会卡住。
// 卡死超过这个时长允许重新抢占——否则那条提案永远既不能确认也不能拒绝。
// 重抢是安全的：写入与定稿同事务，崩溃时整批回滚，不存在「写了一半」被重放。
const PROCESSING_STALE_MS = 10 * 60 * 1000;

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
      packJson(payload == null ? {} : payload, 'proposal_payload'),
      String(requestedBy || 'mcp').slice(0, 80),
      now.toISOString()
    );
  // 顺手裁剪「已处理」历史，保证这张表不会无限长。
  // 放在 create 而不是 settle：settle 在事务里，裁剪失败会连带把这次写入回滚；
  // 而裁剪本身是「可以不成功」的维护动作，不能影响业务。
  try { trimDone(aiConfigStore.readMcpPrefs().proposal_keep); } catch (_) { /* 忽略 */ }
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

// 列表：默认不带 payload（外部轮询用不到，省一次 JSON 解析）；
// 老师侧的待确认/已处理列表要 withPayload=true，好把「改哪一行」翻译出来。
// status 支持数组：界面把 confirmed/failed/rejected/expired 合成一栏「已处理」。
const LIST_COLS = 'proposal_id, kind, label, table_name, operation, status, created_at, decided_at';
function list({ status, limit = 50, withPayload = false } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const cols = withPayload ? '*' : LIST_COLS;
  const statuses = (Array.isArray(status) ? status : [status])
    .filter((s) => s != null && s !== '')
    .map((s) => String(s));
  let rows;
  if (statuses.length === 1) {
    rows = db.prepare(`SELECT ${cols} FROM mcp_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(statuses[0], cap);
  } else if (statuses.length > 1) {
    const ph = statuses.map(() => '?').join(',');
    rows = db.prepare(`SELECT ${cols} FROM mcp_proposals WHERE status IN (${ph}) ORDER BY created_at DESC LIMIT ?`)
      .all(...statuses, cap);
  } else {
    rows = db.prepare(`SELECT ${cols} FROM mcp_proposals ORDER BY created_at DESC LIMIT ?`).all(cap);
  }
  return rows.map((r) => {
    const out = {
      proposal_id: r.proposal_id,
      kind: r.kind,
      label: r.label,
      table: r.table_name,
      operation: r.operation,
      status: r.status,
      created_at: r.created_at,
      decided_at: r.decided_at,
    };
    if (withPayload) out.payload = safeJson(r.payload, {});
    return out;
  });
}

// 原子抢占：pending → processing，先抢到的人才有资格执行写入。
// 并发的第二次 confirm / reject 进来时状态已是 processing，拿不到锁 → 返回 false，
// 调用方据此回 409，杜绝「两人都读到 pending、两人都写一遍」。
// 卡死超过 PROCESSING_STALE_MS 的 processing 也允许重抢（进程崩溃兜底）。
function claim(proposalId, now = Date.now()) {
  const cutoff = new Date(now - PROCESSING_STALE_MS).toISOString();
  const r = db.prepare(`UPDATE mcp_proposals SET status = 'processing', decided_at = ?
    WHERE proposal_id = ? AND (status = 'pending' OR (status = 'processing' AND decided_at < ?))`)
    .run(new Date(now).toISOString(), String(proposalId || ''), cutoff);
  return r.changes > 0;
}

// 定稿：processing → 最终态（confirmed / failed / rejected）。
// mustHold='processing' 表示只认抢占者，防止没抢到锁的人误改。
function settle(proposalId, status, result, { mustHold = 'processing' } = {}) {
  const r = db.prepare(`UPDATE mcp_proposals SET status = ?, result = ?, decided_at = ?
    WHERE proposal_id = ? AND status = ?`)
    .run(String(status), result == null ? null : JSON.stringify(result), new Date().toISOString(),
      String(proposalId || ''), mustHold);
  return r.changes > 0;
}

// 兼容旧调用：一次性把 pending 改到最终态（没有抢占步骤）。
// 新的确认链路请用 claim + settle；这里仅为可能的外部直接调用保留。
function decide(proposalId, status, result) {
  return settle(proposalId, status, result, { mustHold: 'pending' });
}

// 待确认提案数（只数 MAX_AGE_MS 内的）。限流用它判断「老师的确认队列是不是已经堆满」。
// 不能直接数 status='pending'：get() 才有惰性过期，list() 不标记，早就该过期的
// 僵尸提案会一直占着额度，把老师卡在「明明没提案，AI 却提交不进来」的状态。
function countPendingSince(iso) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM mcp_proposals WHERE status = 'pending' AND created_at > ?`
  ).get(String(iso));
  return row ? row.n : 0;
}

// 裁剪「已处理」历史到 keep 条；pending / processing 永不参与。
// 理由是两者性质不同：已定稿的是记录（可以少留），未定稿的是老师还没决策的请求
// （少一条就等于凭空吞掉一次外部 AI 的写入意图，还会让 AI 以为提案丢了）。
// 返回删掉的行数，供接口回显；keep 非法时不动。
function trimDone(keep) {
  const n = Math.round(Number(keep));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ph = DONE_STATUSES.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM mcp_proposals
    WHERE status IN (${ph})
      AND proposal_id NOT IN (
        SELECT proposal_id FROM mcp_proposals
        WHERE status IN (${ph})
        ORDER BY COALESCE(decided_at, created_at) DESC
        LIMIT ?
      )`).run(...DONE_STATUSES, ...DONE_STATUSES, n);
  return r.changes;
}

module.exports = {
  create, get, list, claim, settle, decide, countPendingSince, trimDone,
  DONE_STATUSES, MAX_AGE_MS, PROCESSING_STALE_MS,
};
