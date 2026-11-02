# 前端入口与构建（`student-frontend/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    ├── src/
    │   ├── subwindows/
    │   │   ├── desktop-widget/
    │   │   │   ├── DesktopWidget.vue  # 桌面小组件
    │   │   │   └── main.js
    │   │   ├── migration/
    │   │   │   ├── main.js
    │   │   │   └── Migration.vue  # 数据库迁移
    │   │   ├── setup/
    │   │   │   ├── main.js
    │   │   │   └── Setup.vue  # 首次引导
    │   │   └── widget/
    │   │       ├── main.js
    │   │       └── WidgetApp.vue  # 工具箱浮窗
    │   ├── App.vue  # 主窗口
    │   └── main.js
    ├── resize-bg.mjs  # 背景图压缩
    ├── vite.config.js  # 5 个入口、nonBlockingCss 把 CSS 改为非阻塞、server.warmup…
    └── vite.perf.config.js  # 性能测量
```
<!-- doc-tree:end -->

5 个窗口入口、入口脚本与构建配置；目录树、整体机制见 [README.md](./README.md)。

---

## 5 个窗口入口

| HTML | 挂载点 | 入口 JS | 顶层组件 | 用途 |
| --- | --- | --- | --- | --- |
| `index.html` | `#app` | [`src/main.js`](../../../student-frontend/src/main.js) | [`src/App.vue`](../../../student-frontend/src/App.vue) | 主窗口 |
| `setup.html` | `#setup-app` | [`src/subwindows/setup/main.js`](../../../student-frontend/src/subwindows/setup/main.js) | [`Setup.vue`](../../../student-frontend/src/subwindows/setup/Setup.vue) | 首次引导 |
| `migration.html` | `#migration-app` | [`src/subwindows/migration/main.js`](../../../student-frontend/src/subwindows/migration/main.js) | [`Migration.vue`](../../../student-frontend/src/subwindows/migration/Migration.vue) | 数据库迁移 |
| `widget.html` | `#widget-app` | [`src/subwindows/widget/main.js`](../../../student-frontend/src/subwindows/widget/main.js) | [`WidgetApp.vue`](../../../student-frontend/src/subwindows/widget/WidgetApp.vue) | 工具箱浮窗 |
| `desktop-widget.html` | `#desktop-widget-app` | [`src/subwindows/desktop-widget/main.js`](../../../student-frontend/src/subwindows/desktop-widget/main.js) | [`DesktopWidget.vue`](../../../student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue) | 桌面小组件 |

[`src/main.js`](../../../student-frontend/src/main.js) 的关键动作：设置 `axios`（HTTP 客户端）`baseURL`（基础地址）、注入 `Bearer`（请求头认证方案）`token`（登录令牌）、`401`（未认证）去重并跳登录、网络错误配合 `waitForBackendReady`（等待后端就绪）重试（写请求不自动重发）、`setupSecureAxios`（装配安全通道）装配安全通道、Vue 初始化前写入主题变量防闪、全局注册 `IconGlyph`（图标组件）、注册 `v-preload`（悬停预取指令）、`splash`（启动占位页）保活至「后端就绪 + 路由就绪 + 样式就绪」、失败时提供「重启后端 / 退出」兜底。

[`src/App.vue`](../../../student-frontend/src/App.vue)：自绘标题栏（最小化/最大化/关闭）、登录页无侧边栏、`<KeepAlive :max="16">`（页面缓存，最多 16 个实例）、`NotificationToast`（通知吐司）、后端异常全屏遮罩、AI 悬浮入口、`ShutdownMenuDialog`（关闭选择弹窗）；`mounted`（挂载完成）里 `requestIdleCallback`（浏览器空闲回调）双重空闲后上报小组件就绪并预取路由。

---

## 构建配置

构建配置：[`vite.config.js`](../../../student-frontend/vite.config.js)（5 个入口、`nonBlockingCss` 把 CSS 改为非阻塞、`server.warmup` 预编译首屏、`/api` 与 `/uploads` 代理）、[`vite.perf.config.js`](../../../student-frontend/vite.perf.config.js)（性能测量）、[`resize-bg.mjs`](../../../student-frontend/resize-bg.mjs)（背景图压缩）。

---
