// =========================================================================
// duty-arrange-scope-labor.test.js —— 值日智能排表的作用域与特殊劳动（v7 §5-5）
//
// 两个独立故障，都是「界面看着正常、结果悄悄错了」：
//   ① 「一大组」作用域取 seatCellNames() 的 .name —— 该函数返回的是 { r, c, key }，
//      字段不存在 → 参与者集合空 → 静默回退成全池（全班）。用户选中「一大组」，
//      实际按全班分配。
//   ② 「不做某项目」在没有别的项目空槽时，仍然把原排班清空（assigned[idx] = ''）。
//      预览里那一格真的空了，用户确认后已定的劳动安排被删掉，界面只显示条件未满足。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const loadDuty = () => import(pathToFileURL(path.join(
  ROOT, 'student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js',
)).href)
const loadPersonKey = () => import(pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/dutyPersonKey.js')).href)

const K = (id) => `id:${id}`

function dutyCtx({ seatSeats = [], pool = [] } = {}) {
  return {
    daysArr: { value: ['周一'] },
    itemsArr: { value: [{ name: '扫地', count: 2 }, { name: '拖地', count: 1 }] },
    weights: { value: {} },
    ledger: { value: {} },
    ledgerByName: { value: {} },
    baseCells: { value: {} },
    studentKeys: { value: pool },
    poolKeys: { value: pool },
    keyOfValue: (v) => (typeof v === 'string' && /^(id|name):/.test(v) ? v : ''),
    valueOfKey: (k) => k,
    nameOfKey: (k) => k,
    toKeyCells: (c) => c,
    toValueCells: (c) => c,
    dataSource: { value: 'all' },
    seat: { value: { seats: seatSeats } },
    satisfaction: { value: {} },
    conditions: { value: [] },
  }
}

// ———————————————— ① 一大组作用域 ————————————————

test('§5-5：作用域「一大组」的参与者只取座位表里的人，不静默回退全班', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const pool = [K(1), K(2), K(3), K(4), K(5)]
  // 座位表里只有 1、2 号在位（其余格子空着）
  const ctx = dutyCtx({ seatSeats: [[K(1), K(2)], [null, null]], pool })
  const p = useDutyArrangementPipeline(ctx, {})

  const ctxs = p.scopeContexts('bigroup', [], [])
  assert.equal(ctxs.length, 1)
  assert.deepEqual([...ctxs[0].participants].sort(), [K(1), K(2)].sort(),
    '一大组 = 坐在座位表里的人；取错字段会得到空集并回退成全池（5 人）')
  assert.equal(ctxs[0].key, 'bigroup')
})

test('§5-5：座位表确实没人时才回退全池（回退本身是合理兜底）', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const pool = [K(1), K(2)]
  const ctx = dutyCtx({ seatSeats: [[null]], pool })
  const p = useDutyArrangementPipeline(ctx, {})
  const ctxs = p.scopeContexts('bigroup', [], [])
  assert.deepEqual([...ctxs[0].participants].sort(), pool.sort(), '座位表空着时按全班处理')
})

test('§5-5：座位表里包含池外的人时不会把池外的带进来', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const pool = [K(1)]
  // 3 号不在池子里（数据源选了「现有值日表」时很常见）
  const ctx = dutyCtx({ seatSeats: [[K(1), K(3)]], pool })
  const p = useDutyArrangementPipeline(ctx, {})
  const ctxs = p.scopeContexts('bigroup', [], [])
  assert.deepEqual([...ctxs[0].participants], [K(1)], '只保留池内的人')
})

// ———————————————— ② 特殊劳动「不做」 ————————————————

const slots = [
  { item: '扫地', day: '周一' },
  { item: '拖地', day: '周一' },
]

test('§5-5：「不做」且有空槽 → 挪到空槽并清原槽，条件判为满足', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx({ pool: [K(1), K(2)] })
  const p = useDutyArrangementPipeline(ctx, {})
  const assigned = [K(1), '']
  p.applyLabor(slots, assigned, { uid: 'n1', student: K(1), item: '扫地', action: 'not' })

  assert.equal(assigned[0], '', '原槽要清空（这是用户要的「不做扫地」）')
  assert.equal(assigned[1], K(1), '挪到别的项目的空槽里，人还在名单上')
  assert.equal(p.satisfactionOf({ uid: 'n1' }), 100, '条件达成')
})

test('§5-5：「不做」但没有空槽 → 保留原排班，只把条件记为未满足', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx({ pool: [K(1), K(2)] })
  const p = useDutyArrangementPipeline(ctx, {})
  // 两个槽位都占着，且都排的是「扫地」：没有任何别的项目的空槽可去
  const trickySlots = [
    { item: '扫地', day: '周一' },
    { item: '扫地', day: '周二' },
  ]
  const assigned = [K(1), K(2)]
  p.applyLabor(trickySlots, assigned, { uid: 'n2', student: K(1), item: '扫地', action: 'not' })

  assert.equal(assigned[0], K(1),
    '挪不动时不能把人从已定的班里抹掉 —— 旧实现会写成空串，确认后名额就丢了')
  assert.equal(assigned[1], K(2), '别人的槽位也不能被牵连')
  assert.equal(p.satisfactionOf({ uid: 'n2' }), 0, '没达成就如实显示未满足，让用户改条件')
})

test('§5-5：部分能挪时只挪能挪的，剩下的保留（不整体清空）', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx({ pool: [K(1), K(2)] })
  const p = useDutyArrangementPipeline(ctx, {})
  // 1 号排了两天扫地；拖地只有一个空槽
  const s = [
    { item: '扫地', day: '周一' },
    { item: '扫地', day: '周二' },
    { item: '拖地', day: '周三' },
  ]
  const assigned = [K(1), K(1), '']
  p.applyLabor(s, assigned, { uid: 'n3', student: K(1), item: '扫地', action: 'not' })

  assert.equal(assigned[2], K(1), '能挪的那一格要挪到空槽')
  assert.equal(assigned[0], '', '能挪走的扫地格要清空')
  assert.equal(assigned[1], K(1), '挪不走的扫地格保留原排班（不清空、不丢名额）')
  assert.equal(p.satisfactionOf({ uid: 'n3' }), 0, '还有一格没挪走，条件未满足')
})

test('§5-5：「一定做」在项目还有空槽时把人排进去（原逻辑不能被改坏）', async () => {
  const { useDutyArrangementPipeline } = await loadDuty()
  const ctx = dutyCtx({ pool: [K(1), K(2)] })
  const p = useDutyArrangementPipeline(ctx, {})
  const s = [
    { item: '扫地', day: '周一' },
    { item: '扫地', day: '周二' },
    { item: '拖地', day: '周一' },
  ]
  const assigned = [K(2), '', K(1)]   // 扫地第二格空着；1 号在拖地
  p.applyLabor(s, assigned, { uid: 'n4', student: K(1), item: '扫地', action: 'do' })
  assert.equal(assigned[1], K(1), '1 号进了扫地的空槽')
  assert.equal(assigned[2], '', '原拖地槽被让出来')
  assert.equal(p.satisfactionOf({ uid: 'n4' }), 100)
})
