// 桌面挂件「常用软件」保存：连续编辑必须按顺序落库（审查 v7 · #75）
//
// PUT /api/widget-settings/apps 是整体覆写。添加/删除/排序各自调一次 saveApps，
// 连续操作会并发发出多个请求；较早的请求若处理更慢、后到达，就把新列表写回旧状态
// （删掉的图标重开挂件又出现、排序回退）。这里把真实的 saveApps（含队列声明）
// 从 .vue 源码里抽出来，注入受控的 axios / ref / disposables 跑真实时序。
const test = require('node:test')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const { abs } = require('#testjs/paths')
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const VUE = abs('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')

// 从 `function name(` 起按大括号配平切出完整函数体（参数列表里可能有 `{}`，先跳过）
function loadSaveApps(src) {
  const fnSrc = extractFunctionDecl(src, 'saveApps')
  // 队列变量与函数一起抽：它们是一体的（队列就是 saveApps 的闭包状态）
  const queueDecl = 'let appsSaveQueue = Promise.resolve()'
  // @pin student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue#saveApps
  assert.ok(src.includes(queueDecl), 'saveApps 应当有串行队列（let appsSaveQueue）')
  const code = `${queueDecl}\n${fnSrc}`

  return function makeEnv({ loaded = true, apps = [], hints = [], timers = [] } = {}) {
    const calls = []
    // 注入的是同一个 ref 对象，测试改 env.apps.value 才会真的传给被测代码
    const appsRef = { value: apps }
    const axios = {
      put(url, body) {
        let resolveFn
        let rejectFn
        const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
        calls.push({ url, body, resolve: resolveFn, reject: rejectFn })
        return promise
      },
    }
    const factory = new Function(
      'axios', 'apps', 'appsLoaded', 'MAX_APPS', 'disposables', 'showHint',
      `${code}\nreturn saveApps;`,
    )
    const saveApps = factory(
      axios,
      appsRef,
      { value: loaded },
      8,
      { timeout: (fn, ms) => { timers.push({ fn, ms }); return () => {} } },
      (msg) => hints.push(msg),
    )
    return { saveApps, apps: appsRef, calls, hints, timers }
  }
}

// 让 .then / setTimeout(0) 全部跑完
const flush = () => new Promise((r) => setTimeout(r, 0))

const SRC = fs.readFileSync(VUE, 'utf8')

test('连续两次保存串行发出：第二个请求要等第一个有结果', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [{ name: 'A', path: 'a.exe' }] })

  env.saveApps()
  await flush()
  assert.equal(env.calls.length, 1, '首次保存应立即发出')

  env.saveApps()
  await flush()
  assert.equal(env.calls.length, 1, '前一个请求还在飞时，第二个必须排队（不能并发覆写）')

  env.calls[0].resolve({ data: { success: true } })
  await flush()
  assert.equal(env.calls.length, 2, '前一个落地后第二个才发出')
})

test('落库顺序 = 编辑顺序（后发的列表不会被先发的旧列表覆盖）', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [{ name: 'A', path: 'a.exe' }] })

  env.saveApps() // 列表 [A]
  await flush()
  env.apps.value = [{ name: 'A', path: 'a.exe' }, { name: 'B', path: 'b.exe' }]
  env.saveApps() // 列表 [A, B]
  await flush()

  // 第一个请求很慢，第二个已经排队
  env.calls[0].resolve({ data: { success: true } })
  await flush()
  env.calls[1].resolve({ data: { success: true } })
  await flush()

  assert.equal(env.calls.length, 2)
  assert.deepEqual(env.calls[0].body.desktopApps.map((x) => x.name), ['A'])
  assert.deepEqual(env.calls[1].body.desktopApps.map((x) => x.name), ['A', 'B'])
})

test('排队期间列表又变了：发出的是发出那一刻的列表，不是排队时的旧快照', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [{ name: 'A', path: 'a.exe' }] })

  env.saveApps()
  await flush()
  env.saveApps() // 此时列表还是 [A]
  env.apps.value = [{ name: 'A', path: 'a.exe' }, { name: 'C', path: 'c.exe' }]
  await flush()

  env.calls[0].resolve({ data: { success: true } })
  await flush()

  assert.deepEqual(env.calls[1].body.desktopApps.map((x) => x.name), ['A', 'C'],
    '排队任务发出时应重取当前列表')
})

test('前一个保存失败不会卡死后续保存', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [{ name: 'A', path: 'a.exe' }] })
  env.saveApps()
  await flush()
  env.calls[0].reject(new Error('网络断了'))
  await flush()

  env.saveApps()
  await flush()
  assert.equal(env.calls.length, 2, '失败链路必须被吞掉，否则队列永久卡住')
  // 失败会排一个 2s 后的重试
  assert.equal(env.timers.length, 1, '失败应当登记一次重试')
  assert.equal(env.timers[0].ms, 2000)
  env.calls[1].resolve({ data: { success: true } })
})

test('重试走 disposables 登记的定时器，且在阅读成功前不写入', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [{ name: 'A', path: 'a.exe' }] })
  env.saveApps()
  await flush()
  env.calls[0].reject(new Error('500'))
  await flush()
  env.timers[0].fn()
  await flush()
  assert.equal(env.calls.length, 2, '重试应当真的再发一次')
  env.calls[1].resolve({ data: { success: true } })

  // 未成功读取过：一次请求都不该发（否则用空列表覆盖库里的内容）
  const blank = makeEnv({ loaded: false, apps: [] })
  blank.saveApps()
  await flush()
  assert.equal(blank.calls.length, 0, 'appsLoaded=false 时绝不写入')
})

test('连续三次编辑：请求逐个发出，最后一个请求带着最终列表', async () => {
  const makeEnv = loadSaveApps(SRC)
  const env = makeEnv({ apps: [] })

  env.apps.value = [{ name: 'A', path: 'a' }]
  env.saveApps()
  env.apps.value = [{ name: 'A', path: 'a' }, { name: 'B', path: 'b' }]
  env.saveApps()
  env.apps.value = [{ name: 'B', path: 'b' }]
  env.saveApps()

  for (let i = 0; i < 3; i += 1) {
    await flush()
    assert.equal(env.calls.length, i + 1, `第 ${i + 1} 个请求应在第 ${i} 个落地后才发出`)
    env.calls[i].resolve({ data: { success: true } })
  }
  await flush()

  // 排队中的任务在发出时才取列表，所以三个请求可能带同一份（已是最新）列表 ——
  // 关键是「最后落库的必须是最后一次编辑」且没有并发覆写。
  assert.deepEqual(env.calls[2].body.desktopApps.map((x) => x.name), ['B'],
    '最后落库的必须是最后一次编辑的状态')
})
