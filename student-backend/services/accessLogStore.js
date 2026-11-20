// =========================================================================
// accessLogStore.js —— 数据访问记录的持久层（schema.log.js）
//
// 调用方必须已在 dbManager.withDb(slug, ...) 上下文内 —— 与 mcpProposalStore /
// aiStore 同一口径：SQL 只出现在 Store 里，路由与工具层不碰 db.prepare。
//
// 写入必须「不影响主流程」：记录是观测，不是业务。调用方一律 try/catch 包住，
// 库写失败不能让一次读表请求挂掉（宁可少一条记录）。
//
// 两个可调项都存在 ai_settings.log_json（aiConfigStore.readLogConfig）：
//   keep         保留条数，默认 500，界面可选；0 = 永久保留（不裁剪）
//   granularity  per_call 每次调用一条（默认）/ per_day 按天合并查看
// 裁剪用「先 COUNT 再删」：每条记录只多一次计数，不必每次都跑全表 DELETE 子查询。
// keep=0 时连这一步都跳过（永久模式不能有任何静默删除）。
// =========================================================================

const { db } = require('../db');
const aiConfigStore = require('./aiConfigStore');

const KEEP = aiConfigStore.LOG_DEFAULTS.keep;
const SOURCES = ['ai', 'mcp'];
const RESULTS = ['ok', 'denied', 'failed'];

function clip(v, n) {
  return String(v == null ? '' : v).slice(0, n);
}

// 卡片行尾那句「近 7 天 N 次 · M 次被拒」按天走：记录量不大，读一次配置足够。
function config() {
  try { return aiConfigStore.readLogConfig(); } catch (_) { return { keep: KEEP, granularity: 'per_call' }; }
}

function trim(keep) {
  // keep=0 是界面上的「永久」：不设上限，写入与改配置时都不裁。
  // 必须在 COUNT 之前 return —— 否则老逻辑会把 keep=0 当成「只留 0 条」全删光。
  if (!keep) return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM access_log').get().n;
  if (n <= keep) return;
  db.prepare(`DELETE FROM access_log WHERE log_id NOT IN (
    SELECT log_id FROM access_log ORDER BY log_id DESC LIMIT ?
  )`).run(keep);
}

// 记一条读操作。source/result 非法值一律兜底，不让脏值进库（前端按枚举渲染）。
// amount 是「量」的数值副本（行数 / 结果组数），按天合并时用它求和。
function record({
  source, actor = '', tool, target = '', detail = '', amount = 0, result = 'ok', reason = '',
} = {}) {
  const src = SOURCES.includes(source) ? source : 'ai';
  const res = RESULTS.includes(result) ? result : 'ok';
  const num = Number.isFinite(Number(amount)) ? Math.max(0, Math.round(Number(amount))) : 0;
  db.prepare(`INSERT INTO access_log
    (source, actor, tool, target, detail, amount, result, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(src, clip(actor, 80), clip(tool, 40) || 'unknown', clip(target, 120),
      clip(detail, 120), num, res, clip(reason, 200), new Date().toISOString());
  trim(config().keep);
}

function toOut(r) {
  return {
    id: r.log_id,
    source: r.source,
    actor: r.actor || '',
    tool: r.tool,
    target: r.target || '',
    detail: r.detail || '',
    amount: r.amount || 0,
    result: r.result,
    reason: r.reason || '',
    at: r.created_at,
  };
}

function buildWhere({ source, onlyAbnormal }) {
  const where = [];
  const args = [];
  if (SOURCES.includes(source)) { where.push('source = ?'); args.push(source); }
  if (onlyAbnormal) where.push("result <> 'ok'");
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

// 列表：最新在前。两个面板各自固定传自己的 source（AI 只看 ai、MCP 只看 mcp），
// 不传 source 才返回全部 —— 那个用法只留给未来的「合并查看」。
function list({ source, onlyAbnormal = false, limit = 100, offset = 0 } = {}) {
  const { sql: w, args } = buildWhere({ source, onlyAbnormal });
  const cap = Math.max(1, Math.min(5000, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM access_log ${w}`).get(...args).n;

  if (config().granularity === 'per_day') {
    // 按「天 + 工具 + 目标 + 结果」合并。date(..., 'localtime') 让「今天」跟着
    // 本地时区走，不然早上 8 点前读的记录会被算到前一天。
    const rows = db.prepare(`SELECT MIN(log_id) AS log_id, source, tool, target, result,
        COUNT(*) AS n, SUM(amount) AS amount, MAX(created_at) AS created_at, MAX(actor) AS actor
      FROM access_log ${w}
      GROUP BY source, tool, target, result, date(created_at, 'localtime')
      ORDER BY log_id DESC LIMIT ?`).all(...args, cap);
    return {
      total,
      granularity: 'per_day',
      logs: rows.map((r) => ({ ...toOut(r), count: r.n || 1, detail: '' })),
    };
  }

  const rows = db.prepare(`SELECT * FROM access_log ${w} ORDER BY log_id DESC LIMIT ? OFFSET ?`)
    .all(...args, cap, off);
  return { total, granularity: 'per_call', logs: rows.map((r) => ({ ...toOut(r), count: 1 })) };
}

// 摘要：面板行尾那一句「近 7 天 N 次 · M 次被拒」。
// denied 与 failed 分开算 —— 「被拒」是权限生效的证据，「失败」只是工具出错，
// 混成一个数字会让老师以为自己的设置被人绕过。
function summary({ source, days = 7 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 7));
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const where = ['created_at >= ?'];
  const args = [since];
  if (SOURCES.includes(source)) { where.push('source = ?'); args.push(source); }
  const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END) AS denied,
      SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM access_log WHERE ${where.join(' AND ')}`).get(...args);
  return { days: d, total: row.total || 0, denied: row.denied || 0, failed: row.failed || 0 };
}

// 改小保留条数后立即生效：否则用户把 500 改成 200 之后还要等下一次读取才看到裁剪，
// 以为设置没起作用（实际只是「下次写才裁」）。
function trimToKeep() {
  trim(config().keep);
}

// 清空：两个面板各自清自己的来源；不传 source 才清全部（接口层只放行带 source 的调用）。
function clear({ source } = {}) {
  if (SOURCES.includes(source)) {
    return db.prepare('DELETE FROM access_log WHERE source = ?').run(source).changes;
  }
  return db.prepare('DELETE FROM access_log').run().changes;
}

module.exports = { record, list, summary, clear, trimToKeep, KEEP, SOURCES };
