// =========================================================================
// conversation-shell-retention.test.js —— AI 会话空壳纳入保留策略（V9 · 5-6）
//
// 背景：ai_conversations 壳行没有保留策略，消息被清后会话行单调增长。
// 用户口径：**AI 数据不要自己清理** —— 默认 forever、无定时器、写入路径不自动删。
// 本卡只做「空壳纳入 + 手动清理可达」，默认值不变。
//
// 安全红线：ai_messages.conversation_id → ai_conversations(id) ON DELETE CASCADE。
// 若按 created_at 直接删会话，会把用户明明想留（messages=forever）的消息一起带走。
// 因此 conversations 的所有删除路径都只认「没有消息的空壳」。
//
// 判据：真库行为 + 真变异反证（改掉 SHELL_ONLY 后保护用例必须红）。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'conversation-shell-retention' })
test.after(() => fx.close())
const retention = require('../../../student-backend/services/retentionStore')

const OLD = '2026-01-01 00:00:00'
const NEW = '2026-11-20 00:00:00'

// 四段会话：旧空壳 / 旧但有消息 / 新空壳 / 新且有消息
function seed() {
  const c = fx.reset()
  const ins = c.prepare(`
    INSERT INTO ai_conversations (id, title, summary, created_at, updated_at)
    VALUES (?, ?, '', ?, ?)
  `)
  ins.run(1, '旧空壳', OLD, OLD)
  ins.run(2, '旧带消息', OLD, NEW)
  ins.run(3, '新空壳', NEW, NEW)
  ins.run(4, '新带消息', NEW, NEW)
  c.prepare(`INSERT INTO ai_messages (conversation_id, role, content, created_at)
             VALUES (2, 'user', '旧会话里的新消息', ?)`).run(NEW)
  c.prepare(`INSERT INTO ai_messages (conversation_id, role, content, created_at)
             VALUES (4, 'user', '新会话消息', ?)`).run(NEW)
  return c
}

test('默认策略：conversations 是 forever，写入路径 autoClean 也不删', () => {
  const c = seed()
  assert.equal(retention.readPolicy().conversations, 'forever')
  assert.deepEqual(retention.autoClean('conversations'), { deleted: 0, days: null })
  // 即便用户显式设了 7d，会话空壳仍不接写入路径自动清理
  retention.writePolicy({ conversations: '7d' })
  assert.deepEqual(retention.autoClean('conversations'), { deleted: 0, days: null })
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get().n, 4)
})

test('占用统计只数空壳：有消息的会话不计入，避免显示数量和能清数量不符', () => {
  seed()
  const s = retention.stats()
  assert.equal(s.conversations.count, 2, '旧空壳 + 新空壳')
  assert.ok(s.conversations.bytes > 0)
  const items = retention.list('conversations', 10)
  assert.equal(items.length, 2)
  assert.ok(items.every(x => x.title.includes('空壳')))
})

test('手动删除全部：只清空壳，有消息的会话和消息一条不动（CASCADE 安全）', () => {
  const c = seed()
  const r = retention.deleteAll('conversations')
  assert.equal(r.deleted, 2)
  assert.deepEqual(
    c.prepare('SELECT title FROM ai_conversations ORDER BY id').all().map(x => x.title),
    ['旧带消息', '新带消息']
  )
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 2,
    '有消息的会话必须原样保留，绝不能 CASCADE 掉用户消息')
})

test('保留策略清理：preview 只报超期空壳，applyNow 只回收超期空壳', () => {
  const c = seed()
  const patch = { conversations: '7d' }
  const p = retention.preview(patch)
  assert.equal(p.conversations, 1, '只有旧空壳超期；新空壳没超期；有消息的会话不算')
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get().n, 4, '预览只读不删')

  const done = retention.applyNow(patch)
  assert.equal(done.conversations, 1)
  assert.deepEqual(
    c.prepare('SELECT title FROM ai_conversations ORDER BY id').all().map(x => x.title),
    ['旧带消息', '新空壳', '新带消息']
  )
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 2)
})

test('applyNow 多类同事务：会话空壳与消息超期一起清，互不误伤', () => {
  const c = seed()
  const done = retention.applyNow({ messages: '7d', conversations: '7d', history: 'forever' })
  assert.equal(done.conversations, 1)
  assert.equal(done.failed, 0)
  // 会话 2 的消息是新的（NEW），messages=7d 不会删；会话壳也不能被删
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 2)
  assert.ok(c.prepare("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 2").get().n === 1)
})

test('变异反证：抹掉空壳限定后，「有消息的会话被 CASCADE 连累」的判据必须红', () => {
  const c = seed()
  const src = fs.readFileSync(abs('student-backend/services/retentionStore.js'), 'utf8')
  const shellOnly = /const SHELL_ONLY = '([^']+)'/.exec(src)
  assert.ok(shellOnly, '找不到 SHELL_ONLY 锚点')
  assert.match(shellOnly[1], /NOT EXISTS[\s\S]*ai_messages/, '锚点必须真的查 ai_messages')

  // 用真源码副本把 SHELL_ONLY 变成空串，放到 services/ 旁（相对 require 才解析得到），
  // 经临时文件加载：此时 deleteAll 会删光会话。
  const brokenSrc = src.replace(
    /const SHELL_ONLY = '[^']*'/,
    "const SHELL_ONLY = ''"
  )
  assert.notEqual(brokenSrc, src, '变异没生效')
  const tmp = abs(`student-backend/services/_shell-mutant-${process.pid}.js`)
  fs.writeFileSync(tmp, brokenSrc)
  try {
    const mutant = require(tmp)
    // 变异前先坐实真源码的保护：只删 2 个空壳，消息全在。
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get().n, 4)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 2)
    const r = mutant.deleteAll('conversations')
    assert.equal(r.deleted, 4, '抹掉空壳限定后 4 个会话全被删，证明保护确实来自 SHELL_ONLY')
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM ai_messages').get().n, 0,
      'CASCADE 连带把 2 条用户消息也删了——这正是空壳限定要防的数据丢失')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})
