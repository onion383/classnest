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
const { abs, read } = require('#testjs/paths')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const {
  analyze, walk, keyName, memberPath, findFunction, scriptBlocks,
} = require('#testjs/source-scan')

const MODULE = pathToFileURL(abs('student-frontend/src/utils/widgetDataChanged.js')).href
const { relayToWidgetWindows } = require(abs('electron/main/widget-relay.js'))
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
// 为什么从「正则配空格」改成 AST：
//   旧判据把 `if (announceDataChanged) widgetDataChanged.announce(res.config)`、
//   `if (loadingAll) { refreshPending = true; return }` 这类原文（含分号与空格）焊死，
//   一格式化就假红；而 `[\s\S]*?` 又会被注释/字符串里的同名文本骗过（漏报）。
//   AST 看的是真实调用/真实 if 结构，与缩进、空格、引号无关。

const astOf = (rel) => analyze(rel.endsWith('.vue') ? scriptBlocks(read(rel)) : read(rel)).ast
const propOf = (obj, name) => (obj.properties || []).find(
  (p) => p.type === 'ObjectProperty' && keyName(p.key) === name,
) || null
const isCallTo = (node, path) => node.type === 'CallExpression' && memberPath(node.callee) === path
const hasReturn = (node) => {
  let hit = false
  walk(node, (n) => { if (n.type === 'ReturnStatement') hit = true })
  return hit
}
function evalNumeric(node) {
  if (!node) return null
  if (node.type === 'NumericLiteral') return node.value
  if (node.type === 'BinaryExpression') {
    const a = evalNumeric(node.left)
    const b = evalNumeric(node.right)
    if (a == null || b == null) return null
    if (node.operator === '*') return a * b
    if (node.operator === '+') return a + b
    if (node.operator === '-') return a - b
    if (node.operator === '/') return a / b
  }
  return null
}

// setupApiClient({ announceDataChanged: true }) 里的开关值
function announceFlag(ast) {
  let value = null
  walk(ast.program, (node) => {
    if (!isCallTo(node, 'setupApiClient')) return
    const arg = node.arguments[0]
    if (!arg || arg.type !== 'ObjectExpression') return
    const p = propOf(arg, 'announceDataChanged')
    if (p && p.value.type === 'BooleanLiteral') value = p.value.value
  })
  return value
}

test('接线：只有主窗口开启广播，且成功拦截器真的调用它', () => {
  assert.equal(announceFlag(astOf('student-frontend/src/main.js')), true,
    '主窗口必须 setupApiClient({ announceDataChanged: true })')

  const client = astOf('student-frontend/src/utils/httpClient.js')
  let importDecl = null
  walk(client.program, (node) => {
    if (node.type === 'ImportDeclaration' && node.source.value === './widgetDataChanged.js') importDecl = node
  })
  assert.ok(importDecl, 'httpClient 必须从 widgetDataChanged.js 引入广播器')
  assert.ok(importDecl.specifiers.some((s) => s.type === 'ImportSpecifier'
    && (s.imported.name || s.imported.value) === 'createWidgetDataChangedAnnouncer'),
  'httpClient 必须引入 createWidgetDataChangedAnnouncer')

  // 成功拦截器里必须「在 if (announceDataChanged) 保护下」调用 announce(res.config)
  let guardedAnnounce = false
  walk(client.program, (node) => {
    if (!isCallTo(node, 'widgetDataChanged.announce')) return
    const arg = node.arguments[0]
    if (!arg || memberPath(arg) !== 'res.config') return
    guardedAnnounce = true
  })
  assert.ok(guardedAnnounce, '成功拦截器必须调用 widgetDataChanged.announce(res.config)')
  let hasGuardIf = false
  walk(client.program, (node) => {
    if (node.type === 'IfStatement' && node.test.type === 'Identifier' && node.test.name === 'announceDataChanged') {
      hasGuardIf = true
    }
  })
  assert.ok(hasGuardIf, '广播开关不能是死值：要按 announceDataChanged 判断')

  let sendsToWidget = false
  walk(client.program, (node) => {
    if (!isCallTo(node, 'window.electron.send')) return
    const [ch, payload] = node.arguments
    if (ch && memberPath(ch) === 'SEND.TO_WIDGET' && payload && memberPath(payload) === 'payload') {
      sendsToWidget = true
    }
  })
  assert.ok(sendsToWidget, '中继必须把 payload 发到 SEND.TO_WIDGET')

  for (const rel of [
    'student-frontend/src/subwindows/setup/main.js',
    'student-frontend/src/subwindows/widget/main.js',
    'student-frontend/src/subwindows/desktop-widget/main.js',
  ]) {
    assert.notEqual(announceFlag(astOf(rel)), true, `${rel} 不该广播（会产生回声）`)
  }
})

test('接线：主进程中继把桌面挂件放进同一张窗口表', () => {
  const widgetMain = astOf('electron/main/main.widget.js')
  let relayCall = null
  walk(widgetMain.program, (node) => {
    if (!isCallTo(node, 'relayToWidgetWindows')) return
    const second = node.arguments[1]
    if (!second || second.type !== 'ArrayExpression') return
    const names = second.elements.map((e) => (e && e.type === 'Identifier' ? e.name : null))
    if (names.includes('widgetWindow') && names.includes('desktopWidgetWindow')) relayCall = node
  })
  assert.ok(relayCall, '主进程必须把 widgetWindow 与 desktopWidgetWindow 一起交给 relayToWidgetWindows')

  // 不新增 IPC 通道名：data-changed 是 from-main 消息里的 type，不是新通道
  const channels = JSON.parse(read('electron/ipc-channels.json'))
  assert.deepEqual(channels.receive, ['from-main'])
  assert.ok(channels.send.includes('to-widget'))
  assert.ok(!JSON.stringify(channels).includes('data-changed'))
})

test('接线：挂件真订阅、防抖、并在卸载时配对 off', () => {
  const dw = astOf('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')
  let channelsImport = null
  walk(dw.program, (node) => {
    if (node.type === 'ImportDeclaration' && node.source.value === '../../electronChannels.js') channelsImport = node
  })
  assert.ok(channelsImport, '挂件必须从 electronChannels.js 引入通道名')
  const imported = new Set(channelsImport.specifiers
    .filter((s) => s.type === 'ImportSpecifier')
    .map((s) => (s.imported.name || s.imported.value)))
  for (const n of ['INVOKE', 'SEND', 'RECEIVE']) assert.ok(imported.has(n), `挂件应引入 ${n}`)

  const onFromMain = findFunction(dw, 'onFromMain')
  assert.ok(onFromMain, '挂件应有 onFromMain 处理函数')
  // data.type !== 'data-changed' 时直接 return，不刷新
  let typeGuard = false
  walk(onFromMain.node, (node) => {
    if (node.type !== 'IfStatement') return
    // 判据可能是 `!data || data.type !== 'data-changed'`，在 test 子树里找那次比较
    let filtersType = false
    walk(node.test, (t) => {
      if (t.type === 'BinaryExpression' && t.operator === '!=='
        && memberPath(t.left) === 'data.type'
        && t.right.type === 'StringLiteral' && t.right.value === 'data-changed') filtersType = true
    })
    if (filtersType && hasReturn(node.consequent)) typeGuard = true
  })
  assert.ok(typeGuard, '收到 from-main 时要按 data.type 过滤，只处理 data-changed')

  // defer() 返回的是调度函数本身，必须直接调用；写成 .schedule(...) 会在收到通知时抛
  // TypeError（挂件一直不刷新，2026-11-11 真机日志实锤）。
  let scheduleCall = null
  walk(onFromMain.node, (node) => {
    if (!isCallTo(node, 'scheduleDataRefresh')) return
    const [fn, delay] = node.arguments
    if (fn && fn.type === 'ArrowFunctionExpression' && delay && evalNumeric(delay) === 200) scheduleCall = node
  })
  assert.ok(scheduleCall, '收到 data-changed 后应 scheduleDataRefresh(() => loadAll(), 200)')
  let schedulesLoadAll = false
  walk(scheduleCall.arguments[0].body, (node) => {
    if (isCallTo(node, 'loadAll')) schedulesLoadAll = true
  })
  assert.ok(schedulesLoadAll, '防抖回调必须调用 loadAll')

  let badScheduleMember = false
  walk(dw.program, (node) => {
    if (node.type === 'MemberExpression' && memberPath(node) === 'scheduleDataRefresh.schedule') badScheduleMember = true
  })
  assert.ok(!badScheduleMember, 'defer() 的返回值不是 { schedule } 对象')

  let deferDecl = null
  walk(dw.program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'scheduleDataRefresh') {
      deferDecl = node
    }
  })
  assert.ok(deferDecl && deferDecl.init && isCallTo(deferDecl.init, 'disposables.defer'),
    '必须用 defer()（timeout 的返回函数不清定时器）')

  let subscribes = false
  let unsubscribes = false
  let fiveMinPoll = false
  walk(dw.program, (node) => {
    if (isCallTo(node, 'window.electron.on')) {
      const [ch, handler] = node.arguments
      if (ch && memberPath(ch) === 'RECEIVE.FROM_MAIN' && handler && memberPath(handler) === 'onFromMain') subscribes = true
    }
    if (isCallTo(node, 'disposables.interval')) {
      const [fn, ms] = node.arguments
      if (fn && memberPath(fn) === 'loadAll' && evalNumeric(ms) === 300000) fiveMinPoll = true
    }
  })
  assert.ok(subscribes, '必须 window.electron.on(RECEIVE.FROM_MAIN, onFromMain)')
  // 卸载时配对 off（用 fromMainHandler 引用），否则热切换后回调越积越多
  walk(dw.program, (node) => {
    if (!isCallTo(node, 'disposables.add')) return
    const fn = node.arguments[0]
    if (!fn || !fn.body) return
    walk(fn.body, (inner) => {
      if (!isCallTo(inner, 'window.electron.off')) return
      const [ch, handler] = inner.arguments
      if (ch && memberPath(ch) === 'RECEIVE.FROM_MAIN' && handler && memberPath(handler) === 'fromMainHandler') unsubscribes = true
    })
  })
  assert.ok(unsubscribes, '卸载时必须配对 window.electron.off(RECEIVE.FROM_MAIN, fromMainHandler)')
  assert.ok(fiveMinPoll, '5 分钟兜底轮询不能被删')
})

test('接线：在途轮询不能吞掉这次刷新（补拉链路）', () => {
  const dw = astOf('student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue')
  const loadAll = findFunction(dw, 'loadAll')
  assert.ok(loadAll, '挂件应有 loadAll')

  let pendingSet = false
  let drain = false
  walk(loadAll.node, (node) => {
    if (node.type !== 'IfStatement') return
    if (node.test.type === 'Identifier' && node.test.name === 'loadingAll') {
      const c = node.consequent
      let setsPending = false
      walk(c, (inner) => {
        if (inner.type === 'AssignmentExpression' && memberPath(inner.left) === 'refreshPending'
          && inner.right.type === 'BooleanLiteral' && inner.right.value === true) setsPending = true
      })
      if (setsPending && hasReturn(c)) pendingSet = true
    }
    if (node.test.type === 'Identifier' && node.test.name === 'refreshPending') {
      const c = node.consequent
      let clears = false
      let reloads = false
      walk(c, (inner) => {
        if (inner.type === 'AssignmentExpression' && memberPath(inner.left) === 'refreshPending'
          && inner.right.type === 'BooleanLiteral' && inner.right.value === false) clears = true
        if (isCallTo(inner, 'loadAll')) reloads = true
      })
      if (clears && reloads) drain = true
    }
  })
  assert.ok(pendingSet, '轮询在途时要置 refreshPending = true 并 return（不能直接吞掉通知）')
  assert.ok(drain, 'finally 里要按 refreshPending 再补拉一次')

  let clears = 0
  walk(dw.program, (node) => {
    if (node.type === 'AssignmentExpression' && memberPath(node.left) === 'refreshPending'
      && node.right.type === 'BooleanLiteral' && node.right.value === false) clears++
  })
  assert.ok(clears >= 2, '换号时也要清掉待刷新标记（refreshPending = false 至少两处）')
})
