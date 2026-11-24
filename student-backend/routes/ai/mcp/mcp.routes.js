// =========================================================================
// mcp.routes.js —— 方向 B 的班集侧管理接口（需登录）
//
// 提供：① 列出/处理外部写提案（老师确认入口）；② MCP token 的生成/撤销（供
// Claude Desktop / Cursor 配置）。都是教师身份操作，走 auth(['teacher'])。
// 这些路由挂在 /api/mcp 下，与 /mcp（外部客户端的 Streamable HTTP 端点）分开。
// =========================================================================

const express = require('express');
const dbManager = require('../../../dbManager/dbManager');
const tokenStore = require('../../../services/mcpTokenStore');
const proposals = require('../../../services/mcpProposalStore');
const proposalView = require('../../../services/mcpProposalView');
const mcpProposalExec = require('../../../services/mcpProposalExec');
const aiConfigStore = require('../../../services/aiConfigStore');
const { privacy } = require('../../../services/aiPrivacy');
const { normalizePrivacyPatch, privacyTables, setTableLevel } = require('../privacy.shared');

const router = express.Router();

// 当前请求的 dbSlug（与 ai.dataRoutes 的 currentSlug 同口径）
function slug(req) {
  return (req.user && req.user.dbSlug) || 'default';
}
function inDb(req, fn) {
  return dbManager.withDb(slug(req), fn);
}

// ---- 数据权限（MCP 独立一份）----
// 存 ai_settings.mcp_privacy_json，与 AI 助手那份（privacy_json）互不影响：
// 给外部客户端收紧一张表，不该连带把老师自己的助手锁住。
// 读写语义（字段白名单 / 表清单 / 单表改档）与 AI 侧共用 privacy.shared.js。
const mcpPrivacyIO = { read: () => aiConfigStore.readMcpPrivacy(), set: (p) => aiConfigStore.setMcpPrivacy(p) };

router.get('/privacy', (req, res) => {
  try {
    const cur = inDb(req, () => aiConfigStore.readMcpPrivacy());
    res.json({ success: true, data: { ...cur, tables: privacyTables(cur) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/privacy', (req, res) => {
  try {
    // 单表改档：{ table, level }，与四个布尔开关互斥（一次请求不混两种语义）
    if (req.body && req.body.table !== undefined) {
      const r = inDb(req, () => setTableLevel(req.body.table, req.body.level, mcpPrivacyIO));
      if (r && r.error) return res.status(400).json({ error: r.error });
      try { privacy.invalidate(); } catch (_) { /* 缓存清理失败不阻断设置保存 */ }
      return res.json({ success: true, data: { ...r, tables: privacyTables(r) }, message: '已保存' });
    }
    const next = inDb(req, () => aiConfigStore.setMcpPrivacy(normalizePrivacyPatch(req.body)));
    try { privacy.invalidate(); } catch (_) { /* 缓存清理失败不阻断设置保存 */ }
    res.json({ success: true, data: { ...next, tables: privacyTables(next) }, message: '已保存' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 提案 ----
// 列表带「人读视图」：中文表名 + 每条操作改哪个字段、改前改后。
// 不带之前界面只能显示 students · update_row，老师没法判断该不该确认。
// 列表：status=pending 给「未处理」，status=done 是界面用的聚合值（四种已定稿合并）。
// 已处理用 describeDone：那份视图不回读当前行——执行后行已是新值，重算 diff 会得到空白。
router.get('/proposals', (req, res) => {
  try {
    const raw = String(req.query.status || '');
    const isDone = raw === 'done';
    const rows = inDb(req, () => proposals.list({
      status: isDone ? proposals.DONE_STATUSES : (raw || undefined),
      limit: req.query.limit,
      withPayload: true,
    }));
    const view = isDone ? proposalView.describeDone : proposalView.describe;
    res.json({ proposals: rows.map((p) => view(p)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 提案的保留设置（只作用于「已处理」）。未处理的不受这个数字影响。
router.get('/prefs', (req, res) => {
  try { res.json(inDb(req, () => aiConfigStore.readMcpPrefs())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/prefs', (req, res) => {
  try {
    const next = inDb(req, () => aiConfigStore.setMcpPrefs(req.body || {}));
    // 改小后立刻生效：不能等下一次提案进来才裁，否则界面还显示着旧条数。
    const removed = inDb(req, () => proposals.trimDone(next.proposal_keep));
    res.json({ ...next, removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 老师确认/拒绝：confirm 复用既有写入链路（单事务），状态抢占保证幂等
router.post('/proposals/:id/decide', (req, res) => {
  try {
    const decision = String((req.body && req.body.decision) || '');
    if (!['confirm', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision 必须是 confirm 或 reject' });
    const result = inDb(req, () => mcpProposalExec.confirm(req.params.id, decision));
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 启用开关 ----
// MCP 服务 opt-in，默认关闭 /mcp 端点。状态存在本班 ai_settings，随库备份恢复。
router.get('/enabled', (req, res) => {
  try {
    res.json({ enabled: inDb(req, () => aiConfigStore.readMcpEnabled()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/enabled', (req, res) => {
  try {
    const on = !!(req.body && req.body.enabled);
    inDb(req, () => aiConfigStore.setMcpEnabled(on));
    res.json({ enabled: on });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- token 管理 ----
// 生成 token 时明文只回这一次；前端展示后即丢弃（只存 hash）。
router.post('/tokens', (req, res) => {
  try {
    const label = (req.body && req.body.label) || '';
    // 有效期只认界面那五档；非法/缺省交给 store 兜成「不过期」，老客户端行为不变。
    const validDays = req.body && req.body.validDays;
    const created = tokenStore.create({ slug: slug(req), label, validDays });
    res.json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/tokens', (req, res) => {
  try {
    // 只列当前 slug 的 token：tokenStore.list 不按 slug 过滤，这里在应用侧筛一遍。
    const all = tokenStore.list();
    res.json({ tokens: all.filter((t) => t.slug === slug(req)), endpoint: '/mcp' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 复制令牌：按需从班级库读明文副本（core 索引只存 hash，鉴权不开库）。
// 只回当前 slug 的、未撤销的令牌；跨 slug 的 id 一律返回 null，绝不明文外泄。
router.get('/tokens/:id/plain', (req, res) => {
  try {
    const plain = tokenStore.getPlain(req.params.id, slug(req));
    if (!plain) return res.status(404).json({ error: '令牌不存在、已撤销，或没有可复制的明文（旧令牌）' });
    res.json({ token: plain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tokens/:id/revoke', (req, res) => {
  try {
    // 带当前 slug：只能撤销自己班的令牌，不能跨班越权（与 getPlain 同口径）。
    const ok = tokenStore.revoke(req.params.id, slug(req));
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 去除记录：从 core 索引里彻底删掉这条令牌（只接受已撤销/已过期的，有效令牌拒绝）。
// 与 revoke 区别：revoke 留条目显示「已失效」，remove 让列表里不再有这一行。
router.post('/tokens/:id/remove', (req, res) => {
  try {
    // 带当前 slug：只能删自己班的令牌。
    const ok = tokenStore.remove(req.params.id, slug(req));
    if (!ok) return res.status(404).json({ error: '令牌不存在，或该令牌仍有效（请先删除配置使其失效）' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
