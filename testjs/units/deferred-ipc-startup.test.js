// =========================================================================
// deferred-ipc-startup.test.js —— 延迟 IPC 注册全局化 + 「低配模式已删除」回归
// 运行：node testjs/run-units.js --only=deferred-ipc-startup
//
// 背景：曾按 os.cpus().length <= 2 开过一个「低配启动模式」（含设置页开关、2 个 IPC
// 通道、判定模块）。真机 2 核 4GB VM 的 21 段 startup.log 证明整体错峰没有可测收益
// （开/关中位差 11ms，落在噪声内；异常轮是整机吞吐抖动，全段等比变慢），于是删掉模式，
// 只把「5 组延迟 IPC 注册延到界面可见后」并入全局 —— 这 5 组在高配机上也零损失，
// 本来就不该按核数分叉。
//
// 三层防线：
//   1. 全局接线：注册真的挂在 startupTimer.onFinal 上，不是硬编码立即注册。
//      只断言「函数存在」会假绿 —— main.js 完全可以改回立即注册而测试照样全过。
//   2. 清理干净：主进程 / 通道名单 / 权限表 / 设置页都不再有低配模式残留，
//      判定模块与旧单测文件已删除。防止以后有人把模式半拉子接回来。
//   3. 回归防线：性能面板采样与 1s 轮询照常、更新检查 8s / U 盘 0ms 恢复，
//      fork 与建窗先后不许调换（main.js:607 实测定案·勿再调换）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const at = (...parts) => path.join(ROOT, ...parts)
const MAIN = at('electron/main/main.js')
const DEAD_MODULE = at('electron/main/main.lowPower.js')
const DEAD_TEST = at('testjs/units/low-power-startup.test.js')
const CHANNELS = at('electron/ipc-channels.json')
const POLICY = at('electron/ipc-policy.json')
const VIEW = at('student-frontend/src/views/SettingsView/SettingsView.vue')
const APPEARANCE = at('student-frontend/src/views/SettingsView/SettingsView.appearance.js')

const read = (f) => fs.readFileSync(f, 'utf8')

/**
 * 源码判据只查「真代码」：只剥整行 // 注释。
 * 不剥注释会把说明文字（例如「不 require('electron')」）当成真调用，历史上假红过一次。
 * 但**绝不能**用 /\/\*[\s\S]*?\*\// 去剥块注释 —— .vue 模板里有 accept="image/*"
 * 这类属性值，正则会把斜杠星号当注释开头一路吃到很远的结束标记，实测吃掉 56KB 模板内容。
 * 行内块注释只是「忽略」之类短语，不含本文件要查的标识符，留着无害。
 */
function codeOf(f) {
  return read(f)
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

// ==================== 全局接线 ====================
test('延迟 IPC 注册无条件挂在 startupTimer.onFinal 上（全局生效，不分机型）', () => {
  const src = codeOf(MAIN)
  assert.match(
    src,
    /startupTimer\.onFinal\(\(\)\s*=>\s*\{\s*registerDeferredIpc\(\)\s*\}\)/,
    '5 组延迟 IPC 必须在界面可见后才注册',
  )
  // 「存在 X」不够：不许再出现同步立即注册的分支
  assert.ok(!/\}\s*else\s*\{\s*registerDeferredIpc\(\)\s*\}/.test(src), '不许留立即注册的 else 分支')
  const calls = (src.match(/registerDeferredIpc\(\)/g) || []).length
  assert.equal(calls, 2, `应只有「函数定义 + onFinal 调用」两处（实际 ${calls}）`)
})

test('启动必需的通道仍在文件顶层，不在延迟注册那批里', () => {
  const src = codeOf(MAIN)
  const iDeferred = src.indexOf('function registerDeferredIpc')
  assert.ok(iDeferred > 0, '找不到 registerDeferredIpc 定义')
  // 函数体结束于第一个顶格 }；顶层 IPC 注册在它**之后**（不是之前），别写反。
  const iEnd = src.indexOf('\n}\n', iDeferred)
  assert.ok(iEnd > iDeferred, '找不到 registerDeferredIpc 函数体结束位置')
  const body = src.slice(iDeferred, iEnd)
  // 5 组延迟注册函数必须都在函数体内
  for (const fn of ['registerUsbIpc()', 'registerUpdateIpc(', 'registerDialogsIpc(', 'registerAppsIpc(', 'registerPerfIpc(']) {
    assert.ok(body.includes(fn), `${fn} 必须在 registerDeferredIpc 体内`)
  }
  // 后端 / 小组件 IPC 必须在顶层存在，且不能被塞进延迟函数体
  assert.ok(src.includes('backend.registerBackendIpc({'), '后端 IPC 顶层注册不见了')
  assert.ok(src.includes('widget.registerWidgetIpc({'), '小组件 IPC 顶层注册不见了')
  assert.ok(!body.includes('backend.registerBackendIpc('), '后端 IPC 不许被挪进延迟注册')
  assert.ok(!body.includes('widget.registerWidgetIpc('), '小组件 IPC 不许被挪进延迟注册')
})

// ==================== 清理干净 ====================
test('主进程里不再有任何低配模式判定 / 门控 / 打点', () => {
  const src = codeOf(MAIN)
  for (const word of ['lowPower', 'LOW_POWER', 'BANJI_LOW_POWER', 'applyLowPower', 'os.cpus', '低配启动模式']) {
    assert.ok(!src.includes(word), `main.js 仍残留 ${word}`)
  }
  assert.ok(!src.includes('get-low-power-startup') && !src.includes('set-low-power-startup'))
})

test('通道名单与权限表都不再含 get/set-low-power-startup', () => {
  const ch = JSON.parse(read(CHANNELS))
  const policy = JSON.parse(read(POLICY))
  assert.ok(!ch.invoke.some((c) => c.includes('low-power')), 'ipc-channels.json 仍有低配通道')
  assert.ok(!Object.keys(policy).some((c) => c.includes('low-power')), 'ipc-policy.json 仍有低配通道')
})

test('设置页不再有低配开关、状态行与相关 ctx 绑定', () => {
  const view = codeOf(VIEW)
  const appearance = codeOf(APPEARANCE)
  for (const word of ['低配启动优化', 'lowPowerStartup', 'lowPowerStartupState', 'onLowPowerStartupChange', 'loadLowPowerStartup']) {
    assert.ok(!view.includes(word), `SettingsView.vue 仍残留 ${word}`)
    assert.ok(!appearance.includes(word), `SettingsView.appearance.js 仍残留 ${word}`)
  }
  // 相邻的「快速启动」不能被顺手删掉：用模板原文判，别用剥过注释的源码
  assert.match(read(VIEW), /:model-value="fastStartup"[\s\S]{0,120}@change="onFastStartupChange"/)
  assert.match(read(APPEARANCE), /onFastStartupChange\(/)
})

test('判定模块与旧单测文件已删除', () => {
  assert.equal(fs.existsSync(DEAD_MODULE), false, 'main.lowPower.js 应已删除')
  assert.equal(fs.existsSync(DEAD_TEST), false, 'low-power-startup.test.js 应已删除')
})

// ==================== 回归防线 ====================
test('更新检查 8s 与 U 盘 0ms 恢复原值（低配的 30s / 6000ms 已撤）', () => {
  const src = codeOf(MAIN)
  assert.match(src, /runUpdateFlow\(\)\s*\}\s*,\s*8000\)/)
  assert.match(src, /getUsb\(\)\.startUsbWatch\(\)[\s\S]{0,80}\}\s*,\s*0\)/)
  // 用单词边界：main.js 别处有 60000（ttl 上限），直接 includes('6000') 会误命中
  assert.ok(!/\b30000\b/.test(src) && !/\b6000\b/.test(src), '不许残留低配延迟常量')
})

test('性能面板的内存采样与 1s 轮询照常（删模式不许顺手停监控）', () => {
  const main = codeOf(MAIN)
  const appearance = read(APPEARANCE)
  const view = read(VIEW)
  assert.match(main, /getPerf\(\)\.startMemSampling\(\)/)
  assert.match(appearance, /INVOKE\.PERF_SNAPSHOT/)
  assert.match(view, /ctx\._startPerfPolling\(\)/)
  const start = appearance.indexOf('_startPerfPolling()')
  assert.ok(start > 0, '找不到轮询启动函数')
  const body = appearance.slice(start, start + 400)
  assert.match(body, /setInterval/)
  assert.match(body, /,\s*1000\)/, '轮询仍按 1s 跑')
})

test('proceedStartup 里仍是先建窗口、后 fork 后端（main.js:607 实测定案）', () => {
  const src = read(MAIN)
  const from = src.indexOf('const proceedStartup')
  const to = src.indexOf('proceedStartup()', from + 10)
  assert.ok(from > 0 && to > from, '找不到 proceedStartup 定义体')
  const body = src.slice(from, to)
  const iWin = body.indexOf('createMainWindow()')
  const iFork = body.indexOf('backend.startBackend()')
  assert.ok(iWin > 0 && iFork > 0, '定义体里必须同时有建窗与 fork')
  assert.ok(iWin < iFork, '不许把 fork 提到建窗之前')
  assert.equal((body.match(/backend\.startBackend\(\)/g) || []).length, 1, '不许起第二个后端进程')
})
