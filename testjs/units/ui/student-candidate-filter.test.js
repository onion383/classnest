// =========================================================================
// student-candidate-filter.test.js —— 学生候选下拉统一口径（V9-I-11/12）
//
// 真跑共享匹配函数（归一化 + 拼音），并锁四处下拉都接了它——过去四处各写一份，
// 同一输入在不同弹窗得到不同候选。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { studentCandidateHit } = require(abs('student-frontend/src/utils/tableSearch.js'))

test('行为：归一化子串 + 全拼/首字母拼音都命中，空关键字放行', () => {
  assert.ok(studentCandidateHit('张三', '张'), '子串命中')
  assert.ok(studentCandidateHit('张三', '张三'), '全名命中')
  assert.ok(studentCandidateHit('张三', 'zhangsan'), '全拼命中')
  assert.ok(studentCandidateHit('张三', 'zs'), '首字母命中')
  assert.ok(studentCandidateHit('张 三', '张三'), '空白归一')
  assert.ok(studentCandidateHit('张三', ''), '空关键字放行')
  assert.equal(studentCandidateHit('张三', '李'), false, '无关姓名不命中')
  assert.equal(studentCandidateHit(null, '张'), false, '空姓名不命中')
})

test('接线：四处学生候选下拉都走共享匹配函数', () => {
  const files = [
    'student-frontend/src/components/CadreTreeList.vue',
    'student-frontend/src/components/dialogs/AddLeaveDialog.vue',
    'student-frontend/src/components/dialogs/AddScoreDialog.vue',
    'student-frontend/src/components/tables/GridView/GridView.vue',
  ]
  for (const f of files) {
    const src = read(f)
    // @pin student-frontend/src/utils/tableSearch.js#studentCandidateHit
    assert.match(src, /studentCandidateHit\(/, `${f} 必须走统一候选匹配`)
    // 不许再有裸 toLowerCase().includes 的姓名过滤（旧写法）
    // @pin student-frontend/src/utils/tableSearch.js#studentCandidateHit
    assert.doesNotMatch(src, /姓名.*toLowerCase\(\).*includes/, `${f} 仍有旧口径过滤`)
  }
})
