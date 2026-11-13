// =========================================================================
// _db-express-fixture.cjs —— 后端路由单测的公共夹具
//
// 为什么抽出来：今天加的 7 个路由测试，每个都把同一段 ~20 行抄了一遍
//   （env 兜底 → 内存库 → initSchema → 把 db.js 的 Proxy 与 dbManager.current
//    原地指过去 → express.json → app.use(mount, router) → listen(0)）。
// 抄错了任何一步都是「假绿」：只换 db.js 不换 dbManager.current，
// 走 Proxy 的 insertRow 会打到真实库或抛「未绑定数据库连接」。
//
// 用法（每个测试文件一个夹具；run-units.js 是逐文件起独立 node --test 进程，
// 所以 require.cache / 环境变量这种进程级 stub 不会互相污染）：
//   const fx = createBackendDb({ label: 'album-paging' })
//   const conn = fx.conn
//   // ...顶层造数据...
//   let base
//   test.before(async () => { base = await fx.mount('/api/album', 'student-backend/routes/album.js') })
//   test.after(() => fx.close())
//
// 每个用例要干净库时：
//   test.beforeEach(() => fx.reset())   // 或 fx.reset({ seed: (c) => {...} })
//   const r = await fx.call('POST', '/doc', body)   // → { status, text, json }
//
// 要测「多步写中途失败」时加故障注入（createBackendDb({ label, faults: true })）：
//   fx.inject({ failAt: 2 })                        // 第 2 次 run() 抛错
//   fx.inject({ failMatch: /duty_slots/i, failAtMatch: 1 })  // 匹配该 SQL 的第 1 次写抛错
// 只包 run()（写），get/all 不算写；reset() 会自动清掉注入。
//
// 注意：router 必须由夹具在 stub 装好之后 require，调用方别提前 require 路由。
//
// 为什么 db 是 Proxy 而不是直接给 conn：模块顶层的 `require('../../db')` 会永久
// 持有那一刻的 db 引用，只有「同一对象转发到当前 conn」才能让 reset 换库生效。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
// 原生模块，加载与环境变量无关，可以提前取：调用方造「老库迁移」这类特殊库时要用
const Database = backendRequire('better-sqlite3-multiple-ciphers')

/**
 * 故障注入代理：转发到真连接，但「第 K 次写」或「匹配某 SQL 的第 K 次写」抛错。
 * 只包 run()（写），prepare/get/all 照常 —— 这样「第 K 次写失败」对应业务上的第 K 次落库。
 *
 * 两种注入方式互补：
 *   failAt       绝对写入序号。简单，但业务新增一次写就会整体偏移。
 *   failMatch + failAtMatch   按 SQL 匹配。用例关心的是「哪张表写失败」时用它，
 *                否则一次无关的写会让故障落错步骤，把真 bug 变成假绿（审查 v5 · V5-034）。
 */
function makeFaultyDb(conn, fault) {
  return new Proxy({}, {
    get(_target, prop) {
      const value = conn[prop]
      if (typeof value !== 'function') return value
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = conn.prepare(sql)
          return new Proxy(stmt, {
            get(s, p) {
              const v = s[p]
              if (p === 'run') {
                return (...args) => {
                  fault.writes += 1
                  if (fault.failMatch && fault.failMatch.test(sql)) {
                    fault.matchWrites += 1
                    if (fault.failAtMatch > 0 && fault.matchWrites === fault.failAtMatch) {
                      throw new Error('注入故障：匹配 ' + fault.failMatch + ' 的第 ' + fault.matchWrites + ' 次写入失败')
                    }
                  }
                  if (fault.failAt > 0 && fault.writes === fault.failAt) {
                    throw new Error('注入故障：第 ' + fault.writes + ' 次写入失败')
                  }
                  return v.apply(s, args)
                }
              }
              if (typeof v === 'function') return v.bind(s)
              return v
            },
          })
        }
      }
      return value.bind(conn)
    },
  })
}

/**
 * 同步部分：造内存库 + 装好进程级 stub。返回 { conn, base, router, mount, call, reset, close }。
 * @param {{ label: string, currentSlug?: string, dataDir?: string,
 *           extraDbExports?: Object, dbKey?: string, faults?: boolean }} opts
 *   dataDir        —— 有些老测试要用自己的临时目录（放快照/附件），不覆盖它的选择
 *   extraDbExports —— db.js 除 db / getFields 外还要替换的导出（如 renumber）
 *   dbKey          —— 主密钥默认值，默认用 label 派生
 *   faults         —— 打开故障注入（fx.inject / fx.clearFaults 才有意义）
 */
function createBackendDb({ label, currentSlug, dataDir, extraDbExports, dbKey, faults } = {}) {
  if (!label) throw new Error('createBackendDb 需要 label（用于临时目录与密钥，避免串库）')
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || (dbKey || `${label}-test-key`)
  process.env.DATA_DIR = dataDir || process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))

  const { initSchema } = require('../../student-backend/schema/schema')

  // 当前库放在可变槽里：模块顶层 require 到的 db 引用是永久的，只有「同一对象
  // 转发到当前槽」才能让 reset() 换库后依然生效。
  const state = { conn: null }

  const fault = { writes: 0, failAt: 0, failMatch: null, failAtMatch: 0, matchWrites: 0 }
  function clearFaults() {
    fault.writes = 0
    fault.failAt = 0
    fault.failMatch = null
    fault.failAtMatch = 0
    fault.matchWrites = 0
  }
  /** 装一次故障注入（会先清掉上一次的）。opts: { failAt } 或 { failMatch, failAtMatch } */
  function inject(opts = {}) {
    clearFaults()
    Object.assign(fault, opts)
    return fault
  }

  // 故障代理按库缓存：每次属性访问都 new 一个 Proxy 会让 `db.transaction` 之类
  // 拿到互不相等的函数引用，也白白多一层包装。
  let faulty = { conn: null, proxy: null }
  function backend() {
    if (!faults) return state.conn
    if (faulty.conn !== state.conn) faulty = { conn: state.conn, proxy: makeFaultyDb(state.conn, fault) }
    return faulty.proxy
  }

  const dbProxy = new Proxy({}, {
    get(_target, prop) {
      const c = state.conn
      if (!c) return undefined
      const v = backend()[prop]
      return typeof v === 'function' ? v.bind(backend()) : v
    },
  })

  // db.js 导出的是 Proxy，转发到 dbManager.current()。两处都要原地改属性：
  // 换成新对象的话，已经持有旧引用的模块看不到。
  const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
  const realDb = require(dbPath)
  require.cache[dbPath].exports = {
    ...realDb,
    db: dbProxy,
    getFields: (tableName) => state.conn.prepare(
      'SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order'
    ).all(tableName),
    ...(extraDbExports || {}),
  }
  const dbmPath = require.resolve(path.join(ROOT, 'student-backend/dbManager/dbManager.js'))
  const dbm = require(dbmPath)
  dbm.current = () => state.conn
  if (currentSlug) dbm.currentSlug = () => currentSlug

  let server = null
  let app = null
  let base = null
  let origin = null
  const fx = { router: null, mount, close, reset, call, inject, clearFaults }
  Object.defineProperty(fx, 'conn', { get: () => state.conn, enumerable: true })
  Object.defineProperty(fx, 'base', { get: () => base, enumerable: true })

  /**
   * 换一个干净的内存库（关掉上一个）。每个用例要互不影响时放 test.beforeEach。
   * @param {{ seed?: (conn: any) => void }} [opts]  seed 在 initSchema 之后立刻执行
   */
  function reset({ seed } = {}) {
    if (state.conn) { try { state.conn.close() } catch (_) { /* 已关闭 */ } }
    const conn = new Database(':memory:')
    initSchema(conn)
    state.conn = conn
    clearFaults() // 上一个用例注入的故障不能漏到下一个
    if (typeof seed === 'function') seed(conn)
    return conn
  }
  reset() // 顶层先备一个空库：调用方习惯「createBackendDb 之后立刻造数据」

  /**
   * 异步部分：把真实路由挂到 express 上，返回可直接 fetch 的 base URL。
   * routerOrRel 可以是模块相对路径，也可以是已经建好的 router 实例
   * （如 createDynamicTableRouter(...)）—— 实例必须由调用方在 stub 装好后创建。
   * 可以多次调用挂不同前缀（如座位 + AI 两个路由），共用同一个 server。
   */
  async function mount(mountPath, routerOrRel) {
    const express = backendRequire('express')
    if (!app) {
      app = express()
      app.use(express.json())
    }
    // 必须在 stub 之后 require：路由模块顶部就捕获了 db 句柄
    const router = typeof routerOrRel === 'string' ? require(path.join(ROOT, routerOrRel)) : routerOrRel
    fx.router = router
    app.use(mountPath, router)
    if (!server) {
      server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
      origin = `http://127.0.0.1:${server.address().port}`
      base = `${origin}${mountPath}`
    }
    return `${origin}${mountPath}`
  }

  /**
   * 发一个 JSON 请求，返回 { status, text, json }（非 JSON 响应也保留原文）。
   * subPath 两种写法都行：'/cell'（相对 mount 路径）或 '/api/seats/cell'（绝对路由）。
   */
  async function call(method, subPath, body) {
    if (!base) throw new Error('call() 之前要先 await fx.mount(...)')
    const url = subPath.startsWith('/api') ? `${origin}${subPath}` : base + subPath
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* Express 错误页不是 JSON，也是信息 */ }
    return { status: res.status, text, json }
  }

  function close() {
    if (server) { try { server.close() } catch (_) { /* 已关闭 */ } server = null; app = null; base = null; origin = null }
    if (state.conn) { try { state.conn.close() } catch (_) { /* 已关闭 */ } state.conn = null }
  }

  // 路由实例挂到夹具上：有些用例要直接调 router 上的导出函数（如 scores.dashboardSummary），
  // 不必再自己 require 一遍 —— 那很容易在 stub 装好之前发生。
  return fx
}

module.exports = { createBackendDb, ROOT, Database, backendRequire }
