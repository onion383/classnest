// =========================================================================
// group-rename-batch.test.js —— 批量改名端点（v8 · P3-12）
//
// 事故面：组名自动编号（「第X组」）在前端 `Promise.all` 逐条 PUT；
// 8 个组 = 8 次 loopback，任一条失败就留下改了一半的组名。
//
// 覆盖：
//   ① 一次请求改完全部组名；
//   ② 有 id 不存在时整批回滚（不留半截）；
//   ③ 空名/id 非法/超量 → 400；
//   ④ 路由顺序：/groups/rename-batch 不会被 /groups/:id 抢走；
//   ⑤ 前端接线只发 1 个请求，且跳过未变化的组。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-rename-batch' })

let base
test.before(async () => {
  base = await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
})
test.after(() => fx.close())

const groupsOf = (dimId) => fx.conn.prepare('SELECT * FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
const put = (p, body) => fx.call('PUT', p, body)

async function makeDim(groupCount = 3) {
  const r = await fx.call('POST', '/dimensions', {
    name: '学习小组',
    leader_title: '组长',
    members_per_group: 6,
    group_count: groupCount,
  })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  return groupsOf(r.json.id)
}

test('一次请求改完全部组名', async () => {
  const groups = await makeDim(3)
  const items = groups.map((g, i) => ({ id: g.id, name: `第${i + 1}组` }))
  const r = await put('/groups/rename-batch', { items })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(r.json.updated, 3)
  assert.deepEqual(groupsOf(groups[0].dimension_id).map((g) => g.name), ['第1组', '第2组', '第3组'])
})

test('任一 id 不存在 → 整批回滚，不留半截', async () => {
  const groups = await makeDim(2)
  const before = groupsOf(groups[0].dimension_id).map((g) => g.name)
  const r = await put('/groups/rename-batch', {
    items: [
      { id: groups[0].id, name: '已改' },
      { id: 999999, name: '幽灵组' },
    ],
  })
  assert.equal(r.status, 404)
  assert.deepEqual(groupsOf(groups[0].dimension_id).map((g) => g.name), before, '第一条也必须回滚')
})

test('非法 / 空 / 超量入参 → 400', async () => {
  for (const body of [{}, { items: 'x' }, { items: [] }, { items: [{ id: 0, name: 'a' }] }, { items: [{ id: 1, name: '  ' }] }]) {
    const r = await put('/groups/rename-batch', body)
    assert.equal(r.status, 400, `入参 ${JSON.stringify(body)} 应拒绝`)
  }
  const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, name: `第${i + 1}组` }))
  assert.equal((await put('/groups/rename-batch', { items: tooMany })).status, 400)
})

test('重复 id 去重后只保留最后一次命名', async () => {
  const groups = await makeDim(1)
  const r = await put('/groups/rename-batch', {
    items: [
      { id: groups[0].id, name: '旧名' },
      { id: groups[0].id, name: '新名' },
    ],
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.updated, 1)
  assert.equal(groupsOf(groups[0].dimension_id)[0].name, '新名')
})

test('前端接线：只发 1 个 rename-batch 请求并跳过未变化的组', () => {
  const src = fs.readFileSync(abs('student-frontend/src/views/GroupManageView.vue'), 'utf8')
  const start = src.indexOf('async function applyGroupNames(')
  const end = src.indexOf('// ============ 组名覆盖确认', start)
  assert.ok(start > 0 && end > start, '找不到 applyGroupNames 方法区间')
  const block = src.slice(start, end)
  assert.match(block, /groups\/rename-batch/, '批量改名必须走批量端点')
  assert.equal((block.match(/await api\(/g) || []).length, 1, '整批只允许发 1 个请求')
  assert.match(block, /String\(g\.name \|\| ''\) === names\[i\]/, '未变化的组必须跳过')
})
