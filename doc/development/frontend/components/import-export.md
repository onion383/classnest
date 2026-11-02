# 导入导出组件（`components/import-export/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── student-frontend/
    └── src/
        ├── components/
        │   └── import-export/
        │       ├── ExportExcel/
        │       │   └── ExportExcel.vue  # 导出面板
        │       ├── ExportAlbumIndex.builder.js  # 纯函数，可单测
        │       ├── ExportAlbumIndex.vue  # 相册索引导出
        │       ├── ImportExcel.vue  # Excel 导入
        │       └── VideoThumb.vue  # 视频缩略图
        ├── composables/
        │   └── exportFormats.js
        └── utils/
            └── pdfFont.js
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口约定」；本节只补充组件特有接口。

4 个文件；导出能力统一收口在 `ExportExcel`（导出面板组件）与其 `ExportExcel.exporters.js`（格式实现），格式实现见 [`src/composables/exportFormats.js`](../../../../student-frontend/src/composables/exportFormats.js)。

## 综合概述

- **定位**：导入导出组件（`components/import-export/`）：导出面板、相册索引导出、Excel 导入与视频缩略图。
- **公共逻辑**：导出能力统一收口在 `ExportExcel`（面板）与其 `ExportExcel.exporters.js`，格式实现集中在 `composables/exportFormats.js`；文件名校验与保存走主进程 `save-file`。
- **局限**：不展开各格式的实现细节（见 [composables.md](../composables.md) 与 `exportFormats.js`），也不展开后端导入与缩略图接口。

## 详细说明

### [ExportExcel/ExportExcel.vue](../../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.vue) · 导出面板
- **定位**：全应用的导出入口，支持导出选中行或全部；格式由 `FORMAT_OPTIONS`（格式选项表）决定：**`HTML`（网页）/ `Excel(xlsx)`（工作簿）/ `CSV`（逗号分隔文本）/ `Markdown`（轻量标记文本）/ 纯文本 / `JSON`（结构化文本）/ 图片(`PNG`）/ `PDF`（便携文档）**。
- **对外接口**：
  - `props`（组件属性）：`rows`（行数据，必填）/ `fields`（字段，必填）/ `selectedRowKeys`（选中行键）/ `defaultFilename`（默认文件名）/ `tableElement`（表格元素）/ `groupSource`（分组来源）/ `isVisible`（是否可见）/ `title`（标题）/ `excludeFormats`（排除格式）/ `hideFieldPicker`（隐藏字段选择）/ `disableExport`（禁用导出）
  - `emits`（组件事件）：`export-start`（开始导出）/ `export-finish`（导出完成）/ `export-error`（导出失败）/ `update:isVisible`（显隐更新）
  - `slots`（插槽）：`extraOptions`（在导出选项区插入自定义控件）
- **内部实现**：`pickFields`（选择列）→ `packRows`（选择行）→ `runExport`（按格式分派）；`PDF` 走 `html2canvas`（网页转图片库）+ `jsPDF`（PDF 生成库），中文字体动态子集见 [`utils/pdfFont.js`](../../../../student-frontend/src/utils/pdfFont.js)；文件名校验与保存对话框走主进程 `save-file`（保存文件通道）。
- **使用方**：`ClassroomView`、`FeeManagement`、`LeaveManagement`、`ScoreManagement`、`ScheduleView`、`SeatView`、`DutyView`、`ActivitiesView`、`GroupManageView`、`ExportAlbumIndex`。
- 注意：长表 `HTML`/`PDF` 会让 `html2canvas`（网页转图片库）崩溃，相册索引导出因此屏蔽图片格式；新增格式只需改 `exportFormats.js`（格式实现表）。

### [ExportAlbumIndex.vue](../../../../student-frontend/src/components/import-export/ExportAlbumIndex.vue) · 相册索引导出
- **定位**：把相册照片索引导出为表格（序号 / 文件名 / 目录）。
- **对外接口**：`props: isVisible(false) / albums([])`；`emits: update:isVisible`。
- **内部实现**：包一层 `ExportExcel`；补「选择相册 / 分组（天·月·年·文件顺序）/ 顺序（正序·倒序）」；按分组插入子表标题行；行构建在 [`ExportAlbumIndex.builder.js`](../../../../student-frontend/src/components/import-export/ExportAlbumIndex.builder.js)（纯函数，可单测）。
- **使用方**：`AlbumView`。
- 注意：`excludeFormats` 屏蔽图片类格式（长表渲染崩）。

### [ImportExcel.vue](../../../../student-frontend/src/components/import-export/ImportExcel.vue) · Excel 导入
- **定位**：把 Excel/CSV 解析成行，做字段映射与必填校验，用 `DynamicTable` 预览后提交。
- **对外接口**：`props: visible / existingFields([]) / requiredFields(['收支编码'])`；`emits: import-data / cancel`。
- **内部实现**：`xlsx` 解析首个 Sheet → 表头映射到现有字段（可忽略列）→ 必填校验 → `import-data` 交给宿主（`useTableCRUD` 的 `/import`）。
- **使用方**：`ClassroomView`、`FeeManagement`。

### [VideoThumb.vue](../../../../student-frontend/src/components/import-export/VideoThumb.vue) · 视频缩略图
- **对外接口**：`props: src(必填)`。
- **内部实现**：`<video preload="metadata">` 取首帧；失败/超时显示占位图标。
- **使用方**：`AlbumView`（视频格子）。

## 注意事项

- **新增格式只改一处**：格式实现集中在 `composables/exportFormats.js`，不要在页面里另写导出逻辑。
- **长表别开放图片格式**：长表 `HTML` / `PDF` 会让 `html2canvas` 崩溃，相册索引导出因此屏蔽图片格式。
- **导入两边都校验**：前端先解析预览，后端仍会 `sanitize`（见 [backend/services.md](../../backend/services.md)），不要因为前端校验过就跳过服务端校验。
