// =========================================================================
// dialogs.js —— 文件/文件夹对话框与本地文件读写类 IPC
//
// 汇总主进程里「弹系统对话框 + 读写本地文件」的一组请求-响应通道：
//   select-folder / open-folder / save-background-image /
//   save-file / open-file / screenshot-capture / note-save / get-data-directories
//
// 记忆上次访问目录：Electron 43 起未传 defaultPath 时对话框默认打开「下载」目录，
// 且系统不再记忆上次访问目录（43.0 breaking change）；这里自行记忆并回填，恢复旧体验。
//
// 依赖注入：窗口引用由 main.js 通过 registerDialogsIpc 注入（getMainWindow / getWidgetWindow），
// 本模块不直接持有窗口变量；lastDialogDir 作为本模块内部状态并提供 getter/setter 供 apps.js 复用。
// =========================================================================

const { app, BrowserWindow, desktopCapturer, screen, dialog, shell } = require('electron')
const { CH, IPC } = require('./channels')
const path = require('path')
const fs = require('fs')
const { resolveDataDir, resolveThumbsDir, resolveSkillsDir } = require('./main.config')
const {
  resolveSafeFolder,
  resolveSafeWriteDir,
  resolveSafeOpenFile,
  markFileWritten,
  sanitizeSuggestedName,
} = require('./main.path-guard')
// 结果契约：成功 / 失败 / 取消三种结局分开表达（见 main.ipc-contract.js 顶部注释）。
// 修 B01-06：写盘失败原先返回 { canceled: true }，前端只认 !canceled → 失败被当成取消。
const contract = require('./main.ipc-contract')

const fsp = fs.promises

const { isDev } = require('./main.env')

// 渲染层 → 主进程 → 写盘通道的统一体积上限：避免超大 payload 在主进程再复制一份。
const MAX_WRITE_BYTES = 50 * 1024 * 1024
// 一键截屏的 JPEG 质量：90 在界面截图上肉眼几乎无差，编码耗时只有 PNG 的 1/10 左右
const JPEG_QUALITY = 90
// save-file 只服务导出类文件；扩展名由用户可在对话框里改，因此最终路径还要再校验一次。// 白名单与「前端/后端实际能产出的格式」严格对账（见 testjs/probe/export-format-probe.cjs）：
// 少一个 → 那个格式导出必然被拒；多一个 → 白给一个写盘口子。
// 注：原先含 '.htm'，但没有任何出口产出该扩展名（.html 已覆盖），属于多开的口子，已去掉。
// '.zip' 供设置页「数据管理」的多表打包导出（student-backend/routes/dataExport.js 生成、
// 前端走同一个 saveBlobWithDialog 落盘）。加之前这条链路一定在写盘那一步被拒，
// 用户只看到「不支持保存为该文件类型」——白名单漏登记的典型症状。
//
// 收据「另存」也走这条通道，而它的文件名来自文件本身（扩展名动态），
// 所以白名单必须覆盖「能上传的每一种收据类型」—— 与后端 uploadSignatures.js 的 KINDS 对齐。
// 漏一个的表现是：文件传得上来，却存不出去（同样报「不支持保存为该文件类型」）。
// 这里全是文档 / 图片 / 视频，不含任何可执行类型；能不能用系统程序打开是另一条通道
// （open-upload-file）的黑名单在管，两条通道互不影响。
const ALLOWED_SAVE_EXTS = new Set([
  '.html', '.xlsx', '.csv', '.md', '.txt', '.json', '.png', '.pdf', '.zip',
  '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.doc', '.docx', '.xls', '.ppt', '.pptx',
  '.mp4', '.webm',
])

// open-upload-file 的黑名单：收据里的 Office/PDF 要用系统程序打开，但绝不能让这条
// 通道变成「启动任意程序」的口子。用黑名单而不是白名单，是为了以后新收据格式
// （比如 heic）不用同步改两处就能打开；而这些可执行类型上传时本来就被魔数拦掉了。
const BLOCKED_OPEN_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.scr', '.cpl', '.dll', '.lnk', '.hta', '.reg', '.jar', '.pif',
])

// 上次访问的目录（跨各对话框共享）
let lastDialogDir = null
function getDialogDir() { return lastDialogDir }
function setDialogDir(dir) { lastDialogDir = dir }

// 窗口引用出口：由 registerDialogsIpc 注入
let getMainWindow = () => null
let getWidgetWindow = () => null
// widget 的「点击穿透」态只能记在 widget 模块里（Electron 无 getter），这里注入读取器：
// 截屏会把 widget 临时隐藏，结束后必须还原成进入前的状态，而不是一律恢复成可点击。
let isWidgetIgnoreMouse = () => false
// 穿透态的**写入器**同样要注入：截屏结束时要把窗口恢复成进入前的穿透态，
// 若只调 setIgnoreMouseEvents 而不更新 widget 模块记录的状态，
// 两者就会不一致（记录说「可点击」而窗口实际是穿透），下一次截屏又按错的值还原。
let setWidgetIgnoreMouse = () => {}

function registerDialogsIpc(opts = {}) {
  if (typeof opts.getMainWindow === 'function') getMainWindow = opts.getMainWindow
  if (typeof opts.getWidgetWindow === 'function') getWidgetWindow = opts.getWidgetWindow
  if (typeof opts.isWidgetIgnoreMouse === 'function') isWidgetIgnoreMouse = opts.isWidgetIgnoreMouse
  if (typeof opts.setWidgetIgnoreMouse === 'function') setWidgetIgnoreMouse = opts.setWidgetIgnoreMouse

  // 选择文件夹对话框
  // 返回 Electron 原生的 result（canceled/filePaths）—— 前端依赖这两个字段，不改形状。
  // 只用 contract.safeReject 补异常兜底：dialog 抛错时原先直接 reject，
  // 渲染层拿到的是 "Error invoking remote method"，真实原因全丢。
  IPC.handle(CH.SELECT_FOLDER, contract.safeReject(async (event) => {
    // 以调用方所在窗口为父窗口：首次安装引导期还没有主窗口，此时用引导窗口作父窗口，
    // 否则（mainWindow 为空）会直接返回空数组，导致引导里的「修改」按钮点了没反应。
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    const mainWindow = getMainWindow()
    const parent = (senderWin && !senderWin.isDestroyed())
      ? senderWin
      : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
    const opts = {
      properties: ['openDirectory'],
      defaultPath: lastDialogDir || undefined,
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    if (!result.canceled && result.filePaths.length > 0) {
      lastDialogDir = result.filePaths[0]
    }
    return result
  }))

  // 在文件管理器中打开指定文件夹
  // 保持原语义：路径非法时**返回** { error }（不 reject）—— 前端 AlbumManageDialog
  // 的 try/catch 只在 reject 时触发，改成 reject 会让它的错误提示多弹一次，
  // 那是行为变更、不在本次范围。契约层只把返回形状补齐（success 字段）。
  IPC.handle(CH.OPEN_FOLDER, contract.safe(async (event, folderPath) => {
    // 渲染层传什么路径都不能直接交给系统：只放行已存在、非盘符根、非系统保护目录的绝对路径
    const safe = resolveSafeFolder(folderPath)
    if (safe.error) return contract.fail(safe.error)
    shell.openPath(safe.path)
    return contract.ok()
  }))

  // ========== 数据目录 / 缓存目录（可自定义，含整体搬迁） ==========
  // 当前数据目录与缓存目录信息（供设置页展示）
  IPC.handle(CH.GET_DATA_DIRECTORIES, () => {
    return {
      dataDir: resolveDataDir(),
      thumbsDir: resolveThumbsDir(),
      skillsDir: resolveSkillsDir(),
      defaultDataDir: path.join(app.getPath('userData'), 'data'),
      screenshotDir: path.join(app.getPath('pictures'), 'screenshots'),
    }
  })

  // 「选择图片文件」通道（select-image-file）已删除：
  //   设置页的背景图改用 <input type="file"> + save-background-image（base64 直传），
  //   前端已无任何一处调用它。留着等于给主进程多开一个能读本地文件的口子（审查 v4 · B01-01）。

  // 保存背景图片（用于大图片，前端传入 base64）
  // 写盘改成异步：背景图动辄几 MB，writeFileSync 会把主进程阻塞到写完为止。
  IPC.handle(CH.SAVE_BACKGROUND_IMAGE, contract.safe(async (event, { name, base64 }) => {
    try {
      // 与「选择图片」路径对齐的 50MB 上限：base64 入口原先没有大小校验，
      // 一次超大 payload 就会在主进程里解码出数倍内存（B01-09）。
      // 与 note-save/save-file 共用同一个 50MB 上限，避免三处各写一份常量
      if (typeof base64 !== 'string' || base64.length === 0) {
        return contract.fail('缺少图片数据')
      }
      // 先按 base64 长度粗判（约为原始字节的 4/3），避免把超大字符串解码进内存
      if (base64.length > Math.ceil(MAX_WRITE_BYTES / 3) * 4) {
        return contract.fail('背景图片不能超过 50MB')
      }
      const bgDir = path.join(app.getPath('userData'), 'data', 'uploads', 'background')
      // mkdir recursive 在目录已存在时不报错，省掉一次 existsSync 同步探测
      await fsp.mkdir(bgDir, { recursive: true })
      // 扩展名来自渲染层传入的文件名：只接受图片扩展，其余统一按 .png 落盘，
      // 避免把 IPC 当任意扩展名写盘入口使用
      const ALLOWED_BG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
      let ext = name ? path.extname(String(name)).toLowerCase() : ''
      if (!ALLOWED_BG_EXT.has(ext)) ext = '.png'
      const fileName = `bg_${Date.now()}${ext}`
      const destPath = path.join(bgDir, fileName)
      // 将 base64 写入文件
      const buffer = Buffer.from(base64, 'base64')
      if (buffer.length > MAX_WRITE_BYTES) {
        return contract.fail('背景图片不能超过 50MB')
      }
      await fsp.writeFile(destPath, buffer)
      // 根据环境返回不同的 URL
      let imageUrl
      if (isDev) {
        imageUrl = `/api/background/${fileName}`
      } else {
        imageUrl = `http://127.0.0.1:3000/api/background/${fileName}`
      }
      return contract.ok({ url: imageUrl, fileName })
    } catch (err) {
      return contract.fail(err)
    }
  }))

  // 导出文件保存对话框：用户确认保存后才写入文件并返回
  // 包 contract.safe：dialog.showSaveDialog 本身也可能抛（窗口在弹出瞬间被销毁），
  // 原先这类异常直接 reject，渲染层拿到的真实原因全丢。
  IPC.handle(CH.SAVE_FILE, contract.safe(async (event, { defaultName, data } = {}) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return contract.fail('主窗口不可用')
    // 数据体积先判：字符串按 UTF-8 字节数，ArrayBuffer/TypedArray 按 byteLength。
    // Buffer.from 会在主进程再持有一份等量内存，不设上限等于把 IPC 当内存放大器。
    const dataBytes = typeof data === 'string'
      ? Buffer.byteLength(data, 'utf8')
      : (data && typeof data.byteLength === 'number' ? data.byteLength : -1)
    if (dataBytes < 0) return contract.fail('文件数据格式无效')
    if (dataBytes > MAX_WRITE_BYTES) return contract.fail('导出文件不能超过 50MB')
    // 建议文件名来自渲染层（可能被注入成 ../x 这类串）：统一压平成纯文件名再拼进 defaultPath
    const name = sanitizeSuggestedName(defaultName)
    const ext = path.extname(name).toLowerCase()
    if (ext && !ALLOWED_SAVE_EXTS.has(ext)) {
      return contract.fail('不支持保存为该文件类型')
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: lastDialogDir ? path.join(lastDialogDir, name) : name,
      filters: ext ? [{ name: '文件', extensions: [ext.replace('.', '')] }] : undefined
    })
    // 用户主动点了取消：这是「取消」不是「失败」，前端不该弹错误提示
    if (result.canceled || !result.filePath) return contract.canceled()
    // 用户可在保存对话框里改扩展名：落盘前按最终路径再校验一次，防止把 save-file 当任意写盘入口
    const targetExt = path.extname(result.filePath).toLowerCase()
    if (!ALLOWED_SAVE_EXTS.has(targetExt)) {
      return contract.fail('不支持保存为该文件类型')
    }
    try {
      const buffer = Buffer.from(data)
      // 异步写：导出的 xlsx/pdf 可能几十 MB，同步写会让窗口在写盘期间完全无响应
      await fsp.writeFile(result.filePath, buffer)
      lastDialogDir = path.dirname(result.filePath)
      // 登记「本应用写过的文件」：open-file 只允许打开这里登记过的路径，
      // 防止渲染层被注入后把任意 exe 交给 shell.openPath。
      markFileWritten(result.filePath)
      return contract.ok({ filePath: result.filePath })
    } catch (err) {
      // 写盘失败 ≠ 用户取消：这里必须走 fail()（B01-06）。
      // 原先返回 { canceled: true, error } —— 前端 saveBlobWithDialog 只看 !result.canceled，
      // 于是失败被当成取消，界面一声不吭，用户以为「我取消了」实际是「没写出来」。
      return contract.fail(err)
    }
  }))

  // 导出文件保存后：用系统默认应用打开
  IPC.handle(CH.OPEN_FILE, contract.safe(async (event, { filePath }) => {
    if (!filePath) return contract.fail('缺少文件路径')
    const safe = resolveSafeOpenFile(filePath)
    if (safe.error) return contract.fail(safe.error)
    try {
      const error = await shell.openPath(safe.path)
      // shell.openPath 用「返回错误字符串」表示失败（非 reject）：空串 = 成功
      if (error) return contract.fail(error)
      // error: null 保持旧形状（原先成功时也是 { success: true, error: null }）
      return contract.ok({ error: null })
    } catch (err) {
      return contract.fail(err)
    }
  }))

  // 打开上传目录里的文件（收据里的 PDF / Office / 视频）：用系统默认程序。
  //
  // 为什么不复用 open-file：那条通道只认「本进程通过 save-file 写过的路径」，
  // 目的是防止渲染层被注入后把任意 exe 交给 shell.openPath。收据是上传时直接写进
  // uploads 的，不在那个名单里，所以需要一条范围同样小的旁路：
  //   · 只认 uploads 根目录下的文件名（basename 压平，穿越不出去）
  //   · 挡掉可执行扩展名（见 BLOCKED_OPEN_EXTS）
  IPC.handle(CH.OPEN_UPLOAD_FILE, contract.safe(async (event, { relPath } = {}) => {
    const root = path.resolve(path.join(resolveDataDir(), 'uploads'))
    const name = path.basename(String(relPath || ''))
    if (!name || name === '.' || name === '..') return contract.fail('缺少文件路径')
    const abs = path.join(root, name)
    if (!abs.startsWith(root + path.sep)) return contract.fail('路径不在上传目录内')
    if (!fs.existsSync(abs)) return contract.fail('文件不存在')
    if (BLOCKED_OPEN_EXTS.has(path.extname(abs).toLowerCase())) {
      return contract.fail('不支持用系统程序打开该文件类型')
    }
    try {
      const error = await shell.openPath(abs)
      // shell.openPath 用「返回错误字符串」表示失败：空串 = 成功
      if (error) return contract.fail(error)
      return contract.ok({ error: null })
    } catch (err) {
      return contract.fail(err)
    }
  }))

  // 一键截屏：截取整个屏幕并保存到本地
  // options.hideWidget: 是否隐藏 widget 窗口（默认 true）。
  //
  // ⚠️ 这条路对**工具箱浮窗无效**：它在 main.widget.js 里是 `transparent: true`，
  //   而 Windows 上 setOpacity 对透明窗口不生效 —— 「setOpacity(0) + 等 150ms」等于没做，
  //   抓出来的图里照样有浮窗自己。
  //   所以浮窗里的调用方（Note.vue / Screenshot.vue）必须**自己先藏内容**
  //   （见 student-frontend/src/subwindows/widget/captureHide.js），并传 hideWidget:false
  //   省掉这段必然无效的等待。这里的隐藏只对非透明窗口的调用方有意义。
  IPC.handle(CH.SCREENSHOT_CAPTURE, contract.safe(async (event, options) => {
    const widgetWindow = getWidgetWindow()
    const hideWidget = options?.hideWidget !== false
    let wasVisible = false
    // 进入前的穿透态：截屏结束后要原样还回去
    let wasIgnoreMouse = false
    if (hideWidget && widgetWindow && !widgetWindow.isDestroyed()) {
      wasVisible = widgetWindow.isVisible()
      wasIgnoreMouse = isWidgetIgnoreMouse()
      if (wasVisible) widgetWindow.setOpacity(0)
      // 等待一帧确保窗口已隐藏
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    try {
      const primaryDisplay = screen.getPrimaryDisplay()
      const { width, height } = primaryDisplay.size
      const scaleFactor = primaryDisplay.scaleFactor || 1

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) }
      })

      const primarySource = sources.find(s => s.display_id === String(primaryDisplay.id)) || sources[0]
      // sources 可能为空（无可截取的屏幕 / 系统限制）：原代码直接 primarySource.thumbnail
      // 会抛 TypeError（读 undefined 的属性）→ handler reject → 前端拿到的是
      // Electron 包装的 "Error invoking remote method"，真实原因全丢（B01-10）。
      if (!primarySource) return contract.fail('没有可截取的屏幕')
      // 用 JPEG 而不是 PNG：同一屏实测 toPNG 172ms / 0.51MB，toJPEG(90) 15ms / 0.24MB。
      // 截屏是「点一下就要结果」的操作，编码时间比无损更值得省；质量 90 对界面截图够用。
      const image = primarySource.thumbnail.toJPEG(JPEG_QUALITY)
      const imageExt = 'jpg'
      const imageMime = 'image/jpeg'

      const defaultSaveDir = path.join(app.getPath('pictures'), 'screenshots')
      // saveDir 来自设置页（可自定义），不能直接 mkdir/write：只接受非盘符根、非系统保护目录
      const safeDir = resolveSafeWriteDir(options?.saveDir, defaultSaveDir)
      if (safeDir.error) return contract.fail(safeDir.error)
      const saveDir = safeDir.path
      // 整屏图常有几 MB，写盘走异步，避免截图瞬间主进程冻结
      await fsp.mkdir(saveDir, { recursive: true })

      // 精度必须到毫秒：只到秒时 1 秒内连存两次会生成同名文件，writeFile 直接把上一次的覆盖掉（静默丢数据）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
      const filePath = path.join(saveDir, `screenshot_${timestamp}.${imageExt}`)
      await fsp.writeFile(filePath, image)

      // dataUrl 仅按需生成：整屏图 base64 在主进程/IPC/渲染进程各持一份，
      // 内存开销大。默认生成以兼容旧调用；调用方（Screenshot.vue）不需要时可关闭。
      const withDataUrl = options?.withDataUrl !== false
      const dataUrl = withDataUrl ? `data:${imageMime};base64,${image.toString('base64')}` : ''
      return contract.ok({ filePath, dataUrl })
    } finally {
      // 恢复 widget 窗口透明度
      if (wasVisible && widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.setOpacity(1)
        // 恢复鼠标事件：必须还原成进入前的穿透态，不能一律 setIgnoreMouseEvents(false)。
        // 原来无条件取消穿透，会让设计成「点击穿透桌面」的浮窗截屏后开始吞掉桌面点击。
        // 走注入的写入器（而不是直接调 setIgnoreMouseEvents）：写入器会同时更新
        // widget 模块里记录的状态，避免「记录」与「窗口实际」不一致。
        setWidgetIgnoreMouse(widgetWindow, wasIgnoreMouse)
        // 穿透态下不该抢焦点（否则又把焦点从用户正在用的窗口拿走）
        if (!wasIgnoreMouse) widgetWindow.focus()
      }
    }
  }))

  // ===== 截屏选区（AI 对话里「截屏发图」用）=====
  // 三步配合完成「主窗口保持可见 → 框选区域 → 确定/取消」：
  //   1) screenshot-region：主窗口保持可见（截屏画面带上应用界面），仅把工具箱临时透明后截取主屏，返回冻结画面
  //   2) screenshot-region-show：渲染层画好冻结画面后，主窗口铺满整屏并置顶，作为选区遮罩
  //   3) screenshot-region-end：把主窗口还原到截屏前的尺寸/层级
  // 主窗口上的 AI 浮窗由渲染层在调用前先收起，避免浮窗被截进画面。
  // 裁剪由渲染层用 canvas 完成，不必把整屏数据再传回主进程。
  //
  // ===== 状态归属（审查 v4 · B01-05）=====
  // 原先 regionState 是模块级可变状态，**只由渲染层主动调 region-end 才释放**。
  // 但渲染层可能：
  //   · 崩溃 / 被关闭 → endRegionSelect 里的 invoke 被 catch 静默吞掉，主进程永远收不到；
  //   · 只走到 region 就失败 → 同样收不到。
  // 后果是主窗口**永久停在「铺满整屏 + 置顶」**，用户点不到任何东西；
  // 且 regionState 永不释放 → 之后每次截图都返回「已有截屏进行中」，功能彻底卡死。
  //
  // 修法：把它从「模块级全局」改成「**一次选区会话**」，并给它两个必然的终点：
  //   1) 看门狗超时：窗口已铺满置顶后超过 REGION_SESSION_TIMEOUT_MS 仍未 end → 自动还原；
  //   2) 窗口关闭：主窗口 closed → 立即清掉会话（窗口都没了，没什么可还原的）。
  // 这样无论渲染层走没走到 end，主进程都能自愈。
  const REGION_SESSION_TIMEOUT_MS = 120000
  let regionSession = null

  function setWinOpacity(win, opacity) {
    if (win && !win.isDestroyed()) {
      try { win.setOpacity(opacity) } catch (_) { /* 忽略 */ }
    }
  }

  // 会话看门狗：到点仍未收到 region-end 就自动还原。
  // 只在「窗口已被铺满置顶」期间才 armed —— 那才是卡死的真正危害点。
  function armRegionWatchdog(st) {
    clearRegionWatchdog(st)
    st.timer = setTimeout(() => {
      console.warn('[dialogs] 截屏选区超时未结束，自动还原窗口状态')
      restoreAfterRegion()
    }, REGION_SESSION_TIMEOUT_MS)
    // unref：看门狗只是兜底，不该阻止进程退出
    if (st.timer && typeof st.timer.unref === 'function') st.timer.unref()
  }

  function clearRegionWatchdog(st) {
    if (!st || !st.timer) return
    clearTimeout(st.timer)
    st.timer = null
  }

  // 还原截屏前的窗口状态：正常结束与异常兜底共用
  function restoreAfterRegion() {
    const st = regionSession
    regionSession = null
    if (!st) return
    clearRegionWatchdog(st)
    // 正常结束也要摘掉 closed 监听，避免每次截图累积一个一次性的窗口监听
    if (st.onWindowClosed) {
      try { st.window.removeListener('closed', st.onWindowClosed) } catch (_) { /* 已销毁 */ }
      st.onWindowClosed = null
    }
    const win = st.window
    if (win && !win.isDestroyed()) {
      // 先透明，再改回原尺寸/层级，最后恢复不透明：遮住尺寸变化过程
      setWinOpacity(win, 0)
      try { win.setAlwaysOnTop(st.alwaysOnTop) } catch (_) { /* 忽略 */ }
      try {
        if (st.maximized) win.maximize()
        else win.setBounds(st.bounds)
      } catch (_) { /* 忽略 */ }
      setWinOpacity(win, 1)
      win.show()
      win.focus()
    }
    // 工具箱恢复可见
    if (st.widgetWasVisible) setWinOpacity(getWidgetWindow(), 1)
  }

  IPC.handle(CH.SCREENSHOT_REGION, contract.safe(async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return contract.fail('主窗口不可用')
    // 上一次会话若还在，说明渲染层没走完流程。
    // 这里**不直接拒绝**：先把残留会话还原掉再重新开始 ——
    // 拒绝的话用户就永久卡在「已有截屏进行中」，只能重启应用。
    if (regionSession) {
      console.warn('[dialogs] 检测到残留的截屏选区会话，先还原再重新开始')
      restoreAfterRegion()
    }

    const widgetWindow = getWidgetWindow()
    const display = screen.getPrimaryDisplay()
    const st = {
      window: mainWindow,
      bounds: mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
      alwaysOnTop: mainWindow.isAlwaysOnTop(),
      widgetWasVisible: !!(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.getOpacity() > 0),
      timer: null,
    }
    regionSession = st
    // 看门狗从会话建立起就 arm，而不是等 region-show：
    // 「截图已返回、渲染层还没调 show」这段同样是渲染层可能崩溃的窗口，
    // 没有兜底时会话永久挂起，之后每次截图都撞「已有截屏进行中」（审查 v5 · V5-026）。
    // show 时会重新 arm（重排计时），正常流程不受影响。
    armRegionWatchdog(st)
    // 窗口关闭兜底：主窗口都没了，会话必须立刻清掉（否则 regionSession 指向死窗口，
    // 后续截图会撞上「窗口已销毁」的会话，还得先还原一次才能继续）
    // 处理函数存在会话上，正常结束时由 restoreAfterRegion 摘掉 ——
    // 原先每次截图都 once('closed') 且正常路径不移除，监听器会随使用次数线性累积
    // （审查 v5 · V5-028）。
    const onWindowClosed = () => {
      if (regionSession === st) {
        clearRegionWatchdog(st)
        regionSession = null
      }
    }
    st.onWindowClosed = onWindowClosed
    try {
      mainWindow.once('closed', onWindowClosed)
    } catch (_) { /* 忽略 */ }

    try {
      // 1. 主窗口保持可见（截屏画面带上应用界面），只有工具箱（若可见）会进入截图，先临时透明；
      //    等一帧让合成器更新
      if (st.widgetWasVisible) setWinOpacity(widgetWindow, 0)
      await new Promise((resolve) => setTimeout(resolve, 150))

      // 2. 截取整个主屏（物理像素，供渲染层按显示尺寸比例裁剪）
      const { width, height } = display.size
      const scaleFactor = display.scaleFactor || 1
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
      })
      const primarySource = sources.find((s) => s.display_id === String(display.id)) || sources[0]
      // sources 可能为空：原代码直接 primarySource.thumbnail 会抛 TypeError（读 undefined 的属性）
      if (!primarySource) {
        restoreAfterRegion()
        return contract.fail('没有可截取的屏幕')
      }
      const image = primarySource.thumbnail.toPNG()
      return contract.ok({ dataUrl: `data:image/png;base64,${image.toString('base64')}` })
    } catch (err) {
      restoreAfterRegion()
      return contract.fail(err)
    }
  }))

  IPC.handle(CH.SCREENSHOT_REGION_SHOW, contract.safe(async () => {
    const st = regionSession
    if (!st || !st.window || st.window.isDestroyed()) {
      // 会话已失效（窗口没了/超时了）：清掉残留，别让后续截图一直撞「已有截屏进行中」
      if (st) restoreAfterRegion()
      return contract.fail('截屏选区已失效')
    }
    const display = screen.getPrimaryDisplay()
    // 铺满整屏并置顶作为选区遮罩；渲染层此时已画好冻结画面，再恢复不透明度就不会露出原界面
    st.window.setBounds({
      x: display.bounds.x, y: display.bounds.y,
      width: display.bounds.width, height: display.bounds.height,
    })
    st.window.setAlwaysOnTop(true)
    setWinOpacity(st.window, 1)
    st.window.show()
    st.window.focus()
    // 重新计时：从「窗口真正进入卡死态」起算整段窗口
    armRegionWatchdog(st)
    return contract.ok()
  }))

  IPC.handle(CH.SCREENSHOT_REGION_END, contract.safe(async () => {
    restoreAfterRegion()
    return contract.ok()
  }))

  // 保存注释后的截图
  // 包 contract.safe：写盘失败（磁盘满/权限/路径失效）原先直接 reject，
  // 渲染层拿到的是 Electron 包装的 "Error invoking remote method"，真实原因全丢。
  IPC.handle(CH.NOTE_SAVE, contract.safe(async (event, uint8Array, options) => {
    if (!uint8Array || typeof uint8Array.byteLength !== 'number') {
      return contract.fail('缺少截图数据')
    }
    if (uint8Array.byteLength > MAX_WRITE_BYTES) {
      return contract.fail('截图不能超过 50MB')
    }
    const buffer = Buffer.from(uint8Array)
    const defaultSaveDir = path.join(app.getPath('pictures'), 'screenshots')
    // 与截图保存同一条边界：noteSavePath 由用户配置，渲染层仍可能被篡改，
    // 不允许把任意字节写进 System32/Windows 这类目录。
    const safeDir = resolveSafeWriteDir(options?.saveDir, defaultSaveDir)
    if (safeDir.error) return contract.fail(safeDir.error)
    const saveDir = safeDir.path
    await fsp.mkdir(saveDir, { recursive: true })
    // 精度必须到毫秒：只到秒时 1 秒内连存两次会生成同名文件，writeFile 直接把上一次的覆盖掉（静默丢数据）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
    const filePath = path.join(saveDir, `note_${timestamp}.png`)
    await fsp.writeFile(filePath, buffer)
    return contract.ok({ filePath })
  }))
}

module.exports = { registerDialogsIpc, getDialogDir, setDialogDir }