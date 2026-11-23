// =========================================================================
// auth-recover-hash-sync.test.js —— 恢复改密必须同步账号权威哈希（1-1 / #3 / 独立 H1）
//
// 原缺陷：/recover-password 的两条分支（超级隐私用恢复词、普通恢复词哈希）
// 只写库内 users.password，没同步 accounts.password_hash。登录校验以
// accounts.password_hash 为权威（auth.js 的 hashSource），于是「恢复改密成功」
// 后新密码登录仍被旧哈希判 401，旧密码又因库钥匙已换行开不了库 —— 账号锁死。
// 对照：account.js 普通改密 (:607) 早已写对，这里正是「一处修了、兄弟没修」。
//
// 判据分三层：
//   ① 行为：accountSetPassword 真的改账号表权威哈希（底座不假绿）；
//   ② 接线：两条恢复分支各自在写 users.password 后同步账号表（防只修一条）；
//   ③ 变异反证：临时抹掉源码里的同步调用，②必须失败 —— 证明判据不是恒真。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const AUTH = path.join(BACKEND, 'routes', 'auth.js')

// 隔离 dataDir：必须早于 require dbManager
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-recover-hash-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'recover-hash-test-key'
process.env.DATA_DIR = DATA_DIR
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ } })

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const base = require(path.join(BACKEND, 'dbManager', 'dbManager.base'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写到真实数据目录')

function cleanSrc() {
  return fs.readFileSync(AUTH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// 函数体切片：从 router.post('/recover-password' 起按花括号深度切到 handler 结束。
// 不能用「全文含 accountSetPassword」判据 —— 普通改密也在同文件，会假绿。
function recoverHandlerBody(src) {
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => /router\.post\(\s*['"]\/recover-password['"]/.test(l))
  assert.ok(start >= 0, '未找到 /recover-password handler')
  const out = []
  let depth = 0; let started = false
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    out.push(line)
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true }
      else if (ch === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

// 数「写 users.password 后紧跟同步账号表」的分支数：
// 每个 setPasswordByName 之后的窗口里必须出现 accountSetPassword。
function syncBranchCount(body) {
  const writes = [...body.matchAll(/setPasswordByName\s*\(/g)]
  let synced = 0
  for (const m of writes) {
    const window = body.slice(m.index, m.index + 500)
    if (/accountSetPassword\s*\(/.test(window)) synced += 1
  }
  return { writes: writes.length, synced }
}

// ————————————————————————— ① 行为层 —————————————————————————

test('accountSetPassword 真的改 accounts.password_hash（底座不假绿）', () => {
  const id = base.accountCreate('recover-sync-user', 'hash-old', 'teacher')
  assert.equal(dbManager.accountFindByUsername('recover-sync-user').password_hash, 'hash-old')

  dbManager.accountSetPassword(id, 'hash-new')

  assert.equal(dbManager.accountFindByUsername('recover-sync-user').password_hash, 'hash-new',
    '同步函数没改权威列，接线再对也没用')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('恢复改密两条分支写 users.password 后都同步账号表', () => {
  const { writes, synced } = syncBranchCount(recoverHandlerBody(cleanSrc()))
  assert.equal(writes, 2, `应有两条写密码分支（隐私库 + 普通恢复词），实际 ${writes}`)
  assert.equal(synced, 2, `两条分支都要同步权威哈希，实际只有 ${synced} 条 —— 漏的那条会锁死账号`)
})

test('同步写的是权威账号名，不是库内可能过期的旧名', () => {
  // 多班改名的账号：库内 users.username 可能还是旧名，但登录与改密认 accounts 里的名字。
  // 这里只校验源码写法：用 name / user.username 查 accountFindByUsername，
  // 且同步的哈希与写入 users.password 的是同一个变量（不能写一个、同步另一个）。
  const body = recoverHandlerBody(cleanSrc())
  assert.ok(/accountFindByUsername\s*\(\s*name\s*\)/.test(body), '隐私库分支要按账号名查 acc')
  assert.ok(/accountFindByUsername\s*\(\s*user\.username\s*\)/.test(body), '恢复词分支要按账号名查 acc')
  // 两块同步各用到刚算出的哈希：newHash / passwordHash
  assert.match(body, /setPasswordByName\([^;]*newHash\);[\s\S]{0,400}accountSetPassword\([^;]*newHash\)/,
    '隐私库分支写入与同步的哈希不一致')
  assert.match(body, /setPasswordByName\([^;]*passwordHash\);[\s\S]{0,400}accountSetPassword\([^;]*passwordHash\)/,
    '恢复词分支写入与同步的哈希不一致')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：抹掉两条同步调用后，接线判据必须失败', () => {
  const original = cleanSrc()
  // 抹掉形如 `try { const acc = dbManager.accountFindByUsername(...);
  // if (acc) dbManager.accountSetPassword(...); } catch (err) { console.warn(...) }` 的同步块。
  // 行注释已被 cleanSrc 去掉，所以按代码结构匹配，不依赖注释文字。
  const syncBlock = /\n\s*try\s*\{\s*\n\s*const acc = dbManager\.accountFindByUsername\([^\n]*\);\s*\n\s*if \(acc\) dbManager\.accountSetPassword\([^\n]*\);\s*\n\s*\}\s*catch \(err\) \{\s*\n\s*console\.warn\('\[auth\] 恢复改密同步账号密码失败:'[^\n]*\n\s*\}\n/g
  const mutated = original.replace(syncBlock, '\n')
  // 先确认变异真的抹掉了东西（否则下面的断言是假绿）
  assert.ok(mutated.length < original.length, '变异正则没匹配到任何同步块，反证失效')
  const { synced } = syncBranchCount(recoverHandlerBody(mutated))
  assert.ok(synced < 2, `变异后仍判 PASS（synced=${synced}）—— 接线判据是假绿，没真正锁住同步调用`)
})
