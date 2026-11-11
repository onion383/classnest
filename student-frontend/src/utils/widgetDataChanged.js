// =========================================================================
// 「主窗口写成功 → 通知挂件刷新」的唯一判定与广播入口（A5-02 / K1-02，§4-4）
//
// 事故：桌面挂件的课表/值日/倒计时/请假/学生只有一条 5 分钟定时轮询，
// 主窗口改完数据后挂件最长滞后 5 分钟。前三轮都当「性能问题」修（防叠加、
// 代次守卫），解决的其实是并发与脏写，不产生任何刷新信号。
//
// 根因是缺一条「写成功 → 失效通知」的事件通道。这里只定义**哪些写要通知**，
// 通道复用既有的 to-widget → from-main（新事件 type，不新增 IPC 通道名），
// 挂件侧收到后重拉；5 分钟轮询保留为兜底，防事件丢失 / 窗口未就绪。
//
// 判定口径（保守优先）：写请求默认通知，除非明确属于「与挂件数据无关的基础设施写」。
// 这样以后新增业务写路径即使忘了登记，也只是多刷一次，不会退化成 5 分钟滞后。
// =========================================================================

// 与 DesktopWidget.loadAll 的 5 个 GET 一一对应
export const WIDGET_DOMAINS = Object.freeze(['schedule', 'duty', 'countdowns', 'leaves', 'students'])

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

// 能判出具体域的，只报该域（挂件可据此缩小刷新范围，消息体也不撒谎）
const DOMAIN_PREFIXES = [
  ['/api/schedule', 'schedule'],
  ['/api/duty', 'duty'],
  ['/api/countdowns', 'countdowns'],
  ['/api/leaves', 'leaves'],
  ['/api/students', 'students'],
]

// 一次动作可能改任意一张表：撤销/重做、还原备份、AI 批量落表
const GLOBAL_RE = /^\/api\/(?:undo|restore|db-login|db-recover|register\/confirm|ai\/(?:apply-batch|doc|snapshot\/restore))(?:\/|\?|$)/

// 明确与挂件 5 个数据源无关的基础设施写。聊天、相册、导出、握手每次都会发生，
// 不排掉的话每发一条消息都会让挂件白打 5 个 GET。
const IGNORED_RE = /^\/api\/(?:ai|album|account|auth|login|register|recover-password|secure|search|widget-settings|background|perf|data\/zip|data\/sources)(?:\/|\?|$)/

/** 去掉 origin 与 query/hash，留下可比较的 API 路径。 */
export function normalizeApiPath(url) {
  const s = String(url || '').replace(/^https?:\/\/[^/]+/, '')
  return s.split(/[?#]/)[0] || '/'
}

function atPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/')
}

/**
 * 这次写要通知哪些挂件数据域；返回 [] 表示不用通知。
 * @param {string} method HTTP method
 * @param {string} url 请求 URL（可带 origin / query）
 */
export function domainsForWrite(method, url) {
  if (!WRITE_METHODS.has(String(method || '').toLowerCase())) return []
  const path = normalizeApiPath(url)
  if (GLOBAL_RE.test(path)) return [...WIDGET_DOMAINS]
  if (IGNORED_RE.test(path)) return []
  for (const [prefix, domain] of DOMAIN_PREFIXES) {
    if (atPrefix(path, prefix)) return [domain]
  }
  // 非业务 API（Vite 代理、静态资源等）不通知；未知的业务写一律全量失效
  return path.startsWith('/api/') ? [...WIDGET_DOMAINS] : []
}

/**
 * 造一个广播器；send 由调用方注入（渲染层里就是 window.electron.send），
 * 这样判定逻辑能在 node 里真跑，而不是只靠源码字符串判据。
 *
 * 同一个 config 只播一次：安全通道 / 后端未就绪重试会复用 config 再次经过
 * 响应成功拦截器，不去重会让一次写变成多次刷新。
 */
export function createWidgetDataChangedAnnouncer(send) {
  return {
    announce(config) {
      if (!config || config.__dataChangedSent || config.__skipDataChanged) return null
      const domains = domainsForWrite(config.method, config.url)
      if (!domains.length) return null
      config.__dataChangedSent = true
      const payload = { type: 'data-changed', domains }
      // 广播是「尽力而为」：窗口还没建好 / IPC 抖动，都不能把一次成功的写变成失败，
      // 兜底轮询会把这次漏掉的变化补上。
      try { send(payload) } catch (_) { /* 交给 5 分钟兜底 */ }
      return payload
    },
  }
}
