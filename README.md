# 班集（ClassNest）

面向班级日常管理的桌面应用。数据全部保存在本机（加密 SQLite），不依赖云服务。MIT 开源授权

## 功能

| 模块        | 说明                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 首页        | 班级信息框（时钟 / 班风 / 倒计时）+ 今日课程、今日值日、班费剩余、请假、今日加分 Top4、今日活动、班级相册等卡片，点击直达对应页面                                                             |
| 班级管理      | 学生名单：动态列增删、单元格编辑、排序/搜索、右键菜单、剪切粘贴、去重、导入导出；班干部管理：职务树 / 组织图、成员增删、拖拽排序                                                                  |
| 座位表       | 网状座位编排、拖拽交换、区域选择、单/双人座与走廊、座位模板、周快照与回填、权重设置、智能排表（可存草稿）                                                                               |
| 课程表       | 实行课表 / 一般课表（模板）、学期与节次设置、周快照与回填                                                                                                      |
| 值日        | `daily` / `big` 两种模式、劳动项目与星期设置、权重、随机编排（草稿）、周快照与回填                                                                                   |
| 分组管理      | 分组维度 / 小组 / 成员管理、智能分组并写回、成员拖动、撤销                                                                                                    |
| 加分管理      | 个人 / 小组加减分、今日统计、时间轴、导出                                                                                                              |
| 请假        | 请假记录、销假 / 撤销销假、时间轴、逾期未销假提醒、联系电话联动保存                                                                                                 |
| 班费        | 收支记录（动态列）、收据上传与鉴权查看、班费剩余统计、导入导出                                                                                                     |
| 相册        | 文件夹相册 + 虚拟相册；按 EXIF 拍摄时间的日期时间轴（读不到归入底部「未知时间」）、缩略图批量加载与虚拟滚动、多选移动 / 合并相册、扫描任务管理（暂停 / 继续 / 断点续扫）、删除进回收站可撤销、导出相册索引、视频封面                 |
| 活动        | 班级活动记录 + 倒计时                                                                                                                        |
| AI 助手     | OpenAI 兼容多模型、流式对话、查询 / 图表 / 数据体检 / 排布等工具、写入提案（逐条确认或完全权限）、技能（输入 `/` 调用）、长期记忆、只读子代理、联网搜索、附件解析（PDF / Word / PPT / Excel）、AI 操作可撤销      |
| 工具箱浮窗     | 悬浮工具箱：正计时 / 倒计时、随机点名、屏幕注释、一键截屏，可拖动、鼠标穿透                                                                                             |
| 桌面小组件     | 桌面常驻面板：时钟、倒计时、下一节课、课程、今日值日、人数、常用软件（8 格，可拖入文件），支持置底与落点记忆                                                                             |
| 通用表格 / 交互 | 全局撤销重做（跨重启保留，`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`）、标题栏全局搜索（页面、设置项与业务数据）、导入导出 Excel / CSV / HTML / PDF / Markdown / 纯文本 / JSON / PNG |
| 账号        | 多账号、四种安全等级（明文 / 无密码 / 密码 / 超级隐私）、12 字恢复密钥、找回密码、离线恢复、数据库加密转换与导出备份                                                                    |
| 设置        | 账号、学期、撤销记录、主题（基础 / 毛玻璃 / 新毛玻璃 + 自定义、日夜模式、背景图、透明度、图标样式、标题栏配色）、工具箱、桌面组件、性能面板、保存路径、数据目录、数据管理（技能文件 / 对话导出）、危险操作                         |
| 关于 / 更新   | 版本信息、检查更新、下载进度、重启并安装、更新历史                                                                                                           |

## 技术栈

- **桌面端**：Electron 44，自定义 `app://` 安全协议加载前端，无边框窗口 + 系统亚克力材质，托盘常驻、单实例运行；窗口统一 `sandbox` + `contextIsolation`，IPC 走白名单。

- **前端**：Vue 3.5（Vite 8 + Tailwind CSS 4 + Pinia 4 + Vue Router 5）；另带 Vue 3.6 + Vapor 预览通道（同一份源码可切换编译）。

- **主题**：3 套预设（`base` / `glass` / `glass2`）+ 自定义主题；支持日夜模式与图标样式切换。

- **后端**：Node.js + Express 5，由主进程 `child_process.fork` 拉起为子进程，仅监听 `127.0.0.1`。

- **数据**：本地加密 SQLite（`better-sqlite3-multiple-ciphers`）；每位班主任一个独立加密库，主密钥经 Electron `safeStorage`（DPAPI）加解密。

- **安全**：JWT 鉴权 + 回环 HTTP 安全通道（ECDH P-256 + HKDF + AES-256-GCM）；AI 读写表白名单 + 提案确认 + 只读子代理；外部网页只进隔离 `<webview>`。

- **打包**：electron-builder（`--dir`）+ Inno Setup；更新包校验 HTTPS + SHA-256。

## 文档

文档分两套：**[用户使用文档目录](doc/user/README.md)**（面向使用者，讲软件的使用方法）与 **[开发文档总目录](doc/development/README.md)**（面向维护者，按源码整理）。开发文档各文件职责与架构说明从总目录进入：

- [用户使用文档](doc/user/README.md)（32 篇：卷首、页面操作、通用功能、数据与安全、设置、支持）

- [Electron 主进程开发文档](doc/development/main-process/README.md)

- [后端开发文档](doc/development/backend/README.md)（[接口](doc/development/backend/routes.md) / [公共服务](doc/development/backend/services.md) / [数据层](doc/development/backend/data-layer.md)）

- [前端开发文档](doc/development/frontend/README.md)（含 [页面](doc/development/frontend/views.md) / [组件](doc/development/frontend/components/README.md) / [组合式](doc/development/frontend/composables.md) / [其他](doc/development/frontend/misc.md)）

- [小组件文档](doc/development/widgets.md)（工具箱浮窗 + 桌面小组件）

- [专题文档](doc/development/topics/README.md)：AI / 性能 / 打包与分支 / 界面设计与交互 / 安全

- [依赖与许可证](doc/development/dependencies/README.md)

- [测试资产（testjs）](doc/development/testing/README.md)

- [文档写作、更新与校验](doc/development/dev-doc-verification.md)（写作模板与规则、更新流程与映射、可信度、校验项、不足与记录）

> 文档一致性可用 `npm run docs:verify` 复检（死链 / 源码覆盖 / 路由 / 依赖版本与许可 / 关键计数 / 脚本覆盖 / doc-tree / 禁用词与格式），见 [文档写作、更新与校验 · 文档校验](doc/development/dev-doc-verification.md#三文档校验)。

## 目录结构

```
classnest/
├── electron/                    # Electron 主进程
│   ├── main/main.js             # 主进程入口（package.json 的 main）
│   ├── main/main.*.js           # 21 个拆分模块（backend/perf/tray/widget/protocol/updater/...）
│   ├── preload.js               # 预加载脚本（IPC 白名单注入）
│   ├── ipc-channels.json        # IPC 通道白名单单一来源
│   ├── startup.html             # 引导窗口静态占位页
│   ├── afterPack.js             # 打包后精简（剔除 Chromium 组件、压缩许可）
│   ├── inno/                    # Inno Setup 脚本与向导素材
│   └── installer-assets/        # 安装器图标、协议文本、背景图
├── student-frontend/            # Vue 前端
│   ├── index / setup / migration / widget / desktop-widget.html   # 5 个窗口入口
│   ├── dev-vite.js / vite.config.js / vite.perf.config.js
│   ├── vue36/                   # Vue 3.6 预览依赖（与主线隔离）
│   └── src/
│       ├── views/               # 15 个页面（SettingsView、ScheduleView 为目录）
│       ├── components/          # 76 个组件（base/tables/dialogs/ai/album/data-manage/...）
│       ├── composables/         # 19 个组合式函数（表格 CRUD、网格、撤销、相册时间轴等）
│       ├── subwindows/          # setup / migration / widget / desktop-widget 入口
│       ├── stores/ router/ styles/ utils/ api/ config/ wasm/
├── student-backend/             # Express 后端（fork 为子进程）
│   ├── app.js / init.js / db.js
│   ├── dbManager/               # 多加密库、连接缓存、备份、AI 记忆/技能目录
│   ├── schema/                  # 按域拆分的表结构与迁移
│   ├── middleware/              # JWT 鉴权
│   ├── routes/                  # 业务路由（含 ai/、undo/）
│   ├── services/                # 表格服务、安全通道、清洗、FFmpeg、OCR、解压等
│   ├── utils/
│   └── albumScan.js / scanWorker.js / worker.scan.js / albumThumbs.js / albumExif.js / albumOps.js
├── testjs/                      # units / behavior / smoke / probe / tools
├── resources/ffmpeg/            # 随包 FFmpeg（LGPL）
├── doc/                         # 文档（development/ 开发，user/ 使用）
├── release/ · release36/        # 3.5 / 3.6 打包产物
├── electron-builder.json / eslint.config.mjs / package.json
```

## 环境要求

- Windows（当前主要目标平台）

- Node.js **≥ 22.12**（`package.json` 的 `engines`；Vite 8 亦要求较新版本）

- 原生模块（`better-sqlite3-multiple-ciphers`、`sharp`、`koffi` 等）已通过 `@electron/rebuild` 按 Electron ABI 重编译；**目标机无需安装 Node.js**

## 快速开始

```bash
npm install                # postinstall 会安装 student-backend 依赖
npm run electron:dev       # 同时启动 Vite + Electron（完整应用）
npm run dev                # 只起前端 Vite（无 Electron、无后端）
```

Vue 3.6 + Vapor 预览通道：

```bash
npm run setup:vue36        # 安装 3.6 预览依赖到 student-frontend/vue36
npm run electron:dev36     # 3.6 通道的完整应用
npm run dev:new            # 3.6 通道只起 Vite
```

## 常用脚本

| 命令                                                     | 作用                                                  |
| ------------------------------------------------------ | --------------------------------------------------- |
| `npm run electron:dev`                                 | Vite + Electron（3.5 主线）                             |
| `npm run electron:dev36`                               | Vite + Electron（3.6 预览）                             |
| `npm run dev` / `dev:new`                              | 仅 Vite（3.5 / 3.6）                                   |
| `npm run build` / `build:new`                          | 仅构建前端（3.5 / 3.6）                                    |
| `npm run electron:build`                               | 前端 → electron-builder（`--dir`）→ Inno，产物在 `release/` |
| `npm run electron:buildnew`                            | 同上，走 3.6 通道，产物在 `release36/`                        |
| `npm run build:win:inno`                               | 只编译安装包（需先有 unpacked 产物）                             |
| `npm test`                                             | units + behavior（约 2.4s）                            |
| `npm run test:units` / `test:behavior`                 | 单独跑某一层                                              |
| `npm run smoke`                                        | 链路冒烟（约 1min，发版前）                                    |
| `npm run test:all`                                     | 快测 + 冒烟                                             |
| `npm run seed`                                         | 灌测试数据（需后端在跑）                                        |
| `npm run lint`                                         | ESLint 检查三块代码                                       |
| `npm run check:boundaries` / `check:boundaries:strict` | 错误边界检查（strict 更严格）                                  |
| `npm run docs:verify`                                  | 文档一致性校验（死链 / 覆盖 / 路由 / 依赖 / 计数）                     |
| `npm run inp`                                          | 交互延迟（INP）测量；需 `INP_DEBUG=1` 启动应用                    |

## 构建与打包

```bash
npm run build              # 只构建前端产物（student-frontend/dist）
npm run electron:build     # 构建 + electron-builder（--dir）+ Inno 安装包
npm run build:win:inno     # 仅生成安装包（需先完成 electron-builder 打包）
```

- 安装包输出 `release/班集-Setup-x.y.z.exe`（3.6 通道为 `release36/`）。

- 打包前建议清理编译缓存（`node_modules/.cache`）后再执行。

- 打包流程、剔除/保留清单与双通道机制见 [打包与分支专题](doc/development/topics/build-and-branches.md)。

## 环境变量

实际生效的只有后端端口与 JWT 密钥，其余由主进程自动注入：

| 变量                                                | 默认值    | 说明                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------- |
| `PORT`                                            | `3000` | 后端监听端口（仅 `127.0.0.1`）；`app.js` 读 `process.env.PORT` |
| `JWT_SECRET`                                      | 自动生成   | 可选；未设置时用 `data/.jwt-secret`                         |
| `DB_MASTER_KEY`                                   | —      | 主进程注入（DPAPI 持久化的库主密钥），**无需手填**                      |
| `SECURE_MASTER`                                   | —      | 主进程每次运行随机生成，**无需手填**                                |
| `DATA_DIR` / `ALBUM_THUMBS_DIR` / `AI_SKILLS_DIR` | —      | 主进程按配置注入，**无需手填**                                   |

前端 dev 端口写死在 [`vite.config.js`](student-frontend/vite.config.js) 的 `server.port`（5173），可用 `dev-vite.js --port` 覆盖。

> 根目录 `.env` 里的 `BACKEND_PORT` / `FRONTEND_PORT` 是历史占位，**当前代码不读取**；改端口请用上面的 `PORT` 或 `vite --port`。

## 数据位置与备份

- 默认数据目录：Electron `userData/data`（Windows 下通常为 `%APPDATA%/<应用名>/data`，可在「设置 → 数据目录设置」迁移）。

- 核心文件：`index.db`（账号登记）、`<slug>.db`（各账号加密库）、`db-master.key`、`.jwt-secret`、`uploads/`、`album-thumbs/`、`album-trash/`、`snapshots/`、`ai-memory/`、`ai-skills/`。

- 迁移/备份：设置页「导出数据库」、登录页「从备份恢复」、数据库加密↔明文转换；结构细节见 [安全专题](doc/development/topics/security.md)。

- 日志：`data/backend.log`、`data/startup.log`；启动耗时与内存口径见 [性能专题](doc/development/topics/performance.md)。

## 说明

- 后端开发模式从 `student-backend/` 启动，打包后从 `app.asar.unpacked/student-backend` 启动（原生模块与子进程必须在 asar 外）。

- FFmpeg（LGPL 版）随安装包分发，用于相册视频封面；构建时不要禁用 x86asm。

- 前端打包后用自定义 `app://` 协议加载（而非 `file://`），以获得可持久化 origin（登录态与设置才能留存）。

- 许可与第三方声明：见 [依赖与许可证](doc/development/dependencies/licenses.md)。

## 许可

本项目采用 [MIT License](LICENSE.md)（MIT 许可证）发布。

- 你可以自由使用、复制、修改、合并、发布、分发、再许可和/或销售本软件，包括商业用途。

- 分发时只需在所有副本或重要部分中保留版权声明与许可声明。

- 源代码仓库：<https://github.com/onion383/classnest>

- 第三方依赖遵循各自许可证，见 [依赖与许可证](doc/development/dependencies/licenses.md)。

Copyright (C) 2026 无聊的小洋葱
