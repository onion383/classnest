// =========================================================================
// webview-guard.js —— 右侧网页抽屉 <webview> 安全护栏 + 刷新快捷键拦截
//
// 由 main.js 在模块加载期调用 registerWebviewGuard({ getMainWindow, isDev }) 注册
// app.on('web-contents-created')。依赖注入：主窗口引用以 getter 闭包注入（调用时取当前值），
// isDev 由 main.js 传入（取 main.env 的唯一口径）。原实现内嵌于 main.js，此处为等价的纯搬运。
// =========================================================================

const { app, session } = require('electron')
const { CH } = require('./channels')
const { isHttpUrl } = require('./main.path-guard')

// 右侧网页抽屉用 <webview> 内嵌外部网页的安全护栏（外部内容视为不可信）：
// 只有 http/https 视为合法地址，其余协议（file:、data:、javascript: 等）一律拒绝。
// 协议判定复用 main.path-guard，避免两处实现漂移（新增协议时只改一处）。

// 远程访客页固定落在独立会话：不与默认会话共享缓存、代理与证书例外。
// 名字与渲染层 AiLinkPanel.vue 的 partition="ai-link-preview" 必须一致。
const LINK_PREVIEW_PARTITION = 'ai-link-preview'

// 默认会话（应用自身窗口）里唯一需要放行的受控能力：写剪贴板。
// 渲染层有两处 navigator.clipboard.writeText —— 复制 AI 消息、复制恢复助记词；
// 一律拒绝会让这两个按钮静默失效（助记词复制尤其不能坏）。
// clipboard-read 仍不放行：允许写不等于允许读，读不到剪贴板里的内容。
const DEFAULT_SESSION_ALLOWED = new Set(['clipboard-sanitized-write'])

// 权限总闸：request / check / 设备授权三条路径统一按白名单判定，白名单通常为空 = 全拒。
//
// 应用窗口是本地 app:// 页面，除写剪贴板外不使用摄像头、麦克风、定位、通知、读剪贴板
// 等任何受权限控制的能力（已全量确认：渲染层无 getUserMedia / mediaDevices /
// Notification.requestPermission / geolocation / requestFullscreen 调用）。
// 一旦渲染层被注入或加载了不可信内容，这道闸能挡住「静默开麦、开摄像头、读定位」。
//
// 将来若真需要某项能力（例如扫码取景），在这里按 permission 精确加白，
// 不要用「整体打开」的方式回退。
//
// 幂等：同一会话只装一次，靠会话对象上的标记去重（会话是长期存活的单例）。
function hardenSessionPermissions(ses, allowed) {
  if (!ses || ses.__classnestPermissionGuard) return
  ses.__classnestPermissionGuard = true
  const allow = allowed instanceof Set ? allowed : new Set()
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allow.has(permission))
  // USB / HID / 串口走独立的设备授权 API，不在上面两个处理器里。
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false)
  }
}

// 注册 app.on('web-contents-created') 护栏（原 main.js 内嵌逻辑整体迁出）
function registerWebviewGuard({ getMainWindow, isDev }) {
  // 链接预览会话在 app ready 后立刻上闸，早于任何 <webview> 建立。
  // 用 .then 包住：本函数在模块加载期执行，此时 session 尚不可用。
  app.whenReady().then(() => {
    try {
      hardenSessionPermissions(session.fromPartition(LINK_PREVIEW_PARTITION))
    } catch (err) {
      console.warn('[webview-guard] 链接预览会话权限闸安装失败:', err && err.message)
    }
  })

  // 1) 创建 webview 前校验（will-attach-webview，绑定在宿主 webContents 上）：
  //    即使宿主渲染进程被注入恶意脚本，也无法构造出带 preload / nodeIntegration 的危险 webview。
  app.on('web-contents-created', (event, contents) => {
    // 该 webContents 所属会话一律上权限闸（幂等）：覆盖主窗口的默认会话与所有访客会话。
    // 放在这里而不是启动时一次性设置，是因为它会随窗口/访客不断新建，而会话是复用的。
    // 访客页（远程内容）白名单为空 = 全拒；应用自身窗口只放行写剪贴板。
    const isGuest = contents.getType && contents.getType() === 'webview'
    hardenSessionPermissions(contents.session, isGuest ? undefined : DEFAULT_SESSION_ALLOWED)

    // 禁用刷新快捷键：拦截 Ctrl/Cmd+R、Ctrl/Cmd+Shift+R（硬刷新）、F5、Ctrl+F5，
    // 避免用户误触导致整个界面重载、丢失当前操作状态。覆盖所有窗口（含 webview）。
    // 注：开发模式（isDev）下放行上述快捷键，便于快速重载看改动。
    if (!isDev) {
      contents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return
        const mod = input.control || input.meta
        const key = (input.key || '').toLowerCase()
        if ((mod && key === 'r') || key === 'f5') e.preventDefault()
      })
    }

    // 宿主窗口：拦截其内部将要挂载的 webview，强制安全配置
    if (contents.getType && contents.getType() !== 'webview') {
      contents.on('will-attach-webview', (e, webPreferences, params) => {
        // 剥离任何自定义 preload：外部网页绝不加载本应用的 preload.js（不暴露 window.electron）
        delete webPreferences.preload
        // 强制关闭 Node 集成 / 强制开启隔离与沙箱（压掉任何来自渲染层的越权配置）
        webPreferences.nodeIntegration = false
        webPreferences.nodeIntegrationInSubFrames = false
        webPreferences.contextIsolation = true
        webPreferences.sandbox = true
        webPreferences.webSecurity = true
        // 远程页面统一落进独立会话：即使宿主被注入、自行指定了别的 partition，
        // 也强制改回来 —— 保证上面那道权限总闸一定挂在这个访客页所属的会话上，
        // 同时避免它和默认会话共享缓存/代理/证书例外。
        webPreferences.partition = LINK_PREVIEW_PARTITION
        // 只允许 http/https 地址进入 webview
        if (!isHttpUrl(params.src)) e.preventDefault()
      })
      return
    }

    // 2) webview（访客页）自身：拦下 target=_blank 的新窗口请求，改为在同一 webview 内跳转，
    //    内容始终留在抽屉里、不额外弹窗；并限制其内部导航协议白名单（阻断 file:/data: 等）。
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) {
        // loadURL 返回 Promise，加载失败（网络不通/证书错误/页面已死）会 reject。
        // 原先没接 → unhandled rejection：Electron 主进程打一条难懂的警告，
        // 而抽屉里的网页会**停在旧页面不动**，用户看着像是「点了没反应」（B01-09）。
        // 这里接住并记日志，让失败可诊断；导航失败不该拖垮主进程。
        contents.loadURL(url).catch((err) => {
          console.warn('[webview-guard] 网页跳转失败:', url, err && err.message)
        })
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (e, url) => {
      if (!isHttpUrl(url)) e.preventDefault()
    })

    // 3) 禁止网页下载文件：拦截该会话（partition = ai-link-preview）的下载并取消，
    //    再通知主窗口弹出提示「下载文件请打开本地浏览器」。同一 partition 的 session 会被
    //    多个 webview 共享，用标记去重，避免重复绑定导致多次提示。
    const ses = contents.session
    if (ses && !ses.__aiLinkDownloadGuard) {
      ses.__aiLinkDownloadGuard = true
      ses.on('will-download', (e) => {
        e.preventDefault()
        const mainWindow = getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(CH.FROM_MAIN, { type: 'link-download-blocked' })
        }
      })
    }
  })
}

module.exports = { registerWebviewGuard }
