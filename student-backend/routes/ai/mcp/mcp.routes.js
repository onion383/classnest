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
const mcpProposalExec = require('../../../services/mcpProposalExec');

const router = express.Router();

// 当前请求的 dbSlug（与 ai.dataRoutes 的 currentSlug 同口径）
function slug(req) {
  return (req.user && req.user.dbSlug) || 'default';
}
function inDb(req, fn) {
  return dbManager.withDb(slug(req), fn);
}

// ---- 提案 ----
router.get('/proposals', (req, res) => {
  try {
    res.json({ proposals: inDb(req, () => proposals.list({ status: req.query.status, limit: req.query.limit })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/proposals/:id', (req, res) => {
  try {
    const p = inDb(req, () => proposals.get(req.params.id));
    if (!p) return res.status(404).json({ error: '提案不存在' });
    res.json(p);
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

// ---- token 管理 ----
// 生成 token 时明文只回这一次；前端展示后即丢弃（只存 hash）。
router.post('/tokens', (req, res) => {
  try {
    const label = (req.body && req.body.label) || '';
    const created = tokenStore.create({ slug: slug(req), label });
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

router.post('/tokens/:id/revoke', (req, res) => {
  try {
    const ok = tokenStore.revoke(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
