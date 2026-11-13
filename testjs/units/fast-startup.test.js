// =========================================================================
// fast-startup.test.js —— 「性能 → 快速启动」开关
// 运行：npm run test:units
//
// 背景：这个开关原先是一个写在 main.js 里的编译期常量 HOME_SKELETON_ONLY，
// 改成用户可切换的偏好后，有两处必须同时对：
//   1. 存取层（utils/fastStartup.js）：默认开启；'0' 关闭；存储不可用时按默认开启且写入要能回报失败
//   2. 接线：main.js 必须真的去读它（而不是又写回一个常量），设置页必须真的有开关接到写函数上
//
// 第 2 类是「统一入口存在 ≠ 有人用」的防线：只测纯函数的话，
// main.js 仍然硬编码 true 也照样全绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')
const loadFastStartup = () => import(pathToFileURL(path.join(SRC, 'utils/fastStartup.js')).href)

// 极简 localStorage 替身：node 环境没有它，而模块是「调用时」才访问，所以可以在用例里临时挂上
function withStorage(impl, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev)
    else delete globalThis.localStorage
  }
}

const memory = (init) => {
  const map = new Map(init || [])
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    _map: map,
  }
}

// ==================== 存取层 ====================
test('默认（从未设置过）= 开启', async () => {
  const { readFastStartup } = await loadFastStartup()
  withStorage(memory(), () => {
    assert.equal(readFastStartup(), true)
  })
})

test("显式关闭（'0'）才关闭，其余任何值都算开启", async () => {
  const { readFastStartup } = await loadFastStartup()
  withStorage(memory([['fastStartup', '0']]), () => assert.equal(readFastStartup(), false))
  withStorage(memory([['fastStartup', '1']]), () => assert.equal(readFastStartup(), true))
  // 脏数据不应该把用户关进「等数据」模式（那是体验更差的一侧）
  withStorage(memory([['fastStartup', '']]), () => assert.equal(readFastStartup(), true))
  withStorage(memory([['fastStartup', 'yes']]), () => assert.equal(readFastStartup(), true))
})

test('存储读取抛异常时回落到「开启」，不能卡住启动', async () => {
  const { readFastStartup } = await loadFastStartup()
  withStorage({ getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }, () => {
    assert.equal(readFastStartup(), true)
  })
})

test('写入：true → 「1」、false → 「0」，并回 true', async () => {
  const { writeFastStartup } = await loadFastStartup()
  const store = memory()
  withStorage(store, () => {
    assert.equal(writeFastStartup(true), true)
    assert.equal(store._map.get('fastStartup'), '1')
    assert.equal(writeFastStartup(false), true)
    assert.equal(store._map.get('fastStartup'), '0')
    assert.equal(writeFastStartup(0), true)
    assert.equal(store._map.get('fastStartup'), '0', '非布尔假值也要写成关闭')
  })
})

test('写入失败必须回报 false（设置页据此回滚开关，否则显示与生效值不一致）', async () => {
  const { writeFastStartup } = await loadFastStartup()
  withStorage({ getItem: () => null, setItem() { throw new Error('quota') } }, () => {
    assert.equal(writeFastStartup(true), false)
  })
})

test('写进去的值必须能被读回来（读写同一个 key）', async () => {
  const { readFastStartup, writeFastStartup } = await loadFastStartup()
  const store = memory()
  withStorage(store, () => {
    writeFastStartup(false)
    assert.equal(readFastStartup(), false)
    writeFastStartup(true)
    assert.equal(readFastStartup(), true)
  })
})

// ==================== 接线：main.js 必须真的读这个偏好 ====================
test('main.js 用 readFastStartup() 决定是否等数据，且没有回退成硬编码常量', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')
  assert.ok(
    src.includes("from './utils/fastStartup.js'"),
    'main.js 必须从 utils/fastStartup.js 引入存取函数',
  )
  assert.ok(src.includes('readFastStartup()'), 'main.js 必须真的调用 readFastStartup()')
  // 回归防线：常量式开关被引回时这里会红（清空开关就没必要存在了）
  assert.ok(
    !src.includes('HOME_SKELETON_ONLY'),
    'main.js 里又出现了 HOME_SKELETON_ONLY 硬编码常量 —— 面板开关会失效',
  )
  assert.ok(
    /waitData\s*=\s*onHome\s*&&\s*!fastStartup/.test(src),
    '「是否等首页数据」必须由 fastStartup 变量决定',
  )
})

// ==================== 接线：设置页必须真的有这个开关，并接到写函数 ====================
test('设置页性能面板有「快速启动」开关，且接到 onFastStartupChange → writeFastStartup', () => {
  const view = fs.readFileSync(path.join(SRC, 'views/SettingsView/SettingsView.vue'), 'utf8')
  assert.ok(view.includes('快速启动'), '性能面板里必须有「快速启动」文案')
  assert.ok(
    /:model-value="fastStartup"[\s\S]{0,120}@change="onFastStartupChange"/.test(view),
    '开关必须绑定 fastStartup 并触发 onFastStartupChange',
  )
  assert.ok(view.includes('readFastStartup()'), '初值必须直接读存储，避免进页面先显示默认值再跳')

  const methods = fs.readFileSync(path.join(SRC, 'views/SettingsView/SettingsView.appearance.js'), 'utf8')
  assert.ok(
    /onFastStartupChange[\s\S]{0,400}writeFastStartup\(/.test(methods),
    'onFastStartupChange 必须真的写存储（否则开关只在内存里变）',
  )
})

// ==================== 接线：Dashboard 的注释不再指向已删除的常量 ====================
test('DashboardView 注释不再指向已删除的常量名', () => {
  const src = fs.readFileSync(path.join(SRC, 'views/DashboardView.vue'), 'utf8')
  assert.ok(!src.includes('HOME_SKELETON_ONLY'), '注释里还留着已删除的常量名')
})
