# 导入导出组件（`components/import-export/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
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

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

4 个文件；导出能力统一收口在 `ExportExcel`（导出面板组件）与其 `ExportExcel.exporters.js`（格式实现），格式实现见 [`src/composables/exportFormats.js`](../../../../student-frontend/src/composables/exportFormats.js)。

---

## 综合概述

- **定位**：导入导出组件（`components/import-export/`）：`ExportExcel`（导出面板）、`ExportAlbumIndex`（相册索引导出）、`ImportExcel`（Excel 导入）与 `VideoThumb`（视频缩略图）。
- **公共逻辑**：导出能力统一收口在 `ExportExcel`（导出面板）与其 `ExportExcel.exporters.js`（各格式实现文件），格式实现集中在 `composables/exportFormats.js`（导出格式注册表）；文件名校验与保存走主进程 `save-file`（保存文件对话框通道）。
- **局限**：不展开各格式的实现细节（见 [composables.md](../composables.md) 与 `exportFormats.js`），也不展开后端导入与缩略图接口。

---

## 详细说明

### [ExportExcel/ExportExcel.vue](../../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.vue) · 导出面板
- **定位**：全应用的导出入口，支持导出选中行或全部；格式由 `FORMAT_OPTIONS`（格式选项表）决定：**`HTML`（网页）/ `Excel(xlsx)`（工作簿）/ `CSV`（逗号分隔文本）/ `Markdown`（轻量标记文本）/ 纯文本 / `JSON`（结构化文本）/ 图片(`PNG`）/ `PDF`（便携文档）**。
- **对外接口**：
  - `props`（组件属性）：`rows`（行数据，必填）/ `fields`（字段，必填）/ `selectedRowKeys`（选中行键）/ `defaultFilename`（默认文件名）/ `tableElement`（表格元素）/ `groupSource`（分组来源）/ `isVisible`（是否可见）/ `title`（标题）/ `excludeFormats`（排除格式）/ `hideFieldPicker`（隐藏字段选择）/ `disableExport`（禁用导出）
  - `emits`（组件事件）：`export-start`（开始导出）/ `export-finish`（导出完成）/ `export-error`（导出失败）/ `update:isVisible`（显隐更新）
  - `slots`（插槽）：`extraOptions`（在导出选项区插入自定义控件）
- **内部实现**：`pickFields`（选择列）→ `packRows`（选择行）→ `runExport`（按格式分派）；`PDF` 走 `html2canvas`（网页转图片库）+ `jsPDF`（PDF 生成库），中文字体动态子集见 [`utils/pdfFont.js`](../../../../student-frontend/src/utils/pdfFont.js)；文件名校验与保存对话框走主进程 `save-file`（保存文件通道）。
- **导出进度**：`doExport` 开始后置 `exporting=true`，「导出」按钮置灰并显示 `导出中 N%`；各格式在耗时阶段通过 `ctx.reportProgress()` 上报（如 Excel 20/70/90、PDF 20/40/60/90），结束时统一复位。
- **HTML 导出**：生成自包含的静态表格 —— 样式与页面 `DynamicTable` / `GridView` 对齐（表头、行号列、走廊、讲台、休息行），不内嵌脚本，打开即可查看/打印，行列顺序即导出时的顺序。
- **统一表头色**：模块顶层 `EXPORT_HEAD_*` 以 HTML 表头蓝 `#3b82f6` 为唯一口径，图片（含分组图）、PDF（`headStyles.fillColor`）、Excel / 分组 Excel（`fgColor`）全部取同一份；数据行仍白底黑字，便于打印。分组 PDF 是整表截图，只跳过 `thead` 的刷白，表头同样保留蓝色。
- **图片导出**：html2canvas 不解析 table-cell 的 `vertical-align`（按 Range 基线画字，文字会踩底线），截图前用 `onclone` 在克隆文档里把单元格改成等高 `line-height`、清掉毛玻璃主题给表格/表头加的圆角，并把表头刷成统一蓝；只改克隆，页面本身不受影响。离屏表格也内联同一份 `SCREENSHOT_CELL` 样式。
- **Excel 导出**：只保留细框线、加粗与居中；表头蓝底白字，标题、讲台行、走廊列仍是白底黑字。
- **纯文本导出**：`buildTxt(headers, bodyRows, title)` 首行写标题（文件名）+ 等宽下划线，再按「显示宽度」（中文/全角记 2 宽，其余 1 宽）算每列最宽值、右侧补空格对齐，表头下画一条等宽分隔线；单元格内 Tab/换行压成空格。普通导出与分组导出都传 `filename` 作标题。改成空格对齐后不再按 Tab 分列，导入其它系统请用 CSV。
- **使用方**：`ClassroomView`、`FeeManagement`、`LeaveManagement`、`ScoreManagement`、`ScheduleView`、`SeatView`、`DutyView`、`ActivitiesView`、`GroupManageView`、`ExportAlbumIndex`。
- 注意：长表 `HTML`/`PDF` 会让 `html2canvas`（网页转图片库）崩溃，相册索引导出因此屏蔽图片格式；新增格式只需改 `exportFormats.js`（格式实现表）。

### [ExportAlbumIndex.vue](../../../../student-frontend/src/components/import-export/ExportAlbumIndex.vue) · 相册索引导出
- **定位**：把相册照片索引导出为表格（序号 / 文件名 / 目录）。
- **对外接口**：`props: isVisible(false) / albums([])`；`emits: update:isVisible`。
- **内部实现**：包一层 `ExportExcel`；补「选择相册 / 分组（天·月·年·文件顺序）/ 顺序（正序·倒序）」；按分组插入子表标题行；行构建在 [`ExportAlbumIndex.builder.js`](../../../../student-frontend/src/components/import-export/ExportAlbumIndex.builder.js)（纯函数，可单测）。
- **使用方**：`AlbumView`。
- 注意：`excludeFormats` 屏蔽图片类格式（长表渲染崩）。

### [ImportExcel.vue](../../../../student-frontend/src/components/import-export/ImportExcel.vue) · Excel 导入
- **边界**：模板下载复用主进程 `save-file`（保存文件对话框），与其它导出共用 `utils/saveFile.js`；模板数据区只留空白行，不写示例值。
- **定位**：把 Excel/CSV 解析成行，做字段映射与必填校验，按表格形态用 `DynamicTable` 或 `GridView` 预览后提交。
- **对外接口**：`props: visible / existingFields([]) / requiredFields(['收支编码']) / templateColumns([]) / templateName('') / previewMode('table')`；`emits: import-data / cancel`。
  - `requiredFields` 的每一项既可以是字符串，也可以是同义写法数组（如 `[['项目', '劳动项目', '值日项目']]`），解析时按候选顺序模糊命中文件里的实际列名；认不到时弹窗直接提示「未识别到必填列」。
- **预览形态**：`previewMode='table'` 用 `DynamicTable`（行状表）；`previewMode='grid'` 用 `GridView`（课程表 / 座位 / 值日等矩阵表），第一列作为行标题，讲台行（`_isPodium`）与走廊列（`_isAisle`）按主表样式还原。
- **模板下载**：不传 `templateColumns` 时用 `existingFields` 的表头；`下载标准导入表` 旁的 `点击下载` 按钮用 `exceljs` **现场生成** `.xlsx`（第 1 行合并居中标题、第 2 行表头、20 行空白数据区、全部细框线），再弹系统保存框（按钮包在 `.opbar` 内，命中工具栏同款毛玻璃样式）。
- **内部实现**：CSV 先按 UTF-8/GBK 正确解码（Excel 另存的 GBK CSV 不再乱码）→ `xlsx` 逐 Sheet 解析（最多 5 个，取「数据行最多、缺必填列最少」的 Sheet）→ 表头识别优先命中已知字段 / 模板表头（同义写法、`d_` 前缀、星期变体）→ 列映射与必填校验 → `import-data` 交给宿主（`useTableCRUD` 的 `/import`）。
- **使用方**：`ClassroomView`、`FeeManagement`、`ScoreManagement`、`LeaveManagement`、`ActivitiesView`、`CadreManage`、`GroupManageView`、`ScheduleView`、`SeatView`、`DutyView`、`SettingsDialog`、`DutySettingsDialog`。

### [VideoThumb.vue](../../../../student-frontend/src/components/import-export/VideoThumb.vue) · 视频缩略图
- **对外接口**：`props: src(必填)`。
- **内部实现**：`<video preload="metadata">` 取首帧；失败/超时显示占位图标。
- **使用方**：`AlbumView`（视频格子）。

---

## 注意事项

- **新增格式只改一处**：格式实现集中在 `composables/exportFormats.js`（导出格式注册表），不要在页面里另写导出逻辑。
- **长表别开放图片格式**：长表 `HTML`（网页）/ `PDF`（便携文档）等长文档会让 `html2canvas`（网页转图片库）因为内存占用过多容易崩溃，相册索引导出因此屏蔽图片格式。
- **导入两边都校验**：前端先解析预览，后端仍会 `sanitize`（数据清洗）（见 [backend/services.md](../../backend/services.md)），不要因为前端校验过就跳过服务端校验。

---
