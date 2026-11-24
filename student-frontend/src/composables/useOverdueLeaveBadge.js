// =========================================================================
// useOverdueLeaveBadge.js —— 标题栏「有 N 位同学需要销假」的全局待办计数
//
// 与 LeaveManagement 里的 checkOverdue 分工：
//   · 这里只算「当前库有多少条逾期未销假」，供标题栏铃铛显示，不弹任何窗；
//   · 弹窗仍归请假页管（点铃铛跳过去才弹），所以销假 / 撤销登记那套逻辑
//     不用搬出页面，也不用把 activeLeaves 之类的实例状态提到全局。
//
// 口径与 checkOverdue 一致：状态=请假中 且 结束时间 <= 当前时间。这是「管理视角」
// （还挂着待销假的记录，含已过期的），不是 utils/leaveState.js 的「今天在不在校」，
// 别拿后者来筛 —— 它会把已过期未销假的直接排除掉。
// =========================================================================
import { ref } from 'vue'
import axios from 'axios'
import { registerUserScopedReset, userScopedGeneration } from '../utils/userScopedCache.js'
import { createDisposables } from '../utils/disposables.js'
import { formatDateTime } from '../utils/dateTime.js'

const CHECK_INTERVAL = 10 * 60 * 1000

const count = ref(0)
// 逾期的整行记录：通知中心要列出「哪几位同学」，只给数量就还得再发一次请求
const rows = ref([])
let disposables = null
let inflight = null
// 任何一次「用现成数据直接算」都会让在途请求的回写作废，避免旧响应盖掉新数字
let revision = 0

// 换号 / 切库：立刻清零，别把上一个班的人数挂在标题栏上。
// 在途请求的代次也会变，回来时直接丢弃（见 refreshOverdueLeaveBadge）。
registerUserScopedReset(() => {
  count.value = 0
  rows.value = []
  inflight = null
  revision++
  // 登出/换号要释放定时器与 focus 监听，别让上一账号的轮询空转（F04-09）
  if (disposables) { disposables.dispose(); disposables = null }
})

export function isOverdueLeave(row, now) {
  return !!row && row.状态 === '请假中' && !!row.结束时间 && row.结束时间 <= now
}

// 数量与名单必须同一次算出：通知中心既显示「几位」又列「分别是谁」，
// 分两次筛选会在两次之间发生销假时给出互相矛盾的两个数。
function applyOverdue(inputRows, now) {
  const overdue = (Array.isArray(inputRows) ? inputRows : []).filter((r) => isOverdueLeave(r, now))
  rows.value = overdue
  count.value = overdue.length
  return count.value
}

/**
 * 刷新铃铛计数与名单。
 * 传 inputRows 时直接用现成数据（请假页 loadAll 成功后调用，不额外发请求）；
 * 不传才拉 /api/leaves（全局定时 / 窗口回焦 / 登录后用）。
 */
export function refreshOverdueLeaveBadge(inputRows) {
  const now = formatDateTime(new Date())
  if (inputRows !== undefined) {
    revision++
    return Promise.resolve(applyOverdue(inputRows, now))
  }
  if (inflight) return inflight
  const gen = userScopedGeneration()
  const rev = revision
  inflight = axios.get('/api/leaves')
    .then((res) => {
      if (gen !== userScopedGeneration() || rev !== revision) return count.value
      const list = (res && res.data && res.data.data) || []
      return applyOverdue(list, now)
    })
    .catch(() => count.value) // 后端未就绪 / 网络抖动：保留上次计数，不闪成 0
    .finally(() => { inflight = null })
  return inflight
}

/** 启动全局低频检测；幂等，首屏就绪与登录后各调一次也不会起两份定时器 */
export function startOverdueLeaveBadge() {
  if (disposables) return
  disposables = createDisposables()
  refreshOverdueLeaveBadge()
  disposables.interval(() => refreshOverdueLeaveBadge(), CHECK_INTERVAL)
  // 窗口从后台切回来是天然的工作间隙，顺手按当前时间重算一次
  disposables.listen(window, 'focus', () => refreshOverdueLeaveBadge())
}

export function useOverdueLeaveBadge() {
  return { count, rows }
}
