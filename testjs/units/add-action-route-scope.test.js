// =========================================================================
// add-action-route-scope.test.js —— 首页「去 XX」的 ?action=add 只能打开本页弹窗
//
// 背景：KeepAlive 缓存页的 watch 在 deactivated 时仍然活着。跳转 /leaves?action=add 时，
// 班费等页面的 route.query.action watcher 也会看到 'add'，于是两个弹窗一起弹出。
//
// 判据：
//   ① 纯函数：action=add 且当前路由名匹配才算命中；别页、别 action、缺 route 都不命中；
//   ② 接线：7 个带 action watcher 的页面都经 isAddActionForRoute 判定，不再裸判 v；
//   ③ 变异反证：把任一页的守卫换回裸判 v，接线判据必须变红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { isAddActionForRoute } = require('../../student-frontend/src/utils/addActionRoute.js')

// ————————————————— ① 纯函数 —————————————————

test('当前页 + action=add → 命中', () => {
  assert.equal(isAddActionForRoute({ name: 'leaves', query: { action: 'add' } }, 'leaves'), true)
  assert.equal(isAddActionForRoute({ name: 'fee', query: { action: 'add' } }, 'fee'), true)
})

test('别页带着同一个 action=add → 不命中（这是修复的核心分支）', () => {
  assert.equal(isAddActionForRoute({ name: 'fee', query: { action: 'add' } }, 'leaves'), false)
  assert.equal(isAddActionForRoute({ name: 'leaves', query: { action: 'add' } }, 'fee'), false)
})

test('本页但 action 不是 add / 无 query / 无 route → 不命中', () => {
  assert.equal(isAddActionForRoute({ name: 'leaves', query: { action: 'edit' } }, 'leaves'), false)
  assert.equal(isAddActionForRoute({ name: 'leaves', query: {} }, 'leaves'), false)
  assert.equal(isAddActionForRoute({ name: 'leaves' }, 'leaves'), false)
  assert.equal(isAddActionForRoute(null, 'leaves'), false)
})

// ————————————————— ② 接线 —————————————————

const PAGES = [
  ['FeeManagement.vue', 'fee'],
  ['LeaveManagement.vue', 'leaves'],
  ['DutyView.vue', 'duty'],
  ['ScoreManagement.vue', 'scoreManage'],
  ['ActivitiesView.vue', 'activities'],
  ['AlbumView.vue', 'album'],
  ['ScheduleView/ScheduleView.vue', 'schedule'],
]

function actionWatcherBlock(src) {
  const start = src.indexOf('watch(() => route.query.action,')
  assert.notEqual(start, -1, '找不到 action watcher')
  const end = src.indexOf('}, { immediate: true })', start)
  assert.notEqual(end, -1, '找不到 action watcher 结尾')
  return src.slice(start, end)
}

function assertWired(src, name) {
  assert.match(src, /import\s*\{\s*isAddActionForRoute\s*\}/, '未导入 isAddActionForRoute')
  const block = actionWatcherBlock(src)
  assert.match(block, new RegExp(`isAddActionForRoute\\s*\\(\\s*route\\s*,\\s*'${name}'\\s*\\)`),
    `action watcher 未按本页路由名 ${name} 判定`)
  assert.doesNotMatch(block, /v\s*!==\s*'add'/, '仍保留裸判 v !== add（别页也会开弹窗）')
}

for (const [file, name] of PAGES) {
  test(`${file} 的 action watcher 只认本页`, () => {
    assertWired(read(`student-frontend/src/views/${file}`), name)
  })
}

// ————————————————— ③ 变异反证 —————————————————

test('变异反证：把守卫改回裸判 v 后，接线判据必须变红', () => {
  const src = read('student-frontend/src/views/LeaveManagement.vue')
  const mutated = src.replace(
    "if (!isAddActionForRoute(route, 'leaves')) return",
    "if (v !== 'add') return",
  )
  assert.notEqual(mutated, src, '变异未生效：找不到守卫原文')
  assert.throws(() => assertWired(mutated, 'leaves'), /裸判|未按本页路由名/)
})
