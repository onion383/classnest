# 其他前端模块（stores / router / styles / utils / 指令 / 独立窗口）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
├── student-frontend/
│   ├── src/
│   │   ├── router/
│   │   │   └── index.js  # 路由入口
│   │   ├── stores/
│   │   │   └── theme.js  # 主题 store（唯一 Pinia store）
│   │   ├── styles/
│   │   │   ├── dialog-transition.css  # 弹窗过渡：遮罩淡入 + 卡片 96%→101.5%→100% 回弹
│   │   │   ├── index.css  # 样式入口：导入 Tailwind 与主题、注册 @theme（主题变量声明）、全局 user…
│   │   │   ├── select.css  # AppSelect 的 .av-select 全局样式
│   │   │   ├── theme-base-accent.css  # base 的 B 方案覆盖（深蓝主色 + 工具栏琥珀暖色），并内含 base 的夜间规则（随…
│   │   │   ├── theme-base.css  # 基础主题（默认）：:root 变量与半透明主区
│   │   │   ├── theme-glass.css  # 毛玻璃：蓝灰底 + 薄白玻璃 + 荧光描边 + 光斑/内置背景图
│   │   │   ├── theme-glass2.css  # 新毛玻璃：薰衣草冷雾、漂移柔光斑、分层阴影，透明度由 --glass-opacity 驱动
│   │   │   ├── theme-night.css  # glass / glass2 的夜间配色层（按需加载；base 夜间在 theme-base…
│   │   │   ├── themeLoader.js  # 主题 CSS 按需加载（避免首屏加载全部主题）
│   │   │   ├── themetransition.js  # 主题切换的过渡控制
│   │   │   └── utilities.css  # 工具类：skeleton-block、glass、transition-theme、cont…
│   │   ├── subwindows/
│   │   │   ├── migration/
│   │   │   │   ├── main.js  # 迁移入口：仅 applyTheme + 挂载
│   │   │   │   └── Migration.vue  # 数据库迁移窗口（进度、失败态、打开目录）
│   │   │   └── setup/
│   │   │       ├── main.js  # 首次引导入口：setupApiClient + applyTheme 后挂载
│   │   │       └── Setup.vue  # 欢迎页 + 分步表单（注册、班级信息、主题）
│   │   └── utils/
│   │       ├── albumMedia.js  # 媒体类型判定、缩略图版本拼接、parseThumbBatch 二进制解析
│   │       ├── apiPaths.js  # 认证端点路径单一来源（AUTH_API）：登出、媒体凭据等端点的真实路径。后端 authRo…
│   │       ├── apiUrl.js  # apiUrl(path)、resourceUrl(path)：补后端地址并为图片/背景追加 …
│   │       ├── authStorage.js  # token / 当前用户的唯一读写点（空值语义、坏 JSON 防御）
│   │       ├── backendReady.js  # waitForBackendReady(timeoutMs=4000)（等待后端就绪，超时 …
│   │       ├── base64.js  # Uint8Array/Blob → base64（分块拼接，避免大文件参数展开爆栈）
│   │       ├── blobError.js  # 二进制下载的失败原因归一入口：parseBlobError / materializeBlo…
│   │       ├── changelog.js  # parseChangelog(markdown)：把根目录 CHANGELOG.md 解析为…
│   │       ├── chartHit.js  # 图表命中算法（柱/横条/饼扇区/图例）
│   │       ├── collator.js  # zhCollator、naturalCollator（复用 Intl.Collator）
│   │       ├── contextMenuRegistry.js  # 右键菜单互斥：claimContextMenu(token, close)（新菜单登记时让上…
│   │       ├── csvCell.js  # CSV 单元格转义（逗号/引号/换行）
│   │       ├── dateTime.js  # pad2 / formatDate / formatDateTime / formatDat…
│   │       ├── dialogOverlayPulse.js  # 遮罩点击提示的全局事件委托（捕获阶段拦截）
│   │       ├── dialogPrefetch.js  # v-preload 指令：悬停 80ms 后加载弹窗 chunk
│   │       ├── dialogStack.js  # 弹窗 / 弹层共用的层级栈：pushDialog / removeDialog / isTo…
│   │       ├── disposables.js  # 「资源随作用域释放」登记表（createDisposables() / useDisposa…
│   │       ├── dutyColumns.js  # 前端「值日列名」的唯一来源：ALL_COLUMN（内置「全部」列）、CYCLES、WEEKD…
│   │       ├── dutyIndex.js  # accumulateDutyIndex(dailyRows, weights)：值日指数（公…
│   │       ├── dutyWeightGroups.js  # 权重表多子行联动：pickEditedText（与旧值逐行比对，挑出用户刚改的那格）、par…
│   │       ├── fileName.js  # 文件名校验/清洗、默认名生成
│   │       ├── hbSubset.js  # harfbuzz wasm 子集引擎（每次新建实例、用完即弃）
│   │       ├── heatColor.js  # 热力配色（分数/密度映射）
│   │       ├── httpClient.js  # setupApiClient({ baseURL, getToken })、backendB…
│   │       ├── importSheet.js  # Excel/CSV 解析、表头识别与模糊匹配：normalizeLoose（全角/空白/标点…
│   │       ├── inpProbe.js  # INP 探针前端打点
│   │       ├── jwt.js  # JWT 解码（base64url，不用 atob）与过期判断
│   │       ├── latestOnly.js  # createLatest()：全库唯一的序号守卫（begin() / isCurrent()…
│   │       ├── leaveState.js  # isOnLeaveOn(leave, date) / leavesOn(leaves, da…
│   │       ├── licenseDocs.js  # 第三方许可证英文原文按需加载：LICENSE_TEXTS（7 份，?raw 构建期内联）。只…
│   │       ├── localRecover.js  # 本机信息恢复的请求层：fetchLocalAccounts（列出非隐私库账号）、recove…
│   │       ├── pdfFont.js  # 中文 PDF 字体：全量缓存 + 按字符动态子集，失败回退全量
│   │       ├── perfMark.js  # 启动/首屏分段打点（v6 · P1-01）：perfNow（epoch 毫秒，与主进程/后端…
│   │       ├── renameOutcome.js  # readRenameOutcome(res)：把后端改名响应的 renamed.skippe…
│   │       ├── reportError.js  # 统一错误上报/提示（含上下文）
│   │       ├── routePrefetch.js  # prefetchRoute(router, path)：悬停预取目标路由 chunk
│   │       ├── rowReuse.js  # 表格行复用与 key 稳定（减少重渲染）
│   │       ├── saveFile.js  # 保存对话框与写文件（经主进程 save-file）
│   │       ├── saveResult.js  # classifySaveResult(res)：主进程 save-file 返回值的三态判定…
│   │       ├── semesterStart.js  # 学期开始日/教学周推算
│   │       ├── sequencedCache.js  # createSequencedCache({ load, ttl })：带账号代次的进程内缓…
│   │       ├── serialSaver.js  # 串行保存器：并发合并、失败即停、每轮取最新状态
│   │       ├── tableSearch.js  # 表格关键字过滤与「无结果」判定
│   │       ├── tokenRenewal.js  # absorbRenewalTokens(headers, { generation, set…
│   │       ├── undoRecorder.js  # 撤销登记的唯一入口：校验 spec、发送、失败弱提示（绝不静默）、成功后刷新 Ctrl+Z …
│   │       ├── userScopedCache.js  # 用户作用域缓存：缓存自己登记清理函数，登出时统一清（不点名）—— 三个登出入口不用各记一遍，…
│   │       ├── weekDates.js  # 「星期列 → 具体日期」的唯一口径：formatDateLabel（2026.3.1，月和日…
│   │       ├── widgetDataChanged.js  # 「主窗口写成功 → 通知挂件刷新」的唯一判定与广播入口：WIDGET_DOMAINS（与挂件…
│   │       └── zipPeek.js  # 只读备份包开头的 bundle.json（peekBundleMeta / bundleNe…
│   ├── dev-vite.js  # Vite 启动器：--vue36 切 Vue 3.6 通道、build 子命令；见
│   ├── resize-bg.mjs  # 背景图压缩（sharp）
│   ├── vite.config.js  # 5 入口构建、非阻塞 CSS、warmup、代理
│   └── vite.perf.config.js  # 性能测量配置（端口 5174/5175，代理 3100）
└── eslint.config.mjs
```
<!-- doc-tree:end -->

本篇收拢前端其余基础设施：状态（仅一个 store）、路由、主题样式、工具函数、指令、引导 / 迁移窗口、静态资源与构建配置。页面与组件本身的职责见 [views.md](./views.md) 与 [components/README.md](./components/README.md)。

---

## 综合概述

- **定位**：前端公共基础设施层（`stores/`（状态目录）、`router/`（路由目录）、`styles/`（样式目录）、`utils/`（工具函数目录）、`subwindows/setup|migration`（首次引导 / 数据库迁移窗口）、`public/`（静态资源）与构建配置），被所有页面、组件与独立窗口共用。
- **公共逻辑**：主题只有一个 store（`useThemeStore().applyTheme()`（主题仓库的应用主题方法）统一下发 `data-theme`（主题标识属性）/ CSS 变量 / 背景图）；请求统一经 `setupApiClient`（axios 装配函数，带 token、退避重试与安全通道）；token 与当前用户只经 `authStorage`（登录态唯一读写模块）读写；主题样式按需加载（`themeLoader.js`（主题样式加载器））。
- **局限**：不展开页面与组件的内部实现，也不展开工具箱 / 桌面小组件（见 [widgets.md](../widgets.md)）；构建与分支细节见 [topics/build-and-branches.md](../topics/build-and-branches.md)。

---

## 详细说明

### 1. 状态管理（`src/stores/`）

#### [`theme.js`](../../../student-frontend/src/stores/theme.js) · 主题 store（唯一 Pinia store）
- 内部：`PRESETS`（预设主题列表）为 `base`（彩色色块）/ `glass`（毛玻璃）/ `glass2`（新毛玻璃）；状态 `currentTheme`（当前主题）/ `backgroundImage`（背景图）/ `bgMaskOpacity`（背景遮罩不透明度）/ `glassOpacity`（玻璃层透明度）/ `iconStyle`（图标样式）/ `topbarColor`（顶栏配色）/ `animationsEnabled`（动画开关）。
- `applyTheme()`（应用主题函数）：写 `data-theme`（主题标识）、`data-topbar-color`（顶栏配色标识）、`no-animations`（关闭动画类）、CSS 变量与背景图，并 `theme-chrome`（主题窗口外观）IPC（进程间通信）通知主进程。
- **调用方**：`App.vue`、`Sidebar.vue`、`IconGlyph.vue`、各入口 `main.js`、`SettingsView`。

### 2. 路由（`src/router/`）

#### [`index.js`](../../../student-frontend/src/router/index.js) · 路由入口
- 路由表 15 页 + `/account → /settings` 重定向 + 兜底重定向；`PROD`（生产环境）用 `createWebHashHistory`（哈希路由），`dev`（开发环境）用 `createWebHistory`（普通 URL 路由）。
- `beforeEach`（路由前置守卫）：本地校验 `JWT`（登录令牌）`exp`（过期时间）、无 `token` 跳 `/login`、首次请求 `/api/me`、进首页 `ensureDashboardData()`（确保首页数据）。
- 导出 `prefetchRoutes()`（预取路由）：空闲时逐条预热懒加载 `chunk`（代码分包）。

### 3. 样式（`src/styles/`，12 个文件：10 个 CSS + 2 个 JS）

| 文件 | 作用 |
| --- | --- |
| [`index.css`](../../../student-frontend/src/styles/index.css) | 样式入口：导入 Tailwind 与主题、注册 `@theme`（主题变量声明）、全局 `user-select:none`（禁止选中文本）、复选框动画、`no-animations`（关闭动画类）开关、number spinner（数字输入框上下箭头）淡入规则 |
| [`theme-base.css`](../../../student-frontend/src/styles/theme-base.css) | 基础主题（默认）：`:root` 变量与半透明主区 |
| [`theme-base-accent.css`](../../../student-frontend/src/styles/theme-base-accent.css) | base 的 B 方案覆盖（深蓝主色 + 工具栏琥珀暖色），并内含 base 的夜间规则（随入口常驻） |
| [`theme-glass.css`](../../../student-frontend/src/styles/theme-glass.css) | 毛玻璃：蓝灰底 + 薄白玻璃 + 荧光描边 + 光斑/内置背景图 |
| [`theme-glass2.css`](../../../student-frontend/src/styles/theme-glass2.css) | 新毛玻璃：薰衣草冷雾、漂移柔光斑、分层阴影，透明度由 `--glass-opacity` 驱动 |
| [`theme-night.css`](../../../student-frontend/src/styles/theme-night.css) | glass / glass2 的夜间配色层（按需加载；base 夜间在 `theme-base-accent.css`） |
| [`utilities.css`](../../../student-frontend/src/styles/utilities.css) | 工具类：`skeleton-block`、`glass`、`transition-theme`、`content-visibility-auto`、`.btn-plain`、`.dlg-close`、基础/极简主题下的遮罩模糊 |
| [`select.css`](../../../student-frontend/src/styles/select.css) | `AppSelect` 的 `.av-select` 全局样式 |
| [`dialog-transition.css`](../../../student-frontend/src/styles/dialog-transition.css) | 弹窗过渡：遮罩淡入 + 卡片 96%→101.5%→100% 回弹 |
| [`themeLoader.js`](../../../student-frontend/src/styles/themeLoader.js) | 主题 CSS 按需加载（避免首屏加载全部主题） |
| [`themetransition.js`](../../../student-frontend/src/styles/themetransition.js) | 主题切换的过渡控制 |

### 4. 工具（`src/utils/`，50 个）

| 文件 | 导出 / 职责 | 调用方 |
| --- | --- | --- |
| [`apiPaths.js`](../../../student-frontend/src/utils/apiPaths.js) | 认证端点路径**单一来源**（`AUTH_API`）：登出、媒体凭据等端点的真实路径。后端 `authRoutes` 挂在 `/api` 下，**没有 `/api/auth` 这一层** —— 写成 `/api/auth/logout` 会恒 404 且被 `.catch(() => {})` 吞掉（登出看着成功、服务端 session 没吊销） | `AccountDialog`、`SettingsView`、`apiUrl.js` |
| [`apiUrl.js`](../../../student-frontend/src/utils/apiUrl.js) | `apiUrl(path)`、`resourceUrl(path)`：补后端地址并为图片/背景追加 token | 各视图的资源显示处 |
| [`httpClient.js`](../../../student-frontend/src/utils/httpClient.js) | `setupApiClient({ baseURL, getToken })`、`backendBaseUrl()`：各窗口共用的 axios 装配（token、退避重试、安全通道） | `subwindows/setup`、`widget`、`desktop-widget` 的 `main.js` |
| [`backendReady.js`](../../../student-frontend/src/utils/backendReady.js) | `waitForBackendReady(timeoutMs=4000)`（等待后端就绪，超时 4 秒）、`isBackendReady()`（是否已就绪） | `httpClient`、`main.js` |
| [`changelog.js`](../../../student-frontend/src/utils/changelog.js) | `parseChangelog(markdown)`：把根目录 `CHANGELOG.md` 解析为 `{ version, date, notes }` 列表（按日期倒序、兼容 v 前缀与多种分隔符） | `AboutView`、`testjs/units/changelog.test.js` |
| [`jwt.js`](../../../student-frontend/src/utils/jwt.js) | JWT 解码（base64url，不用 `atob`）与过期判断 | `router/index.js`、`authStorage` |
| [`authStorage.js`](../../../student-frontend/src/utils/authStorage.js) | token / 当前用户的唯一读写点（空值语义、坏 JSON 防御） | 全局 |
| [`authSync.js`](../../../student-frontend/src/utils/authSync.js) | 跨窗口登录态同步的唯一实现：按「账号 + 库 + 会话」判身份（滑动续期不算换人），换号/登出时清用户级缓存并广播 `AUTH_CHANGED_EVENT`；三个窗口入口共用一份判定 | `main.js`、`subwindows/{widget,desktop-widget}/main.js` |
| [`localRecover.js`](../../../student-frontend/src/utils/localRecover.js) | 本机信息恢复的请求层：`fetchLocalAccounts`（列出非隐私库账号）、`recoverFromLocalDb`（拼 `<slug>.db` 并落 token）、`submitRecoveredPassword`（换发常规 token）。登录页与「设置 → 修改密码 → 忘记密码」**共用一份**，避免两边对 `mustChangePassword` 的处理分叉成「一边卡在设密码、一边拿 recover 态调业务接口被 401」 | `Login`、`LocalRecoverDialog` |
| [`dateTime.js`](../../../student-frontend/src/utils/dateTime.js) | `pad2 / formatDate / formatDateTime / formatDateTimeLocal` | 各弹窗、`AnimatedClock`、工具箱 `Timer` |
| [`collator.js`](../../../student-frontend/src/utils/collator.js) | `zhCollator`、`naturalCollator`（复用 `Intl.Collator`） | 表格排序、文件名自然排序 |
| [`saveFile.js`](../../../student-frontend/src/utils/saveFile.js) | 保存对话框与写文件（经主进程 `save-file`） | 导出组件 |
| [`base64.js`](../../../student-frontend/src/utils/base64.js) | Uint8Array/Blob → base64（分块拼接，避免大文件参数展开爆栈） | 数据管理导出、班费导出 |
| [`renameOutcome.js`](../../../student-frontend/src/utils/renameOutcome.js) | `readRenameOutcome(res)`：把后端改名响应的 `renamed.skipped` 翻译成可展示提示。学生改名时后端会一并级联「只存姓名」的关联表，旧名有同名学生时跳过级联（宁可不同步也不能改错人）；此前前端**完全不看这个字段** → 用户以为改名全部生效，实际值日表/座位表还挂着旧名，历史值日指数从此归不到他名下，且界面不报错 | `useTableCRUD` 的单格保存 |
| [`fileName.js`](../../../student-frontend/src/utils/fileName.js) | 文件名校验/清洗、默认名生成 | 导出组件 |
| [`csvCell.js`](../../../student-frontend/src/utils/csvCell.js) | CSV 单元格转义（逗号/引号/换行） | CSV 导出 |
| [`importSheet.js`](../../../student-frontend/src/utils/importSheet.js) | Excel/CSV 解析、表头识别与模糊匹配：`normalizeLoose`（全角/空白/标点/星期写法归一）、`matchCandidate`（编辑距离 + 包含关系，同分返回候选）、`resolveHeader`（按同义词顺序解析实际列名） | `ImportExcel`、`DutyView`、`DutySettingsDialog` |
| [`tableSearch.js`](../../../student-frontend/src/utils/tableSearch.js) | 表格关键字过滤与「无结果」判定 | `useTableCRUD`、`DynamicTable` |
| [`albumMedia.js`](../../../student-frontend/src/utils/albumMedia.js) | 媒体类型判定、缩略图版本拼接、`parseThumbBatch` 二进制解析 | `AlbumView`、`useThumbBatch` |
| [`heatColor.js`](../../../student-frontend/src/utils/heatColor.js) | 热力配色（分数/密度映射） | `DashboardView`、`ScoreManagement` |
| [`chartHit.js`](../../../student-frontend/src/utils/chartHit.js) | 图表命中算法（柱/横条/饼扇区/图例） | `AiChart` |
| [`pdfFont.js`](../../../student-frontend/src/utils/pdfFont.js) | 中文 PDF 字体：全量缓存 + 按字符动态子集，失败回退全量 | `exportFormats` |
| [`perfMark.js`](../../../student-frontend/src/utils/perfMark.js) | 启动/首屏**分段打点**（v6 · P1-01）：`perfNow`（epoch 毫秒，与主进程/后端同一时钟）、`createPhaseLog` / `markSince` / `phase`（挂在 axios config 的 `__perf` 上累积各段）、`logSummary`（汇总成一条，带 `@epoch` 兼容启动探针）。**没有 `__perf` 时全部空转**（普通请求零开销），打点抛错也静默、绝不影响请求 | `useDashboardData`、`secureAxios`、`httpClient`、`DashboardView` |
| [`hbSubset.js`](../../../student-frontend/src/utils/hbSubset.js) | harfbuzz wasm 子集引擎（每次新建实例、用完即弃） | `pdfFont` |
| [`semesterStart.js`](../../../student-frontend/src/utils/semesterStart.js) | 学期开始日/教学周推算 | `ScheduleView`、AI 工具 |
| [`serialSaver.js`](../../../student-frontend/src/utils/serialSaver.js) | 串行保存器：并发合并、失败即停、每轮取最新状态 | 设置页写入 |
| [`rowReuse.js`](../../../student-frontend/src/utils/rowReuse.js) | 表格行复用与 key 稳定（减少重渲染） | `DynamicTable` |
| [`dialogPrefetch.js`](../../../student-frontend/src/utils/dialogPrefetch.js) | `v-preload` 指令：悬停 80ms 后加载弹窗 chunk | 各视图按钮 |
| [`dialogOverlayPulse.js`](../../../student-frontend/src/utils/dialogOverlayPulse.js) | 遮罩点击提示的全局事件委托（捕获阶段拦截） | `main.js` |
| [`routePrefetch.js`](../../../student-frontend/src/utils/routePrefetch.js) | `prefetchRoute(router, path)`：悬停预取目标路由 chunk | `Sidebar` |
| [`reportError.js`](../../../student-frontend/src/utils/reportError.js) | 统一错误上报/提示（含上下文） | 各 composable/视图 |
| [`inpProbe.js`](../../../student-frontend/src/utils/inpProbe.js) | INP 探针前端打点 | 仅调试构建 |
| [`latestOnly.js`](../../../student-frontend/src/utils/latestOnly.js) | `createLatest()`：**全库唯一**的序号守卫（`begin()` / `isCurrent()` / `current()` / `invalidate()`）。语义 = 「异步结果回来时假定世界没变」。手写 `let seq=0` 抄三遍容易把比较写反。原先还有一份 `composables/useSeq.js`（`take()` / `isLatest()`），语义相同 → 2026-11-04 合并到本文件，旧文件删除；**别再新建第二份** | 值日模式切换、相册选择器、表格刷新、AI 模型识别、每日回填、历史快照 |
| [`leaveState.js`](../../../student-frontend/src/utils/leaveState.js) | `isOnLeaveOn(leave, date)` / `leavesOn(leaves, date)`：**「今天在不在校」的唯一口径** = 状态「请假中」且 开始时间 ≤ 今天 ≤ 结束时间（首尾都算；结束时间为空按「请到销假为止」；还没开始的假不算；`date` 可传 `Date` 或带时间的日期串，按本地日期比）。此前这个口径在 4 处以不同写法各写一遍：首页右上角数字数「所有请假中」（不看日期）、首页「今日请假」卡片筛「开始时间=今天」→ 同一屏两个数字互相矛盾（跨天假只进数字不进卡片）；桌面挂件是第三份；请假管理的「当前请假中」是第四份（但它是**管理视角**，含过期未销假，别硬套本文件） | 首页 `attendance` 与「今日请假」卡片、桌面挂件 `attendance` |
| [`userScopedCache.js`](../../../student-frontend/src/utils/userScopedCache.js) | 用户作用域缓存：缓存自己登记清理函数，登出时统一清（**不点名**）—— 三个登出入口不用各记一遍，下次加缓存也不会漏 | 学期开始日缓存、仪表盘快照 |
| [`disposables.js`](../../../student-frontend/src/utils/disposables.js) | 「资源随作用域释放」登记表（`createDisposables()` / `useDisposables()`）：定时器、事件监听器、AbortController **就地登记**，作用域结束时统一释放。资源创建处与销毁处本来隔着几百行，靠人脑配对必然漏（审查 v4 批 11 的根因修复）。`useDisposables()` 用 `getCurrentScope` + `onScopeDispose`，**不用组件实例代理**（本项目已全库清零） | 搜索弹窗的远程检索、便签窗口的拖拽与截屏链、迁移窗的完成定时器、桌面挂件的窗口级监听、表格行定位的重试链 |
| [`blobError.js`](../../../student-frontend/src/utils/blobError.js) | 二进制下载的**失败原因归一入口**：`parseBlobError` / `materializeBlobError` / `friendlyError` / `installBlobErrorNormalizer`。`responseType: 'blob'` 时后端 `{ error }` 也被包成 Blob → `err.response.data.error` 恒空、界面只剩「导出失败」；这里把失败体还原成对象并补 `friendlyMessage` / `message`，全库既有 `err.response?.data?.error` 写法自动生效。**必须注册在安全通道拦截器之前**（安全通道靠 `err.response.data.d` 判会话过期，Blob 形状下会误判） | `httpClient` 装配；导出 / 收据下载 / 相册另存的 catch |
| [`widgetDataChanged.js`](../../../student-frontend/src/utils/widgetDataChanged.js) | 「主窗口写成功 → 通知挂件刷新」的**唯一判定与广播入口**：`WIDGET_DOMAINS`（与挂件 5 个 GET 一一对应）、`normalizeApiPath`、判定函数。写请求默认通知，明确无关的基础设施写（聊天/相册/账户/导出/握手）排除，撤销/还原/AI 落表等未知业务写**保守全量失效**；复用既有 `to-widget` 通道、不新增 IPC 通道名，5 分钟轮询保留兜底 | `httpClient` 成功拦截器（仅主窗口开启） |
| [`contextMenuRegistry.js`](../../../student-frontend/src/utils/contextMenuRegistry.js) | 右键菜单互斥：`claimContextMenu(token, close)`（新菜单登记时让上一个自行 `emit('close')`，同实例重新定位不关自己）返回 `release`（仅在自己仍是当前菜单时清空）。座位页行标签与列头是两个组件实例，模块级登记表让四个使用点自动互斥 | 各 `ContextMenu` 使用点 |
| [`dialogStack.js`](../../../student-frontend/src/utils/dialogStack.js) | 弹窗 / 弹层**共用的层级栈**：`pushDialog` / `removeDialog` / `isTopDialog`（幂等）、`pushEscLayer` / `removeEscLayer`、`consumeEscape(e, { open, self })`（同一事件只消费一次，`WeakSet` 记录）。原先 `openStack` 写在 `<script setup>` 里，每个实例各一份 → 一次 Esc 连带关掉父弹窗 | `DialogShell`、`AppSelect`、`AppHelp`、表头筛选面板 |
| [`saveResult.js`](../../../student-frontend/src/utils/saveResult.js) | `classifySaveResult(res)`：主进程 `save-file` 返回值的三态判定（`ok` / `fail` / `canceled`），兼容旧形状（`canceled` / `success:false` / 只有 `filePath`），脏输入一律按失败。此前多个调用点只判 `canceled`，写盘失败会被当成「已保存」 | `saveFile.js`、`AiChart`、`RecoveryKeyDialog` |
| [`zipPeek.js`](../../../student-frontend/src/utils/zipPeek.js) | 只读备份包开头的 `bundle.json`（`peekBundleMeta` / `bundleNeedsSecret` / `isEncryptedMeta`）：读前 64KB 判断恢复时**要不要输口令**（明文库不用、钥匙明文随包不用、只有 `wrappedByPassword/Mnemonic` 才要），解析不出来保守显示输入框。`isEncryptedMeta` 必须与后端 `services/bundleRestore.js` 逐字一致 | 登录页「从数据库登录」 |
| [`sequencedCache.js`](../../../student-frontend/src/utils/sequencedCache.js) | `createSequencedCache({ load, ttl })`：**带账号代次的进程内缓存**。TTL 复用 + 写入前核对代次（`createLatest`）+ 失败不缓存；`invalidate()` 同时清值并作废在途，`clear()` 只清值不动代次。解决「登出清了缓存、在途响应又把 A 的数据写回来」的跨账号泄漏 | `AiGridPreview` 的学生姓名表 |
| [`tokenRenewal.js`](../../../student-frontend/src/utils/tokenRenewal.js) | `absorbRenewalTokens(headers, { generation, setToken, storeMediaToken })`：滑动续期凭据的**落盘判定**，代次不符（期间登出/换号）一律丢弃；`generation` 必传，缺省抛 `TypeError`（否则会静默停掉续期）。代次复用 `userScopedGeneration()`，不另立第二份「换人」信号 | `apiUrl.absorbRenewal`、`httpClient` 与 `secureAxios` 拦截器 |
| [`undoRecorder.js`](../../../student-frontend/src/utils/undoRecorder.js) | 撤销登记的**唯一入口**：校验 spec、发送、失败弱提示（绝不静默）、成功后刷新 Ctrl+Z 可用态、批次不逐条刷；另有 `newUndoBatchId`、`rowSnapshot`（从全表快照取完整行）。此前全库 6 种写法各自决定失败反馈，三条写成 `.catch(() => {})` | 所有写路径（`useUndo`、`useTableCRUD`、各业务组件） |
| [`weekDates.js`](../../../student-frontend/src/utils/weekDates.js) | 「星期列 → 具体日期」的唯一口径：`formatDateLabel`（`2026.3.1`，月和日不补零；非法与不存在日期返回空串）、`buildWeekDateMap(baseMonday, days)`、`currentWeekDateMap`、`weekdayNameOf`。**按星期名取而不按列下标取**（表头可拖拽，按下标会在拖完对不上） | `GridView` 列头、课表页、值日页 |
| [`dutyColumns.js`](../../../student-frontend/src/utils/dutyColumns.js) | 前端「值日列名」的唯一来源：`ALL_COLUMN`（内置「全部」列）、`CYCLES`、`WEEKDAYS`、`GROUP_TYPES`、`MAX_GROUPS`、`cleanColumns`、`bigColumnNames(groupType, count)`（由「任务分组 + 数量」派生，不落库）、`withoutAllColumn`。规则必须与后端 `services/dutyConfig.js` 一致 | 值日设置、值日页、大扫除 |
| [`dutyIndex.js`](../../../student-frontend/src/utils/dutyIndex.js) | `accumulateDutyIndex(dailyRows, weights)`：值日指数（公平账本）的**唯一累加口径**。逐日快照按「项目 × 星期」乘权重记到姓名下，非数字 / 缺失权重整格跳过；展示值与排表账本只差结算区间，不许各写一遍 | `DutyView` 的两个消费点、公平账本 |
| [`dutyWeightGroups.js`](../../../student-frontend/src/utils/dutyWeightGroups.js) | 权重表**多子行联动**：`pickEditedText`（与旧值逐行比对，挑出用户刚改的那格）、`parseWeightText`（空/非数字 → 0，越界夹到 `[min,max]`）、`resolveWeightGroups`（把改动同步到该项目所有天；一维按均值口径比对）。底层一个项目只有一个权重值，多行只是同一值的展示 | `DutyView` 权重表 |
| [`licenseDocs.js`](../../../student-frontend/src/utils/licenseDocs.js) | 第三方许可证**英文原文**按需加载：`LICENSE_TEXTS`（7 份，`?raw` 构建期内联）。只含英文原文，**不许手写或翻译正文**（译文不具法律效力，中文说明在 `AboutView` 的 `LICENSE_ZH`） | `AboutView` 的协议弹窗（动态 import） |

### 5. 指令

- `v-preload`：定义在 [`dialogPrefetch.js`](../../../student-frontend/src/utils/dialogPrefetch.js)，`main.js` 全局注册；用法 `v-preload="loadXxxDialog"`。
- 遮罩点击提示不是指令，而是 [`dialogOverlayPulse.js`](../../../student-frontend/src/utils/dialogOverlayPulse.js) 的全局事件委托。

### 6. 独立窗口（引导 / 迁移）

| 文件 | 职责 |
| --- | --- |
| [`subwindows/setup/main.js`](../../../student-frontend/src/subwindows/setup/main.js) | 首次引导入口：`setupApiClient` + `applyTheme` 后挂载 |
| [`subwindows/setup/Setup.vue`](../../../student-frontend/src/subwindows/setup/Setup.vue) | 欢迎页 + 分步表单（注册、班级信息、主题） |
| [`subwindows/migration/main.js`](../../../student-frontend/src/subwindows/migration/main.js) | 迁移入口：仅 `applyTheme` + 挂载 |
| [`subwindows/migration/Migration.vue`](../../../student-frontend/src/subwindows/migration/Migration.vue) | 数据库迁移窗口（进度、失败态、打开目录） |

工具箱与桌面小组件见 [widgets.md](../widgets.md)。

### 7. 静态资源（`public/`）

| 文件 | 说明 |
| --- | --- |
| `NotoSansSC-6.ttf` / `.ttf.gz` | PDF 中文字体源；`.ttf` 不进安装包，`.gz` 随包 |
| `logo.png` / `logo-icon.png` | 应用 Logo / 图标版 |
| `favicon.svg` / `icons.svg` | 站点图标与图标雪碧图 |
| `glass-bg.jpg` / `glass-bg-opt.jpg` | 毛玻璃背景原图与压缩版（长边 2560） |
| `alipay.jpg` / `wechatpay.png` | 关于页收款码 |

### 8. 根目录其他文件

| 文件 | 说明 |
| --- | --- |
| [`dev-vite.js`](../../../student-frontend/dev-vite.js) | Vite 启动器：`--vue36` 切 Vue 3.6 通道、`build` 子命令；见 [build-and-branches.md](../topics/build-and-branches.md) |
| [`vite.config.js`](../../../student-frontend/vite.config.js) | 5 入口构建、非阻塞 CSS、warmup、代理 |
| [`vite.perf.config.js`](../../../student-frontend/vite.perf.config.js) | 性能测量配置（端口 5174/5175，代理 3100） |
| [`resize-bg.mjs`](../../../student-frontend/resize-bg.mjs) | 背景图压缩（sharp） |
| `package.json` | 前端依赖与脚本（`dev` / `build` / `preview`） |

### 9. 代码检查

- 根目录 [`eslint.config.mjs`](../../../eslint.config.mjs)，`npm run lint` 一次跑 `student-frontend/src`、`student-backend`、`electron`。
- 只做低级错误护栏：不启用 `eslint:recommended` 与审美类 vue 规则，不挂进 `build`，不扫 `testjs/`。

---

## 注意事项

- **主题只走 store**：切主题统一调 `useThemeStore().applyTheme()`（主题仓库的应用主题方法）（`data-theme`（主题标识属性）/ CSS 变量 / 背景图 / `theme-chrome`（通知主进程换窗口外观的 IPC）一起下发）；各窗口入口都先 `applyTheme()`（应用主题函数）再挂载，否则首帧是默认主题。
- **token 只走 `authStorage`**：`token`（登录令牌）/ `currentUser`（当前用户）的裸存储键只能出现在 `authStorage.js`（登录态唯一读写模块）（`behavior/sfc-conventions.test.js`（架构标准行为测试）会扫全量 SFC（单文件组件）拦截）。
- **请求与资源地址统一封装**：接口经 `setupApiClient`（axios 装配函数，带 token、退避重试与安全通道）装配的实例，图片 / 背景用 `apiUrl`（拼接口地址）/ `resourceUrl`（拼资源地址并附 token）追加 token；直接拼裸地址会漏掉重试与鉴权。
- **主题 CSS 按需加载**：主题样式由 `themeLoader.js`（主题样式加载器）按主题加载，夜间配色单独在 `theme-night.css`（夜间配色样式文件）；新增主题或配色要落到对应 `theme-*.css`（各主题样式文件），改完跑 `radius-audit.js`（圆角使用审计脚本）与主题切换检查。
- **新增窗口入口要登记构建**：独立窗口的 HTML 入口必须写进 `vite.config.js`（Vite 构建配置）的 `rollupOptions.input`（Rollup 打包入口清单），否则打包后找不到页面；入口脚本按 `widgets.md` 的做法先 `applyTheme()`（应用主题函数）再挂载。

---
