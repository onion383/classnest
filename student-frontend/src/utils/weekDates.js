// =========================================================================
// weekDates.js —— 「星期列 → 具体日期」的唯一口径
//
// 课程表与值日表的列头是「周一…周日」，但用户想知道这一周到底是几号。
// 两处（课表页、值日页）都曾经各自写一份换算 —— 同一语义散在多处，
// 迟早有一处口径不同（一个按学期周次、一个按自然周），对不上。
//
// 这里收敛成一个入口：
//   buildWeekDateMap(baseMonday, days)  指定周（baseMonday = 该周周一）
//   currentWeekDateMap(days)            今天所在的那一周
//
// 两个约定：
//   1. **按星期名取，不按列下标取**。列可以拖拽（课表/值日的表头固定、
//      数据搬家），按下标算日期会在拖完之后对不上；按星期名算则永远稳定。
//   2. 日期标签是「年.月.日」且月日不补零（2026.3.1），与界面上的
//      紧凑风格一致，也避免表头两行把列撑得太宽。
// =========================================================================
import { localDateStr, mondayOf, shiftDateStr } from './dateTime.js'

// 星期名 → 周内偏移（周一=0 … 周日=6）
const DAY_INDEX = {
  '周一': 0, '周二': 1, '周三': 2, '周四': 3, '周五': 4, '周六': 5, '周日': 6,
}

// '2026-03-01' → '2026.3.1'（月日不补零）。非法输入返回空串（调用方按「没有日期」处理）。
// 除了格式，还要校验**是不是真实存在的日期**：光看正则 '2026-13-45' 也能匹配上，
// 但那是 13 月 45 日 —— 直接输出会显示出一个根本不存在的日期。
export function formatDateLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').slice(0, 10));
  if (!m) return '';
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  // 用本地时间构造再回读：2 月 30 日会被 Date 自动进位成 3 月 2 日，对比不上就说明日期不存在。
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return '';
  return `${year}.${month}.${day}`;
}

// 以 baseMonday（该周周一，YYYY-MM-DD）为基准，给出每个星期名对应的日期标签。
// days 只取列表里出现的星期名（课表/值日的天数可配置，可能是「周三~周五」这种子集）。
export function buildWeekDateMap(baseMonday, days) {
  const map = {};
  const list = Array.isArray(days) ? days : [];
  for (const day of list) {
    const idx = DAY_INDEX[day];
    if (idx == null) continue;
    const dateStr = shiftDateStr(baseMonday, idx);
    if (!dateStr) continue;
    map[day] = formatDateLabel(dateStr);
  }
  return map;
}

// 今天所在的自然周（周一为起点）。
// today 走参数而不是内部取：调用方要能对「今天」这个值保持响应式
// （页面长时间开着跨过零点时，重新算出来的日期才是新的）。
export function currentWeekDateMap(days, today = localDateStr()) {
  return buildWeekDateMap(mondayOf(today), days);
}

// '2026-11-05' → '周四'。用来判断「今天在哪一列」。
// 走本地时间构造（不能用 toISOString，那是 UTC 口径，东八区凌晨会差一天）。
// 非法输入返回空串，调用方按「没有今天」处理。
export function weekdayNameOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').slice(0, 10));
  if (!m) return '';
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return '';
  // getDay(): 0=周日 … 6=周六
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
