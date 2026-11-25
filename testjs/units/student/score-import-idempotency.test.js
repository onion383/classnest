// =========================================================================
// score-import-idempotency.test.js —— 成绩批量导入幂等（F07-04）
//
// 判据（真跑 POST /api/scores/import，不是读源码正则）：
//   ① 同一份表连导两次：第二次 alreadyImported=true 且 score_records 行数不变；
//   ② 第二次带 force=true：强制新建、行数增加、批次指纹更新为新那批；
//   ③ 内容不同（哪怕只一个单元格）算另一份表，正常新建；
//   ④ 指纹是稳定 hash：入参对象键顺序变了不影响，任一项内容变了就变。
//
// 为什么按"文件指纹"而不是按内容去重：同一学生同一天同一项目加两次分是合法的，
// 内容指纹会误伤。"重复"只定义为"同一份表再导一次"。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'score-import-idem' })
let base

test.before(async () => {
  base = await fx.mount('/api/scores', 'student-backend/routes/scores.js')
})
test.after(() => fx.close())

const post = (body) => fx.call('POST', '/import', body)
const rowsOf = () => fx.conn.prepare('SELECT * FROM score_records ORDER BY id').all()

// 一份最小可导入的表：不依赖 students 表，名册外姓名会落临时学生（有 hash 缓存，同批只建一次）
const sheet = (score = '5') => ({
  fields: ['姓名', '类型', '分值', '项目', '加分时间'],
  rows: [[`临时学生${score}`, '加分', score, '测试项目', '2026-11-25']],
  mode: 'personal',
})

test('指纹是稳定 hash：键顺序无关、内容变化即变化', async () => {
  const { fingerprintOf } = require('../../../student-backend/services/importBatch.js')
  const a = sheet()
  const b = { mode: 'personal', rows: a.rows, fields: a.fields } // 键顺序不同
  assert.equal(fingerprintOf(a), fingerprintOf(b), '入参键顺序不影响指纹')
  assert.notEqual(fingerprintOf(a), fingerprintOf(sheet('6')), '内容变了指纹必须变')
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, mode: 'group' }), 'mode 变了指纹必须变')
})

test('① 同一份表连导两次：第二次不新建，回原结果', async () => {
  fx.reset()
  const payload = sheet()
  const first = await post(payload)
  assert.equal(first.status, 200, `首次导入应 200，实际 ${first.status} ${first.text}`)
  assert.equal(first.json.alreadyImported, undefined, '首次导入不该标记已导入')
  assert.equal(rowsOf().length, 1, '首次导入建 1 条')

  const second = await post(payload)
  assert.equal(second.status, 200)
  assert.equal(second.json.alreadyImported, true, '第二次应标记已导入')
  assert.equal(rowsOf().length, 1, '第二次不得新建记录')
  assert.deepEqual(second.json.created, first.json.created, '第二次应回读第一次新建的那条（供撤销）')
})

test('② force=true 强制新建：行数增加、批次改指向新那批', async () => {
  fx.reset()
  const payload = sheet()
  const first = await post(payload)
  const forced = await post({ ...payload, force: true })
  assert.equal(forced.status, 200)
  assert.equal(forced.json.alreadyImported, undefined, 'force 不应再报已导入')
  assert.equal(rowsOf().length, 2, 'force 必须新建一条')
  assert.equal(forced.json.created.length, 1)

  // 再导一次仍命中最新那批（batch 记录已更新为 force 那批）
  const third = await post(payload)
  assert.equal(third.json.alreadyImported, true)
  assert.deepEqual(third.json.created, forced.json.created, '默认应命中最近一次 force 建的批次')
})

test('③ 内容不同算另一份表，正常新建不误拦', async () => {
  fx.reset()
  await post(sheet('5'))
  const other = await post(sheet('7'))
  assert.equal(other.status, 200)
  assert.equal(other.json.alreadyImported, undefined, '不同内容的表不该被判重复')
  assert.equal(rowsOf().length, 2, '不同内容应各自建一条')
})

test('④ 批次与写记录同事务：写入中途失败不留半条批次', async () => {
  fx.reset()
  // 造一行触发校验失败（缺姓名），整批 400；不得留下 import_batches
  const bad = { fields: ['类型', '分值'], rows: [['加分', '5']], mode: 'personal' }
  const r = await post(bad)
  assert.equal(r.status, 400, '缺姓名的行应整批失败')
  const batches = fx.conn.prepare('SELECT * FROM import_batches').all()
  assert.equal(batches.length, 0, '失败批次不得残留（否则下次同内容永远被误判已导入）')
  assert.equal(rowsOf().length, 0)
})

// ---- 前端接线：重复导入给出口、不登记撤销（源码结构断言，配 @pin 供变异反证）----
const { read } = require('#testjs/paths')
const vueSrc = () => read('student-frontend/src/views/ScoreManagement.vue')

test('前端：重复导入走提示分支，不登记撤销，且给「仍然新建」出口', () => {
  const src = vueSrc()
  // @pin student-frontend/src/views/ScoreManagement.vue#onImportData
  assert.match(src, /if \(res\.data\?\.alreadyImported\)/, '必须识别后端的已导入响应')
  // @pin student-frontend/src/views/ScoreManagement.vue#onImportData
  assert.match(src, /action: \{ label: '仍然新建'/, '重复导入要给用户强制新建的出口')
  // @pin student-frontend/src/views/ScoreManagement.vue#onImportData
  assert.match(src, /onClick: \(\) => onImportData\(\{ fields, rows, studentIds \}, true\)/, '出口必须带 force=true 重发')
  // 关键：alreadyImported 分支里 return 在前，不得 fallthrough 到 recordRowsBatchInsert
  const branch = src.match(/if \(res\.data\?\.alreadyImported\)[\s\S]*?\n    \}/)
  assert.ok(branch, '要能定位已导入分支')
  assert.match(branch[0], /\breturn\b/, '已导入分支必须提前 return，否则会撤销掉上次的数据')
})
