// =========================================================================
// cache-guards.test.js —— v8 审查 B-7（RC-CACHE）缓存 / 代次 / 变更判据
//
// 覆盖：
//   · F04-02 删除当前会话后作废在途历史/补载代次
//   · F04-06 useAccessLog 的 load/loadSummary/clear 共用代次
//   · F04-07 usePrivacyConfig.load 不覆盖在途写字段
//   · F04-10 useSeatGrid.load 只认最后一次
//   · K01-03 增量扫描按 mtime + 大小判源图变更（见 album-scan-incremental-thumb）
//   · P2-01 限流桶无门槛回收过期项 + 条数硬顶
//   · P2-06 列名缓存条数硬顶
//   · P2-09 ffmpeg 缓存清理旧版本目录
//   · Q1-09 表头值筛选上限 200 项
// 变异反证：去掉任一守卫 / 硬顶，对应断言即红。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')


test('F04-02：删除会话成功后作废在途历史/补载代次', () => {
  const src = read('student-frontend/src/composables/ai/aiConversations.js')
  const at = src.indexOf('async onDeleteConfirm()')
  const fn = src.slice(at, src.indexOf('loadConversationList()', at))
  assert.match(fn, /await axios\.delete\(/)
  assert.match(fn, /convSeq\.invalidate\(\)/, '删除成功必须作废在途响应，否则旧会话消息会落回空上下文')
})

test('F04-06：useAccessLog 的 load/loadSummary/clear 共用代次守卫', () => {
  const src = read('student-frontend/src/composables/useAccessLog.js')
  assert.match(src, /import \{ createLatest \} from '\.\.\/utils\/latestOnly\.js'/)
  assert.match(src, /const seq = createLatest\(\)/)

  const load = src.slice(src.indexOf('async function load('), src.indexOf('async function saveConfig'))
  assert.match(load, /const my = seq\.begin\(\)/)
  assert.ok((load.match(/seq\.isCurrent\(my\)/g) || []).length >= 2, '成功/失败两条路径都要判代次')
  assert.ok((load.match(/seq\.isCurrent\(my\)/g) || []).length >= 3, 'finally 里收尾 loading 也要判')

  const summary = src.slice(src.indexOf('async function loadSummary()'), src.indexOf('async function saveConfig'))
  assert.match(summary, /const my = seq\.begin\(\)/)
  assert.match(summary, /if \(!seq\.isCurrent\(my\)\) return/)

  const clear = src.slice(src.indexOf('async function clear()'))
  assert.match(clear, /seq\.invalidate\(\)/, '清空后在途 load 不能把已清记录写回')
})

test('F04-07：usePrivacyConfig.load 有代次，在途写字段不被旧快照覆盖', () => {
  const src = read('student-frontend/src/composables/usePrivacyConfig.js')
  assert.match(src, /const loadSeq = createLatest\(\)/)
  const load = src.slice(src.indexOf('async function load()'), src.indexOf('// 开关类字段'))
  assert.match(load, /const my = loadSeq\.begin\(\)/)
  assert.match(load, /if \(!loadSeq\.isCurrent\(my\)\) return/)
  assert.match(load, /for \(const k of pendingWrites\.keys\(\)\) delete data\[k\]/,
    '写路径在途的字段要保留本地乐观值')
  assert.match(load, /pendingWrites\.has\('table:' \+ t\.key\)/, '单表权限档同样跳过在途项')
  assert.match(src, /loadSeq\.invalidate\(\)/, '写请求结束要作废早于写入落库的 load')
})

test('F04-10：useSeatGrid.load 只认最后一次响应', () => {
  const src = read('student-frontend/src/composables/useSeatGrid.js')
  assert.match(src, /const loadSeq = createLatest\(\)/)
  const fn = src.slice(src.indexOf('async function load()'), src.indexOf('// 串行保存器'))
  assert.match(fn, /const my = loadSeq\.begin\(\)/)
  assert.ok((fn.match(/loadSeq\.isCurrent\(my\)/g) || []).length >= 2, '成功/失败分支都要判代次')
})

test('Q1-09：表头值筛选最多渲染 200 项并提示截断', () => {
  const src = read('student-frontend/src/components/tables/DynamicTable/DynamicTable.filter.vue')
  assert.match(src, /const OPTION_LIMIT = 200/)
  assert.match(src, /filteredOptions\.value\.slice\(0, OPTION_LIMIT\)/)
  assert.match(src, /const truncated = computed\(\(\)/)
  assert.match(src, /仅显示前/)
})

test('P2-01：限流桶过期即回收（无条数门槛），超硬顶淘汰最旧', () => {
  const fx = createBackendDb({ label: 'rate-prune' })
  try {
    const rate = backendRequire(abs('student-backend/services/mcpRateLimit.js'))
    rate._resetForTest()
    rate._setLimitsForTest({ read: { perMin: 1, label: '读取' } })

    const t0 = 1_000_000
    for (const s of ['a', 'b', 'c']) rate.checkAndConsume(s, 'read', t0)
    assert.equal(rate._sizeForTest(), 3)

    // 越过窗口：旧实现 `size < 200 直接 return` 会把过期桶全部留在 Map 里
    rate.checkAndConsume('d', 'read', t0 + rate.WINDOW_MS + 1)
    assert.equal(rate._sizeForTest(), 1, '过期桶必须被清掉，只剩新桶')

    const t1 = t0 + rate.WINDOW_MS + 1
    for (let i = 0; i < 5001; i++) rate.checkAndConsume('k' + i, 'read', t1)
    assert.equal(rate.checkAndConsume('k0', 'read', t1).ok, true, '最旧桶被淘汰后应重新计数')
    assert.equal(rate.checkAndConsume('k5000', 'read', t1).ok, false, '最新桶仍在额度内')

    rate._resetForTest()
  } finally {
    fx.close()
  }
})

test('P2-06 / X3-17：列名缓存有条数硬顶，外部 DDL 后按 schema_version 重读', () => {
  const fx = createBackendDb({ label: 'col-cache' })
  try {
    const conn = fx.conn
    const aiStore = backendRequire(abs('student-backend/services/aiStore.js'))

    for (let i = 0; i <= 500; i++) conn.exec(`CREATE TABLE t${i} (id INTEGER PRIMARY KEY)`)
    for (let i = 0; i <= 500; i++) aiStore.tableColumns('t' + i)

    // 第 501 个键写入时最旧的 t0 被淘汰
    let keys = aiStore._colCacheKeysForTest()
    assert.equal(keys.length, 500, '缓存条数必须被硬顶截住')
    assert.ok(!keys.some((k) => k.endsWith(':t0')), '最旧键应已淘汰')
    assert.ok(keys.some((k) => k.endsWith(':t500')), '最新键应仍在缓存')

    // 外部 DDL（不经 clearTableColumnsCache）：schema_version 变化必须触发重读
    conn.exec('CREATE TABLE t_ver (id INTEGER)')
    assert.deepEqual(aiStore.tableColumns('t_ver'), ['id'])
    conn.exec('ALTER TABLE t_ver ADD COLUMN extra TEXT')
    assert.ok(aiStore.tableColumns('t_ver').includes('extra'), '外部改结构后不能读到陈旧列清单')
  } finally {
    fx.close()
  }
})

test('P2-09：下载成功后清掉不再使用的旧版本目录', async () => {
  const fx = createBackendDb({ label: 'ffmpeg-cache' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-cache-'))
  try {
    const { __pruneOldVersions } = backendRequire(abs('student-backend/services/ffmpeg.js'))
    const oldBin = path.join(dir, 'old', 'bin')
    const newBin = path.join(dir, 'new', 'bin')
    fs.mkdirSync(oldBin, { recursive: true })
    fs.mkdirSync(newBin, { recursive: true })
    fs.writeFileSync(path.join(oldBin, 'ffmpeg'), 'old')
    fs.writeFileSync(path.join(newBin, 'ffmpeg'), 'new')

    await __pruneOldVersions(dir, ['old', 'new'], path.join(newBin, 'ffmpeg'))

    assert.equal(fs.existsSync(path.join(dir, 'old')), false, '旧版本目录必须被清掉')
    assert.equal(fs.existsSync(path.join(newBin, 'ffmpeg')), true, '正在使用的版本不能删')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fx.close()
  }
})
