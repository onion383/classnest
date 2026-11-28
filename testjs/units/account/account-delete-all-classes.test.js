// V10-U02-01：本文件的源码串副本变异是**静态旁证**，不是真模块回放；真回放范式见 ai-read-scope-gate.test.js（loadMutated + 依赖 stub + 真调函数）。
// =========================================================================
// account-delete-all-classes.test.js —— 删账号销毁全部班级（1-11 / #4）
//
// 原缺陷：DELETE /api/account 只 deleteTeacher(当前 dbSlug)，多班账号删号后
// 其它班仍留在 registry 且凭证未清 —— 用户退出后还能用别的班登录。
// 修法：删库前收集账号名下全部 slug，逐个 deleteTeacher（最后一个会自动清 accounts），
// 再按全部 slug 吊销会话。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-delete-account-'))
// 进程退出统一清理，避免每次跑测试在 %TEMP% 留下目录（tmp-leak 判据）
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* 仍被占用留给系统清理 */ }
})
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'delete-account-test-key'
process.env.DATA_DIR = DATA_DIR

const BACKEND = abs('student-backend')
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会删真实数据')
const sessions = require(path.join(BACKEND, 'services', 'sessions'))
const { revokeAccountSessions } = require(path.join(BACKEND, 'services', 'credentialChange'))

// ————————————————————————— ① 行为层 —————————————————————————

test('逐个 deleteTeacher 后：全部班级库文件与账号凭证都消失', () => {
  const NAME = 'delete-all-user'
  const a = dbManager.createTeacher(NAME, 'h', 'teacher', false, 'A班')
  const b = dbManager.createTeacher(NAME, 'h', 'teacher', false, 'B班')
  const cls = dbManager.registryFindAllByUsername(NAME).map((c) => c.slug)
  assert.equal(cls.length, 2)
  const acc = dbManager.accountFindByUsername(NAME)
  assert.ok(acc, '建班后应有 accounts 行')

  // 模拟新 handler：收集全部 slug → 逐个删
  for (const slug of cls) dbManager.deleteTeacher(slug)

  for (const slug of [a.slug, b.slug]) {
    assert.ok(!fs.existsSync(dbManager.dbFilePath(slug)), `${slug} 的库文件没删掉`)
  }
  assert.equal(dbManager.registryFindAllByUsername(NAME).length, 0, 'registry 还有残留班')
  assert.equal(dbManager.accountFindByUsername(NAME), undefined, '最后一个班删完应清掉 accounts 凭证')
})

test('只删当前班（旧行为）会留下其它班与凭证 —— 反证 bug 成立', () => {
  const NAME = 'delete-one-user'
  const a = dbManager.createTeacher(NAME, 'h', 'teacher', false, 'A班')
  dbManager.createTeacher(NAME, 'h', 'teacher', false, 'B班')
  dbManager.deleteTeacher(a.slug) // 旧行为：只删当前班
  assert.ok(dbManager.registryFindAllByUsername(NAME).length >= 1, '旧行为会留下其它班')
  assert.ok(dbManager.accountFindByUsername(NAME), '旧行为下账号凭证还在 —— 仍能登录')
})

test('按全部 slug 吊销：两个班的旧会话都失效', () => {
  const uid = 77
  const slugA = '@dela00000001'; const slugB = '@delb00000001'
  sessions.__test_insert('sa1', uid, Date.now(), slugA)
  sessions.__test_insert('sb1', uid, Date.now(), slugB)
  revokeAccountSessions(uid, [slugA, slugB])
  assert.equal(sessions.has('sa1'), false)
  assert.equal(sessions.has('sb1'), false)
})

// ————————————————————————— ② 接线层 —————————————————————————

function deleteHandler() {
  const src = read('student-backend/routes/account.js')
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  return parts.find((p) => p.startsWith("router.delete('/'"))
}

test('删号 handler 收集全部班级并逐个删，按数组吊销', () => {
  const h = deleteHandler()
  assert.ok(h, '未找到 DELETE / handler')
  assert.match(h, /registryFindAllByUsername\(/, '必须先收集全部班级')
  assert.match(h, /for \(const slug of slugs\) dbManager\.deleteTeacher\(slug\)/, '要逐个删全部班')
  assert.match(h, /revokeAccountSessions\(u\.userId,\s*slugs\)/, '吊销必须按全部 slug')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：把 handler 改回只删当前班后，接线判据必须失败', () => {
  const h = deleteHandler()
  const mutated = h.replace(/for \(const slug of slugs\) dbManager\.deleteTeacher\(slug\)/,
    'dbManager.deleteTeacher(u.dbSlug)')
  assert.ok(mutated !== h, '变异没匹配到逐个删除循环')
  assert.ok(!/for \(const slug of slugs\) dbManager\.deleteTeacher/.test(mutated),
    '变异后接线判据应判失败')
})
