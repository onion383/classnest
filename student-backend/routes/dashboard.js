// =========================================================================
// dashboard.js —— 首屏聚合接口
//
// 把首页需要的 9 份数据合并成 1 次请求（1 次 HTTP + 1 次加解密），替代原来
// 前端并发拉 9 个接口（/api/schedule、/api/duty、/api/countdowns、/api/leaves、
// /api/students、/api/scores、/api/activities、/api/fee-records、/api/album）。
//
// 各读函数复用对应路由/服务的既有实现，返回值形状与前端 useDashboardData 期望一致：
//   { schedule:{cells,settings}, duty:{cells,settings},
//     countdowns:[], leaves:[], students:[{id,姓名}], activities:[], album:[],
//     summary:{ studentCount, scoreCount, feeCount, topScores:[], feeBalance, monthIncome, monthExpense } }
// 注：v6 · 2-1 起不再下发全量 scores / fees（首页只用聚合值），students 也瘦成 id+姓名；
// 全量数据由各自页面按需拉取。9 个旧接口全部保留，本接口只服务首屏。
// =========================================================================

const express = require('express');
const router = express.Router();
const { localDateStr } = require('../utils/date');

// 单项读取：任一域出错只回退空值，保证聚合接口永不 500。
function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// 首页真正消费的只有几个聚合值（v6 · 2-1 实测）：
//   · scores 是体积大头 —— 真实班级一学期 1000 行约 326KB，占整包 91%，而首页只显示「今日加分 Top4」；
//   · fees 只用余额 / 本月收入 / 本月支出；
//   · students 只用人数与值日展示的 id→姓名。
// 全量记录仍由 /api/scores、/api/fee-records、/api/students 按需拉。
// 口径与改造前 DashboardView 的三个 computed 逐行对齐（顺序、正负、月份前缀都不改）。
function buildSummary({ students, scoreAgg, fees, today }) {
  // 今日 Top4 由 SQL 直接算（COUNT + 前缀 LIKE + 数值降序 + LIMIT 4），
  // 不再把整张成绩表读进内存再 filter/sort/slice（v6 · 2-23）。
  const topScores = ((scoreAgg && scoreAgg.top) || []).map((s) => {
    // 区分个人加分（学生）与小组加分（小组名），扣分统一转成负数展示
    const name = s['姓名'] || s.group_name || '未知';
    const score = Number(s['分值'] || 0);
    return { name, score: s['类型'] === '扣分' ? -score : score };
  });

  const monthPrefix = today.slice(0, 7); // YYYY-MM，与前端 pad2(month) 同一口径
  let feeBalance = 0;
  let monthIncome = 0;
  let monthExpense = 0;
  for (const r of fees) {
    const amount = Number((r && r['收支金额']) || 0);
    const isExpense = String((r && r['收支类型']) || '').trim() === '支出';
    feeBalance += isExpense ? -Math.abs(amount) : Math.abs(amount);
    if (String((r && r['收支时间']) || '').startsWith(monthPrefix)) {
      if (isExpense) monthExpense += Math.abs(amount);
      else monthIncome += Math.abs(amount);
    }
  }

  return {
    studentCount: students.length,
    // 仅用于「有没有记录」的按钮文案与探针回读，不含任何明细
    scoreCount: (scoreAgg && scoreAgg.count) || 0,
    feeCount: fees.length,
    topScores,
    feeBalance,
    monthIncome,
    monthExpense,
  };
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
  // 成绩只用聚合（条数 + 今日 Top4），不再整表读入内存（v6 · 2-23）
  const today = localDateStr();
  const scoreAgg = read('scores', () => require('./scores').dashboardSummary(today), { count: 0, top: [] });
  const activities = read('activities', () => require('./activities').readAll(), []);
  const album = read('album', () => require('./album').readAlbums(), []);
  // students / fee_records 由动态表路由服务（在 app.js 内联创建），直接复用其查询实现取行数组。
  const { queryAll } = require('../services/tableService');
  const students = read('students', () => queryAll('students').data, []);
  const fees = read('fees', () => queryAll('fee_records').data, []);

  // 摘要化（v6 · 2-1）：整包从「全量 students/scores/fees」收敛到聚合值 + 轻量名册。
  // 名册只留 id/姓名 —— 首页值日卡片要按 id 显示姓名，其余字段（电话/备注等）一律不下发。
  const summary = buildSummary({ students, scoreAgg, fees, today });
  const studentsLite = students.map((s) => ({ id: s.id, 姓名: s['姓名'] }));
  const payload = { schedule, duty, countdowns, leaves, students: studentsLite, activities, album, summary };

  res.json(payload);

  if (!bootTimed) {
    bootTimed = true;
    try {
      // 响应体积口径（v6 · 2-1 前置）：只在 PERF_STARTUP=1 时多序列化一次拿字节数，
      // 默认路径零开销。体积是「摘要化是否有效」的判据（改前 358.8KB / 1000 条加分）。
      let size = '';
      if (process.env.PERF_STARTUP === '1') {
        try {
          const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
          const n = (v) => (Array.isArray(v) ? v.length : 0);
          size = `，响应 ${(bytes / 1024).toFixed(1)}KB（students ${n(studentsLite)} / scores ${summary.scoreCount} / fees ${summary.feeCount} / leaves ${n(leaves)} / activities ${n(activities)} / album ${n(album)}）`;
        } catch (_) { /* 只影响打点 */ }
      }
      console.log(`[boot] dashboard 首屏聚合 ${Date.now() - _t0}ms（进入 ${_t0}）: ${_seg.join(' / ')}${size}`);
    } catch (_) { /* 日志失败不影响响应 */ }
  }
});

module.exports = router;
