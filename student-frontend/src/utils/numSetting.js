// =========================================================================
// utils/numSetting.js —— 数值型 localStorage 设置的唯一解析规则
//
// 为什么不能用 `parseFloat(x) || 默认值`：
//   不透明度滑块的 min 是 0，「完全透明」是合法取值，而 0 在 JS 里是 falsy，
//   会被 `||` 当成"没读到"→ 重载后变回默认值
//   （表现为「明明关掉了遮罩，重启又回来了」）。
//
// 为什么抽成纯函数：
//   入口（main.js）与主题 store（stores/theme.js）用的是同一套规则，
//   回归探针（testjs/smoke/theme-setting-probe.mjs）也需要在没有 DOM 的
//   Node 环境里引用它。任何一处各写一份副本，规则一变就会悄悄漂移，
//   探针也会跟着假绿。
// =========================================================================

// 纯解析：raw 可能是 null（未设置）、undefined（没有这个 key）或写坏的字符串
export const parseNumSetting = (raw, fallback) => {
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : fallback
}

// 便捷包装：直接从 localStorage 读取（浏览器环境）
export const readNumSetting = (key, fallback) => parseNumSetting(localStorage.getItem(key), fallback)
