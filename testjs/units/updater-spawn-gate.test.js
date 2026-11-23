// =========================================================================
// updater-spawn-gate.test.js —— 更新安装器 spawn 失败不能让应用静默消失
//
// 根因：spawn() 的失败是异步 'error' 事件，同步 try/catch 抓不到。原实现 spawn 后
// 立即 app.isQuitting + app.quit()，exe 被删/权限不足时应用直接消失且无错误提示。
// 且退出前没等后端子进程停 —— 后端还占着数据库文件，安装器替换失败。
// 修法：监听 'spawn' 确认真的起来才走退出；'error' 先到则报错留在应用；退出前 await stopBackend。
//
// 判据：①真跑抽出的 spawn 逻辑，注入假 child 发 error/spawn 事件，验应用不退出/退出顺序；
//       ②接线判据：main.js 注入 stopBackend，registerUpdateIpc 接收 deps。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const UPDATER = path.join(ROOT, 'electron/main/main.updater.js')
const MAIN = path.join(ROOT, 'electron/main/main.js')

/** 抽出 spawn Promise 的**回调体**（`new Promise((resolve) => { ... })` 的大括号内容） */
function extractSpawnBlock(code) {
  const mark = 'await new Promise((resolve) => {'
  const start = code.indexOf(mark)
  assert.ok(start > 0, '找不到 spawn Promise')
  const brace = start + mark.length - 1 // 指向 '{'
  let depth = 0
  for (let i = brace; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(brace + 1, i)
    }
  }
  throw new Error('括号不配平')
}

function runSpawnBlock({ event, spawnThrows = false, stopBackendDelay = 0 }) {
  const code = fs.readFileSync(UPDATER, 'utf8')
  // 把 body 里的 require('child_process') 替换成注入的 spawn，让 new Function 环境能跑
  const body = extractSpawnBlock(code)
    .replace("const { spawn } = require('child_process')", 'const spawn = __spawn')
    .replace(/\bspawn\(resolved/g, 'spawn(resolved')
  const events = []
  let quitScheduled = false
  let stateError = null
  let launched = false
  const fakeApp = {
    set isQuitting(v) { events.push('isQuitting=' + v) },
    quit: () => { quitScheduled = true; events.push('quit') },
  }
  class FakeChild {
    constructor() { this.handlers = {} }
    once(evt, fn) { this.handlers[evt] = fn; return this }
    unref() { events.push('unref') }
    fire(evt, arg) { return this.handlers[evt] && this.handlers[evt](arg) }
  }
  const child = new FakeChild()
  const fakeSpawn = () => {
    if (spawnThrows) throw new Error('spawn 同步抛错')
    return child
  }
  const fn = new Function('app', 'spawn', '__spawn', 'setTimeout', 'setUpdateState', 'friendlyUpdateError', 'stopBackend', 'launchedRef', 'resolved', 'resolve', `
    ${body.replace(/launched = true/g, 'launchedRef.value = true')}
  `)
  // body 里已有 resolve（来自外层 new Promise），这里用 completed 信号等它
  const deps = {
    app: fakeApp,
    spawn: fakeSpawn,
    // quit 的 setTimeout 立即执行（验证退出顺序）；兜底的 10s setTimeout 不触发（本次事件都会来）
    setTimeout: (f, ms) => { if (ms === 500) { events.push('setTimeout(quit)'); f() } return 0 },
    setUpdateState: (p) => { if (p.error) stateError = p.error },
    friendlyUpdateError: (e) => 'ERR:' + (e && e.message),
    stopBackend: async () => { events.push('stopBackend:start'); await new Promise((r) => setTimeout(r, stopBackendDelay)); events.push('stopBackend:done') },
    launchedRef: { get value() { return launched }, set value(v) { launched = v } },
    resolved: '/fake/installer.exe',
  }
  let done
  // 判据自身兜底：变异（去掉 finish 调用）时不能让测试进程挂死，要干净转红
  const p = new Promise((r) => { done = r; setTimeout(() => r(), 500) })
  fn(deps.app, deps.spawn, deps.spawn, deps.setTimeout, deps.setUpdateState, deps.friendlyUpdateError,
    deps.stopBackend, deps.launchedRef, deps.resolved, done)
  // 触发事件（在 body 同步执行完 once 注册后）
  if (!spawnThrows && event === 'error') child.fire('error', new Error('exe 被删'))
  if (!spawnThrows && event === 'spawn') child.fire('spawn')
  return p.then(() => ({ events, quitScheduled, stateError, launched }))
}

test('spawn 异步 error：报错但不退出应用，不置 launched', async () => {
  const r = await runSpawnBlock({ event: 'error' })
  assert.ok(r.stateError && r.stateError.includes('exe 被删'), '必须把 spawn 错误报给用户')
  assert.equal(r.quitScheduled, false, 'spawn 失败绝不能退出应用')
  assert.equal(r.launched, false, 'spawn 失败不能置 launched')
  assert.ok(!r.events.includes('stopBackend:start'), '失败路径不该停后端')
})

test('spawn 成功：先停后端，再置退出标志并排退出', async () => {
  const r = await runSpawnBlock({ event: 'spawn' })
  assert.equal(r.stateError, null, '成功路径不该报错')
  assert.equal(r.launched, true, '成功要置 launched')
  const iStop = r.events.indexOf('stopBackend:done')
  const iQuitFlag = r.events.indexOf('isQuitting=true')
  const iQuitTimer = r.events.indexOf('setTimeout(quit)')
  assert.ok(iStop >= 0 && iQuitFlag > iStop && iQuitTimer > iQuitFlag,
    `顺序必须是 stopBackend → isQuitting → quit，实际：${r.events.join(' / ')}`)
  assert.equal(r.quitScheduled, true)
})

test('spawn 同步抛错：报错不退出', async () => {
  const r = await runSpawnBlock({ spawnThrows: true })
  assert.ok(r.stateError, '同步抛错也要报错')
  assert.equal(r.quitScheduled, false)
})

test('接线：main.js 注入 stopBackend，updater 接收 deps', () => {
  const updater = fs.readFileSync(UPDATER, 'utf8')
  const main = fs.readFileSync(MAIN, 'utf8')
  assert.match(updater, /function registerUpdateIpc\(send, deps = \{\}\)/, '注册函数要接收 deps')
  assert.match(updater, /deps\.stopBackend/, 'updater 要读注入的 stopBackend')
  assert.match(updater, /child\.once\('error'/, '必须监听异步 error')
  assert.match(updater, /child\.once\('spawn'/, '必须监听 spawn 确认')
  assert.match(updater, /await stopBackend\(\)/, '退出前必须 await 后端停止')
  assert.match(main, /registerUpdateIpc\([\s\S]{0,240}stopBackend:\s*\(\) => backend\.stopBackendProcess\(\)/, 'main.js 必须注入 stopBackend')
})
