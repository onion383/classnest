/**
 * cadre-undo-test.cjs —— 班干部撤销执行器回归（真实加密库 + 真实路由）
 *
 * 覆盖：
 *   · cadre_delete：删职务（级联删成员 + 下级上移）能否整批回滚、重做
 *   · cadre_order：拖拽职务/成员后，归属（parent_id / cadre_id）与 sort_order 能否回滚
 *   · cadre_import：导入只回滚本次新建的行，重做时层级正确
 *   · 走真实 /api/undo：中文 key（班干部）的 pushRecord / status / table undo
 *
 * 做法同 api-routes-test.cjs：临时 DATA_DIR + 测试主密钥建真实加密库，
 * 真实路由挂最小 Express，用 dbManager.withDb 绑定 ALS 上下文（等价于 auth 中间件）。
 *
 * 跑法：node testjs/smoke/cadre-undo-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const NM = path.join(BACKEND, 'node_modules')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-undo-'))
process.env.DB_MASTER_KEY = 'cadre-undo-test-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'thumbs')

const express = require(path.join(NM, 'express'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const { executors } = require(path.join(BACKEND, 'routes', 'undo', 'undo.executors'))
const cadresRouter = require(path.join(BACKEND, 'routes', 'cadres'))
const undoRouter = require(path.join(BACKEND, 'routes', 'undo', 'undo'))

const USERNAME = 'cadre-undo-test'
const { slug } = dbManager.createTeacher(USERNAME, 'no-hash', 'teacher')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) console.log('    →', JSON.stringify(detail).slice(0, 400))
}

function request(port, { method = 'GET', p = '/', body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c.toString('utf8') })
      res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch (_) { } resolve({ status: res.statusCode, json, text }) })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const app = express()
app.use(express.json({ limit: '4mb' }))
const bind = (req, res, next) => {
  req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
  dbManager.withDb(slug, () => next())
}
app.use('/api/cadres', bind, cadresRouter)
app.use('/api/undo', bind, undoRouter)

const findNode = (list, id) => {
  for (const n of list || []) {
    if (n.id === id) return n
    const r = findNode(n.children, id)
    if (r) return r
  }
  return null
}
const cadreState = (list, out = []) => {
  for (const n of list || []) {
    out.push({ id: n.id, parent_id: n.parent_id == null ? 0 : n.parent_id, sort_order: n.sort_order })
    cadreState(n.children, out)
  }
  return out
}
const memberState = (list, out = []) => {
  for (const n of list || []) {
    for (const m of n.members || []) out.push({ id: m.id, cadre_id: m.cadre_id, sort_order: m.sort_order == null ? 0 : m.sort_order })
    memberState(n.children, out)
  }
  return out
}

;(async () => {
  const server = app.listen(0)
  const port = server.address().port

  // 建一棵树：班长(2人上限) + 其下级「组长」，各挂学生
  const r1 = await request(port, { method: 'POST', p: '/api/cadres', body: { name: '班长', max_count: 2 } })
  const rootId = r1.json.id
  const r2 = await request(port, { method: 'POST', p: '/api/cadres', body: { name: '组长', max_count: 2, parent_id: rootId } })
  const childId = r2.json.id
  await request(port, { method: 'POST', p: `/api/cadres/${rootId}/members`, body: { student_name: '张三' } })
  await request(port, { method: 'POST', p: `/api/cadres/${rootId}/members`, body: { student_name: '李四' } })
  await request(port, { method: 'POST', p: `/api/cadres/${childId}/members`, body: { student_name: '王五' } })

  let tree = (await request(port, { p: '/api/cadres' })).json.tree
  const root = findNode(tree, rootId)
  check('成员接口返回 sort_order（撤销整行恢复需要）', Number.isInteger(root.members[0].sort_order), root.members[0])

  // ===== 1. 删除职务（级联）后撤销 =====
  const snap = {
    node: { id: root.id, name: root.name, parent_id: root.parent_id, max_count: root.max_count, sort_order: root.sort_order },
    members: root.members.map((m) => ({ id: m.id, cadre_id: m.cadre_id, student_id: m.student_id, student_name: m.student_name, sort_order: m.sort_order })),
    children: (root.children || []).map((c) => ({ id: c.id, parent_id: c.parent_id })),
  }
  const del = await request(port, { method: 'DELETE', p: `/api/cadres/${rootId}` })
  check('删除职务成功', del.status === 200, del.text)
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('删除后：下级上移到顶级', findNode(tree, childId).parent_id === 0, findNode(tree, childId))
  check('删除后：原成员已清空', findNode(tree, childId).members.length === 1, findNode(tree, childId).members)

  await dbManager.withDb(slug, () => executors.cadre_delete.undo(snap))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  const back = findNode(tree, rootId)
  check('撤销删除：职务行恢复（含 max_count/sort_order）', back && back.name === '班长' && back.max_count === 2 && back.sort_order === snap.node.sort_order, back)
  check('撤销删除：成员按原顺序恢复', back && back.members.map((m) => m.student_name).join(',') === '张三,李四', back && back.members)
  check('撤销删除：成员 sort_order 保持 1/2', back && back.members.map((m) => m.sort_order).join(',') === '1,2', back && back.members.map((m) => m.sort_order))
  check('撤销删除：下级重新挂回被删职务', findNode(tree, childId).parent_id === rootId, findNode(tree, childId))

  await dbManager.withDb(slug, () => executors.cadre_delete.redo(snap))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('重做删除：职务行再次消失', !findNode(tree, rootId), tree)
  check('重做删除：下级再次上移', findNode(tree, childId).parent_id === 0, findNode(tree, childId))
  check('重做删除：成员再次清空', !findNode(tree, childId).members.some((m) => m.student_name === '王五') === false, findNode(tree, childId).members)

  // 复原，供排序用例使用
  await dbManager.withDb(slug, () => executors.cadre_delete.undo(snap))

  // ===== 2. 拖拽排序后撤销 =====
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  const beforeState = { cadres: cadreState(tree), members: memberState(tree) }
  // 把「组长」拖到顶级首位
  const mv = await request(port, { method: 'POST', p: `/api/cadres/${childId}/move`, body: { parent_id: 0, index: 0 } })
  check('移动职务成功', mv.status === 200, mv.text)
  const afterTree = mv.json.tree
  const afterState = { cadres: cadreState(afterTree), members: memberState(afterTree) }
  check('移动后：组长已是顶级', findNode(afterTree, childId).parent_id === 0, findNode(afterTree, childId))

  await dbManager.withDb(slug, () => executors.cadre_order.undo({ before: beforeState, after: afterState }))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('撤销排序：组长回到班长下面', findNode(tree, childId).parent_id === rootId, findNode(tree, childId))
  check('撤销排序：cadres 排序状态与拖拽前完全一致', JSON.stringify(cadreState(tree)) === JSON.stringify(beforeState.cadres), { now: cadreState(tree), before: beforeState.cadres })

  await dbManager.withDb(slug, () => executors.cadre_order.redo({ before: beforeState, after: afterState }))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('重做排序：组长再次成为顶级', findNode(tree, childId).parent_id === 0, findNode(tree, childId))

  // ===== 3. 成员跨职务拖动后撤销（cadre_id 也要回滚） =====
  const mid = findNode(tree, rootId).members[0].id
  const beforeState2 = { cadres: cadreState(tree), members: memberState(tree) }
  const mv2 = await request(port, { method: 'POST', p: `/api/cadres/members/${mid}/move`, body: { cadre_id: childId, index: 0 } })
  check('移动成员成功', mv2.status === 200, mv2.text)
  const afterState2 = { cadres: cadreState(mv2.json.tree), members: memberState(mv2.json.tree) }
  await dbManager.withDb(slug, () => executors.cadre_order.undo({ before: beforeState2, after: afterState2 }))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('撤销成员移动：cadre_id 回到原职务', findNode(tree, rootId).members.some((m) => m.id === mid), findNode(tree, rootId).members)

  // ===== 4. Excel 导入后撤销（只回滚本次新建的行） =====
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  const beforeCount = cadreState(tree).length
  const imp = await request(port, {
    method: 'POST',
    p: '/api/cadres/import',
    body: {
      fields: ['职务', '上级职务', '担任学生', '可担任人数'],
      rows: [['学习委员', '', '赵六、钱七', '3'], ['数学组长', '学习委员', '赵六', '1']],
    },
  })
  check('导入成功', imp.status === 200, imp.text)
  const created = imp.json.created
  check('导入返回本次新建行（2 职务 / 3 成员）', created && created.cadres.length === 2 && created.members.length === 3, created)
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('导入后职务数 +2', cadreState(tree).length === beforeCount + 2, cadreState(tree).length)

  await dbManager.withDb(slug, () => executors.cadre_import.undo(created))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('撤销导入：新建职务全部消失', cadreState(tree).length === beforeCount, cadreState(tree))
  check('撤销导入：新建成员一并消失', !JSON.stringify(tree).includes('赵六'), tree)

  await dbManager.withDb(slug, () => executors.cadre_import.redo(created))
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('重做导入：职务恢复', cadreState(tree).length === beforeCount + 2, cadreState(tree))
  check('重做导入：成员恢复且层级正确', JSON.stringify(tree).includes('赵六') && findNode(tree, created.cadres[1].id).parent_id === created.cadres[0].id, tree)

  // ===== 5. 走真实 /api/undo 路由（中文 key + pushRecord / flip） =====
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  const groupNode = findNode(tree, created.cadres[1].id) // 数学组长
  const snap2 = {
    node: { id: groupNode.id, name: groupNode.name, parent_id: groupNode.parent_id, max_count: groupNode.max_count, sort_order: groupNode.sort_order },
    members: groupNode.members.map((m) => ({ id: m.id, cadre_id: m.cadre_id, student_id: m.student_id, student_name: m.student_name, sort_order: m.sort_order })),
    children: [],
  }
  await request(port, { method: 'DELETE', p: `/api/cadres/${groupNode.id}` })
  const push = await request(port, { method: 'POST', p: '/api/undo', body: { key: '班干部', type: 'cadre_delete', label: '删除职务：数学组长', payload: snap2 } })
  check('pushRecord 接受 cadre_delete', push.status === 200 && !!push.json.id, push.text)
  const encKey = encodeURIComponent('班干部')
  const st = await request(port, { p: `/api/undo/table/${encKey}/status` })
  check('中文 key 的撤销可用态可查', st.json && st.json.canUndo === true, st.text)
  const un = await request(port, { method: 'POST', p: `/api/undo/table/${encKey}/undo` })
  check('中文 key 的撤销执行成功', un.json && un.json.ok === true, un.text)
  tree = (await request(port, { p: '/api/cadres' })).json.tree
  check('撤销后「数学组长」重新出现', !!findNode(tree, groupNode.id), tree)

  server.close()
  console.log(failed ? `\n${failed} 条断言失败` : '\n全部通过')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
