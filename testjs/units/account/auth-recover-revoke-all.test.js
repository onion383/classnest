// V10-U02-01：本文件的源码串副本变异是**静态旁证**，不是真模块回放；真回放范式见 ai-read-scope-gate.test.js（loadMutated + 依赖 stub + 真调函数）。
// =========================================================================
// auth-recover-revoke-all.test.js —— 恢复改密吊销账号全部班级会话（1-2 / N1 / H7）
//
// 原缺陷：/recover-password 两条分支只 revokeAccountSessions(userId, resolved.slug)
// —— 只吊销当前班那一个。多班账号在另一班窗口的旧 token 带各自的 dbSlug，
// 在 JWT 有效期内仍可读写，等于密码没改。
// 对照：account.js 普通改密用 accountSlugsForRevoke(user) 拿全部班级 slug 传数组。
//
// 判据三层：
//   ① 行为：revokeAccountSessions 传 slug 数组时真的清空所有班（底座支持数组）；
//   ② 接线：两条恢复分支的第二参数是 accountSlugsForRevoke(...)，不是裸 resolved.slug；
//   ③ 变异反证：把参数退回单 slug 后，②必须失败。
// =========================================================================
const test = require('node:test')
const { extractBlockByAnchor } = require('#testjs/units/_mechanism.cjs')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')
const AUTH = path.join(BACKEND, 'routes', 'auth.js')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-recover-revoke-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'recover-revoke-test-key'
process.env.DATA_DIR = DATA_DIR
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ } })

const sessions = require(path.join(BACKEND, 'services', 'sessions'))
const { revokeAccountSessions } = require(path.join(BACKEND, 'services', 'credentialChange'))

function cleanSrc() {
  return fs.readFileSync(AUTH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const recoverHandlerBody = (src) => extractBlockByAnchor(src, "router.post('/recover-password'")

// 接线判据（供主用例与变异反证共用）：两条吊销都要用全班级数组口径。
function checkRevokeWiring(body) {
  const calls = [...body.matchAll(/revokeAccountSessions\([^\n]*\)/g)].map((m) => m[0])
  if (calls.length !== 2) return { ok: false, why: `吊销调用数 ${calls.length} ≠ 2` }
  for (const c of calls) {
    // 第二参数整体是 accountSlugsForRevoke(...) 即数组口径。
    // 不能额外写 /,\s*resolved\.slug\s*\)/ 的 doesNotMatch：helper 入参本身就带
    // resolved.slug，会误伤。变异反证（换成裸 resolved.slug）已能锁住这条判据。
    if (!/accountSlugsForRevoke\s*\(/.test(c)) return { ok: false, why: `${c} 没用全班级数组口径` }
  }
  return { ok: true, calls }
}

// ————————————————————————— ① 行为层 —————————————————————————

test('revokeAccountSessions 传 slug 数组时清空该账号全部班级会话', () => {
  const uid = 55
  const slugA = '@revokeaaa0001'; const slugB = '@revokebbb0001'
  const inA1 = 'ra-a1'; const inA2 = 'ra-a2'; const inB = 'ra-b'; const otherUser = 'ra-other'
  sessions.__test_insert(inA1, uid, Date.now(), slugA)
  sessions.__test_insert(inA2, uid, Date.now(), slugA)
  sessions.__test_insert(inB, uid, Date.now(), slugB)
  sessions.__test_insert(otherUser, uid + 1, Date.now(), slugA) // 别的账号同 slug，不能误伤

  const n = revokeAccountSessions(uid, [slugA, slugB])

  assert.equal(n, 3, '两个班的该账号会话共 3 个都应被吊销')
  assert.equal(sessions.has(inA1), false)
  assert.equal(sessions.has(inA2), false)
  assert.equal(sessions.has(inB), false, '只吊销当前班会放过另一班 token')
  assert.equal(sessions.has(otherUser), true, '不能误伤同 slug 的其它账号')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('两条恢复分支的吊销都用 accountSlugsForRevoke 数组口径', () => {
  const result = checkRevokeWiring(recoverHandlerBody(cleanSrc()))
  assert.equal(result.ok, true, result.why)
})

test('accountSlugsForRevoke 本地 helper 用 listClasses 取全班级、当前班排首位', () => {
  const src = cleanSrc()
  const helper = src.match(/function accountSlugsForRevoke\([^)]*\)[\s\S]*?\n\}/)
  assert.ok(helper, 'auth.js 缺少 accountSlugsForRevoke helper')
  assert.match(helper[0], /listClasses\s*\(/, 'helper 必须用 listClasses 取该账号全部班级')
  assert.match(helper[0], /\[currentSlug,\s*\.\.\.rest\]/, '当前班要排首位（与 account.js 同口径）')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：吊销参数退回单 slug 后，接线判据必须失败', () => {
  const body = recoverHandlerBody(cleanSrc())
  const mutated = body.replace(/revokeAccountSessions\(([^,]+),\s*accountSlugsForRevoke\([^)]*\)\)/g,
    'revokeAccountSessions($1, resolved.slug)')
  assert.ok(mutated !== body, '变异没匹配到任何吊销调用')
  const result = checkRevokeWiring(mutated)
  assert.equal(result.ok, false, '退回单 slug 后接线判据仍判 PASS —— 判据是假绿，没真正锁住全班级口径')
})
