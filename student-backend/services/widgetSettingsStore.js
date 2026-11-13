// ==================== widget_settings 的 SQL 出口 ====================
// 档 C · M12-B7：路由只做字段清洗与 HTTP，读写语句收在这里。
const { db } = require('../db')

function readSettings() {
  return db.prepare('SELECT * FROM widget_settings WHERE id = 1').get()
}

// sets / vals 由路由按「请求里真的出现的字段」拼出，字段名是路由内常量，不来自请求。
function updateSettings(sets, vals) {
  return db.prepare(`UPDATE widget_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals)
}

function readDesktopApps() {
  return db.prepare('SELECT desktop_apps FROM widget_settings WHERE id = 1').get()
}

function writeDesktopApps(json) {
  db.prepare('UPDATE widget_settings SET desktop_apps = ? WHERE id = 1').run(json)
}

function readClassInfo() {
  return db.prepare('SELECT class_info FROM widget_settings WHERE id = 1').get()
}

function writeClassInfo(json) {
  db.prepare('UPDATE widget_settings SET class_info = ? WHERE id = 1').run(json)
}

module.exports = {
  readSettings,
  updateSettings,
  readDesktopApps,
  writeDesktopApps,
  readClassInfo,
  writeClassInfo,
}
