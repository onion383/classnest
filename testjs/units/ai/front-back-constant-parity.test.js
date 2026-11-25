// =========================================================================
// front-back-constant-parity.test.js —— v8 §5-3 / Q4-01 缺口 ④⑥
//
// 行为测试，不是结构对账：后端把「可写表 / 设置项」key 通过提案下发给前端，
// 前端用真实行为函数把 key 翻译成中文名。若前端那份映射漏了后端下发的 key，
// 用户看到的提案预览会静默退回英文 key（Q3-01 的真实后果）。
//
// 这里不比对两份清单的键集，而是把后端实际的 key 逐个喂进前端真实函数
// tableLabel / frontProposalHint，断言结果是可读中文、不是原样英文 key。
// 常量仍是运行时真值：后端 require、前端函数 import()（type:module），零源码正则。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { abs } = require('#testjs/paths')
const { backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const loadMessages = () => import(pathToFileURL(abs('student-frontend/src/composables/ai/aiMessages.js')).href)

const be = backendRequire(abs('student-backend/routes/ai/ai.constants.js'))
const schema = backendRequire(abs('student-backend/routes/ai/ai.tools/tools.schema.js'))

test('④ 后端下发的每个可写表，提案预览显示后端给定的中文名', async () => {
  const { tableLabel } = await loadMessages()
  const writable = { ...be.WRITE_TABLES, ...be.JSON_WRITE_TABLES }
  assert.ok(Object.keys(writable).length >= 15, '后端可写表清单不应为空')
  for (const [table, expectedLabel] of Object.entries(writable)) {
    // 后端提案下发 { table, label }，前端 tableLabel 应还原出同一中文名。
    // 漏映射时 tableLabel 兜底返回英文 key，与后端 label 不等 → 行为失败。
    assert.equal(tableLabel(table), expectedLabel,
      `表 ${table} 的提案预览与后端下发标签「${expectedLabel}」不符——前端 LABELS 漏了该表`)
  }
})

test('④ widget_settings 提案预览显示「系统设置」（Q3-01 曾漏）', async () => {
  const { tableLabel } = await loadMessages()
  assert.equal(tableLabel('widget_settings'), be.JSON_WRITE_TABLES.widget_settings)
  assert.equal(tableLabel('widget_settings'), '系统设置')
})

test('⑥ 后端 FRONT_SETTINGS 白名单每项，设置提案说明都显示各自的中文名', async () => {
  const { frontProposalHint } = await loadMessages()
  const settingKeys = Object.keys(schema.FRONT_SETTINGS)
  assert.ok(settingKeys.length >= 8, '后端设置项白名单不应为空')
  for (const key of settingKeys) {
    const hint = frontProposalHint({ kind: 'front', key })
    // 后端白名每项自带 label（如 theme→'主题'）。提案说明必须展示这个具体中文名，
    // 不能只靠「将修改」三个字蒙混——缺映射时兜底文案也含中文，泛判据会假绿。
    const expected = schema.FRONT_SETTINGS[key].label
    assert.ok(hint.includes(expected),
      `设置项 ${key} 提案说明「${hint}」未显示中文名「${expected}」——前端 FRONT_LABELS 漏了该映射`)
    assert.ok(!hint.includes(`「${key}」`), `设置项 ${key} 的提案说明退回英文 key`)
  }
})

test('⑥ 未知设置项 key 仍能安全兜底为原文（不因缺映射崩溃）', async () => {
  const { frontProposalHint, tableLabel } = await loadMessages()
  assert.equal(frontProposalHint({ kind: 'front', key: 'unknown_key' }), '将修改「unknown_key」')
  assert.equal(tableLabel('unknown_table'), 'unknown_table')
})
