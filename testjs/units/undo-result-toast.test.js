// =========================================================================
// undo-result-toast.test.js —— 更改审查：回退/撤销/重做的结果走提示条
//
// 为什么钉住：审查是连续动作（一条接一条地退、退错了再重做）。
// 结果如果弹窗，每退一条都要点一次「确定」才能继续，等于把连续操作切成一次一次。
// Ctrl+Z 那条路径早就是 useNotification().warning，面板按钮应当同一口径。
//
// 注意不能一刀切禁掉 ctx.showAlert：删除班级、导出失败这些仍该用弹窗——
// 那是必须让人停下来看的错误。所以只盯「撤销四个入口」的文案映射。
// 文案映射是纯函数：直接执行断言，不再统计源码里的调用次数（T08-04）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FILE = path.join(__dirname, '../../student-frontend/src/views/SettingsView/SettingsView.data.js')
const SRC = fs.readFileSync(FILE, 'utf8')
const MODULE = path.join(__dirname, '../../student-frontend/src/views/SettingsView/undoNotices.js')

test('更改审查：四个入口的结果文案可执行且分支正确', async () => {
  const {
    rewindNotice, replayNotice, undoStepNotice, undoMemberNotice, apiErrorNotice,
  } = await import(pathToFileURL(MODULE).href)

  assert.equal(rewindNotice({ ok: true }), '已成功回退')
  assert.equal(rewindNotice({ ok: true, label: '删除学生', batch: 3 }), '已回退：删除学生（连带回退 3 项）')
  assert.equal(replayNotice({ ok: true }), '已成功重做')
  assert.equal(replayNotice({ ok: true, label: '新增成绩', batch: 2 }), '已重做：新增成绩（连带重做 2 项）')
  assert.equal(undoStepNotice({ ok: true }), '已撤销这一步')
  assert.equal(undoStepNotice({ ok: true, label: '改座位' }), '已撤销：改座位')
  assert.equal(undoMemberNotice({ ok: true }), '已撤销这一条')
  assert.equal(undoMemberNotice({ ok: true, label: '改姓名' }), '已撤销：改姓名')
  assert.equal(apiErrorNotice({ response: { data: { error: '后端原因' } } }, '兜底'), '后端原因')
  assert.equal(apiErrorNotice(new Error('network'), '兜底'), '兜底')
})

test('更改审查：四个入口都接同一套文案映射，且不再弹窗', () => {
  const start = SRC.indexOf('async undoEntry(')
  const end = SRC.indexOf('clearUndo() {', start)
  assert.ok(start > 0 && end > start, '找不到撤销四个入口的方法区间')
  const block = SRC.slice(start, end)
  for (const fn of ['rewindNotice', 'replayNotice', 'undoStepNotice', 'undoMemberNotice', 'apiErrorNotice']) {
    assert.ok(block.includes(fn), `缺少文案映射 ${fn}，入口可能又手写了分支`)
  }
  assert.ok(!/ctx\.showAlert/.test(block), '撤销入口的结果不许再弹窗（要点掉才能继续）')
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
