// =========================================================================
// useTodoCenter.js —— 标题栏「N 项待处理」胶囊的数据来源
//
// 原来只有销假一个待办，直接在 App.vue 里写死一个铃铛。现在再加临时学生，
// 两类待办各自的数据源分散在不同 composable / 接口里，统一在这里汇成一个列表：
//   · 销假：复用 useOverdueLeaveBadge 的名单（同一份数据，不在通知中心里再算一遍口径）
//   · 临时学生：GET /api/students/provisional
//
// 没有待办时胶囊整个不渲染（不是显示「0 项」），有需要时点开才看详情。
// 定时与窗口回焦各刷一次，与销假铃铛同一节奏；换号/切库立刻清空，不串班。
// =========================================================================
import { computed, ref } from 'vue'
import axios from 'axios'
import { useOverdueLeaveBadge, refreshOverdueLeaveBadge } from './useOverdueLeaveBadge.js'
import { registerUserScopedReset, userScopedGeneration } from '../utils/userScopedCache.js'
import { createDisposables } from '../utils/disposables.js'
import { TODO_CHANGED_EVENT } from '../utils/todoInvalidator.js'

const CHECK_INTERVAL = 10 * 60 * 1000

const provisional = ref([])
let disposables = null
let inflight = null
let revision = 0

registerUserScopedReset(() => {
  provisional.value = []
  inflight = null
  revision++
  // 登出/换号要连资源句柄一起释放：interval 与 focus 监听不该跨账号存活（F04-09）。
  // 下次登录由 startTodoCenter 幂等重建。
  if (disposables) { disposables.dispose(); disposables = null }
})

/** 拉临时学生名单；在途请求复用，避免首屏与 focus 事件各发一次 */
export function refreshProvisionalStudents() {
  if (inflight) return inflight
  const gen = userScopedGeneration()
  const rev = revision
  inflight = axios.get('/api/students/provisional')
    .then((res) => {
      if (gen !== userScopedGeneration() || rev !== revision) return provisional.value.length
      const list = (res && res.data && res.data.data) || []
      provisional.value = Array.isArray(list) ? list : []
      return provisional.value.length
    })
    .catch(() => provisional.value.length) // 后端未就绪 / 网络抖动：保留上次，不闪成 0
    .finally(() => { inflight = null })
  return inflight
}

/**
 * 启动待办检测；幂等，首屏与登录成功各调一次也不会起两份定时器。
 *
 * 三条刷新路径：
 *   ① 写成功事件 → 200ms debounce 后立刻重拉两类（实时）
 *   ② 窗口回焦 → 补一次（后台被节流的定时器靠它兜住）
 *   ③ 10 分钟轮询 → 兜底，防事件丢失 / 别的窗口改了库
 *
 * debounce 用 disposables.defer() 的 schedule：它内部会 clearTimeout 上一次排期。
 * 不用 d.timeout()：它不是「可替换」的，要防抖得自己保存上一轮的取消函数，容易忘。
 */
export function startTodoCenter() {
  if (disposables) return
  disposables = createDisposables()
  refreshProvisionalStudents()
  disposables.interval(() => refreshProvisionalStudents(), CHECK_INTERVAL)
  disposables.listen(window, 'focus', () => refreshProvisionalStudents())

  // defer() 返回的**就是**调度函数（带 .cancel()），没有 .schedule()
  const debounced = disposables.defer()
  disposables.listen(window, TODO_CHANGED_EVENT, () => {
    debounced(() => {
      refreshOverdueLeaveBadge()
      refreshProvisionalStudents()
    }, 200)
  })
}

/** 释放定时器与事件监听（测试用；主窗口生命周期内不会调） */
export function stopTodoCenter() {
  if (!disposables) return
  disposables.dispose()
  disposables = null
}

// 一位同学可能有多条逾期请假（或老库里同名临时学生），列名字时去重；
// 计数也按人数而不是记录数 —— 文案说的是「N 位同学」，列出 2 个名字却写 3 位会自相矛盾。
function namesOf(rows, field) {
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map((r) => String(r && r[field] != null ? r[field] : '').trim())
    .filter(Boolean))]
}

export function useTodoCenter() {
  const { rows: overdueRows } = useOverdueLeaveBadge()

  const items = computed(() => {
    const out = []
    const leaveNames = namesOf(overdueRows.value, '姓名')
    if (leaveNames.length) {
      out.push({ key: 'overdue', title: '销假提醒', count: leaveNames.length, names: leaveNames })
    }
    const provisionalNames = namesOf(provisional.value, '姓名')
    if (provisionalNames.length) {
      out.push({ key: 'provisional', title: '临时学生提醒', count: provisionalNames.length, names: provisionalNames })
    }
    return out
  })

  const total = computed(() => items.value.reduce((n, item) => n + item.count, 0))

  return { items, total }
}
