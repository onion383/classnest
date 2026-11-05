// =========================================================================
// dutyCycle.js —— 大扫除「周期 + 星期几」→ 命中日的唯一计算实现
//
// 规则（2026-11-05 与用户确认的设计）：
//   以**学期开始日所在周为第 1 周**（该周的周一 = 基准周一）。
//   命中条件 = 「星期几」对上 **且** 第 N 周符合周期：
//     一周   → 每周的该星期几都命中（第 1、2、3… 周）
//     两周   → 第 1、3、5… 周（隔周）
//     一个月 → 每 4 周（第 1、5、9… 周）
//
// 「一个月 = 4 周」是本项目定的口径：日历上「每月第几个星期三」没有唯一解，
// 而值日场景里「每月一次大扫除」一般就是每四周一次，误差一周可接受。
// 用固定周序还有一个好处：命中日永远落在固定的周序上，值日记录页按周切换才对得齐。
//
// 纯函数（不碰数据库）：基准周一由调用方算好后传进来，便于单测。
// =========================================================================

const { diffDays, localDateStr, mondayOf, parseDateStr } = require('../utils/date');

// 周期 → 间隔周数
const CYCLE_STEPS = { week: 1, biweek: 2, month: 4 };
// 星期几名 → 序号（周一=1 … 周日=7）
const WEEKDAY_INDEX = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7 };

// 归一周期：非法值退回「一周」
function normalizeCycle(cycle) {
  return Object.prototype.hasOwnProperty.call(CYCLE_STEPS, cycle) ? cycle : 'week';
}

// 星期几名 → 序号；非法值返回 0
function weekdayIndexOf(name) {
  return WEEKDAY_INDEX[String(name || '')] || 0;
}

// 某天是周几（1=周一 … 7=周日）；非法日期返回 0
function weekdayIndexOfDate(dateStr) {
  const d = parseDateStr(String(dateStr || '').slice(0, 10));
  if (isNaN(d.getTime())) return 0;
  const wd = d.getDay(); // 0=周日
  return wd === 0 ? 7 : wd;
}

// 某天属于第几周（基准周一所在周 = 第 1 周）；不在基准之后返回 0
function weekIndexOf(dateStr, baseMonday) {
  if (!baseMonday) return 0;
  const mon = mondayOf(dateStr);
  if (!mon) return 0;
  const delta = diffDays(baseMonday, mon);
  if (delta < 0) return 0;
  return Math.floor(delta / 7) + 1;
}

// 该天是否命中。
// config: { cycle, weekday }（weekday 为「周一」这类名字）
// baseMonday: 基准周一（YYYY-MM-DD）
function isHitDate(dateStr, config, baseMonday) {
  const c = config || {};
  if (!baseMonday) return false;
  if (weekdayIndexOfDate(dateStr) !== weekdayIndexOf(c.weekday)) return false;
  const idx = weekIndexOf(dateStr, baseMonday);
  if (idx <= 0) return false;
  const step = CYCLE_STEPS[normalizeCycle(c.cycle)];
  return (idx - 1) % step === 0;
}

// 从 start（含）到 end（含）之间的所有命中日，升序
function hitDatesBetween(start, end, config, baseMonday) {
  const out = [];
  const a = parseDateStr(String(start || '').slice(0, 10));
  const b = parseDateStr(String(end || '').slice(0, 10));
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return out;
  const days = diffDays(start, end);
  for (let i = 0; i <= days; i++) {
    const d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + i);
    // 日期一律走 utils/date.js 的 localDateStr（本地时区口径），不内联手拼
    if (isHitDate(localDateStr(d), config, baseMonday)) out.push(localDateStr(d));
  }
  return out;
}

module.exports = {
  CYCLE_STEPS,
  normalizeCycle,
  weekdayIndexOf,
  weekdayIndexOfDate,
  weekIndexOf,
  isHitDate,
  hitDatesBetween,
};
