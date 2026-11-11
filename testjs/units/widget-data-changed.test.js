// =========================================================================
// widget-data-changed.test.js —— 挂件不能再只靠 5 分钟轮询发现数据变了
//                                （A5-02 / K1-02，§4-4）
//
// 判据分三层：
//   ① 纯判定：哪些写要广播、广播哪些域、同一次请求只播一次；
//   ② 中继行为：to-widget 必须同时发到工具箱浮窗与桌面挂件，坏窗口不挡其它窗口；
//   ③ 接线源码：主窗口开启广播、成功拦截器真调、挂件真订阅且资源可释放、
//      在途请求不能吞掉刷新、5 分钟轮询仍保留、不新增 IPC 通道名。
// 只测纯函数会假绿：广播发出去但中继没扇出到挂件，单元测试照样全绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/widgetDataChanged.js')).href
const { relayToWidgetWindows } = require(path.join(ROOT, 'electron/main/widget-relay.js'))
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const load = () => import(MODULE)

// 去注释：修复说明里会出现旧写法 / 通道名，判据不能被注释骗过
function code(rel) {
  return read(rel)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// —— ① 纯判定 ——

test('normalizeApiPath：去掉 origin / query / hash', async () => {
  const { normalizeApiPath } = await load()
  assert.equal(normalizeApiPath('http://127.0.0.1:3000/api/students/3?x=1#y'), '/api/students/3')
  assert.equal(normalizeApiPath('/api/leaves?date=2026-11-11'), '/api/leaves')
})

test('读请求不广播；五个数据源的写各报自己的域', async () => {
  const { domainsForWrite, WIDGET_DOMAINS } = await load()
  assert.deepEqual(domainsForWrite('get', '/api/students'), [])
  const cases = {
    '/api/schedule/save': 'schedule',
    '/api/duty/save': 'duty',
    '/api/countdowns/3': 'countdowns',
    '/api/leaves/import': 'leaves',
    '/api/students/delete-with-relations': 'students',
  }
  for (const [url, domain] of Object.entries(cases)) {
    assert.deepEqual(domainsForWrite('post', url), [domain], url)
    assert.deepEqual(domainsForWrite('put', `http://127.0.0.1:3000${url}`), [domain], url)
    assert.deepEqual(domainsForWrite('delete', url), [domain], url)
  }
  assert.equal(WIDGET_DOMAINS.length, 5)
})

test('撤销/还原/AI 落表会让任意域变化 → 全量失效', async () => {
  const { domainsForWrite, WIDGET_DOMAINS } = await load()
  for (const url of ['/api/undo/12/undo', '/api/undo', '/api/restore-offline', '/api/ai/apply-batch', '/api/ai/doc']) {
    assert.deepEqual(domainsForWrite('post', url), [...WIDGET_DOMAINS], url)
  }
})

test('聊天/相册/账户/导出等基础设施写不广播（否则每条消息都白打 5 个 GET）', async () => {
  const { domainsForWrite } = await load()
  for (const url of [
    '/api/ai/conversations/1/messages', '/api/ai/chat', '/api/album/photo/1',
    '/api/account/export-zip', '/api/login', '/api/secure/handshake',
    '/api/search?q=zs', '/api/widget-settings', '/api/data/zip',
  ]) {
    assert.deepEqual(domainsForWrite('post', url), [], url)
  }
})

test('未知的业务写保守地全量失效（新路由忘登记只是多刷一次，不是滞后 5 分钟）', async () => {
  const { domainsForWrite, WIDGET_DOMAINS } = await load()
  assert.deepEqual(domainsForWrite('patch', '/api/new-business-table/1'), [...WIDGET_DOMAINS])
  assert.deepEqual(domainsForWrite('post', '/static/index.html'), [])
})

test('广播器：只播一次、形状固定、send 抛错也不能把成功的写变成失败', async () => {
  const { createWidgetDataChangedAnnouncer } = await load()
  const sent = []
  const a = createWidgetDataChangedAnnouncer((p) => sent.push(p))
  const config = { method: 'post', url: '/api/students' }
  const payload = a.announce(config)
  assert.deepEqual(payload, { type: 'data-changed', domains: ['students'] })
  assert.equal(a.announce(config), null, '安全通道重试复用同一 config，不能重复广播')
  assert.deepEqual(sent, [payload])

  assert.equal(a.announce({ method: 'get', url: '/api/students' }), null)
  assert.equal(a.announce({ method: 'post', url: '/api/ai/chat' }), null)
  assert.equal(a.announce({ method: 'post', url: '/api/students', __skipDataChanged: true }), null)
  assert.equal(a.announce(null), null)
  assert.equal(sent.length, 1)

  const broken = createWidgetDataChangedAnnouncer(() => { throw new Error('窗口还没建好') })
  assert.doesNotThrow(() => broken.announce({ method: 'put', url: '/api/duty/save' }))
})

// —— ② 中继行为 ——

test('to-widget 中继：两个窗口都收到，销毁中的窗口跳过且不影响另一个', () => {
  const calls = []
  const win = (name, destroyed = false, throws = false) => ({
    isDestroyed: () => destroyed,
    webContents: { send: (channel, data) => {
      if (throws) throw new Error('render-process-gone')
      calls.push([name, channel, data])
    } },
  })
  const payload = { type: 'data-changed', domains: ['schedule'] }
  // crashed 放在 desktop 之前：单个窗口抛错不能挡住后面那个窗口
  const n = relayToWidgetWindows(payload, [
    win('toolbox'), win('closed', true), win('crashed', false, true), win('desktop'), null,
  ])
  assert.equal(n, 2)
  assert.deepEqual(calls, [
    ['toolbox', 'from-main', payload],
    ['desktop', 'from-main', payload],
  ])
})

// —— ③ 接线（源码判据）——

test('接线：只有主窗口开启广播，且成功拦截器真的调用它', () => {
  const main = code('student-frontend/src/main.js')
  assert.match(main, /setupApiClient\(\{[\s\S]*?announceDataChanged:\s*true/)

  const client = code('student-frontend/src/utils/httpClient.js')
  assert.match(client, /import \{ createWidgetDataChangedAnnouncer \} from '\.\/widgetDataChanged\.js'/)
  assert.match(client, /if \(announceDataChanged\) widgetDataChanged\.announce\(res\.config\)/)
  assert.match(client, /window\.electron\.send\(SEND\.TO_WIDGET, payload\)/)

  for (const rel of [
    'student-frontend/src/subwindows/setup/main.js',
    'student-frontend/src/subwindows/widget/main.js',
    'student-frontend/src/subwindows/desktop-widget/main.js',
  ]) {
    assert.ok(!/announceDataChanged:\s*true/.test(code(rel)), `${rel} 不该广播（会产生回声）`)
  }
})

test('接线：主进程中继把桌面挂件放进同一张窗口表', () => {
  const widgetMain = code('electron/main/main.widget.js')
  assert.match(widgetMain, /require\('\.\/widget-relay'\)/)
  assert.match(widgetMain, /ipcMain\.on\('to-widget'[\s\S]*?relayToWidgetWindows\(data, \[widgetWindow, desktopWidgetWindow\]\)/)

  // 不新增 IPC 通道名：data-changed 是 from-main 消息里的 type，不是新通道
  const channels = JSON.parse(read('electron/ipc-channels.json'))
  assert.deepEqual(channels.receive, ['from-main'])
  assert.ok(channels.send.includes('to-widget'))
  assert.ok(!JSON.stringify(channels).includes('data-changed'))
})

test('接线：挂件真订阅、防抖、并在卸载时配对 off', () => {
  const dw = code('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')
  assert.match(dw, /import \{ INVOKE, SEND, RECEIVE \} from '\.\.\/\.\.\/electronChannels\.js'/)
  assert.match(dw, /data\.type !== 'data-changed'/)
  // defer() 返回的是调度函数本身，必须直接调用；写成 .schedule(...) 会在收到通知时抛
  // TypeError（挂件一直不刷新，2026-11-11 真机日志实锤）。
  assert.match(dw, /scheduleDataRefresh\(\(\) => loadAll\(\), 200\)/)
  assert.doesNotMatch(dw, /scheduleDataRefresh\.schedule/, 'defer() 的返回值不是 { schedule } 对象')
  assert.match(dw, /const scheduleDataRefresh = disposables\.defer\(\)/, '必须用 defer（timeout 的返回函数不清定时器）')
  assert.match(dw, /window\.electron\.on\(RECEIVE\.FROM_MAIN, onFromMain\)/)
  assert.match(dw, /disposables\.add\(\(\) => window\.electron\.off\(RECEIVE\.FROM_MAIN, fromMainHandler\)\)/)
  assert.match(dw, /disposables\.interval\(loadAll, 5 \* 60 \* 1000\)/, '5 分钟兜底轮询不能被删')
})

test('接线：在途轮询不能吞掉这次刷新（补拉链路）', () => {
  const dw = code('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')
  assert.match(dw, /if \(loadingAll\) \{ refreshPending = true; return \}/)
  assert.match(dw, /if \(refreshPending\) \{\s*refreshPending = false\s*loadAll\(\)/)
  assert.match(dw, /refreshPending = false/, '换号时也要清掉待刷新标记')
})
