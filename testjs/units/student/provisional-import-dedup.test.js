// =========================================================================
// provisional-import-dedup.test.js —— V10-K04-03：导入选人 'new' 分支的同名临时学生冲突
//
// 根因：resolvePickedForImport 的 picked==='new' 直接 insertRow('students', …)，
// 撞唯一索引 ux_students_provisional_name 时把 SQLITE_CONSTRAINT 原样抛给路由，
// 前端收到 500 而非业务 400。同文件 resolveOne 已有「按名查回既有临时学生」的兜底。
//
// 判据：真库跑两遍 picked==='new' 同名导入，第二次必须复用第一次的 id，
// 且学生表里只有一条临时记录；变异反证（去掉 catch 兜底）必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const { loadMutated } = require('#testjs/units/_mechanism.cjs')

const fx = createBackendDb({ label: 'provisional-import-dedup' })
const conn = fx.conn
test.after(() => fx.close())

const REL = 'student-backend/services/provisionalStudents.js'
const prov = require('../../../student-backend/services/provisionalStudents')

test('同名临时学生重复导入：复用既有 id，不抛约束异常', () => {
  const first = prov.resolvePickedForImport('new', '临时同名同学')
  assert.equal(first.created, true, '第一次应新建')
  const count1 = conn.prepare('SELECT COUNT(*) AS c FROM students WHERE 姓名 = ? AND is_provisional = 1').get('临时同名同学').c
  assert.equal(count1, 1)

  const second = prov.resolvePickedForImport('new', '临时同名同学')
  assert.equal(second.created, false, '第二次应复用，不该再建')
  assert.equal(second.id, first.id, '两次必须指向同一条临时学生记录')
  const count2 = conn.prepare('SELECT COUNT(*) AS c FROM students WHERE 姓名 = ? AND is_provisional = 1').get('临时同名同学').c
  assert.equal(count2, 1, '唯一索引兜底后仍只有一条')
})

test('变异反证：去掉唯一冲突兜底后，第二次导入必须抛错', () => {
  const mutated = loadMutated(REL, (s) => s.replace(
    /    } catch \(err\) \{\n      if \(\/UNIQUE\/i\.test\(String\(err && err\.message\)\)\) \{\n        const again = findByName\(name\)\.find\(\(r\) => r\.is_provisional\)\n        if \(again\) return \{ id: Number\(again\.id\), name, is_provisional: true, created: false \}\n      \}\n      throw err\n    \}/,
    '    } catch (err) { throw err }'
  ))
  // 变异体用的是同一测试库，先清掉上一条避免第一次就撞
  conn.prepare('DELETE FROM students WHERE 姓名 = ?').run('变异同名同学')
  mutated.resolvePickedForImport('new', '变异同名同学')
  assert.throws(() => mutated.resolvePickedForImport('new', '变异同名同学'), /UNIQUE/i,
    '去掉兜底后应抛 SQLITE_CONSTRAINT —— 原判据确实在防这件事')
})
