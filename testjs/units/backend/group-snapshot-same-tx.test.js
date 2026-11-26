// group_snapshot 写后补登记收口判据：apply-grouping 带 before spec，
// 后端在同事务里用写后结构生成 after 并登记，响应回 undoId；撤销 payload 的 before/after 正确。
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'group-snapshot-same-tx', extraDbExports: { renumber: () => {} } })

test('apply-grouping：同事务登记，撤销 payload 的 before 是写前、after 是写后', async () => {
  const conn = fx.reset()
  const dim = conn.prepare('INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, sort_order) VALUES (?, ?, ?, ?, 1)').run('维度', '', 10, 2,).lastInsertRowid
  const g1 = conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, 1)').run(dim, '一组').lastInsertRowid
  conn.prepare('INSERT INTO group_members (group_id, member_name, sort_order) VALUES (?, ?, 1)').run(g1, '张三')
  conn.prepare("INSERT INTO students (position, 姓名) VALUES (1, '张三')").run()

  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
  await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js')

  // 写前快照（模拟前端 buildGroupSnapshot）
  const before = [{ id: g1, name: '一组', gender: null, sort_order: 1, members: [
    { id: conn.prepare('SELECT id FROM group_members WHERE group_id = ?', {1:1}).get(g1)?.id ?? 1, member_name: '张三', remark: '', sort_order: 1 },
  ] }]
  const spec = { key: 'group_manage', type: 'group_snapshot', label: '分组结构变更', payload: { oldValue: before } }
  const res = await fx.call('POST', `/dimensions/${dim}/apply-grouping`, {
    groups: [['张三', '李四']], _undoSpec: spec,
  })
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.undoId, '响应带回 undoId')

  const row = conn.prepare('SELECT payload FROM undo_history WHERE id = ?').get(res.json.undoId)
  assert.ok(row, '撤销记录落库')
  const p = JSON.parse(row.payload)
  assert.equal(p.dimId, dim)
  assert.deepEqual(p.oldValue, before, 'before 就是前端写前快照')
  assert.equal(p.newValue.length, 1, 'after 是写后的组结构')
  assert.equal(p.newValue[0].members.length, 2, 'after 含新写入的两名成员')
  assert.equal(p.newValue[0].members[0].member_name, '张三')
  assert.equal(p.newValue[0].members[1].member_name, '李四')
  assert.ok(p.newValue[0].members[0].id > 0, 'after 成员保留 id（执行器按 id 回插）')
})
test.after(() => fx.close())
