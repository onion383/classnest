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
│   │       ├── apiUrl.js  # apiUrl(path)、resourceUrl(path)：补后端地址并为图片/背景追加 …
│   │       ├── authStorage.js  # token / 当前用户的唯一读写点（空值语义、坏 JSON 防御）
│   │       ├── backendReady.js  # waitForBackendReady(timeoutMs=4000)（等待后端就绪，超时 …
│   │       ├── chartHit.js  # 图表命中算法（柱/横条/饼扇区/图例）
│   │       ├── collator.js  # zhCollator、naturalCollator（复用 Intl.Collator）
│   │       ├── csvCell.js  # CSV 单元格转义（逗号/引号/换行）
│   │       ├── dateTime.js  # pad2 / formatDate / formatDateTime / formatDat…
│   │       ├── dialogOverlayPulse.js  # 遮罩点击提示的全局事件委托（捕获阶段拦截）
│   │       ├── dialogPrefetch.js  # v-preload 指令：悬停 80ms 后加载弹窗 chunk
│   │       ├── fileName.js  # 文件名校验/清洗、默认名生成
│   │       ├── hbSubset.js  # harfbuzz wasm 子集引擎（每次新建实例、用完即弃）
│   │       ├── heatColor.js  # 热力配色（分数/密度映射）
│   │       ├── httpClient.js  # setupApiClient({ baseURL, getToken })、backendB…
│   │       ├── importSheet.js  # Excel/CSV 解析与表头归一化
│   │       ├── inpProbe.js  # INP 探针前端打点
│   │       ├── jwt.js  # JWT 解码（base64url，不用 atob）与过期判断
│   │       ├── pdfFont.js  # 中文 PDF 字体：全量缓存 + 按字符动态子集，失败回退全量
│   │       ├── reportError.js  # 统一错误上报/提示（含上下文）
│   │       ├── routePrefetch.js  # prefetchRoute(router, path)：悬停预取目标路由 chunk
│   │       ├── rowReuse.js  # 表格行复用与 key 稳定（减少重渲染）
│   │       ├── saveFile.js  # 保存对话框与写文件（经主进程 save-file）
│   │       ├── semesterStart.js  # 学期开始日/教学周推算
│   │       ├── serialSaver.js  # 串行保存器：并发合并、失败即停、每轮取最新状态
│   │       └── tableSearch.js  # 表格关键字过滤与「无结果」判定
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
- 内部：`PRESETS`（预设主题列表）为 `base`（彩色色块）/ `glass`（毛玻璃）/ `glass2`（新毛玻璃）（+ 用户自定义）；状态 `currentTheme`（当前主题）/ `customColors`（自定义颜色）/ `customThemes`（自定义主题）/ `backgroundImage`（背景图）/ `bgMaskOpacity`（背景遮罩不透明度）/ `glassOpacity`（玻璃层透明度）/ `iconStyle`（图标样式）/ `topbarColor`（顶栏配色）/ `animationsEnabled`（动画开关）。
- `applyTheme()`（应用主题函数）：写 `data-theme`（主题标识）、`data-topbar-color`（顶栏配色标识）、`no-animations`（关闭动画类）、CSS 变量与背景图，并 `theme-chrome`（主题窗口外观）IPC（进程间通信）通知主进程。
- **调用方**：`App.vue`、`Sidebar.vue`、`IconGlyph.vue`、各入口 `main.js`、`SettingsView`。

### 2. 路由（`src/router/`）

#### [`index.js`](../../../student-frontend/src/router/index.js) · 路由入口
- 路由表 15 页 + `/account → /settings` 重定向 + 兜底重定向；`PROD`（生产环境）用 `createWebHashHistory`（哈希路由），`dev`（开发环境）用 `createWebHistory`（普通 URL 路由）。
- `beforeEach`（路由前置守卫）：本地校验 `JWT`（登录令牌）`exp`（过期时间）、无 `token` 跳 `/login`、首次请求 `/api/me`、进首页 `ensureDashboardData()`（确保首页数据）。
- 导出 `prefetchRoutes()`（预取路由）：空闲时逐条预热懒加载 `chunk`（代码分包）。

### 3. 样式（`src/styles/`，11 个）

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

### 4. 工具（`src/utils/`，25 个）

| 文件 | 导出 / 职责 | 调用方 |
| --- | --- | --- |
| [`apiUrl.js`](../../../student-frontend/src/utils/apiUrl.js) | `apiUrl(path)`、`resourceUrl(path)`：补后端地址并为图片/背景追加 token | 各视图的资源显示处 |
| [`httpClient.js`](../../../student-frontend/src/utils/httpClient.js) | `setupApiClient({ baseURL, getToken })`、`backendBaseUrl()`：各窗口共用的 axios 装配（token、退避重试、安全通道） | `subwindows/setup`、`widget`、`desktop-widget` 的 `main.js` |
| [`backendReady.js`](../../../student-frontend/src/utils/backendReady.js) | `waitForBackendReady(timeoutMs=4000)`（等待后端就绪，超时 4 秒）、`isBackendReady()`（是否已就绪） | `httpClient`、`main.js` |
| [`jwt.js`](../../../student-frontend/src/utils/jwt.js) | JWT 解码（base64url，不用 `atob`）与过期判断 | `router/index.js`、`authStorage` |
| [`authStorage.js`](../../../student-frontend/src/utils/authStorage.js) | token / 当前用户的唯一读写点（空值语义、坏 JSON 防御） | 全局 |
| [`dateTime.js`](../../../student-frontend/src/utils/dateTime.js) | `pad2 / formatDate / formatDateTime / formatDateTimeLocal` | 各弹窗、`AnimatedClock`、工具箱 `Timer` |
| [`collator.js`](../../../student-frontend/src/utils/collator.js) | `zhCollator`、`naturalCollator`（复用 `Intl.Collator`） | 表格排序、文件名自然排序 |
| [`saveFile.js`](../../../student-frontend/src/utils/saveFile.js) | 保存对话框与写文件（经主进程 `save-file`） | 导出组件 |
| [`fileName.js`](../../../student-frontend/src/utils/fileName.js) | 文件名校验/清洗、默认名生成 | 导出组件 |
| [`csvCell.js`](../../../student-frontend/src/utils/csvCell.js) | CSV 单元格转义（逗号/引号/换行） | CSV 导出 |
| [`importSheet.js`](../../../student-frontend/src/utils/importSheet.js) | Excel/CSV 解析与表头归一化 | `ImportExcel` |
| [`tableSearch.js`](../../../student-frontend/src/utils/tableSearch.js) | 表格关键字过滤与「无结果」判定 | `useTableCRUD`、`DynamicTable` |
| [`albumMedia.js`](../../../student-frontend/src/utils/albumMedia.js) | 媒体类型判定、缩略图版本拼接、`parseThumbBatch` 二进制解析 | `AlbumView`、`useThumbBatch` |
| [`heatColor.js`](../../../student-frontend/src/utils/heatColor.js) | 热力配色（分数/密度映射） | `DashboardView`、`ScoreManagement` |
| [`chartHit.js`](../../../student-frontend/src/utils/chartHit.js) | 图表命中算法（柱/横条/饼扇区/图例） | `AiChart` |
| [`pdfFont.js`](../../../student-frontend/src/utils/pdfFont.js) | 中文 PDF 字体：全量缓存 + 按字符动态子集，失败回退全量 | `exportFormats` |
| [`hbSubset.js`](../../../student-frontend/src/utils/hbSubset.js) | harfbuzz wasm 子集引擎（每次新建实例、用完即弃） | `pdfFont` |
| [`semesterStart.js`](../../../student-frontend/src/utils/semesterStart.js) | 学期开始日/教学周推算 | `ScheduleView`、AI 工具 |
| [`serialSaver.js`](../../../student-frontend/src/utils/serialSaver.js) | 串行保存器：并发合并、失败即停、每轮取最新状态 | 设置页写入 |
| [`rowReuse.js`](../../../student-frontend/src/utils/rowReuse.js) | 表格行复用与 key 稳定（减少重渲染） | `DynamicTable` |
| [`dialogPrefetch.js`](../../../student-frontend/src/utils/dialogPrefetch.js) | `v-preload` 指令：悬停 80ms 后加载弹窗 chunk | 各视图按钮 |
| [`dialogOverlayPulse.js`](../../../student-frontend/src/utils/dialogOverlayPulse.js) | 遮罩点击提示的全局事件委托（捕获阶段拦截） | `main.js` |
| [`routePrefetch.js`](../../../student-frontend/src/utils/routePrefetch.js) | `prefetchRoute(router, path)`：悬停预取目标路由 chunk | `Sidebar` |
| [`reportError.js`](../../../student-frontend/src/utils/reportError.js) | 统一错误上报/提示（含上下文） | 各 composable/视图 |
| [`inpProbe.js`](../../../student-frontend/src/utils/inpProbe.js) | INP 探针前端打点 | 仅调试构建 |

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
