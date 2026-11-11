// 「主应用 → 浮窗」消息中继的唯一发送实现（A5-02 / K1-02）。
//
// to-widget 原先只扇出到工具箱浮窗，桌面挂件收不到任何跨窗口业务消息 ——
// 于是它只能靠 5 分钟轮询发现数据变了。这里把两个窗口放在同一张表里一起发，
// 新增第三个订阅窗口时只需往数组里加一项，不必再复制一段 send。
//
// 纯模块（不 require('electron')）：窗口对象是调用方注入的，能在 node 单测里真跑。
function relayToWidgetWindows(data, windows) {
  let sent = 0
  for (const w of windows || []) {
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) continue
    try {
      w.webContents.send('from-main', data)
      sent += 1
    } catch (_) {
      // 某个窗口正在关闭 / 渲染层崩了：不能让它挡住其它窗口收到消息
    }
  }
  return sent
}

module.exports = { relayToWidgetWindows }
