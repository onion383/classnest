// =========================================================================
// undo-retention.test.js —— 撤销记录的「每 key 50 条」上限
//
// 为什么加这个测试：v6 清单排查「撤销记录要不要分页」时发现，结论「不需要」
// 完全依赖 pushRecord 里的 MAX_PER_KEY=50 —— 只要这个上限哪天被改掉或加进动态 key，
// 表就会无限长，那个「不需要」立刻失效。而当时全库没有任何测试锁住它。
//
// 真实规模（15 个库实测）：最大 70 条 / 10.6KB / 5 个 key。
// 上界 = 50 × key 种类，所以 /api/undo 根本不需要分页。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

// 只需要内存库（这个用例不挂 express），但 stub 必须和路由测试同源
const fx = createBackendDb({ label: 'undo-retention' })
const conn = fx.conn
test.after(() => fx.close())

const { pushRecord } = require('../../student-backend/routes/undo/undo.records')

const count = (key) => conn.prepare('SELECT COUNT(*) AS c FROM undo_history WHERE key = ?').get(key).c
const labels = (key) => conn.prepare('SELECT label FROM undo_history WHERE key = ? ORDER BY id ASC').all(key).map(r => r.label)

test('同一 key 连续写 60 条 → 只留最新的 50 条', () => {
  for (let i = 0; i < 60; i++) pushRecord('album', 'album_add', `n${i}`, {}, '')
  assert.equal(count('album'), 50)
  assert.deepEqual(labels('album'), Array.from({ length: 50 }, (_, i) => `n${i + 10}`),
    '删掉的必须是最旧的 10 条，留下的是最新的 50 条')
})

test('不同 key 各算各的上限，互不挤掉', () => {
  for (let i = 0; i < 55; i++) pushRecord('座位表', 'seat_update', `s${i}`, {}, '')
  for (let i = 0; i < 8; i++) pushRecord('课程表', 'schedule_update', `c${i}`, {}, '')
  assert.equal(count('座位表'), 50)
  assert.equal(count('课程表'), 8, '另一张表的记录不该被座位表的清理误删')
})

test('上限是「每 key」，不是整表上限：多个 key 各到 50 条也能共存', () => {
  for (const key of ['值日表', 'group_manage', '成绩表']) {
    for (let i = 0; i < 50; i++) pushRecord(key, 'row_update', `${key}-${i}`, {}, '')
  }
  assert.equal(count('值日表'), 50)
  assert.equal(count('group_manage'), 50)
  assert.equal(count('成绩表'), 50)
  const total = conn.prepare('SELECT COUNT(*) AS c FROM undo_history').get().c
  assert.ok(total >= 150, '整表不是被一刀切到 50')
})

// 结论的前提：key 必须是固定字面量。万一以后有人把 key 做成「每天一个」，
// 每 key 上限就形同虚设（每天 50 条、永远不清旧天）。这里扫源码把动态 key 挡住。
test('前提：撤销记录的 key 不能是动态拼接的（否则每 key 上限失效）', () => {
  // M12-B8：语句与上限常量一起下沉到 services/undoStore（路由只留撤销语义）
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/services/undoStore.js'), 'utf8')
  assert.match(src, /const MAX_KEYS = 50/, '上限常量必须还在')
  assert.match(src, /SELECT id FROM undo_history WHERE key = \? ORDER BY id DESC LIMIT -1 OFFSET \?/,
    '清理必须按 key 分组、按 id 倒序保留最新的')

  const front = path.join(ROOT, 'student-frontend/src')
  const walk = (d) => {
    let out = []
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) out = out.concat(walk(p))
      else if (/\.(js|vue)$/.test(e.name)) out.push(p)
    }
    return out
  }
  // recordUndo / recordUndoSpec 的调用里，key 要写成字面量。
  // 这里的判据不是「前端一个模板字符串都不许有」，而是「不许出现在撤销调用里」。
  const offenders = []
  for (const f of walk(front)) {
    const s = fs.readFileSync(f, 'utf8')
    for (const m of s.matchAll(/recordUndo\w*\s*\(\s*\{([\s\S]{0,240}?)\}\s*,?\s*\)/g)) {
      if (/key:\s*`/.test(m[1])) offenders.push(path.relative(front, f))
    }
  }
  assert.deepEqual(offenders, [], `撤销调用的 key 变成了动态值：${offenders.join(', ')}`)
})
