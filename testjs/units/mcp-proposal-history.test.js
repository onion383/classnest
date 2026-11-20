// =========================================================================
// mcp-proposal-history.test.js —— 提案的「未处理 / 已处理」两栏与保留条数
//
// 背景：原先弹窗只拉 status=pending，确认/拒绝后那条就在界面上彻底消失了，
// 老师想回看「刚才那条 AI 改了什么」只能去「更改审查」里翻。现在分成两栏，
// 已处理按条数保留。这份测试钉住四件事：
//   1. list 支持多状态（4 种已定稿合并成一栏），不把 pending 混进去
//   2. 保留条数只裁已处理，pending 一条都不能少（裁掉等于偷偷吞提案）
//   3. 保留条数的取值范围（50~2000，非法值回落默认）
//   4. 已处理视图不回读当前行、不重算 diff（执行后行已是新值，重算只会得到空白）
// 变异反证：把 trimDone 的状态条件去掉（连 pending 一起裁），第 2 条立刻红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

const BACKEND = path.join(ROOT, 'student-backend')
const DIALOG = path.join(ROOT, 'student-frontend/src/components/data-manage/McpProposalsDialog.vue')

function seedProposal(proposals, db, { operation = 'update', decidedAt = null, status = null } = {}) {
  const id = proposals.create({
    kind: 'row_write',
    label: '测试提案',
    table: 'students',
    operation,
    payload: { id: 1, data: { 姓名: '张三丰' } },
    requestedBy: 'mcp',
  })
  if (status) {
    proposals.decide(id, status, { ok: status === 'confirmed' })
    if (decidedAt) {
      // 同一毫秒内连建多条时 decided_at 会撞在一起，裁剪顺序就不确定了；
      // 显式错开，才能断言「留下的就是最新的 N 条」。
      db.prepare('UPDATE mcp_proposals SET decided_at = ? WHERE proposal_id = ?').run(decidedAt, id)
    }
  }
  return id
}

test('提案两栏：已处理可查、保留条数只裁历史', async (t) => {
  const fx = createBackendDb({ label: 'proposal-history' })
  fx.reset()

  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()

  const proposals = backendRequire(path.join(BACKEND, 'services/mcpProposalStore.js'))
  const view = backendRequire(path.join(BACKEND, 'services/mcpProposalView.js'))
  const aiConfigStore = backendRequire(path.join(BACKEND, 'services/aiConfigStore.js'))
  const { db } = backendRequire(path.join(BACKEND, 'db.js'))

  t.after(() => {
    dbManager.withDb = origWithDb
    fx.close()
  })

  // 5 条已处理（时间递增）+ 2 条待确认
  const doneIds = []
  const kinds = ['confirmed', 'rejected', 'failed', 'confirmed', 'confirmed']
  for (let i = 0; i < 5; i += 1) {
    const iso = new Date(Date.UTC(2026, 10, 1, 0, 0, i + 1)).toISOString()
    doneIds.push(seedProposal(proposals, db, { status: kinds[i], decidedAt: iso }))
  }
  const pendingA = seedProposal(proposals, db)
  const pendingB = seedProposal(proposals, db, { operation: 'delete' })

  await t.test('已处理：四种定稿状态合并成一栏，pending 不在里面', () => {
    const rows = proposals.list({ status: proposals.DONE_STATUSES, withPayload: true })
    assert.equal(rows.length, 5, `期望 5 条已处理，实际 ${rows.length}`)
    assert.ok(!rows.some((r) => r.status === 'pending'), '已处理里不能出现 pending')
    const got = new Set(rows.map((r) => r.status))
    assert.ok(got.has('rejected') && got.has('failed'), '拒绝与失败要各自保留细分状态')
  })

  await t.test('单状态查询仍然可用（外部轮询与摘要行都在用）', () => {
    const rows = proposals.list({ status: 'pending', withPayload: true })
    assert.equal(rows.length, 2)
  })

  await t.test('裁剪只动已处理：pending 一条都不能少', () => {
    const removed = proposals.trimDone(2)
    assert.equal(removed, 3, `期望裁掉 3 条，实际 ${removed}`)
    const left = proposals.list({ status: proposals.DONE_STATUSES })
    assert.equal(left.length, 2, '已处理应只剩最近 2 条')
    const pend = proposals.list({ status: 'pending' })
    assert.equal(pend.length, 2, 'pending 不能被保留条数影响')
  })

  await t.test('留下的是最新的两条（按 decided_at 倒序）', () => {
    const left = proposals.list({ status: proposals.DONE_STATUSES })
    // 刚建的 5 条里，时间最晚的两条是 i=4、i=3
    assert.deepEqual(left.map((r) => r.proposal_id), [doneIds[4], doneIds[3]])
    assert.ok(!left.some((r) => r.proposal_id === pendingA || r.proposal_id === pendingB))
  })

  await t.test('保留条数：范围 50~2000，非法值回落默认 200', () => {
    assert.equal(aiConfigStore.setMcpPrefs({ proposal_keep: 10 }).proposal_keep, 50, '低于下限夹到 50')
    assert.equal(aiConfigStore.setMcpPrefs({ proposal_keep: 99999 }).proposal_keep, 2000, '高于上限夹到 2000')
    assert.equal(aiConfigStore.setMcpPrefs({ proposal_keep: 'abc' }).proposal_keep, 200, '非法值回落默认')
    assert.equal(aiConfigStore.readMcpPrefs().proposal_keep, 200, '落库后读回来一致')
  })

  await t.test('已处理视图不回读：没有 fields，只给表名/操作/id', () => {
    const row = proposals.get(doneIds[4])
    const live = view.describe(row)
    const hist = view.describeDone(row)
    // pending 视图要能算出「改前 → 改后」；历史视图必须不带这个（执行后行是新值）
    assert.ok(Array.isArray(live.ops[0].fields), '实时视图仍有字段 diff')
    assert.equal(hist.ops[0].fields, undefined, '已处理视图不该有 fields')
    assert.equal(hist.ops[0].op_label, '修改')
    assert.equal(hist.ops[0].table_label, '学生名单')
    assert.equal(hist.status, 'confirmed')
    assert.equal(hist.payload, undefined, '内部结构不下发')
  })

  await t.test('弹窗两栏：有未处理/已处理，且已处理卡片没有确认按钮', () => {
    const src = fs.readFileSync(DIALOG, 'utf8')
    assert.match(src, /label: '未处理'/, '要有未处理栏')
    assert.match(src, /label: '已处理'/, '要有已处理栏')
    // 只截「已处理」区块：未处理区当然有确认/拒绝，不能一刀切禁 decide
    const start = src.indexOf('<!-- 已处理')
    const end = src.indexOf('<!-- 保留条数')
    assert.ok(start > 0 && end > start, '找不到已处理区块')
    const block = src.slice(start, end)
    assert.ok(!/decide\(/.test(block), '已处理是只读历史，不能再出现确认/拒绝按钮')
    assert.match(block, /statusLabel\(p\.status\)/, '要有结果状态徽标')
    assert.match(src, /status: 'done'/, '已处理的数据来源是 status=done')
  })
})

test('提案弹窗：刷新要给反馈，打开时不要弹「已刷新」', () => {
  // 三个 load 以前各自 catch 吞错，点刷新失败也毫无反应（列表保持旧内容，
  // 看起来像「刷新了但没变化」）。这条钉住：按钮走 refreshAll、成功失败都有提示条，
  // 而「打开弹窗自动拉」必须静默 —— 否则每次点进提案页都先弹一条。
  const src = fs.readFileSync(DIALOG, 'utf8')
  assert.match(src, /@click="refreshAll\(\)"/, '刷新按钮要显式调用 refreshAll()')
  assert.match(src, /notify\.success\('已刷新'\)/, '成功要有提示条')
  assert.match(src, /notify\.error\('刷新失败/, '失败要说原因')
  assert.match(src, /refreshAll\(\{ notifyResult: false \}\)/, '打开时静默刷新')
  // load 里不许再自己吞错，否则 allSettled 永远看到 fulfilled
  const loadBlocks = src.slice(src.indexOf('async function loadPending'), src.indexOf('async function refreshAll'))
  assert.ok(!/catch\s*\(/.test(loadBlocks), 'load 不该内部吞错，交给 refreshAll 汇总')
})

test('已处理栏走行虚拟滚动，未处理栏不走', () => {
  // 已处理可以堆到几百条，全量挂 DOM 没必要；未处理的卡片必须完整显示 diff、
  // 高度随内容变 —— 那正是行高不定的情形，塞进固定步长会错行。所以只对已处理切片。
  const src = fs.readFileSync(DIALOG, 'utf8')
  assert.match(src, /@scroll="onScroll"/, '滚动容器要接滚动事件')
  assert.match(src, /doneView\.padTop/, '上方垫片')
  assert.match(src, /doneView\.padBottom/, '下方垫片')
  assert.match(src, /\.prop-card \{ height: \d+px; \}/, '卡片必须定高（虚拟滚动的先决条件）')
  assert.match(src, /visibleFixedRows\(/, '计算走共享纯函数')

  // 未处理区块不许出现垫片：那一段要全量渲染
  const pStart = src.indexOf("tab === 'pending'")
  const dStart = src.indexOf('<!-- 已处理')
  assert.ok(pStart > 0 && dStart > pStart, '找不到未处理区块')
  const block = src.slice(pStart, dStart)
  assert.ok(!/padTop|padBottom/.test(block), '未处理栏不该有垫片')
})
