# 布局组件（`components/layout/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    └── src/
        ├── components/
        │   └── layout/
        │       └── Sidebar.vue  # 侧边栏导航
        └── utils/
            └── routePrefetch.js
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

---

## [Sidebar.vue](../../../../student-frontend/src/components/layout/Sidebar.vue) · 侧边栏导航
- **定位**：主窗口左侧导航，按 `navGroups`（分组清单：概览 / 基础信息 / 核心管理 / 活动中心 / 系统管理）渲染 `router-link`（路由链接组件）。
- **对外接口**：无 `props`（组件属性）/ `emits`（组件事件）；读取 `router`（路由实例）、`route`（当前路由）与主题 `store`（状态仓库）的 `iconStyle`（图标样式）。
- **内部实现**：`pointerdown`（指针按下）记录 `pendingPath`（待落地路径）做乐观高亮（保证同时只亮一个）；`watch(route.path)`（侦听路由变化）后交回真实路由；`pointerover`（指针移入）调 [`utils/routePrefetch.js`](../../../../student-frontend/src/utils/routePrefetch.js) 的 `prefetchRoute`（预取路由）预取 `chunk`（代码分包）；图标由 `IconGlyph`（图标组件）渲染。
- **依赖与调用方**：`App.vue` 挂载；依赖 `IconGlyph`、主题 store、路由预取工具。
- 注意：`router-link` 的 `active-class` 要等异步路由 resolve 后才生效，去掉乐观高亮会出现「点了没反应」的观感。

其余根级组件（`AnimatedClock`、`CadreManage`、`CadreTreeList`、`ClippedText`、`AiChart`）见 [root.md](./root.md)。

---
