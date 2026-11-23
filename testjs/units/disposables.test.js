// =========================================================================
// disposables.test.js —— 「资源随作用域释放」底座的语义测试
//
// 这个底座是审查 v4 批 11 的根因修复：前端原先没有统一表达「谁负责清理什么」，
// 定时器/监听器/AbortController 散落各处靠人脑配对，漏一处就永久泄漏。
// 底座本身没有业务依赖，直接 import 即可，要保证的是它的语义不被后来人改歪：
//   · 登记 = 承诺释放；dispose 后资源一定不再活着
//   · dispose 幂等；单个清理函数抛错不能连累其它资源
//   · listen 必须与 removeEventListener 严格配对（capture 选项要原样传回）
//   · defer 的语义是「可替换的一次性定时器」（防抖），不是「可叠加的」
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/utils', rel)).href)
const { loadVue } = require('./_vue-loader.cjs')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 假的事件目标：记录注册与移除，用来验证配对是否严格对称
function fakeTarget() {
  return {
    added: [],
    removed: [],
    addEventListener(type, handler, options) { this.added.push({ type, handler, options }) },
    removeEventListener(type, handler, options) { this.removed.push({ type, handler, options }) },
  }
}

test('disposables：登记的定时器在 dispose 后不再触发', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  d.timeout(() => { fired++ }, 5)
  assert.equal(d.size, 1, '登记后应有一条待释放的资源')
  d.dispose()
  await wait(30)
  assert.equal(fired, 0, 'dispose 之后定时器不能再触发')
})

test('disposables：周期定时器在 dispose 后停止', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  d.interval(() => { fired++ }, 5)
  await wait(20)
  const seen = fired
  assert.ok(seen > 0, '定时器本该在跑')
  d.dispose()
  await wait(20)
  assert.equal(fired, seen, 'dispose 之后不应再有新的触发')
})

test('disposables：事件监听器与移除严格配对（含 capture 选项）', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  const t = fakeTarget()
  const onX = () => {}
  d.listen(t, 'lostpointercapture', onX, true)
  assert.equal(t.added.length, 1, '应注册了一个监听器')
  d.dispose()
  assert.equal(t.removed.length, 1, 'dispose 必须移除监听器')
  assert.equal(t.removed[0].handler, onX, '移除的必须是同一个 handler')
  assert.equal(t.removed[0].options, true, 'capture 选项必须原样传回（capture 不一致就移不掉）')
})

test('disposables：defer 是「可替换」的防抖语义', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let n = 0
  const schedule = d.defer()
  schedule(() => { n++ }, 5)
  schedule(() => { n++ }, 5)
  schedule(() => { n++ }, 5)
  await wait(30)
  assert.equal(n, 1, '连着排三次只应触发最后一次（防抖），旧实现会触发三次')
})

test('disposables：defer 的 cancel 能撤掉还在排期的那次', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let n = 0
  const schedule = d.defer()
  schedule(() => { n++ }, 5)
  assert.equal(schedule.pending, true, '排期中 pending 应为 true')
  schedule.cancel()
  assert.equal(schedule.pending, false, '取消后 pending 应为 false')
  await wait(30)
  assert.equal(n, 0, '取消后不该触发')
})

test('disposables：AbortController 随作用域 abort', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let aborted = false
  const ctrl = { abort() { aborted = true } }
  d.abort(ctrl)
  d.dispose()
  assert.equal(aborted, true, 'dispose 必须 abort 已登记的 controller')
})

test('disposables：dispose 幂等，清理函数只跑一次', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let n = 0
  d.add(() => { n++ })
  d.dispose()
  d.dispose()
  d.dispose()
  assert.equal(n, 1, '重复 dispose 不该重复清理')
  assert.equal(d.disposed, true)
  assert.equal(d.size, 0, 'dispose 后不应还挂着待释放资源')
})

test('disposables：单个清理函数抛错不连累其它资源', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let ok = 0
  d.add(() => { throw new Error('boom') })
  d.add(() => { ok++ })
  assert.doesNotThrow(() => d.dispose(), '清理失败不能反过来让卸载流程崩掉')
  assert.equal(ok, 1, '后面的清理仍要执行')
})

test('disposables：已释放后再登记 → 立刻释放（资源不该留在死作用域里）', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  d.dispose()
  let n = 0
  d.add(() => { n++ })
  assert.equal(n, 1, '作用域已死，新登记的资源必须当场释放')
})

test('disposables：useDisposables 在 Vue 作用域外也能用（退化成普通登记表）', async () => {
  const { useDisposables } = await load('disposables.js')
  assert.doesNotThrow(() => useDisposables(), '组件外调用不能抛错')
  const d = useDisposables()
  let fired = 0
  d.timeout(() => { fired++ }, 5)
  d.dispose()
  await wait(30)
  assert.equal(fired, 0)
})

test('disposables：useDisposables 在真实 Vue 作用域里会自动随作用域释放', async () => {
  // 用 Vue 的 effectScope 模拟组件作用域：scope.stop() 即组件卸载。
  // 入口按 package.json exports 解析（不硬编码 index.mjs，也与源码共用同一模块实例）。
  const { effectScope } = await loadVue()
  const { useDisposables } = await load('disposables.js')
  const scope = effectScope()
  let d = null
  let fired = 0
  scope.run(() => {
    d = useDisposables()
    d.timeout(() => { fired++ }, 5)
  })
  scope.stop()
  await wait(30)
  assert.equal(fired, 0, '作用域停止后定时器不该再触发（这是底座存在的意义）')
})

test('V5-006：dispose 之后 timeout / defer / interval 都不再排期', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  d.dispose()

  let timeoutFired = 0
  let deferFired = 0
  let intervalFired = 0
  d.timeout(() => { timeoutFired++ }, 5)
  d.defer()(() => { deferFired++ }, 5)
  d.interval(() => { intervalFired++ }, 5)

  await wait(40)
  assert.equal(timeoutFired, 0, '已释放的作用域不能再排一次性定时器（否则操作已卸载状态）')
  assert.equal(deferFired, 0, 'defer 的排期同样要挡掉')
  assert.equal(intervalFired, 0, '周期定时器也不能在释放后继续跑')
})

// ——————————————————— §5-1：返回值必须是「真取消」，不能只是撤销登记 ———————————————————
//
// add() 返回的函数只把清理项从表里摘掉、并不执行它。timeout/interval 曾经直接把
// 那个函数当取消函数返回：cancel() 之后 timer 照跑、回调照触发，而且清理项已被摘掉，
// 连 dispose() 都救不回来。这三条判据卡的就是「取消 = 资源真的停了」。

test('§5-1：timeout 的取消函数必须真的清掉定时器（不只是摘掉登记项）', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  const cancel = d.timeout(() => { fired++ }, 10)
  assert.equal(d.size, 1, '排期后应有一条待释放项')
  cancel()
  assert.equal(d.size, 0, '取消后登记项应被摘掉（不留死项）')
  await wait(40)
  assert.equal(fired, 0, '取消之后回调不能触发（旧实现这里会触发）')
})

test('§5-1：timeout 一旦取消，dispose 也不会再动它（不该重复清理已结束的资源）', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  const cancel = d.timeout(() => { fired++ }, 10)
  cancel()
  d.dispose()
  await wait(40)
  assert.equal(fired, 0, '取消 + dispose 之后仍不该触发')
})

test('§5-1：timeout 已触发后调用取消函数是无害的空操作', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  const cancel = d.timeout(() => { fired++ }, 5)
  await wait(25)
  assert.equal(fired, 1, '正常到点应触发一次')
  assert.doesNotThrow(() => cancel(), '触发后再取消不能抛错')
  cancel()
  await wait(20)
  assert.equal(fired, 1, '重复取消不该产生副作用')
})

test('§5-1：interval 的取消函数同样必须真的停掉周期定时器', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  let fired = 0
  const stop = d.interval(() => { fired++ }, 5)
  await wait(20)
  assert.ok(fired > 0, '周期定时器本该在跑')
  stop()
  const seen = fired
  assert.equal(d.size, 0, '取消后登记项应被摘掉')
  await wait(30)
  assert.equal(fired, seen, '取消之后不应再有新的触发（旧实现这里还会继续跑）')
})

// ——————————————— §5-17：listen 的返回值也必须是「真取消」 ———————————————
//
// 拖拽这类动态监听没法等到卸载才收尾：pointermove/pointerup 必须松手就摘。
// 旧实现的 listen 返回的仍是 add() 的「撤销登记」，调用方以为摘掉了监听器，
// 实际上回调照旧触发（只把清理项从表里删了，连 dispose 都救不回来）。

test('§5-17：listen 的取消函数必须真的摘掉监听器（不只是摘掉登记项）', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  const t = fakeTarget()
  const onX = () => {}
  const cancel = d.listen(t, 'pointermove', onX, { capture: true })
  assert.equal(t.added.length, 1, '应注册了一个监听器')
  cancel()
  assert.equal(t.removed.length, 1, '取消必须调用 removeEventListener（旧实现这里是 0 次）')
  assert.equal(t.removed[0].handler, onX, '移除的必须是同一个 handler')
  assert.equal(t.removed[0].options.capture, true, 'capture 必须原样传回')
  assert.equal(d.size, 0, '取消后登记项应被摘掉（不留死项）')
})

test('§5-17：listen 取消后再 dispose 不重复移除；重复取消是空操作', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  const t = fakeTarget()
  const cancel = d.listen(t, 'pointerup', () => {})
  cancel()
  cancel()
  d.dispose()
  assert.equal(t.removed.length, 1, '同一个监听器只该被摘一次')
})

test('§5-17：dispose 仍负责摘掉没被手动取消的监听器', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  const t = fakeTarget()
  const onX = () => {}
  d.listen(t, 'resize', onX)
  d.dispose()
  assert.equal(t.removed.length, 1, '没手动取消的监听器由 dispose 兜底摘掉')
  assert.equal(t.removed[0].handler, onX)
})

test('§5-17：已 dispose 之后再 listen → 立刻摘掉，不留活监听', async () => {
  const { createDisposables } = await load('disposables.js')
  const d = createDisposables()
  const t = fakeTarget()
  d.dispose()
  const cancel = d.listen(t, 'scroll', () => {})
  assert.equal(t.removed.length, 1, '死作用域里新登记的监听器必须当场摘掉')
  assert.doesNotThrow(() => cancel(), '再取消一次不能抛错')
  assert.equal(t.removed.length, 1, '重复取消不该产生第二次移除')
})
