// V10-U02-01：本文件的源码串副本变异是**静态旁证**，不是真模块回放；真回放范式见 ai-read-scope-gate.test.js（loadMutated + 依赖 stub + 真调函数）。
// =========================================================================
// student-provisional-visibility.test.js —— 临时学生在「点名器 / AI 找人 / AI 聚合」里可见
//
// 背景：临时学生与正式学生共用 students 表，只靠 is_provisional 一位区分。
// 三处出口此前把它当普通人：点名器默认连临时学生一起抽；AI 找人返回的候选
// 看不出谁临时建档；AI 聚合统计人数时把临时学生算进正式名单。
// 本用例锁三件事：
//   ① 点名器默认 formal=1，只有设置开关打开才取全量（源码判据 + 变异反证）
//   ② AI 找人候选 / 检索命中带 is_provisional 与中文标记（真实执行器行为）
//   ③ AI 聚合在 students 表上给出「含临时学生、需 where 过滤」的口径提示（行为）
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')


const fx = createBackendDb({ label: 'student-provisional-visibility' })
const { isProvisional } = require('../../../student-backend/routes/ai/ai.tools/tools.executors/executors.common')
const { runResolveStudent, runSearchAll, runAggregate } = require('../../../student-backend/routes/ai/ai.tools/tools.executors/executors.query')

test.after(() => fx.close())

function seed() {
  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, is_provisional) VALUES (1, ?, ?, 0)').run('正式甲', 'S01')
    c.prepare('INSERT INTO students (id, 姓名, 学号, is_provisional) VALUES (2, ?, ?, 1)').run('临时乙', '')
  }})
}

// ---------------- ① 点名器默认过滤临时学生 ----------------

function rollCallOk(src) {
  const getAt = src.indexOf("axios.get(includeProvisional ? '/api/students'")
  const formalAt = src.indexOf("'/api/students?formal=1'")
  const flagAt = src.indexOf('rollcallIncludeProvisional')
  return flagAt > 0 && getAt > 0 && formalAt > getAt
    // 默认（开关读不到 / 关）走 formal=1
    && /const includeProvisional = !!settings\?\.data\?\.data\?\.rollcallIncludeProvisional/.test(src)
}

const QUERY_SRC = 'student-backend/routes/ai/ai.tools/tools.executors/executors.query.js'
// 找人标记判据：候选 / 检索命中 / 提示三处都要认得临时学生
function findMarkOk(src) {
  return /is_provisional: isProvisional\(r\) \? 1 : 0/.test(src)
    && /标记: isProvisional\(r\) \? '临时学生' : ''/.test(src)
    && /标记: isProvisional\(s\) \? '临时学生' : ''/.test(src)
    && /其中 \$\{provisionalTotal\} 名是「临时学生」/.test(src)
}
// 聚合提示判据：students 表要补口径说明，条件分支不能被删
function aggNoteOk(src) {
  const at = src.indexOf("if (table === 'students')")
  const block = at > 0 ? src.slice(at, at + 400) : ''
  return at > 0 && /含 is_provisional=1 的临时学生/.test(block) && /is_provisional:0/.test(block)
}

test('点名器：默认取正式学生名单，只有开关打开才取全量', () => {
  const src = read('student-frontend/src/subwindows/widget/RollCall.vue')
  assert.equal(rollCallOk(src), true)
})

test('设置链路：schema / 接口 / 设置页 / 清单对账四处都接了新开关', () => {
  const schema = read('student-backend/schema/schema.widget.js')
  assert.match(schema, /rollcall_include_provisional INTEGER NOT NULL DEFAULT 0/)

  const route = read('student-backend/routes/widgetSettings.js')
  assert.match(route, /rollcallIncludeProvisional:\s*!!settings\.rollcall_include_provisional/)
  const putAt = route.indexOf("router.put('/'")
  const put = route.slice(putAt)
  assert.match(put, /const \{[^}]*rollcallIncludeProvisional[^}]*\} = req\.body/)
  assert.match(put, /if \(rollcallIncludeProvisional !== undefined\)[\s\S]{0,160}rollcall_include_provisional = \?/)

  const view = read('student-frontend/src/views/SettingsView/SettingsView.vue')
  assert.match(view, /:model-value="rollcallIncludeProvisional"[\s\S]{0,220}@change="onRollcallIncludeProvisionalChange"/)
  assert.match(view, /const rollcallIncludeProvisional = ref\(false\)/)
  // Vapor：处理器必须在顶层解构与 ctx 袋里都出现，否则点了静默无反应。
  // 解构块可能跨多行，取 `} = ctx` 之前的 `const {` 段再断言，不用固定字数窗口。
  const ctxEnd = view.indexOf('} = ctx')
  const ctxOpen = ctxEnd > 0 ? view.lastIndexOf('const {', ctxEnd) : -1
  const destructure = ctxOpen > 0 ? view.slice(ctxOpen, ctxEnd) : ''
  assert.match(destructure, /onRollcallIncludeProvisionalChange/, '处理器漏解构，Vapor 下点了无反应')
  assert.match(view, /rollcallExcludeAbsent, rollcallIncludeProvisional, noteSavePath/)

  const app = read('student-frontend/src/views/SettingsView/SettingsView.appearance.js')
  assert.match(app, /ctx\.rollcallIncludeProvisional\.value = !!res\.data\.data\.rollcallIncludeProvisional/)
  assert.match(app, /rollcallIncludeProvisional: ctx\.rollcallIncludeProvisional\.value/)
  assert.match(app, /onRollcallIncludeProvisionalChange\(value\)[\s\S]{0,160}ctx\.saveWidgetSettings\(\)/)

  assert.match(read('student-backend/services/sanitize.js'), /rollcall_include_provisional: \{ kind: 'bool' \}/)
  assert.match(read('student-backend/routes/ai/ai.constants.js'), /rollcall_include_provisional 点名器是否包含临时学生/)
  assert.match(read('student-backend/routes/dataExport.js'), /点名器包含临时学生/)
})

// ---------------- ② AI 找人 / 检索给临时学生做标记 ----------------

test('isProvisional：0/1/数字字符串/布尔/空值口径一致', () => {
  assert.equal(isProvisional({ is_provisional: 1 }), true)
  assert.equal(isProvisional({ is_provisional: '1' }), true)
  assert.equal(isProvisional({ is_provisional: true }), true)
  assert.equal(isProvisional({ is_provisional: 0 }), false)
  assert.equal(isProvisional({ is_provisional: '0' }), false)
  assert.equal(isProvisional(null), false)
  assert.equal(isProvisional({}), false)
})

test('resolve_student：候选带 is_provisional 与中文标记，临时学生有单独提示', () => {
  assert.equal(findMarkOk(read(QUERY_SRC)), true, '找人标记源码判据未接上')
  seed()
  const r = runResolveStudent({ query: '临时乙' })
  assert.equal(r.ok, true)
  const hit = r.candidates.find((c) => c.姓名 === '临时乙')
  assert.ok(hit, '临时学生也要能被找到（不是过滤掉）')
  assert.equal(hit.is_provisional, 1)
  assert.equal(hit.标记, '临时学生')
  assert.match(r.note, /临时学生/)

  const formal = runResolveStudent({ query: '正式甲' })
  const f = formal.candidates.find((c) => c.姓名 === '正式甲')
  assert.equal(f.is_provisional, 0)
  assert.equal(f.标记, '')
  assert.doesNotMatch(formal.note, /其中 \d+ 名是「临时学生」/)
})

test('search_all：学生档案命中也带临时标记', () => {
  seed()
  const r = runSearchAll({ query: '临时乙', tables: 'students' })
  assert.equal(r.ok, true)
  const section = r.sections.find((s) => s.table === 'students')
  assert.ok(section)
  const hit = section.items.find((x) => x.姓名 === '临时乙')
  assert.equal(hit.is_provisional, 1)
  assert.equal(hit.标记, '临时学生')
})

// ---------------- ③ AI 聚合对临时学生的口径提示 ----------------

test('aggregate 查 students：结果提示含临时学生、正式统计要 where 过滤；其它表不带这句', () => {
  assert.equal(aggNoteOk(read(QUERY_SRC)), true, '聚合提示源码判据未接上')
  seed()
  const r = runAggregate({ table: 'students', metrics: [{ fn: 'count' }] })
  assert.equal(r.rows[0].count, 2, '聚合本身不改口径：临时学生仍在，只是提示')
  assert.match(r.note, /含 is_provisional=1 的临时学生/)
  assert.match(r.note, /is_provisional:0/)

  const other = runAggregate({ table: 'countdowns', metrics: [{ fn: 'count' }] })
  assert.doesNotMatch(other.note, /临时学生/)

  const official = runAggregate({ table: 'students', metrics: [{ fn: 'count' }], where: { is_provisional: 0 } })
  assert.equal(official.rows[0].count, 1, 'where 过滤真的能只算正式学生')
})

test('students 表描述告诉模型 is_provisional 的含义与过滤方法', () => {
  const src = read('student-backend/routes/ai/ai.constants.js')
  assert.match(src, /students: '[^']*is_provisional[^']*1=在值日\/座位里填名字自动建的临时学生[^']*where:\{is_provisional:0\}/)
})

// ---------------- 变异反证：判据必须能抓到改坏的版本 ----------------

test('反证：去掉默认 formal=1 / 找人标记 / 聚合提示，判据都要报红', () => {
  const rc = read('student-frontend/src/subwindows/widget/RollCall.vue')
  assert.equal(rollCallOk(rc.replace("'/api/students?formal=1'", "'/api/students'")), false,
    '去掉默认 formal=1 还能判绿 = 点名器仍会抽到临时学生')

  const q = read(QUERY_SRC)
  assert.equal(findMarkOk(q.replace(/标记: isProvisional\(r\) \? '临时学生' : '',/, '')), false,
    '删掉找人候选的中文标记还能判绿 = 模型看不出谁是临时学生')
  assert.equal(findMarkOk(q.replace(/其中 \$\{provisionalTotal\} 名是「临时学生」/, '')), false,
    '删掉临时学生提示还能判绿 = 提示判据失效')
  assert.equal(aggNoteOk(q.replace(/含 is_provisional=1 的临时学生/, '含其它数据')), false,
    '改坏聚合提示文案还能判绿 = 聚合判据失效')
  assert.equal(aggNoteOk(q.replace("if (table === 'students')", 'if (false)')), false,
    '把条件改成永假还能判绿 = 提示对所有表都发，判据失效')
  assert.equal(isProvisional({ is_provisional: 1 }), true) // 确认上面 replace 只作用于字符串，没改到运行函数
})
