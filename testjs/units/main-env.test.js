// =========================================================================
// main-env.test.js —— 开发/打包模式判定单一口径（Electron 45 回归）
//
// 事故面（实测 Electron 45.2.3）：用 `electron .` 从源码启动时 `app.isPackaged` 仍返回 true，
// 而 `process.defaultApp` 同时为 true。于是 `isDev = !app.isPackaged` 判成 false：
//   · 后端去 `resources/app.asar.unpacked/student-backend` 找入口 → spawn ENOENT；
//   · 开发环境跑起「检查更新 + 下载」；
//   · dev-loader（Vite 轮询）被禁用。
//
// 覆盖：
//   ① 三种真实组合的判定结果（打包 / Electron45 源码 / 常规源码）；
//   ② main.env.js 之外不许再出现 `app.isPackaged`（防止以后又各自判一次）；
//   ③ 关键模块确实从 main.env 取值，且更新入口用 isPackaged 把开发环境挡在外面。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MAIN_DIR = path.join(ROOT, 'electron/main')
const ENV_MODULE = path.join(MAIN_DIR, 'main.env.js')
const ENV_ID = require.resolve(ENV_MODULE)
const electronId = require.resolve('electron')

// 每个组合都要一份新的模块实例（isDev 在模块加载时求值）
function loadEnv({ isPackaged, defaultApp }) {
  const prevElectron = require.cache[electronId]
  const prevDefaultApp = process.defaultApp
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: { app: { isPackaged } },
  }
  if (defaultApp === undefined) delete process.defaultApp
  else process.defaultApp = defaultApp
  delete require.cache[ENV_ID]
  try {
    return require(ENV_MODULE)
  } finally {
    if (prevElectron) require.cache[electronId] = prevElectron
    else delete require.cache[electronId]
    if (prevDefaultApp === undefined) delete process.defaultApp
    else process.defaultApp = prevDefaultApp
    delete require.cache[ENV_ID]
  }
}

test('打包版：isPackaged=true 且不是入口 JS 启动 → 生产分支', () => {
  const env = loadEnv({ isPackaged: true, defaultApp: undefined })
  assert.equal(env.isDev, false)
  assert.equal(env.isPackaged, true)
})

test('Electron 45 源码模式：isPackaged 误报 true 时必须仍按开发模式处理', () => {
  const env = loadEnv({ isPackaged: true, defaultApp: true })
  assert.equal(env.isDev, true, 'process.defaultApp=true 就是源码模式，不能被 isPackaged 带偏')
  assert.equal(env.isPackaged, false)
})

test('常规源码模式：isPackaged=false → 开发分支', () => {
  const env = loadEnv({ isPackaged: false, defaultApp: undefined })
  assert.equal(env.isDev, true)
  assert.equal(env.isPackaged, false)
})

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('main.env.js 之外不得再出现 app.isPackaged', () => {
  const files = fs.readdirSync(MAIN_DIR).filter((f) => f.endsWith('.js') && f !== 'main.env.js')
  const offenders = files.filter((f) => /app\.isPackaged/.test(stripComments(fs.readFileSync(path.join(MAIN_DIR, f), 'utf8'))))
  assert.deepEqual(offenders, [], `以下文件仍自行判定打包状态，应改用 main.env：${offenders.join(', ')}`)
})

test('关键模块接线：统一从 main.env 取值，更新入口用 isPackaged 挡住开发环境', () => {
  const read = (f) => fs.readFileSync(path.join(MAIN_DIR, f), 'utf8')
  for (const f of [
    'main.js', 'main.backend.js', 'main.dialogs.js', 'main.protocol.js',
    'main.web-prefs.js', 'main.widget.js', 'main.updater.js', 'main.inpLog.js',
  ]) {
    assert.match(read(f), /require\('\.\/main\.env'\)/, `${f} 必须从 main.env 取开发/打包判定`)
  }
  // 启动 8s 后的自动更新只允许在打包环境跑（否则开发机一直在打 GitHub）
  const mainSrc = stripComments(read('main.js'))
  assert.match(mainSrc, /if \(isPackaged\) \{\s*setTimeout\(\(\) => \{ getUpdater\(\)\.runUpdateFlow\(\) \}/)
  // 后端入口选择必须走 main.env 的 isDev（这是本次 spawn ENOENT 的根因）
  const backendSrc = stripComments(read('main.backend.js'))
  assert.match(backendSrc, /const \{ isDev \} = require\('\.\/main\.env'\)/)
})
