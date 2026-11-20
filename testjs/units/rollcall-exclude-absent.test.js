// =========================================================================
// rollcall-exclude-absent.test.js —— 「点名排除没有在校的同学」开关全链路
// 运行：npm run test:units
//
// 为什么不能只测过滤函数：这个开关跨了「库列 → 后端接口 → 设置页 → 工具箱浮窗」
// 四层，任何一层漏接都是静默失效（界面上开关能点，点名器照旧全员抽）。
// 所以除行为用例外，还把每一层的接线写成接收源码文本的纯函数，并做变异反证：
// 把关键片段改坏，判据必须报红，否则判据本身就是假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const loadLeaveState = () => import(pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/leaveState.js')).href)

const SCHEMA = 'student-backend/schema/schema.widget.js'
const ROUTE = 'student-backend/routes/widgetSettings.js'
const VIEW = 'student-frontend/src/views/SettingsView/SettingsView.vue'
const APPEARANCE = 'student-frontend/src/views/SettingsView/SettingsView.appearance.js'
const ROLLCALL = 'student-frontend/src/subwindows/widget/RollCall.vue'

const DAY = '2026-11-15'
const leave = (o) => ({ 状态: '请假中', ...o })
const stu = (id, 姓名) => ({ id, 姓名, 学号: `S${id}` })

// ---------------- 行为：候选名单过滤（口径复用 leavesOn） ----------------

test('今天在假的学生被排除：改名后仍按 student_id 命中，只剩在校的人可点', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(1, '张三'), stu(2, '李四'), stu(3, '王五')]
  const leaves = [
    // 请假行里的姓名是旧名，靠 student_id 才能排掉改名后的学生
    leave({ student_id: 1, 姓名: '张小三', 开始时间: DAY, 结束时间: DAY }),
    // 跨天假，今天落在中间
    leave({ student_id: 3, 姓名: '王五', 开始时间: '2026-11-14', 结束时间: '2026-11-17' }),
  ]
  const { list, excludedCount } = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(list.map((s) => s.id), [2])
  assert.equal(excludedCount, 2)
})

test('只有姓名的历史请假行按 trim 后的规范名排除（不做模糊匹配）', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(1, '张三'), stu(2, '张三丰')]
  const leaves = [leave({ student_id: null, 姓名: '  张三  ', 开始时间: DAY, 结束时间: DAY })]
  const { list, excludedCount } = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(list.map((s) => s.id), [2], '名字相似但不同的同学不能被误排除')
  assert.equal(excludedCount, 1)
})

test('不在今天覆盖范围内的假不排除：未开始 / 已过期 / 已返校 / 已取消 / 无开始时间', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(1, '甲'), stu(2, '乙'), stu(3, '丙'), stu(4, '丁'), stu(5, '戊'), stu(6, '己')]
  const leaves = [
    leave({ student_id: 1, 姓名: '甲', 开始时间: '2026-11-16', 结束时间: '2026-11-18' }),
    leave({ student_id: 2, 姓名: '乙', 开始时间: '2026-11-01', 结束时间: '2026-11-02' }),
    leave({ student_id: 3, 姓名: '丙', 状态: '已返校', 开始时间: DAY, 结束时间: DAY }),
    leave({ student_id: 4, 姓名: '丁', 状态: '已取消', 开始时间: DAY, 结束时间: DAY }),
    leave({ student_id: 5, 姓名: '戊', 开始时间: '', 结束时间: '2026-11-20' }),
    leave({ student_id: 6, 姓名: '己', 开始时间: DAY, 结束时间: DAY }),
  ]
  const { list, excludedCount } = filterPresentStudents(students, leaves, DAY)
  assert.deepEqual(list.map((s) => s.id), [1, 2, 3, 4, 5])
  assert.equal(excludedCount, 1, '只有真正覆盖今天的「请假中」算不在校')
})

test('全员不在校 → 名单为空且人数如实回报；空名单/脏数据不炸', async () => {
  const { filterPresentStudents } = await loadLeaveState()
  const students = [stu(1, '张三'), stu(2, '李四')]
  const { list, excludedCount } = filterPresentStudents(students, [
    leave({ student_id: 1, 姓名: '张三', 开始时间: DAY }),
    leave({ student_id: 2, 姓名: '李四', 开始时间: DAY }),
  ], DAY)
  assert.deepEqual(list, [])
  assert.equal(excludedCount, 2)
  assert.deepEqual(filterPresentStudents(null, null, DAY), { list: [], excludedCount: 0 })
  assert.deepEqual(filterPresentStudents('not-an-array', 'not-an-array', DAY), { list: [], excludedCount: 0 })
})

// ---------------- 接线判据（纯函数，供变异反证喂假源码） ----------------

function schemaOk(src) {
  return /rollcall_exclude_absent INTEGER NOT NULL DEFAULT 0/.test(src)
}

function routeOk(src) {
  const hasGet = /rollcallExcludeAbsent:\s*!!settings\.rollcall_exclude_absent/.test(src)
  const putAt = src.indexOf("router.put('/'")
  const put = putAt >= 0 ? src.slice(putAt) : ''
  const hasPut = /const \{[^}]*rollcallExcludeAbsent[^}]*\} = req\.body/.test(put)
    && /if \(rollcallExcludeAbsent !== undefined\)[\s\S]{0,200}rollcall_exclude_absent = \?/.test(put)
  return hasGet && hasPut
}

function viewOk(src) {
  // 模板绑定是受控开关；方法必须在 `const { ... } = ctx` 解构里，否则 Vapor 下点了静默无反应
  const bound = /:model-value="rollcallExcludeAbsent"[\s\S]{0,260}@change="onRollcallExcludeAbsentChange"/.test(src)
  const hit = src.indexOf('} = ctx')
  const open = hit > 0 ? src.lastIndexOf('const {', hit) : -1
  const visible = hit > 0 && open > 0
    ? new Set(src.slice(open, hit).match(/[A-Za-z_$][\w$]*/g) || []).has('onRollcallExcludeAbsentChange')
    : false
  const ctxStart = src.indexOf('const ctx = {')
  const ctxEnd = src.indexOf('// 迟绑定', ctxStart)
  const inCtx = ctxStart > 0 && ctxEnd > ctxStart
    && /\brollcallExcludeAbsent\b/.test(src.slice(ctxStart, ctxEnd))
  return bound && visible && inCtx && /const rollcallExcludeAbsent = ref\(false\)/.test(src)
}

function appearanceOk(src) {
  return /ctx\.rollcallExcludeAbsent\.value = !!res\.data\.data\.rollcallExcludeAbsent/.test(src)
    && /rollcallExcludeAbsent: ctx\.rollcallExcludeAbsent\.value/.test(src)
    && /onRollcallExcludeAbsentChange\(value\)[\s\S]{0,320}ctx\.saveWidgetSettings\(\)/.test(src)
}

function rollCallOk(src) {
  const filterAt = src.indexOf('filterPresentStudents(all')
  if (filterAt < 0) return false
  const before = src.slice(0, filterAt)
  // 开关门必须在过滤之前；请假数据取不到时不能静默退回全员名单
  return /axios\.get\('\/api\/widget-settings'\)/.test(before)
    // 必须是完整的「开关关 → 直接返回全员」门，不能只在注释里出现开关名
    && /if \(!settings\?\.data\?\.data\?\.rollcallExcludeAbsent\) return \{ list: all, excludedCount: 0 \}/.test(before)
    && /axios\.get\('\/api\/leaves'\)/.test(before)
    && /throw new Error\('无法获取请假记录/.test(src)
    && /excludedCount\.value = result\.excludedCount/.test(src)
    && /excludedCount/.test(src.slice(0, src.indexOf('<script setup')))
}

test('库列：新建库即带该列，默认 0', () => {
  assert.equal(schemaOk(read(SCHEMA)), true, 'schema.widget.js 缺新列或补列逻辑')
})

test('接口：GET 下发开关、PUT 以补丁式写入（未传时不动其它设置）', () => {
  assert.equal(routeOk(read(ROUTE)), true, 'widgetSettings.js 的 GET/PUT 没接上开关')
})

test('设置页：模板绑定 + ctx 袋 + 解构三处齐全（防 Vapor 静默失效）', () => {
  assert.equal(viewOk(read(VIEW)), true, '新开关的模板绑定或 ctx 解构漏了')
})

test('设置页逻辑：加载回显 / 保存携带 / 切换处理器三处齐全', () => {
  assert.equal(appearanceOk(read(APPEARANCE)), true, 'appearance.js 的读写或处理器漏了')
})

test('点名器：按开关取请假记录并过滤，失败不静默降级，排除人数可见', () => {
  assert.equal(rollCallOk(read(ROLLCALL)), true, 'RollCall.vue 没有真正按开关过滤')
})

test('清单对账：sanitize / AI 表描述 / 数据导出都认得新列', () => {
  assert.match(read('student-backend/services/sanitize.js'), /rollcall_exclude_absent: \{ kind: 'bool' \}/)
  assert.match(read('student-backend/routes/ai/ai.constants.js'), /rollcall_exclude_absent 点名器是否排除/)
  assert.match(read('student-backend/routes/dataExport.js'), /点名器排除不在校同学/)
})

// ---------------- 变异反证：判据必须能抓到改坏的版本 ----------------

test('反证：漏掉建库列 / 补丁式守卫 / ctx 解构 / 开关门，判据都要报红', () => {
  const schema = read(SCHEMA)
  assert.equal(schemaOk(schema.replace(/rollcall_exclude_absent INTEGER NOT NULL DEFAULT 0/, '')), false,
    'CREATE 里删了该列还判绿 = schema 判据失效')

  const route = read(ROUTE)
  assert.equal(routeOk(route.replace('if (rollcallExcludeAbsent !== undefined)', 'if (rollcallExcludeAbsent)')), false,
    '把补丁守卫改成真值判断（false 时写不进库）还能判绿 = 接口判据失效')
  assert.equal(routeOk(route.replace(/rollcallExcludeAbsent:\s*!!settings\.rollcall_exclude_absent/, '')), false,
    'GET 不下发开关还能判绿 = 接口判据失效')

  const view = read(VIEW)
  // 从解构块里摘掉这个方法名（不依赖解构行的相邻顺序，重排也不会让反证假红）
  const hit = view.indexOf('} = ctx')
  const open = view.lastIndexOf('const {', hit)
  const noBinding = view.slice(0, open) + view.slice(open, hit).replace('onRollcallExcludeAbsentChange', '') + view.slice(hit)
  assert.equal(viewOk(noBinding), false,
    '漏解构还能判绿 = 静默失效抓不到')
  assert.equal(viewOk(view.replace('@change="onRollcallExcludeAbsentChange"', '@change="onToolboxChange"')), false,
    '开关接到别的处理器还能判绿 = 模板判据失效')

  const appearance = read(APPEARANCE)
  assert.equal(appearanceOk(appearance.replace('rollcallExcludeAbsent: ctx.rollcallExcludeAbsent.value,', '')), false,
    '保存时不带新字段还能判绿 = 回显会永远回滚')

  const rollcall = read(ROLLCALL)
  assert.equal(rollCallOk(rollcall.replace("if (!settings?.data?.data?.rollcallExcludeAbsent) return { list: all, excludedCount: 0 }", '')), false,
    '去掉开关门还能判绿 = 开关根本不生效')
  assert.equal(rollCallOk(rollcall.replace("throw new Error('无法获取请假记录，为避免点到不在校的同学，本次点名已取消')", '')), false,
    '请假接口失败静默降级还能判绿 = 会点到不在校的同学')
})
