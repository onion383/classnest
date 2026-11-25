// =========================================================================
// undo-sql-outlet.test.js —— 撤销域的 SQL 出口（档 C · M12-B8）
//
// 判据：undo 域的 5 个文件（入口 / 记录 / 辅助 / 执行器 / expected 校验）都不许再有裸 SQL，
// 语句只在 services/undoStore.js；执行器的每条复合动作必须真的经 store。
// 这不是「换个写法」的洁癖：撤销的语句此前散在四处，同一条 undo_history 查询
// 抄两遍 —— 一处改了、另一处没改，表现是「撤销面板有记录、Ctrl+Z 说没有」。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { ROOT } = require('#testjs/units/_db-express-fixture.cjs')
const {
  analyze, walk, memberPath, findFunction,
} = require('#testjs/source-scan')

const FILES = [
  'student-backend/routes/undo/undo.js',
  'student-backend/routes/undo/undo.records.js',
  'student-backend/routes/undo/undo.helpers.js',
  'student-backend/routes/undo/undo.executors.js',
  'student-backend/routes/undo/undo.expected.js',
]

function read(file) {
  return fs.readFileSync(abs(file), 'utf8')
}
function codeOnly(file) {
  // AST 的 codeNoStrings：注释和字符串内容都已抹成空格 —— 字符串里写一句 '.prepare('
  // 不会被当成裸 SQL（旧的正则剔除注释会留下字符串），真代码里的调用仍然可见。
  return analyze(read(file)).codeNoStrings
}
// SQL 规范化空白：源码换行/缩进变化不再影响判据（旧正则绑定单空格）
function sqlOf(file) {
  return read(file).replace(/\s+/g, ' ')
}

test('SQL 出口：undo 的 5 个文件不留裸 SQL', () => {
  for (const f of FILES) {
    const code = codeOnly(f)
    assert.ok(!/\.prepare\s*\(/.test(code), `${f} 不许再有裸 SQL（应走 services/undoStore；显式 conn 也不行）`)
    assert.ok(!/const\s*\{\s*db\s*\}\s*=\s*require/.test(code), `${f} 不许再持有 db`)
  }
})

test('undoStore 承担记录表与执行器动作的语句', () => {
  const st = sqlOf('student-backend/services/undoStore.js')
  // 记录表：插入（含清 redo 与淘汰）与方向 CAS
  // source 是统一来源分类（manual/ai_assistant/mcp），列顺序固定，改列清单这里是第一道闸。
  assert.match(st, /INSERT INTO undo_history \(key, type, label, payload, dir, origin, source, ts\)/)
  assert.match(st, /UPDATE undo_history SET dir = \? WHERE id = \? AND dir = \?/)
  // expected 校验读当前行也必须走 store（不许在 records/expected 里写裸 SQL）
  assert.ok(findFunction(analyze(read('student-backend/services/undoStore.js')).ast, 'findRowById'),
    'undoStore 应提供 findRowById(table, id)')
  // 每 key 上限：面板不分页完全建立在这条上
  assert.match(st, /LIMIT -1 OFFSET \?/)
})

test('执行器的复合动作必须真的经 store', () => {
  const { ast } = analyze(read('student-backend/routes/undo/undo.executors.js'))
  // 为什么用 AST 收集调用而不是 /undoStore\.name\(/ 正则：
  // 正则会命中注释/字符串里的同名字样；而且空格一变（undoStore.name (）就假红。
  // 这里只认真实的 CallExpression 且 callee 静态路径是 undoStore.<name>。
  const called = new Set()
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const p = memberPath(node.callee)
    if (p && p.startsWith('undoStore.')) called.add(p.slice('undoStore.'.length))
  })
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
    assert.ok(called.has(name), `执行器必须调用 undoStore.${name}`)
  }
  // 学生级联删除要同时写行与座位/值日 JSON，事务必须由 undoStore 提供
  assert.ok(called.has('runInTransaction'), '执行器必须用 undoStore.runInTransaction 包事务')
})
