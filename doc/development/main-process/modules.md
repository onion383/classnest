# 主进程模块（`electron/main/main.*.js`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── electron/
    └── main/
        ├── main.apps.js  # 桌面小组件·常用软件：选择或拖入 exe/lnk/bat/cmd、文件夹、普通文件并提取名称…
        ├── main.backend.js  # 后端子进程全生命周期：日志文件、开发/打包两种 fork 方式、就绪检测、boot-stat…
        ├── main.config.js  # 配置/路径/密钥叶子模块：app-config.json 读写与内存缓存、解析数据目录与缩略…
        ├── main.desktop-layer.js  # Windows「置底」定位（仅 Win32 生效）：不做 SetParent，用 koffi…
        ├── main.dev-loader.js  # 开发模式加载器：devLoadingHtml() 内联 loading 页、pollVite…
        ├── main.dialogs.js  # 文件/文件夹对话框与本地文件读写类 IPC：选择文件夹/图片、保存背景图、导出保存、打开文件…
        ├── main.inpLog.js  # INP 归因落盘（仅开发模式）：接收渲染层 inp-report，追加写入 /inp.log
        ├── main.migration.js  # 数据目录搬迁引擎：校验源文件 → 复制（字节进度）→ 复检（失败单拷 + 全局哈希）→ 写配…
        ├── main.path-guard.js  # IPC 路径 / URL 白名单：只接受绝对路径、拒绝系统保护目录与可执行后缀、realpa…
        ├── main.perf.js  # 性能面板 IPC 与内存采样：逐进程内存列表、总计/近一分钟平均/自启动最高、重启前端/小组…
        ├── main.privateWorkingSet.js  # 用 koffi 调 pdh.dll 读取 Windows「Process V2(*)\Wor…
        ├── main.protocol.js  # 打包模式 app:// 协议服务静态资源（含 asar 流式读取、SPA 回退、防目录穿越、…
        ├── main.startup-timer.js  # 启动事件计时器：记录 mark 时间线、end 定死「启动完成」锚点、结构化 getTime…
        ├── main.tray.js  # 无边框标题栏窗口控制 + 系统托盘 + 关闭确认菜单：win-minimize/win-ma…
        ├── main.update-integrity.js  # 更新包完整性校验：下载地址与重定向地址必须 HTTPS；sha256: digest 强制比…
        ├── main.updater.js  # 自建版本更新：请求 GitHub Releases 最新版、比较版本、下载 Inno 安装包…
        ├── main.usb.js  # U 盘自动打开：配置持久化、轮询 A–Z 盘符、检测到新盘符用资源管理器打开（仅 Windo…
        ├── main.web-prefs.js  # 全部窗口 webPreferences 的公共模板：contextIsolation / s…
        ├── main.webview-guard.js  # 安全护栏：只允许 http(s)、剥离 preload、强制 sandbox/context…
        ├── main.widget.js  # 工具箱浮窗 + 桌面小组件两个窗口的生命周期与 IPC（创建/隐藏/显示、拖动、缩放、全屏、…
        └── main.window-material.js  # 窗口原生背景材质：setBackgroundMaterial('acrylic'
```
<!-- doc-tree:end -->

---

## 综合概述

- **定位**：21 个 `main.*.js` 模块，按职责拆分；`main.js` 入口编排见 [entry.md](./entry.md)，整体机制与标准见 [README.md](./README.md)。
- **公共逻辑**：模块统一以 `registerXxxIpc(opts)`（注册 IPC 的函数）对外；窗口、后端进程等引用通过 getter 闭包注入，模块内部不持有全局窗口变量；启动关键路径之外的模块由 `main.js` 用 `lazyModule()`（惰性加载）推迟到建窗之后。
- **局限**：本页是清单，只列职责、关键导出/IPC 与依赖；内部时序、重连策略等实现细节见 [README.md](./README.md) 第二节，改代码前先读对应机制段。

---

## 详细说明

| 文件                                                                              | 职责                                                                                                                                                                                          | 关键导出 / IPC 通道                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 依赖与被依赖                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.config.js`](../../../electron/main/main.config.js)                       | 配置/路径/密钥叶子模块：`app-config.json` 读写与内存缓存、解析数据目录与缩略图目录、Node 编译缓存目录、安全通道主密钥（运行期随机）、DB 主密钥（safeStorage/DPAPI 持久化）                                                                                | 导出：`resolveCompileCacheDir`、`getMasterKey`、`getAppConfigPath`、`resolveAppConfig`、`saveAppConfig`、`resolveDataDir`、`resolveThumbsDir`、`getDbMasterKey`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 依赖 electron(app/safeStorage)、path/fs/crypto；被 `main.js`、`main.backend.js`、`main.dialogs.js` 引用                                         |
| [`main.backend.js`](../../../electron/main/main.backend.js)                     | 后端子进程全生命周期：日志文件、开发/打包两种 fork 方式、就绪检测、`boot-status`、启动失败看门狗、心跳假死判定、自动重连、即时健康探测、`mem-report/gc-report` 转发                                                                                     | 导出：`registerBackendIpc`、`startBackend`、`stopBackendProcess`、`shutdownBackend`、`waitForBackendReadySignal`、`setBootStatus`、`getBootStatusText`、`getBackendProcess`、`isBackendReady`；IPC：`restart-backend`、`backend-failure`、`probe-backend`、`backend-status`、`boot-status`；广播 `from-main`：`boot-status`、`backend-ready`、`backend-failed`、`backend-reconnecting`                                                                                                                                                                                                                                                                                                                          | 依赖 electron、startup-timer、perf、config；被 `main.js` 调用，与 `main.perf.js` 双向（转发后端消息）                                                       |
| [`main.perf.js`](../../../electron/main/main.perf.js)                           | 性能面板 IPC 与内存采样：逐进程内存列表、总计/近一分钟平均/自启动最高、重启前端/小组件、整体重启、手动 GC、启动耗时                                                                                                                             | 导出：`registerPerfIpc`、`startMemSampling`、`handleBackendMemReport`、`handleBackendGcReport`；IPC：`perf-snapshot`、`perf-restart-frontend`、`perf-restart-widget`、`perf-relaunch-app`、`perf-gc`、`perf-startup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 依赖 electron、privateWorkingSet、startup-timer；被 `main.js` 注入窗口 getter 并调用，承接 `main.backend.js` 转发的后端消息                                   |
| [`main.privateWorkingSet.js`](../../../electron/main/main.privateWorkingSet.js) | 用 koffi 调 `pdh.dll` 读取 Windows「Process V2(*)\Working Set - Private」，得到与任务管理器一致的「专用工作集」口径。查询在 worker 线程内执行：`PdhAddEnglishCounterW` 每个进程内首次调用会同步阻塞约 500ms，放主线程会拖慢启动                           | 导出：`getPrivateWorkingSetKB`（返回 `Promise<Map<pid,KB> \| null>`，首次约 0.7s）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 依赖 koffi、worker_threads；被 `main.perf.js` 引用（须 await）                                                                                   |
| [`main.widget.js`](../../../electron/main/main.widget.js)                       | 工具箱浮窗 + 桌面小组件两个窗口的生命周期与 IPC（创建/隐藏/显示、拖动、缩放、全屏、鼠标穿透、右键菜单、会话级显隐、token 透传）。桌面组件窗口**就在主进程里**：透明顶层窗口 + 置底（z 序插到 `Progman` 之上，没有开关）、拖动 `setContentBounds`（每帧带宽高）、落点持久化、`render-process-gone` 自动重载 | 导出：`registerWidgetIpc`、`createWidgetWindow`、`hideWidgetWindow`、`showWidgetWindow`、`createDesktopWidgetWindow`、`getWidgetWindow`、`getDesktopWidgetWindow`（返回伪窗口对象）、`setDesktopWidgetWindow`、`isDesktopEnabled`、`isDesktopWidgetRunning`；IPC on：`widgets-ready`、`desktop-widget-enabled`、`desktop-widget-desktop-layer`、`widget-resize`、`widget-move-to`、`widget-center`、`widget-restore-position`、`widget-fullscreen`、`widget-restore`、`widget-set-ignore-mouse`、`widget-set-visible`、`widget-drag-start/move/end`、`widget-context-menu`、`widget-set-session-visible`、`to-widget`、`to-main`；IPC handle：`get-session-widget-visible`、`get-desktop-layer-state`（`get-main-token` 已随独立进程删除） | 依赖 electron、`main.startup-timer`、`main.web-prefs`、`main.desktop-layer`；由 `main.js` 注入窗口 getter 与 `loadUrlWithRetry`（`main.dev-loader`） |

| [`main.desktop-layer.js`](../../../electron/main/main.desktop-layer.js) | Windows「置底」定位（仅 Win32 生效）：**不做 `SetParent`**，用 koffi 的 `SetWindowPos` 把窗口插到「`Progman` 之上、所有可见窗口之下」（跳过 `Default IME`/`MSCTFIME UI` 这类不可见系统窗口），`isJustAboveDesktop()` 从 `Progman` 往上找自己来校验，`reassert()` 供点击/失焦/拖动结束后重新压回，`placeAboveDesktop()` 是原语 | 导出：`attach`、`detach`、`reassert`、`placeAboveDesktop`、`isJustAboveDesktop`、`getRect`、`moveWindow`、`isAvailable` | 依赖 koffi、user32；被 `main.widget.js` 引用（失败自动退回普通顶层窗口，总开关 `DESKTOP_LAYER_ENABLED`）。**不要再改回 `SetParent`**：子窗口被移动会让 Electron 原生崩溃（`0xC000041D`），详见 [widgets.md](../widgets.md) |
| [`main.tray.js`](../../../electron/main/main.tray.js) | 无边框标题栏窗口控制 + 系统托盘 + 关闭确认菜单：`win-minimize/win-maximize-toggle/win-close`、`shutdown-action`、托盘驻留与恢复、关闭范围选择（主/工具箱/桌面组件/全部） | 导出：`registerTrayIpc`、`createTray`、`destroyTray`、`isTrayAlive`、`resetShutdownState`、`beginCloseWithoutMenu`、`handleMainClose`；IPC on：`shutdown-action`、`win-minimize`、`win-maximize-toggle`、`win-close`；广播 `from-main`：`shutdown-menu` | 依赖 electron、path/fs；被 `main.js` 注入窗口 getter 与 `createMainWindow` |
| [`main.protocol.js`](../../../electron/main/main.protocol.js) | 打包模式 `app://` 协议服务静态资源（含 asar 流式读取、SPA 回退、防目录穿越、缓存策略）+ 渲染进程 V8 代码缓存目录及其按版本清理 | 导出：`setupRendererCodeCache`、`setupAppProtocol` | 依赖 electron(app/session/protocol)、path/fs/stream；被 `main.js` 在 ready 后调用（scheme 特权注册在 `main.js` 提前完成） |
| [`main.apps.js`](../../../electron/main/main.apps.js) | 桌面小组件·常用软件：选择或拖入 exe/lnk/bat/cmd、文件夹、普通文件并提取名称与图标，点击启动 | 导出：`registerAppsIpc`；IPC：`apps-select-file`、`apps-resolve-paths`、`apps-launch` | 依赖 electron、path、fs、dialogs（复用 `getDialogDir/setDialogDir`）；由 `main.js` 注册并注入 `getMainWindow`（桌面组件与主窗口同进程，无需再注册） |
| [`main.dialogs.js`](../../../electron/main/main.dialogs.js) | 文件/文件夹对话框与本地文件读写类 IPC：选择文件夹/图片、保存背景图、导出保存、打开文件/文件夹、截屏、注释截图保存、数据/缓存目录信息 | 导出：`registerDialogsIpc`、`getDialogDir`、`setDialogDir`；IPC：`select-folder`、`open-folder`、`select-image-file`、`save-background-image`、`save-file`、`open-file`、`screenshot-capture`、`note-save`、`get-data-directories` | 依赖 electron、path/fs、config；被 `main.js` 注入窗口 getter；其目录记忆被 `main.apps.js` 复用 |
| [`main.updater.js`](../../../electron/main/main.updater.js) | 自建版本更新：请求 GitHub Releases 最新版、比较版本、下载 Inno 安装包（带进度）、`update-install` 时静默安装并退出 | 导出：`registerUpdateIpc`、`runUpdateFlow`；IPC handle：`get-app-version`、`update-check`；IPC on：`update-install`；广播 `from-main`：`update-state` | 依赖 electron、path/fs；被 `main.js` 注入发给主窗口的 `send` 出口并在启动后延时调用 `runUpdateFlow` |
| [`main.usb.js`](../../../electron/main/main.usb.js) | U 盘自动打开：配置持久化、轮询 A–Z 盘符、检测到新盘符用资源管理器打开（仅 Windows 生效） | 导出：`registerUsbIpc`、`loadUsbAutoOpenConfig`、`startUsbWatch`、`isUsbAutoOpenEnabled`；IPC：`get-usb-auto-open`、`set-usb-auto-open` | 依赖 electron、path/fs；被 `main.js` 在模块加载期注册 IPC、在 `whenReady` 后加载配置并启动监听 |
| [`main.window-material.js`](../../../electron/main/main.window-material.js) | 窗口原生背景材质：`setBackgroundMaterial('acrylic'|'mica'|'none'...)`，仅 Win11 22H2+ 生效，其余自动回退。主窗口/引导/迁移等仍用它；桌面组件已改为渲染层自绘磨砂，不再依赖系统材质 | 导出：`applyBackgroundMaterial`、`disableBackgroundMaterial` | 依赖 electron；被 `main.js` 引用 |
| [`main.web-prefs.js`](../../../electron/main/main.web-prefs.js) | 全部窗口 `webPreferences` 的公共模板：contextIsolation / sandbox / 关闭 nodeIntegration / preload / `additionalArguments:['--secure-channel']` / webSecurity / spellcheck；差异项（`devTools`、`backgroundThrottling`）参数化传入 | 导出：`buildWebPreferences({ devTools, backgroundThrottling })` | 依赖 electron(app)/path；被 `main.js`、`main.widget.js` 引用（收敛主窗口/引导/迁移/工具箱/桌面组件 5 处重复配置） |
| [`main.startup-timer.js`](../../../electron/main/main.startup-timer.js) | 启动事件计时器：记录 mark 时间线、`end` 定死「启动完成」锚点、结构化 `getTimeline`、`report`/`saveLog` | 导出：`mark`、`end`、`msFromStart`、`report`、`saveLog`、`getTimeline` | 依赖 path/fs/electron(app)；被 `main.js`、`main.backend.js`、`main.widget.js`、`main.perf.js` 引用 |
| [`main.dev-loader.js`](../../../electron/main/main.dev-loader.js) | 开发模式加载器：`devLoadingHtml()` 内联 loading 页、`pollViteAndNavigate(win)` 轮询 Vite、`loadUrlWithRetry(win, url)` 重试导航（同时注入给 `main.widget.js`） | 导出：`devLoadingHtml`、`pollViteAndNavigate`、`loadUrlWithRetry` | 依赖 `main.backend`（`setBootStatus`）与 `main.startup-timer`；仅开发模式加载（`app.isPackaged` 时为 null） |
| [`main.migration.js`](../../../electron/main/main.migration.js) | 数据目录搬迁引擎：校验源文件 → 复制（字节进度）→ 复检（失败单拷 + 全局哈希）→ 写配置 → 删旧目录；进度经注入的 `send` 推送 | 导出：`migrateDataDir(oldDir, target, send)` | 依赖 fs/path/crypto；被 `main.js` 调用（进度窗口与 IPC 仍在 `main.js`） |
| [`main.inpLog.js`](../../../electron/main/main.inpLog.js) | INP 归因落盘（仅开发模式）：接收渲染层 `inp-report`，追加写入 `<数据目录>/inp.log` | 导出：`registerInpLogIpc` | 依赖 electron/fs；由 `main.js` 在非打包环境注册 |
| [`main.path-guard.js`](../../../electron/main/main.path-guard.js) | IPC 路径 / URL 白名单：只接受绝对路径、拒绝系统保护目录与可执行后缀、`realpath` 防 junction、外链只放行 http(s)；纯函数便于单测 | 导出：`isHttpUrl`、`assertSafePath` 等判定函数、`setProtectedRoots` | 依赖 path/fs；被 `main.js`、`main.webview-guard.js` 引用；单测 `testjs/units/pathGuard.test.js` |
| [`main.update-integrity.js`](../../../electron/main/main.update-integrity.js) | 更新包完整性校验：下载地址与重定向地址必须 HTTPS；`sha256:` digest 强制比对，缺失时至少校验大小 | 导出：`assertHttpsUrl`、`sha256File`、`verifyDownloadedFile` | 不依赖 electron；被 `main.updater.js` 引用；单测 `testjs/units/updateIntegrity.test.js` |
| [`main.webview-guard.js`](../../../electron/main/main.webview-guard.js) | `<webview>` 安全护栏：只允许 http(s)、剥离 preload、强制 sandbox/contextIsolation/关闭 Node、拦下载与 `target=_blank`；生产禁刷新快捷键 | 导出：`registerWebviewGuard({ getMainWindow, isDev })` | 依赖 electron、`main.path-guard`（`isHttpUrl`）；由 `main.js` 在模块加载期注册 |

---

## 注意事项

- **新增模块先判断加载时机**：占启动关键路径（窗口、协议、配置、后端）用普通 `require`；其余（更新、对话框、性能面板、U 盘、迁移、常用软件）加到 `main.js` 的 `lazyModule()`，并在 `registerDeferredIpc()` 里注册。
- **新增 IPC 通道要三处同步**：模块内注册、`electron/ipc-channels.json`、`electron/preload.js` 白名单；跨层协议变更同时更新 [security.md](../topics/security.md)。
- **`main.privateWorkingSet.js` 的 PDH 查询必须在 worker 线程**：`PdhAddEnglishCounterW` 首次调用会同步阻塞约 500ms，放主线程会拖慢启动。
- **`main.desktop-layer.js` 不要改回 `SetParent`**：子窗口被移动会让 Electron 原生崩溃（`0xC000041D`），当前用 `SetWindowPos` 插到 `Progman` 之上。
- **`main.widget.js` 的桌面组件窗口在主进程内**：透明顶层窗口 + 置底，不是独立进程；不要按独立子进程的方式改造。

---
