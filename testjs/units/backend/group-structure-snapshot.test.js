// structureSnapshot 与前端 buildGroupSnapshot 同构判据：
// 字段一致、成员 id 保留、sort_order 按组内序号，才能被 undo 执行器按 id 回插。
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'group-structure-snapshot' })

test('structureSnapshot：与前端同构、成员 id 保留、序号从 1', () => {
  const conn = fx.reset()
  const dim = conn.prepare('INSERT INTO group_dimensions (name, sort_order) VALUES (?, 1)').run('测试维度').lastInsertRowid
  const g1 = conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 1)').run(dim, '一组').lastInsertRowid
  const g2 = conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 2)').run(dim, '二组').lastInsertRowid
  const m1 = conn.prepare('INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?, ?, ?, 5)').run(g1, '张三', '备注').lastInsertRowid
  const m2 = conn.prepare('INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?, ?, ?, 9)').run(g1, '李四', '').lastInsertRowid

  const groupDim = require(abs('student-backend/services/groupDim.js'))
  const snap = groupDim.structureSnapshot(dim)
  assert.equal(snap.length, 2)
  assert.deepEqual(Object.keys(snap[0]).sort(), ['gender', 'id', 'members', 'name', 'sort_order'])
  assert.equal(snap[0].id, g1)
  assert.equal(snap[0].members.length, 2)
  assert.equal(snap[0].members[0].id, m1, '成员 id 必须保留（执行器按 id 回插）')
  assert.equal(snap[0].members[1].id, m2)
  assert.equal(snap[0].members[0].sort_order, 1, '序号按组内顺序重编从 1')
  assert.equal(snap[1].id, g2)
})

test.after(() => fx.close())
