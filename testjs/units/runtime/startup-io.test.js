// =========================================================================
// startup-io.test.js —— 启动期同步 IO 打点（v6 性能专题 · 1-10）
//
// 验收点：
//   ① 默认（PERF_STARTUP 未开）不安装：传 enabled:false 时一个 fs 方法都不替换；
//   ② 开启后按方法计数、返回值与异常原样透传（计时不能改变语义）；
//   ③ summarize 打印合计并把 mark 写进启动时间线；重复 install 不叠加。
// 另外锁接线：main.js 必须在业务模块 require 之前安装，summary 必须在 report 之前。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const io = require(abs('electron/main/main.startup-io'))
const timer = require(abs('electron/main/main.startup-timer'))
const {
  analyze, walk, keyName, memberPath, findFunction, scriptBlocks,
} = require('#testjs/source-scan')

// 源码判据统一走 AST：
//   旧的 indexOf('函数名') + slice(n, n + 700/900/4000) 绑定「函数名写法 + 代码长度」，
//   前面加一行注释、函数变长或改成别的函数形式就切空（假红）或截到隔壁代码（漏报）。
//   AST 给出真实节点范围，顺序比较用 node.start，与空格/缩进/注释无关。
function srcOf(rel) { return fs.readFileSync(abs(rel), 'utf8') }
function astOf(rel) { return analyze(rel.endsWith('.vue') ? scriptBlocks(srcOf(rel)) : srcOf(rel)).ast }
const isCallTo = (node, path) => node.type === 'CallExpression' && memberPath(node.callee) === path
function findCalls(node, path) {
  const out = []
  walk(node, (n) => { if (isCallTo(n, path)) out.push(n) })
  return out
}
function findVar(ast, name) {
  let found = null
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name) found = n
  })
  return found
}
function arrayOf(ast, name) {
  const decl = findVar(ast, name)
  return decl && decl.init && decl.init.type === 'ArrayExpression' ? decl.init : null
}
const stringValues = (arr) => (arr.elements || [])
  .filter((e) => e && e.type === 'StringLiteral')
  .map((e) => e.value)

function fakeFs(overrides = {}) {
  return {
    existsSync: Object.assign(() => true, overrides.existsSync || {}),
    readFileSync: Object.assign(() => 'content', overrides.readFileSync || {}),
    mkdirSync: () => undefined,
  }
}

test('开关未开启时不安装，fs 方法保持原引用', () => {
  io.reset()
  const f = fakeFs()
  const orig = f.existsSync
  assert.equal(io.install(f, { enabled: false }), false)
  assert.equal(f.existsSync, orig)
  assert.equal(io.isInstalled(), false)
  assert.deepEqual(io.collect(), { calls: 0, ms: 0, rows: [] })
})

test('开启后按方法计数，返回值与异常原样透传', () => {
  io.reset()
  const f = fakeFs()
  f.readFileSync = () => { throw new Error('boom') }
  assert.equal(io.install(f, { enabled: true }), true)
  assert.equal(io.isInstalled(), true)

  // 返回值透传
  assert.equal(f.existsSync('a'), true)
  assert.equal(f.mkdirSync('d'), undefined)
  // 异常透传，但仍然计数
  assert.throws(() => f.readFileSync('b'), /boom/)

  const r = io.collect()
  assert.equal(r.calls, 3)
  assert.ok(r.ms >= 0)
  const byName = Object.fromEntries(r.rows.map((x) => [x.name, x.count]))
  assert.equal(byName.existsSync, 1)
  assert.equal(byName.mkdirSync, 1)
  assert.equal(byName.readFileSync, 1)
})

test('重复 install 不叠加，summarize 打印合计并写入启动时间线', () => {
  io.reset()
  const f = fakeFs()
  assert.equal(io.install(f, { enabled: true }), true)
  assert.equal(io.install(f, { enabled: true }), false, '第二次安装应被忽略')

  f.existsSync('a')
  const lines = []
  const r = io.summarize({ console: { log: (s) => lines.push(String(s)) } })
  assert.ok(r, 'summarize 应返回汇总')
  assert.equal(r.calls, 1)
  assert.match(lines[0], /^\[boot\] 同步IO合计 /)
  assert.ok(lines.some((l) => /fs\.existsSync .* × 1$/.test(l)))

  const timeline = timer.getTimeline()
  assert.ok(
    timeline.marks.some((m) => m.label.startsWith('同步IO合计 ')),
    '时间线里必须有一条同步 IO 合计 mark'
  )
})

test('未安装时 summarize 是空操作', () => {
  io.reset()
  assert.equal(io.summarize({ console: { log: () => { throw new Error('不该打印') } } }), null)
})

test('接线判据：安装了 main.js，且顺序正确', () => {
  const ast = astOf('electron/main/main.js')
  const install = findCalls(ast.program, 'startupIo.install')[0]
  const mkdir = findCalls(ast.program, 'fs.mkdirSync')[0]
  assert.ok(install, 'main.js 必须调用 startupIo.install(fs)')
  assert.ok(mkdir, 'main.js 必须保留启动路径上的首个同步 IO（node-compile-cache 建目录）')
  assert.ok(mkdir.start > install.start, '安装必须早于首个同步 IO 调用（node-compile-cache 建目录）')

  const summarize = findCalls(ast.program, 'startupIo.summarize')[0]
  const report = findCalls(ast.program, 'startupTimer.report')[0]
  assert.ok(summarize, '启动收尾里必须调用 startupIo.summarize()')
  assert.ok(report, '启动收尾里必须调用 startupTimer.report()')
  assert.ok(report.start > summarize.start, 'summarize 必须早于 report，否则时间线漏这条')

  // 默认必须由 PERF_STARTUP 开关门控（默认零开销）：`PERF_STARTUP === '1'` 的真实比较节点
  const impl = astOf('electron/main/main.startup-io.js')
  let gated = false
  walk(impl.program, (node) => {
    if (node.type === 'BinaryExpression' && node.operator === '==='
      && memberPath(node.left) === 'process.env.PERF_STARTUP'
      && node.right.type === 'StringLiteral' && node.right.value === '1') gated = true
  })
  assert.ok(gated, '默认必须由 PERF_STARTUP 开关门控（默认零开销）')
})

// v6 · 2-21：fork→就绪空档拆段（fork 发起 / 子进程 spawn / 入口 / 监听成功 四戳）
test('2-21 接线：fork 与子进程入口都带 epoch，且默认零开销', () => {
  const backend = fs.readFileSync(abs('electron/main/main.backend.js'), 'utf8')
  assert.match(backend, /_bootMark\('fork 发起'\)/, '打包分支必须记录 fork 发起时刻')
  assert.match(backend, /_bootMark\('fork 发起（dev）'\)/, '开发分支同样要记录')
  assert.match(backend, /child\.once\('spawn'/, '必须有 spawn 事件戳（区分进程创建与 Node 引导）')
  assert.match(backend, /process\.env\.PERF_STARTUP === '1'/, '打点必须由 PERF_STARTUP 门控')

  const app = fs.readFileSync(abs('student-backend/app.js'), 'utf8')
  assert.match(app, /_bootEpoch/, '后端入口/监听成功必须带绝对 epoch，供主进程按同一时钟相减')
  assert.match(app, /process\.env\.PERF_STARTUP === '1'/, 'epoch 只在 PERF_STARTUP=1 时追加')
})

// 首屏关键路径：jsonwebtoken 首次 require 实测 79ms（另一台机器 100ms+），原先落在
// **首个 API 请求的 verifyToken** 里 —— 那时连接已 accept、路由还没进去，这次同步加载
// 会把同时到达的 5 个首屏请求一起挡在队列里（实测 87~133ms 循环停顿，首屏「发送」段
// 225ms → 预热后 45ms）。预热位置必须满足两条：listen 之后（不拖慢「后端就绪」信号）、
// 首屏请求之前（warmupStep 是让路链第一环，天然满足）。
test('首屏：jsonwebtoken 必须在 warmupStep 预热，不许落在首个请求里', () => {
  const ast = astOf('student-backend/app.js')
  const warm = findFunction(ast, 'warmupStep')
  assert.ok(warm, 'warmupStep 必须存在')

  const dbWarm = findCalls(warm.node, 'dbManager.warmup')[0]
  const authWarm = findCalls(warm.node, 'warmupAuth')[0]
  assert.ok(dbWarm, 'warmupStep 里必须先做数据库暖机')
  assert.ok(authWarm && authWarm.start > dbWarm.start,
    '鉴权预热必须排在数据库暖机之后、同一个 warmupStep 内')
  // 不许在模块顶层直接预热（那会拖慢后端就绪）：所有 warmupAuth 调用都必须落在 warmupStep 里
  for (const c of findCalls(ast.program, 'warmupAuth')) {
    assert.ok(c.start >= warm.start && c.end <= warm.end, '不许在模块顶层直接预热 warmupAuth()')
  }

  const auth = astOf('student-backend/middleware/auth.js')
  let exported = false
  walk(auth.program, (node) => {
    if (node.type !== 'AssignmentExpression' || memberPath(node.left) !== 'module.exports') return
    if (!node.right || node.right.type !== 'ObjectExpression') return
    exported = node.right.properties.some((p) => p.type === 'ObjectProperty' && keyName(p.key) === 'warmupAuth')
  })
  assert.ok(exported, '必须导出 warmupAuth')
  const warmupFn = findFunction(auth, 'warmupAuth')
  assert.ok(warmupFn, '必须实现 warmupAuth')
  assert.ok(findCalls(warmupFn.node, 'jwtLib').length > 0, '预热必须真的触发 jsonwebtoken 的 require')
})

// 首屏窗口让路（v6 性能 · 打包版实测）：data / fee-records 两个重模块的 require
// （multer、xlsx）原本与首屏请求落在同一条时间线上抢事件循环。ai 是首屏依赖
// （App.vue 挂载后拉 /api/ai/config），实测纠错后已移回首屏组，不许再挪。
// 判据锁三件事：① 两个前缀不在首屏组里，而在 lateLoaders；② 两组之间必须有「只等待」
// 的步骤；③ 等待到点走 flushLateLoaders（内含第二次错误兜底），不许直接展开 lateLoaders。
test('首屏：data / fee-records 必须延后注册，ai 不许延后', () => {
  // 为什么用数组 AST 而不是 indexOf('const deferredLoaders = [') + 切片到下一个声明：
  // 切片的结束点绑死字面量 "const steps = ["，中间插一个变量就切错；而按文本 includes(prefix)
  // 还会把注释里提到的路径算进去。这里直接遍历两个数组元素的真实源码（注释已抹）。
  const { ast, code } = analyze(srcOf('student-backend/app.js'))
  const earlyArr = arrayOf(ast, 'deferredLoaders')
  const lateArr = arrayOf(ast, 'lateLoaders')
  assert.ok(earlyArr && lateArr && lateArr.start > earlyArr.start,
    'deferredLoaders 与 lateLoaders 都必须存在，且后者在后')
  const earlyText = earlyArr.elements.map((e) => code.slice(e.start, e.end))
  const lateText = lateArr.elements.map((e) => code.slice(e.start, e.end))
  const inEarly = (p) => earlyText.some((t) => t.includes(p))
  const inLate = (p) => lateText.some((t) => t.includes(p))

  for (const p of ['/api/data', '/api/fee-records']) {
    assert.ok(!inEarly(p), `${p} 不许留在首屏那一组里`)
    assert.ok(inLate(p), `${p} 必须延后注册`)
  }
  // 首屏依赖一个都不许被挪走：
  //   · /api/dashboard 的 7 个读函数（含 album 封面）；
  //   · /api/ai —— 实测纠错：最初把它挪进 lateLoaders，结果首屏 5 个并发请求里就有它。
  //     配置路由现已在关键路由区提前挂好（见下一条判据），但完整 router 仍必须留在
  //     这一组，不能推到 800ms 之后。
  for (const p of ['/api/schedule', '/api/duty', '/api/countdowns', '/api/album', '/api/leaves', '/api/ai']) {
    assert.ok(inEarly(p), `${p} 是首屏依赖，必须留在前一组`)
  }

  const stepsArr = arrayOf(ast, 'steps')
  assert.ok(stepsArr, 'steps 必须存在')
  const elements = stepsArr.elements
  const isDelayStep = (e) => e && e.type === 'ObjectExpression'
    && e.properties.some((p) => p.type === 'ObjectProperty' && keyName(p.key) === 'delay'
      && p.value.type === 'Identifier' && p.value.name === 'LATE_LOAD_DELAY_MS')
  const isIdent = (e, name) => e && e.type === 'Identifier' && e.name === name

  const delayIdx = elements.findIndex(isDelayStep)
  const flushIdx = elements.findIndex((e) => isIdent(e, 'flushLateLoaders'))
  const errorIdx = elements.findIndex((e) => isIdent(e, 'errorHandlerStep'))
  assert.ok(delayIdx >= 0, 'steps 里必须有「只等待」的延后步骤')
  assert.ok(flushIdx > delayIdx, '等待到点必须走同一个 flush 入口')
  assert.ok(errorIdx >= 0 && errorIdx < delayIdx, '延后窗口内必须先有一个错误兜底')
  assert.ok(!elements.some((e) => e && e.type === 'SpreadElement'
    && e.argument.type === 'Identifier' && e.argument.name === 'lateLoaders'),
  '不许直接展开 lateLoaders（会绕过幂等守卫）')

  let delayConstant = false
  walk(ast.program, (node) => {
    if (node.type === 'LogicalExpression' && node.operator === '??'
      && memberPath(node.left) === 'process.env.CLASSNEST_LATE_LOAD_DELAY_MS'
      && node.right.type === 'NumericLiteral' && node.right.value === 800) delayConstant = true
  })
  assert.ok(delayConstant, '延后时长要有显式常量与测试用的 0 覆盖')

  let subtractsDelay = false
  walk(ast.program, (node) => {
    if (node.type !== 'BinaryExpression' || node.operator !== '-') return
    if (memberPath(node.right) !== '_delayAcc') return
    let usesDeferT0 = false
    walk(node.left, (n) => { if (n.type === 'Identifier' && n.name === '_deferT0') usesDeferT0 = true })
    if (usesDeferT0) subtractsDelay = true
  })
  assert.ok(subtractsDelay, '队列耗时必须扣掉延后等待，否则口径被 800ms 污染')
})

// 800ms 固定空窗曾让「界面可见后立刻点进设置页 / 班费明细」拿到 404。修法是命中延后前缀
// 就同步 flush 注册（实测：请求处理期间 app.use 追加的 layer，同一次请求即可命中），
// 定时到点复用同一入口。只断言「有 flush 函数」会假绿 —— 必须同时锁住门卫接线、
// 前缀边界、幂等守卫与错误兜底顺序。
test('首屏：延后前缀被提前访问时必须立刻 flush，且只注册一次', () => {
  const ast = astOf('student-backend/app.js')

  const prefixes = arrayOf(ast, 'LATE_PATH_PREFIXES')
  assert.ok(prefixes, '延后前缀白名单必须存在')
  assert.deepEqual(stringValues(prefixes), ['/api/data', '/api/fee-records'], '白名单只含这两个前缀')

  // 门卫：app.use((req, res, next) => { ... LATE_PATH_PREFIXES.some(...) ... })
  // 为什么不用 app.slice(indexOf('app.use((req, res, next) => {'), indexOf('\n});'))：
  // 结束锚点绑死「换行 + });」，缩进/换行一变就切到隔壁中间件（假绿/假红）。AST 拿真实函数节点。
  let guard = null
  walk(ast.program, (node) => {
    if (!isCallTo(node, 'app.use')) return
    const fn = node.arguments[0]
    if (!fn || fn.type !== 'ArrowFunctionExpression' || fn.params.length !== 3) return
    if (findCalls(fn.body, 'LATE_PATH_PREFIXES.some').length > 0) guard = fn
  })
  assert.ok(guard, '门卫中间件必须按 LATE_PATH_PREFIXES 识别（且挂在白名单之后）')

  // 前缀必须「完全相等 或 prefix + '/' 开头」，否则 /api/data 会误吞 /api/database
  let exactOrSlash = false
  walk(guard.body, (node) => {
    if (node.type !== 'LogicalExpression' || node.operator !== '||') return
    const a = node.left
    const b = node.right
    if (a.type === 'BinaryExpression' && a.operator === '==='
      && memberPath(a.left) === 'p' && memberPath(a.right) === 'prefix'
      && isCallTo(b, 'p.startsWith')
      && b.arguments[0] && b.arguments[0].type === 'TemplateLiteral') {
      exactOrSlash = true
    }
  })
  assert.ok(exactOrSlash, '前缀边界要精确：等值 + 「前缀/」子路径，缺一不可')

  const flushCalls = findCalls(guard.body, 'flushLateLoaders')
  const nextCall = findCalls(guard.body, 'next')[0]
  assert.ok(flushCalls.length > 0, '门卫必须真的触发注册')
  assert.ok(nextCall && nextCall.start > flushCalls[0].start, '门卫不许吞掉请求（flush 后 next）')

  // 幂等 + 顺序：lateLoaded 置位 → errorHandlerStep() → for(lateLoaders) → errorHandlerStep(true)
  const flush = findFunction(ast, 'flushLateLoaders')
  assert.ok(flush, 'flush 实现必须存在')
  let idempotent = false
  walk(flush.node, (node) => {
    if (node.type === 'IfStatement' && node.test.type === 'Identifier' && node.test.name === 'lateLoaded') {
      let ret = false
      walk(node.consequent, (n) => { if (n.type === 'ReturnStatement') ret = true })
      if (ret) idempotent = true
    }
  })
  assert.ok(idempotent, '注册必须幂等')

  let setLoaded = null
  let forOf = null
  walk(flush.node, (node) => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === 'lateLoaded'
      && node.right.type === 'BooleanLiteral' && node.right.value === true) setLoaded = node
    if (node.type === 'ForOfStatement' && node.right.type === 'Identifier' && node.right.name === 'lateLoaders') forOf = node
  })
  assert.ok(setLoaded && forOf, '幂等标记要在注册前落位，并真的遍历 lateLoaders')
  assert.ok(setLoaded.start < forOf.start, '幂等标记必须在注册前落位')
  let mounts = false
  walk(forOf.body, (n) => { if (isCallTo(n, 'mount')) mounts = true })
  assert.ok(mounts, 'flush 要真的挂那两个路由')

  const eh = findCalls(flush.node, 'errorHandlerStep')
  const ehPlain = eh.find((c) => c.arguments.length === 0)
  const ehForce = eh.find((c) => c.arguments[0] && c.arguments[0].type === 'BooleanLiteral' && c.arguments[0].value === true)
  assert.ok(ehPlain && ehPlain.start < forOf.start, '① 先补前面的错误兜底')
  assert.ok(ehForce && ehForce.start > forOf.end, '② 再兜住刚注册的路由')

  const flushVar = findVar(ast, 'flushLateLoaders')
  assert.ok(flushVar && flushVar.init && flushVar.init.type === 'NullLiteral', 'flush 必须是可后置赋值的钩子')
})

// 首屏 AI 配置 404 边界：/api/ai 原本排在让路链最后一步，慢机器上要 ~85ms 才注册，
// 而首屏请求在 listen 后 40~170ms 就到 —— 请求先到就是 404，AI 入口消失到下次刷新。
// 修法与 /api/dashboard 同款：listen 之前挂轻量的 ai.config router，重模块仍由让路链预热。
// 判据必须限定在「关键路由区」里找 —— 全文 match('/api/ai') 会被让路链里那条骗过去。
test('首屏：/api/ai/config 必须在 listen 之前就挂好，且不拖慢后端就绪', () => {
  const ast = astOf('student-backend/app.js')
  // 为什么不再切「关键路由区」文本：区域边界靠注释字符串定位，且 match('/api/ai') 会被
  // 让路链里那条完整 router 骗过去。这里直接识别 app.use 调用的真实路由 + require 目标。
  const mounts = findCalls(ast.program, 'app.use')
  const requiredOf = (call) => call.arguments.slice(1)
    .map((a) => (a.type === 'CallExpression' && a.callee.type === 'Identifier' && a.callee.name === 'require'
      && a.arguments[0] && a.arguments[0].type === 'StringLiteral' ? a.arguments[0].value : null))
    .filter(Boolean)
  const findMount = (route, mod) => mounts.find((c) => c.arguments[0]
    && c.arguments[0].type === 'StringLiteral' && c.arguments[0].value === route
    && requiredOf(c).includes(mod))

  const listen = findCalls(ast.program, 'app.listen')[0]
  assert.ok(listen, '找不到 app.listen')

  const configMount = findMount('/api/ai', './routes/ai/ai.config')
  assert.ok(configMount, '首屏 ai 配置必须挂 ai.config')
  assert.ok(configMount.start < listen.start, '首屏 ai 配置必须挂在 listen 之前，不能等让路链')
  // 关键点：完整 ai router 不能也提前挂（pdf-parse 等重模块会拖慢后端就绪）
  const fullMount = findMount('/api/ai', './routes/ai/ai')
  assert.ok(fullMount, '完整 ai router 仍要由让路链在后台注册，其它 ai 接口照常')
  assert.ok(fullMount.start > listen.start, '关键路由区不许 require 完整 ai router（重模块会拖慢后端就绪）')

  assert.ok(findMount('/api/dashboard', './routes/dashboard'), '同一条原则：dashboard 也在 listen 之前')
})

// 首屏第一笔同步开销提前（2026-11-14 打包版归因）：拆开 dashboard 的 54~73ms 后发现，
// 它自己的聚合只要 2~3ms，其余全是陪跑 —— 第一个请求（/api/me）进 auth 的 withDb 时
// 才第一次开账号库，「KDF + openFile」41~58ms 同步阻塞，把同时到达的另外 4 个首屏请求
// 一起挡在「连接到达」之后。修法是在让路链的 warmup 步骤里先打开最近使用过的库。
//
// 判据锁五件事：① 预热排在 dbManager.warmup() 之后、同一个 warmupStep 内；
// ② 不许模块顶层直接调用（listen 之前会拖慢「后端就绪」信号）；
// ③ 必须真的走 getConn（否则连接没进缓存，首屏照样冷开）；
// ④ 隐私库必须跳过 —— 它的库钥匙只在登录解锁后的内存表里，硬开会抛；
// ⑤ 已开着必须幂等返回，不许重复 openFile。
test('首屏：账号库预热排在 warmup 之后、跳过隐私库、走 connCache', () => {
  // 为什么不用 indexOf('const warmupStep = () => {') + slice(..., indexOf('const steps = ['))：
  // 边界绑死两条字面量声明（改成 const warmupStep = async () => 或提前插入变量就切空/切错），
  // 而 fnBody = conn.slice(fnAt) 一路切到文件尾，别的函数里出现 readdirSync 也会误报。
  // 这里用 AST 取每个函数自己的节点范围。
  const ast = astOf('student-backend/app.js')
  const warm = findFunction(ast, 'warmupStep')
  assert.ok(warm, 'warmupStep 必须存在')

  const dbWarm = findCalls(warm.node, 'dbManager.warmup')[0]
  // 只认「调用」不管参数形态：预热要传 slug（warmupMostRecent(sessions.recentSlug())），
  // 写死空参形态会让判据在正常改动后假红。
  const recentWarm = findCalls(warm.node, 'dbManager.warmupMostRecent')[0]
  assert.ok(dbWarm, 'warmupStep 里必须先做数据库暖机')
  assert.ok(recentWarm && recentWarm.start > dbWarm.start,
    '账号库预热必须排在数据库暖机之后（同一个 warmupStep 内）')
  for (const c of findCalls(ast.program, 'dbManager.warmupMostRecent')) {
    assert.ok(c.start >= warm.start && c.end <= warm.end, '不许在模块顶层直接预热（会拖慢「后端就绪」信号）')
  }

  const connAst = astOf('student-backend/dbManager/dbManager.conn.js')
  let exported = false
  walk(connAst.program, (node) => {
    if (node.type !== 'AssignmentExpression' || memberPath(node.left) !== 'module.exports') return
    if (!node.right || node.right.type !== 'ObjectExpression') return
    exported = node.right.properties.some((p) => p.type === 'ObjectProperty' && keyName(p.key) === 'warmupMostRecent')
  })
  assert.ok(exported, 'conn 必须导出 warmupMostRecent')

  const warmFn = findFunction(connAst, 'warmupMostRecent')
  assert.ok(warmFn, 'warmupMostRecent 必须存在')
  assert.ok(findCalls(warmFn.node, 'getConn').length > 0, '预热必须真的走 getConn（否则连接没进缓存，首屏仍要冷开）')
  let protectGuard = false
  walk(warmFn.node, (node) => {
    if (node.type === 'BinaryExpression' && node.operator === '==='
      && typeof memberPath(node.left) === 'string' && memberPath(node.left).endsWith('.protect')
      && node.right.type === 'NumericLiteral' && node.right.value === 1) protectGuard = true
  })
  assert.ok(protectGuard, '隐私库必须跳过：库钥匙只在登录解锁后的内存里')
  assert.ok(findCalls(warmFn.node, 'connCache.has').length > 0, '已开着就不许重复 openFile（幂等）')
  assert.ok(findCalls(warmFn.node, 'rememberedDb').length > 0, '预热必须读 .last-db（后端自己记的），不靠会话或 mtime 猜')
  assert.equal(findCalls(warmFn.node, 'readdirSync').length, 0, '不许用目录 mtime 猜库')
  assert.equal(findCalls(warmFn.node, 'statSync').length, 0, '不许用目录 mtime 猜库')
  let usesSessions = false
  walk(warmFn.node, (node) => {
    const p = node.type === 'MemberExpression' ? memberPath(node) : null
    if (p && p.startsWith('sessions.')) usesSessions = true
  })
  assert.ok(!usesSessions, '预热不许依赖会话模块（老会话没有 dbSlug，且会构成循环 require）')

  const mgrAst = astOf('student-backend/dbManager/dbManager.js')
  let forwarded = false
  walk(mgrAst.program, (node) => {
    if (node.type === 'ObjectProperty' && keyName(node.key) === 'warmupMostRecent'
      && memberPath(node.value) === 'conn.warmupMostRecent') forwarded = true
  })
  assert.ok(forwarded, 'dbManager 必须转发 warmupMostRecent')

  // 「记」的那一侧：withDb 真正开库成功后必须落盘，否则下次启动没得预热。
  const withDb = findFunction(connAst, 'withDb')
  assert.ok(withDb && withDb.start < warmFn.start, 'withDb 必须在 warmupMostRecent 之前')
  let takesConn = false
  walk(withDb.node, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'conn'
      && node.init && isCallTo(node.init, 'getConn')) takesConn = true
  })
  assert.ok(takesConn, 'withDb 必须先取连接')
  // 必须锁到「调用」形态：`function rememberDb(slug) {` 的定义行同样包含 rememberDb(slug)，
  // 只测这个子串时，把调用整行删掉照样假绿（2026-11-14 变异实测）。
  assert.ok(findCalls(withDb.node, 'rememberDb').some(
    (c) => c.arguments[0] && memberPath(c.arguments[0]) === 'slug',
  ), 'withDb 成功开库后必须记下 slug（否则下次启动学不到）')

  // 写盘必须只在 slug 变化时发生：否则每个请求都写一次小文件，把一次 1ms 变成热路径常驻开销。
  const remFn = findFunction(connAst, 'rememberDb')
  assert.ok(remFn, 'rememberDb 必须存在')
  let compares = false
  walk(remFn.node, (node) => {
    if (node.type === 'BinaryExpression' && node.operator === '==='
      && memberPath(node.left) === 's' && memberPath(node.right) === 'lastDbWritten') compares = true
  })
  assert.ok(compares, '必须只在 slug 变化时写盘（进程内比对）')
  assert.ok(findCalls(remFn.node, 'fs.writeFileSync').length > 0 || findCalls(remFn.node, 'writeFileSync').length > 0,
    'rememberDb 必须真的落盘')
  let guardsPath = false
  const rememberedFn = findFunction(connAst, 'rememberedDb')
  const checkPath = (fn) => {
    if (!fn) return
    walk(fn.node, (node) => {
      if (isCallTo(node, 'SLUG_RE.test')) guardsPath = true
      if (node.type === 'MemberExpression' && memberPath(node) === 'LAST_DB_FILE') guardsPath = true
    })
  }
  checkPath(remFn)
  checkPath(rememberedFn)
  assert.ok(guardsPath, '写入前不许把脏 slug 当路径用')
})

// 首屏路由组件的两条打点必须能过「首屏日志白名单」。
// 为什么要单独立这一条（2026-11-14 实测）：DashboardView 是动态 import 的 chunk，
// 它的解析时间常常晚于 did-finish-load，而主进程在 did-finish-load 之后只接收
// LATE_STARTUP_LABELS 里的标签 —— 打点代码明明执行了、日志却整条消失，
// 表现为「加了点还是拆不开 Vue 挂载 → 首页数据发起」，非常难查。
test('首屏路由组件的打点必须进得了日志白名单', () => {
  // 为什么不用 /const LATE_STARTUP_LABELS = \[([\s\S]*?)\n  \]/ + labels.includes("'x'")：
  // 结束锚点绑死「两个空格缩进 + ]」，改成 4 空格/单行数组/双引号就切空（假红）；
  // 字符串包含还会被注释里的同名标签骗过。AST 直接读数组字面量与真实 mark() 调用。
  const mainAst = astOf('electron/main/main.js')
  const labelsArr = arrayOf(mainAst, 'LATE_STARTUP_LABELS')
  assert.ok(labelsArr, '必须能读到 LATE_STARTUP_LABELS')
  const labels = new Set(stringValues(labelsArr))

  // 逐条核对「首屏链路里 mark('X') 用的字面量」在不在白名单里：
  // 改名/新增打点而不同步白名单，日志会被 did-finish-load 之后的过滤静默丢掉。
  // 三个文件覆盖首屏导航全链路：入口（安装/chunk 求值）、守卫、落地组件。
  const files = [
    'student-frontend/src/main.js',
    'student-frontend/src/router/index.js',
    'student-frontend/src/views/DashboardView.vue',
  ]
  for (const rel of files) {
    const ast = astOf(rel)
    walk(ast.program, (node) => {
      if (!isCallTo(node, 'mark')) return
      const arg = node.arguments[0]
      if (!arg || arg.type !== 'StringLiteral') return
      assert.ok(labels.has(arg.value),
        `${rel} 的 mark('${arg.value}') 不在 LATE_STARTUP_LABELS 里 —— 日志会被 did-finish-load 之后的过滤丢掉`)
    })
  }
})

// 渲染层的启动标记必须自报「事件真实发生时刻」，否则会被投递延迟污染。
// 为什么立这条（2026-11-14 实测）：`Vue 挂载完成` 是唯一漏了 @epoch 的一条，
// 主进程退回按「日志送达时刻」打点，于是「挂载完成 → 路由守卫进入」凭空多出几十毫秒，
// 被误读成主线程布局开销，白查了一轮。渲染层每一条 [startup] 都必须带 @epoch。
test('渲染层启动标记必须自报时刻（@epoch）', () => {
  const files = [
    'student-frontend/src/main.js',
    'student-frontend/src/composables/secureChannel.js',
    'student-frontend/src/composables/useDashboardData.js',
  ]
  for (const rel of files) {
    const src = fs.readFileSync(abs(rel), 'utf8')
    // 取所有含 [startup] 的模板串所在行，逐行要求带 @${...} 自报时刻；注释行不算。
    for (const line of src.split('\n')) {
      const t = line.trim()
      if (!line.includes('[startup]')) continue
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
      assert.match(
        line,
        /@\$\{/,
        `${rel} 的启动日志缺 @epoch，会被投递延迟污染：${t.slice(0, 90)}`,
      )
    }
  }
})

// 占位页移除不能只依赖 rAF。
// 为什么立这条（2026-11-14 两次独立测量各复现一次）：页面处于 hidden（窗口尚未 show、
// 或启动后被最小化到托盘）时 Chromium 会暂停 rAF —— 同一时刻注册的 setTimeout(0) 在
// +509ms 正常执行，rAF 回调却拖到 +1488ms 才跑。只靠 rAF 的后果是：占位页一直挂着，
// 用户把窗口恢复出来时先看到的仍是占位页，而不是已经渲染好的内容。
test('占位页移除必须有非 rAF 的兜底路径', () => {
  // 为什么不再 slice(indexOf('const dropSplash'), +4000)：
  // 4000 是拍脑袋的长度窗口 —— 代码一长就切不到 visibilitychange 那段（假红），
  // 而 indexOf 命中注释里的同名串又会从一个不相干的位置开始切（漏报）。
  // AST：先找到包含 dropSplash 的 `if (splashEl)` 块，再在这个真实块里找三条提交路径。
  const ast = astOf('student-frontend/src/main.js')
  const dropDecl = findVar(ast, 'dropSplash')
  assert.ok(dropDecl, '没找到 dropSplash：占位页移除入口被改名或删除')

  let splashBlock = null
  walk(ast.program, (node) => {
    if (node.type !== 'IfStatement' || !node.consequent) return
    if (node.test.type !== 'Identifier' || node.test.name !== 'splashEl') return
    if (node.consequent.start <= dropDecl.start && dropDecl.end <= node.consequent.end) splashBlock = node.consequent
  })
  assert.ok(splashBlock, '找不到包含 dropSplash 的 if (splashEl) 块')

  const hasCommitArg = (call) => call.arguments[0] && call.arguments[0].type === 'Identifier'
    && call.arguments[0].name === 'commitSplashRemove'
  assert.ok(findCalls(splashBlock, 'requestAnimationFrame').some(hasCommitArg),
    '正常路径：必须仍等一帧再提交（硬切观感依赖它）')

  const timeout = findCalls(splashBlock, 'setTimeout').find((c) => hasCommitArg(c)
    && c.arguments[1] && c.arguments[1].type === 'Identifier' && c.arguments[1].name === 'SPLASH_RAF_FALLBACK_MS')
  assert.ok(timeout, '兜底路径 1 缺失：页面 hidden 时 rAF 不跑，必须有定时器接手')

  const addVisible = findCalls(splashBlock, 'document.addEventListener').find((c) => c.arguments[0]
    && c.arguments[0].type === 'StringLiteral' && c.arguments[0].value === 'visibilitychange')
  assert.ok(addVisible, '兜底路径 2 缺失：窗口变可见时应立刻提交，不该等用户先看到占位页')

  const commit = findFunction(ast, 'commitSplashRemove')
  assert.ok(commit, '三条路径必须共用 commitSplashRemove')
  let idempotent = false
  walk(commit.node, (node) => {
    if (node.type === 'IfStatement' && node.test.type === 'Identifier' && node.test.name === 'committed') {
      let ret = false
      walk(node.consequent, (n) => { if (n.type === 'ReturnStatement') ret = true })
      if (ret) idempotent = true
    }
  })
  assert.ok(idempotent, '三条路径必须共用幂等提交，否则会重复 remove、重复派发 app-visible')

  const removeVisible = findCalls(commit.node, 'document.removeEventListener').find((c) => c.arguments[0]
    && c.arguments[0].type === 'StringLiteral' && c.arguments[0].value === 'visibilitychange')
  assert.ok(removeVisible, '提交后必须摘掉 visibilitychange 监听器')

  const constDecl = findVar(ast, 'SPLASH_RAF_FALLBACK_MS')
  assert.ok(constDecl && constDecl.init && constDecl.init.type === 'NumericLiteral', '缺 SPLASH_RAF_FALLBACK_MS 常量')
  const ms = constDecl.init.value
  assert.ok(ms >= 200 && ms <= 600,
    `兜底时长 ${ms}ms 不合理：须 >=200（不误伤实测 ~180ms 的重排帧边界）且 <=600（否则和 900ms 的 rAF 暂停没区别）`)
})
