// =========================================================================
// duty-enum-roundtrip.test.js —— v8 §5-4 / G11 值日枚举前后端一致性（行为测试）
//
// 用户后果：前端设置弹窗列出周期（一周/两周/一个月）与星期几，用户选完保存；
// 后端 normalizeConfig 用 CYCLES/WEEKDAYS.includes 校验，不认的值静默退回默认。
// 若两侧枚举漂移，界面能选、保存后却被改掉——用户看到「设了却没生效」。
//
// 判据是真库往返：把前端每个选项喂给后端 writeConfig → readConfig，断言原样取回。
// 不比对两份清单的键集（那是结构守卫，不是行为）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { abs } = require('#testjs/paths')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'duty-enum-roundtrip' })
const dutyConfig = require(abs('student-backend/services/dutyConfig'))

const loadFront = () => import(pathToFileURL(abs('student-frontend/src/utils/dutyColumns.js')).href)

test.after(() => fx.close())

test('G11 前端每个周期选项保存后原样取回（不被后端退回默认）', async () => {
  const { CYCLES } = await loadFront()
  assert.ok(CYCLES.length >= 3, '前端周期选项不应为空')
  for (const { value } of CYCLES) {
    fx.reset()
    dutyConfig.writeConfig('big', { cycle: value, weekday: '周三', groupType: 'big', groupCount: 3 })
    const got = dutyConfig.readConfig('big')
    assert.equal(got.cycle, value,
      `前端周期选项「${value}」保存后被后端退回「${got.cycle}」——后端 CYCLES 与前端不一致`)
  }
})

test('G11 前端每个星期选项保存后原样取回（不被后端退回默认）', async () => {
  const { WEEKDAYS } = await loadFront()
  assert.ok(WEEKDAYS.length >= 7, '前端星期选项不应为空')
  for (const weekday of WEEKDAYS) {
    fx.reset()
    dutyConfig.writeConfig('big', { cycle: 'week', weekday, groupType: 'big', groupCount: 3 })
    const got = dutyConfig.readConfig('big')
    assert.equal(got.weekday, weekday,
      `前端星期选项「${weekday}」保存后被后端退回「${got.weekday}」——后端 WEEKDAYS 与前端不一致`)
  }
})
