// =========================================================================
// open-upload-probe.cjs —— open-upload-file 通道的边界
//
// 这条通道能让渲染层「用系统默认程序打开一个文件」，所以判据的重点不是能打开，
// 而是**只能打开 uploads 目录里的、非可执行的文件**。
//
// 跑的是真实 electron/main/main.dialogs.js handler（只把 electron 换成替身）。
// 运行：node testjs/probe/open-upload-probe.cjs
// =========================================================================
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const handlers = new Map()
const opened = []
const userData = path.join(os.tmpdir(), 'classnest-probe-userdata')

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
    getAppPath: () => ROOT,
  },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async (s) => Buffer.from(s), decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1, bounds: {} }) },
  shell: { openPath: async (p) => { opened.push(p); return '' } },
}

const electronId = require.resolve('electron')
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: fakeElectron }

const { registerDialogsIpc } = require(path.join(ROOT, 'electron/main/main.dialogs.js'))
const { resolveContentDir } = require(path.join(ROOT, 'electron/main/main.config.js'))
registerDialogsIpc({ getMainWindow: () => ({ isDestroyed: () => false }) })

let failed = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failed++; console.log('  ✗ ' + msg) }
}

// 上传目录的真实位置是 <dataDir>/content/uploads（dbManager.paths.js 的 uploadsDir）。
// 早先探针自己也按 <dataDir>/uploads 造夹具，于是 handler 拼错根目录也照样全绿 —— 假绿。
const uploads = path.join(resolveContentDir(), 'uploads')
const receiptTrash = path.join(resolveContentDir(), 'receipt-trash')
fs.mkdirSync(uploads, { recursive: true })
fs.mkdirSync(receiptTrash, { recursive: true })
fs.writeFileSync(path.join(uploads, 'ok.pdf'), 'PDF')
fs.writeFileSync(path.join(uploads, 'bad.exe'), 'MZ')
fs.writeFileSync(path.join(receiptTrash, 'ok.docx'), 'DOCX')
fs.writeFileSync(path.join(receiptTrash, 'bad.exe'), 'MZ')
fs.writeFileSync(path.join(path.dirname(uploads), 'outside.pdf'), 'X')
// handler 抛错时也要清掉夹具文件（T02-06）
process.on('exit', () => {
  const fixtures = [
    path.join(uploads, 'ok.pdf'), path.join(uploads, 'bad.exe'),
    path.join(receiptTrash, 'ok.docx'), path.join(receiptTrash, 'bad.exe'),
    path.join(path.dirname(uploads), 'outside.pdf'),
  ]
  for (const p of fixtures) {
    try { fs.rmSync(p, { force: true }) } catch (_) { /* 已删除 */ }
  }
})

;(async () => {
  const h = handlers.get('open-upload-file')
  ok(typeof h === 'function', 'handler 已注册')

  const r1 = await h({}, { relPath: '/uploads/ok.pdf' })
  ok(r1 && r1.outcome === 'ok' && opened.length === 1, 'uploads 内的 pdf 能交给系统打开')

  // 收据回收站里的 Office 也要能「本地查看」；不传 area 的旧调用仍只认 uploads
  const rTrash = await h({}, { relPath: 'ok.docx', area: 'receiptTrash' })
  ok(rTrash && rTrash.outcome === 'ok' && opened[opened.length - 1] === path.join(receiptTrash, 'ok.docx'),
    'receiptTrash 里的 docx 能交给系统打开')
  const rTrashExe = await h({}, { relPath: 'bad.exe', area: 'receiptTrash' })
  ok(rTrashExe && rTrashExe.outcome === 'fail' && !opened.some((p) => p === path.join(receiptTrash, 'bad.exe')),
    '回收站里的 .exe 同样被执行黑名单拦下')
  const rTrashEscape = await h({}, { relPath: '../../outside.pdf', area: 'receiptTrash' })
  ok(rTrashEscape && rTrashEscape.outcome === 'fail', 'receiptTrash 的 basename 压平也跳不出根目录')

  const r2 = await h({}, { relPath: '../../outside.pdf' })
  ok(r2 && r2.outcome === 'fail', '有 ../ 的路径被拒（basename 压平后找不到文件）')

  const r3 = await h({}, { relPath: '/uploads/bad.exe' })
  ok(r3 && r3.outcome === 'fail', '.exe 被可执行黑名单拦下')
  ok(opened.every((p) => !p.endsWith('.exe')), '可执行文件从未交给 shell.openPath')

  const r4 = await h({}, { relPath: '/uploads/nope.pdf' })
  ok(r4 && r4.outcome === 'fail', '不存在的文件返回 fail')

  const r5 = await h({}, {})
  ok(r5 && r5.outcome === 'fail', '缺参数返回 fail 而不是抛异常')

  const openedBefore = opened.length
  const r6 = await h({}, { relPath: '/uploads/../outside.pdf' })
  ok(r6 && r6.outcome === 'fail' && opened.length === openedBefore, 'uploads 外的文件即使存在也打不开')

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
  process.exit(failed ? 1 : 0)
})()
