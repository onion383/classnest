// =========================================================================
// useWeekDates.js —— 「今天」的响应式来源
//
// 用途：课程表 / 值日表的列头要在星期名下面标出具体日期（2026.3.1）。
// 日期必须是**响应式**的：页面开着不动，跨过零点后第二天要自己对上，
// 否则用户盯着屏幕看到的是昨天的日期。
//
// 提供：
//   today  —— 今天的本地日期串（每分钟刷新一次，跨零点即翻页）
//   monday —— 今天所在自然周的周一（YYYY-MM-DD），当前表的基准
//
// 「周 → 星期名对应日期」的换算在 utils/weekDates.js（纯函数，可单测）；
// 这里只管「今天会变」，各页面自己按自己的星期列去算映射。
//
// 定时器走 utils/disposables.js 的底座：就地登记、随作用域释放，
// 不要在页面里另写 setInterval（那是全库清零过的写法）。
// =========================================================================
import { ref, computed } from 'vue';
import { localDateStr, mondayOf } from '../utils/dateTime.js';
import { useDisposables } from '../utils/disposables.js';
import { weekdayNameOf } from '../utils/weekDates.js';

export function useWeekDates() {
  const d = useDisposables();
  // 本地日期串：不能用 toISOString（UTC 口径，东八区凌晨会差一天）
  const today = ref(localDateStr());
  d.interval(() => { today.value = localDateStr(); }, 60000);

  // 今天所在自然周的周一（YYYY-MM-DD）
  const monday = computed(() => mondayOf(today.value));

  // 今天的星期名（'周四'）：用来给「今天这一列」加高亮。
  // 表里没有这一列（如只配了周一~周五而今天是周六）→ 高亮自动不生效。
  const todayName = computed(() => weekdayNameOf(today.value));

  return { today, monday, todayName };
}
