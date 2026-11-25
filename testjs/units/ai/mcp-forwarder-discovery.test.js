// =========================================================================
// mcp-forwarder-discovery.test.js —— 端口顺延后 MCP 客户端还能不能找到后端
//
// 背景：后端首选端口被占用时会顺延（app.js MAX_PORT_TRIES），而客户端配置里的
// CLASSNEST_MCP_URL 是复制那一刻的快照。转发器必须能靠端口发现文件自愈，
// 否则「端口换一个数字」就会让已配好的 Claude Desktop 永久连不上。
//
// 只测纯函数会假绿，所以同时断言接线：主进程写文件 / 设置页传路径 / 转发器读文件。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const discovery = require(abs('student-backend/mcpForwarderDiscovery.cjs'))

const { readRuntimePort, originOf, buildCandidates, guessRuntimeFiles } = discovery

test('候选顺序：env 显式配置 > 端口发现文件 > 默认端口（变异反证）', () => {
  const got = buildCandidates({
    envUrl: 'http://127.0.0.1:3000/mcp',
    runtimeEntries: [{ mcpUrl: 'http://127.0.0.1:3005/mcp' }],
    defaultPort: 3000,
  })
  assert.deepEqual(got, ['http://127.0.0.1:3000/mcp', 'http://127.0.0.1:3005/mcp'])

  // 把 env 挪到后面这条就会变：显式配置必须永远排第一，否则用户手填的地址会被静默忽略
  const onlyRuntime = buildCandidates({ runtimeEntries: [{ port: 3011 }], defaultPort: 3000 })
  assert.deepEqual(onlyRuntime, ['http://127.0.0.1:3011/mcp', 'http://127.0.0.1:3000/mcp'])
})

test('候选去重：env 与发现文件指向同一地址时不重复试连', () => {
  const got = buildCandidates({
    envUrl: 'http://127.0.0.1:3000/mcp',
    runtimeEntries: [{ mcpUrl: 'http://127.0.0.1:3000/mcp' }],
    defaultPort: 3000,
  })
  assert.equal(got.length, 1, '同一个地址不应重复出现')
})

test('端口发现文件三种形态都能解析（mcpUrl / origin / port）', () => {
  assert.equal(originOf({ mcpUrl: 'http://127.0.0.1:3009/mcp' }), 'http://127.0.0.1:3009/mcp')
  assert.equal(originOf({ origin: 'http://127.0.0.1:3009/' }), 'http://127.0.0.1:3009/mcp')
  assert.equal(originOf({ port: 3009 }), 'http://127.0.0.1:3009/mcp')
  assert.equal(originOf(null), '')
  assert.equal(originOf({}), '')
})

test('半写入 / 损坏 / 缺失的文件都当没有，不能让转发器崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-runtime-'))
  const good = path.join(dir, 'good.json')
  const broken = path.join(dir, 'broken.json')
  const empty = path.join(dir, 'empty.json')
  fs.writeFileSync(good, JSON.stringify({ port: 3012, mcpUrl: 'http://127.0.0.1:3012/mcp' }))
  fs.writeFileSync(broken, '{"port": 30')
  fs.writeFileSync(empty, '')

  assert.equal(readRuntimePort(good).port, 3012)
  assert.equal(readRuntimePort(broken), null)
  assert.equal(readRuntimePort(empty), null)
  assert.equal(readRuntimePort(path.join(dir, 'nope.json')), null)
  assert.equal(readRuntimePort(''), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('老配置没有 runtime 路径时，按平台猜常见 userData 目录', () => {
  const win = guessRuntimeFiles({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')
  assert.ok(win.length >= 1)
  assert.ok(win.every((p) => p.endsWith('runtime-port.json')), '每个候选都应是 runtime-port.json')
  assert.ok(win.some((p) => /classnest/i.test(p)), '至少要覆盖 package.json name 对应的目录')

  const linux = guessRuntimeFiles({ HOME: '/home/x' }, 'linux')
  assert.ok(linux.every((p) => p.endsWith('runtime-port.json')))
})

// ==================== 接线：三处必须同时存在，否则自愈链路是断的 ====================
test('接线：主进程写文件、设置页传路径、转发器读文件', () => {
  const backend = read('electron/main/main.backend.js')
  assert.match(backend, /function writeRuntimePortFile\(/, '主进程必须写端口发现文件')
  assert.match(backend, /writeRuntimePortFile\(msg\.port\)/, '后端回报端口时要落盘')
  assert.match(backend, /runtimeFilePath: resolveRuntimePortPath\(\)/, '设置页要能拿到文件路径')

  const config = read('electron/main/main.config.js')
  assert.match(config, /function resolveRuntimePortPath\(\)/, '路径只能有一个来源')
  assert.match(config, /app\.getPath\('userData'\)/, '必须固定在 userData 根，不能挂 dataDir')
  assert.match(config, /resolveRuntimePortPath,/, '要导出给 backend 用')

  const dialog = read('student-frontend/src/components/data-manage/McpTokensDialog.vue')
  assert.match(dialog, /CLASSNEST_RUNTIME_FILE/, '生成的客户端配置要带文件路径')
  assert.match(dialog, /backendOrigin\(\)/, 'MCP 地址要用运行期 origin，不能用模块级快照')

  const forwarder = read('student-backend/mcp-forwarder.cjs')
  assert.match(forwarder, /require\('\.\/mcpForwarderDiscovery\.cjs'\)/, '转发器必须复用发现逻辑')
  assert.match(forwarder, /resolveCandidates\(\)/, '候选地址要按 env → 文件 → 默认 顺序组装')
  assert.match(forwarder, /CLASSNEST_RUNTIME_FILE/, '转发器要认文件路径这个 env')
  assert.doesNotMatch(forwarder, /const URL_ = /, '不能再用顶层一次性解析的地址')
})
