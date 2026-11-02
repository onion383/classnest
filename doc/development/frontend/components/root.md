# 根级组件与布局（`components/*.vue` + `layout/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
├── student-frontend/
│   └── src/
│       ├── components/
│       │   ├── layout/
│       │   │   └── Sidebar.vue  # 侧边栏导航
│       │   ├── AiChart.vue  # AI 图表
│       │   ├── AnimatedClock.vue  # 动画时钟
│       │   ├── CadreManage.vue  # 班干部管理
│       │   ├── CadreTreeList.vue  # 职务树列表
│       │   └── ClippedText.vue  # 截断文本
│       ├── subwindows/
│       │   └── desktop-widget/
│       │       └── DesktopWidget.vue
│       └── utils/
│           └── routePrefetch.js
└── testjs/
    └── units/
        └── frontend.test.js
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

---

## 综合概述

- **定位**：`components/` 根目录的跨页组件：`Sidebar`（侧边栏）、`AnimatedClock`（动画时钟）、`CadreManage`（班干部管理）、`CadreTreeList`（职务树列表）、`ClippedText`（截断文本）与 `AiChart`（AI 图表）。
- **公共逻辑**：多数组件由页面直接引入、无全局状态；`Sidebar` 读路由与主题 store（主题状态仓库），`CadreManage` 内嵌在 `ClassroomView`（学生页）的班干部 Tab 内。
- **局限**：不展开班干部接口（见 [backend/routes.md](../../backend/routes.md)）与图表命中算法（见 [misc.md](../misc.md) 的 `utils/chartHit.js`）。

---

## 详细说明

### [layout/Sidebar.vue](../../../../student-frontend/src/components/layout/Sidebar.vue) · 侧边栏导航
- **定位**：主窗口左侧导航，按 `navGroups`（分组清单：概览 / 基础信息 / 核心管理 / 活动中心 / 系统管理）渲染 `router-link`（路由链接组件）。
- **对外接口**：无 `props`（组件属性）/ `emits`（组件事件）；读取 `router`（路由实例）、`route`（当前路由）与主题 `store`（状态仓库）的 `iconStyle`（图标样式）。
- **内部实现**：`pointerdown`（指针按下）记录 `pendingPath`（待落地路径）做乐观高亮（保证同时只亮一个）；`watch(route.path)`（侦听路由变化）后交回真实路由；`pointerover`（指针移入）调用 [`utils/routePrefetch.js`](../../../../student-frontend/src/utils/routePrefetch.js) 的 `prefetchRoute`（预取路由）预取 `chunk`（代码分包）；图标由 `IconGlyph`（图标组件）按主题切换。
- **使用方**：`App.vue`。
- 注意：`router-link` 的 `active-class` 要等异步路由 resolve 才生效，去掉乐观高亮会出现「点了没反应」。

### [AnimatedClock.vue](../../../../student-frontend/src/components/AnimatedClock.vue) · 动画时钟
- **定位**：首页与桌面小组件的时钟，仅对变化的字符做动画。
- **对外接口**：`props: timeFormat('{H}:{M}:{S}') / dateFormat('星期{W} {Y}-{M}-{D}')`。
- **内部实现**：按模板占位符切片渲染，字符变化时触发过渡；每秒对齐整秒重排。
- **使用方**：`DashboardView`、[`DesktopWidget.vue`](../../../../student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue)。

### [CadreManage.vue](../../../../student-frontend/src/components/CadreManage.vue) · 班干部管理
- **定位**：学生页「班干部管理」Tab 的子页面，树状视图 / 组织图视图切换。
- **对外接口**：无 props（由 `ClassroomView` 内嵌）；`emits` 无，内部直接调 `/api/cadres`。
- **内部实现**：职务增删改、成员增删、拖拽排序；视图切换后复用同一棵数据树。
- **使用方**：`ClassroomView`（懒加载）。

### [CadreTreeList.vue](../../../../student-frontend/src/components/CadreTreeList.vue) · 职务树列表
- **对外接口**：`props: node(必填) / allStudents / level / selectedId`；`emits: add-child / edit / remove / remove-member / drop-move / select / add-student`。
- **内部实现**：递归渲染子职务、折叠展开、拖拽排序、行内添加学生与候选下拉。
- **使用方**：`CadreManage`（并递归自引用）。

### [ClippedText.vue](../../../../student-frontend/src/components/ClippedText.vue) · 截断文本
- **对外接口**：`props: text / max(28) / title('完整内容')`。
- **内部实现**：右到左省略（保留尾部更有辨识度）；超长时 title 提示完整内容。
- **使用方**：`DashboardView`。

### [AiChart.vue](../../../../student-frontend/src/components/AiChart.vue) · AI 图表
- **定位**：把 AI 返回的图表规格（`bar` / `barh` / `pie` / `line`）画成 SVG，并带悬停提示。
- **对外接口**：`props: data(必填)`（`{type, labels, values, ...}`）；无 emits。
- **内部实现**：类型白名单回退 `bar`；数值非法归 0；`chartHit` 计算命中扇区/柱；提示框定位不走响应式（避免每帧重排）；配色读主题变量。
- **使用方**：`AiChatMessages`（图表工具结果）。
- 注意：解析与命中算法有单测（[`testjs/units/frontend.test.js`](../../../../testjs/units/frontend.test.js)），改算法先跑单测。

---

## 注意事项

- **`Sidebar`（侧边栏组件）与路由 / 主题耦合**：新增页面要同时补路由表、侧边栏入口与本页说明；`active-class`（选中态类名）依赖异步路由 `resolve`（解析完成），别去掉乐观高亮。
- **`CadreManage`（班干部管理组件）数据模型独立**：走 `/api/cadres`（班干部接口），不是学生表；改学生表不会同步班干部数据。

---
