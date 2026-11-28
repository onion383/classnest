// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// resource-bounds.test.js —— v8 B-4（RC-RESOURCE-BOUND）资源上限/往返
//
// 覆盖：K03-09 首屏聚合下推、K04-07 访问时间线下推、K05-03/N3-10 解压闸、
//       F03-13 上下文裁剪、P3-02 排座 id 索引、P3-16 点名并行。
// 变异反证：去掉任一上限/下推，对应断言即红。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


test('K03-09：首屏学生/班费只取所需列与 SQL 聚合', () => {
  const route = read('student-backend/routes/dashboard.js')
  assert.match(route, /require\('\.\.\/services\/dashboardAgg'\)/)
  assert.match(route, /studentsLite\(\)/)
  assert.match(route, /feeSummary\(monthPrefix\)/)
  assert.ok(!/queryAll\('students'\)|queryAll\('fee_records'\)/.test(route), '不能再整表读 students/fees')
  const agg = read('student-backend/services/dashboardAgg.js')
  assert.match(agg, /SELECT id, 姓名 FROM students/)
  assert.match(agg, /SUM\(CASE WHEN TRIM\(收支类型\)/)
})

test('K04-07：访问时间写的过滤下推到 SQL，不整表读 undo_history', () => {
  const store = read('student-backend/services/undoStore.js')
  // @pin student-backend/services/undoStore.js#listForAccess
  assert.match(store, /function listForAccess\(source/)
  assert.match(store, /WHERE source = \? AND \(\? = '' OR ts >= \?\)/)
  const timeline = read('student-backend/services/accessTimeline.js')
  assert.match(timeline, /undoStore\.listForAccess\(want/)
  assert.ok(!/undoStore\.listAll\(\)/.test(timeline), '不能再 listAll 全表')
})

test('K05-03 / N3-10：两条解压路径都有条目数/体积闸', () => {
  const u = read('student-backend/services/unzipSafe.js')
  assert.match(u, /const MAX_ENTRIES = \d+/)
  assert.match(u, /const MAX_ENTRY_BYTES =/)
  assert.match(u, /const MAX_TOTAL_BYTES =/)
  assert.match(u, /entryCount > MAX_ENTRIES/)
  assert.match(u, /actual > MAX_ENTRY_BYTES/)
  const b = read('student-backend/services/backupArchive.js')
  assert.match(b, /MAX_ENTRIES/)
  assert.match(b, /entryBytes >|totalBytes >/)
})

test('F03-13：AI 历史消息有客户端条数/字符上限', () => {
  const src = read('student-frontend/src/composables/ai/aiChat.js')
  assert.match(src, /kept\.length >= 60/)
  assert.match(src, /historyChars \+ len > 30000/)
  assert.match(src, /for \(const m of kept\)/, '附件聚合也必须用裁剪后的消息')
})

test('P3-02：排座初始化先建 id 索引，不再逐格 find', () => {
  const pipe = read('student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.pipeline.js')
  assert.match(pipe, /const byId = new Map\(ctx\.students\.value\.map/)
  assert.match(pipe, /s = byId\.get\(val\) \|\| null/)
  const opts = read('student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.options.js')
  assert.ok(!/ctx\.students\.value\.find\(s => s\.id ===/.test(opts), '不能退回逐格 find')
  assert.match(opts, /byId\.get\(v\) \|\| null/)
})

test('P3-16：点名器并行取学生与请假记录', () => {
  const src = read('student-frontend/src/subwindows/widget/RollCall.vue')
  assert.match(src, /Promise\.all\(\[studentsReq, axios\.get\('\/api\/leaves'\)\]\)/)
})

test('V9-K01-05：首屏打点数的是已解析数组，不是函数引用', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../student-backend/routes/dashboard.js'), 'utf8')
  // @pin student-backend/routes/dashboard.js#dashboardSummary
  assert.doesNotMatch(src, /students \$\{n\(studentsLite\)\}/,
    'n(studentsLite) 数的是函数形参个数（恒 0），必须数已解析的 students')
  // @pin student-backend/routes/dashboard.js#dashboardSummary
  assert.match(src, /students \$\{n\(students\)\}/)
})
