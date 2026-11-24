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
const {
  analyze, walk, memberPath, keyName, findFunction, scriptBlocks,
} = require('../_source-scan.cjs')

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const scriptOf = (rel) => scriptBlocks(read(rel))
// 对象字面量的具名属性
const prop = (obj, name) => (obj.properties || []).find(
  (p) => p.type === 'ObjectProperty' && keyName(p.key) === name,
) || null
const rangeText = (code, node) => code.slice(node.start, node.end)

// 在指定函数体内按 url 片段找请求。两种调用形态都支持：
//   api({ url, method, data/body }) 与 api(url, { method, body })
function requestInFunction(ast, code, fnName, ...needles) {
  const fn = findFunction(ast, fnName)
  if (!fn) return null
  let found = null
  walk(fn.node, (node) => {
    if (node.type !== 'CallExpression' || !node.arguments.length) return
    const first = node.arguments[0]
    let urlNode = null
    let options = null
    if (first.type === 'ObjectExpression') {
      const u = prop(first, 'url')
      if (!u) return null
      urlNode = u.value
      options = first
    } else if (first.type === 'StringLiteral' || first.type === 'TemplateLiteral') {
      urlNode = first
      const o = node.arguments[1]
      if (o && o.type === 'ObjectExpression') options = o
    }
    if (!urlNode || !options) return
    const urlText = rangeText(code, urlNode)
    if (needles.every((n) => urlText.includes(n))) found = options
  })
  return found
}

test('班干部添加成员：请求体带 student_id（不是只发姓名）', () => {
  const code = scriptOf('components/CadreManage.vue')
  // 为什么不用 indexOf('`/cadres/${nodeId}/members`') + 切片到 '})'：
  // 字符串写法（引号/模板串）一变就找不到；而 '})' 会被参数里的对象/箭头提前命中。
  // AST 直接定位 url 含 cadres/members 的请求对象，再看 data 的键。
  const { ast } = analyze(code)
  const req = requestInFunction(ast, code, 'onAddStudentInline', 'members')
  assert.ok(req, '找不到添加担任学生的请求')

  const data = prop(req, 'data')
  assert.ok(data && data.value.type === 'ObjectExpression', '请求应带 data 对象')
  assert.ok(prop(data.value, 'student_id'), '必须把 student_id 一起提交，否则 cadre_members 只能存姓名快照')
  assert.ok(prop(data.value, 'student_name'), '姓名快照也要带（后端会以 students.姓名 为准）')
})

test('班干部添加成员：名册里找不到这个人时不发请求', () => {
  const code = scriptOf('components/CadreTreeList.vue')
  const { ast } = analyze(code)
  const fn = findFunction(ast, 'confirmAdd')
  assert.ok(fn, '找不到 confirmAdd')

  let guard = null
  walk(fn.node, (node) => {
    if (node.type === 'IfStatement' && node.test.type === 'UnaryExpression'
      && node.test.operator === '!' && node.test.argument.type === 'Identifier'
      && node.test.argument.name === 'student') guard = node
  })
  assert.ok(guard, '必须有「找不到学生」的分支')

  // 守卫分支里必须 return（不能落下去继续提交）、且要告诉用户
  let hasReturn = false
  let hasError = false
  walk(guard.consequent, (node) => {
    if (node.type === 'ReturnStatement') hasReturn = true
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && node.callee.name === 'error') hasError = true
      if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'error') hasError = true
    }
  })
  assert.ok(hasReturn, '守卫分支必须 return，不能落下去继续提交')
  assert.ok(hasError, '要告诉用户「请从候选里选」，不能静默失败')

  let emitCall = null
  walk(fn.node, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'emit'
      && node.arguments[0] && node.arguments[0].type === 'StringLiteral'
      && node.arguments[0].value === 'add-student') emitCall = node
  })
  assert.ok(emitCall, 'confirmAdd 应 emit add-student')
  assert.ok(emitCall.start > guard.end, 'emit 必须在守卫之后 —— 否则会带着 undefined 的 id 提交')
})

test('小组成员提交：从名册选中时带 student_id，手输时只发姓名', () => {
  const code = scriptOf('views/GroupManageView.vue')
  const { ast } = analyze(code)

  // P2-1 之后 group_members 有 student_id 列，「同名两人」只能靠它区分。
  // 两条请求体都必须**有条件地**带上它 —— 无条件带会让手输姓名变成一个空 id。
  // 判据：body.student_id = m._studentId 在文件里恰好出现 2 次（新增 + 编辑），
  // 且每次都在 `if (m._studentId != null)` 的 consequent 里。
  const assigns = []
  const ifs = []
  walk(ast.program, (node) => {
    if (node.type === 'AssignmentExpression' && memberPath(node.left) === 'body.student_id') {
      assigns.push(node)
    }
    if (node.type === 'IfStatement') ifs.push(node)
  })
  assert.equal(assigns.length, 2, `新增/编辑两条请求体都要补 student_id（实际 ${assigns.length} 处）`)
  for (const a of assigns) {
    const guarded = ifs.some((st) => st.consequent.start <= a.start && a.end <= st.consequent.end
      && /_studentId/.test(rangeText(code, st.test)))
    assert.ok(guarded, 'body.student_id 必须按 m._studentId 条件补齐（手输时不能发空 id）')
    assert.equal(memberPath(a.right), 'm._studentId', '补进 body 的应是选中的 m._studentId')
  }

  // 候选选中时把 id 记到成员对象上；「XXX 临时」伪候选的 id 是哨兵字符串，必须排除
  const fill = findFunction(ast, 'fillCandidate')
  assert.ok(fill, '找不到 fillCandidate')
  let fillAssign = null
  walk(fill.node, (node) => {
    if (node.type === 'AssignmentExpression' && memberPath(node.left) === 'm._studentId') fillAssign = node
  })
  assert.ok(fillAssign, '选中候选必须记住学生 id')
  assert.ok(fillAssign.right.type === 'ConditionalExpression', '哨兵 id 必须用条件表达式排除')
  assert.match(rangeText(code, fillAssign.right.test), /typeof\s+s\.id\s*===\s*'number'/,
    '哨兵 id（__provisional__）不能当学生 id 传')
})

test('小组成员提交：手动改字要丢掉之前选中的 id', () => {
  const code = scriptOf('views/GroupManageView.vue')
  const { ast } = analyze(code)
  const fn = findFunction(ast, 'onMemberInput')
  assert.ok(fn, '找不到成员输入处理')
  // 「选了甲、又把名字改成乙」若不清 id，会存成「乙的名字 + 甲的 id」——
  // 这种错在界面上完全看不出来，只有按 id 反查名册才会发现挂错了人。
  let cleared = false
  walk(fn.node, (node) => {
    if (node.type === 'AssignmentExpression' && memberPath(node.left) === 'm._studentId'
      && node.right.type === 'NullLiteral') cleared = true
  })
  assert.ok(cleared, '重新输入必须清掉旧的选中 id')
})

test('智能分组写回：只传姓名数组（后端负责认人）', () => {
  const code = scriptOf('views/GroupManageView.vue')
  const { ast } = analyze(code)
  const req = requestInFunction(ast, code, 'handleSmartGroupResult', 'apply-grouping')
  assert.ok(req, '找不到智能分组写回请求')

  // 写回体是 JSON.stringify({ groups })；不能顺带塞 student_id
  const body = prop(req, 'body')
  assert.ok(body && body.value.type === 'CallExpression' && memberPath(body.value.callee) === 'JSON.stringify',
    '写回体应是 JSON.stringify(...)')
  const payload = body.value.arguments[0]
  assert.ok(payload && payload.type === 'ObjectExpression', '写回体应是对象')
  assert.ok(prop(payload, 'groups'), '写回体是 { groups }（每组一个姓名数组）')
  assert.ok(!prop(payload, 'student_id'), '智能分组不传 id（写回时后端统一认人）')
})
