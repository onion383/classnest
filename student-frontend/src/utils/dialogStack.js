// =========================================================================
// dialogStack.js —— 弹窗层级栈（跨实例共享）
//
// 为什么单独一个模块：DialogShell 是公共外壳，设置类弹窗里还会再开确认框
// （两层同时可见）。做 Esc 层级判断需要一个**所有实例共享**的栈；
// 原先 `const openStack = []` 写在 `<script setup>` 里，每个组件实例各有一份，
// 于是「确认框按 Esc」时它只跟自己的空栈比，判断恒真或无意义，
// 结果一次 Esc 把外层设置弹窗也一起关掉（审查 v5 · V5-003）。
//
// 放在模块作用域后：同一次应用里所有 DialogShell 实例共用同一个栈。
// 纯函数、零依赖，便于直接单测。
// =========================================================================

const stack = []

// 打开：登记到栈顶。重复登记是幂等的（visible 反复切换不会重复入栈）
export function pushDialog(id) {
  if (stack.indexOf(id) >= 0) return
  stack.push(id)
}

// 关闭/卸载：从栈中移除。不存在时静默返回（卸载时可能已经移除过）
export function removeDialog(id) {
  const i = stack.indexOf(id)
  if (i >= 0) stack.splice(i, 1)
}

// 是否最上层：只有栈顶实例响应 Esc
export function isTopDialog(id) {
  return stack.length > 0 && stack[stack.length - 1] === id
}

// ---------------------------------------------------------------------------
// 通用 Esc 层协议
//
// 弹窗（DialogShell）和弹层（下拉 / 气泡 / 筛选面板）共用**同一个栈**：
// 谁后打开谁在栈顶，Esc 只归栈顶处理。这样「父弹窗被连带关掉」不再取决于
// 各个弹层有没有记得调用 preventDefault —— 层级顺序本身就是唯一真相。
//
// 生产端统一走 consumeEscape()：打开态才消费，收起态完全放行。
// 直接给模板加 .prevent 是错的：菜单没开时按 Esc 也会把父弹窗的 Esc 吞掉。
// ---------------------------------------------------------------------------

// 打开/关闭一个弹层（与弹窗同栈；重复 push/remove 幂等）
export const pushEscLayer = pushDialog
export const removeEscLayer = removeDialog

// 同一次 Esc 只允许被消费一次。stopPropagation 不会阻止**同一节点**上的其他监听器，
// 多个 document 级弹层（如下拉 + 表头筛选）可能依次收到同一个事件；记下已消费的事件，
// 后到的监听器直接放行，避免一次 Esc 连收两层。WeakSet 不持有事件引用。
const consumedEscEvents = new WeakSet()

/**
 * 生产端消费一次 Esc 的唯一入口。
 *
 * @param {KeyboardEvent} e
 * @param {{ open?: boolean, self?: object }} opts
 *   open：弹层当前是否展开（收起时必须完全放行）
 *   self：弹层在栈里的身份；传了就先确认自己在栈顶，没传则只按 open 判断
 * @returns {boolean} true = 本次 Esc 归自己，调用方应关闭弹层
 */
export function consumeEscape(e, { open = true, self = null } = {}) {
  if (!e || e.key !== 'Escape' || !open) return false
  if (consumedEscEvents.has(e)) return false
  if (self && !isTopDialog(self)) return false
  consumedEscEvents.add(e)
  e.preventDefault()
  e.stopPropagation()
  return true
}

// 仅测试用：当前层级数
export function _stackSize() {
  return stack.length
}
