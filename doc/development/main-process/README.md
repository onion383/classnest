# Electron 主进程开发文档

本文档描述「班集」桌面应用 `electron/` 目录（Electron 主进程层）的职责、目录结构、逐个文件的功能，以及关键机制。内容基于源码逐文件阅读整理。

---
## 一、主进程整体机制

### 1. 主进程职责与运行方式

Electron 主进程层是整个桌面应用的「外壳与调度中心」，负责：

- 应用生命周期：单实例锁、启动流程编排、退出收尾；
- 窗口体系：主窗口、首次安装引导窗口、迁移/加密进度窗口、工具箱浮窗、桌面小组件窗口；
- 后端子进程管理：以 `child_process.fork`（创建 Node 子进程）拉起 `student-backend/app.js`，并做就绪检测、心跳假死判定、自动重连、启动失败兜底与看门狗；
- 系统集成：自定义 `app://` 协议（应用内资源加载协议）、系统托盘、关闭确认、原生右键菜单、U 盘监听、文件/文件夹对话框、截屏、性能面板、版本更新；
- 本地能力：路径与密钥管理（配置目录、DB 主密钥、安全通道主密钥）、本地文件读写、渲染层静态资源（含 V8 代码缓存）；
- 打包期处理：`afterPack.js`（打包后钩子）精简产物、`inno/compile.mjs` 调用 Inno Setup 打成安装包。

运行方式与进程/窗口模型：

- 入口为 `electron/main.js`（`package.json` 的 main 指向），运行于 Electron 主进程（Node 环境）。
- 后端 `student-backend/app.js` 由主进程 `fork`（创建子进程）为独立子进程：
  - 开发模式用系统 `node`（探测/缓存其可执行路径）；
  - 打包模式用 `process.execPath`（当前可执行文件路径，即 electron.exe）+ `ELECTRON_RUN_AS_NODE=1`（以纯 Node 模式运行），以 Electron 内置 Node 的「纯 Node 模式」运行，目标机无需安装 Node。
  - 两者均通过 `execArgv: ['--expose-gc']`（Node 启动参数：暴露垃圾回收接口）暴露 `GC`（垃圾回收），并通过 `env`（环境变量）注入 `DATA_DIR / ALBUM_THUMBS_DIR / SECURE_MASTER / DB_MASTER_KEY / NODE_COMPILE_CACHE`。
- 渲染层为 Vue 3 前端（`student-frontend/`）构建产物：
  - 开发模式经 Vite（`http://127.0.0.1:5173`）加载；
  - 打包模式经自定义 `app://local/*` 协议加载（如 `app://local/index.html`、`setup.html`、`widget.html`、`migration.html`、`desktop-widget.html`）。
- 渲染进程统一使用 `electron/preload.js`（预加载脚本）暴露的 `window.electron`（`contextIsolation`（上下文隔离）开启、`nodeIntegration`（Node 集成）关闭、`sandbox`（沙箱）开启）。

### 2. 主进程关键机制

#### 2.1 单实例锁与第二实例处理

- `main.js` 在模块加载期调用 `app.requestSingleInstanceLock()` 得到 `gotSingleInstanceLock`；`app.whenReady` 内若为 `false` 直接 `app.quit()`。
- 监听 `app.on('second-instance')`：用户重复点击图标时，先 `tray.destroyTray()`，若主窗口存在则 `restore/show/focus`（最小化时先还原），否则调用 `createMainWindow()` 重建。
- 注意：后端 fork 不能提前到 `ready` 之前——其 `env` 需要 `DB_MASTER_KEY`，而该值来自 `safeStorage` 解密；Windows 上 `safeStorage.isEncryptionAvailable()` 只有 `ready` 之后才为 `true`，提前调用会误走「生成随机新密钥」分支导致加密库打不开。因此 fork 放在 `whenReady` 内、建窗之后。

#### 2.2 app:// 自定义协议（不采用 file:// 的原因）

- 打包模式用自定义 `app://` 安全协议加载前端，根目录为 `student-frontend/dist`。
- **不采用 `file://` 的原因**：`file://` 是「不透明 origin」，`localStorage` 仅会话内生效、每次重启即清空（表现为反复登录、设置还原）；`app://` 声明 `standard + secure + supportFetchAPI + corsEnabled + stream + codeCache` 后成为真实且持久化的 origin。
- 特权声明 `protocol.registerSchemesAsPrivileged([...])` 必须在 `app ready` **之前**，放在 `main.js` 模块顶部；`ready` 之后的 `protocol.handle('app', ...)` 由 `main.protocol.js` 的 `setupAppProtocol` 完成（开发模式直接 `return`，不走该协议）。
- 服务策略：启动时只 `readdir` 一次拿到顶级 html 入口名单，之后按路径规则流式返回，避免逐请求同步 `fs` 阻塞主进程；无扩展名或未登记的 html 路径回退 `index.html`（SPA 路由）；带 hash 的静态资源（js/css/wasm/图片/字体）设 `immutable` 长缓存，其余 `no-cache`；做了目录穿越防护（`file !== root && !file.startsWith(root + path.sep)` 返回 403）。
- 渲染进程 V8 代码缓存：`setupRendererCodeCache` 在首个页面加载前调用 `session.defaultSession.setCodeCachePath(...)`（自定义协议需显式指定缓存目录），并按应用版本号（`.cc-version` 标记）后台清理旧版本条目，避免累积。

#### 2.3 主窗口/引导窗口/小组件的创建与显示

主窗口（`main.js` 的 `createMainWindow`）：

- 统一为「无边框（`frame: false`）+ 系统亚克力材质（`backgroundMaterial: 'acrylic'`）+ 不透明底色」；**不用 `transparent`**（透明窗口会禁用系统材质），磨砂由渲染层 CSS `backdrop-filter` 完成，Win11 会据此自动加圆角。`mainWindowChrome` 恒为 `'frameless'`。
- 尺寸 1280x800（**最小 1200x600 DIP**），图标 `app-icon.png`；`webPreferences` 由 `main/web-prefs.js` 的 `buildWebPreferences()` 统一生成（各窗口共用），主窗口额外传 `devTools:true`：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`additionalArguments:['--secure-channel']`、`webSecurity:!isDev`。
- 显示时机：`show:false` 创建，等 `ready-to-show` 再 `show`（先露出一层空亚克力底），并设有 1500ms 兜底 `revealWindow`。`revealWindow` 在显示前对 win32 再次 `applyBackgroundMaterial(win,'acrylic')`（隐藏态创建时材质可能未生效）。
- 开发模式：先 `loadURL` 一份内联 loading 页（`data:text/html` 的 `devLoadingHtml()`，窗口 <1s 出画），同时后台 `pollViteAndNavigate` 轮询 Vite，就绪后导航到 `http://127.0.0.1:5173/` 并打开 DevTools（`INP_DEBUG` 时不打开）。
- 打包模式：`win.loadURL('app://local/index.html')`。

引导窗口（`createSetupWindow`）：

- 主窗口全新安装（`firstRunAtStartup`）时创建；固定 800x540，无边框 + 亚克力，`sandbox:true`，启动期间禁止关闭。
- 显示时机：`show:!isDev`（prod 直接显示，占位页为 `app://local/setup.html` 的内联/静态内容），dev 下先隐藏、等 `setup-ready` 回报后 `revealWindow`，另有 1500ms 兜底。
- 记录 `setup-incomplete` 标记（`setupPendingMarkerPath`），只有 `setup-complete` 时删除；中途关闭/退出则下次仍进入引导。
- 预热（`runSetupWarmup`）在 `setup-ready` 之后后台推进，通过 `from-main{type:'setup-warmup'}` 与 `get-setup-warmup` 供渲染层补齐。

工具箱浮窗与桌面小组件（`main.widget.js`）：

- 工具箱浮窗：`frame:false + transparent:true`、`alwaysOnTop`、`skipTaskbar`、不可缩放；窗口尺寸为「视觉内容 + 2×`WIDGET_SHADOW_MARGIN`(16px)」以便绘制阴影；会话级显隐采用「隐藏即 `destroy`」以释放渲染进程（重启用 `lastWidgetBounds` 恢复位置）；拖动/缩放/全屏/鼠标穿透等 IPC 见文件清单。
- 桌面小组件：320 宽、高度约屏幕 95%，无边框 + 渲染层自绘磨砂（`transparent:false`、页面铺满不透明遮罩）、不置顶、不可缩放；由 `setDesktopEnabled`/`scheduleCreateDesktop` 按启用状态创建/关闭；`widgets-ready`（主窗口首帧空闲回报）时创建工具箱并按启用状态建关桌面组件。

#### 2.4 后端子进程的 fork 与心跳/重连/看门狗

启动（`main.backend.js`）：

- `startBackend` 每次 fork 前复位 `backendReady`、`setBootStatus`、武装失败看门狗（`armBackendFailWatchdog`，超时 `BACKEND_FAIL_TIMEOUT` = 30s，`SIM_BACKEND_FAIL` 时为 3s）；启动阶段连续崩溃上限 10 次，超过则进入失败态。
- 就绪检测（`detectBackendReady`）：对子进程 stdout 做滚动缓冲（保留末 4096 字节）+ 子串匹配 `/服务器已启动|listening|server started/i`，命中即 `startupTimer.mark('后端就绪')`；此检测仅作日志，不再作为建窗信号（主窗口与后端并行启动）。
- 就绪上报：子进程 `postMessage({type:'backend-ready'})` → `onBackendMessage` 置 `backendReady=true`、清零重启计数、清失败态、`setBootStatus('本地服务已就绪')`、启动心跳，并向所有已存在窗口广播 `from-main{type:'backend-ready'}`；同时唤醒主进程侧等待者与「首次就绪」回调。

心跳与假死判定：

- 每 `HEARTBEAT_INTERVAL`(30s) 发 `{type:'ping'}`，单次等 `pong` 上限 `HEARTBEAT_TIMEOUT`(4s)，连续 `HEARTBEAT_FAIL_LIMIT`(2) 次超时判定「疑似假死」，进入重连（`handleBackendDown`）。等待期间校验进程身份（`proc !== backendProcess` 则不计入），避免把已被替换的进程算成异常。
- 「请求失败触发即时探测」：渲染层上报请求无响应时调 `probe-backend`，主进程立即 `pingOnce`；探测失败且已就绪时立刻进入重连（把用户每一次失败操作变成探针，不必等下一个心跳周期）。

退出与重连：

- 子进程 `exit` 触发 `scheduleBackendRestart`（1.5s 去抖），非主动停止时进入 `handleBackendDown`。
- `handleBackendDown`：最多 `RECONNECT_MAX`(5) 次重连，每次广播 `from-main{type:'backend-reconnecting', active, attempt, max}` 并 `setBootStatus`；成功即恢复心跳并广播解除；全部失败则 `markBackendFailed`。
- 启动失败兜底：看门狗超时或自动重启用尽 → `markBackendFailed` 广播 `from-main{type:'backend-failed', failed:true}`，启动占位页给出「重启后端 / 退出应用」（`restart-backend` / `quit-app`）；恢复时广播 `failed:false`。
- `stopBackendProcess`：返回 Promise 等进程真正退出（Windows 上 `kill()` 异步，需等句柄释放，否则搬迁数据库易 EBUSY/EPERM），并摘掉 `exit → scheduleBackendRestart` 监听避免「主动停止」被自动重启。`shutdownBackend` 置 `app.isQuitting`、杀后端、关闭日志流。
- 后端日志写入 `userData/data/backend.log`。

#### 2.5 启动计时（startup-timer 与渲染层 [startup] 日志的采集口径）

- `main.startup-timer.js` 以模块加载时刻为起点，`mark(name)` 记录时间戳并打印 `[startup] +Nms name`；`end(name)` 定死「启动完成」锚点 `endElapsed`（幂等，仅首次生效），此后 `getTimeline().total` 不再被更晚的 mark 抬高。
- 主进程打点：`app.whenReady 就绪`、`协议注册完成`、`createMainWindow/createSetupWindow 完成`、`startBackend 完成`、`ready-to-show（窗口首次显示）`、`Vite 就绪，开始跳转`、`loading 页面加载完成`、`Vite 页面加载完成`、`后端就绪` 等。
- 锚点口径（`main.js` `revealWindow`）：「上次启动耗时」= 进程启动 → **第一个窗口首次显示**的那一刻。所有窗口的显示都走 `revealWindow()`，其中调 `startupTimer.end('窗口首次显示')` 定死锚点：主窗口是 `ready-to-show`（未触发时走 1500ms 兜底 reveal），引导窗口是 `setup-ready`（dev 下此刻才 reveal；prod 下创建即显示，锚点顺延到 `setup-ready` 的 reveal）。后端就绪、首屏数据就绪等更晚事件不再抬高总耗时，用户在引导页的停留也不计入。
- 渲染层日志采集：主窗口监听 `webContents.on('console-message')`，把渲染层以 `[startup]` 前缀打印的日志转成 mark（去掉前缀；含「Vue 挂载完成」「占位页移除（界面可见）」等，仅作时间线记录，不再参与锚点）。仅采集「首次加载」：非 `data:` 页面 `did-finish-load` 后置 `rendererStartupLogged=true` 停收，避免前端重启（`reload`）把这些日志以主进程已运行时长为基准重复计入；例外是「占位页移除」必然晚于 `did-finish-load`，放行第一次以保证界面可见时刻留在时间线上。
- 输出：`whenReady` 后 5s 调用 `startupTimer.report()` 打印时间线，`startupTimer.saveLog()` 追加写入 `userData/data/startup.log`；性能面板用 `startupTimer.getTimeline()`（经 `perf-startup`）读取。

#### 2.6 preload 的 IPC 通道白名单机制

**白名单是「按窗口角色裁剪」的**：主进程用 `electron/ipc-policy.json`（通道 → 允许的窗口角色）裁剪出本窗口可用的通道，
再经 `additionalArguments` 注入 preload。渲染层拿不到越权通道 —— 比等主进程拒绝更早一步。
详见 [2.8 IPC 授权模型](#28-ipc-授权模型通道--允许的窗口角色)。

- `preload.js` 定义三张白名单：
  - `validSendChannels`：单向发送（`ipcRenderer.send`），如 `to-widget`、`widget-*`、`win-minimize/maximize-toggle/close`、`shutdown-action`、`quit-app`、`show-native-context-menu`、`theme-chrome`、`desktop-widget-enabled`、`widgets-ready`、`migration-*`、`setup-*`、`update-install` 等；
  - `validInvokeChannels`：请求-响应（对应 `ipcMain.handle`），如 `select-folder`/`save-file`/`open-file`/`open-folder`/`screenshot-capture`/`note-save`、`get-master-key`、`apps-select-file`/`apps-resolve-paths`/`apps-launch`、`get-data-directories`/`set-data-dir`/`set-thumbs-dir`/`set-skills-dir`/`set-db-encryption`/`set-initial-data-dir`、`backend-status`/`boot-status`/`restart-backend`/`backend-failure`/`probe-backend`、`perf-*`、`get-app-version`/`update-check` 等；
  - `validReceiveChannels`：仅 `from-main`（主进程 → 渲染进程）。`from-widget` 已删除 —— 配套的 `to-main` 通道整条链路无生产者也无消费者。
- 其余通道（按用途归类，均来自 `electron/ipc-channels.json`）：
  - 工具箱/桌面组件拖拽与交互：`widget-drag-move`、`widget-drag-end`、`widget-exit`、`desktop-widget-content-ready`、`desktop-widget-drag-start`、`desktop-widget-drag-move`、`desktop-widget-drag-end`、`desktop-widget-open-page`
  - AI 右键菜单：`ai-context-menu`
  - 首次启动/引导：`launch-skip-warn`、`launch-open-download`、`launch-plan`
  - 截图：`screenshot-region`、`screenshot-region-show`、`screenshot-region-end`
  - 设置与敏感操作：`set-skills-dir`、`set-content-protection`、`copy-sensitive-text`
- 暴露的 `window.electron`：`send` 仅放行 `validSendChannels`；`invoke` 对白名单外通道直接 `Promise.reject`；`on/once` 仅放行 `validReceiveChannels`；`getPathForFile(file)` 走 `webUtils` 取拖入文件的真实路径（Electron 32 起 `File.path` 已移除）。
- 监听器缓存 `listenerMap`：`on` 时保存「用户 callback → 包装后的 wrapper」映射，`off` 时据此取出真正的 wrapper 再 `removeListener`（并兼容传入 wrapper 的情况），避免因引用不同而无法解绑造成内存泄漏。
- `contextBridge.exposeInMainWorld('__SECURE_CHANNEL__', process.argv.includes('--secure-channel'))`：仅当主进程通过 `additionalArguments` 传入 `--secure-channel` 时置位，前端据此对业务 JSON API 启用加密传输。

#### 2.8 IPC 授权模型（通道 → 允许的窗口角色）

**问题**：5 个窗口（main / widget / desktop-widget / setup / migration）原本共用**同一份**通道白名单，
preload 层区分不了「谁在调」；主进程只能逐 handler 手写 `event.sender !== X.webContents`，
散在 8 个文件、两种写法，**12 条通道漏了 5 条** —— 漏的恰好是最危险的那批。

**做法**：授权模型收口成「一张表 + 两个执行点」。

| 件 | 作用 |
|---|---|
| `electron/ipc-policy.json` | **唯一事实来源**：通道 → 允许的窗口角色。由 `testjs/probe/ipc-policy-gen.mjs` 从渲染层**静态 import 图**推导，不是手写猜的 |
| `electron/main/main.ipc-auth.js` | 角色登记、`isAllowed` 判定、`installIpcGuard()` 统一拦截、角色化白名单裁剪 |
| 执行点 1（渲染层） | `main.web-prefs.js` 按角色裁剪通道名单后注入 preload → 越权通道渲染层就调不到 |
| 执行点 2（主进程） | `installIpcGuard()` 包装 `ipcMain.handle/on`，**每一次注册**自动带发送方校验，含将来新加的通道 |

**关键性质**：

- **fail-closed**：表里没有的通道一律拒绝。新增通道忘登记 → 开发期立刻表现为「调用没生效」，而不是「忘了写 if 就等于放行」。
- **单一判据**：改一处即可，不必同步 N 个 handler。
- **角色 ≠ 窗口**：`get-master-key` 授权给 5 个角色 —— 凡是装了 `apiClient` 的窗口都会建安全通道（`setupApiClient` → `setupSecureAxios`），包括引导窗。
- **所有窗口同 origin**（`app://local` 或 dev 的 `127.0.0.1:5173`），所以「同源」不构成任何边界 —— 边界只由授权表与「渲染层不加载外部内容」构成。

**授权表怎么来的**：`ipc-policy-gen.mjs` 对每个通道的每个调用点文件做两段判定 ——
文件在 `src/subwindows/<role>/**` → 角色就是 `<role>`；文件是公共模块（`src/` 根下）→ 角色 = 能 import 到它的入口集合。
「当前无调用方但能力应当保留」的通道（如 `set-db-encryption`：后端接口与迁移窗 crypt 模式都在，只差设置页入口）在生成器的 `OVERRIDE` 里显式登记。

**回归保障**：`testjs/probe/ipc-policy-probe.cjs`（表与名单一一对应、授权覆盖真实调用方、敏感通道仅主窗口、fail-closed、裁剪正确）
与 `testjs/probe/ipc-guard-probe.cjs`（拦截层放行/拒绝/幂等）。

#### 2.7 托盘与窗口关闭确认流程

- 主窗口 `close` 事件被 `tray.handleMainClose` 拦截（覆盖系统 ✕ 与自绘标题栏关闭按钮）：若 `app.isQuitting` 或 `allowMainClose` 为真则放行，否则 `e.preventDefault()` 并在窗口中央弹出「怎样关闭」菜单。
- 关闭菜单优先由渲染层弹出：主进程发 `from-main{type:'shutdown-menu', hasToolbox, hasDesktop}`，渲染层回报 `shutdown-action`（`ready`/`cancel`/具体 action）；渲染层未就绪（`mainRendererShutdownReady` 为假）时回退到主进程原生菜单 `showShutdownMenu`（选项：关闭主窗口 / 主窗口和工具箱 / 主窗口和桌面组件 / 关闭所有窗口及其后端）。
- 统一关闭逻辑 `closeMainWith(action)`：`all` 走 `app.quit()`；否则按需关闭组件窗口后**先 `createTray()` 再关主窗口**（保证 `window-all-closed` 时托盘仍在、进程与后端保持存活），置 `allowMainClose=true` 后 `mainWindow.close()`。
- `window-all-closed`：若 `tray.isTrayAlive()` 为真则保持后台运行；否则 `backend.shutdownBackend()` 并在非 macOS 下 `app.quit()`。
- 托盘（`createTray`）：图标从 `tray-icon.png` 读取后 `nativeImage.createFromBuffer`（规避 asar 路径问题），提示「班集」，右键菜单「恢复主窗口 / 完全退出」，左键点击恢复主窗口（`showMainFromTray`：存在则唤起，不存在则重建，并销毁托盘）。
- 主窗口重建时 `tray.resetShutdownState()` 复位 `allowMainClose/shutdownMenuOpen/mainRendererShutdownReady`，避免新建窗口被静默放行或被旧状态影响。

#### 2.8 打包后精简（afterPack.js 与 inno/compile.mjs）

`afterPack.js`（仅 `win32`，由 electron-builder 在打包产物生成后调用）：

- 剔除运行时用不到的 Chromium 组件：`vk_swiftshader.dll`、`vk_swiftshader_icd.json`、`vulkan-1.dll`、`dxcompiler.dll`、`dxil.dll`（约 -32MB；依据为对产物开 CDP 核对，界面渲染/WebGL 状态与删除前一致）。
- 把 `LICENSES.chromium.html`（约 19.4MB）压缩为同目录 `third-party-licenses.zip`（自实现 CRC32 + `deflateRawSync` 生成单文件 zip，不引入第三方依赖），许可声明仍随包分发以满足合规（红线：不得改为联网下载）。
- 明确保留：`libGLESv2.dll`/`libEGL.dll`/`d3dcompiler_47.dll`（ANGLE 硬件加速必需）、`icudtl.dat`、`resources.pak`、`v8_context_snapshot.bin`/`snapshot_blob.bin`、`ffmpeg.dll`（相册视频播放必需）。

`inno/compile.mjs`（由 `package.json` 的构建脚本调用）：

- 定位 Inno Setup 6/7 的 `ISCC.exe`，顺序为：环境变量 `INNO_SETUP_ISCC` → PATH 中 `iscc`（`where`/`which`）→ 常见安装目录（`Inno Setup 6/7`）→ 注册表卸载表 `InstallLocation`；找不到时打印中文提示与下载地址并以退出码 1 结束。
- 以 `spawnSync(iscc, [setup.iss], { stdio: 'inherit' })` 编译 `electron/inno/setup.iss`，把退出码透传。
- `setup.iss` 输出固定名 `ClassNest-Setup-x.y.z.exe` 到 `release/`（Vue 3.6 预览通道为 `release36/`；便于 `main.updater.js` 按 `*-Setup-*.exe` 匹配资产），AppId 为固定 GUID（保证升级/卸载识别），`PrivilegesRequired=admin`（机器级安装到 `C:\Program Files\班集`，会请求 UAC）、`WizardStyle=modern`、`CloseApplications/RestartApplications=yes`（支持静默升级自动关旧进程/装完重启），安装界面由 [Code] 段自绘。

---
## 二、主进程文件索引

### 1. 主进程目录树

`electron/main/` 下共 **23 个 `main.*.js`** 模块 + `main.js` 入口：

```
electron/
├── main/main.js                 主进程入口：生命周期编排、主窗口/引导窗口、迁移/加密流程
├── main/main.config.js          路径/配置/密钥（app-config.json、编译缓存目录、主密钥）
├── main/main.backend.js         后端子进程全生命周期（fork/心跳/重连/看门狗）
├── main/main.perf.js            性能面板 IPC 与内存采样
├── main/main.privateWorkingSet.js  Windows PDH「专用工作集」口径（koffi 调 pdh.dll）
├── main/main.widget.js          工具箱浮窗 + 桌面小组件窗口与 IPC
├── main/main.desktop-layer.js   Windows 桌面置底（SetWindowPos + Progman 校验）
├── main/main.tray.js            无边框标题栏 + 系统托盘 + 关闭确认菜单
├── main/main.protocol.js        app:// 协议 + 渲染进程 V8 代码缓存
├── main/main.apps.js            桌面小组件·常用软件（选文件取图标 / 启动）
├── main/main.dialogs.js         文件/文件夹对话框与本地文件读写类 IPC
├── main/main.updater.js         版本更新（GitHub Releases 检查/下载 + Inno 静默安装）
├── main/main.update-integrity.js 更新包 HTTPS / SHA-256 校验
├── main/main.usb.js             U 盘自动打开（轮询盘符）
├── main/main.window-material.js 窗口原生背景材质（亚克力/云母）
├── main/main.web-prefs.js       BrowserWindow 的 webPreferences 公共模板
├── main/main.webview-guard.js   <webview> 安全护栏 + 刷新快捷键拦截
├── main/main.ipc-auth.js        IPC 授权层（通道 → 允许的窗口角色；统一拦截 + 白名单裁剪）
├── main/main.ipc-contract.js    IPC 结果契约层（成功 / 失败 / 用户取消 三态互斥的统一表达）
├── main/main.path-guard.js      IPC 路径 / URL 白名单
├── main/main.dev-loader.js      开发模式加载（Vite 轮询 / loading 页 / 重试导航）
├── main/main.migration.js       数据目录搬迁引擎
├── main/main.inpLog.js          INP 归因落盘（仅开发模式）
├── main/main.startup-timer.js   启动事件计时器
├── preload.js                   预加载脚本：IPC 通道白名单 + contextBridge
├── ipc-channels.json            IPC 通道名单单一来源（经 additionalArguments 注入）
├── ipc-policy.json              IPC 授权表：通道 → 允许的窗口角色（唯一事实来源）
├── startup.html                 打包模式引导窗口静态占位页
├── afterPack.js                 electron-builder afterPack：精简 Windows 产物
├── app-icon.png / tray-icon.png 应用图标 / 托盘图标
├── inno/                        Inno Setup 安装器（setup.iss / compile.mjs / 向导图）
└── installer-assets/            安装器资源（图标 / 协议文本 / 输入框背景）
```

### 2. 逐文件职责与接口

| 覆盖范围 | 文档 | 主要内容 |
| --- | --- | --- |
| `electron/main/main.js` | [entry.md](./entry.md) | 入口编排：加载期顺序、主窗口、`whenReady`、引导/低版本提示、迁移与加密、入口 IPC、退出收尾 |
| 23 个 `main.*.js` | [modules.md](./modules.md) | 逐模块职责、关键导出 / IPC 通道、依赖与被依赖 |
| `electron/` 根文件与安装器资源 | [root-files.md](./root-files.md) | `preload.js`、`ipc-channels.json`、`ipc-policy.json`、`startup.html`、图标、`afterPack.js`、`inno/`、`installer-assets/` |

---
## 三、主进程标准

- **模块依赖注入标准**：`main.js`（主进程入口 / 编排者），`main.backend.js`（后端进程）/`main.perf.js`（性能采集）/`main.tray.js`（托盘）/`main.widget.js`（小组件窗口）/`main.dialogs.js`（系统对话框）/`main.apps.js`（常用软件）/`main.updater.js`（更新）均通过 `registerXxxIpc(opts)`（各模块注册 IPC 的标准函数）注入窗口引用（getter 闭包，调用时取当前值）或回传出口，各模块内部不直接持有 `mainWindow`（主窗口引用）变量。新增窗口引用时需同步更新这些注入项。
- **async-ipc 与单向广播的分工**：请求-响应走 `ipcMain.handle`（Electron 请求-响应通道注册）；主进程 → 渲染层统一用 `from-main`（主进程发往渲染层）；任何新通道必须同步加入 `electron/ipc-channels.json`（通道名单）与 `electron/ipc-policy.json`（授权表），否则前端调用会被静默拒绝或 `reject`（返回失败的 Promise）。
- **sandbox 默认开启**：所有窗口 `sandbox:true`（沙箱开关）且 `contextIsolation:true`（上下文隔离）、`nodeIntegration:false`（关闭 Node 集成）；如遇 Electron 版本回退导致沙箱启动崩溃，才考虑临时置 `false`（软件层仍由 `contextIsolation`（上下文隔离）兜底）。
- **IPC 结果必须三态互斥**：`ipcMain.handle`（Electron 请求-响应通道注册）的返回体统一走 `main.ipc-contract.js`（结果契约层）的 `ok()` / `fail()` / `canceled()`。**「用户取消」与「执行失败」必须能区分**：取消是用户的正常选择（前端安静吞掉），失败是要提示用户的错误（前端必须弹提示）。两者共用一个 `canceled:true`（取消标记）表达时，失败会被当成取消而静默 —— 这正是批 13 修掉的 B01-06。新增 handler 时用 `contract.safe()`（异常转成失败**返回值**）或 `contract.safeReject()`（保留 reject 语义但换成可读 message），二选一取决于前端现有代码是 `try/catch` 还是读返回值。
- **`webSecurity`（网页安全策略开关）仅开发模式关闭**，生产必须开启，禁止在打包后关闭网页安全策略。
- **主窗口系「不透明 + 系统材质」，桌面组件「渲染层自绘磨砂」**：亚克力 / 云母材质在透明窗口上会被禁用，主窗口 / 迁移窗口 / 进度窗口仍遵循 `transparent:false`（不透明窗口）+ `backgroundMaterial`（系统背景材质），浮窗（工具箱）是唯一使用 `transparent:true`（透明窗口）的窗口。桌面组件要的是稳定的「桌面被模糊」观感（`DWM`（Windows 桌面窗口管理器）材质只做壁纸亮度采样 + 强着色、观感随 build 变），改为「壁纸图 + CSS 全局模糊 + 奶白遮罩」自绘（见 [widgets.md](../widgets.md)），不依赖系统材质，挂桌面层（`WS_CHILD`（子窗口样式））时同样可用。
- **safeStorage 时序**：`DB_MASTER_KEY`（数据库主密钥）依赖 `safeStorage`（Electron 安全存储），只能在 `app ready`（应用就绪事件）之后生成 / `fork`（派生子进程），切勿提前到模块加载期。主密钥文件 `db-master.key` 与数据库同目录存放，会随数据目录一起迁移。
- **写配置必须抛错**：`config.saveAppConfig`（保存应用配置的函数）写失败会抛出，调用方（如目录搬迁）应据此中止，避免「数据在新目录、配置却指向已删除旧目录」的错位状态。
- **主动停止后端与自动重启**：任何需要重启后端的操作（目录搬迁、缩略图目录变更、加密转换、重连）都应先 `backend.stopBackendProcess()`（停止后端子进程，其内部已摘除自动重启监听并停心跳），再 `backend.startBackend()`（启动后端子进程），避免 `fork`（派生子进程）出两个后端。
- **迁移/加密流程的窗口数保护**：执行前先创建进度窗口再关闭其它窗口，保证窗口数不为 0，避免触发 `window-all-closed`（所有窗口关闭事件）导致应用提前退出；同时 `tray.beginCloseWithoutMenu()`（托盘放行关闭主窗口的方法）放行主窗口关闭。
- **测试开关**（均通过环境变量，默认关闭）：`FORCE_SETUP=1/0` 强制/跳过首次引导；`SIM_BACKEND_FAIL` 让后端起不来（验证失败页）；`SIM_BACKEND_CRASH=once|dead` 模拟运行期崩溃（验证重连/满 5 次进全屏）；`INP_DEBUG=1` 开 CDP 远程调试端口 9222；`NODE_EXEC_PATH` 指定开发模式后端 node 路径。
- **启动计时的停收标准**：`rendererStartupLogged`（启动日志停收标记）会在真正应用页 `did-finish-load`（页面加载完成事件）后停收 `[startup]` 日志，新增页面 / 日志时需注意该口径（前端重启不计入启动耗时）。
- **`app://`（应用自定义协议）与新入口页**：新增顶级 html 入口需确保其位于 `student-frontend/dist` 顶层（`setupAppProtocol`（注册应用协议的启动逻辑）启动时枚举 html 入口名单），否则会被当作 SPA（单页应用）路由回退到 `index.html`（主页面）。

---
