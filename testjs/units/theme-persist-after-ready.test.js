// =========================================================================
// theme-persist-after-ready.test.js —— 主题备料失败不能留下「持久态分叉」
//
// `setTheme` 原来在 await 备料（loadThemeStyles / preloadModeBackground）**之前**
// 就 `localStorage.setItem(THEME_KEY, themeId)`。备料抛错时 data-theme 没落到 DOM，
// 但持久态已经是新主题：界面还是旧配色，设置里却显示新主题，下次启动还会去加载
// 那个从没成功过的主题（复核 B2-06 判定成立）。
//
// 判据：把真实的 setTheme 抽出来注入受控依赖，跑「成功 / 备料失败 / 中途改选」三种时序，
// 直接看 THEME_KEY 到底写没写、写在第几步。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '../../student-frontend/src/stores/theme.js')
const SRC = fs.readFileSync(FILE, 'utf8')

// 切出 `const setTheme = async (themeId) => { ... }` 的完整定义
function extractSetTheme(src) {
  const start = src.indexOf('const setTheme = async (themeId) => {')
  assert.ok(start >= 0, '找不到 setTheme')
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('setTheme 的大括号没有配平')
}

// 极简「只认最后一次」守卫，语义与 utils/latestOnly.js 一致
function createLatest() {
  let cur = 0
  return {
    begin: () => { cur += 1; return cur },
    isCurrent: (t) => t === cur,
    invalidate: () => { cur += 1 },
  }
}

function makeEnv({ prepFails = false, order = [] } = {}) {
  const store = new Map([['app-theme', 'glass']])
  const currentTheme = { value: 'glass' }
  const mode = { value: 'day' }
  const themeSwap = createLatest()

  const setItem = (k, v) => {
    order.push(`persist:${v}`)
    store.set(k, v)
  }
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem }

  const loadThemeStyles = async () => {
    order.push('load')
    if (prepFails) throw new Error('CSS 404')
  }
  const preloadModeBackground = async () => { order.push('preload') }
  const performThemeSwap = (fn) => { order.push('swap'); fn() }
  const applyTheme = () => { order.push('apply') }

  const factory = new Function(
    'PRESET_IDS', 'currentTheme', 'localStorage', 'THEME_KEY', 'themeSwap', 'mode',
    'loadThemeStyles', 'preloadModeBackground', 'performThemeSwap', 'applyTheme',
    `${extractSetTheme(SRC)}\nreturn setTheme;`,
  )
  const setTheme = factory(
    ['glass', 'sakura'], currentTheme, localStorage, 'app-theme', themeSwap, mode,
    loadThemeStyles, preloadModeBackground, performThemeSwap, applyTheme,
  )
  return { setTheme, currentTheme, themeSwap, store, order }
}

test('成功：持久态写在备料之后、落地之前', async () => {
  const order = []
  const env = makeEnv({ order })
  await env.setTheme('sakura')

  assert.equal(env.store.get('app-theme'), 'sakura')
  assert.deepEqual(order, ['load', 'preload', 'persist:sakura', 'swap', 'apply'],
    '必须先把 CSS/底图备齐再写 localStorage，最后才改 DOM')
  assert.equal(env.currentTheme.value, 'sakura')
})

test('备料失败：不写持久态，卡片高亮回退，不动 DOM', async () => {
  const order = []
  const env = makeEnv({ prepFails: true, order })
  await env.setTheme('sakura')

  assert.equal(env.store.get('app-theme'), 'glass', '失败时持久态必须还是旧主题')
  assert.equal(env.currentTheme.value, 'glass', '高亮要退回去，否则设置里显示新主题、界面是旧配色')
  assert.equal(order.includes('swap'), false, '没备齐就不该做快照切换')
  assert.equal(order.filter((x) => x.startsWith('persist')).length, 0)
})

test('备料期间用户又选了别的主题：这一次不写持久态（交给后一次落地）', async () => {
  const order = []
  const env = makeEnv({ order })
  const p = env.setTheme('sakura')
  env.themeSwap.invalidate() // 模拟又点了一张卡片
  await p

  assert.equal(env.store.get('app-theme'), 'glass', '被后来者取代的那次不能写持久态')
  assert.equal(order.includes('swap'), false)
})

test('未知主题 id 与重复点选都不写持久态', async () => {
  const order = []
  const env = makeEnv({ order })
  await env.setTheme('not-a-theme')
  await env.setTheme('glass') // 已是当前主题
  assert.deepEqual(order, [])
  assert.equal(env.store.get('app-theme'), 'glass')
})
