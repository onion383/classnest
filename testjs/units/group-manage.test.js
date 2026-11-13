// =========================================================================
// group-manage.test.js —— 分组管理的读写路径（档 C · M12-B1）
//
// 背景：`routes/groupManage.js` 的 78 处语句下沉到 services/groupDim.js，
// 路由只剩 HTTP 形状与「内置宿舍组 vs 普通维度」的分支。本用例锁住**行为**，
// 特别是几条靠事务才成立的性质：
//   ① 改组数：多了补、少了删（删组要连带成员），排序始终 1..n；
//   ② 内置宿舍组改宿舍数：**保留组的 id 与成员**，只改名/性别/排序
//      （全删重建会把全班宿舍分配清空，且没有撤销记录）；
//   ③ 移动成员：同组内重排与跨组移动后的顺序都连续；
//   ④ 智能分组写回 / 导入：整批一个事务，失败不留半截；
//   ⑤ 新增/改名成员会建档（is_provisional=1），成员名与名册同一身份。
// 另加一条源码判据：路由不许再有裸 SQL。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'group-manage' })

test.before(() => fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js'))
test.after(() => fx.close())

const post = (p, body) => fx.call('POST', p, body)
const put = (p, body) => fx.call('PUT', p, body)
const del = (p) => fx.call('DELETE', p)
const get = (p) => fx.call('GET', p)

const all = (sql, ...args) => fx.conn.prepare(sql).all(...args)
const one = (sql, ...args) => fx.conn.prepare(sql).get(...args)

const groupsOf = (dimId) => all('SELECT * FROM groups WHERE dimension_id = ? ORDER BY sort_order, id', dimId)
const membersOf = (groupId) => all('SELECT * FROM group_members WHERE group_id = ? ORDER BY sort_order, id', groupId)
const studentsNamed = (name) => all('SELECT id, 姓名, is_provisional FROM students WHERE 姓名 = ?', name)

// 建一个普通维度，返回 { id, groupIds }
async function makeDim(name = '学习小组', groupCount = 2, membersPerGroup = 6) {
  const r = await post('/dimensions', { name, leader_title: '组长', members_per_group: membersPerGroup, group_count: groupCount })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  return { id: r.json.id, groupIds: groupsOf(r.json.id).map((g) => g.id) }
}

test('bootstrap：没有维度时自动建内置「宿舍组」，重复调用不会多建', async () => {
  fx.reset()
  const r = await get('/bootstrap')
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(r.json.dimensions.length, 1)
  assert.equal(r.json.dimensions[0].name, '宿舍组')
  assert.equal(r.json.dimensions[0].is_default, 1)
  assert.equal(r.json.active.dimension.id, r.json.dimensions[0].id)

  await get('/bootstrap')
  assert.equal(all('SELECT id FROM group_dimensions WHERE is_default = 1').length, 1, '默认维度不能越用越多')
})

test('新增维度：按组数建出空组，排序从 1 连续', async () => {
  fx.reset()
  const { id } = await makeDim('学习小组', 3)
  const gs = groupsOf(id)
  assert.equal(gs.length, 3)
  assert.deepEqual(gs.map((g) => g.sort_order), [1, 2, 3])
  assert.ok(gs.every((g) => g.name === ''), '组名留空由用户填')
  assert.equal(one('SELECT members_per_group AS m FROM group_dimensions WHERE id = ?', id).m, 6)
})

test('普通维度改组数：少了删（连带成员），多了补，排序重排成 1..n', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 3)
  await post(`/groups/${groupIds[2]}/members`, { member_name: '张三' })
  assert.equal(membersOf(groupIds[2]).length, 1)

  let r = await put(`/dimensions/${id}`, { group_count: 1 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(groupsOf(id).length, 1, '多出来的组要删掉')
  assert.equal(all('SELECT id FROM group_members WHERE group_id = ?', groupIds[2]).length, 0, '删组要连带成员')

  r = await put(`/dimensions/${id}`, { group_count: 3 })
  assert.equal(r.status, 200)
  const gs = groupsOf(id)
  assert.equal(gs.length, 3)
  assert.deepEqual(gs.map((g) => g.sort_order), [1, 2, 3])
})

test('内置宿舍组改宿舍数：保留组的 id 与成员，只改名/性别/排序', async () => {
  fx.reset()
  await get('/bootstrap')
  const dimId = one('SELECT id FROM group_dimensions WHERE is_default = 1').id

  let r = await put(`/dimensions/${dimId}`, { male_group_count: 2, female_group_count: 1 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  let gs = groupsOf(dimId)
  assert.deepEqual(gs.map((g) => `${g.name}/${g.gender}`), ['男生宿舍1/0', '男生宿舍2/0', '女生宿舍1/1'])
  assert.deepEqual(gs.map((g) => g.sort_order), [1, 2, 3])

  // 给第一间宿舍加人，再改女生宿舍数：这间宿舍的 id 与成员必须原样留存
  const firstId = gs[0].id
  await post(`/groups/${firstId}/members`, { member_name: '李四' })

  r = await put(`/dimensions/${dimId}`, { female_group_count: 2 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  gs = groupsOf(dimId)
  assert.equal(gs[0].id, firstId, '宿舍不能被全删重建（成员会跟着丢）')
  assert.equal(membersOf(firstId).length, 1, '成员分配必须留着')
  assert.deepEqual(gs.map((g) => g.name), ['男生宿舍1', '男生宿舍2', '女生宿舍1', '女生宿舍2'])
})

test('移动维度：成功换序，到边界回 400 且顺序不变', async () => {
  fx.reset()
  await get('/bootstrap') // 宿舍组排 1
  const a = await makeDim('A')
  await makeDim('B')
  const order = () => all('SELECT name, sort_order FROM group_dimensions ORDER BY sort_order, id').map((d) => d.name)
  assert.deepEqual(order(), ['宿舍组', 'A', 'B'])

  let r = await post('/dimensions/move', { id: a.id, direction: 'up' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.deepEqual(order(), ['A', '宿舍组', 'B'])

  r = await post('/dimensions/move', { id: a.id, direction: 'up' })
  assert.equal(r.status, 400, '已到第一个不能再上移')
  assert.deepEqual(order(), ['A', '宿舍组', 'B'], '边界失败不能改动顺序')
})

test('新增组：排到末尾；超过 50 个直接拒', async () => {
  fx.reset()
  const { id } = await makeDim('学习小组', 1)
  const r = await post(`/dimensions/${id}/groups`, { name: '第二组' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const gs = groupsOf(id)
  assert.equal(gs.length, 2)
  assert.equal(gs[1].name, '第二组')
  assert.equal(gs[1].sort_order, 2)

  // 直接铺满到上限（走接口太慢），再新增一条应被拒
  for (let i = gs.length; i < 50; i++) {
    fx.conn.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, ?)').run(id, `填充${i}`, i + 1)
  }
  const over = await post(`/dimensions/${id}/groups`, { name: '多出来的' })
  assert.equal(over.status, 400)
  assert.match(over.json.error, /不能超过 50/)
})

test('删除组：级联成员并把同维度排序重排', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 3)
  await post(`/groups/${groupIds[0]}/members`, { member_name: '张三' })

  const r = await del(`/groups/${groupIds[0]}`)
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(all('SELECT id FROM group_members WHERE group_id = ?', groupIds[0]).length, 0)
  assert.deepEqual(groupsOf(id).map((g) => g.sort_order), [1, 2])

  const missing = await del('/groups/99999')
  assert.equal(missing.status, 404)
})

test('新增成员：建档（is_provisional）并接到组尾；每组人数上限生效', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 1, 1) // 每组 1 人
  const r = await post(`/groups/${groupIds[0]}/members`, { member_name: '王五', remark: '体育委员' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.ok(r.json.student && r.json.student.id, '应回传解析到的学生')
  assert.equal(r.json.student.is_provisional, true)
  assert.equal(studentsNamed('王五').length, 1, '新名字要落一条临时学生')
  assert.equal(studentsNamed('王五')[0].is_provisional, 1)

  const m = membersOf(groupIds[0])
  assert.equal(m.length, 1)
  assert.equal(m[0].remark, '体育委员')

  const over = await post(`/groups/${groupIds[0]}/members`, { member_name: '赵六' })
  assert.equal(over.status, 400)
  assert.match(over.json.error, /上限 1 人/)
})

test('修改成员：改名后同步建档，备注可单独改', async () => {
  fx.reset()
  const { groupIds } = await makeDim('学习小组', 1)
  const add = await post(`/groups/${groupIds[0]}/members`, { member_name: '旧名' })
  const id = add.json.id

  let r = await put(`/group-members/${id}`, { member_name: '新名' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(membersOf(groupIds[0])[0].member_name, '新名')
  assert.equal(studentsNamed('新名').length, 1, '改名也要建档（否则候选框选不到）')

  r = await put(`/group-members/${id}`, { remark: '只改备注' })
  assert.equal(r.status, 200)
  const m = membersOf(groupIds[0])[0]
  assert.equal(m.member_name, '新名', '没传名字不能把名字清空')
  assert.equal(m.remark, '只改备注')

  assert.equal((await put('/group-members/99999', { member_name: 'x' })).status, 404)
})

test('删除成员：同组排序重排', async () => {
  fx.reset()
  const { groupIds } = await makeDim('学习小组', 1)
  for (const n of ['甲', '乙', '丙']) await post(`/groups/${groupIds[0]}/members`, { member_name: n })
  const ids = membersOf(groupIds[0]).map((m) => m.id)

  const r = await del(`/group-members/${ids[1]}`)
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const rest = membersOf(groupIds[0])
  assert.deepEqual(rest.map((m) => m.member_name), ['甲', '丙'])
  assert.deepEqual(rest.map((m) => m.sort_order), [1, 2])
})

test('移动成员：同组内换位、跨组移动、目标组满员拒绝', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 2, 3) // 每组最多 3 人
  const [g1, g2] = groupIds
  for (const n of ['甲', '乙', '丙']) await post(`/groups/${g1}/members`, { member_name: n })
  const ids = membersOf(g1).map((m) => m.id)
  assert.equal(ids.length, 3, '前提：三人都在第一组')

  // 同组：把「甲」移到最后
  let r = await post('/group-members/move', { memberId: ids[0], targetGroupId: g1, targetIndex: 2 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.deepEqual(membersOf(g1).map((m) => m.member_name), ['乙', '丙', '甲'])

  // 跨组：把「乙」移到第二组首位
  r = await post('/group-members/move', { memberId: ids[1], targetGroupId: g2, targetIndex: 0 })
  assert.equal(r.status, 200)
  assert.deepEqual(membersOf(g2).map((m) => m.member_name), ['乙'])
  assert.deepEqual(membersOf(g1).map((m) => m.member_name), ['丙', '甲'])
  assert.deepEqual(membersOf(g1).map((m) => m.sort_order), [1, 2])

  // 满员：第二组补到 3 人（上限 3），再移入应被拒
  await post(`/groups/${g2}/members`, { member_name: '丁' })
  await post(`/groups/${g2}/members`, { member_name: '戊' })
  const over = await post('/group-members/move', { memberId: ids[2], targetGroupId: g2, targetIndex: 0 })
  assert.equal(over.status, 400)
  assert.match(over.json.error, /无法移入/)

  assert.equal((await post('/group-members/move', { memberId: 99999, targetGroupId: g2 })).status, 404)
  assert.equal((await post('/group-members/move', { memberId: ids[2], targetGroupId: 99999 })).status, 404)
  assert.equal(all('SELECT id FROM groups WHERE dimension_id = ?', id).length, 2)
})

test('智能分组写回：整维覆盖；超组数 / 超人数都被拒', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 2, 2)
  await post(`/groups/${groupIds[0]}/members`, { member_name: '旧成员' })

  let r = await post(`/dimensions/${id}/apply-grouping`, { groups: [['甲', '乙'], ['丙']] })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.deepEqual(membersOf(groupIds[0]).map((m) => m.member_name), ['甲', '乙'], '整组覆盖（旧成员要清掉）')
  assert.deepEqual(membersOf(groupIds[1]).map((m) => m.member_name), ['丙'])

  r = await post(`/dimensions/${id}/apply-grouping`, { groups: [['甲'], ['乙'], ['丙']] })
  assert.equal(r.status, 400, '组数超过维度的小组数')
  assert.match(r.json.error, /不能超过该维度的 2 个小组/)

  r = await post(`/dimensions/${id}/apply-grouping`, { groups: [['甲', '乙', '丙']] })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /超过上限 2 人/)

  // 失败不能留半截：原数据仍然是上一次成功的结果
  assert.deepEqual(membersOf(groupIds[0]).map((m) => m.member_name), ['甲', '乙'])
})

test('导入：合并追加、同组重名跳过、内置宿舍组不许新建小组', async () => {
  fx.reset()
  const { id, groupIds } = await makeDim('学习小组', 1)
  await put(`/groups/${groupIds[0]}`, { name: '第一组' }) // 先给唯一的组一个名字，导入才能按名复用

  let r = await post(`/dimensions/${id}/import`, {
    fields: ['小组', '姓名', '备注'],
    rows: [
      ['第一组', '甲', '备注甲'],
      ['第一组', '甲', ''],   // 同一小组内重名 → 跳过
      ['第一组', '乙', ''],
      ['新组', '丙', ''],     // 不存在的小组名 → 自动新建
    ],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.match(r.json.message, /成功导入 3 名成员，新建 1 个小组/)
  assert.equal(r.json.skipped, 1, '重名要计入 skipped')
  assert.equal(groupsOf(id).length, 2, '只新建缺失的那一个组')
  assert.deepEqual(membersOf(groupIds[0]).map((m) => m.member_name), ['甲', '乙'])
  assert.equal(membersOf(groupIds[0])[0].remark, '备注甲')

  // 内置宿舍组：同名小组不存在时直接拒（宿舍数由设置决定）
  await get('/bootstrap')
  const dimId = one('SELECT id FROM group_dimensions WHERE is_default = 1').id
  r = await post(`/dimensions/${dimId}/import`, { fields: ['小组', '姓名'], rows: [['不存在的宿舍', '张三']] })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /内置宿舍组不能新建小组/)

  // 缺列也带行号拒掉
  r = await post(`/dimensions/${id}/import`, { fields: ['小组'], rows: [['第一组']] })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /第 1 行缺少「姓名」/)
})

// ---------------------------------------------------------------------------
// 源码判据：M12-B1 之后分组路由不该再有裸 SQL
// ---------------------------------------------------------------------------
test('SQL 出口：groupManage 路由只经 groupDim', () => {
  const code = fs.readFileSync(path.join(ROOT, 'student-backend/routes/groupManage.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(!/db\.prepare\(/.test(code), 'groupManage 路由不许再有裸 SQL')
  assert.match(code, /groupDim\.loadDimension\(/, '读取维度必须经 groupDim')
  assert.match(code, /groupDim\.importMembers\(/, '导入必须经 groupDim')
})
