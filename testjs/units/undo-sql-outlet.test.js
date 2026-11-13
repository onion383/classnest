// =========================================================================
// undo-sql-outlet.test.js —— 撤销域的 SQL 出口（档 C · M12-B8）
//
// 判据：undo 域的 4 个文件（入口 / 记录 / 辅助 / 执行器）都不许再有裸 SQL，
// 语句只在 services/undoStore.js；执行器的每条复合动作必须真的经 store。
// 这不是「换个写法」的洁癖：撤销的语句此前散在四处，同一条 undo_history 查询
// 抄两遍 —— 一处改了、另一处没改，表现是「撤销面板有记录、Ctrl+Z 说没有」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { ROOT } = require('./_db-express-fixture.cjs')

const FILES = [
  'student-backend/routes/undo/undo.js',
  'student-backend/routes/undo/undo.records.js',
  'student-backend/routes/undo/undo.helpers.js',
  'student-backend/routes/undo/undo.executors.js',
]

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}
function codeOnly(file) {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

test('SQL 出口：undo 的 4 个文件不留裸 SQL', () => {
  for (const f of FILES) {
    const code = codeOnly(f)
    assert.ok(!/db\.prepare\(/.test(code), `${f} 不许再有裸 SQL（应走 services/undoStore）`)
    assert.ok(!/const \{ db \} = require/.test(code), `${f} 不许再持有 db`)
  }
})

test('undoStore 承担记录表与执行器动作的语句', () => {
  const st = read('student-backend/services/undoStore.js')
  // 记录表：插入（含清 redo 与淘汰）与方向 CAS
  assert.match(st, /INSERT INTO undo_history \(key, type, label, payload, dir, origin, ts\)/)
  assert.match(st, /UPDATE undo_history SET dir = \? WHERE id = \? AND dir = \?/)
  // 每 key 上限：面板不分页完全建立在这条上
  assert.match(st, /LIMIT -1 OFFSET \?/)
})

test('执行器的复合动作必须真的经 store', () => {
  const ex = codeOnly('student-backend/routes/undo/undo.executors.js')
  for (const name of [
    'restoreDimension',
    'restoreMergedAlbum',
    'restoreCadreDelete',
    'restoreCadreImport',
    'restoreStudentCascade',
    'deleteStudentLinks',
    'restoreAlbumPhotoMove',
    'writeGridSnapshot',
  ]) {
    assert.match(ex, new RegExp(`undoStore\\.${name}\\(`), `执行器必须调用 undoStore.${name}`)
  }
  // 学生级联删除要同时写行与座位/值日 JSON，事务必须由 undoStore 提供
  assert.match(ex, /undoStore\.runInTransaction\(/)
})
