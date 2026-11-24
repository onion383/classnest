// =========================================================================
// sweep-fixes-c2.test.js —— 档 C-2「业务规则与算法单点」的行为回归
//
//   F03-01  apart/together 满组后没有跨组交换兜底（G=2 拆散成功率实测仅 55.6%）
//   F03-04  全女生 balanced 满足率被记成 0%（空命题误报）
//   F03-07  GridView 保存编辑重建单元格，丢掉 _bg/_fg 等装饰字段
//   K05-06  分组快照回填丢 student_id，权威引用退化为姓名匹配
//   Q2-06  几何越界校验只覆盖座位表，课表收缩后旧坐标仍可写进矩阵
//   K03-15  scanWorker 的 restartWindow 声明在引用它的函数之后（TDZ 顺序）
//   Q3-04   /api/ai 下 ai.config 两处挂载（确认是快路径 + 独立可用的有意设计）
//
// 手法：算法类直接 import 真实 ESM；后端类跑真内存库 + 真执行器；
// 组件方法从真实 .vue 源码里抽函数体用 new Function 执行（不复制逻辑）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const importFrontend = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const fx = createBackendDb({ label: 'sweep-c2' })
test.after(() => fx.close())

// ---------------------------------------------------------------------------
// F03-01 / F03-04：分组算法真跑
// ---------------------------------------------------------------------------
const PIPELINE = 'student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.pipeline.js'

function makeCtx(roster, groupCount, stages) {
  const satisfaction = { value: {} }
  return {
    roster: { value: roster },
    groups: { value: Array.from({ length: groupCount }, () => ({})) },
    stages: { value: stages },
    satisfaction,
    trackSatisfaction(key, done, total) {
      satisfaction.value[key] = total > 0 ? done / total : 1
    },
  }
}

const groupIndexOf = (members, si) => members.findIndex((g) => g.has(si))

test('[行为] F03-01 apart 在两组皆满时用交换兜底：500 轮全部拆散且人数守恒', async () => {
  const { useSmartGroupPipeline } = await importFrontend(PIPELINE)
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, 姓名: `S${i + 1}`, 性别: '男' }))
  const ctx = makeCtx(roster, 2, [{ key: 'r1', type: 'relation', kind: 'apart', a: '1', b: '2' }])
  const { buildAssignment } = useSmartGroupPipeline(ctx)

  let bad = 0
  for (let round = 0; round < 500; round++) {
    ctx.satisfaction.value = {}
    const { members } = buildAssignment()
    const total = members.reduce((n, g) => n + g.size, 0)
    // 1 号与 2 号是 roster 的下标 0 / 1
    const apart = groupIndexOf(members, 0) !== groupIndexOf(members, 1)
    const even = members.every((g) => g.size === 4)
    if (!apart || !even || total !== 8 || ctx.satisfaction.value.r1 !== 1) bad++
  }
  assert.equal(bad, 0, `500 轮里 ${bad} 轮没有把两人拆开 / 人数不守恒`)
})

test('[行为] F03-01 together 在两组皆满时用交换兜底', async () => {
  const { useSmartGroupPipeline } = await importFrontend(PIPELINE)
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, 姓名: `S${i + 1}`, 性别: '女' }))
  const ctx = makeCtx(roster, 2, [{ key: 'r1', type: 'relation', kind: 'together', a: '1', b: '2' }])
  const { buildAssignment } = useSmartGroupPipeline(ctx)

  for (let round = 0; round < 200; round++) {
    ctx.satisfaction.value = {}
    const { members } = buildAssignment()
    assert.equal(groupIndexOf(members, 0), groupIndexOf(members, 1), '指定同组的两人必须在同一组')
    assert.equal(members.reduce((n, g) => n + g.size, 0), 8, '交换兜底不能丢人')
    assert.equal(ctx.satisfaction.value.r1, 1)
  }
})

test('[行为] F03-01 交换兜底不动指定组长与其它关系条件里的人', async () => {
  const { useSmartGroupPipeline } = await importFrontend(PIPELINE)
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, 姓名: `S${i + 1}`, 性别: '男' }))
  const ctx = makeCtx(roster, 2, [
    { key: 'i1', type: 'identity', kind: 'leader', studentId: '3' }, // 先固定组长
    { key: 'r1', type: 'relation', kind: 'together', a: '7', b: '8' },
    { key: 'r2', type: 'relation', kind: 'apart', a: '1', b: '2' },
  ])
  const { buildAssignment } = useSmartGroupPipeline(ctx)
  for (let round = 0; round < 100; round++) {
    ctx.satisfaction.value = {}
    const { members, leaders } = buildAssignment()
    assert.equal(groupIndexOf(members, 0) !== groupIndexOf(members, 1), true, 'r2 必须满足')
    assert.equal(groupIndexOf(members, 6), groupIndexOf(members, 7), 'r1 不能被交换兜底破坏')
    const g3 = groupIndexOf(members, 2)
    assert.equal(leaders[g3], 2, '指定组长不能被换走')
  }
})

test('[行为] F03-04 名册没有男生时 balanced 不记 0%（空命题视为满足）', async () => {
  const { useSmartGroupPipeline } = await importFrontend(PIPELINE)
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, 姓名: `G${i + 1}`, 性别: '女' }))
  const ctx = makeCtx(roster, 2, [{ key: 'g1', type: 'gender', mode: 'balanced' }])
  const { buildAssignment } = useSmartGroupPipeline(ctx)

  ctx.satisfaction.value = {}
  buildAssignment()
  assert.equal(ctx.satisfaction.value.g1, 1, '全女生时“男女均匀”是空命题，不能显示 0%')
})

// ---------------------------------------------------------------------------
// F03-07：从真实 .vue 源码抽 saveEditCell 函数体执行
// ---------------------------------------------------------------------------

/** 抽出 `name() { ... }` 的函数体（按花括号配平；失败直接抛，避免假绿） */
function extractMethodBody(src, name) {
  const start = src.indexOf(`${name}() {`)
  assert.ok(start >= 0, `源码里找不到 ${name}()`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`${name}() 的花括号没有配平`)
}

test('[行为] F03-07 保存编辑保留 _bg/_fg/_blank 等装饰字段', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const body = extractMethodBody(src, 'saveEditCell')
  const run = new Function('ctx', 'emit', body)

  const ctx = {
    editingCell: { value: { row: 0, col: 0 } },
    rows: { value: [{ cells: [{ course: '数学', _bg: '#ffdddd', _fg: '#111111', _blank: false }] }] },
    editingCellData: { value: { course: '语文' } },
    candidateIdField: { value: null },
    closeEditor() { this.closed = true },
  }
  let emitted = null
  run(ctx, (ev, rows) => { emitted = rows })

  assert.ok(emitted, '必须 emit update:cells')
  const cell = emitted[0].cells[0]
  assert.equal(cell.course, '语文', '编辑内容要写进去')
  assert.equal(cell._bg, '#ffdddd', '热力图底色不能被保存动作抹掉')
  assert.equal(cell._fg, '#111111', '深底白字不能被保存动作抹掉')
  assert.equal(cell._blank, false, '空位标记不能被保存动作抹掉')
})

test('[行为] F03-07 清空内容时只清 _studentId，装饰字段仍然保留', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const run = new Function('ctx', 'emit', extractMethodBody(src, 'saveEditCell'))
  const ctx = {
    editingCell: { value: { row: 0, col: 0 } },
    rows: { value: [{ cells: [{ course: '张三', _studentId: 9, _bg: '#eef' }] }] },
    editingCellData: { value: { course: '' } },
    candidateIdField: { value: 'student_id' },
    closeEditor() {},
  }
  let emitted = null
  run(ctx, (ev, rows) => { emitted = rows })
  assert.equal(emitted[0].cells[0]._studentId, null, '空名字不能留旧 id')
  assert.equal(emitted[0].cells[0]._bg, '#eef', '清内容不等于清装饰')
})

// ---------------------------------------------------------------------------
// K05-06：真库 + 真执行器
// ---------------------------------------------------------------------------
const { executors } = require('../../student-backend/routes/undo/undo.executors')

function seedGroup(conn) {
  conn.exec(`
    INSERT INTO students (id, 姓名) VALUES (7, '张三'), (8, '李四');
    INSERT INTO group_dimensions (id, name) VALUES (1, '学习小组');
    INSERT INTO groups (id, dimension_id, name, sort_order) VALUES (10, 1, 'A组', 1);
    INSERT INTO group_members (id, group_id, student_id, member_name, remark, sort_order)
      VALUES (100, 10, 7, '张三', '', 1);
  `)
}

test('[行为] K05-06 分组快照撤销/重做都必须把 student_id 写回', () => {
  const conn = fx.reset({ seed: seedGroup })
  const snapshot = [{
    id: 10, name: 'A组', gender: 0, sort_order: 1,
    members: [
      { id: 100, student_id: 7, member_name: '张三', remark: '组长', sort_order: 1 },
      { id: 101, student_id: 8, member_name: '李四', remark: '', sort_order: 2 },
    ],
  }]

  executors.group_snapshot.undo({ dimId: 1, oldValue: snapshot })
  const rows = conn.prepare('SELECT id, student_id, member_name FROM group_members ORDER BY id').all()
  assert.deepEqual(rows.map((r) => r.student_id), [7, 8], '撤销后 student_id 不能落成 NULL（否则同名两人无法区分）')
  assert.deepEqual(rows.map((r) => r.member_name), ['张三', '李四'])

  executors.group_snapshot.redo({ dimId: 1, newValue: snapshot })
  const after = conn.prepare('SELECT student_id FROM group_members ORDER BY id').all()
  assert.deepEqual(after.map((r) => r.student_id), [7, 8], '重做同样要保住权威引用')
})

// ---------------------------------------------------------------------------
// Q2-06：课表矩阵收缩后，旧坐标的撤销必须被拒绝
// ---------------------------------------------------------------------------
test('[行为] Q2-06 课表从 4×4 收缩到 3×3 后，第 4 行的旧撤销被拒（不再静默补形状）', () => {
  const conn = fx.reset()
  const cells = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ course: '' })))
  conn.prepare("UPDATE schedule_slots SET cells = ? WHERE kind = 'current'").run(JSON.stringify(cells))

  const bad = executors.grid_cell.validate({ table: 'schedule', row: 3, col: 0 })
  assert.match(String(bad), /3 行/, '越界行必须返回可读的拒绝理由')

  const badCol = executors.grid_cell.validate({ table: 'schedule', row: 0, col: 3 })
  assert.match(String(badCol), /3 列/, '越界列同样要拒绝')

  assert.equal(executors.grid_cell.validate({ table: 'schedule', row: 2, col: 2 }), null, '当前形状内的格子仍可撤销')
})

// ---------------------------------------------------------------------------
// K03-15 / Q3-04：静态接线
// ---------------------------------------------------------------------------
test('[静态] K03-15 restartWindow 声明在 scheduleRestart 之前', () => {
  const src = read('student-backend/scanWorker.js')
  const decl = src.indexOf('let restartWindow')
  const fn = src.indexOf('function scheduleRestart')
  assert.ok(decl >= 0 && fn >= 0)
  assert.ok(decl < fn, 'let restartWindow 必须在使用它的 scheduleRestart 之前声明')
})

test('[静态] Q3-04 ai.config 双挂载是有意设计（快路径 + 独立可用），不是待删死代码', () => {
  const app = read('student-backend/app.js')
  const ai = read('student-backend/routes/ai/ai.js')
  assert.match(app, /app\.use\('\/api\/ai', auth\(\['teacher'\]\), require\('\.\/routes\/ai\/ai\.config'\)\)/, '首屏快路径必须保留')
  assert.match(ai, /router\.use\(require\('\.\/ai\.config'\)\)/, 'ai router 独立挂载时仍需要 /config')
  assert.match(ai, /Q3-04[\s\S]{0,120}router\.use\(require\('\.\/ai\.config'\)\)/, '两处保留的原因要写在附近，防止后人误删一处')
})
