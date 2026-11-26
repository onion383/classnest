// =========================================================================
// group-dimension-settings-same-tx.test.js —— 899 维度设置：组名批量改 + 结构快照同事务
//                                            （V9-I-13 · 一次动作两处写不能留窗口）
// 原缺陷：doSaveSettings 先 PUT dimensions/:id 改设置，再 PUT groups/rename-batch 改组名，
// 最后写后二次 GET 生成 group_snapshot.after。改名的第二次请求不在同事务，after 靠 GET，
// 崩溃窗口 + 快照漏组名。修法：groupRenames 合进 dimensions PUT 同事务，after 由后端
// dimensionSettingsPayload 在改名后读结构快照生成。
// 判据：①真跑：带 groupRenames + group_snapshot spec，撤销栈 newValue 含改名后组名；
//       ②变异反证：去掉 groupRenames 时 newValue 仍是旧名（证明 after 确实读了同事务改名结果）。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'group-dim-settings' })

test.before(() => fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js'))
test.after(() => fx.close())

const put = (p, body) => fx.call('PUT', p, body)
const post = (p, body) => fx.call('POST', p, body)

async function makeDim(groupCount = 2) {
  const r = await post('/dimensions', { name: '学习小组', leader_title: '组长', members_per_group: 6, group_count: groupCount })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const groups = fx.conn.prepare('SELECT id, name FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(r.json.id)
  return { id: r.json.id, groups }
}

test('带 groupRenames：设置+组名+结构快照同事务，撤销 newValue 是改名后组名', async () => {
  const dim = await makeDim(2)
  const before = dim.groups.map((g) => ({ id: g.id, name: g.name, gender: null, sort_order: 1, members: [] }))
  const renames = dim.groups.map((g, i) => ({ id: g.id, name: `新组${i + 1}` }))
  const res = await put(`/dimensions/${dim.id}`, {
    name: '学习小组', leader_title: '组长', members_per_group: 6, group_count: 2,
    groupRenames: renames,
    _undoSpecs: [{ key: 'group_manage', type: 'group_snapshot', label: '分组结构变更', payload: { dimId: dim.id, oldValue: before } }],
  })
  assert.equal(res.status, 200, res.text.slice(0, 300))
  assert.ok(res.json.undoId, '单条 spec 回一个 undoId')
  // 库里组名已改
  const after = fx.conn.prepare('SELECT name FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dim.id)
  assert.deepEqual(after.map((g) => g.name), ['新组1', '新组2'])
  // 撤销栈的 newValue 是改名后的结构（证明快照在同事务改名之后生成）
  const row = fx.conn.prepare('SELECT type, payload FROM undo_history ORDER BY id DESC LIMIT 1').get()
  assert.equal(row.type, 'group_snapshot')
  const payload = JSON.parse(row.payload)
  assert.deepEqual(payload.newValue.map((g) => g.name), ['新组1', '新组2'], '快照 after 必须含改名后组名')
})

test('变异反证：不带 groupRenames 时快照 after 保留旧名（证明 after 读的是本事务改名结果）', async () => {
  const dim = await makeDim(2)
  const before = dim.groups.map((g) => ({ id: g.id, name: g.name, gender: null, sort_order: 1, members: [] }))
  const res = await put(`/dimensions/${dim.id}`, {
    name: '学习小组', leader_title: '组长', members_per_group: 6, group_count: 2,
    // 不带 groupRenames —— 组名不变
    _undoSpecs: [{ key: 'group_manage', type: 'group_snapshot', label: '分组结构变更', payload: { dimId: dim.id, oldValue: before } }],
  })
  assert.equal(res.status, 200, res.text.slice(0, 300))
  const row = fx.conn.prepare('SELECT type, payload FROM undo_history ORDER BY id DESC LIMIT 1').get()
  assert.equal(row.type, 'group_snapshot')
  const payload = JSON.parse(row.payload)
  assert.deepEqual(payload.newValue.map((g) => g.name), dim.groups.map((g) => g.name), '没改名时快照 after 应是旧名')
})
