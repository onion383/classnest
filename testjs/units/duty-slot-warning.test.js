// =========================================================================
// duty-slot-warning.test.js —— 「值日位置不足，有 X 人排不进值日表」确认提示
// 运行：npm run test:units
//
// 判据：X 必须来自 shortageCount 单源；确认框与 needsSlotWarning 都读它；
//       「重复值日」那一支不能被新文案吞掉（两种情况方向相反）。
// 行为部分跑 options.js 真实源码，形态部分读 vue 源码（去注释后匹配）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIR = path.join(__dirname, '../../student-frontend/src/components/dialogs/DutyArrangementDialog')
const loadOptions = () => import(pathToFileURL(path.join(DIR, 'DutyArrangementDialog.options.js')).href)
const VUE = path.join(DIR, 'DutyArrangementDialog.vue')

const DAYS = ['周一', '周二', '周三']
const ITEMS = [{ name: '扫地', count: 2 }, { name: '拖地', count: 2 }] // 3 天 × 4 槽 = 12
const names = n => Array.from({ length: n }, (_, i) => 'S' + i)

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

async function makeOpts(over = {}) {
  const ctx = {
    daysArr: { value: DAYS },
    itemsArr: { value: ITEMS },
    poolNames: { value: names(14) },
    studentNames: { value: names(14) },
    dataSource: { value: 'all' },
    tableFilled: { value: 12 },
    ...over,
  }
  const { useDutyArrangementOptions } = await loadOptions()
  // 真实组件里也是 Object.assign 回填，needsSlotWarning 才能调到 shortageCount
  Object.assign(ctx, useDutyArrangementOptions(ctx, {}))
  return ctx
}

test('人数不足 · X = 参与人数 − 总槽位，单源可复算', async () => {
  const ctx = await makeOpts()
  assert.equal(ctx.totalSlots(), 12)
  assert.equal(ctx.shortageCount(), 2, '14 人 / 12 槽 → 2 人排不进表')
  const ok = await makeOpts({ poolNames: { value: names(12) }, studentNames: { value: names(12) } })
  assert.equal(ok.shortageCount(), 0, '人数正好等于槽位时不报不足')
  const few = await makeOpts({ poolNames: { value: names(8) }, studentNames: { value: names(8) } })
  assert.equal(few.shortageCount(), 0, '人数少于槽位时差额为 0，不报不足')
})

test('人数不足 · 确认判定与文案共用同一个 X', async () => {
  const short = await makeOpts()
  assert.equal(short.needsSlotWarning(), true)
  assert.equal(short.shortageCount(), 2)
  // 「现有排表表格」下人数多于槽位也要拦住，不能只按 dataSource='all' 判断
  const tableShort = await makeOpts({ dataSource: { value: 'table' } })
  assert.equal(tableShort.needsSlotWarning(), true)
  // 人数够、槽位多 → 走「重复值日」那一支，仍要提示
  const repeat = await makeOpts({
    poolNames: { value: names(8) }, studentNames: { value: names(8) },
    dataSource: { value: 'table' }, tableFilled: { value: 6 },
  })
  assert.equal(repeat.shortageCount(), 0)
  assert.equal(repeat.needsSlotWarning(), true, '重复值日的提示不能被吞掉')
  // 全部同学且人数够 → 不需要任何确认
  const allOk = await makeOpts({ poolNames: { value: names(8) }, studentNames: { value: names(8) } })
  assert.equal(allOk.needsSlotWarning(), false)
})

test('文案 · 新提示带数字、旧提示仍在、X 取自单源', async () => {
  const vue = stripComments(fs.readFileSync(VUE, 'utf8'))
  const options = stripComments(fs.readFileSync(path.join(DIR, 'DutyArrangementDialog.options.js'), 'utf8'))
  assert.ok(vue.includes('值日位置不足，有 ${n} 人排不进值日表，确认继续吗？'),
    '确认框必须把 X 显示出来')
  assert.ok(vue.includes('部分同学会重复值日，确认继续吗？'),
    '「槽位多 → 重复值日」那一支必须保留')
  assert.ok(!vue.includes('您设置的值日人数小于学生人数'), '旧的无数字文案应被替换')
  assert.ok(vue.includes('ctx.shortageCount()'), '文案必须读单源，不能自己再算一遍')
  // minCount：定义 + 判据 + 文案，三处都要用同一个方法
  const uses = (options.match(/shortageCount\(\)/g) || []).length
  assert.ok(uses >= 2, `options 里 shortageCount 的调用点应 ≥2 处，实际 ${uses}`)
  assert.ok(options.includes('ctx.poolNames.value.length - ctx.totalSlots()'),
    '差额口径必须是参与人数与总槽位之差')
})
