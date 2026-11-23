// =========================================================================
// historyLoadGuard.js —— 历史记录 tab「数据已加载就不再重复拉」的判定
//
// 起因：SeatView / DutyView 的 watch(activeTab) 写的是
//   if (newTab === 'history') fetchHistoryWeeks()
// 于是在「管理 ↔ 历史」之间来回切会反复发 /history（周列表）+ /history/:week
// （快照），Seat 还会尾随 loadSeatIndex() 再算一次账本 —— 全是无谓往返，
// 也是「切 tab 慢」的真正来源。ScheduleView 早有 guard，故不受影响。
//
// 本文件只做**判定**，不碰请求 / ref：给定当前已加载的周列表、选中周、
// 以及（Duty 专属）周列表是按哪个维度拉的，回答「这次进 history 要不要拉」。
// 纯函数，便于 node 单测 + 变异反证。
//
// 为什么周列表非空就不拉：fetchHistoryWeeks 内部会选周并 loadHistorySnapshot，
// 只要列表在、选中周仍有效，快照与派生指数就都在，重复拉只会制造抖动。
// 用户在历史页点「刷新」走的是 refreshHistory() → fetchHistoryWeeks()，
// 是显式动作，不受本判定约束。
// =========================================================================

/**
 * 判定进入 history tab 时是否需要重新拉取周列表。
 *
 * @param {object} args
 * @param {Array<{week_start: string}>} args.weeks 已加载的周列表
 * @param {string} args.currentWeek 当前选中的周（week_start）
 * @param {string} [args.loadedScope] 周列表是按哪个维度/模式拉的（Duty 用）
 * @param {string} [args.scope] 当前维度/模式（Duty 用）
 * @returns {boolean} true=需要拉
 *
 * 规则：
 *   1) 周列表为空 → 拉（首次进入 / 上次拉取失败）
 *   2) 维度变了（loadedScope !== scope）→ 拉（周列表与当前模式不匹配）
 *   3) 选中周已不在列表中 → 拉（需要按新列表重选周 + 载快照）
 *   4) 其余 → 不拉（数据已在）
 *
 * 注意 scope 只在「传入了 scope」时参与判定：Seat 无维度概念，不传即可，
 * 避免把 undefined === undefined 当成有效的维度匹配而无视第 2 条。
 */
export function shouldReloadHistory({ weeks, currentWeek, loadedScope, scope } = {}) {
  const list = Array.isArray(weeks) ? weeks : []
  if (list.length === 0) return true
  if (scope !== undefined && loadedScope !== scope) return true
  if (currentWeek && !list.some(w => w && w.week_start === currentWeek)) return true
  return false
}

export default shouldReloadHistory
