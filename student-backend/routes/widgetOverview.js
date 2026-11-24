// =========================================================================
// widgetOverview.js —— 桌面挂件概览（v8 · P3-14）
//
// 挂件每轮原来并发拉 5 份文档（课表/值日/倒计时/请假/学生），其中只用到摘要，
// 学生表还整份下发。这里合成单条响应；名册用 dashboardAgg.studentsLite（id/姓名）。
// 只回挂件真正消费的 5 项；主页面仍走各自原端点，语义不变。
// =========================================================================
const express = require('express');
const router = express.Router();
const { studentsLite } = require('../services/dashboardAgg');

// 单个读取失败只影响自己那一项：挂件其余卡片照常显示（与原来 5 个 .catch 兜底同口径）
function read(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// GET /api/widget-overview —— { schedule, duty, countdowns, leaves, students }
router.get('/', (req, res) => {
  res.json({
    schedule: read(() => require('./schedule').readSchedule(), { cells: [], settings: {} }),
    duty: read(() => require('./duty').readDuty(), { cells: {}, settings: {} }),
    countdowns: read(() => require('./countdowns').readAll(), []),
    leaves: read(() => require('./leaves').listOrders(), []),
    students: read(() => studentsLite(), []),
  });
});

module.exports = router;
