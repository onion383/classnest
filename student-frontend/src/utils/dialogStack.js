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

// 仅测试用：当前层级数
export function _stackSize() {
  return stack.length
}
