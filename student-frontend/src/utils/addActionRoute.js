// 首页空态蓝按钮用 ?action=add 跳到目标页，目标页读到后开对应新增弹窗。
// 但被 KeepAlive 缓存的其他页面同样能观察到这个 query（watch 在 deactivated 时仍然活着），
// 若只看 action 值，跳「去登记请假」会把班费/值日/加分等弹窗一起打开。
// 因此判定必须同时满足：query.action === 'add' 且当前路由就是本页。
export function isAddActionForRoute(route, expectedName) {
  return !!route && route.name === expectedName && route?.query?.action === 'add'
}
