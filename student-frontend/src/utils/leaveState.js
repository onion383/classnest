// =========================================================================
// leaveState.js —— 「某人今天在不在校」的唯一判定
//
// 为什么要有它：
//   「请假」这个口径在库里散成了好几份，写法还不一致：
//     · DashboardView.attendance  ：状态 === '请假中'（**不看日期**）
//     · DashboardView.currentLeaveList：状态 === '请假中' && 开始时间 是今天
//     · DesktopWidget.attendance  ：状态 === '请假中'（不看日期）
//     · LeaveManagement.activeLeaves：状态 === '请假中'（不看日期）
//   前两个就在同一屏上：右上角「请假 3」而下面的「今日请假」一张卡都没有 ——
//   因为跨天假（8/31–9/02）只在数字里算、不在卡片里算。同一屏两个数字互相矛盾，
//   用户无法判断哪个是真的。
//
// 归一口径（今日视角）：
//   **状态 === '请假中' 且 开始时间 <= 今天 <= 结束时间**（首尾都算）。
//   结束时间为空的历史行按「请到销假为止」处理，只卡开始时间。
//   还没开始的假（提前登记）不算「今天不在校」，否则在校人数会凭空减少。
//
// 注意 LeaveManagement 的「当前请假中」是**管理视角**（所有还挂着「请假中」
// 待销假的记录，含已过期的），与这里不是同一个概念，不要硬套。
// =========================================================================

import { localDateStr } from './dateTime.js'

// 只取日期部分：接口回来可能是 '2026-09-02'，也可能是带时间的 '2026-09-02 08:30'/'2026-09-02T00:00'。
// 传 Date 时要按**本地日期**取（桌面挂件传的是响应式 Date），不能 String(Date).slice(0,10)。
const day10 = (v) => {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : localDateStr(v)
  return String(v || '').slice(0, 10)
}

/**
 * 这条请假记录是否覆盖 dateStr 这一天。
 * @param {object} leave 请假记录（状态/开始时间/结束时间）
 * @param {string} [dateStr] 目标日期 YYYY-MM-DD，缺省为今天（本地口径）
 */
export function isOnLeaveOn(leave, dateStr) {
  if (!leave || leave.状态 !== '请假中') return false
  const day = day10(dateStr || localDateStr())
  if (!day) return false
  const start = day10(leave.开始时间)
  // 没有开始时间：无从判断覆盖范围，不计入（宁可少算，也不要把脏数据算成「不在校」）
  if (!start) return false
  if (start > day) return false // 还没开始
  const end = day10(leave.结束时间)
  if (end && end < day) return false // 已过期但还没销假
  return true
}

/** 从请假列表里筛出覆盖 dateStr 这一天的人（缺省今天） */
export function leavesOn(leaves, dateStr) {
  const list = Array.isArray(leaves) ? leaves : []
  return list.filter((l) => isOnLeaveOn(l, dateStr))
}

/**
 * 从学生名单里剔除「今天不在校」的人（工具箱点名器的候选名单）。
 * 判定仍然只走 leavesOn，不另写一份请假条件 —— 点名结果与首页「在校人数」同源。
 *
 * 请假记录有两种身份来源：新增时优先带 student_id，导入/临时姓名可能只有姓名。
 * 所以按 id 和「trim 后的姓名」双路匹配：学生改过名也能靠 id 排除，
 * 只有姓名的历史请假行也能靠规范名排除（姓名口径与名册表一致，不做模糊匹配）。
 *
 * @returns {{ list: object[], excludedCount: number }} 剩余候选名单与被排除的人数
 */
export function filterPresentStudents(students, leaves, dateStr) {
  const ids = new Set()
  const names = new Set()
  for (const leave of leavesOn(leaves, dateStr)) {
    if (leave.student_id !== null && leave.student_id !== undefined && leave.student_id !== '') {
      const id = Number(leave.student_id)
      if (Number.isFinite(id)) ids.add(id)
    }
    const name = String(leave.姓名 || '').trim()
    if (name) names.add(name)
  }

  const list = Array.isArray(students) ? students : []
  let excludedCount = 0
  const present = list.filter((stu) => {
    if (!stu) return false
    const id = stu.id === null || stu.id === undefined || stu.id === '' ? NaN : Number(stu.id)
    const absentById = Number.isFinite(id) && ids.has(id)
    const absentByName = names.has(String(stu.姓名 || '').trim())
    if (absentById || absentByName) {
      excludedCount++
      return false
    }
    return true
  })
  return { list: present, excludedCount }
}
