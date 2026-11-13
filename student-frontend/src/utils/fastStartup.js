// 「快速启动」偏好：占位页是否等首页数据。
//   开启（默认）= 路由 + 样式就绪即移除占位页，首页数据边加载边显示（各卡片自己 loading）。
//   关闭        = 占位页一直挡到首页聚合接口返回后才移除。
//
// 单一来源：main.js 在启动关键路径上同步读这个值（判断本身就在「要不要等数据」的路上，
// 走接口读会变成「先等一个接口才知道要不要等接口」），设置页性能面板负责写。
// 两条路径共用这里的 key，避免两处各写一份字符串后漂移。
export const FAST_STARTUP_KEY = 'fastStartup'

export function readFastStartup() {
  try {
    return (localStorage.getItem(FAST_STARTUP_KEY) ?? '1') !== '0'
  } catch (_) {
    // 读不到（隐私模式/存储被禁）按默认开启处理：这是体验更好的那一侧，不会卡住启动
    return true
  }
}

/** 写入偏好，返回是否真的写成功（存储被禁时返回 false，调用方需回滚 UI）。 */
export function writeFastStartup(on) {
  try {
    localStorage.setItem(FAST_STARTUP_KEY, on ? '1' : '0')
    return true
  } catch (_) {
    return false
  }
}
