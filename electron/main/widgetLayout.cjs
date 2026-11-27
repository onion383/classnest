// 工具箱浮窗的初始窗口位置（CJS，Electron 主进程与单测都能直接 require）。
// 与渲染层 student-frontend/src/subwindows/widget/widgetLayout.js 同源：
// 内容区 520×784、图标 48×48 居中 → 图标左上角在窗口内偏移 (236,368)。
// 拖拽夹位不在这里做：位置真源是渲染层 iconScreen，主进程重复夹会与它脱钩。

const WIDGET_ICON_SIZE = 48
const WIDGET_ICON_OFF_X = 236
const WIDGET_ICON_OFF_Y = 368

// 初始位置：让图标完整贴在指定工作区左缘、垂直居中，返回窗口左上角。
// 图标「左上角」相对窗口左上角 = (236,368)，不额外加阴影留边。
// 旧公式把图标「中心」放到 x=0，图标左半边 24px 出屏；这里放到左上角 x=0。
function initialWidgetPosition(wa) {
  const h = typeof wa.height === 'number' ? wa.height : wa.h
  return [-WIDGET_ICON_OFF_X, Math.round(h / 2) - (WIDGET_ICON_OFF_Y + WIDGET_ICON_SIZE / 2)]
}

module.exports = {
  WIDGET_ICON_SIZE,
  WIDGET_ICON_OFF_X,
  WIDGET_ICON_OFF_Y,
  initialWidgetPosition,
}
