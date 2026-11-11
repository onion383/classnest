// =========================================================================
// duty-dedupe-whole-table.test.js —— 「整表去重」这个开关必须真的生效（A3-01）
//
// 事故：`const wholeTable = ctx.dedupeWholeTable === true`
// ctx 里的状态全是 ref/computed（见 pipeline 文件头的「ctx 契约」），
// `ref(false) === true` 与 `ref(true) === true` **都是 false** ——
// 也就是说大扫除场景「一个人不能同时扫第 1 组和第 2 组」这条规则从未生效过，
// 而且不报错：排出来的表看着挺正常，只是有人被重复排了两遍。
//
// 判据不能只测「大扫除不重复」，还要测「日常仍然按天去重」——
// 否则把整个去重逻辑改成全表去重也能骗过测试。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const PIPELINE = pathToFileURL(
  path.join(ROOT, 'student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js'),
).href

async function makePipeline({ wholeTable, pool = ['甲', '乙', '丙'] }) {
  const { useDutyArrangementPipeline } = await import(PIPELINE)
  // 只提供 fillEmptySlots 需要的 ctx 字段；形状必须与真实调用点一致（都是 ref）
  const ctx = {
    poolNames: { value: pool },
    dedupeWholeTable: { value: wholeTable },
  }
  return useDutyArrangementPipeline(ctx, {})
}

const slots = (days) => days.map((day) => ({ item: '扫地', day, k: 0 }))

test('大扫除：一个人不能同时占两个组', async () => {
  const p = await makePipeline({ wholeTable: true })
  const assigned = ['甲', null, null]
  p.fillEmptySlots(slots(['第1组', '第2组', '第3组']), assigned, [])
  assert.equal(assigned[0], '甲', '已排好的不能被动')
  assert.ok(assigned[1] && assigned[1] !== '甲', `第2组不该还是甲，实际「${assigned[1]}」`)
  assert.ok(assigned[2] && assigned[2] !== '甲', `第3组不该还是甲，实际「${assigned[2]}」`)
  assert.equal(new Set(assigned).size, assigned.length, '大扫除的表里不该出现重复的人')
})

test('日常：同一个人可以排在不同星期（按天去重，不是整表）', async () => {
  const p = await makePipeline({ wholeTable: false })
  // 三个槽分属三天，池里只有 3 人：若按整表去重会排成甲乙丙（各一次）；
  // 按天去重则允许重复 —— 差别就是下面这一条「集合比长度小」。
  const assigned = ['甲', null, null]
  p.fillEmptySlots(slots(['周一', '周二', '周三']), assigned, [])
  assert.ok(assigned.every(Boolean), '三个槽都该填上')
  assert.ok(
    new Set(assigned).size < assigned.length,
    `日常场景应允许同一人跨天重复，实际 ${JSON.stringify(assigned)}（如果这里是甲乙丙，说明被当成整表去重了）`,
  )
})

test('日常：同一天内仍然不重复', async () => {
  const p = await makePipeline({ wholeTable: false, pool: ['甲', '乙'] })
  // 同一天两个槽位
  const assigned = ['甲', null]
  p.fillEmptySlots([{ item: '扫地', day: '周一', k: 0 }, { item: '拖地', day: '周一', k: 1 }], assigned, [])
  assert.equal(assigned[1], '乙', '同一天的第二个槽要换人')
})

test('缺 dedupeWholeTable 开关的旧 ctx：按日常去重，且不能抛错', async () => {
  const { useDutyArrangementPipeline } = await import(PIPELINE)
  const ctx = { poolNames: { value: ['甲', '乙'] } }
  const p = useDutyArrangementPipeline(ctx, {})
  const assigned = ['甲', null, null]
  assert.doesNotThrow(() => p.fillEmptySlots(slots(['周一', '周二', '周三']), assigned, []))
  assert.ok(assigned.every(Boolean), '没有大扫除开关时仍要正常补齐空槽')
})

test('接线：读 ctx 状态必须取 .value（ref 对象本身恒不等于 true）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js'),
    'utf8',
  )
  assert.ok(
    /ctx\.dedupeWholeTable\?\.value\s*===\s*true/.test(src),
    'pipeline 里又出现了 `ctx.dedupeWholeTable === true` 这种写法 —— 开关会静默失效',
  )
  // 顺带确认 ctx 那个字段确实是 computed（如果将来改成普通布尔，这条判据就该重写）
  const vue = fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.vue'),
    'utf8',
  )
  assert.match(vue, /dedupeWholeTable:\s*computed\(/, 'ctx.dedupeWholeTable 不是 computed 了，判据要跟着改')
})
