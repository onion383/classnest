# 主进程入口（`electron/main/main.js`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── electron/
    └── main/
        └── main.js
```
<!-- doc-tree:end -->

---

## 综合概述

- **定位**：Electron 主进程的唯一入口（[`main.js`](../../../electron/main/main.js)，`package.json` 的 `main` 指向它），负责启动编排、窗口创建、首次引导与数据迁移流程、退出收尾；不承担各模块内部实现。
- **对外接口**：无 `module.exports`（被 Electron 直接加载）；对渲染层通过 `ipcMain.handle` / `ipcMain.on` 注册入口级通道，对系统通过 `app.whenReady` / `second-instance` / `window-all-closed` / `before-quit` / `activate` 驱动生命周期。
- **依赖与调用方**：依赖 24 个 `main.*.js` 模块（逐步拆出）与 `electron`、`path`、`fs`、`os`；渲染层只能经 `preload.js` 的白名单通道间接触达。

---

## 详细说明

### 1. 模块加载期（`app.whenReady`（应用就绪事件）之前）

| 顺序 | 动作 | 关键约束 |
| --- | --- | --- |
| 1 | `migrateLegacyUserData()`（旧品牌目录迁移）：`campus-assistant` → `classnest`，同盘重命名；失败则回退继续用旧目录 | 必须在使用 `userData`（用户数据目录）之前执行，保证升级后数据还在 |
| 2 | 启用 V8 编译缓存：`require('module').enableCompileCache(userData/node-compile-cache)` | 必须在**任何** `require`（模块加载函数）之前；不能写 `module.enableCompileCache`（Electron 的 `module` 是 CJS（CommonJS 模块规范）包装对象，不是 Node 的 `Module` 实例） |
| 3 | 记录启动计时器 `startupTimer`（`main.startup-timer.js`）并启用开发期 `_profMark` / `_profReq` 打点 | 打点只在 `!app.isPackaged`（非打包环境）生效，打包版是空操作 |
| 4 | 加载关键路径模块（`main.config`、`main.protocol`、`main.window-material`、`main.web-prefs`、`main.tray`、`main.backend`、`main.widget`、`main.webview-guard`、`main.path-guard`） | 这些模块顶层无立即副作用；IPC 注册都在本文件显式调用 |
| 5 | 6 个非关键模块改用 `lazyModule()`（惰性加载）：`main.usb`、`main.updater`、`main.dialogs`、`main.apps`、`main.perf`、`main.migration` | 冷启动时这 6 个 require 合计约 300ms，推迟到建窗之后，避免进首屏关键路径 |
| 6 | `pathGuard.setProtectedRoots([app.getAppPath()])`（设置受保护根目录） | 安装目录（打包后为只读 asar（Electron 应用归档包））禁止被 IPC 写入或启动 |
| 7 | `app.commandLine.appendSwitch('js-flags', '--expose-gc')`（追加 Node 启动参数） | 必须在 ready 之前，主进程与各渲染进程才会暴露 `gc`（垃圾回收接口） |
| 8 | `app.requestSingleInstanceLock()`（单实例锁）+ `second-instance`（二次启动） | 未拿到锁的实例在 `whenReady` 里直接退出；二次启动会唤起或重建主窗口 |
| 9 | `protocol.registerSchemesAsPrivileged()`（`app://` 特权 scheme） | 必须在 ready 之前注册；`standard + secure + supportFetchAPI + corsEnabled + stream + codeCache` 才能让 `localStorage`（本地存储）持久化 |
| 10 | 开发模式附加：`ELECTRON_DISABLE_SECURITY_WARNINGS`（关闭安全警告）、`INP_DEBUG`（交互性能调试）时开 9222 调试端口、`devLoader`（开发模式加载器）仅开发加载 | 正式包不加载 `main.dev-loader`，也不开 CDP（Chrome 调试协议） |

### 2. 主窗口 `createMainWindow()`

- **窗口参数**：1280×800，最小 1200×600（DIP（设备无关像素））；`frame:false`（无边框）、`transparent:false`（不透明窗口）、`backgroundMaterial:'acrylic'`（系统亚克力材质）、`show:false`（先隐藏）、`backgroundColor:'#f0f4f8'`；`webPreferences`（渲染进程安全配置）走 `buildWebPreferences({ devTools: true, webviewTag: true })`。
- **加载**：开发模式先加载内联 loading 页（`devLoader.devLoadingHtml()`），同时并行轮询 Vite（前端开发服务器），就绪后跳转；打包模式直接 `app://local/index.html`。
- **启动计时**：监听渲染层 `[startup]` 日志，带 `@<epoch>`（渲染层自报时刻）的行按该时刻打点；「占位页移除」定稿启动完成（与性能面板同一口径）；12 秒未定稿则用候选时刻兜底。
- **显示**：`ready-to-show`（首帧可显示事件）时 `revealWindow(win, 'provisional')` 并再次确认亚克力材质；另有 1.5 秒兜底显示定时器。
- **关闭**：`close`（窗口关闭事件）交给 `tray.handleMainClose()` 弹「怎样关闭」菜单；`closed`（已关闭事件）只在当前引用相等时清空 `mainWindow`，避免重建时旧窗口误清新窗口。
- **重建**：`recreateMainWindow(mode)` 保留位置/大小/最大化状态；当前主题切换恒传 `frameless`（无边框模式），因此不会触发重建。

### 3. `app.whenReady`（应用就绪事件）编排

1. 未拿到单实例锁 → `app.quit()`（退出应用）并返回。
2. **安装器预热 `--warmup`**（安装器 `[Run]` 段调用一次后立即退出）：`startBackend()` → 等后端就绪（20s 上限）→ 顺序读一遍 `resources/app.asar`（应用归档包，把前端首屏资源读进系统文件缓存）→ 停后端（3s 上限）→ `app.quit()`，另有 3s 后 `app.exit(0)`（立即退出）兜底。**不能直接 `app.exit()`**：Node 编译缓存是异步落盘，直接终止会让缓存来不及写。
3. 正常启动：
   - `setupRendererCodeCache()`（装配渲染进程代码缓存）→ `setupAppProtocol()`（注册 `app://` 协议）；
   - `proceedStartup()`：按 `shouldWarnOsVersion()` / `looksLikeFirstRun()` 决定先建引导窗口还是主窗口；
   - **先建窗口，再 `backend.startBackend()`**（实测调换会让「界面可见」推迟约 143ms）；
   - 建窗与 `fork`（派生子进程）之后 `registerDeferredIpc()`（延迟注册 IPC），注册 U 盘、更新、对话框、常用软件、性能面板 5 组通道，与首屏加载并行；
   - `startMemSampling()`（启动内存采样）。
4. 打包环境启动后 8 秒做一次版本更新检查（`runUpdateFlow()`，避开首屏）。
5. 启动时间线在定稿后 800ms 落盘；12 秒兜底收尾。
6. U 盘监听延后到 `setTimeout(..., 0)`（延时回调），避免同步读配置/枚举盘符阻塞建窗。

### 4. 启动窗口：低版本提示与首次引导（`createSetupWindow()`）

- **窗口参数**：800×540 固定、无边框、系统亚克力；开发模式 `show:false` 等 `setup-ready` 再显示，打包模式直接显示（静态占位页秒出画面）。
- **合并两种首屏**：`plan.warn`（Windows 10 1709 以下提示）与 `plan.setup`（首次引导）共用同一窗口，按「提示 → 引导」顺序展示；`launch-plan` 通道把计划交给渲染层。
- **引导未完成标记**：`userData/setup-incomplete` 在创建引导窗口时写入，`setup-complete` 时删除；中途关闭或退出，下次启动仍进引导。
- **关闭拦截**：`setupRunning` 为真时 `close` 一律 `preventDefault()`；`setup-quit` 与「获取最新的 Windows」会置 `app.isQuitting` 后退出。
- **预热**：`setup-ready` 后后台跑 `runSetupWarmup()`（轮询后端 `GET /api/accounts`（上限 15s）→ 建数据/缩略图/编译缓存目录 → 进度经 `get-setup-warmup` 补齐）。
- **低版本提示**：Windows build < 16299 触发；「忽略」可勾选「不再提示」（写 `userData/os-version-warning-skipped`）；「获取最新的 Windows」打开系统下载页并退出。

### 5. 数据目录 / 缩略图 / 技能目录 / 加密转换

| 通道 | 动作 | 关键点 |
| --- | --- | --- |
| `set-initial-data-dir` | 引导期保存初始数据/缓存目录 | 尚未建库时直接写配置；已建库则复用安全搬迁；完成后重启后端 |
| `set-data-dir` | 变更数据库目录 | 校验：绝对路径、拒绝盘符根/保护目录、目标须为空、不能迁到自身内部、源目录必须有 `index.db` 与 `db-master.key`；先建进度窗口再关其它窗口；成功后切配置、重启后端、重开主窗口；失败保留旧目录并重开后端 |
| `set-db-encryption` | 开关数据库加密 | 先从主窗口 `localStorage`（本地存储）取 JWT（登录令牌）；进度窗口就绪后关闭其它窗口，由渲染层调后端 NDJSON（逐行 JSON）流执行，`migration-dismiss` 回报结果；失败不改库 |
| `set-thumbs-dir` | 变更缩略图缓存目录 | 缓存可再生，不搬迁：写配置 → 停/起后端 |
| `set-skills-dir` | 变更 AI 技能目录 | 复制 → 校验条目数 → 切配置 → 删旧目录；失败保留旧目录并重启后端 |

进度窗口固定 460×280、`alwaysOnTop`、`skipTaskbar`、禁止缩放；`migrationRunning` 期间拦截关闭；`waitMigrationReady()` 4s 超时兜底。

### 6. 入口级 IPC 清单

**`ipcMain.handle`（请求-响应）**：

`open-external`（仅 http/https）、`get-master-key`（安全通道主密钥）、`set-content-protection`（敏感内容防截屏）、`copy-sensitive-text`（剪贴板 TTL（有效期）清理）、`get-pending-notification`（取迁移/引导提示）、`launch-plan`（启动计划）、`get-setup-warmup`（引导预热状态）、`set-initial-data-dir`、`set-data-dir`、`set-db-encryption`、`set-thumbs-dir`、`set-skills-dir`。

**`ipcMain.on`（单向通道）**：

`quit-app`（退出应用）、`show-native-context-menu`（显示原生右键菜单）、`ai-context-menu`（AI 右键菜单）、`theme-chrome`（主题边框）、`migration-ready`（迁移窗口就绪）、`migration-dismiss`（迁移结果回报）、`setup-ready`（引导界面就绪）、`launch-skip-warn`（忽略低版本提示）、`launch-open-download`（打开系统下载页）、`setup-complete`（引导完成）、`setup-quit`（退出引导）。

其余通道由各模块的 `registerXxxIpc()` 注册（见 [modules.md](./modules.md) 与 [README.md](./README.md) 第 2.6 节）。

### 7. 退出与二次启动

- `window-all-closed`（所有窗口关闭事件）：托盘图标还在（主窗口关闭后转入后台）就保持进程与后端存活；否则 `backend.shutdownBackend()`（关闭后端子进程），非 macOS 直接 `app.quit()`。
- `activate`（应用激活事件，macOS）：没有窗口时销毁托盘并重建主窗口；工具箱/桌面组件不在此时直接创建，等新主窗口 `widgets-ready` 后由 `main.widget.js` 按设置恢复。
- `before-quit`（退出前事件）：`tray.destroyTray()`（销毁托盘）+ `backend.shutdownBackend()`，保证后端不残留。

---

## 注意事项

- **`fork`（派生子进程）不能提前到 ready 之前**：`DB_MASTER_KEY`（数据库主密钥）依赖 `safeStorage`（系统安全存储）的异步加密器，它由 `isAsyncEncryptionAvailable()`（异步加密可用性检查）在 ready 之后惰性初始化；提前调用会生成随机新密钥导致旧库打不开。同步 API 已于 Electron 45 弃用、46 移除。
- **不要调换「建窗 → fork」顺序**，也不要尝试把 fork 放进 worker 线程：实测界面可见时间会变差，且引入进程残留风险。
- **启动计时有两个锚点**：窗口首次显示只是候选，定稿看「占位页移除」；引导窗口例外（停留不计入启动耗时）。
- **迁移流程先建进度窗口再关其它窗口**：否则窗口数归零会触发 `window-all-closed` 提前退出；同时 `tray.beginCloseWithoutMenu()` 放行主窗口关闭。
- **失败语义要保住**：数据目录/加密转换失败一律保留旧目录与旧配置；重启后端，避免用户回主界面后连不上。
- **引导预热轮询地址是硬编码的 `127.0.0.1:3000`**：`waitBackendReady()` 用 IPv4 字面量轮询 `/api/accounts`。后端只绑 IPv4，写成 `localhost` 会先解析 `::1` 被拒再回退，白做一次失败连接；改后端端口时要同步这里。
- **新增入口级通道要三处同步**：本文件注册、`electron/ipc-channels.json`（通道名单）、`electron/ipc-policy.json`（授权表）。
- **`get-master-key` 的调用方受 `ipc-policy.json` 授权表约束**：只有表中列出的窗口角色能调用（v5 起由 `installIpcGuard()` 统一校验发送方角色，表外通道 fail-closed）；新增窗口时要同时在授权表登记其角色，否则会直接被拒。
- **`content-protection` 与剪贴板清理有平台差异**：前者依赖 Windows `SetWindowDisplayAffinity`（窗口防截屏 API）；后者默认 60s、只清「仍是这段文本」的剪贴板。

---
