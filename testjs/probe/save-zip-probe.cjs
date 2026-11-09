// =========================================================================
// save-zip-probe.cjs —— save-file 通道能不能落 .zip
//
// 背景：设置页「数据管理」把多张表打成一个 zip，落盘走的还是 saveBlobWithDialog
// → IPC save-file。而 save-file 有一份扩展名白名单（ALLOWED_SAVE_EXTS），
// 名单里没有 .zip 时，整条导出链在最后一步被拒，用户只看到「不支持保存为该文件类型」，
// 完全看不出是主进程漏登记。
//
// 这个探针跑的是**真实的 main.dialogs.js handler**（只把 electron 换成替身），
// 所以能锁住「白名单里有没有 .zip」这件事，而不只是读一遍常量。
//
// 运行：node testjs/probe/save-zip-probe.cjs
// =========================================================================
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const handlers = new Map()
let saveResult = { canceled: true }
let lastSaveOpts = null

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? path.join(os.tmpdir(), 'classnest-probe-userdata') : os.tmpdir()),
    getAppPath: () => ROOT,
  },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async (s) => Buffer.from(s), decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async (_win, opts) => {
      lastSaveOpts = opts
      return saveResult
    },
  },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1, bounds: {} }) },
  shell: { openPath: async () => '' },
}

const electronId = require.resolve('electron')
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: fakeElectron }

const { registerDialogsIpc } = require(path.join(ROOT, 'electron/main/main.dialogs.js'))
registerDialogsIpc({ getMainWindow: () => ({ isDestroyed: () => false }) })

let failed = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failed++; console.log('  ✗ ' + msg) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-zip-'))
const payload = Buffer.from('PK\u0003\u0004 fake zip body', 'utf8')
const arrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)

;(async () => {
  const h = handlers.get('save-file')
  ok(typeof h === 'function', 'save-file handler 已注册')

  // 1) 正常保存 .zip
  const zipPath = path.join(tmp, '班级数据导出_2026-11-05.zip')
  saveResult = { canceled: false, filePath: zipPath }
  const r1 = await h({}, { defaultName: '班级数据导出_2026-11-05.zip', data: arrayBuffer })
  ok(r1 && r1.outcome === 'ok', '保存 .zip 返回 outcome=ok（白名单已放行）')
  ok(fs.existsSync(zipPath) && fs.readFileSync(zipPath).equals(payload), '.zip 内容按字节写入磁盘')
  ok(lastSaveOpts && String(lastSaveOpts.defaultPath).endsWith('.zip'), '保存对话框的扩展名过滤器是 zip')

  // 2) 不支持的扩展名（默认名）→ fail，且不能是 canceled
  saveResult = { canceled: false, filePath: path.join(tmp, 'x.exe') }
  const r2 = await h({}, { defaultName: 'x.exe', data: arrayBuffer })
  ok(r2 && r2.outcome === 'fail', '默认名 .exe 被拒（outcome=fail）')

  // 3) 用户在对话框里把 .zip 改成 .exe → 落盘前二次校验要拦住
  const sneaky = path.join(tmp, 'sneaky.exe')
  saveResult = { canceled: false, filePath: sneaky }
  const r3 = await h({}, { defaultName: 'ok.zip', data: arrayBuffer })
  ok(r3 && r3.outcome === 'fail', '对话框改成 .exe 被二次校验拒掉')
  ok(!fs.existsSync(sneaky), '.exe 没有被写出来')

  // 4) 用户取消仍是 canceled（别把取消当失败）
  saveResult = { canceled: true }
  const r4 = await h({}, { defaultName: 'a.zip', data: arrayBuffer })
  ok(r4 && r4.outcome === 'canceled', '用户取消 → outcome=canceled')

  // 5) 收据「另存」的类型必须能真的写盘（jpg / docx / mp4 之类）。
  //    白名单原本只有导出格式，收据能上传却存不出去 —— 用户看到「不支持保存为该文件类型」。
  for (const name of ['收据照片.jpg', '采购单.docx', '班会录像.mp4']) {
    const p = path.join(tmp, name)
    saveResult = { canceled: false, filePath: p }
    const r = await h({}, { defaultName: name, data: arrayBuffer })
    ok(r && r.outcome === 'ok' && fs.existsSync(p), `收据「另存」${name} 能写盘（白名单已放行）`)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
  process.exit(failed ? 1 : 0)
})()
