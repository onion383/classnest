// =========================================================================
// undo.records.js —— 撤销系统·记录与回退
// （原 routes/undo.js 按职责拆分而来，纯代码搬运，行为不变）
//   撤销记录的入库/读取、单条 undo/redo（flip）、AI 批次回退
// =========================================================================

const undoStore = require('../../services/undoStore')
const { executors } = require('./undo.executors')
const { publicToolError } = require('../../utils/publicToolError')
const expected = require('./undo.expected')
const { safeJson } = require('../../utils/json')

// parse payload 安全包裹
function getRecord(id) {
  const rec = undoStore.findById(id)
  if (!rec) return null
  // 用 safeJson 而不是裸 JSON.parse：注释写着「安全包裹」但实现是裸解析，
  // 一条畸形 payload 会让整条 getRecord 抛 → 撤销面板 500（列表都打不开，
  // 用户连别的记录都没法撤）。payload 解析不了就当空 payload：
  // 执行器按「没有可回退的内容」处理，比整个面板打不开好。
  rec.payload = safeJson(rec.payload, {}, 'undo_history.payload')
  return rec
}

// 新增一条可撤销记录（undo侧）
// origin：来源标记。空=老师手动编辑；非空=AI 助手一次更改的批次标识（同批次整批回退）
// 清空全部 redo + 插入 + 每 key 淘汰最旧，三步同事务（undoStore.push）。
// 只清本 key 会在跨 key 批次里留下「另一半还能重做」的残尾：用户去另一张表按重做，
// 数据就变成半新半旧 —— 时间线分叉后所有重做都该失效。
function pushRecord(key, type, label, payload, origin) {
  return undoStore.push({ key, type, label, payload, origin: origin || '' })
}

// 执行 undo/redo 并切换 dir（执行器可能含异步文件操作，故为 async）
async function flip(id, fromDir, toDir, mode) {
  const rec = getRecord(id)
  if (!rec) return { error: '记录不存在' }
  if (rec.dir !== fromDir) return { error: mode === 'undo' ? '该条已无可撤销' : '该条已无可重做' }
  const ex = executors[rec.type]
  if (!ex) return { error: `不支持的记录类型: ${rec.type}` }
  const validation = ex.validate ? ex.validate(rec.payload) : null
  if (validation) return { error: validation }
  // expected 快照校验：当前行必须仍是这条记录写入后留下的样子，否则拒绝——
  // 跳过中间记录撤旧记录会盲写覆盖手改（A 新增→B 改名→手改→C 再改，直接撤 B 吞手改）。
  // 放在抢占方向之前：失败不翻 dir、不执行补偿，记录仍可原样重试。
  // 用 expected.checkExpected 而非解构，便于测试替换实现做变异反证。
  const expectedErr = expected.checkExpected(rec, mode)
  if (expectedErr) return { error: expectedErr }
  // 先 CAS 抢占方向，再执行副作用：原先「执行成功后才切 dir」在 UPDATE 失败时会允许同向重放。
  // 执行失败则把 dir 改回去，记录仍可重试；极端崩溃只会少一次可撤销，不会重复执行。
  const claim = undoStore.claimDir(id, toDir, fromDir)
  if (claim.changes !== 1) {
    return { error: mode === 'undo' ? '该条已无可撤销' : '该条已无可重做' }
  }
  try {
    await ex[mode](rec.payload)
  } catch (err) {
    try {
      undoStore.releaseDir(id, fromDir, toDir)
    } catch (rollbackErr) {
      // 回滚失败只可能是库不可写；保留日志，至少不要掩盖原始执行错误
      console.error('[undo] 执行失败后回滚 dir 失败:', rollbackErr.message)
    }
    throw err
  }
  // 展示文案按当前操作方向生成，而非存库的方向
  const label = ex.describe ? ex.describe(rec.payload, mode) : rec.label
  // 结构化变更结果（供前端本地增量应用）；生成失败一律兜底为全量重载，绝不影响撤销本身
  let change
  try {
    change = ex.change ? ex.change(rec.payload, mode) : { type: 'full_reload' }
  } catch {
    change = { type: 'full_reload' }
  }
  return { ok: true, label, change }
}

// ========== 批量补偿的统一内核 ==========
// 所有批量入口（全局 rewind、origin 批次、AI 工具）共用这一套补偿语义，
// 避免「有的入口原子、有的裸循环」的两套行为。
//
// 原子性用 SAVEPOINT 而非 db.transaction()：后者是同步包装器，执行器一旦 await
// 就会把事务边界撕开。SAVEPOINT 是连接级状态，能跨 await 保持开启。
// 但它是**连接级**的：两个并发批次的 SAVEPOINT 会互相嵌套，ROLLBACK TO 会滚掉
// 对方的写。所以统一在这里用 Promise 链把调用串行化（单连接本来也只能串行写）。
let rewindTail = Promise.resolve()

// records：已按执行顺序排好的完整记录对象（undo 逆序 / redo 正序）。
// 预检（只读，不开事务）：拒绝未知类型与异步文件类型、提前跑 validate。
// expected 校验故意不在这里做：链式记录只有前一条撤完后，当前状态才等于下一条的
// newRow（A 新增→B 改名→手改→C 再改，撤 C 后才是手改的 newRow）。它必须在 flip
// 里逐条查，按序执行时自然满足。
function prepareBatch(records) {
  const prepared = []
  for (const rec of records) {
    const ex = executors[rec.type]
    if (!ex) return { error: `不支持的记录类型: ${rec.type}` }
    if (ex.undo?.constructor.name === 'AsyncFunction' || ex.redo?.constructor.name === 'AsyncFunction') {
      return { error: `「${rec.label || rec.type}」包含文件操作，无法整批回退，请逐条撤销` }
    }
    const v = ex.validate ? ex.validate(rec.payload) : null
    if (v) return { error: v }
    prepared.push(rec)
  }
  return { prepared }
}

// 串行 + 原子执行。fromDir/toDir 由调用方按 mode 给定。
function runAtomicBatch(records, mode, fromDir, toDir) {
  const run = rewindTail.then(() => runAtomicBatchImpl(records, mode, fromDir, toDir))
  // 失败不能让锁链断掉，否则后续回退永远排队
  rewindTail = run.then(() => {}, () => {})
  return run
}

async function runAtomicBatchImpl(records, mode, fromDir, toDir) {
  const pre = prepareBatch(records)
  if (pre.error) return { ok: false, error: pre.error }

  const sp = undoStore.beginRewind()
  const labels = []
  try {
    for (const rec of pre.prepared) {
      const res = await flip(rec.id, fromDir, toDir, mode)
      if (res.error) throw new Error(res.error)
      if (res.label) labels.push(res.label)
    }
    undoStore.commitRewind(sp)
  } catch (err) {
    try {
      undoStore.rollbackRewind(sp)
    } catch (rbErr) {
      console.error('[undo] 批量回退回滚失败:', rbErr.message)
    }
    return { ok: false, error: publicToolError(err.message), count: labels.length, labels }
  }
  return { ok: true, count: labels.length, labels }
}

// ========== 回退到指定记录之前（全局时间线，跨表 / 跨来源） ==========
// 语义：选中时间线上第 R 条 → 撤销 R 及之后所有 dir=1 记录，逆序执行；
// 重做对称：重做 R 及之前所有 dir=0 记录，正序执行。表格只是视图筛选，不是回退边界。
function rewindTo(targetId, mode = 'undo') {
  const fromDir = mode === 'undo' ? 1 : 0
  const toDir = mode === 'undo' ? 0 : 1
  const target = getRecord(targetId)
  if (!target) return Promise.resolve({ ok: false, error: '记录不存在' })
  if (target.dir !== fromDir) {
    return Promise.resolve({ ok: false, error: mode === 'undo' ? '该条已无可撤销' : '该条已无可重做' })
  }
  // undo 逆序（>= R，后做的先退）；redo 正序（<= R，先做的先回）
  const rows = undoStore.idsFromBoundary(
    targetId, fromDir,
    mode === 'undo' ? '>=' : '<=',
    mode === 'undo' ? 'DESC' : 'ASC'
  )
  if (!rows.length) return Promise.resolve({ ok: true, count: 0, labels: [] })
  // 只读选行在锁外，真正改写的 SAVEPOINT 段由 runAtomicBatch 串行化。
  // 并发下第二个 rewind 选到相同 rows 也无妨：执行到已翻 dir 的记录会被 flip 拒绝并整批回滚。
  return runAtomicBatch(rows.map((r) => getRecord(r.id)), mode, fromDir, toDir)
}

// 回退某一批次（origin 相同）的全部记录。origin 为 AI 一次更改的批次标识。
// 与全局 rewind 共用同一原子内核，差别只在「选哪些记录」——这里选同 origin 的。
async function undoOriginBatch(origin) {
  const rows = undoStore.idsByOrigin(origin, 1, 'DESC')
  if (!rows.length) return { ok: true, count: 0, labels: [] }
  return runAtomicBatch(rows.map((r) => getRecord(r.id)), 'undo', 1, 0)
}

// 重做某一批次的全部记录（origin 相同、当前在 redo 侧）。
// 顺序与 undoOriginBatch 相反：撤销是逆序退（后做的先退），重做必须正序上（先做的先回）。
async function redoOriginBatch(origin) {
  const rows = undoStore.idsByOrigin(origin, 0, 'ASC')
  if (!rows.length) return { ok: true, count: 0, labels: [] }
  return runAtomicBatch(rows.map((r) => getRecord(r.id)), 'redo', 0, 1)
}

// 撤销「AI 助手」此前做出的最近一次数据更改（同一批次整批回退）。
//   key 可选：限定只撤销该资源（表名 / 分组名）上的最近一次 AI 更改。
//   只处理 origin 非空的记录，不会误撤销老师手动编辑产生的撤销记录。
//   返回 { ok, count, labels } 或 { ok:false, error }。供 AI 工具 undo_change 复用。
async function undoAiChange(key) {
  const last = undoStore.latestAiOrigin(key)
  if (!last) {
    return { ok: false, error: key ? `没有可撤销的、你此前对「${key}」做出的更改` : '你此前没有可撤销的更改' }
  }
  return undoOriginBatch(last.origin)
}

// 列出 AI 助手此前的可撤销更改，按「批次」分组（同一 origin 为一次更改），最新在前。
//   step 从 1 起：1 = 最近一次更改。返回 [{ step, label, count, keys, ts, id, origin }]。
//   供 AI 工具 list_changes 复用，让模型看到撤销栈（不再是盲退）。
function listAiChanges(limit) {
  const rows = undoStore.listAiRows()
  const batches = []
  const map = new Map()
  for (const r of rows) {
    let b = map.get(r.origin)
    if (!b) { b = { origin: r.origin, labels: [], keys: [], ids: [], ts: r.ts }; map.set(r.origin, b); batches.push(b) }
    b.labels.push(r.label || '')
    if (!b.keys.includes(r.key)) b.keys.push(r.key)
    b.ids.push(r.id)
  }
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 30)
  return batches.slice(0, lim).map((b, i) => ({
    step: i + 1,
    label: b.labels.filter(Boolean).join('；') || '（无描述）',
    count: b.labels.length,
    keys: b.keys,
    ts: b.ts,
    id: Math.max(...b.ids),
    origin: b.origin,
  }))
}

// 回退最近 N 批 AI 更改（最新在前逐批回退）：steps=1 即只回退最近一次更改。
//   返回 { ok, count, labels, batches } 或 { ok:false, error }。供 AI 工具 undo_change（steps）复用。
async function undoAiChanges(steps) {
  const n = Math.min(Math.max(Number(steps) || 1, 1), 20)
  const batches = listAiChanges(n)
  if (!batches.length) return { ok: false, error: '你此前没有可撤销的更改' }
  const labels = []
  let undone = 0
  for (const b of batches) {
    const res = await undoOriginBatch(b.origin)
    if (res.error) return { ok: false, error: res.error, count: labels.length, labels }
    labels.push(...res.labels)
    undone++
  }
  return { ok: true, count: labels.length, labels, batches: undone }
}

// ========== 只撤「这一条」（格子级） ==========
// 时间线回退是「回到某一刻」，做不了「跳过最新的、只退中间那一条」。而值日/座位这类
// 单格记录本身只写一格，单独退是安全的 —— 前提是**这一格后来没被再改过**，
// 否则会把后面的改动无声吞掉。所以：
//   · 只认带 currentValue 的执行器（格子级），整块快照类型一律拒绝；
//   · 当前值必须仍等于这条记录写入的值，否则提示从最新一条开始退。
// 执行仍走 flip：沿用同一套 validate / CAS 抢占 / 失败回滚。
const norm = (v) => (v == null ? '' : String(v))

async function undoCellOnly(id) {
  const rec = getRecord(id)
  if (!rec) return { error: '记录不存在' }
  if (rec.dir !== 1) return { error: '该条已无可撤销' }
  const ex = executors[rec.type]
  if (!ex) return { error: `不支持的记录类型: ${rec.type}` }
  if (typeof ex.currentValue !== 'function') {
    return { error: '这类改动只能整步回退，不能只退其中一条' }
  }
  const v = ex.validate ? ex.validate(rec.payload) : null
  if (v) return { error: v }
  let cur
  try { cur = ex.currentValue(rec.payload) } catch (_) { cur = undefined }
  if (norm(cur) !== norm(rec.payload.newValue)) {
    return { error: '这一格后来又被改过，请从最新的一条开始退' }
  }
  return flip(id, 1, 0, 'undo')
}

// 这条记录「现在还撤得动吗」。只读，不改任何状态：'' = 可用，否则是失效原因。
// 必须现算，不能存库 —— 数据被别的路径改回去之后（比如把那次备份恢复撤了），
// 同一条记录会重新变回可用，存下来的标记会立刻过期。
// 判定口径与真正执行前的校验同一套（行级 expected 快照 / 格子级 currentValue），
// 所以这里说「可用」的记录，点下去不会因为冲突被拒。
function staleReason(rec) {
  if (!rec || rec.dir !== 1) return ''
  const ex = executors[rec.type]
  if (!ex) return ''
  const p = rec.payload || {}
  // 判定失败（表被删、payload 畸形）一律当「没失效」：这里只是面板打标/快捷提示，
  // 不能因为一条坏记录把整个撤销列表 500 掉。
  let rowErr = ''
  try { rowErr = expected.checkExpected(rec, 'undo') || '' } catch { rowErr = '' }
  if (rowErr) return rowErr
  if (typeof ex.currentValue === 'function') {
    let cur
    try { cur = ex.currentValue(p) } catch { return '' }
    return norm(cur) === norm(p.newValue) ? '' : '这一条写入的值已经被改动'
  }
  return ''
}

module.exports = {
  getRecord,
  pushRecord,
  flip,
  rewindTo,
  undoCellOnly,
  staleReason,
  undoOriginBatch,
  redoOriginBatch,
  undoAiChange,
  listAiChanges,
  undoAiChanges,
}
