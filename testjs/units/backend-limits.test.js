// =========================================================================
// backend-limits.test.js —— 「无界资源 / 入口收敛 / 密钥派生」的行为断言
//
// 覆盖 v4 台账 B04-04 / B04-06 / B04-07 / B04-09（批 16）：
//   · B04-04 ffmpeg 下载递归跟随重定向**无次数上限** → 重定向环会无限递归、爆栈。
//   · B04-06 会话 sid 名单**无 TTL / 无容量上限** → .sessions.json 单调增长，
//     登出只删一个 sid，其余永远留着。
//   · B04-07 恢复词哈希**没有版本标识** → 将来换算法时无法区分新旧哈希。
//     （台账说的「前 3 词确认门约 24bit 熵」在代码里并不存在 —— 校验一律用完整 12 字。）
//   · B04-09 undo 路由的 `:id` 没按项目既有口径收敛整数（`Number.isInteger(id) && id > 0`）。
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '../..')
const DATA_DIR = path.join(os.tmpdir(), 'limits-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = DATA_DIR

// ---------------------------------------------------------------------------
// B04-04：重定向次数上限
// ---------------------------------------------------------------------------

test('ffmpeg 下载：重定向次数必须有上限（重定向环不能无限递归）', { timeout: 15000 }, async () => {
  const ffmpeg = require('../../student-backend/services/ffmpeg')
  const { download, MAX_REDIRECTS } = ffmpeg

  assert.ok(
    Number.isInteger(MAX_REDIRECTS) && MAX_REDIRECTS > 0 && MAX_REDIRECTS <= 20,
    '必须定义一个合理上限的常量（实际 ' + MAX_REDIRECTS + '）'
  )

  // 用一个「永远重定向到自己」的假 http 服务器复现重定向环。
  // （不能用 https：本地假服务器没有证书，握手就失败了，测不到重定向逻辑。）
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    res.statusCode = 302
    res.setHeader('location', `http://127.0.0.1:${server.address().port}${req.url}`)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dest = path.join(DATA_DIR, 'redir-loop.zip')
  ffmpeg.__setTransport(http)
  try {
    await assert.rejects(
      () => download(`http://127.0.0.1:${port}/x`, dest),
      (err) => {
        assert.ok(
          /重定向|redirect/i.test(err && err.message),
          '重定向超限应给出明确错误（实际 ' + (err && err.message) + '）'
        )
        return true
      },
      '重定向环必须被拒绝，不能无限递归'
    )
  } finally {
    ffmpeg.__setTransport(null)
    // Node 19+ 的全局 agent 默认 keep-alive：不断掉空闲连接，server.close() 会一直
    // 等到 keepAliveTimeout（默认 5s）才回调，单测白等 5 秒。
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---------------------------------------------------------------------------
// B04-06：会话名单的 TTL 与容量上限
// ---------------------------------------------------------------------------

test('sessions：sid 名单必须有 TTL 与容量上限（不能单调增长）', () => {
  const sessions = require('../../student-backend/services/sessions')

  assert.ok(
    Number.isInteger(sessions.SESSION_TTL_MS) && sessions.SESSION_TTL_MS > 0,
    '必须定义会话 TTL（实际 ' + sessions.SESSION_TTL_MS + '）'
  )
  assert.ok(
    Number.isInteger(sessions.MAX_SESSIONS) && sessions.MAX_SESSIONS > 0,
    '必须定义会话数量上限（实际 ' + sessions.MAX_SESSIONS + '）'
  )

  // 清理过期项：往名单里塞一条「很久以前」的会话
  const stale = sessions.__test_insert('s-stale', 1, Date.now() - sessions.SESSION_TTL_MS - 60000)
  assert.ok(stale, '测试辅助：应能插入一条过期会话')
  sessions.prune()
  assert.equal(sessions.has('s-stale'), false, '过期会话必须被清掉（名单不能单调增长）')

  // 容量上限：塞满 MAX_SESSIONS + 10 条，最老的应被挤掉
  for (let i = 0; i < sessions.MAX_SESSIONS + 10; i++) {
    sessions.__test_insert('s-fill-' + i, 1, Date.now() - (sessions.MAX_SESSIONS + 10 - i) * 1000)
  }
  sessions.prune()
  const size = sessions.__test_size()
  assert.ok(
    size <= sessions.MAX_SESSIONS,
    '会话数不得超过上限 ' + sessions.MAX_SESSIONS + '（实际 ' + size + '）'
  )
})

test('sessions：正常会话不能被误清（TTL 内的会话必须仍然有效）', () => {
  const sessions = require('../../student-backend/services/sessions')
  const sid = sessions.create(42)
  sessions.prune()
  assert.equal(sessions.has(sid), true, 'TTL 内的会话必须仍然有效')
  assert.equal(sessions.revoke(sid), true, '登出必须能吊销')
  assert.equal(sessions.has(sid), false, '吊销后必须失效')
})

// ---------------------------------------------------------------------------
// B04-07：恢复词哈希的版本标识
// ---------------------------------------------------------------------------

test('recoveryKey：恢复词哈希必须带版本标识（为将来换算法留门）', () => {
  const rk = require('../../student-backend/services/recoveryKey')

  const h = rk.deriveRestoreHash('水光风')
  assert.ok(typeof h === 'string' && h.length > 0, '哈希必须是非空字符串')

  assert.ok(
    typeof rk.RESTORE_HASH_VERSION === 'string' && rk.RESTORE_HASH_VERSION.length > 0,
    '必须导出版本常量（实际 ' + rk.RESTORE_HASH_VERSION + '）'
  )
  assert.ok(
    h.includes(rk.RESTORE_HASH_VERSION),
    '哈希里必须含版本标识「' + rk.RESTORE_HASH_VERSION + '」（实际 ' + h + '）'
  )
})

test('recoveryKey：现存用户的旧哈希必须仍能校验（不能作废已发的恢复词）', () => {
  const rk = require('../../student-backend/services/recoveryKey')
  const crypto = require('node:crypto')
  // 旧算法：单轮 sha256('restore:' + phrase)，无版本前缀 —— 这是**已发布**版本写进库的值
  const legacyHash = crypto.createHash('sha256').update('restore:' + '水光风').digest('hex')

  const ok = rk.verifyRestoreHash('水光风', legacyHash)
  assert.equal(ok, true, '旧哈希必须仍能校验通过（否则已发的恢复词永久失效）')

  const bad = rk.verifyRestoreHash('水月光', legacyHash)
  assert.equal(bad, false, '词不对必须拒绝')
})

test('recoveryKey：verifyRestoreHash 对新哈希也必须成立，且不能误判', () => {
  const rk = require('../../student-backend/services/recoveryKey')
  const h = rk.deriveRestoreHash('山水日月')
  assert.equal(rk.verifyRestoreHash('山水日月', h), true, '新哈希必须能校验通过')
  assert.equal(rk.verifyRestoreHash('山水月明', h), false, '词不对必须拒绝')
  assert.equal(rk.verifyRestoreHash('山水日月', ''), false, '空哈希必须拒绝')
  assert.equal(rk.verifyRestoreHash('山水日月', null), false, 'null 哈希必须拒绝')
})

// ---------------------------------------------------------------------------
// B04-09：undo 路由的 :id 收敛
// ---------------------------------------------------------------------------

test('undo 路由：非整数 / 非正数的 :id 必须被拒（不能靠 NaN 静默查不到）', async () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/undo/undo.js'), 'utf8')

  // 路由里必须有一个统一的 id 收敛函数（而不是各处裸 Number(...)）
  assert.ok(
    /function parseUndoId\s*\(/.test(src),
    '必须定义统一的 id 收敛函数 parseUndoId（各处裸 Number(req.params.id) 收不住 NaN/小数/0）'
  )
  const parseFn = src.match(/function parseUndoId\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(parseFn, '必须能取到 parseUndoId 的函数体')
  assert.ok(
    /Number\.isInteger\(/.test(parseFn[1]),
    'parseUndoId 必须用 Number.isInteger 判整数（否则 Number("1.5") → 1.5 会被当成合法 id）'
  )
  assert.ok(
    /<=\s*0/.test(parseFn[1]),
    'parseUndoId 必须拒绝非正数（id 必须是正整数）'
  )

  // 三处 :id 路由都必须走这个收敛函数
  const idRoutes = src.match(/router\.(post|delete)\('\/:id[^']*'/g) || []
  assert.equal(idRoutes.length, 3, 'undo.js 里应有 3 处 :id 路由（实际 ' + idRoutes.length + '）')
  const uses = src.match(/parseUndoId\(req\.params\.id\)/g) || []
  assert.equal(
    uses.length, 3,
    '每处 :id 路由都必须走 parseUndoId（实际 ' + uses.length + ' 处）'
  )

  // 收敛失败必须回 400（不能静默当「记录不存在」）
  const guards = src.match(/id == null\) return res\.status\(400\)/g) || []
  assert.equal(
    guards.length, 3,
    '每处 :id 路由都必须对收敛失败回 400（实际 ' + guards.length + ' 处）'
  )
})
