# 前端层（`student-frontend/`）

运行在 Electron 渲染进程中的 Vue 3 单页应用，通过 HTTP 与后端子进程通信（默认 `127.0.0.1:3000`），通过白名单 IPC（进程间通信）与主进程通信。

---
## 一、前端整体机制

### 1. 前端定位与职责

- 承载全部业务界面：学生、班干部、分组、课表、座位、值日、加减分、请假、班费、相册、活动、AI 助手、设置、关于。
- 承载 5 个独立窗口入口：主窗口、首次引导、数据库迁移、工具箱浮窗、桌面小组件。
- 前端侧机制：无边框标题栏、主题与背景、登录态、后端就绪等待、请求加密（安全通道）、撤销重做、懒加载与预取、KeepAlive。

### 2. 前端技术栈

| 项 | 实际值 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5.45 | 组合式 API + `<script setup>`（组合式 API 简洁脚本）；可选 Vue 3.6 + `Vapor`（新渲染模式）通道（见 [build-and-branches.md](../topics/build-and-branches.md)） |
| 构建 | Vite 8.3.4 | 多页面入口，`base:'./'`（相对路径基址），`build.target:'chrome120'`（目标浏览器版本） |
| 样式 | Tailwind CSS 4.3.3 | `@tailwindcss/vite`（Vite 插件），无 `tailwind.config`，令牌用 `@theme`（主题变量声明）写在 [`src/styles/index.css`](../../../student-frontend/src/styles/index.css) |
| 状态 | Pinia 4.1.0 | 仅一个 `store`（状态仓库）：[`src/stores/theme.js`](../../../student-frontend/src/stores/theme.js) |
| 路由 | vue-router 5.4.0 | `PROD`（生产环境）用 `HashHistory`（哈希路由），`dev`（开发环境）用 `WebHistory`（普通 URL 路由） |
| 图标 | `@lucide/vue` 1.58 | 统一走 `IconGlyph`（图标组件） |
| 其他 | axios / exceljs / xlsx / jspdf / html2canvas / sortablejs / dompurify / marked / pinyin-match | 见 [dependencies/frontend.md](../dependencies/frontend.md) |

### 3. 前端入口与构建

5 个 HTML 入口、入口脚本的关键动作与构建配置见 [entry.md](./entry.md)；本节不再展开。

### 4. 前端路由与页面映射

路由定义、页面职责与页面调用的后端接口见 [views.md](./views.md)；路由守卫在 [`src/router/index.js`](../../../student-frontend/src/router/index.js) 中：`beforeEach` 本地校验 JWT `exp`（解码失败视为未过期，由后端 401 兜底），无 token 统一跳 `/login`，首次导航后台请求 `/api/me`，进首页调用 `ensureDashboardData()`，`prefetchRoutes()` 空闲时逐条预热懒加载 chunk。

### 5. 前端主题系统

预设 3 套 + 自定义（[`src/stores/theme.js`](../../../student-frontend/src/stores/theme.js) 的 `PRESETS`（预设主题列表））：

| id | 名称 | 变量文件 | 特征 |
| --- | --- | --- | --- |
| `base` | 彩色色块主题 | [`styles/theme-base.css`](../../../student-frontend/src/styles/theme-base.css) + [`styles/theme-base-accent.css`](../../../student-frontend/src/styles/theme-base-accent.css) | 无毛玻璃、纸白底、深蓝主色、工具栏琥珀暖色、深色侧边栏 |
| `glass` | 毛玻璃主题 | [`styles/theme-glass.css`](../../../student-frontend/src/styles/theme-glass.css) | 蓝灰底 + 薄白玻璃 + 荧光描边按钮 |
| `glass2` | 新毛玻璃主题 | [`styles/theme-glass2.css`](../../../student-frontend/src/styles/theme-glass2.css) | 薰衣草冷雾、柔光斑、厚高光玻璃、只在大面板做模糊 |
| 自定义 | 用户主题 | 运行时写入 CSS 变量 | store 有增删改函数，但当前界面没有创建入口；仅当 localStorage 已有数据时才会出现在主题列表 |

`applyTheme()`（应用主题函数）写 `data-theme`（主题标识）、`data-mode`（日/夜模式标识）、`data-topbar-color`（顶栏配色标识）、`no-animations`（关闭动画类）、CSS 变量与背景图，并通过 `theme-chrome`（主题窗口外观）IPC（进程间通信）通知主进程调整窗口外观。三套主题的设计取舍、夜间配色、动效与排版规则见 [界面设计与交互专题](../topics/design-and-interaction.md)。

### 6. 前端关键机制

- **安全通道**：[`secureChannel.js`](../../../student-frontend/src/composables/secureChannel.js) + [`secureAxios.js`](../../../student-frontend/src/composables/secureAxios.js)，ECDH P-256 + HKDF + AES-256-GCM，由 `VITE_SECURE` / `window.__SECURE_CHANNEL__` 控制。
- **后端就绪**：[`utils/backendReady.js`](../../../student-frontend/src/utils/backendReady.js) 订阅 `backend-ready`，兜底查询 `backend-status`。
- **懒加载与预取**：弹窗异步组件 + `v-preload`（悬停 80ms）+ 路由 chunk 预取 + `KeepAlive(max 16)`。
- **表格体系**：`DynamicTable`（动态列 CRUD）与 `GridView`（座位/课表/值日），逻辑分别在 [`useTableCRUD.js`](../../../student-frontend/src/composables/useTableCRUD.js)、[`useSeatGrid.js`](../../../student-frontend/src/composables/useSeatGrid.js)。
- **撤销/重做**：[`useUndo.js`](../../../student-frontend/src/composables/useUndo.js) 持久化到 `/api/undo`，快捷键 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`。
- **Vapor 双通道**：同一份源码可被 3.5 / 3.6 编译，见 [build-and-branches.md](../topics/build-and-branches.md)。

---
## 二、前端文件索引

### 1. 前端目录树

```
student-frontend/
├─ index.html / setup.html / migration.html / widget.html / desktop-widget.html
├─ vite.config.js / vite.perf.config.js / dev-vite.js / resize-bg.mjs
├─ public/           字体、Logo、背景图、收款码
└─ src/
   ├─ main.js / App.vue / electronChannels.js
   ├─ api/           接口封装
   ├─ config/        前端常量
   ├─ subwindows/    setup / migration / widget / desktop-widget
   ├─ views/         15 个页面（SettingsView、ScheduleView 为目录）
   ├─ components/    76 个组件（layout/base/tables/dialogs/import-export/ai/album/data-manage + 根级）
   ├─ composables/   26 个组合式函数（根目录 19 + ai/ 7）
   ├─ stores/        theme.js
   ├─ router/        index.js
   ├─ styles/        11 个 CSS（主题、工具类、弹窗过渡、滚动条等）
   ├─ utils/         26 个工具
   └─ wasm/          字体子集等 wasm 资源
```

逐目录说明见 [views.md](./views.md)、[components/README.md](./components/README.md)、[composables.md](./composables.md)、[misc.md](./misc.md)。

### 2. 子文档与入口速查

| 文档 | 主要内容 |
| --- | --- |
| [entry.md](./entry.md) | 入口与构建：5 个 HTML 入口、入口脚本关键动作、Vite 配置 |
| [views.md](./views.md) | 15 个页面：路由、Tab、状态与数据流、调用接口 |
| [components/README.md](./components/README.md) | 76 个组件索引、通用接口标准、全局注册 |
| [composables.md](./composables.md) | 26 个组合式函数：签名、返回字段、时序与副作用 |
| [misc.md](./misc.md) | stores / router / styles / utils / 指令 / 独立窗口 / 静态资源 |
| [widgets.md](../widgets.md) | 工具箱浮窗 + 桌面小组件（前端入口与主进程实现） |

---
## 三、前端标准

- **路由与页面**：页面路由懒加载，主视图用 `<KeepAlive :max="16">`（最多保活 16 个页面缓存）；无 `token`（登录令牌）统一跳 `/login`，`401`（未授权）去重后跳登录；首次导航请求 `/api/me`（当前账号信息接口），空闲时预取路由 `chunk`（代码分包）。
- **请求**：统一 `axios`（HTTP 请求库）（`baseURL`（接口基址）+ `Bearer`（请求头认证方式）`token`），安全通道由 `setupSecureAxios`（安全通道装配函数）装配；网络错误配合 `waitForBackendReady`（等待后端就绪）重试，写请求不自动重发。
- **主题**：颜色、圆角与背景走 CSS 变量及 `data-theme`（主题标识）/ `data-mode`（明暗模式）/ `data-topbar-color`（顶栏配色），不在组件写死；细则见 [界面设计与交互](../topics/design-and-interaction.md)。
- **组件**：图标统一走 `IconGlyph`（统一图标组件）；弹窗异步加载，配合 `v-preload`（悬停预取指令）预取；Props / Emits 规范见 [components/README.md](./components/README.md)。
- **状态与撤销**：跨页状态放 `stores/`（状态目录）；写操作登记 `/api/undo`（撤销记录接口），快捷键 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`（撤销 / 重做），实现见 [`useUndo.js`](../../../student-frontend/src/composables/useUndo.js)（撤销组合式函数）与 [composables.md](./composables.md)。

---
