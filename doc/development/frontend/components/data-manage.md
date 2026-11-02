# 数据管理组件（`components/data-manage/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    └── src/
        └── components/
            └── data-manage/
                ├── DataManageDialog.vue  # 数据管理弹窗
                ├── ExportChatDialog.vue  # 对话导出
                ├── ExportMarkdownDialog.vue  # Markdown 导出
                └── MarkdownEditDialog.vue  # Markdown 编辑
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

4 个文件，对应设置页「数据管理」：技能 Markdown、AI 对话导出、Markdown 导出与编辑。

---

## 综合概述

- **定位**：设置页「数据管理」的弹窗组：`DataManageDialog`（数据管理入口）、`MarkdownEditDialog`（Markdown 编辑）、`ExportMarkdownDialog`（Markdown 导出）与 `ExportChatDialog`（对话导出）。
- **公共逻辑**：均由 `DataManageDialog`（数据管理弹窗）打开；技能文件经 `MarkdownEditDialog`（Markdown 编辑弹窗）新增 / 编辑，导出内容与文件名由面板统一交给保存对话框。
- **局限**：不展开 AI 技能文件与对话数据的后端存储（见 [topics/ai.md](../../topics/ai.md)）。

---

## 详细说明

### [DataManageDialog.vue](../../../../student-frontend/src/components/data-manage/DataManageDialog.vue) · 数据管理弹窗
- **定位**：管理 AI 技能文件与数据目录信息的总入口。
- **对外接口**：`props`（组件属性）：`visible`（显隐，默认关闭）；`emits`（组件事件）：`update:visible`（显隐更新）。
- **内部实现**：`loadAll()`（加载全部）读取技能列表与 `get-data-directories`（读取数据目录的 IPC 通道：数据/缓存/缩略图/技能目录）；打开 `MarkdownEditDialog`（Markdown 编辑弹窗）新增/编辑技能；打开 `ExportChatDialog`、`ExportMarkdownDialog` 导出；删除技能需确认。
- **使用方**：`SettingsView`（数据管理入口）。

### [MarkdownEditDialog.vue](../../../../student-frontend/src/components/data-manage/MarkdownEditDialog.vue) · Markdown 编辑
- **对外接口**：`props: visible / isNew / nameDisabled / originalName / initialName / initialContent`；`emits: update:visible / save({original, name, content})`。
- **内部实现**：文件名合法性校验（`safeName`）；760×660 固定尺寸，内容区可滚动。
- **使用方**：`DataManageDialog`。

### [ExportMarkdownDialog.vue](../../../../student-frontend/src/components/data-manage/ExportMarkdownDialog.vue) · Markdown 导出
- **对外接口**：`props: visible / content('') / defaultFilename('Markdown文件')`；`emits: update:visible`。
- **内部实现**：选 `md` / `txt` 格式导出，走 `runTableExport` 的保存对话框。
- **使用方**：`DataManageDialog`。

### [ExportChatDialog.vue](../../../../student-frontend/src/components/data-manage/ExportChatDialog.vue) · 对话导出
- **对外接口**：`props: visible / conversationId(null) / conversationName('')`；`emits: update:visible`。
- **内部实现**：按范围导出（全部 / 仅用户 / 仅 AI / 仅最后输出 / 仅思维链）。
- **使用方**：`DataManageDialog`。

---

## 注意事项

- **技能文件名先校验**：`MarkdownEditDialog`（Markdown 编辑弹窗）的 `safeName`（文件名合法性校验）不能绕过；改名时由 `nameDisabled`（名称不可改标记）控制名称是否可编辑。
- **保存统一走导出面板**：`ExportMarkdownDialog`（Markdown 导出弹窗）/ `ExportChatDialog`（对话导出弹窗）只产出内容与默认文件名，保存对话框由导出面板统一弹，不要各自实现保存。
- **入口唯一**：新增数据管理类弹窗挂在 `DataManageDialog`（数据管理弹窗）下，不要从设置页另开入口。

---
