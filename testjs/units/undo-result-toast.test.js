// =========================================================================
// undo-result-toast.test.js —— 更改审查：回退/撤销/重做的结果走提示条
//
// 为什么钉住：审查是连续动作（一条接一条地退、退错了再重做）。
// 结果如果弹窗，每退一条都要点一次「确定」才能继续，等于把连续操作切成一次一次。
// Ctrl+Z 那条路径早就是 useNotification().warning，面板按钮应当同一口径。
//
// 注意不能一刀切禁掉 ctx.showAlert：删除班级、导出失败这些仍该用弹窗——
// 那是必须让人停下来看的错误。所以只截「撤销四个入口」这一段来断言。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '../../student-frontend/src/views/SettingsView/SettingsView.data.js')
const SRC = fs.readFileSync(FILE, 'utf8')

// 从 undoEntry 到 clearUndo：正好包住 undoEntry / undoOriginStep / undoMember / redoEntry
function undoBlock() {
  const start = SRC.indexOf('async undoEntry')
  const end = SRC.indexOf('clearUndo()')
  assert.ok(start > 0 && end > start, '找不到撤销相关方法段（方法名或顺序变了就更新这里）')
  return SRC.slice(start, end)
}

test('更改审查：撤销/重做结果用提示条，不弹窗', () => {
  const block = undoBlock()
  assert.ok(!/ctx\.showAlert/.test(block), '回退/撤销/重做的结果不许再弹窗（要点掉才能继续）')

  for (const fn of ['undoEntry', 'undoOriginStep', 'undoMember', 'redoEntry']) {
    assert.ok(block.includes(fn), `缺少入口 ${fn}`)
  }
  const okCount = (block.match(/useNotification\(\)\.success/g) || []).length
  const errCount = (block.match(/useNotification\(\)\.error/g) || []).length
  // 四个入口各有成功 + 失败两条；少一条就是某个分支又悄悄吞了结果
  assert.equal(okCount, 4, `成功提示应覆盖四个入口，实际 ${okCount} 处`)
  assert.equal(errCount, 4, `失败提示应覆盖四个入口，实际 ${errCount} 处`)
})

test('更改审查：清空记录是确认框 + 5 秒倒计时（不可逆动作不能一点就生效）', () => {
  const at = SRC.indexOf('clearUndo() {')
  assert.ok(at > 0, '找不到 clearUndo 方法定义')
  const block = SRC.slice(at, SRC.indexOf('sourceLabel(source)'))
  // 与危险区同一套：确定键先置灰，倒计时结束才可点
  assert.match(block, /confirmDisabled: true/, '确定键必须先置灰')
  assert.match(block, /remain = 5/, '倒计时从 5 起（与危险区同节奏，删账号是 10）')
  assert.match(block, /clearDeleteTimer\(\)/, '关闭/取消必须停表，否则计时器会继续改一个已关掉的弹窗')
  assert.ok(!/showAlert/.test(block), '这里要确认框，不是提示条')
})
