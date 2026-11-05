// =========================================================================
// dutyConfig.js —— 值日「列名 + 模式配置」的唯一读写入口
//
// 为什么要有这个模块：
//   · 列名按模式分键存储：{daily:["周一"…],big:["第1大组",…,"全部"]}。
//     日常值日的列名是星期几，大扫除的列名是「第X大组 / 第X小组 / 全部」，
//     两者语义不同，共用一份数组时大扫除根本没法表达「第1大组负责扫地」。
//     结构与 items 的 {daily,big} 同构。
//   · 后端有 6 处要读列名（值日路由 / 校验规则 / 全局搜索 / AI 出图 / 数据导出 …）。
//     各自写一份解包逻辑，就会出现「同一份数据被解释成不同结构」的老问题 ——
//     表现是「AI 出图的列名跟界面对不上」。所以读列名一律走本模块，
//     别处不要再直接 SELECT days。
//   · 模式配置（settings 列，按模式分键）：大扫除的
//     { cycle, weekday, groupType, groupCount }；日常值日为空对象 {}。
//
// 大扫除的列名是**派生**的（由「任务分组 + 数量」算出来），不单独存一份：
//   列 = 第1大组 … 第N大组（第1小组 … 第N小组）+ 全部
//   「任务分组」是大组还是小组由用户选（二选一），数量由用户填。
//   组数存在配置里，列名是它的纯函数。这样只有一个真相 ——
//   存「数量」又存「列名」两份，改了数量忘了同步列名就会两处打架。
// =========================================================================

const store = require('./slotStore');
const { unpackMode, packMode, normalizeMode } = require('./dutyMode');

// 日常值日的默认列（整行缺失时的兜底）
const DEFAULT_DAYS = ['周一', '周二', '周三', '周四', '周五'];
// 大扫除的内置列：候选池是全体学生（各组列的候选池也是全体 —— 组只是「责任区域」）
const ALL_COLUMN = '全部';
// 周期：一周 / 两周 / 一个月
const CYCLES = ['week', 'biweek', 'month'];
// 周期对应的间隔周数（一个月按 4 周算，见 dutyCycle.js 的说明）
const CYCLE_STEPS = { week: 1, biweek: 2, month: 4 };
// 时间设置里的星期几
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 任务分组（二选一）：每个人负责一块区域，区域要么是「大组」要么是「小组」
const GROUP_TYPES = { big: '大组', small: '小组' };
// 组数的取值上限（防手滑输个 999 造出 1000 列）
const MAX_GROUPS = 30;
// 模式配置的默认值：大扫除默认 3 个大组
const DEFAULT_CONFIG = { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 3 };

// 洗一遍列名数组：去空白 / 去空项 / 去重（保持原顺序）
function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 读整行的 settings 行（days / items / settings 三列都取）
function rawDoc() {
  return store.getDoc('duty_settings');
}

// 由「任务分组 + 数量」派生大扫除的列名：
//   任务分组=大组 → 第1大组 … 第N大组 + 全部
//   任务分组=小组 → 第1小组 … 第N小组 + 全部
// 「全部」永远在末尾（内置列：候选池是全体学生）。
function bigColumnNames(groupType, groupCount) {
  const out = [];
  const n = Math.max(0, Math.min(MAX_GROUPS, Math.round(Number(groupCount)) || 0));
  const label = GROUP_TYPES[groupType] || GROUP_TYPES[DEFAULT_CONFIG.groupType];
  for (let i = 1; i <= n; i++) out.push(`第${i}${label}`);
  out.push(ALL_COLUMN);
  return out;
}

// 读某模式的列名。
// 日常值日：存的是用户勾选的星期。
// 大扫除：由配置里的「任务分组 + 数量」派生（不存列名，见文件头的说明）。
function readDays(mode) {
  const m = normalizeMode(mode);
  if (m === 'big') {
    const cfg = readConfig('big');
    return bigColumnNames(cfg.groupType, cfg.groupCount);
  }
  const doc = rawDoc();
  // 整行都没有（表被清空）才兜底；读到「配置为空」要如实返回空，不能兜底
  if (!doc) return DEFAULT_DAYS.slice();
  const packed = unpackMode(doc.days, m, []);
  return cleanList(Array.isArray(packed) ? packed : []);
}

// 写某模式的列名。
// 大扫除的列名是派生的 → 不落库（存了就会和「任务分组 + 数量」打架）。
function writeDays(mode, days) {
  const m = normalizeMode(mode);
  if (m === 'big') return;
  const doc = rawDoc();
  const prev = doc ? doc.days : null;
  const arr = cleanList(Array.isArray(days) ? days : []);
  store.setDoc('duty_settings', { days: JSON.stringify(packMode(prev, m, arr)) });
}

// 归一模式配置：非法值退回默认（外部输入不能把库写坏）
function normalizeConfig(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cycle = CYCLES.includes(o.cycle) ? o.cycle : DEFAULT_CONFIG.cycle;
  const weekday = WEEKDAYS.includes(o.weekday) ? o.weekday : DEFAULT_CONFIG.weekday;
  const groupType = GROUP_TYPES[o.groupType] ? o.groupType : DEFAULT_CONFIG.groupType;
  const n = Math.round(Number(o.groupCount));
  const groupCount = !Number.isFinite(n) || n < 0 ? DEFAULT_CONFIG.groupCount : Math.min(MAX_GROUPS, n);
  return { cycle, weekday, groupType, groupCount };
}

// 读某模式的配置（大扫除：周期 / 星期几 / 所用的分组维度）
function readConfig(mode) {
  const m = normalizeMode(mode);
  const doc = rawDoc();
  const packed = doc ? unpackMode(doc.settings, m, null) : null;
  if (m === 'daily') return {};
  return normalizeConfig(packed);
}

// 写某模式的配置
function writeConfig(mode, config) {
  const m = normalizeMode(mode);
  const doc = rawDoc();
  const prev = doc ? doc.settings : null;
  const next = m === 'daily' ? {} : normalizeConfig(config);
  store.setDoc('duty_settings', { settings: JSON.stringify(packMode(prev, m, next)) });
}

module.exports = {
  DEFAULT_DAYS,
  ALL_COLUMN,
  CYCLES,
  CYCLE_STEPS,
  WEEKDAYS,
  GROUP_TYPES,
  DEFAULT_CONFIG,
  MAX_GROUPS,
  cleanList,
  bigColumnNames,
  readDays,
  writeDays,
  readConfig,
  writeConfig,
  normalizeConfig,
};
