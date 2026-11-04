// 临时探针：跑真实 electron/main/main.dialogs.js 的 select-db-file handler，
// 只把 electron 模块换成替身（不 mock 逻辑本身）。
// 判据：取消 → canceled；.db → 只给文件名；.json → 连文本一起给；超大 → fail；默认目录按上次/数据目录。
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const handlers = new Map()
const calls = []
let pickResult = { canceled: true, filePaths: [] }

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? path.join(os.tmpdir(), 'classnest-probe-userdata') : os.tmpdir()),
    getAppPath: () => ROOT,
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
  dialog: {
    showOpenDialog: async (winOrOpts, maybeOpts) => {
      calls.push(maybeOpts || winOrOpts)
      return pickResult
    },
    showSaveDialog: async () => ({ canceled: true }),
  },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1, bounds: {} }) },
  shell: { openPath: async () => '' },
}

const electronId = require.resolve('electron')
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: fakeElectron }

const { registerDialogsIpc, getDialogDir } = require(path.join(ROOT, 'electron/main/main.dialogs.js'))
registerDialogsIpc({})

const assert = (ok, msg) => {
  if (!ok) { console.log('FAIL  ' + msg); process.exitCode = 1 }
  else console.log('PASS  ' + msg)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'select-db-file-'))
const dbPath = path.join(tmp, 'sub', 'demo.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
fs.writeFileSync(dbPath, 'x')

const jsonPath = path.join(tmp, 'backup.json')
fs.writeFileSync(jsonPath, JSON.stringify({ version: 2, username: '甲' }))

const bigPath = path.join(tmp, 'big.json')
fs.writeFileSync(bigPath, '')
fs.truncateSync(bigPath, 65 * 1024 * 1024)

;(async () => {
  const h = handlers.get('select-db-file')
  assert(typeof h === 'function', 'handler 注册在 select-db-file')

  // 1) 取消
  pickResult = { canceled: true, filePaths: [] }
  const r0 = await h({ sender: {} })
  assert(r0.outcome === 'canceled', '取消 → outcome=canceled（不是 fail）')
  assert(calls[0].defaultPath && calls[0].defaultPath.replace(/\\/g, '/').endsWith('/data'), '首次默认目录落在数据目录：' + calls[0].defaultPath)
  assert(JSON.stringify(calls[0].filters[0].extensions) === '["db","json"]', '.db/.json 过滤器存在')

  // 2) 选 .db
  pickResult = { canceled: false, filePaths: [dbPath] }
  const r1 = await h({ sender: {} })
  assert(r1.outcome === 'ok' && r1.kind === 'db' && r1.name === 'demo.db', '.db → ok/kind=db/name=demo.db')
  assert(r1.text === undefined, '.db 不读文件内容（不给 text）')
  assert(getDialogDir() === path.dirname(dbPath), '记住上次目录 = 选中文件所在目录')

  // 3) 第二次默认目录用上次的
  pickResult = { canceled: true, filePaths: [] }
  await h({ sender: {} })
  assert(calls[calls.length - 1].defaultPath === path.dirname(dbPath), '下次默认目录 = 上次选中目录')

  // 4) 选 .json
  pickResult = { canceled: false, filePaths: [jsonPath] }
  const r2 = await h({ sender: {} })
  assert(r2.outcome === 'ok' && r2.kind === 'json' && r2.name === 'backup.json', '.json → ok/kind=json')
  assert(JSON.parse(r2.text).username === '甲', '.json 带回可解析的文本')

  // 5) 超大备份包
  pickResult = { canceled: false, filePaths: [bigPath] }
  const r3 = await h({ sender: {} })
  assert(r3.outcome === 'fail' && /64MB/.test(r3.error), '超大备份包 → fail 且说明体积上限')

  fs.rmSync(tmp, { recursive: true, force: true })
})()
