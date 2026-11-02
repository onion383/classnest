# 表格与网格组件（`components/tables/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    └── src/
        ├── components/
        │   └── tables/
        │       ├── DynamicTable/
        │       │   ├── DynamicTable.filter.vue  # 列筛选下拉
        │       │   └── DynamicTable.vue  # 动态列 CRUD 表
        │       ├── GridView/
        │       │   └── GridView.vue  # 网格表
        │       ├── AiGridPreview.vue  # AI 排布预览
        │       ├── AiProposalTable.vue  # AI 提案明细表
        │       └── AiRecordTable.vue  # AI 记录预览表
        └── composables/
            └── useTableCRUD.js  # 表格增删改查组合式函数
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

6 个文件，分「动态列 `CRUD`（增删改查）表」「座位/课表/值日网格」「AI 表格预览」三组。全部是受控组件：状态由宿主或 `composable`（组合式函数）持有。

---

## 综合概述

- **定位**：表格与网格组件（`components/tables/`），覆盖动态列 CRUD 表、座位 / 课表 / 值日网格，以及 AI 表格预览。
- **公共逻辑**：全部是**受控组件**——状态与写库在宿主或 `useTableCRUD`（表格增删改查组合式函数）/ `useSeatGrid`（座位网格组合式函数），组件只负责渲染、表头吸顶、排序筛选、行列拖拽与多选。
- **局限**：不展开组合式函数的签名与撤销登记（见 [composables.md](../composables.md)），也不展开页面如何组装（见 [views.md](../views.md)）。

---

## 详细说明

### [DynamicTable/DynamicTable.vue](../../../../student-frontend/src/components/tables/DynamicTable/DynamicTable.vue) · 动态列 CRUD 表
- **定位**：学生表、班费表等「列可增删」的表格；是 [`useTableCRUD`](../../../../student-frontend/src/composables/useTableCRUD.js)（表格增删改查组合式函数）的纯展示层。
- 对外接口（关键）：
  - `props`（组件属性）：`fields`（字段，必填）/ `rows`（行数据，必填）/ `newRow`（新行）/ `sortField`（排序字段）/ `sortOrder`（排序方向）/ `editingCell`（正在编辑的单元格）/ `maxRows`（最大行数）/ `hideSelectAll`（隐藏全选）/ `hideMoveButtons`（隐藏移动按钮）/ `hideAddRow`（隐藏添加行）/ `minTableHeight`（最小高度）/ `maxHeight`（最大高度）
  - `emits`（组件事件）：`contextmenu`（右键菜单）/ `search`（搜索）/ `toggleSort`（切换排序）/ `saveNewRow`（保存新行）/ `cancelNewRow`（取消新行）/ `startEdit`（开始编辑）/ `saveCell`（保存单元格）/ `moveRow`（移动行）/ `deleteRow`（删除行）/ `addNewRowAtBottom`（底部新增行）/ `updateNewRow`（更新新行）/ `manageReceipt`（管理收据）/ `swapRows`（交换行）/ `swapColumns`（交换列）/ `moveSelectedRows`（移动选中行）/ `selectionChange`（选中变化）
  - `slots`（插槽）：`empty-actions`（空态按钮）
- **内部实现**：列头排序/搜索、双击编辑、行内新增行、多选、行列拖拽（交换/移动）、底部「点击添加一行」；列宽快照与增删行动画；内部另定义 `TransitionGroup`（多元素进出过渡组件）包装子组件。
- **使用方**：`ClassroomView`、`FeeManagement`、`LeaveManagement`、`ScoreManagement`、`ImportExcel`、`DeduplicateDialog`。
- 注意：所有接口调用都在 `useTableCRUD` 里，组件内不发请求；表头先于数据渲染（避免空表塌陷）。

### [DynamicTable/DynamicTable.filter.vue](../../../../student-frontend/src/components/tables/DynamicTable/DynamicTable.filter.vue) · 列筛选下拉
- **定位**：表头筛选的下拉内容（列选择 + 关键字过滤），由 `DynamicTable` 内部使用。
- **对外接口**：接收当前列与关键字，向上 emit 选择结果；与 `AppSelect`、`zhCollator` 配合做中文排序。
- 注意：属于内部拆分件，不单独对外复用。

### [GridView/GridView.vue](../../../../student-frontend/src/components/tables/GridView/GridView.vue) · 网格表
- **定位**：座位表、课程表、值日表的网格渲染（支持跨行合并与走廊列）。
- 对外接口（关键）：
  - `props: colHeaders(必填) / rows(必填) / showPeriodColumn / title / hideMetaColumns / showRowNumber / enableCandidate / candidateItems / candidateExcludeIds / candidateLabelField / minTableHeight / maxHeight / rowHeaderLabel`
  - `emits`（组件事件）：`update:cells`（单元格更新）/ `swapRows`（交换行）/ `swapColumns`（交换列）/ `update:row-meta`（行元信息更新）/ `cell-dblclick`（单元格双击）
- **内部实现**：单元格拖选/长按多选、双击编辑、候选下拉（`Teleport`（传送组件）+ `fixed`（固定定位），与座位表候选一致）、行列拖拽交换、行元信息编辑；`maxHeight`（最大高度）在弹窗调用方传 0 关闭。
- **使用方**：`SeatView`、`ScheduleView`、`DutyView`、`DutyArrangementDialog`、`SmartArrangementDialog`、`AiGridPreview`。
- 注意：**不要加 `virtual scroll`（虚拟滚动）**（`rowspan`（跨行合并）切片会错位，且拖拽依赖完整 `DOM`（页面元素树））；空态一律不做。

### [AiGridPreview.vue](../../../../student-frontend/src/components/tables/AiGridPreview.vue) · AI 排布预览
- **定位**：把 AI 提案里的课表/座位/值日排布渲染成网格预览（只读）。
- **对外接口**：`props: table(必填, 表名) / override(提案数据, 默认 null)`。
- **内部实现**：按表名取 `GridView` 所需的列头与行，叠加 `override` 后只读展示；弹窗内使用 `maxHeight=0`。
- **使用方**：`AiAssistant` / AI 提案确认流程。

### [AiProposalTable.vue](../../../../student-frontend/src/components/tables/AiProposalTable.vue) · AI 提案明细表
- **定位**：展示 `propose_write` 提案的逐项改动（字段/to 新值、批量时「旧值 → 新值」），含技能 md 的行级 diff。
- **对外接口**：`props: proposal(必填)`；无 emits（只读展示）。
- **内部实现**：按表分组渲染 `ops`；`lineDiff` 计算技能文件差异；布尔值显示为「开启/关闭」。
- **使用方**：AI 提案确认面板（`AiChangePanel`）。

### [AiRecordTable.vue](../../../../student-frontend/src/components/tables/AiRecordTable.vue) · AI 记录预览表
- **定位**：AI 查询结果（指定表 + 指定行 id）的只读表格预览。
- **对外接口**：`props: table(必填) / ids(必填)`；无 emits。
- **内部实现**：拉取记录并补 `_rowKey`；列按后端字段元数据渲染。
- **使用方**：AI 消息里的「查看记录」气泡。

---

## 注意事项

- **受控到底**：`DynamicTable`（动态列表格）内不发请求、不写库；新增写操作仍放 `useTableCRUD`（表格组合式函数），否则撤销与搜索会各走一套。
- **三张 AI 表只读**：`AiGridPreview`（AI 排布预览表）/ `AiProposalTable`（AI 提案明细表）/ `AiRecordTable`（AI 记录预览表）只做预览，不要改造成可编辑表。
- **网格不要虚拟滚动**：`rowspan`（跨行合并）切片会错位，拖拽又依赖完整 `DOM`（页面元素树）；`GridView`（网格表）与 `AiGridPreview`（AI 排布预览表）都受影响。
- **字段标准要同步**：`fields`（字段列表，`DynamicTable`（动态列表格）用）与 `colHeaders`（列头列表，`GridView`（网格表）用）必须与 `useTableCRUD`（表格组合式函数）/ 后端动态列接口一致，否则表头与数据错位。

---
