// =========================================================================
// dashboard.js —— 首屏聚合接口
//
// 把首页需要的 9 份数据合并成 1 次请求（1 次 HTTP + 1 次加解密），替代原来
// 前端并发拉 9 个接口（/api/schedule、/api/duty、/api/countdowns、/api/leaves、
// /api/students、/api/scores、/api/activities、/api/fee-records、/api/album）。
//
// 各读函数复用对应路由/服务的既有实现，返回值形状与前端 useDashboardData 期望一致：
//   { schedule:{cells,settings}, duty:{cells,settings},
//     countdowns:[], leaves:[], students:[], scores:[], activities:[], fees:[], album:[] }
// 9 个旧接口全部保留，本接口只服务首屏。
// =========================================================================

const express = require('express');
const router = express.Router();

// 单项读取：任一域出错只回退空值，保证聚合接口永不 500。
function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// 启动归因：**第一次**请求的分段耗时。后续请求各段都走缓存热路径，打出来只是噪音。
// 计时用 Date.now() 绝对值，可与渲染层 [startup] 打点（epoch 毫秒）直接对齐 —— 两者同机同时钟。
let bootTimed = false;

// GET /api/dashboard
router.get('/', (req, res) => {
  const _t0 = Date.now();
  const _seg = [];
  // 分段读取：失败回退空值（语义同 safe），并记录本段耗时。
  // 第一段（schedule）包含首次打开业务库的冷成本（openFile + initSchema），
  // 其余各段直接命中连接缓存 —— 两者混在一起就分不清「冷开库」和「查询慢」。
  const read = (name, fn, fallback) => {
    const t = Date.now();
    const v = safe(fn, fallback);
    if (!bootTimed) _seg.push(`${name} ${Date.now() - t}ms`);
    return v;
  };

  // 读函数在 handler 内 require：路由本身已在 app.js 的 listen 之前挂好，
  // 但业务路由模块由启动期的「让路链」逐个加载。命中已加载的模块时取缓存、
  // 不额外增加成本；个别模块还没轮到时，这里会同步加载它（Node 模块缓存保证
  // 与链里的 require 不会重复加载），首屏只是把该付的 require 成本提前付掉。
  const schedule = read('schedule', () => require('./schedule').readSchedule(), { cells: [], settings: {} });
  const duty = read('duty', () => require('./duty').readDuty(), { cells: {}, settings: {} });
  const countdowns = read('countdowns', () => require('./countdowns').readAll(), []);
  const leaves = read('leaves', () => require('./leaves').listOrders(), []);
  const scores = read('scores', () => require('./scores').readAll(), []);
  const activities = read('activities', () => require('./activities').readAll(), []);
  const album = read('album', () => require('./album').readAlbums(), []);
  // students / fee_records 由动态表路由服务（在 app.js 内联创建），直接复用其查询实现取行数组。
  const { queryAll } = require('../services/tableService');
  const students = read('students', () => queryAll('students').data, []);
  const fees = read('fees', () => queryAll('fee_records').data, []);

  res.json({ schedule, duty, countdowns, leaves, students, scores, activities, fees, album });

  if (!bootTimed) {
    bootTimed = true;
    try {
      console.log(`[boot] dashboard 首屏聚合 ${Date.now() - _t0}ms（进入 ${_t0}）: ${_seg.join(' / ')}`);
    } catch (_) { /* 日志失败不影响响应 */ }
  }
});

module.exports = router;
