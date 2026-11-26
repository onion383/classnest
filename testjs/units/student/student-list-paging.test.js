// =========================================================================
// student-list-paging.test.js —— 学生名单首屏分页（V9 · 5-5）
//
// 口径：办公侧 GET /api/students 默认整表下发（10 万行约 97ms 阻塞事件循环），
// 前端虚拟滚动只省 DOM 不省 payload。学生管理页改为首屏 limit=50、滚到底逐页追加；
// 导出/去重/搜索/跨页定位需要整表的动作先补成全量，其余调用方（点名/座位/缴费页）不变。
//
// 判据是真执行 + 变异反证：直接跑 composable 引用的同一份纯函数，
// 再对「分页开关 / 全量开关 / hasMore 比较方向」做变异，断言判据必须失败。
// 只测「源码里出现了 limit 字样」这类假绿不算数。
// =========================================================================
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PAGE_PATH = abs('student-frontend/src/utils/tablePaging.js')
const PAGE = pathToFileURL(PAGE_PATH).href
const loadPaging = () => import(PAGE)
const obj = (params) => Object.fromEntries(params.entries())

// 把真源码变异后写到临时文件执行：确认「守卫一旦掉了，判据立刻红」。
// 用 data: URL 避免污染工作区，也避开 ESM 缓存（每次都是新 URL）。
async function loadMutated(mutate) {
  const src = fs.readFileSync(PAGE_PATH, 'utf8')
  const broken = mutate(src)
  assert.notEqual(broken, src, '变异没生效：锚点没匹配上')
  return import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'))
}

test('首屏：带 limit/offset 与页面附加查询，其他页面不分页', async () => {
  const { buildListParams } = await loadPaging()
  const first = obj(buildListParams({ extra: { formal: 1 }, pageSize: 50, offset: 0 }))
  assert.equal(first.formal, '1', 'formal=1 的过滤参数必须随分页请求带上')
  assert.equal(first.limit, '50')
  assert.equal(first.offset, '0')

  const other = obj(buildListParams({ extra: { formal: 1 }, pageSize: 0, offset: 0 }))
  assert.equal(other.limit, undefined, '不传 paging 的调用方（缴费页等）照旧整表')
  assert.equal(other.offset, undefined)
})

test('追加下一页：offset 用已加载行数', async () => {
  const { buildListParams } = await loadPaging()
  const p = obj(buildListParams({ extra: { formal: 1 }, pageSize: 50, offset: 50 }))
  assert.equal(p.offset, '50')
  assert.equal(p.limit, '50')
})

test('显式全量 / 已全量刷新：都不带 limit，避免缩回第一页', async () => {
  const { buildListParams } = await loadPaging()
  const full = obj(buildListParams({ extra: { formal: 1 }, pageSize: 50, offset: 100, full: true }))
  assert.equal(full.limit, undefined, '导出/定位的全量请求不能带 limit')
  assert.equal(full.offset, undefined)

  const afterFull = obj(buildListParams({ extra: { formal: 1 }, pageSize: 50, offset: 0, fullLoaded: true }))
  assert.equal(afterFull.limit, undefined, '补过全量后刷新也要保持全表')
})

test('hasMore：已加载 < 总数才继续；全量模式恒 false', async () => {
  const { nextPageState } = await loadPaging()
  const paged = nextPageState({ mode: 'replace', loaded: 50, total: 100 })
  assert.deepEqual(paged, { offset: 50, total: 100, hasMore: true, fullLoaded: false })

  const done = nextPageState({ mode: 'append', loaded: 100, total: 100 })
  assert.equal(done.hasMore, false, '取完就不能再报还有')

  const full = nextPageState({ mode: 'full', loaded: 100, total: 0 })
  assert.deepEqual(full, { offset: 100, total: 100, hasMore: false, fullLoaded: true })
})

test('变异反证：抹掉分页开关，首屏 limit 判据必须失败', async () => {
  const good = await loadPaging()
  assert.equal(good.buildListParams({ pageSize: 50 }).get('limit'), '50', '原判据要先成立')

  const mutant = await loadMutated((s) => s.replace('if (pageSize && !full && !fullLoaded) {', 'if (false) {'))
  assert.equal(mutant.buildListParams({ pageSize: 50 }).get('limit'), null,
    '守卫被抹掉后 limit 必须消失——否则这条测试是假绿')
})

test('变异反证：hasMore 比较方向反过来，判据必须失败', async () => {
  const good = await loadPaging()
  assert.equal(good.nextPageState({ mode: 'replace', loaded: 50, total: 100 }).hasMore, true)

  const mutant = await loadMutated((s) => s.replace('hasMore: loaded < n', 'hasMore: loaded >= n'))
  assert.equal(mutant.nextPageState({ mode: 'replace', loaded: 50, total: 100 }).hasMore, false,
    '比较方向翻转后判据必须红——否则这条测试是假绿')
})

test('变异反证：全量模式若误标 hasMore，判据必须失败', async () => {
  const good = await loadPaging()
  assert.equal(good.nextPageState({ mode: 'full', loaded: 100, total: 200 }).hasMore, false)

  const mutant = await loadMutated((s) => s.replace('hasMore: false, fullLoaded: true', 'hasMore: true, fullLoaded: true'))
  assert.equal(mutant.nextPageState({ mode: 'full', loaded: 100, total: 200 }).hasMore, true,
    '全量模式被改出「还有更多」时判据必须红')
})
