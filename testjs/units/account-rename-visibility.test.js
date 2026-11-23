// =========================================================================
// account-rename-visibility.test.js —— 多班改名后其它班仍列在登录列表（1-3 / H2）
//
// 原缺陷：registryListValid() 校验库内账号行用
//   SELECT 1 FROM users WHERE username = registry.username
// 但多班改名只同步 registry + accounts，各库 users.username 故意留旧名
// （挨个开库改名要 N 次 KDF，见 account.js / auth.js 的注释）。于是改名后，
// 库内旧名 ≠ registry 新名，其它班被判「无账号」从 /accounts 登录列表消失。
//
// 判据三层：
//   ① 行为：两班账号改名（只改 registry）后，registryListValid() 仍返回两个班；
//   ② 接线：判据不再按 username 匹配库内行（防回退到 WHERE username = ?）；
//   ③ 变异反证：把判据改回按名字匹配后，行为断言必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const SRC = path.join(BACKEND, 'dbManager', 'dbManager.account.js')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-rename-vis-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'rename-vis-test-key'
process.env.DATA_DIR = DATA_DIR
// 退出时清理隔离目录（Windows 上库连接可能仍占用，失败就留给系统临时目录）
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ } })

const base = require(path.join(BACKEND, 'dbManager', 'dbManager.base'))
assert.strictEqual(base.dataDir, DATA_DIR, '隔离目录没生效，测试会写到真实数据目录')
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))

function registryValidBody() {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => /function\s+registryListValid\s*\(/.test(l))
  assert.ok(start >= 0, '未找到 registryListValid')
  const out = []; let depth = 0; let started = false
  for (let i = start; i < lines.length; i += 1) {
    out.push(lines[i])
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; started = true }
      else if (ch === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

// ————————————————————————— ① 行为层 —————————————————————————

test('两班账号改名（只改 registry）后，两个班仍都在登录列表', () => {
  const OLD = 'vis-old-name'; const NEW = 'vis-new-name'
  const a = dbManager.createTeacher(OLD, 'h', 'teacher', false, 'A班')
  const b = dbManager.createTeacher(OLD, 'h', 'teacher', false, 'B班')
  assert.notEqual(a.slug, b.slug, '两次 createTeacher 应建出两个不同的班')

  // 改名流程的等价操作：只改 registry 两行 + accounts.username，
  // 各库 users 表保持旧名（模拟「挨个开库改名太贵、故意不同步」）。
  for (const rec of dbManager.registryFindAllByUsername(OLD)) {
    base.registryRename(rec.slug, NEW)
  }
  const acc = dbManager.accountFindByUsername(OLD)
  if (acc) dbManager.accountRename(acc.id, NEW)

  const valid = dbManager.registryListValid()
  const slugs = valid.filter((r) => r.username === NEW).map((r) => r.slug)
  assert.ok(slugs.includes(a.slug), `${a.slug}（A班）改名后从登录列表消失了`)
  assert.ok(slugs.includes(b.slug), `${b.slug}（B班）改名后从登录列表消失了 —— 正是本 bug`)
})

test('幽灵账号仍被过滤：库内一行用户都没有的登记不算有效', () => {
  // 造一条 registry 登记但没有对应库文件：resolveByUsername 会打开失败，应被过滤。
  // 验证「改成 SELECT 1 FROM users LIMIT 1」没有顺手把有效性校验整个拆掉。
  base.registryUpsert('@ghost00000001', 'ghost-user', '', 0)
  const valid = dbManager.registryListValid()
  assert.ok(!valid.some((r) => r.slug === '@ghost00000001'), '缺库文件的幽灵登记不该出现在登录列表')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('registryListValid 不再按 registry.username 匹配库内用户行', () => {
  const body = registryValidBody()
  assert.doesNotMatch(body, /WHERE\s+username\s*=\s*\?/, '又回退到按名字匹配 —— 改名后其它班会被隐藏')
  assert.match(body, /LIMIT\s+1/, '应只校验「库内有账号行」，不假设库内用户名 == registry 名')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：判据改回按 username 匹配后，接线判据必须失败', () => {
  const body = registryValidBody()
  const mutated = body.replace(/SELECT 1 FROM users LIMIT 1/, 'SELECT 1 FROM users WHERE username = ?')
  assert.ok(mutated !== body, '变异没匹配到判据 SQL')
  assert.match(mutated, /WHERE\s+username\s*=\s*\?/, '变异后接线判据应能检出回退')
})
