# 前端页面（`src/views/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── student-frontend/
    └── src/
        ├── components/
        │   ├── base/
        │   │   └── LeaveTimeline.vue
        │   ├── tables/
        │   │   └── DynamicTable/
        │   │       └── DynamicTable.vue  # 动态列表格
        │   └── CadreManage.vue
        ├── composables/
        │   ├── useDashboardData.js
        │   ├── usePhotoTimeline.js
        │   ├── useSeatGrid.js  # 座位模式
        │   ├── useTableCRUD.js  # 表格增删改查组合式函数
        │   └── useThumbBatch.js
        ├── router/
        │   └── index.js
        └── views/
            ├── ScheduleView/
            │   ├── ScheduleView.active.js
            │   ├── ScheduleView.common.js
            │   ├── ScheduleView.history.js
            │   ├── ScheduleView.master.js
            │   └── ScheduleView.vue  # /schedule
            ├── SettingsView/
            │   ├── SettingsView.appearance.js
            │   ├── SettingsView.data.js
            │   ├── SettingsView.search.js
            │   └── SettingsView.vue  # /settings
            ├── AboutView.vue  # /about
            ├── ActivitiesView.vue  # /activities
            ├── AiAssistant.vue  # /ai-assistant
            ├── AlbumView.vue  # /album
            ├── ClassroomView.vue  # /students
            ├── DashboardView.vue  # /
            ├── DutyView.vue  # /duty
            ├── FeeManagement.vue  # /fee
            ├── GroupManageView.vue  # /group-manage
            ├── LeaveManagement.vue  # /leaves
            ├── Login.vue  # /login
            ├── ScoreManagement.vue  # /scores
            └── SeatView.vue  # /seats
```
<!-- doc-tree:end -->

15 个页面。路由定义见 [`src/router/index.js`](../../../student-frontend/src/router/index.js)，页面与路由的对应关系见下方「页面总表」。接口列为页面直接调用的后端接口（动态拼接的参数未逐条穷举）。

## 综合概述

- **定位**：前端页面层（`src/views/`），把组合式函数、组件与后端接口组装成可交互的页面；15 个页面与路由基本一对一。
- **公共逻辑**：两张动态表格页共用 `useTableCRUD` + `DynamicTable`；看板 / 座位 / 相册分别复用 `useDashboardData` / `useSeatGrid` / `usePhotoTimeline`；写操作统一登记 `/api/undo`；路由与预取集中在 `router/index.js` 与 `prefetchRoutes()`。
- **局限**：不展开组件内部实现与组合式函数签名（见 [components/README.md](./components/README.md)、[composables.md](./composables.md)），也不展开后端接口契约（见 [backend/routes.md](../backend/routes.md)）。

## 详细说明

### 页面总表

| 页面 | 路由 | 职责 | 主要接口（`GET` 查询 / `POST` 新增 / `PUT` 更新 / `DELETE` 删除） |
| --- | --- | --- | --- |
| [`DashboardView.vue`](../../../student-frontend/src/views/DashboardView.vue) | `/` | 概览首页：班级信息大框 + 卡片瀑布流 | `GET/PUT /api/widget-settings/class-info`、`GET /api/album/{id}/photos`、`/photo/{id}/thumb` |
| [`ClassroomView.vue`](../../../student-frontend/src/views/ClassroomView.vue) | `/students` | 学生信息 / 班干部管理（`Tabs`，标签页） | `GET/POST/PUT/DELETE /api/students`（动态表 `factory`（工厂））、`/api/cadres` |
| [`FeeManagement.vue`](../../../student-frontend/src/views/FeeManagement.vue) | `/fee` | 班费记录 + 收据上传 | `/api/fee-records`、`POST /api/fee-records/upload-receipt` |
| [`Login.vue`](../../../student-frontend/src/views/Login.vue) | `/login` | 登录 / 注册 / 恢复密钥 / 离线恢复 / 找回密码 | `/api/db-login`、`/api/login`、`/api/register`、`/api/account/restore-offline`、`/api/recover-password` |
| [`SettingsView/`](../../../student-frontend/src/views/SettingsView/SettingsView.vue) | `/settings` | 账号 / 撤销记录 / 外观 / 工具箱 / 桌面组件 / 路径 / 数据 / 性能 / 数据库 | `/api/undo`、`/api/account/*`、`/api/widget-settings` |
| [`ScheduleView/`](../../../student-frontend/src/views/ScheduleView/ScheduleView.vue) | `/schedule` | 实行课表 / 一般课表、周历史 | `/api/schedule`、`/master`、`/settings`、`/history`、`/snapshot`、`/apply-master` |
| [`SeatView.vue`](../../../student-frontend/src/views/SeatView.vue) | `/seats` | 座位编排、模板、历史、回填 | `/api/seats`、`/master/cell`、`/history`、`/snapshot`、`/apply-master` |
| [`LeaveManagement.vue`](../../../student-frontend/src/views/LeaveManagement.vue) | `/leaves` | 请假列表 + 时间轴 + 销假 | `/api/leaves`、`/api/students` |
| [`AlbumView.vue`](../../../student-frontend/src/views/AlbumView.vue) | `/album` | 时间轴 / 相册双视图、多选移动、任务管理、导出索引 | `/api/album/*`（相册、照片、任务、缩略图、移动） |
| [`GroupManageView.vue`](../../../student-frontend/src/views/GroupManageView.vue) | `/group-manage` | 维度/小组/成员、智能分组 | `/api/group-manage/*`、`/api/students`、`/api/undo` |
| [`ScoreManagement.vue`](../../../student-frontend/src/views/ScoreManagement.vue) | `/scores` | 个人/小组加减分 + 时间轴 | `/api/scores`、`/api/group-manage/bootstrap` |
| [`DutyView.vue`](../../../student-frontend/src/views/DutyView.vue) | `/duty` | 值日（daily / big）、模板、历史、回填 | `/api/duty`、`/settings`、`/template`、`/history`、`/snapshot`、`/apply-master` |
| [`ActivitiesView.vue`](../../../student-frontend/src/views/ActivitiesView.vue) | `/activities` | 活动 / 倒计时 | `/api/activities`、`/api/countdowns` |
| [`AiAssistant.vue`](../../../student-frontend/src/views/AiAssistant.vue) | `/ai-assistant` | AI 对话、流式、提案确认、设置 | `/api/ai/*`（详见 [topics/ai.md](../topics/ai.md)） |
| [`AboutView.vue`](../../../student-frontend/src/views/AboutView.vue) | `/about` | 关于软件 | 无（静态） |

### 页面细节

### DashboardView
- 数据：由 [`useDashboardData.js`](../../../student-frontend/src/composables/useDashboardData.js) 的 `ensureDashboardData()`（确保首页数据）并行拉取 9 个接口（schedule / duty / countdowns / leaves / students / scores / activities / fee-records / album），模块级缓存 + `pending`（进行中请求）去重。
- 交互：班级信息大框可编辑，写回 `PUT /api/widget-settings/class-info`；倒计时卡片取 `countdowns`；相册卡片取相册首图缩略图。
- 注意：首屏不等待懒加载路由 `chunk`（代码分包），数据由路由守卫提前预热。

### ClassroomView
- 结构：`Tabs`（标签页）切「学生信息 / 班干部管理」；学生表 = [`useTableCRUD`](../../../student-frontend/src/composables/useTableCRUD.js)（表格增删改查组合式函数）+ [`DynamicTable`](../../../student-frontend/src/components/tables/DynamicTable/DynamicTable.vue)（动态列表格），动态弹窗（新增、导入、去重、导出）用 `v-preload`（悬停预取指令）预取。
- **接口**：`/api/students` 由后端 [`routes/dynamicTable.js`](../backend/routes.md) 的 `factory`（工厂函数）生成（含 `/add-column`、`/rename-column`、`/move-row`、`/reorder`、`/import`、`/columns/{name}`）。
- 班干部 Tab 内嵌 [`CadreManage.vue`](../../../student-frontend/src/components/CadreManage.vue)，走 `/api/cadres`。

### FeeManagement
- 结构：同 `useTableCRUD` + `DynamicTable` + `SearchBar`；收据上传后以 `resourceUrl` 鉴权显示。
- **接口**：`/api/fee-records`（同一动态表工厂，`minCount` 等参数不同）+ `POST /upload-receipt`（单图 10MB、扩展名 + MIME + 魔数三重校验）。

### Login
- 覆盖安装后首次进入、常规登录、离线恢复、找回密码；唯一不显示侧边栏的全屏页面。
- 注册流程：有密码账号先出草稿，抄写恢复密钥前 3 词确认后才建库（见 [backend/README.md](../backend/README.md) 鉴权小节）。

### SettingsView（目录）
- 组成：[`SettingsView.vue`](../../../student-frontend/src/views/SettingsView/SettingsView.vue) + [`SettingsView.appearance.js`](../../../student-frontend/src/views/SettingsView/SettingsView.appearance.js) / [`SettingsView.data.js`](../../../student-frontend/src/views/SettingsView/SettingsView.data.js) / [`SettingsView.search.js`](../../../student-frontend/src/views/SettingsView/SettingsView.search.js)。
- 职责：账号信息、撤销记录、主题（`ThemePickerDialog`）、工具箱与桌面组件开关、保存路径、数据目录、性能面板、数据库加密/导出、数据管理弹窗。

### ScheduleView（目录）
- 组成：[`ScheduleView.vue`](../../../student-frontend/src/views/ScheduleView/ScheduleView.vue) + [`ScheduleView.common.js`](../../../student-frontend/src/views/ScheduleView/ScheduleView.common.js) / [`ScheduleView.master.js`](../../../student-frontend/src/views/ScheduleView/ScheduleView.master.js) / [`ScheduleView.active.js`](../../../student-frontend/src/views/ScheduleView/ScheduleView.active.js) / [`ScheduleView.history.js`](../../../student-frontend/src/views/ScheduleView/ScheduleView.history.js)。
- 职责：实行课表（本周）、一般课表（模板）、学期设置、周快照与回填。

### SeatView
- 数据：[`useSeatGrid.js`](../../../student-frontend/src/composables/useSeatGrid.js)（座位模式）+ 模板接口；`GridView` 渲染。
- 弹窗：`SeatSettingsDialog`、`SeatRecordSettingsDialog`、`SeatBackfillDialog`、`WeightAlgorithmDialog`、`SmartArrangementDialog`。

### LeaveManagement
- 列表 + [`LeaveTimeline`](../../../student-frontend/src/components/base/LeaveTimeline.vue)；新增/编辑走 `AddLeaveDialog`，销假/撤销销假走 `POST /:id/return|unreturn`；逾期未销假弹 `OverdueLeaveDialog`。

### AlbumView
- 双视图：时间轴（按日期分组的虚拟滚动网格，[`usePhotoTimeline`](../../../student-frontend/src/composables/usePhotoTimeline.js) + [`useThumbBatch`](../../../student-frontend/src/composables/useThumbBatch.js)）与相册卡片。
- 时间轴长按 400ms 进多选，工具栏「移动到相册（N）」开 `MoveAlbumDialog`；年份尺 `AlbumYearRuler`；导出索引 `ExportAlbumIndex`。
- 注意：8 列/4 列判定与 FLIP 动画规则见 [优化计划.md](../../开发文档/优化计划.md)（不入库）。

### GroupManageView
- 维度 Tab + 小组/成员 CRUD；智能分组 `SmartGroupDialog`；写回走 `POST /dimensions/:dimId/apply-grouping`，撤销走 `/api/undo`。

### ScoreManagement
- 个人/小组两种目标（`AddScoreDialog` 的 `mode`）；`DynamicTable` 展示记录，`LeaveTimeline` 复用做时间轴。

### DutyView
- 两种模式 `daily` / `big`；编排 `DutyArrangementDialog`（草稿、权重）、`DutySettingsDialog`、`DutyRecordSettingsDialog`、`DutyBackfillDialog`。
- **接口**：`/api/duty`、`/settings`、`/template`、`/history`、`/snapshot`、`/apply-master`（周快照四组路由由 [`routes/historyRoutes.js`](../backend/services.md) 工厂生成）。

### ActivitiesView
- `Tabs` 切「日常活动 / 倒计时」；时间轴复用 `LeaveTimeline`；导出走 `ExportExcel`。

### AiAssistant
- 对话列表 + 消息流 + 输入器 + 提案确认；SSE 用 `fetch` 流式读取；打开面板见 [components/ai.md](./components/ai.md)，全链路见 [topics/ai.md](../topics/ai.md)。

### AboutView
- 版本、图标、许可与赞助信息；无后端请求。

### 两类表格的共同标准

- **表头先行**：页面挂载即渲染表头（`DynamicTable` 的 `fields` / `GridView` 的 `colHeaders` 有前端默认值），行数据就绪后填入。
- **高度与滚动**：都有 `minTableHeight`（空表不塌陷）与 `maxHeight`（默认 400 / 560px），超出后容器内滚动 + 表头吸顶；弹窗调用方传 `maxHeight=0` 关闭。
- **空态**：仅列表型表格用 `EmptySnapshot`；网格页与加载中不显示空态。
- **不做虚拟滚动**：`GridView` 的 rowspan 与拖拽依赖完整 DOM（结论见 [优化计划.md](../../开发文档/优化计划.md) D1.1）。

### 页面 ↔ 后端路由

基本一对一。非 1:1 的刻意设计：

| 页面 | 后端 | 原因 |
| --- | --- | --- |
| `ClassroomView`（学生）/ `FeeManagement` | [`routes/dynamicTable.js`](../backend/routes.md) + [`services/tableService.js`](../backend/services.md) | 两张表共用动态列 CRUD 工厂，按表名参数化 |
| `ClassroomView`（班干部 Tab） | [`routes/cadres.js`](../backend/routes.md) | 同页不同 Tab，数据模型独立 |
| `ActivitiesView` | `routes/activities.js` + `routes/countdowns.js` | 一页两个数据模型 |
| `DashboardView` | `routes/widget-settings.js` + 多个业务接口 | 看板跨模块只读聚合 |
| `SettingsView` | `routes/account.js` + `routes/widget-settings.js` + `routes/undo.js` | 设置页聚合三类 |
| `Login` | `routes/auth.js` + `routes/account.js`（`restore-offline`） | 登录页含离线恢复 |
| 所有编辑页 | `routes/undo.js` | 撤销是横切能力 |

## 注意事项

- **页面只做组装**：表格 / 网格的状态与写库、撤销快照放 `useTableCRUD` / `useSeatGrid`，页面里不要重复实现，否则撤销与搜索会各走一套。
- **写操作必须登记撤销**：编辑页的写接口要同步 `POST /api/undo`（设置页的「撤销记录」与 `Ctrl+Z` 都依赖它）；新增写接口时连 `settle` 一起补，见 [composables.md](./composables.md) 的 `useUndo`。
- **表格统一用现成组件**：表头先行、空态、高度与滚动按上文「两类表格的共同标准」交给 `DynamicTable` / `GridView`，页面不要各写一套。
- **页面文件必须被本页覆盖**：`docs-verify` 会检查 `src/views/` 下每个 `.vue` / `.js` 是否在本页出现，新增或改名页面要同步「页面总表」，否则校验失败。
- **懒加载与预取**：页面路由与弹窗都按 `chunk` 懒加载，靠 `prefetchRoutes()`（路由空闲预热）与 `v-preload`（悬停 80ms 加载弹窗）预热；不要在首屏静态 `import` 弹窗组件。
