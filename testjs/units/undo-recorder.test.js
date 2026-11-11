// =========================================================================
// undo-recorder.test.js —— 撤销登记只能有一个入口，失败不能静默
//                          （Q2-10 / §4-7，也是 §4-6 的底座）
//
// 事故：三条内联通道各自 `.catch(() => {})`。业务操作已经落库，撤销栈里却没有
// 这一条，用户按 Ctrl+Z 才发现撤不回来。全库同时存在 6 种登记写法，新增写路径
// 天然继承缺口（RC-COVERAGE）—— 补 N 个调用点只会补出第 N+1 个漏网的。
//
// 判据分三层，缺一层就是假绿：
//   ① 行为：入口自己负责校验 / 失败弱提示 / 成功后刷可用态 / 批次不逐条刷；
//   ② 接线：所有旧通道真调统一入口，裸 pushUndo 与直发 /api/undo 全库清零；
//   ③ 防复发：消费文件里不允许再出现「登记失败空吞」的写法。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/undoRecorder.js')).href
const SRC = path.join(ROOT, 'student-frontend/src')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const load = () => import(MODULE)

// 剥注释：修复说明里会引用旧写法，判据不能被注释骗过
function code(rel) {
  return read(rel)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(js|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

const ENTRY = 'student-frontend/src/utils/undoRecorder.js'
const API = 'student-frontend/src/api/undo.js'
const USE_UNDO = 'student-frontend/src/composables/useUndo.js'
// 曾经各自写登记的 8 个消费方（含三条 Q2-10 点名的内联通道）
const CONSUMERS = [
  'student-frontend/src/composables/useTableCRUD.js',
  'student-frontend/src/views/GroupManageView.vue',
  'student-frontend/src/components/CadreManage.vue',
  'student-frontend/src/components/dialogs/AlbumManageDialog.vue',
  'student-frontend/src/components/dialogs/MoveAlbumDialog.vue',
  'student-frontend/src/components/dialogs/NewAlbumDialog.vue',
  'student-frontend/src/views/AlbumView.vue',
  'student-frontend/src/composables/ai/aiExec.js',
]

// 每个用例重设 hooks：ESM 模块在文件内是单例，不重设会串状态。
function setup(overrides = {}) {
  const calls = { sent: [], failures: [], registered: 0 }
  return {
    calls,
    hooks: {
      transport: overrides.transport || ((body) => {
        calls.sent.push(body)
        return Promise.resolve({ data: { id: 41 } })
      }),
      notifyFailure: (label, err) => calls.failures.push([label, err]),
      onRegistered: overrides.onRegistered || (() => { calls.registered++ }),
    },
  }
}

// —— ① 行为层 ——

test('合法登记：只把五个约定字段发给 transport，返回记录 id 并刷一次可用态', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const { calls, hooks } = setup()
  configureUndoRecorder(hooks)
  const id = await recordUndo({
    key: 'students', type: 'cell_update', label: '姓名', payload: { table: 'students', rowId: 1 },
    refresh: true, // 不属于传输契约，不该混进 body
  })
  assert.equal(id, 41)
  assert.deepEqual(calls.sent, [{
    key: 'students', type: 'cell_update', label: '姓名',
    payload: { table: 'students', rowId: 1 }, origin: '',
  }])
  assert.equal(calls.registered, 1)
  assert.equal(calls.failures.length, 0)
})

test('缺省刷新策略：无 origin 刷一次，批次不逐条刷（由调用方统一 flush）', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const { calls, hooks } = setup()
  configureUndoRecorder(hooks)
  await recordUndo({ key: 'k', type: 't', payload: {} })
  assert.equal(calls.registered, 1, '普通登记必须刷新')
  await recordUndo({ key: 'k', type: 't', payload: {}, origin: 'op-1' })
  assert.equal(calls.registered, 1, '带 origin 不能逐条刷 /status')
  await recordUndo({ key: 'k', type: 't', payload: {}, refresh: false })
  assert.equal(calls.registered, 1, '显式 refresh:false 也不能刷')
  await recordUndo({ key: 'k', type: 't', payload: {}, origin: 'op-2', refresh: true })
  assert.equal(calls.registered, 2, '显式 refresh:true 要压过批次缺省')
})

test('transport reject：返回 null、提示一次、不刷可用态，异常不抛回主流程', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const boom = new Error('backend down')
  const { calls, hooks } = setup({ transport: () => Promise.reject(boom) })
  configureUndoRecorder(hooks)
  const id = await recordUndo({ key: 'k', type: 't', label: '改姓名', payload: {} })
  assert.equal(id, null)
  assert.equal(calls.failures.length, 1)
  assert.equal(calls.failures[0][0], '改姓名')
  assert.equal(calls.failures[0][1], boom)
  assert.equal(calls.registered, 0)
})

test('transport 同步抛错也走同一套失败反馈（不是只防 Promise reject）', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const { calls, hooks } = setup({ transport: () => { throw new Error('sync') } })
  configureUndoRecorder(hooks)
  assert.equal(await recordUndo({ key: 'k', type: 't', label: 'L', payload: {} }), null)
  assert.equal(calls.failures.length, 1)
  assert.equal(calls.sent.length, 0)
})

test('非法 spec 不发请求，但一样要提示「本次无法撤销」', async () => {
  const { configureUndoRecorder, recordUndo, validateUndoSpec } = await load()
  const { calls, hooks } = setup()
  configureUndoRecorder(hooks)
  const bad = [
    null,
    {},
    { key: '', type: 't', payload: {} },
    { key: 'k', type: '', payload: {} },
    { key: 'k', type: 't' },
    { key: 'k', type: 't', payload: [] },
    { key: 'k', type: 't', payload: 'x' },
  ]
  for (const spec of bad) {
    assert.equal(await recordUndo(spec), null)
    assert.ok(validateUndoSpec(spec), 'validateUndoSpec 必须能拦住这一条')
  }
  assert.equal(calls.sent.length, 0, '不合法就不该写一条永远无法执行的撤销记录')
  assert.equal(calls.failures.length, bad.length)
  assert.equal(validateUndoSpec({ key: 'k', type: 't', payload: {} }), null)
})

test('onRegistered 自己炸了不能把「登记成功」伪装成失败', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const { calls, hooks } = setup({ onRegistered: () => { throw new Error('status probe') } })
  configureUndoRecorder(hooks)
  assert.equal(await recordUndo({ key: 'k', type: 't', payload: {} }), 41)
  assert.equal(calls.failures.length, 0)
})

test('transport 没回 id：仍算登记成功（刷状态），只是拿不到精确撤销入口', async () => {
  const { configureUndoRecorder, recordUndo } = await load()
  const { calls, hooks } = setup({ transport: () => Promise.resolve({}) })
  configureUndoRecorder(hooks)
  assert.equal(await recordUndo({ key: 'k', type: 't', payload: {} }), null)
  assert.equal(calls.failures.length, 0)
  assert.equal(calls.registered, 1)
})

test('rowSnapshot：优先取全表里的完整行，取不到才用提交数据兜底，且不改原对象', async () => {
  const { rowSnapshot } = await load()
  const full = { id: 7, 姓名: '张三', position: 3, is_provisional: 0 }
  const rows = [{ id: 6, 姓名: '李四' }, full]
  const snap = rowSnapshot(rows, 7, { 姓名: '张三' })
  assert.deepEqual(snap, full, '完整行必须带 position 等列，否则 redo 重建会缺列')
  assert.notEqual(snap, full, '不能把表里的行对象直接塞进撤销记录')
  assert.deepEqual(rowSnapshot(rows, 99, { 姓名: '王五' }), { 姓名: '王五', id: 99 })
  assert.deepEqual(rowSnapshot(null, 99, { 姓名: '王五' }), { 姓名: '王五', id: 99 })
})

test('批次标识格式稳定且两次不重复；装配缺 transport 直接抛错', async () => {
  const { newUndoBatchId, configureUndoRecorder } = await load()
  const ids = Array.from({ length: 30 }, () => newUndoBatchId())
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^op-\d+-[0-9a-z]{1,8}$/)
  assert.throws(() => configureUndoRecorder({}), TypeError)
  assert.throws(() => configureUndoRecorder(), TypeError)
})

// —— ② 接线：旧通道真的接到入口 ——

test('全库裸登记通道清零：除 API 层与入口自身，不许再直接 pushUndo / 直发 /api/undo', async () => {
  const bad = []
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    if (rel === ENTRY || rel === API) continue
    const s = code(rel)
    if (/\bpushUndo\(/.test(s)) bad.push(`${rel}: 裸 pushUndo`)
    if (/axios\.post\(\s*['"`]\/api\/undo['"`]/.test(s)) bad.push(`${rel}: 直发 /api/undo`)
  }
  assert.deepEqual(bad, [], '新通道会让失败反馈与刷新策略再次分叉')
})

test('8 个消费方都 import 统一入口并真的调用（不是只导入不用）', async () => {
  for (const rel of CONSUMERS) {
    const s = code(rel)
    assert.match(s, /from\s+['"][^'"]*undoRecorder\.js['"]/, `${rel} 没有 import 入口`)
    assert.match(s, /recordUndoSpec\(\s*\{/, `${rel} 没有调用入口`)
  }
})

test('三条 Q2-10 点名的内联通道不再空吞失败', async () => {
  const named = [
    'student-frontend/src/composables/useTableCRUD.js',
    'student-frontend/src/views/GroupManageView.vue',
    'student-frontend/src/components/CadreManage.vue',
  ]
  for (const rel of named) {
    assert.doesNotMatch(code(rel), /\.catch\(\(\)\s*=>\s*\{\}\)/, `${rel} 又把登记失败空吞了`)
  }
  // 其余登记文件整文件不许空吞。
  // AlbumView.vue 另有一处与撤销无关的 loadAlbums 刷新空吞，单独按登记块判，别把无关代码算进来。
  const rest = [...CONSUMERS.filter(f => !f.endsWith('AlbumView.vue')), USE_UNDO]
  for (const rel of rest) {
    assert.doesNotMatch(code(rel), /\.catch\(\(\)\s*=>\s*\{\}\)/, `${rel} 出现空吞`)
  }
  const av = code('student-frontend/src/views/AlbumView.vue')
  const at = av.indexOf("type: 'photo_trash'")
  assert.ok(at > 0, '删除照片的撤销登记消失')
  assert.doesNotMatch(av.slice(at - 200, at + 900), /\.catch\(/, '删除照片的登记失败不许再由调用方接管')
  // 失败反馈的实现只能住在入口：消费方不许再各自 warnUndoFailed
  for (const rel of CONSUMERS) {
    assert.doesNotMatch(code(rel), /warnUndoFailed\s*\(/, `${rel} 又自己写了失败提示`)
  }
})

test('useUndo.js 的五个语义封装都薄壳化到入口，并装配真实副作用', async () => {
  const s = code(USE_UNDO)
  assert.ok((s.match(/\brecordUndo\(\s*\{/g) || []).length >= 5, '五个封装都要走入口')
  assert.match(s, /configureUndoRecorder\(\s*\{/)
  assert.match(s, /transport:\s*pushUndo/, 'transport 必须走全局 axios / 安全通道')
  assert.match(s, /notifyFailure:\s*warnUndoFailed/)
  assert.match(s, /onRegistered:/)
  assert.match(s, /export\s*\{\s*warnUndoFailed,\s*newUndoBatchId\s*\}/, '对外 API 不能断')
  assert.doesNotMatch(s, /\.then\(\(\)\s*=>\s*refreshUndoStatus\(true\)\)/, '刷新策略不许留在封装里')
})

// —— ③ 防复发：入口的护栏不许被拆掉 ——

test('入口本身不许退化成静默：失败提示必须同时留日志与发通知', async () => {
  const s = code(ENTRY)
  assert.match(s, /export function warnUndoFailed/, '弱提示函数消失')
  assert.match(s, /console\.warn\(/, '只剩通知、没有日志也不行')
  assert.match(s, /useNotification\(\)\.warning\(/, '只剩日志、用户看不见也不行')
  assert.match(s, /h\.notifyFailure\(label, err\)/, 'reject 分支必须提示')
  assert.match(s, /h\.notifyFailure\(label, new Error\(invalid\)\)/, '非法 spec 分支必须提示')
  assert.match(s, /h\.onRegistered\(\)/, '成功必须刷可用态')
  assert.match(s, /if \(shouldRefresh\)/, '刷新必须受批次策略约束')
  assert.match(s, /spec\.refresh === undefined \? !body\.origin/, '缺省策略必须是「批次不逐条刷」')
  assert.match(s, /validateUndoSpec\(spec\)/, '入口必须先校验')
})

// —— ④ 底座的首个消费方：Q2-07 学生/班费弹窗（证明新写路径只写一行就有完整护栏）——

test('两个弹窗的增/改四个分支都登记行级 inverse，且用完整行快照', async () => {
  const cases = [
    { rel: 'student-frontend/src/views/ClassroomView.vue', key: 'students', refresh: 'await fetchStudents()' },
    { rel: 'student-frontend/src/views/FeeManagement.vue', key: 'fee_records', refresh: 'await fetchRecords()' },
  ]
  for (const c of cases) {
    const s = code(c.rel)
    assert.match(s, new RegExp(`recordRowUpdate\\('${c.key}',`), `${c.rel} 编辑分支没登记`)
    assert.match(s, new RegExp(`recordRowInsert\\('${c.key}',`), `${c.rel} 新增分支没登记`)
    assert.ok((s.match(/table\.rowSnapshotById\(/g) || []).length >= 2, `${c.rel} 必须两处都取完整行`)
    assert.match(s, /res\.data\.id/, `${c.rel} 新增必须拿回填 id`)
    // 刷新必须在登记之前：否则 rows 里还没有新行，快照只能靠猜
    assert.ok(s.indexOf(c.refresh) < s.indexOf('table.rowSnapshotById('), `${c.rel} 登记早于刷新，拿不到完整行`)
    assert.match(s, /const oldRow = \{ \.\.\.editingRow\.value \}/, `${c.rel} 编辑前必须留旧行快照`)
  }
  const crud = code('student-frontend/src/composables/useTableCRUD.js')
  assert.match(crud, /rowSnapshot\(rows\.value, id, fallback\)/, '共享层没有把纯函数接到当前表快照')
  assert.match(crud, /rowSnapshotById,?\s*\n?\s*\}/, '共享层没有导出给页面')
})

test('后端仍按命令类型白名单校验：统一入口不绕过服务端约束', async () => {
  const s = code('student-backend/routes/undo/undo.js')
  assert.match(s, /if \(!\(type in executors\)\)/, '后端不能因为前端收口就去掉类型校验')
})
