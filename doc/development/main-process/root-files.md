# 主进程根文件与安装器资源（`electron/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── electron/
    ├── inno/
    │   ├── compile.mjs  # 定位 Inno Setup 6/7 的 ISCC.exe（环境变量→PATH→常见目录→注册…
    │   └── setup.iss  # Inno Setup 安装脚本：自定义安装界面（居中 logo/标题/安装路径/协议勾选）、…
    ├── afterPack.js  # electron-builder afterPack 钩子（仅 win32）：剔除运行时用不…
    ├── preload.js  # 预加载脚本。用 contextBridge 暴露 window.electron（send/…
    └── startup.html  # 打包模式下引导窗口的静态占位页（纯内联 HTML/CSS，展示「班集 启动中…」，不依赖 J…
```
<!-- doc-tree:end -->

---

## 综合概述

- **定位**：`electron/` 根目录下不参与运行时模块拆分的文件（预加载、占位页、打包钩子、IPC 通道清单、图标），以及 `inno/`、`installer-assets/` 里的安装器与素材；入口 `main.js` 与 21 个模块分别见 [entry.md](./entry.md)、[modules.md](./modules.md)。
- **公共逻辑**：`preload.js`（预加载脚本）是所有窗口的安全边界；`ipc-channels.json`（通道清单）是通道白名单的单一来源；`afterPack.js`（打包后钩子）与 `inno/compile.mjs`（安装器编译脚本）只在打包期执行，运行时不参与。
- **局限**：本页只列文件职责、导出与依赖；打包流程、剔除清单、Vue 3.6 / 3.5 双分支见 [build-and-branches.md](../topics/build-and-branches.md)，安装包参数细节见该专题第 5 节。

---

## 详细说明

### 1. `electron/` 根文件

| 文件 | 职责 | 关键导出 / IPC 通道 | 依赖与被依赖 |
| --- | --- | --- | --- |
| [`preload.js`](../../../electron/preload.js) | 预加载脚本。用 `contextBridge` 暴露 `window.electron`（`send/on/off/once/invoke`）与 `window.__SECURE_CHANNEL__`，通过白名单约束收发通道 | `window.electron`、`window.__SECURE_CHANNEL__`；白名单：`validSendChannels`、`validInvokeChannels`、`validReceiveChannels` | 依赖 electron(contextBridge/ipcRenderer)；被各窗口 `webPreferences.preload` 引用 |
| [`ipc-channels.json`](../../../electron/ipc-channels.json) | IPC 通道白名单单一来源：`send` / `invoke` / `receive` 三组通道名，打包时经 `additionalArguments` 注入渲染进程 | 无模块导出（JSON 数据） | 被 `preload.js` 读取校验；新增通道必须同步这里 |
| [`startup.html`](../../../electron/startup.html) | 打包模式下引导窗口的静态占位页（纯内联 HTML/CSS，展示「班集 启动中…」，不依赖 JS，保证「秒出画面」） | 无 | 被 `main.js` 的 `createSetupWindow` 经 `app://local/setup.html` 使用（同源占位） |
| [`afterPack.js`](../../../electron/afterPack.js) | electron-builder `afterPack` 钩子（仅 win32）：剔除运行时用不到的 Chromium 组件、把 `LICENSES.chromium.html` 压缩为 `third-party-licenses.zip` | `module.exports = async function(context)` | 依赖 fs/path/zlib；被 electron-builder 打包流程调用 |
| [`app-icon.png`](../../../electron/app-icon.png) | 应用窗口/任务栏图标（`main.js` 的 `APP_ICON_PATH`），也被安装器自绘界面复用 | 无 | 被 `main.js`、`inno/setup.iss` 引用 |
| [`tray-icon.png`](../../../electron/tray-icon.png) | 系统托盘图标 | 无 | 被 `main.tray.js` 读取 |

### 2. 安装器与素材（`electron/inno/`、`electron/installer-assets/`）

| 文件 | 职责 | 关键导出 / IPC 通道 | 依赖与被依赖 |
| --- | --- | --- | --- |
| [`inno/compile.mjs`](../../../electron/inno/compile.mjs) | 定位 Inno Setup 6/7 的 `ISCC.exe`（环境变量→PATH→常见目录→注册表），并编译 `setup.iss`；找不到时给出中文提示与下载地址 | 无（ESM 脚本，`process.exit` 返回编译结果）；读 `INNO_SETUP_ISCC` 环境变量 | 依赖 node:fs/child_process/url/path；由 `package.json` 构建脚本调用 |
| [`inno/setup.iss`](../../../electron/inno/setup.iss) | Inno Setup 安装脚本：自定义安装界面（居中 logo/标题/安装路径/协议勾选）、协议弹窗、静默升级参数、AppId 固定 GUID、输出 `班集-Setup-x.y.z.exe` | 无（编译期脚本）；`#define MyAppVersion` 需与 `package.json` version 一致 | 被 `compile.mjs` 编译；引用 `..\app-icon.png`、`..\installer-assets\*`、`{#AppDir}\win-unpacked\*`（`AppDir` 默认 `release`，Vue 3.6 预览通道传 `release36`） |
| [`inno/wizard-large.bmp`](../../../electron/inno/wizard-large.bmp) | 安装向导左侧大图（modern 风格，164x314） | 无 | 被 `setup.iss` 引用 |
| [`inno/wizard-small.bmp`](../../../electron/inno/wizard-small.bmp) | 安装向导右上角小图（55x55） | 无 | 被 `setup.iss` 引用 |
| [`installer-assets/installer.ico`](../../../electron/installer-assets/installer.ico) | 安装程序图标 | 无 | 被 `setup.iss` 的 `SetupIconFile` 引用 |
| [`installer-assets/uninstaller.ico`](../../../electron/installer-assets/uninstaller.ico) | 卸载程序图标（随包资源） | 无 | 安装器资源 |
| [`installer-assets/license.txt`](../../../electron/installer-assets/license.txt) | 用户协议全文（UTF-8 BOM），编译期解压到临时目录供 [Code] 段展示 | 无 | 被 `setup.iss` 的 `[Files]`/`[Code]` 引用 |
| [`installer-assets/field-bg.png`](../../../electron/installer-assets/field-bg.png) | 自绘安装页安装路径输入框的圆角背景图 | 无 | 被 `setup.iss` 的 `[Files]`/`[Code]` 引用 |

安装流程本身（前端构建 → electron-builder → `afterPack` 精简 → Inno Setup 编译）不在这里重复，见 [build-and-branches.md](../topics/build-and-branches.md)。

---

## 注意事项

- **`afterPack.js` 仅 win32 生效**：它按白名单剔 Chromium 组件并压缩 `LICENSES.chromium.html`；许可压缩包不能删，组件名单改动要同步打包专题的剔除清单。
- **`preload.js` 与 `ipc-channels.json` 必须同步**：新增通道不同步这两个文件，渲染层调用会被直接拒绝；通道清单的完整断言由 `docs:verify` 覆盖。
- **图标类文件被多处引用**：`app-icon.png` 同时是窗口图标、exe 图标与安装器素材；替换时要同步 `inno/setup.iss` 和打包配置，否则安装后图标不一致。
- **安装器素材改名要全局搜索**：`installer.ico`、`uninstaller.ico`、`license.txt`、`field-bg.png` 都被 `setup.iss` 的 `[Files]` / `[Code]` 段按文件名引用。

---
