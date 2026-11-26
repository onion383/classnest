// =========================================================================
// accessLog.js —— 数据访问记录接口（/api/access-log）
//
// 两个面板各自只看自己的来源：
//   AI 数据保护（弹窗底部）   → ?source=ai
//   MCP 服务管理（第 4 行）   → ?source=mcp
// 「全部来源 + 写入回退」在设置 → 更改审查（/api/undo），不在这里重复一遍。
//
// 只做校验与 HTTP；SQL 全部在 services/accessLogStore。
// =========================================================================

const express = require('express');
const { sendError } = require('../utils/sendError')
const dbManager = require('../dbManager/dbManager');
const accessLog = require('../services/accessLogStore');
const timeline = require('../services/accessTimeline');
const aiConfigStore = require('../services/aiConfigStore');

const router = express.Router();

function slug(req) {
  return (req.user && req.user.dbSlug) || 'default';
}
function inDb(req, fn) {
  return dbManager.withDb(slug(req), fn);
}

// 列表 + 摘要 + 当前配置：一次请求给齐，面板行尾那句摘要和弹窗列表不用各拉一遍。
// 列表是「读 + 写」合并的时间线（services/accessTimeline）：读来自 access_log，
// 写来自 undo_history / 待确认提案 —— 权威记录各在一处，这里不复制。
router.get('/', (req, res) => {
  try {
    const source = accessLog.SOURCES.includes(req.query.source) ? req.query.source : '';
    const onlyAbnormal = req.query.onlyAbnormal === '1' || req.query.onlyAbnormal === 'true';
    const out = inDb(req, () => {
      const config = aiConfigStore.readLogConfig();
      return {
        ...timeline.list({
          source,
          onlyAbnormal,
          limit: req.query.limit,
        }),
        summary: timeline.summary({ source }),
        config,
        // 列表实际的呈现口径（per_call 逐条 / per_day 合并）——前端据此显示当前选择
        granularity: config.granularity,
      };
    });
    res.json(out);
  } catch (e) { sendError(res, e); }
});

// 记录设置：保留条数 + 查看粒度。两个面板共用一份（同一张表，规则不该两套）。
router.put('/config', (req, res) => {
  try {
    const body = req.body || {};
    const config = inDb(req, () => {
      const next = aiConfigStore.setLogConfig({
        keep: body.keep,
        granularity: body.granularity,
      });
      // 改小保留条数要立刻裁剪，不能等下一次读表才生效（用户会以为设置没起作用）
      if (body.keep != null) accessLog.trimToKeep();
      return next;
    });
    res.json({ config });
  } catch (e) { sendError(res, e); }
});

// 清空：必须带 source，避免一个面板顺手把另一个来源的记录也清了。
router.delete('/', (req, res) => {
  try {
    const source = accessLog.SOURCES.includes(req.query.source) ? req.query.source : '';
    if (!source) return res.status(400).json({ error: '必须指定 source（ai 或 mcp）' });
    const removed = inDb(req, () => accessLog.clear({ source }));
    res.json({ removed });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
