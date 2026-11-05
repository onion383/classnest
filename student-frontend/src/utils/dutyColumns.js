// =========================================================================
// dutyColumns.js —— 前端「值日列名」的唯一来源
//
// 值日表的列名有两种语义（后端按模式存同一份，见 student-backend/services/dutyConfig.js）：
//   daily（日常值日）→ 周一…周五（用户勾选）
//   big  （大扫除）  → 第1大组…第N大组（第1小组…第N小组）+ 内置的「全部」列
//
// 大扫除的列名是**派生**的（「任务分组 + 数量」的纯函数），不单独存一份 ——
// 只存数量又存列名两份，改了数量忘了同步列名就会两处打架。
// 后端的同一实现在 services/dutyConfig.bigColumnNames，规则必须一致
// （testjs/behavior/duty-big-mode.test.js 有断言守着两边一致）。
//
// 「全部」是**内置列**：候选池是全体学生。各组列的候选池也是全体
// （组只是「责任区域」：每个人负责一块区域，不绑定具体成员）。
// =========================================================================

// 内置列：候选池 = 全体学生
export const ALL_COLUMN = '全部';

// 大扫除的周期选项（与后端 services/dutyConfig.js 的 CYCLES 一致）
export const CYCLES = [
  { value: 'week', label: '一周' },
  { value: 'biweek', label: '两周' },
  { value: 'month', label: '一个月' },
];

// 时间设置里的星期几
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 任务分组（二选一）：每个人负责一块区域，区域要么是「大组」要么是「小组」
export const GROUP_TYPES = [
  { value: 'big', label: '大组' },
  { value: 'small', label: '小组' },
];

// 任务分组的显示名（与后端 GROUP_TYPES 一致）
export const GROUP_TYPE_LABELS = { big: '大组', small: '小组' };

// 组数的取值上限（与后端 MAX_GROUPS 一致）
export const MAX_GROUPS = 30;

// 洗一遍列名数组：去空白 / 去空项 / 去重（保持原顺序）
export function cleanColumns(list) {
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

// 由「任务分组 + 数量」派生大扫除的列名：
//   任务分组=大组 → 第1大组 … 第N大组 + 全部
//   任务分组=小组 → 第1小组 … 第N小组 + 全部
// 「全部」永远在末尾（内置列）。
export function bigColumnNames(groupType, groupCount) {
  const out = [];
  const n = Math.max(0, Math.min(MAX_GROUPS, Math.round(Number(groupCount)) || 0));
  const label = GROUP_TYPE_LABELS[groupType] || GROUP_TYPE_LABELS.big;
  for (let i = 1; i <= n; i++) out.push(`第${i}${label}`);
  out.push(ALL_COLUMN);
  return out;
}

// 从列名里剔除内置列（用户侧只维护组名）
export function withoutAllColumn(columns) {
  return cleanColumns(columns).filter((c) => c !== ALL_COLUMN);
}
