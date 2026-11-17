// =========================================================================
// student-ref-frontend-wiring.test.js —— 前端「成员提交口径」（P1-4）
//
// 清单原本的怀疑是「有的传 id、有的传姓名」。逐个读提交点后结论相反：
// 现在的口径已经是「有 id 列的表传 id，没有 id 列的表才传姓名」，
// 所以这一条不改代码，只把这些事实钉成判据，防止以后被改回去。
//
// 三条口径：
//   ① cadre_members（有 student_id 权威列）→ 前端必须传 student_id；
//   ② 名册里找不到人时**不发请求**（不能把 undefined 当 id 发过去，后端会当成「仅姓名成员」）；
//   ③ group_members（P2-1 起有 student_id）→ 从名册选中时传 id，手输时只传 member_name。
//
// 为什么用源码判据而不是点一遍：这三处都是「有没有带某个字段」的静态事实，
// 起前端跑一遍拿不到比这更强的保证；而漏带的后果是静默的（成员落库但 id 为空）。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('班干部添加成员：请求体带 student_id（不是只发姓名）', () => {
  const src = stripComments(read('components/CadreManage.vue'))
  const at = src.indexOf('`/cadres/${nodeId}/members`')
  assert.ok(at > 0, '找不到添加担任学生的请求')

  // 取这次调用的 data 片段（到该语句的右括号为止）
  const seg = src.slice(at, src.indexOf('})', at) + 2)
  assert.match(seg, /student_id\s*:/, '必须把 student_id 一起提交，否则 cadre_members 只能存姓名快照')
  assert.match(seg, /student_name\s*:/, '姓名快照也要带（后端会以 students.姓名 为准）')
})

test('班干部添加成员：名册里找不到这个人时不发请求', () => {
  const src = stripComments(read('components/CadreTreeList.vue'))
  const fnAt = src.indexOf('function confirmAdd(')
  assert.ok(fnAt > 0, '找不到 confirmAdd')
  const seg = src.slice(fnAt, src.indexOf('\n}', fnAt))

  const guardAt = seg.indexOf('if (!student)')
  assert.ok(guardAt > 0, '必须有「找不到学生」的分支')
  const emitAt = seg.indexOf("emit('add-student'")
  assert.ok(emitAt > guardAt, 'emit 必须在守卫之后 —— 否则会带着 undefined 的 id 提交')

  // 注意：报错文案里有模板串 `${name}`，不能按第一个 '}' 截断（会截到字符串里）
  const guardSeg = seg.slice(guardAt, emitAt)
  assert.match(guardSeg, /return/, '守卫分支必须 return，不能落下去继续提交')
  assert.match(guardSeg, /error\(/, '要告诉用户「请从候选里选」，不能静默失败')
})

test('小组成员提交：从名册选中时带 student_id，手输时只发姓名', () => {
  const src = stripComments(read('views/GroupManageView.vue'))

  // P2-1 之后 group_members 有 student_id 列，「同名两人」只能靠它区分。
  // 两条请求体都必须**有条件地**带上它 —— 无条件带会让手输姓名变成一个空 id，
  // 后端还得再猜一次，等于白加一列。所以判据是「先建 body，再按 _studentId 补」。
  const addBodyAt = src.indexOf('const body = { member_name: m.member_name, remark: m.remark };')
  assert.ok(addBodyAt > 0, '找不到新增成员的请求体')
  assert.match(
    src.slice(addBodyAt, addBodyAt + 220),
    /body\.student_id\s*=\s*m\._studentId/,
    '新增成员必须能把选中的 student_id 传上去',
  )

  const editBodyAt = src.indexOf('const body = { member_name: newName, remark: newRemark };')
  assert.ok(editBodyAt > 0, '找不到修改成员的请求体')
  assert.match(
    src.slice(editBodyAt, editBodyAt + 220),
    /body\.student_id\s*=\s*m\._studentId/,
    '改名/换人同样要能带上 student_id',
  )

  // 候选选中时把 id 记到成员对象上；「XXX 临时」伪候选的 id 是哨兵字符串，必须排除
  const fillAt = src.indexOf('function fillCandidate(')
  const fillSeg = src.slice(fillAt, src.indexOf('\nfunction ', fillAt + 10))
  assert.match(fillSeg, /_studentId\s*=/, '选中候选必须记住学生 id')
  assert.match(fillSeg, /typeof s\.id === 'number'/, '哨兵 id（__provisional__）不能当学生 id 传')
})

test('小组成员提交：手动改字要丢掉之前选中的 id', () => {
  const src = stripComments(read('views/GroupManageView.vue'))
  const at = src.indexOf('function onMemberInput(')
  assert.ok(at > 0, '找不到成员输入处理')
  const seg = src.slice(at, src.indexOf('\nfunction ', at + 10))
  // 「选了甲、又把名字改成乙」若不清 id，会存成「乙的名字 + 甲的 id」——
  // 这种错在界面上完全看不出来，只有按 id 反查名册才会发现挂错了人。
  assert.match(seg, /_studentId\s*=\s*null/, '重新输入必须清掉旧的选中 id')
})

test('智能分组写回：只传姓名数组（后端负责认人）', () => {
  const src = stripComments(read('views/GroupManageView.vue'))
  const at = src.indexOf('/apply-grouping`')
  assert.ok(at > 0, '找不到智能分组写回请求')

  const seg = src.slice(at, src.indexOf('});', at) + 3)
  assert.match(seg, /groups/, '写回体是 { groups }（每组一个姓名数组）')
  assert.ok(!/student_id/.test(seg), '智能分组不传 id（写回时后端统一认人）')
})
