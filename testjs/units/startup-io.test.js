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
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const io = require(path.join(ROOT, 'electron/main/main.startup-io'))
const timer = require(path.join(ROOT, 'electron/main/main.startup-timer'))

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
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.js'), 'utf8')
  const installAt = src.indexOf('startupIo.install(fs)')
  const firstSyncIoAt = src.indexOf('fs.mkdirSync(_ccDir')
  assert.ok(installAt > 0, 'main.js 必须调用 startupIo.install(fs)')
  assert.ok(firstSyncIoAt > 0, 'main.js 必须保留启动路径上的首个同步 IO（node-compile-cache 建目录）')
  assert.ok(firstSyncIoAt > installAt, '安装必须早于首个同步 IO 调用（node-compile-cache 建目录）')

  const summarizeAt = src.indexOf('startupIo.summarize()')
  const reportAt = src.indexOf('startupTimer.report()', summarizeAt > 0 ? summarizeAt : 0)
  assert.ok(summarizeAt > 0, 'onFinal 里必须调用 startupIo.summarize()')
  assert.ok(reportAt > summarizeAt, 'summarize 必须早于 report，否则时间线漏这条')

  const impl = fs.readFileSync(path.join(ROOT, 'electron/main/main.startup-io.js'), 'utf8')
  assert.match(impl, /PERF_STARTUP === '1'/, '默认必须由 PERF_STARTUP 开关门控（默认零开销）')
})

// v6 · 2-21：fork→就绪空档拆段（fork 发起 / 子进程 spawn / 入口 / 监听成功 四戳）
test('2-21 接线：fork 与子进程入口都带 epoch，且默认零开销', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'electron/main/main.backend.js'), 'utf8')
  assert.match(backend, /_bootMark\('fork 发起'\)/, '打包分支必须记录 fork 发起时刻')
  assert.match(backend, /_bootMark\('fork 发起（dev）'\)/, '开发分支同样要记录')
  assert.match(backend, /child\.once\('spawn'/, '必须有 spawn 事件戳（区分进程创建与 Node 引导）')
  assert.match(backend, /process\.env\.PERF_STARTUP === '1'/, '打点必须由 PERF_STARTUP 门控')

  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  assert.match(app, /_bootEpoch/, '后端入口/监听成功必须带绝对 epoch，供主进程按同一时钟相减')
  assert.match(app, /process\.env\.PERF_STARTUP === '1'/, 'epoch 只在 PERF_STARTUP=1 时追加')
})

// 首屏关键路径：jsonwebtoken 首次 require 实测 79ms（另一台机器 100ms+），原先落在
// **首个 API 请求的 verifyToken** 里 —— 那时连接已 accept、路由还没进去，这次同步加载
// 会把同时到达的 5 个首屏请求一起挡在队列里（实测 87~133ms 循环停顿，首屏「发送」段
// 225ms → 预热后 45ms）。预热位置必须满足两条：listen 之后（不拖慢「后端就绪」信号）、
// 首屏请求之前（warmupStep 是让路链第一环，天然满足）。
test('首屏：jsonwebtoken 必须在 warmupStep 预热，不许落在首个请求里', () => {
  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  const warmAt = app.indexOf('const warmupStep = () => {')
  assert.ok(warmAt > 0, 'warmupStep 必须存在')
  const dbAt = app.indexOf('dbManager.warmup()', warmAt)
  const authAt = app.indexOf('warmupAuth()', warmAt)
  assert.ok(dbAt > warmAt, 'warmupStep 里必须先做数据库暖机')
  assert.ok(authAt > dbAt, '鉴权预热必须排在数据库暖机之后、同一个 warmupStep 内')
  assert.ok(!/^\s*warmupAuth\(\)/m.test(app.slice(0, warmAt)), '不许在模块顶层直接预热（那会拖慢后端就绪）')

  const auth = fs.readFileSync(path.join(ROOT, 'student-backend/middleware/auth.js'), 'utf8')
  assert.match(auth, /module\.exports = \{[\s\S]*warmupAuth/, '必须导出 warmupAuth')
  assert.match(auth, /function warmupAuth\(\)[\s\S]{0,200}jwtLib\(\)/, '预热必须真的触发 jsonwebtoken 的 require')
})

// 首屏窗口让路（v6 性能 · 打包版实测）：data / fee-records 两个重模块的 require
// （multer、xlsx）原本与首屏请求落在同一条时间线上抢事件循环。ai 是首屏依赖
// （App.vue 挂载后拉 /api/ai/config），实测纠错后已移回首屏组，不许再挪。
// 判据锁三件事：① 两个前缀不在首屏组里，而在 lateLoaders；② 两组之间必须有「只等待」
// 的步骤；③ 等待到点走 flushLateLoaders（内含第二次错误兜底），不许直接展开 lateLoaders。
test('首屏：data / fee-records 必须延后注册，ai 不许延后', () => {
  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  const earlyAt = app.indexOf('const deferredLoaders = [')
  const lateAt = app.indexOf('const lateLoaders = [')
  assert.ok(earlyAt > 0 && lateAt > earlyAt, 'deferredLoaders 与 lateLoaders 都必须存在，且后者在后')

  const early = app.slice(earlyAt, lateAt)
  const stepsAt = app.indexOf('const steps = [', lateAt)
  assert.ok(stepsAt > lateAt, 'steps 必须定义在 lateLoaders 之后')
  const late = app.slice(lateAt, stepsAt)

  for (const p of ['/api/data', '/api/fee-records']) {
    assert.ok(!early.includes(p), `${p} 不许留在首屏那一组里`)
    assert.ok(late.includes(p), `${p} 必须延后注册`)
  }
  // 首屏依赖一个都不许被挪走：
  //   · /api/dashboard 的 7 个读函数（含 album 封面）；
  //   · /api/ai —— 实测纠错：最初把它挪进 lateLoaders，结果首屏 5 个并发请求里就有它。
  //     配置路由现已在关键路由区提前挂好（见下一条判据），但完整 router 仍必须留在
  //     这一组，不能推到 800ms 之后。
  for (const p of ['/api/schedule', '/api/duty', '/api/countdowns', '/api/album', '/api/leaves', '/api/ai']) {
    assert.ok(early.includes(p), `${p} 是首屏依赖，必须留在前一组`)
  }

  const steps = app.slice(stepsAt, app.indexOf('let stepIdx = 0', stepsAt))
  const delayAt = steps.indexOf('{ delay: LATE_LOAD_DELAY_MS }')
  assert.ok(delayAt > 0, 'steps 里必须有「只等待」的延后步骤')
  const flushAt = steps.indexOf('flushLateLoaders')
  assert.ok(flushAt > delayAt, '等待到点必须走同一个 flush 入口')
  assert.ok(!steps.includes('...lateLoaders'), '不许直接展开 lateLoaders（会绕过幂等守卫）')
  assert.ok(steps.indexOf('errorHandlerStep,') < delayAt, '延后窗口内必须先有一个错误兜底')

  assert.match(app, /CLASSNEST_LATE_LOAD_DELAY_MS \?\? 800/, '延后时长要有显式常量与测试用的 0 覆盖')
  assert.match(app, /_deferT0 - _delayAcc/, '队列耗时必须扣掉延后等待，否则口径被 800ms 污染')
})

// 800ms 固定空窗曾让「界面可见后立刻点进设置页 / 班费明细」拿到 404。修法是命中延后前缀
// 就同步 flush 注册（实测：请求处理期间 app.use 追加的 layer，同一次请求即可命中），
// 定时到点复用同一入口。只断言「有 flush 函数」会假绿 —— 必须同时锁住门卫接线、
// 前缀边界、幂等守卫与错误兜底顺序。
test('首屏：延后前缀被提前访问时必须立刻 flush，且只注册一次', () => {
  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')

  const prefixesAt = app.indexOf('const LATE_PATH_PREFIXES')
  assert.ok(prefixesAt > 0, '延后前缀白名单必须存在')
  assert.match(app.slice(prefixesAt, prefixesAt + 120), /'\/api\/data'\s*,\s*'\/api\/fee-records'/, '白名单只含这两个前缀')
  const guardAt = app.indexOf('app.use((req, res, next) => {', prefixesAt)
  assert.ok(guardAt > prefixesAt, '门卫中间件必须挂在白名单之后')
  const guard = app.slice(guardAt, app.indexOf('\n});', guardAt))
  assert.match(guard, /LATE_PATH_PREFIXES\.some\(/, '门卫必须按白名单识别')
  assert.ok(guard.includes('p === prefix'), '前缀边界要精确：等值判断不能省')
  assert.ok(guard.includes('p.startsWith('), '前缀边界要精确：子路径判断不能省')
  assert.match(guard, /flushLateLoaders\(\)/, '门卫必须真的触发注册')
  assert.match(guard, /next\(\)/, '门卫不许吞掉请求')
  assert.match(app, /let flushLateLoaders = null/, 'flush 必须是可后置赋值的钩子')

  const flushAt = app.indexOf('flushLateLoaders = () => {')
  assert.ok(flushAt > 0, 'flush 实现必须存在')
  const flush = app.slice(flushAt, app.indexOf('const steps = [', flushAt))
  assert.match(flush, /if \(lateLoaded\) return/, '注册必须幂等')
  assert.match(flush, /lateLoaded = true/, '幂等标记要在注册前落位')
  assert.match(flush, /for \(const mount of lateLoaders\) mount\(\)/, 'flush 要真的挂那两个路由')
  assert.ok(flush.indexOf('errorHandlerStep()') < flush.indexOf('for (const mount'), '① 先补前面的错误兜底')
  assert.ok(flush.indexOf('errorHandlerStep(true)') > flush.indexOf('for (const mount'), '② 再兜住刚注册的路由')
})

// 首屏 AI 配置 404 边界：/api/ai 原本排在让路链最后一步，慢机器上要 ~85ms 才注册，
// 而首屏请求在 listen 后 40~170ms 就到 —— 请求先到就是 404，AI 入口消失到下次刷新。
// 修法与 /api/dashboard 同款：listen 之前挂轻量的 ai.config router，重模块仍由让路链预热。
// 判据必须限定在「关键路由区」里找 —— 全文 match('/api/ai') 会被让路链里那条骗过去。
test('首屏：/api/ai/config 必须在 listen 之前就挂好，且不拖慢后端就绪', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  // 只剥整行 // 注释：不剥的话，把挂载注释掉之后判据照样绿（历史上假绿过）。
  // 绝不用块注释正则 —— 源码里有 url("image/*") 这类属性值，会一路吞到很远的结束标记。
  const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const keyAt = raw.indexOf('// ===================== 关键路由')
  const serverAt = raw.indexOf('function startServer(')
  assert.ok(keyAt > 0 && serverAt > keyAt, '找不到关键路由区与 startServer 的边界')
  const keyRoutes = code(raw.slice(keyAt, serverAt))
  assert.match(
    keyRoutes,
    /app\.use\('\/api\/ai', auth\(\['teacher'\]\), require\('\.\/routes\/ai\/ai\.config'\)\)/,
    '首屏 ai 配置必须挂在 listen 之前，不能等让路链',
  )
  assert.ok(
    !/require\('\.\/routes\/ai\/ai'\)/.test(keyRoutes),
    '关键路由区不许 require 完整 ai router（pdf-parse 等重模块会拖慢后端就绪）',
  )
  assert.match(keyRoutes, /app\.use\('\/api\/dashboard'/, '同一条原则：dashboard 也在 listen 之前')

  const deferredAt = raw.indexOf('const deferredLoaders = [')
  const deferred = code(raw.slice(deferredAt, raw.indexOf('const lateLoaders = [', deferredAt)))
  assert.match(
    deferred,
    /app\.use\('\/api\/ai', auth\(\['teacher'\]\), require\('\.\/routes\/ai\/ai'\)\)/,
    '完整 ai router 仍要由让路链在后台注册，其它 ai 接口照常',
  )
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
  // 剥整行注释：判据里 indexOf('dbManager.warmup()') 会命中注释里的同名字样，
  // 不剥的话「注释掉真调用」这种变异会假绿（2026-11-14 已经踩过一次）。
  // 绝不用块注释正则 —— 源码里有 url("image/*") 这类属性值，会一路吞到很远。
  const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')

  const app = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')
  const warmAt = app.indexOf('const warmupStep = () => {')
  const stepsAt = app.indexOf('const steps = [', warmAt)
  assert.ok(warmAt > 0 && stepsAt > warmAt, '找不到 warmupStep 与 steps 的边界')
  const warmBody = code(app.slice(warmAt, stepsAt))

  const dbAt = warmBody.indexOf('dbManager.warmup()')
  // 只匹配到左括号为止：调用要传 slug（warmupMostRecent(sessions.recentSlug())），
  // 写死空参形态会让判据在正常改动后假红。
  const recentAt = warmBody.indexOf('dbManager.warmupMostRecent(')
  assert.ok(dbAt > 0, 'warmupStep 里必须先做数据库暖机')
  assert.ok(recentAt > dbAt, '账号库预热必须排在数据库暖机之后（同一个 warmupStep 内）')
  assert.ok(
    !/^\s*dbManager\.warmupMostRecent\(\)/m.test(code(app.slice(0, warmAt))),
    '不许在模块顶层直接预热（会拖慢「后端就绪」信号）',
  )

  const conn = fs.readFileSync(path.join(ROOT, 'student-backend/dbManager/dbManager.conn.js'), 'utf8')
  assert.match(conn, /module\.exports = \{[\s\S]*warmupMostRecent/, 'conn 必须导出 warmupMostRecent')
  const fnAt = conn.indexOf('function warmupMostRecent(')
  assert.ok(fnAt > 0, 'warmupMostRecent 必须存在')
  const fnBody = code(conn.slice(fnAt))
  assert.match(fnBody, /getConn\(/, '预热必须真的走 getConn（否则连接没进缓存，首屏仍要冷开）')
  assert.match(fnBody, /protect === 1/, '隐私库必须跳过：库钥匙只在登录解锁后的内存里')
  assert.match(fnBody, /connCache\.has\(/, '已开着就不许重复 openFile（幂等）')

  const mgr = fs.readFileSync(path.join(ROOT, 'student-backend/dbManager/dbManager.js'), 'utf8')
  assert.match(mgr, /warmupMostRecent:\s*conn\.warmupMostRecent/, 'dbManager 必须转发 warmupMostRecent')

  // 预热哪个库必须来自「后端自己记的事实」，不许猜：
  //  - 会话里的 dbSlug 是后来才加的字段，老会话为 null（实测 21 条里 16 条），
  //    退回别的会话必然猜错，猜错时比不预热更慢；
  //  - 库文件 mtime 也不许用（预热自身的 initSchema 会刷新它，猜错会自我强化）。
  assert.match(fnBody, /rememberedDb\(/, '预热必须读 .last-db（后端自己记的），不靠会话或 mtime 猜')
  assert.ok(
    !/readdirSync|statSync/.test(fnBody),
    '不许用目录 mtime 猜库：命中率低，且预热自身会刷新 mtime',
  )
  assert.ok(
    !/sessions\./.test(fnBody),
    '预热不许依赖会话模块（老会话没有 dbSlug，且会构成循环 require）',
  )

  // 「记」的那一侧：withDb 真正开库成功后必须落盘，否则下次启动没得预热。
  const withDbAt = conn.indexOf('function withDb(')
  assert.ok(withDbAt > 0 && withDbAt < fnAt, 'withDb 必须在 warmupMostRecent 之前')
  const withDbBody = code(conn.slice(withDbAt, fnAt))
  assert.match(withDbBody, /const conn = getConn\(/, 'withDb 必须先取连接')
  // 必须锁到「调用」形态（带分号）：`function rememberDb(slug) {` 的定义行同样包含
  // `rememberDb(slug)`，只测这个子串时，把调用整行删掉照样假绿（2026-11-14 变异实测）。
  assert.match(withDbBody, /rememberDb\(slug\);/, 'withDb 成功开库后必须记下 slug（否则下次启动学不到）')

  // 写盘必须只在 slug 变化时发生：否则每个请求都写一次小文件，把一次 1ms 变成热路径常驻开销。
  const remAt = conn.indexOf('function rememberDb(')
  assert.ok(remAt > 0, 'rememberDb 必须存在')
  const remBody = code(conn.slice(remAt))
  assert.match(remBody, /s === lastDbWritten/, '必须只在 slug 变化时写盘（进程内比对）')
  assert.match(remBody, /writeFileSync/, 'rememberDb 必须真的落盘')
  assert.match(remBody, /SLUG_RE\.test|LAST_DB_FILE/, '写入前不许把脏 slug 当路径用')
})

// 首屏路由组件的两条打点必须能过「首屏日志白名单」。
// 为什么要单独立这一条（2026-11-14 实测）：DashboardView 是动态 import 的 chunk，
// 它的解析时间常常晚于 did-finish-load，而主进程在 did-finish-load 之后只接收
// LATE_STARTUP_LABELS 里的标签 —— 打点代码明明执行了、日志却整条消失，
// 表现为「加了点还是拆不开 Vue 挂载 → 首页数据发起」，非常难查。
test('首屏路由组件的打点必须进得了日志白名单', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron/main/main.js'), 'utf8')
  const labels = (main.match(/const LATE_STARTUP_LABELS = \[([\s\S]*?)\n  \]/) || [])[1]
  assert.ok(labels, '必须能读到 LATE_STARTUP_LABELS')

  // 逐条核对「首屏链路里 mark('X') 用的字面量」在不在白名单里：
  // 改名/新增打点而不同步白名单，日志会被 did-finish-load 之后的过滤静默丢掉。
  // 三个文件覆盖首屏导航全链路：入口（安装/chunk 求值）、守卫、落地组件。
  const files = [
    'student-frontend/src/main.js',
    'student-frontend/src/router/index.js',
    'student-frontend/src/views/DashboardView.vue',
  ]
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const m of src.matchAll(/\bmark\(['"]([^'"]+)['"]\)/g)) {
      const label = m[1]
      assert.ok(
        labels.includes(`'${label}'`),
        `${rel} 的 mark('${label}') 不在 LATE_STARTUP_LABELS 里 —— 日志会被 did-finish-load 之后的过滤丢掉`,
      )
    }
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
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
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
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/main.js'), 'utf8')
  // 只剥整行注释。绝不能用块注释正则 —— 上面那段注释里就写着 rAF/setTimeout，
  // 不剥会让「删掉兜底代码」的变异假绿（02:05 踩过一次）。
  const code = src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')

  const start = code.indexOf('const dropSplash')
  assert.ok(start > 0, '没找到 dropSplash：占位页移除入口被改名或删除')
  const seg = code.slice(start, start + 4000)

  assert.match(seg, /requestAnimationFrame\(commitSplashRemove\)/,
    '正常路径：必须仍等一帧再提交（硬切观感依赖它）')
  assert.match(seg, /setTimeout\(commitSplashRemove,\s*SPLASH_RAF_FALLBACK_MS\)/,
    '兜底路径 1 缺失：页面 hidden 时 rAF 不跑，必须有定时器接手')
  assert.match(seg, /addEventListener\(['"]visibilitychange['"]/,
    '兜底路径 2 缺失：窗口变可见时应立刻提交，不该等用户先看到占位页')
  assert.match(seg, /if \(committed\) return/,
    '三条路径必须共用幂等提交，否则会重复 remove、重复派发 app-visible')
  assert.match(seg, /removeEventListener\(['"]visibilitychange['"]/,
    '提交后必须摘掉 visibilitychange 监听器')

  const m = src.match(/const SPLASH_RAF_FALLBACK_MS = (\d+)/)
  assert.ok(m, '缺 SPLASH_RAF_FALLBACK_MS 常量')
  const ms = Number(m[1])
  assert.ok(ms >= 200 && ms <= 600,
    `兜底时长 ${ms}ms 不合理：须 >=200（不误伤实测 ~180ms 的重排帧边界）且 <=600（否则和 900ms 的 rAF 暂停没区别）`)
})
