// =========================================================================
// row-focus-cancel-registry.test.js —— 反复跨页定位不能攒住旧闭包与 DOM（v7 §5-9 / #28）
//
// 原缺陷：createRowFocusHost 用一个 Set 收集「清理动作」，只有组件卸载时才逐个调用。
// 每次 applyRouteRowFocus 会往里塞 1~2 条（重试链 cancel + runAfterScroll 的 cancel），
// 而后者闭包里捕获着容器元素 —— 长驻页面（值日 / 相册 / 成绩）每点一次搜索结果就攒一条，
// 卸载前一个都放不掉。
//
// 修法：每轮定位开始前撤掉上一轮的清理动作（同一宿主同一时刻只有一个「当前定位」）。
// 判据：跑真实的 applyRouteRowFocus + 假 route/router/容器，看旧目标的重试链是否停手。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const MODULE = path.join(ROOT, 'student-frontend/src/composables/useRowFocus.js')
// 用可控假时钟推进重试链（T07-11）：
// 原用例靠真实墙钟 wait(250)/wait(120)/wait(90)，在慢 CI 上调度被延迟时链次不足会偶发误红。
// 这里每个用例启用 mock.timers，用 tick 精确推进 80ms 的重试间隔，判据与时序无关。
const withClock = (t, fn) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  return fn()
}

let mod = null
test.before(async () => {
  mod = await import(pathToFileURL(MODULE).href)
})

// 假宿主：route.query.focus 可改，router.replace 记账；容器永远找不到目标行
// （于是 focusRowWhenReady 会按 80ms 间隔一直重试 —— 正好用来观察「链有没有停」）。
function makeHost() {
  const route = { path: '/duty', query: { focus: '' } }
  const replaced = []
  const router = { replace: (p) => replaced.push(p) }
  const host = mod.createRowFocusHost(route, router)
  const queries = []
  const container = {
    querySelector(sel) {
      queries.push(String(sel))
      return null
    },
  }
  return { host, route, router, queries, replaced, container }
}

const idOf = (sel) => (/data-row-id="([^"]*)"/.exec(sel) || [])[1]

test('行为：换一个目标定位后，上一轮的重试链必须停手', async (t) => withClock(t, () => {
  const { host, route, queries, container } = makeHost()
  route.query.focus = 'row-A'
  mod.applyRouteRowFocus(host, { container: () => container })
  t.mock.timers.tick(240)
  const aTries = queries.filter(s => idOf(s) === 'row-A').length
  assert.ok(aTries >= 2, `第一轮应已在重试（实际 ${aTries} 次），否则用例没测到链`)

  const beforeSwitch = queries.length
  route.query.focus = 'row-B'
  mod.applyRouteRowFocus(host, { container: () => container })
  t.mock.timers.tick(240)
  const after = queries.slice(beforeSwitch)
  assert.equal(after.filter(s => idOf(s) === 'row-A').length, 0,
    '旧目标 row-A 的链还在跑 —— 上一轮的清理动作没撤掉')
  assert.ok(after.filter(s => idOf(s) === 'row-B').length >= 2, '新目标应正常开始重试')
  host.dispose()
}))

test('行为：dispose 之后不再有任何重试', async (t) => withClock(t, () => {
  const { host, route, queries, container } = makeHost()
  route.query.focus = 'row-C'
  mod.applyRouteRowFocus(host, { container: () => container })
  t.mock.timers.tick(80)
  host.dispose()
  const atDispose = queries.length
  t.mock.timers.tick(320)
  assert.equal(queries.length, atDispose, 'dispose 后仍有重试在跑')
}))

test('行为：连续多次定位不会越攒越多（每次都只有当前目标在重试）', async (t) => withClock(t, () => {
  const { host, route, queries, container } = makeHost()
  for (const id of ['r1', 'r2', 'r3', 'r4']) {
    route.query.focus = id
    mod.applyRouteRowFocus(host, { container: () => container })
    t.mock.timers.tick(80)
  }
  const mark = queries.length
  t.mock.timers.tick(240)
  const tail = queries.slice(mark).map(idOf)
  assert.ok(tail.every(id => id === 'r4'), `只有最后一个目标该继续重试，实际还在重试：${[...new Set(tail)]}`)
  host.dispose()
}))

test('接线：新定位开始前显式撤掉上一轮，宿主带 _clearFocusCancels', () => {
  const src = fs.readFileSync(MODULE, 'utf8')
  assert.match(src, /host\._clearFocusCancels = clearCancels/, '宿主没有暴露撤表入口')
  const applyFn = src.slice(src.indexOf('export function applyRouteRowFocus'))
  assert.match(applyFn.slice(0, 1200), /host\._clearFocusCancels\(\)/, 'applyRouteRowFocus 没撤上一轮')
  // 不能再用只增不减的 Set
  assert.doesNotMatch(src, /cancels\.add\(/, '又回到只增不减的 Set 了')
})
