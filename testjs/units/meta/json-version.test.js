// =========================================================================
// json-version.test.js —— JSON 列的 __v 结构版本标记
//
// 守的是四件事：对象列写入带版本、读取时剥离、数组列不受影响、无版本的旧数据照常读。
//
// 为什么值得单独测：版本标记不改变任何业务行为，所以「丢了」也不会有人发现 ——
// 但它是将来「按 __v 解码」的唯一依据。一旦哪次重构把 packJson 换回 JSON.stringify，
// 库里从此再也不写版本，而所有读取路径都正常，属于典型的静默退化。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'json-version' })

const slotStore = require(abs('student-backend/services/slotStore'))
const aiConfigStore = require(abs('student-backend/services/aiConfigStore'))
const mcpProposals = require(abs('student-backend/services/mcpProposalStore'))
const undoRecords = require(abs('student-backend/routes/undo/undo.records'))
const mcpTools = require(abs('student-backend/services/mcpTools'))
const { safeJson, packJson, stripVersion, stripVersionDeep } = require(abs('student-backend/utils/json'))

test.after(() => fx.close())

// 直接从库里取原始文本（绕过任何读取层），判断有没有版本标记
function rawCol(table, col, where) {
  return fx.conn.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${where}`).get().v
}
const hasVersion = (raw) => {
  try { return Object.prototype.hasOwnProperty.call(JSON.parse(raw), '__v') } catch (_) { return false }
}

test('对象列：写入打上 __v，读回剥掉', () => {
  slotStore.setDoc('seat_template', { settings: { showAisle: false } })
  const raw = rawCol('seat_slots', 'settings', "kind = 'template'")
  assert.equal(hasVersion(raw), true, '对象列必须带 __v，否则将来无法判断数据是哪一代')
  assert.equal(JSON.parse(raw).showAisle, false, '业务字段不能被序列化改坏')

  const back = safeJson(slotStore.getDoc('seat_template').settings, {}, 'settings')
  assert.equal('__v' in back, false, '读取层必须剥掉 __v，上层代码不该看到它')
  assert.equal(back.showAisle, false)
})

test('数组列：原样序列化，不塞 __v（数组无法带字段）', () => {
  slotStore.setDoc('seat_draft', { conditions: [{ k: 1 }] })
  const raw = rawCol('seat_slots', 'conditions', "kind = 'draft'")
  assert.equal(raw, '[{"k":1}]')
  assert.equal(hasVersion(raw), false)
})

test('旧数据（没有 __v）照常读，不报错也不补写', () => {
  fx.conn.prepare("UPDATE seat_slots SET settings = '{\"showAisle\":true}' WHERE kind = 'current'").run()
  const back = safeJson(slotStore.getDoc('seat_layout').settings, {}, 'settings')
  assert.deepEqual(back, { showAisle: true })
  assert.equal(
    rawCol('seat_slots', 'settings', "kind = 'current'"),
    '{"showAisle":true}',
    '读取不能回写库，旧格式应该原样保留',
  )
})

test('AI 四列：写入带版本、读回剥离、重复写不累积脏键', () => {
  aiConfigStore.setPrivacy({ enabled: true })
  assert.equal(hasVersion(rawCol('ai_settings', 'privacy_json', 'id = 1')), true)

  const read = aiConfigStore.readPrivacy()
  assert.equal('__v' in read, false)
  assert.equal(read.enabled, true)

  // 再写一次：从库里读出来 → 合并 → 写回，不能出现两个 __v
  aiConfigStore.setPrivacy({ enabled: false })
  const raw = rawCol('ai_settings', 'privacy_json', 'id = 1')
  assert.equal((raw.match(/"__v"/g) || []).length, 1, '__v 只能有一个')
  assert.equal(aiConfigStore.readPrivacy().enabled, false)
})

test('历史快照 payload：写入带版本、读回剥离、合并更新不丢版本', () => {
  slotStore.histInsert('seat', { snapDate: '2026-11-21', payload: { cols: 13 } })
  assert.equal(hasVersion(rawCol('domain_history', 'payload', "domain = 'seat'")), true)

  const snap = slotStore.histFind('seat', '2026-11-21')
  assert.deepEqual(snap.payload, { cols: 13 }, '读回不能带 __v')

  slotStore.histUpdateByDate('seat', '2026-11-21', null, { rows: 6 })
  const raw = rawCol('domain_history', 'payload', "domain = 'seat'")
  assert.equal((raw.match(/"__v"/g) || []).length, 1)
  assert.deepEqual(slotStore.histFind('seat', '2026-11-21').payload, { cols: 13, rows: 6 })
})

test('变异反证：写入绕开 packJson 时，判据必须报红', () => {
  // 模拟「有人把 packJson 换回 JSON.stringify」后的产物
  const naive = JSON.stringify({ showAisle: false })
  assert.equal(hasVersion(naive), false, '裸 JSON.stringify 必然没有 __v —— 上面的判据确实能抓到')
  assert.equal(hasVersion(packJson({ showAisle: false }, 'settings')), true, 'packJson 必须带上')
  assert.deepEqual(stripVersion(JSON.parse(packJson({ a: 1 }, 'settings'))), { a: 1 })
})

// ---------------------------------------------------------------------------
// 撤销快照与提案意图：这两列的形状「跨时间」使用（撤销记录可能存很久，
// 提案可能躺着几小时才被确认），读回时同样必须剥干净。

test('撤销快照 payload：写入带版本，getRecord 读回剥离', () => {
  const id = undoRecords.pushRecord('students:1', 'row_update', '改姓名', {
    table: 'students', rowId: 1,
    oldRow: { id: 1, 姓名: '张三' }, newRow: { id: 1, 姓名: '李四' },
  }, '')
  assert.equal(hasVersion(rawCol('undo_history', 'payload', `id = ${Number(id)}`)), true,
    'undo_history.payload 必须带 __v：撤销要能分辨快照是哪一代形状')

  const rec = undoRecords.getRecord(Number(id))
  assert.equal('__v' in rec.payload, false, '撤销执行器不该看到 __v')
  assert.equal(rec.payload.newRow.姓名, '李四', '剥版本不能动业务字段')
})

test('提案意图 payload：写入带版本，读取剥离', () => {
  const pid = mcpProposals.create({
    kind: 'row_write', label: '改姓名', table: 'students', operation: 'update',
    payload: { id: 1, 姓名: '李四' }, requestedBy: 'mcp',
  })
  assert.equal(hasVersion(rawCol('mcp_proposals', 'payload', `proposal_id = '${pid}'`)), true)

  const p = mcpProposals.get(pid)
  assert.equal('__v' in p.payload, false, '提案读取层不该看到 __v')
  assert.equal(p.payload.姓名, '李四')
})

// ---------------------------------------------------------------------------
// 出站剥离：MCP 把整行/整表交给外部模型，版本键在对象里、也在 JSON 列的字符串里

test('stripVersionDeep：对象、数组、字符串里的 JSON 都剥干净', () => {
  const src = { a: 1, __v: 1, nested: { b: 2, __v: 1 }, list: [{ c: 3, __v: 1 }] }
  assert.deepEqual(stripVersionDeep(src), { a: 1, nested: { b: 2 }, list: [{ c: 3 }] })
  assert.equal('__v' in src, true, '不能就地改调用方的对象')

  // 读表返回的行里，JSON 列是**字符串**，版本键在字符串内部
  assert.equal(stripVersionDeep('{"a":1,"__v":1}'), '{"a":1}')
  assert.equal(stripVersionDeep('{"a":1}'), '{"a":1}', '没有标记的字符串原样返回')
  assert.equal(stripVersionDeep('普通文本 __v'), '普通文本 __v', '不是 JSON 的文本不碰')
})

test('stripVersionDeep：没有标记时返回原对象，不做无谓深拷贝', () => {
  const src = { a: 1, nested: { b: 2 } }
  assert.equal(stripVersionDeep(src), src, '无标记必须原样返回同一个引用')
})

test('MCP 读表：JSON 列字符串里的 __v 不出现在结果里', () => {
  // 必须挑一张**按行读**、且带整块 JSON 列的表：读表返回的是 SELECT * 的原始字符串，
  // 版本键藏在字符串内部（doc 表走 getDoc，safeJson 已经剥过，测不出这一层）。
  undoRecords.pushRecord('students:9', 'row_update', '改班级', {
    table: 'students', rowId: 9, oldRow: { id: 9, 班级: '高二(1)班' }, newRow: { id: 9, 班级: '高二(3)班' },
  }, '')
  assert.equal(hasVersion(rawCol('undo_history', 'payload', "key = 'students:9'")), true, '前提：库里确实带着 __v')

  const out = mcpTools.readTable({ table: 'undo_history' }, { slug: 'json-version' })
  assert.equal(out.ok, true, '读表不该失败：' + out.error)
  const row = (out.rows || []).find((r) => r.key === 'students:9') || {}
  assert.equal(row.key, 'students:9', '读表结果里应当有刚写入的那条')
  // 断言直接盯 payload 这个字符串，不要先 JSON.stringify 整行再找 '"__v"'：
  // 序列化会把内部引号转义成 \"__v\"，那样的判据永远匹配不到 —— 是假绿。
  assert.equal(typeof row.payload, 'string', '读表返回的 JSON 列应当是原始字符串')
  assert.equal(String(row.payload).includes('__v'), false, `MCP 读结果不能带版本键：${row.payload}`)
  assert.equal(String(row.payload).includes('高二(3)班'), true, '剥版本不能把业务值弄丢')
})
