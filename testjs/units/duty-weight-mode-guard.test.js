// =========================================================================
// duty-weight-mode-guard.test.js —— 值日权重表不能与设置抢跑、也不能被旧模式覆盖（v7 §5-7 / #25a）
//
// 两个独立毛病：
//   ① 首屏四项并发（onMounted / reloadAll / reloadAllFromServer）。权重为空时要按
//      `settingsItems[].difficulty × settingsDays` 铺初始矩阵，若设置还没回来，
//      items/days 都是空数组 → 铺出**空矩阵**并当成「已加载」，页面上一个项目都没有。
//   ② 快速切模式（日常值日 ↔ 大扫除）时两个 GET /duty/weight?mode=... 同时在途，
//      先发的响应后回来，会把新模式权重覆盖成旧模式的数值。
// 修法：fetchSettings / loadWeight 各一张 createLatest 守卫；权重空表分支先 await 设置，
// 醒来后重新核对守卫（等设置期间可能已经切了模式）。
//
// 判据：把真实的 loadWeight 抽出来跑（axios / ref / 守卫全部注入），跑三种时序。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createLatest } = require('../../student-frontend/src/utils/latestOnly.js')

const ROOT = path.join(__dirname, '../..')
const VUE = 'student-frontend/src/views/DutyView.vue'

function functionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `找不到 async function ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`async function ${name} 的大括号没有配平`)
}

const defer = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

// 用真实的 loadWeight 源码搭一个最小运行环境
function build(src) {
  const fn = functionSource(src, 'loadWeight')
  const env = {
    dutyMode: { value: 'daily' },
    dutyWeights: { value: {} },
    weightError: { value: false },
    weightLoaded: { value: false },
    settingsItems: { value: [] },
    settingsDays: { value: [] },
    weightLoadGuard: createLatest(),
    calls: [],
  }
  const axios = {
    get(url) {
      const d = defer()
      env.calls.push({ url, ...d })
      return d.promise
    },
  }
  const factory = new Function(
    'axios', 'API_BASE', 'dutyMode', 'dutyWeights', 'weightError', 'weightLoaded',
    'settingsItems', 'settingsDays', 'weightLoadGuard',
    `${fn}\nreturn loadWeight;`,
  )
  env.loadWeight = factory(
    axios, '/api', env.dutyMode, env.dutyWeights, env.weightError, env.weightLoaded,
    env.settingsItems, env.settingsDays, env.weightLoadGuard,
  )
  return env
}

const src = fs.readFileSync(path.join(ROOT, VUE), 'utf8')

test('行为：权重为空时先等设置落定，再按 items×days 铺初始矩阵', async () => {
  const env = build(src)
  // 设置后到（20ms），权重先到（5ms）—— 原实现会在这 15ms 里用空设置铺出空矩阵
  const settingsReady = (async () => {
    await tick(20)
    env.settingsItems.value = [{ name: '扫教室', difficulty: 0.3 }, { name: '拖地', difficulty: 0.7 }]
    env.settingsDays.value = ['周一', '周二']
  })()
  const load = env.loadWeight(settingsReady)
  await tick(5)
  env.calls[0].resolve({ data: { weights: {} } })
  await load
  assert.deepEqual(env.dutyWeights.value, {
    扫教室: { 周一: 0.3, 周二: 0.3 },
    拖地: { 周一: 0.7, 周二: 0.7 },
  }, '初始矩阵必须来自同一模式的设置，不能是空对象')
  assert.equal(env.weightLoaded.value, true)
})

test('行为：切模式后先发的旧响应不得覆盖新模式权重', async () => {
  const env = build(src)
  env.dutyMode.value = 'daily'
  const first = env.loadWeight()
  // 用户在请求在途时切到大扫除，触发第二轮加载
  env.dutyMode.value = 'big'
  const second = env.loadWeight()

  // 旧模式的响应后回来
  env.calls[0].resolve({ data: { weights: { 扫教室: { 周一: 0.1 } } } })
  await first
  assert.deepEqual(env.dutyWeights.value, {}, '旧模式权重不能写进当前（大扫除）表')
  assert.equal(env.weightLoaded.value, false, '旧请求不能替新请求宣布「已加载」')

  env.calls[1].resolve({ data: { weights: { 拖地: { 全部: 0.9 } } } })
  await second
  assert.deepEqual(env.dutyWeights.value, { 拖地: { 全部: 0.9 } })
  assert.equal(env.weightLoaded.value, true)
})

test('行为：请求失败只在仍是最新请求时才置错误态', async () => {
  const env = build(src)
  const first = env.loadWeight()
  env.dutyMode.value = 'big'
  const second = env.loadWeight()
  env.calls[0].reject(new Error('daily failed'))
  await first
  assert.equal(env.weightError.value, false, '旧模式的失败不能污染当前模式的错误态')
  env.calls[1].resolve({ data: { weights: {} } })
  await second
  assert.equal(env.weightError.value, false)
})

test('接线：设置与权重各有一张守卫，且并发入口把设置 promise 交给权重', () => {
  const s = src
  assert.match(s, /const settingsLoadGuard = createLatest\(\)/, 'fetchSettings 缺「只认最后一次」守卫')
  assert.match(s, /const weightLoadGuard = createLatest\(\)/, 'loadWeight 缺「只认最后一次」守卫')
  const settingsFn = s.slice(s.indexOf('async function fetchSettings()'))
  assert.match(settingsFn.slice(0, 600), /if \(!settingsLoadGuard\.isCurrent\(token\)\) return/,
    'fetchSettings 写完状态前必须核对守卫')
  const weightFn = functionSource(s, 'loadWeight')
  assert.equal((weightFn.match(/weightLoadGuard\.isCurrent\(token\)/g) || []).length, 4,
    '权重响应、等设置之后、失败分支、收尾各要核对守卫')
  assert.match(weightFn, /await settingsReady/, '空权重分支必须先等设置')
  // 三个并发入口：onMounted / reloadAll / reloadAllFromServer（第 4 处是函数声明本身）
  const passing = s.match(/loadWeight\(settingsReady\)/g) || []
  assert.equal(passing.length, 4, `应为 3 个入口传设置 promise（+1 处函数声明），实际 ${passing.length}`)
  assert.equal((s.match(/const settingsReady = fetchSettings\(\)/g) || []).length, 3)
})

test('变异反证：去掉「等设置」后空矩阵必现', async () => {
  const mutated = src.replace(
    'if (settingsReady) { try { await settingsReady } catch (_) { /* 设置失败：按当前（可能为空的）设置铺 */ } }',
    '',
  )
  assert.ok(mutated !== src, '变异没匹配到等待设置的语句')
  const env = build(mutated)
  const settingsReady = (async () => {
    await tick(20)
    env.settingsItems.value = [{ name: '扫教室', difficulty: 0.3 }]
    env.settingsDays.value = ['周一']
  })()
  const load = env.loadWeight(settingsReady)
  await tick(5)
  env.calls[0].resolve({ data: { weights: {} } })
  await load
  assert.deepEqual(env.dutyWeights.value, {}, '变异后应当铺出空矩阵（判据有效）')
})

test('变异反证：去掉守卫后旧响应会覆盖新模式', async () => {
  const mutated = src.replace(/if \(!weightLoadGuard\.isCurrent\(token\)\) return/g, 'if (false) return')
  assert.ok(mutated !== src, '变异没匹配到守卫判断')
  const env = build(mutated)
  const first = env.loadWeight()
  env.dutyMode.value = 'big'
  const second = env.loadWeight()
  env.calls[0].resolve({ data: { weights: { 扫教室: { 周一: 0.1 } } } })
  await first
  assert.deepEqual(env.dutyWeights.value, { 扫教室: { 周一: 0.1 } }, '变异后旧响应会写入（判据有效）')
  env.calls[1].resolve({ data: { weights: {} } })
  await second
})
