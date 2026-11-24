// =========================================================================
// updater-manual-install.test.js —— 更新链不再静默执行未签名安装包
//
// 背景：V8 C-6（更新链信任根）未施工，安装包没有发布者签名。原实现下载完
// 直接 spawn exe + /SILENT 静默安装，完全绕过 Windows 的 UAC / SmartScreen。
// 新方案：主进程只做安装前复核，然后 shell.openPath 把安装包交给用户手动装；
// dev mock 场景绝不执行假包，只在文件管理器里定位。
//
// 判据：①纯函数真跑（源解析 / 安装动作选择）；②抽出真实 UPDATE_INSTALL
// handler 的 body 注入假依赖执行，验证两条路径与失败分支；③静态确认静默
// 安装线索清零。全部为执行判据，不是「文件读完」式假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const UPDATER = path.join(ROOT, 'electron/main/main.updater.js')
const CODE = fs.readFileSync(UPDATER, 'utf8')

// 直接 require 会执行 updater 顶层的 app.getVersion()，这里只 mock electron 两个字段。
function loadUpdater() {
  const m = new Module(UPDATER, null)
  m.filename = UPDATER
  m.paths = Module._nodeModulePaths(path.dirname(UPDATER))
  const origLoad = Module._load
  Module._load = function (req) {
    if (req === 'electron') return { app: { getVersion: () => '0.1.0' }, shell: {} }
    return origLoad.apply(this, arguments)
  }
  try { m._compile(CODE, UPDATER) } finally { Module._load = origLoad }
  return m.exports
}

const updater = loadUpdater()

// ---------------- 纯函数：更新源解析 ----------------

test('resolveUpdateEndpoints：仅 dev + 回环 http 走 mock，打包环境恒 GitHub', () => {
  const mock = 'http://127.0.0.1:18499'
  const devResult = updater.resolveUpdateEndpoints({ CLASSNEST_UPDATE_MOCK_BASE: mock }, true)
  assert.equal(devResult.allowLocalMock, true)
  assert.equal(devResult.apiUrl, mock + '/releases/latest')

  const prodResult = updater.resolveUpdateEndpoints({ CLASSNEST_UPDATE_MOCK_BASE: mock }, false)
  assert.equal(prodResult.allowLocalMock, false, '打包环境不能靠环境变量换更新源')
  assert.match(prodResult.apiUrl, /^https:\/\/api\.github\.com\//)

  assert.equal(updater.resolveUpdateEndpoints({}, true).allowLocalMock, false)
  assert.equal(updater.resolveUpdateEndpoints({ CLASSNEST_UPDATE_MOCK_BASE: 'http://192.168.1.9:18499' }, true).allowLocalMock, false)
  assert.equal(updater.resolveUpdateEndpoints({ CLASSNEST_UPDATE_MOCK_BASE: 'https://evil.example' }, true).allowLocalMock, false)
})

test('resolveInstallAction：只有 dev + mock 才定位假包，打包环境永远打开', () => {
  assert.equal(updater.resolveInstallAction({ dev: true, allowLocalMock: true }), 'reveal')
  assert.equal(updater.resolveInstallAction({ dev: true, allowLocalMock: false }), 'open')
  assert.equal(updater.resolveInstallAction({ dev: false, allowLocalMock: true }), 'open', '即使误配 mock，打包环境也不能定位假包')
  assert.equal(updater.resolveInstallAction({ dev: false, allowLocalMock: false }), 'open')
})

// ---------------- 真跑安装 handler ----------------

function extractInstallBody(code) {
  const mark = 'IPC.on(CH.UPDATE_INSTALL, async () => {'
  const start = code.indexOf(mark)
  assert.ok(start > 0, '找不到 UPDATE_INSTALL handler')
  const brace = start + mark.length - 1
  let depth = 0
  for (let i = brace; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(brace + 1, i)
    }
  }
  throw new Error('括号不配平')
}

const USER_DATA = path.join(path.sep, 'fake-userData')
const CACHE_DIR = path.join(USER_DATA, 'update-cache')
const INSTALLER = path.join(CACHE_DIR, 'ClassNest-Setup-99.0.0.exe')
const FILE_SIZE = 1024
const GOOD_DIGEST = 'a'.repeat(64)

async function runInstall({
  packaged = true,
  allowLocalMock = false,
  tampered = false,
  sizeMismatch = false,
  openError = '',
} = {}) {
  const body = extractInstallBody(CODE)
  const states = []
  const calls = []
  const deps = {
    app: { getPath: () => USER_DATA },
    fs: {
      existsSync: () => true,
      statSync: () => ({ size: sizeMismatch ? FILE_SIZE + 1 : FILE_SIZE }),
      rmSync: () => calls.push('rm'),
    },
    path,
    sha256File: async () => (tampered ? 'b'.repeat(64) : GOOD_DIGEST),
    setUpdateState: (patch) => states.push(patch),
    resolveUpdateEndpoints: () => ({ allowLocalMock }),
    resolveInstallAction: updater.resolveInstallAction,
    shell: {
      openPath: async () => { calls.push('openPath'); return openError },
      showItemInFolder: () => { calls.push('showItemInFolder') },
    },
    isPackaged: packaged,
    state: { path: INSTALLER, digest: GOOD_DIGEST, size: FILE_SIZE },
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('deps', `
    const { app, fs, path, sha256File, setUpdateState, resolveUpdateEndpoints,
      resolveInstallAction, shell, isPackaged, state } = deps
    let installBusy = false
    let downloadedInstallerPath = state.path
    let downloadedInstallerDigest = state.digest
    let downloadedInstallerSize = state.size
    ${body}
  `)
  await fn(deps)
  return { states, calls, last: states[states.length - 1] || {} }
}

test('打包环境：复核通过后 openPath 打开安装包，不执行、不退出、状态 opened', async () => {
  const r = await runInstall({ packaged: true })
  assert.deepEqual(r.calls, ['openPath'], '必须交给 Windows 安装向导，且不能静默执行')
  assert.equal(r.last.status, 'opened')
  assert.equal(r.last.error, null)
})

test('dev mock：只定位假包，绝不 openPath / 执行', async () => {
  const r = await runInstall({ packaged: false, allowLocalMock: true })
  assert.deepEqual(r.calls, ['showItemInFolder'], '假 exe 绝不能被 openPath 执行')
  assert.equal(r.last.status, 'opened')
})

test('包被替换：清掉可疑文件、报错，绝不打开', async () => {
  const r = await runInstall({ tampered: true })
  assert.deepEqual(r.calls, ['rm'])
  assert.equal(r.last.status, 'error')
  assert.match(r.last.error, /文件已改变/)
})

test('大小不符：报错，绝不打开', async () => {
  const r = await runInstall({ sizeMismatch: true })
  assert.deepEqual(r.calls, ['rm'])
  assert.match(r.last.error, /大小不符/)
})

test('openPath 失败：报错但应用不退出，用户仍留在界面里', async () => {
  const r = await runInstall({ openError: 'no app associated' })
  assert.deepEqual(r.calls, ['openPath'])
  assert.equal(r.last.status, 'error')
  assert.match(r.last.error, /打开安装包失败/)
})

test('静态：静默安装线索清零（child_process / SILENT / app.quit / stopBackend）', () => {
  // 只查代码行：注释里保留「历史漏洞为什么危险」的说明是必要的，不算回退。
  const codeLines = CODE.split('\n').filter((line) => !line.trimStart().startsWith('//'))
  for (const dead of ['child_process', '/SILENT', '/CLOSEAPPLICATIONS', 'app.quit(', 'stopBackend']) {
    assert.ok(!codeLines.some((line) => line.includes(dead)), `不应再出现静默安装线索：${dead}`)
  }
  assert.match(CODE, /shell\.openPath\(resolved\)/)
  assert.match(CODE, /shell\.showItemInFolder\(resolved\)/)
})
