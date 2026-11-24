// =========================================================================
// accessTimeline.js —— 「访问记录」弹窗的合并视图：读 + 写
//
// 为什么在**读侧合并**、而不把写也抄进 access_log：
//   写入的权威记录本来就有两处，而且各自解决不同问题：
//     · 已执行的写 → undo_history（带前后值与回退入口，「设置 → 更改审查」就是它）
//     · 未执行的写 → mcp_proposals（外部客户端的待确认提案）
//   再往 access_log 里抄一份，等于同一件事存三遍，第三次改口径时必然对不上。
//   所以这里只做「拼装」，一行新数据都不落。
//
// 仍然是各看各的：
//   source='ai'  → 读 access_log(ai) + 写 undo_history(source='ai_assistant')
//   source='mcp' → 读 access_log(mcp) + 写 undo_history(source='mcp') + 待确认提案
//
// 折叠口径：undo_history 里同一「步动作」会产生多条记录（共享 origin），
// 这里按 origin 折成一 行，条数放进 count —— 否则一次批量导入 40 个学生会刷 40 行。
// 「只要有任意一条还生效，这一步就算还生效」（回退是整批的），与更改审查同口径。
// =========================================================================

const accessLog = require('./accessLogStore');
const undoStore = require('./undoStore');
const proposals = require('./mcpProposalStore');

const UNDO_SOURCE = { ai: 'ai_assistant', mcp: 'mcp' };
const DAY_MS = 24 * 60 * 60 * 1000;

// 已执行的写入：按 origin 折叠成「一步」。
// 过滤（来源 / 时间窗 / 条数）全部下推到 SQL，不再每次展开弹窗都整表读 undo_history。
function writeSteps(source, { since = '', limit = 1000 } = {}) {
  const want = UNDO_SOURCE[source];
  if (!want) return [];
  const rows = undoStore.listForAccess(want, { since, limit });
  const map = new Map();
  for (const r of rows) {
    const k = r.origin ? `o:${r.origin}` : `i:${r.id}`;
    let cur = map.get(k);
    if (!cur) {
      cur = { key: r.key, lastId: r.id, label: r.label || '', ts: r.ts, dir: 1, count: 0 };
      map.set(k, cur);
    }
    cur.count += 1;
    cur.lastId = Math.max(cur.lastId, r.id);
    cur.dir = Math.min(cur.dir, Number(r.dir) === 0 ? 0 : 1);
    if (r.ts && (!cur.ts || r.ts < cur.ts)) cur.ts = r.ts;
    if (!cur.label && r.label) cur.label = r.label;
  }
  return [...map.values()].map((w) => ({
    kind: 'write',
    id: `w:${w.lastId}`,
    at: w.ts,
    actor: '',
    tool: 'write',
    target: w.key,
    detail: w.label,
    amount: w.count,
    count: w.count,
    result: w.dir === 1 ? 'ok' : 'undone',
    reason: '',
  }));
}

// 还没执行的写入（只有 MCP 有这个概念）：提案被确认/拒绝后就不再是 pending，
// 转而出现在上面的 undo_history 里，所以两边不会同一条重复显示。
function pendingProposals(source) {
  if (source !== 'mcp') return [];
  return proposals.list({ status: 'pending', limit: 100 }).map((p) => ({
    kind: 'proposal',
    id: `p:${p.proposal_id}`,
    at: p.created_at,
    actor: p.requested_by || '',
    tool: 'proposal',
    target: p.table,
    detail: p.label || '',
    amount: 0,
    count: 1,
    result: 'pending',
    reason: '',
  }));
}

function sortDesc(list) {
  return list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// 列表：读 + 写合成一条时间线，最新在前。
// onlyAbnormal 只留「被拒 / 失败」——待确认不是异常，撤销也只是结果的一种，都不进这个筛选。
function list({ source, onlyAbnormal = false, limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));
  // 异常筛选下推到 SQL：在内存里筛只能筛这 500 条窗口内的，窗口外更旧的拒绝/失败
  // 永远进不了「仅看被拒与失败」视图。合成行（写 / 提案）也照样过一遍同一个条件，
  // 它们目前没有 denied/failed，但别把口径分开写两份。
  const reads = accessLog.list({ source, onlyAbnormal, limit: 500 });
  const readLogs = reads.logs.map((r) => ({ ...r, kind: 'read' }));
  const synthetic = [...writeSteps(source), ...pendingProposals(source)]
    .filter((r) => !onlyAbnormal || r.result === 'denied' || r.result === 'failed');
  const all = sortDesc([...readLogs, ...synthetic]);
  return {
    // total 原先取的是「截断后的内存数组长度」：读侧只拉了 500 条、per_day 还会合并，
    // 超过 500 条就以 500 封顶。改用 SQL 的 COUNT，前端「已记 N 条」才是真数。
    total: reads.total + synthetic.length,
    // 保留条数（keep）是全局的：AI 与 MCP 共用一张 access_log、共用一份设置，
    // 而弹窗只看当前来源。改小 keep 时真正被删的是全表超限部分，所以前端确认框
    // 必须按这个数判断，不能按本来源视图的 total（审查 v7 · #33）。
    retentionTotal: accessLog.list({ limit: 1 }).total,
    logs: all.slice(0, cap),
  };
}

// 摘要：面板行尾那一句。reads 与 writes 分开报，被拒单列（权限生效的证据）。
function summary({ source, days = 7 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 7));
  const since = new Date(Date.now() - d * DAY_MS).toISOString();
  const base = accessLog.summary({ source, days: d });
  const writes = writeSteps(source, { since }).length;
  const pending = pendingProposals(source).length;
  return { ...base, writes, pending };
}

module.exports = { list, summary };
