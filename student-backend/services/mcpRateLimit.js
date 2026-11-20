// =========================================================================
// mcpRateLimit.js —— MCP 工具调用的频率闸门（方向 B）
//
// 为什么要有：写操作唯一的闸门是老师那一下确认。AI 跑飞、客户端被脚本批量驱动时，
// 一分钟能堆几百条待确认，老师只能闭眼点——技术防线没破，人的注意力先崩。
// 读侧同理但弱一档：访问记录只留 500 条（accessLogStore.KEEP，先进先出），
// 无限读会把「谁读过什么」的痕迹挤掉。限流挡不住冲刷，但能让冲刷变慢、变得可观察。
//
// 口径（改数字只改这张表，文案里的数字跟着变）：
//   read   160 次/分钟 —— 一次「把全班过一遍」约 20~25 次读，留 5 倍余量
//   search  60 次/分钟 —— LIKE '%词%' 跨表扫，最贵的读；正常一次对话 2~5 次
//   write   10 条/分钟 —— 批量导入 50 人只算 1 条（propose_batch），正常碰不到
//   write 另有积压上限 30 条 —— 只限速率挡不住「每分钟 9 条刷一小时」；
//     老师不清理，新的就进不来，这才是有意义的那道闸。
//
// 刻意不做成用户可配：这是护栏不是偏好。用户没有判断依据，调低会把自己坑住
// （批量导入试错两次就撞墙），而「0 = 关闭」等于自己开个洞。要放宽直接改这张表。
//
// 分桶：按 slug + kind 各一个 60 秒固定窗口。不同班级库互不牵连；固定窗口在
// 跨窗口边界最坏会放过 2 倍流量，对本地单用户够用，也就不用引入滑动窗口的记账成本。
// =========================================================================

const proposals = require('./mcpProposalStore');

const WINDOW_MS = 60 * 1000;

const DEFAULT_LIMITS = {
  read: { perMin: 160, label: '读取' },
  search: { perMin: 60, label: '搜索' },
  write: { perMin: 10, pendingMax: 30, label: '提案提交' },
};

let limits = DEFAULT_LIMITS;
// key: `${slug}:${kind}` → { start, count }
const buckets = new Map();

function bucketOf(slug, kind, now) {
  const key = `${slug}:${kind}`;
  const cur = buckets.get(key);
  if (cur && now - cur.start < WINDOW_MS) return cur;
  const fresh = { start: now, count: 0 };
  buckets.set(key, fresh);
  return fresh;
}

// 桶只在请求时惰性重建，长期不来的 slug 会留在 Map 里；班级数量有限，
// 但换库/测试反复建会积累，所以超过阈值时顺手清一遍过期项。
function prune(now) {
  if (buckets.size < 200) return;
  for (const [k, b] of buckets) if (now - b.start >= WINDOW_MS) buckets.delete(k);
}

// 只读判断，不计数：超限的请求不该占额度，否则「被拒」也把自己越推越远。
function check(slug, kind, now = Date.now()) {
  if (!kind) return { ok: true };
  const lim = limits[kind];
  if (!lim) return { ok: true };
  prune(now);
  const b = bucketOf(slug, kind, now);
  if (b.count >= lim.perMin) {
    const retryAfter = Math.max(1, Math.ceil((b.start + WINDOW_MS - now) / 1000));
    return {
      ok: false,
      retryAfter,
      error: `${lim.label}过于频繁（每分钟最多 ${lim.perMin} 次），请 ${retryAfter} 秒后再试`,
    };
  }
  if (kind === 'write' && lim.pendingMax) {
    // 只数 24 小时内的 pending：list() 不触发 store 的惰性过期，
    // 直接数 status='pending' 会让早该过期的僵尸提案一直占着额度。
    const since = new Date(now - proposals.MAX_AGE_MS).toISOString();
    const pending = proposals.countPendingSince(since);
    if (pending >= lim.pendingMax) {
      return {
        ok: false,
        retryAfter: 60,
        error: `老师还有 ${pending} 条提案待确认（上限 ${lim.pendingMax} 条），请等老师处理后再提交，不要立即重试`,
      };
    }
  }
  return { ok: true };
}

// 计入额度。读/搜索无论成败都算（它确实查了库）；写只算真的建出提案的，
// 参数错被拒的不占额度 —— 否则 AI 改两遍字段名就把自己锁死了。
function consume(slug, kind, now = Date.now()) {
  if (!kind || !limits[kind]) return;
  bucketOf(slug, kind, now).count += 1;
}

module.exports = {
  check,
  consume,
  WINDOW_MS,
  limits: () => limits,
  _resetForTest: () => { buckets.clear(); limits = DEFAULT_LIMITS; },
  _setLimitsForTest: (next) => { limits = { ...DEFAULT_LIMITS, ...next }; },
};
