// =========================================================================
// todo-realtime.test.js —— 写成功后标题栏待办要立刻重拉，不能等 10 分钟
//
// 判定逻辑单独成模块、在 node 里真跑（不是只扫源码字符串）：
//   · 写请求默认触发，新增写入口不会漏；
//   · 高频且无关的写（AI 聊天、相册、认证）排掉；
//   · /api/ai/doc 与 apply-batch 虽在 /api/ai 下，但会建档，必须捞回来；
//   · 同一个 config 只播一次（安全通道 / 重试会复用 config 再走一遍拦截器）。
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SRC = path.join(__dirname, '../../student-frontend/src')
const invalidatorPath = pathToFileURL(path.join(SRC, 'utils/todoInvalidator.js')).href
const loadInvalidator = () => import(invalidatorPath)

test('写请求默认触发：新增业务写入口不用登记也能实时刷新', async () => {
  const { shouldInvalidateTodo } = await loadInvalidator()
  for (const url of [
    '/api/leaves/3/return', '/api/scores', '/api/seats/cell', '/api/duty',
    '/api/group-manage/groups/1/members', '/api/cadres', '/api/students/provisional/convert',
    '/api/undo/undo', '/api/new-future-endpoint',
  ]) {
    assert.equal(shouldInvalidateTodo('POST', url), true, `${url} 会改待办数据`)
  }
  for (const m of ['put', 'PATCH', 'delete']) {
    assert.equal(shouldInvalidateTodo(m, '/api/leaves/1'), true, `${m} 也是写`)
  }
})

test('读请求与带 query / origin 的写路径判定正确', async () => {
  const { shouldInvalidateTodo } = await loadInvalidator()
  assert.equal(shouldInvalidateTodo('GET', '/api/leaves'), false)
  assert.equal(shouldInvalidateTodo('HEAD', '/api/leaves'), false)
  assert.equal(shouldInvalidateTodo('POST', 'http://localhost:3000/api/seats/cell?x=1'), true)
  assert.equal(shouldInvalidateTodo('post', '/api/scores/import#top'), true)
  assert.equal(shouldInvalidateTodo('POST', '/static/app.js'), false, '非 API 不触发')
})

test('/api/ai 下的整块写会建档，必须捞回来；聊天不算', async () => {
  const { shouldInvalidateTodo } = await loadInvalidator()
  assert.equal(shouldInvalidateTodo('POST', '/api/ai/doc'), true, 'AI 写座位会建临时学生')
  assert.equal(shouldInvalidateTodo('POST', '/api/ai/apply-batch'), true, '批量落表也会建档')
  assert.equal(shouldInvalidateTodo('POST', '/api/ai/snapshot/restore'), true, '还原备份会换库内容')
  assert.equal(shouldInvalidateTodo('POST', '/api/ai/chat'), false, '发一条聊天消息不该刷待办')
})

test('与待办无关的高频写被排掉', async () => {
  const { shouldInvalidateTodo } = await loadInvalidator()
  for (const url of ['/api/album/scan', '/api/account/update', '/api/auth/login', '/api/search']) {
    assert.equal(shouldInvalidateTodo('POST', url), false, `${url} 不该触发`)
  }
})

test('同一个请求只广播一次，安全通道重试不会导致多次刷新', async () => {
  const { createTodoInvalidator } = await loadInvalidator()
  const emitted = []
  const inv = createTodoInvalidator(() => emitted.push(1))
  const config = { method: 'post', url: '/api/ai/doc' }
  assert.equal(inv.announce(config), true)
  assert.equal(inv.announce(config), false, '重试复用同一个 config，第二次跳过')
  assert.equal(emitted.length, 1)
})

test('显式跳过的请求不广播；发事件的异常不影响调用方', async () => {
  const { createTodoInvalidator } = await loadInvalidator()
  let n = 0
  const inv = createTodoInvalidator(() => { n++; throw new Error('window 还没就绪') })
  assert.equal(inv.announce({ method: 'post', url: '/api/seats', __skipTodoChanged: true }), false)
  assert.equal(n, 0)
  assert.equal(inv.announce({ method: 'post', url: '/api/seats' }), true)
  assert.equal(n, 1, '事件发出去抛错要吞掉，不能把一次成功的写变成失败')
})

test('接线：httpClient 在响应成功处广播，通知中心监听并保持轮询兜底', () => {
  const http = fs.readFileSync(path.join(SRC, 'utils/httpClient.js'), 'utf8')
  assert.match(http, /todoInvalidator\.announce\(res\.config\)/, '没接上写成功时机')
  assert.match(http, /dispatchEvent\(new CustomEvent\(TODO_CHANGED_EVENT\)\)/)

  const center = fs.readFileSync(path.join(SRC, 'composables/useTodoCenter.js'), 'utf8')
  assert.match(center, /disposables\.listen\(window, TODO_CHANGED_EVENT/, '通知中心没监听事件')
  assert.match(center, /refreshOverdueLeaveBadge\(\)[\s\S]*refreshProvisionalStudents\(\)/, '两类都要重拉，只刷一类会口径分裂')
  assert.match(center, /CHECK_INTERVAL = 10 \* 60 \* 1000/, '轮询兜底不能删 —— 事件可能丢')
  assert.match(center, /disposables\.defer\(\)/, 'debounce 必须用 defer()（它内部 clearTimeout），d.timeout 不 clearTimeout')
})


// ============ 行为判据：静态扫描证明不了「监听真的注册了」 ============

test('行为：事件到达后两类待办都真的重拉，且连发只算一次', async () => {
  // axios 同时有 CJS/ESM 两个入口；生产模块走 ESM 的 index.js，
  // 用 require('axios') mock 到的是另一个实例，请求根本不会被拦住。
  const axiosUrl = pathToFileURL(path.join(SRC, '../node_modules/axios/index.js')).href
  const axios = (await import(axiosUrl)).default
  const calls = []
  const oldAdapter = axios.defaults.adapter
  axios.defaults.adapter = async (config) => {
    calls.push(String(config.url || ''))
    return { data: { data: [] }, status: 200, statusText: 'OK', headers: {}, config }
  }

  const listeners = new Map()
  global.window = {
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
  }

  // 带 query 强制重新求值模块：disposables 是模块级状态，复用会让 start 直接 return
  const url = pathToFileURL(path.join(SRC, 'composables/useTodoCenter.js')).href + '?rt=' + Date.now()
  const m = await import(url)
  try {
    m.startTodoCenter()
    assert.ok(listeners.has('classnest:todo-changed'), '事件监听器必须真的注册上，不是只写在源码里')
    await new Promise((r) => setTimeout(r, 40))
    calls.length = 0

    // 连发三次（一次业务写可能带多个请求）。这里验的是「不会重复拉」这个结果，
    // 由 debounce 与两个 refresh 各自的 inflight 去重共同保证 —— 单测无法区分是谁的功劳。
    for (let i = 0; i < 3; i++) listeners.get('classnest:todo-changed')()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(calls.filter((u) => u === '/api/leaves').length, 1, '销假只拉一次')
    assert.equal(calls.filter((u) => u.includes('/api/students/provisional')).length, 1, '临时学生只拉一次')
  } finally {
    m.stopTodoCenter()
    axios.defaults.adapter = oldAdapter
    delete global.window
  }
})
