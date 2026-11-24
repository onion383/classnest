// =========================================================================
// duty-cell-undo.test.js —— 值日表「按格撤销」
//
// 背景：值日表原来每次保存记一条**整块快照**，一次改三格就只能三条一起退
// （时间线回退是「回到某一刻」，中间那条跳不过去）。
// 改成逐格记录（duty_cell）之后：
//   ① 一格一条，同一批次共用 origin（Ctrl+Z / 退回到此仍是整批一步）；
//   ② 「只撤这一条」可以跳过它后面的记录，只把这一格写回原值；
//   ③ 但这一格后来又被改过时必须拒绝 —— 否则会把手改无声吞掉；
//   ④ 整块快照类型（doc_update / grid_snapshot）不给这个入口。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'duty-cell-undo', extraDbExports: { renumber: () => {} } })

test.before(async () => { await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js') })
test.after(() => fx.close())

// 库里存的是「按模式分键」的结构 { daily: {...}, big: {...} }（services/dutyMode）。
// 测试必须照真实形状写，否则会把「读打包结构取不到值」这类错误掩盖掉。
function readPacked() {
  return JSON.parse(fx.conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells || '{}')
}
function setCells(value, mode = 'daily') {
  const packed = readPacked()
  packed[mode] = value
  fx.conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'").run(JSON.stringify(packed))
}
function readCells(mode = 'daily') {
  return readPacked()[mode] || {}
}
function cell(item, day, index, mode = 'daily') {
  const v = readCells(mode)
  const arr = (v[item] && v[item][day]) || []
  return arr[index] == null ? '' : arr[index]
}

// 登记一条「甲→丙」的格记录，并把库改成「丙」（模拟那次保存已经写进去了）
async function pushCell({
  item = '扫地', day = '周一', index = 0, oldValue = '甲', newValue = '丙', origin = '', mode = 'daily',
} = {}) {
  const r = await fx.call('POST', '/', {
    key: '值日表',
    type: 'duty_cell',
    label: `${item}·${day}：「${oldValue}」→「${newValue}」`,
    payload: { table: 'duty_layout', mode, item, day, index, oldValue, newValue },
    origin,
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json.id
}

test('duty_cell：整批撤销与单条撤销都只动自己那一格', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲', '乙'] } })
  // 第一格：甲 → 丙
  const id1 = await pushCell({ index: 0, oldValue: '甲', newValue: '丙' })
  let cells = readCells()
  cells['扫地']['周一'][0] = '丙'
  setCells(cells)
  // 第二格：乙 → 丁
  const id2 = await pushCell({ index: 1, oldValue: '乙', newValue: '丁' })
  cells = readCells()
  cells['扫地']['周一'][1] = '丁'
  setCells(cells)

  assert.equal(cell('扫地', '周一', 0), '丙')
  assert.equal(cell('扫地', '周一', 1), '丁')

  // 只撤第二条（最新那条）：第一格不受影响
  const r = await fx.call('POST', `/${id2}/only`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(cell('扫地', '周一', 0), '丙', '不该动第一格')
  assert.equal(cell('扫地', '周一', 1), '乙', '第二格应退回原值')

  // 再撤第一条：两格都回到最初
  const r2 = await fx.call('POST', `/${id1}/only`)
  assert.equal(r2.status, 200, JSON.stringify(r2.json))
  assert.equal(cell('扫地', '周一', 0), '甲')
})

test('duty_cell：跳过最新那条直接退中间那条是允许的（格子互不影响）', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'], 周二: ['乙'] } })
  const idA = await pushCell({ day: '周一', index: 0, oldValue: '甲', newValue: '丙' })
  let cells = readCells()
  cells['扫地']['周一'][0] = '丙'
  setCells(cells)
  const idB = await pushCell({ day: '周二', index: 0, oldValue: '乙', newValue: '丁' })
  cells = readCells()
  cells['扫地']['周二'][0] = '丁'
  setCells(cells)

  // 退「较早」的那一条，后面的仍然生效
  const r = await fx.call('POST', `/${idA}/only`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(cell('扫地', '周一', 0), '甲', '中间那条应被单独退回')
  assert.equal(cell('扫地', '周二', 0), '丁', '后面那条必须保持生效')
})

test('duty_cell：这一格后来又被改过时拒绝（不吞掉后面的改动）', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'] } })
  const id = await pushCell({ index: 0, oldValue: '甲', newValue: '丙' })
  // 记录之后，这一格又被手改成「戊」
  setCells({ 扫地: { 周一: ['戊'] } })

  const r = await fx.call('POST', `/${id}/only`)
  assert.equal(r.status, 400)
  assert.match(r.json.error, /后来又被改过/)
  assert.equal(cell('扫地', '周一', 0), '戊', '拒绝时不能写库')
})

test('整块快照类型不给「只撤这一条」（会吞掉后面几条的改动）', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'] } })
  const r = await fx.call('POST', '/', {
    key: '值日表',
    type: 'grid_snapshot',
    label: '整块变更',
    payload: { table: 'duty_layout', oldValue: { 扫地: { 周一: ['甲'] } }, newValue: { 扫地: { 周一: ['丙'] } } },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))

  const only = await fx.call('POST', `/${r.json.id}/only`)
  assert.equal(only.status, 400)
  assert.match(only.json.error, /只能整步回退/)
})

test('同一批次的多条记录仍按「一步」计（origin 折叠的前提）', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲', '乙'] } })
  const origin = 'b-1700000000000-abc'
  const id1 = await pushCell({ index: 0, oldValue: '甲', newValue: '丙', origin })
  const id2 = await pushCell({ index: 1, oldValue: '乙', newValue: '丁', origin })

  const list = await fx.call('GET', '/')
  const group = list.json.groups.find((g) => g.key === '值日表')
  const mine = group.records.filter((r) => r.id === id1 || r.id === id2)
  assert.equal(mine.length, 2)
  assert.equal(mine[0].origin, mine[1].origin, '同批次必须共用 origin，前端才能折成一步')
})

// ---------------------------------------------------------------------------
// 界面接线：按钮必须分派到「只撤这一条」，不能一律走时间线回退（rewind）。
// 这条是纯源码判据 —— 后端的 /only 再好，按钮还接在 rewind 上，用户照样只能连带退。
// ---------------------------------------------------------------------------
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.resolve(__dirname, '../..')
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('源码判据：单格行的按钮只撤这一条，不再默认连带', () => {
  const vue = readSrc('student-frontend/src/views/SettingsView/SettingsView.vue')
  assert.match(vue, /@click="undoRow\(ent\)"/, '行按钮必须经 undoRow 分派')
  assert.match(vue, /undoActionLabel\(ent\)/, '按钮文案要跟着「能不能单独撤」变')
  assert.ok(!/@click="undoEntry\(ent\)"/.test(vue), '不能直接绑定 rewind（单格也会被连带）')

  const js = readSrc('student-frontend/src/views/SettingsView/SettingsView.data.js')
  const at = js.indexOf('undoRow(entry)')
  assert.ok(at > 0, '没找到 undoRow')
  const seg = js.slice(at, js.indexOf('undoActionLabel(entry)'))
  const atOnly = seg.indexOf('return ctx.undoMember(')
  const atStep = seg.indexOf('return ctx.undoOriginStep(')
  const atRewind = seg.indexOf('return ctx.undoEntry(')
  assert.ok(atOnly > 0, '单条可隔离时必须先走「只撤这一条」')
  assert.ok(atStep > atOnly, '批次要按 origin 整批退，且排在单条判断之后')
  assert.ok(atRewind > atStep, '只有整块快照才落到「连同之后一起退」，且必须是最后兜底')
  // 行类记录走 flip（带行快照比对），格子类走 /only（带单格当前值比对）
  assert.match(js, /member\.isolate === 'row' \? await undoById/, '行级单条撤销要走 /:id/undo')
})

// ---------------------------------------------------------------------------
// 模式隔离：cells 存的是 { daily, big }，撤销只能动记录所属的那一半。
// 漏了 mode 就解不出格子（currentValue=undefined）→ 每条都被判成「后来又被改过」，
// 更糟的是 apply 会把「扫地」写进打包结构顶层：撤销报成功、页面看不到。
// ---------------------------------------------------------------------------
test('duty_cell：只动记录所属模式，另一半原样不动', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'] } }, 'daily')
  setCells({ 扫地: { 周一: ['乙'] } }, 'big')

  const id = await pushCell({ mode: 'daily', oldValue: '甲', newValue: '丙' })
  const daily = readCells('daily')
  daily['扫地']['周一'][0] = '丙'
  setCells(daily, 'daily')

  const r = await fx.call('POST', `/${id}/only`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(cell('扫地', '周一', 0, 'daily'), '甲', 'daily 这一格要退回原值')
  assert.equal(cell('扫地', '周一', 0, 'big'), '乙', 'big 模式不该被碰')
  const packed = readPacked()
  assert.deepEqual(Object.keys(packed).sort(), ['big', 'daily'], '不许往打包结构顶层塞项目名')
})

test('duty_cell：老记录没带 mode 时按 daily 解包（不至于整批撤不动）', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'] } }, 'daily')
  const r = await fx.call('POST', '/', {
    key: '值日表',
    type: 'duty_cell',
    label: '扫地·周一：「甲」→「丙」',
    payload: { table: 'duty_layout', item: '扫地', day: '周一', index: 0, oldValue: '甲', newValue: '丙' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const daily = readCells('daily')
  daily['扫地']['周一'][0] = '丙'
  setCells(daily, 'daily')

  const only = await fx.call('POST', `/${r.json.id}/only`)
  assert.equal(only.status, 200, JSON.stringify(only.json))
  assert.equal(cell('扫地', '周一', 0, 'daily'), '甲')
})

// ---------------------------------------------------------------------------
// 来源判定：老师一次动作的批次是 op-…，不能被当成 AI 助手。
// 「非 32 位 hex 就算助手」的旧口径会把「一次改三格」整批染成 AI 色标。
// ---------------------------------------------------------------------------
test('来源判定：op- 批次是手改，ai-/子agent 才是助手，32 位 hex 是 MCP', async () => {
  fx.reset()
  const push = (origin) => fx.call('POST', '/', {
    key: '值日表', type: 'duty_cell', label: `x·${origin}`,
    // 项目/星期必须是设置里真实存在的，否则入库前的校验会拒绝（Q2-12）
    payload: { table: 'duty_layout', mode: 'daily', item: '扫地', day: '周一', index: 0, oldValue: '', newValue: '甲' },
    origin,
  })

  await push('op-1700000000000-abc123')
  await push('ai-1700000000001-def456')
  await push('子agent:座位助手-1700000000002-ghi789')
  await push('0123456789abcdef0123456789abcdef')

  const list = await fx.call('GET', '/')
  const recs = list.json.groups.find((g) => g.key === '值日表').records
  const byOrigin = (p) => recs.find((r) => String(r.label).includes(p))
  assert.equal(byOrigin('op-').source, 'manual', 'op- 批次必须是手改')
  assert.equal(byOrigin('ai-').source, 'ai_assistant')
  assert.equal(byOrigin('子agent').source, 'ai_assistant')
  assert.equal(byOrigin('0123456789abcdef').source, 'mcp')
})

// ---------------------------------------------------------------------------
// 失效是**现算**的，不是记录属性：数据被改走 → 标失效；改回去 → 自动恢复可用。
// 这也是它不能落库的原因。
// ---------------------------------------------------------------------------
async function staleOf(id) {
  // 失效与列表分开取：只算当前这张表，只回失效的 id
  const r = await fx.call('GET', `/stale?key=${encodeURIComponent('值日表')}`)
  return r.json.stale[id] || ''
}

test('失效现算：被外部改动就标失效，改回去就恢复可用', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'], 周二: ['乙'] } }, 'daily')

  const idA = await pushCell({ day: '周一', oldValue: '甲', newValue: '丙' })
  let d = readCells('daily'); d['扫地']['周一'][0] = '丙'; setCells(d, 'daily')
  const idB = await pushCell({ day: '周二', oldValue: '乙', newValue: '丁' })
  d = readCells('daily'); d['扫地']['周二'][0] = '丁'; setCells(d, 'daily')

  assert.equal(await staleOf(idA), '', 'A 刚写完，应当可用')
  assert.equal(await staleOf(idB), '', 'B 刚写完，应当可用')

  // 模拟「撤销栈之外的路径」改了周二那一格
  d = readCells('daily'); d['扫地']['周二'][0] = '外'; setCells(d, 'daily')
  assert.ok(await staleOf(idB), 'B 该标失效')
  assert.equal(await staleOf(idA), '', 'A 没被碰，仍可用（失效只针对被改过的那一格）')

  // 把外部改动撤掉 → B 立刻恢复可用
  d = readCells('daily'); d['扫地']['周二'][0] = '丁'; setCells(d, 'daily')
  assert.equal(await staleOf(idB), '', '状态回退后必须自动恢复可用')
})

// ---------------------------------------------------------------------------
// Ctrl+Z：撞上失效先提示，用户再按一次才跳过它去退更早的一步。
// ---------------------------------------------------------------------------
test('Ctrl+Z：第一次只报失效，带 skip 才跳过并退更早的那一步', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲'], 周二: ['乙'] } }, 'daily')
  const key = encodeURIComponent('值日表')

  await pushCell({ day: '周一', oldValue: '甲', newValue: '丙' })
  let d = readCells('daily'); d['扫地']['周一'][0] = '丙'; setCells(d, 'daily')
  const idB = await pushCell({ day: '周二', oldValue: '乙', newValue: '丁' })
  d = readCells('daily'); d['扫地']['周二'][0] = '丁'; setCells(d, 'daily')
  // 外部改动让最新那条（B）失效
  d = readCells('daily'); d['扫地']['周二'][0] = '外'; setCells(d, 'daily')

  const first = await fx.call('POST', `/table/${key}/undo`, {})
  assert.equal(first.json.ok, false)
  assert.equal(first.json.stale, true, '第一次必须只报告，不许直接跳')
  assert.equal(first.json.id, idB)
  assert.equal(cell('扫地', '周二', 0, 'daily'), '外', '报失效时不许动数据')

  const second = await fx.call('POST', `/table/${key}/undo`, { skipIds: [idB] })
  assert.equal(second.json.ok, true, JSON.stringify(second.json))
  assert.equal(cell('扫地', '周一', 0, 'daily'), '甲', '跳过 B 后应退掉更早的周一那条')
  assert.equal(cell('扫地', '周二', 0, 'daily'), '外', '被跳过的 B 保持原样')
})

test('Ctrl+Z：批次里有一条失效时整批都不退，并报出是哪一条', async () => {
  fx.reset()
  setCells({ 扫地: { 周一: ['甲', '乙'] } }, 'daily')
  const key = encodeURIComponent('值日表')
  const origin = 'op-1700000000000-batchx'

  const id1 = await pushCell({ index: 0, oldValue: '甲', newValue: '丙', origin })
  const id2 = await pushCell({ index: 1, oldValue: '乙', newValue: '丁', origin })
  const d = readCells('daily')
  d['扫地']['周一'][0] = '丙'
  d['扫地']['周一'][1] = '外' // 第二格被外部改动 → 整批失效
  setCells(d, 'daily')

  const r = await fx.call('POST', `/table/${key}/undo`, {})
  assert.equal(r.json.ok, false)
  assert.equal(r.json.stale, true)
  assert.equal(r.json.origin, origin, '要给出批次，前端才能整批跳过')
  assert.ok([id1, id2].includes(r.json.id))

  // 整批跳过 → 这一批一个都不动，且没有更早的记录可退
  const r2 = await fx.call('POST', `/table/${key}/undo`, { skipOrigins: [origin] })
  assert.equal(r2.json.ok, false)
  assert.equal(cell('扫地', '周一', 0, 'daily'), '丙', '跳过的批次不许被改')
})
