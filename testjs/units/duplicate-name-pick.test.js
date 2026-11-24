// =========================================================================
// duplicate-name-pick.test.js —— 手工填表里同名学生的「点谁认谁」
//
// 名册里两个「张敏」时，候选列表显示学号让用户区分（studentLabel.js），
// 但确认环节若又拿输入框里的姓名去 find，仍然恒取第一个 —— 显示层做了
// 区分、写入层没接住。这里锁两条写入路径：
//   ① 班干部 CadreTreeList：点选的学生对象（带 id）直接 emit，手输同名则提示；
//   ② 座位/值日 GridView：学生候选显示「姓名 · 学号」，课表候选不受影响。
// 判据读源码做结构断言（Vue SFC 里的函数不能脱离上下文跑），配变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const TREE = path.join(ROOT, 'student-frontend/src/components/CadreTreeList.vue')
const GRID = path.join(ROOT, 'student-frontend/src/components/tables/GridView/GridView.vue')

function fnBody(src, marker) {
  const start = src.indexOf(marker)
  assert.ok(start >= 0, `找不到 ${marker}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${marker} 的函数体没有闭合`)
}

test('班干部：点选的候选按对象传递，不按姓名重新 find', () => {
  const src = fs.readFileSync(TREE, 'utf8')
  // pickCandidate 必须记住选中的学生（含 id），否则 confirmAdd 无从区分
  const pick = fnBody(src, 'function pickCandidate(s)')
  assert.match(pick, /pickedStudent\.value\s*=\s*s\b/, 'pickCandidate 要记住选中的学生对象')

  const body = fnBody(src, 'function confirmAdd()')
  // 「点选优先」的赋值必须出现在按姓名 filter 之前：否则还是取第一个
  assert.match(body, /if\s*\(\s*picked\s*&&/, '点选分支必须以「确实点过候选」为条件，不能恒走姓名查找')
  const pickedUse = body.indexOf('student = picked')
  const nameFilter = body.indexOf('props.allStudents.filter')
  assert.ok(pickedUse >= 0, 'confirmAdd 必须点名使用点选对象（student = picked）')
  assert.ok(nameFilter >= 0, '手输姓名仍要走名册查找（兼容旧习惯）')
  assert.ok(pickedUse < nameFilter, `点选对象要先于姓名查找生效，实际 picked@${pickedUse} filter@${nameFilter}`)

  // 手输同名时明确提示，不静默挑第一个
  assert.match(body, /matches\.length\s*>\s*1/, '手输同名要判重')
  assert.match(body, /有多位同学/, '同名歧义要提示用户从候选里选')

  // emit 出去的是确认后的 student（对象，带 id），不是姓名字符串
  assert.match(body, /emit\('add-student'[^;]*\bstudent\b/, 'add-student 载荷要带 student 对象')
})

test('座位/值日格内候选：学生候选显示学号，课表候选不受影响', () => {
  const src = fs.readFileSync(GRID, 'utf8')
  const body = fnBody(src, 'getCandidateLabel(item) {')

  // 有 candidateIdField（学生表）时才补学号；课表等按 label 字段的不加
  assert.match(body, /ctx\.candidateIdField\.value/, '要按候选是否落学生 id 判断是否补学号')
  assert.match(body, /item\.学号/, '要读学生行里的学号')
  assert.match(body, /formatStudentLabel\(/, '显示文案走统一标签函数（姓名 · 学号）')
  assert.match(src, /import\s*\{\s*formatStudentLabel\s*\}/, 'GridView 要引入统一标签函数')

  // 标签函数本身：有学号显示「姓名 · 学号」，空学号留给模板的「临时」标签
  const labelSrc = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/studentLabel.js'), 'utf8')
  const fmt = fnBody(labelSrc, 'export function formatStudentLabel(name, xuehao)')
  assert.match(fmt, /\$\{n\} · \$\{x\}/, '统一标签要含学号')
})
