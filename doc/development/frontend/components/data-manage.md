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
                ├── DataExportPanel.vue  # 数据导出面板
                ├── DataManageDialog.vue  # 数据管理弹窗
                ├── ExportChatDialog.vue  # 对话导出
                ├── ExportMarkdownDialog.vue  # Markdown 导出
                └── MarkdownEditDialog.vue  # Markdown 编辑
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

5 个文件：4 个是设置页「数据管理」的弹窗组（技能 Markdown、AI 对话导出、Markdown 导出与编辑），
外加 `DataExportPanel`（设置页里内嵌的数据导出面板，不是弹窗 —— 与 `DataManageDialog` 同名不同义，别混）。

---

## 综合概述

- **定位**：设置页的弹窗组：`DataManageDialog`（数据管理入口）、`MarkdownEditDialog`（Markdown 编辑）、`ExportMarkdownDialog`（Markdown 导出）与 `ExportChatDialog`（对话导出）；以及内嵌面板 `DataExportPanel`（业务数据打包导出）。
- **公共逻辑**：弹窗组均由 `DataManageDialog`（数据管理弹窗）打开；技能文件经 `MarkdownEditDialog`（Markdown 编辑弹窗）新增 / 编辑，导出内容与文件名由面板统一交给保存对话框。`DataExportPanel` 独立挂在设置页，导出选项复用 `ExportExcel` 的弹窗。
- **局限**：不展开 AI 技能文件与对话数据的后端存储（见 [topics/ai.md](../../topics/ai.md)）。

---

## 详细说明

### [DataExportPanel.vue](../../../../student-frontend/src/components/data-manage/DataExportPanel.vue) · 数据导出面板
- **定位**：设置页「数据管理」分区的主体。列出 20 张业务表（行数、勾选、单表导出），顶部「全部导出 / 选中导出」把多张表打成一个 zip。
- **搜索**：标题行右侧的搜索框（外观与设置页顶部那个一致），结果是**过滤列表**而不是设置页那样的跳转定位，所以没有悬浮弹窗与键盘高亮。匹配口径沿用同一套 —— 命中「表名片段」或「拼音首字母」（`py` 由 `GET /tables` 下发），`Esc` 清空。搜索状态下「全部导出」变成「导出筛选的 N 张」，只导当前筛出来的表；「选中导出」仍按勾选走（筛选只是视图，取消勾选才会改动集合）。
- **对外接口**：无 props / emits（自包含，直接挂在 `SettingsView`）。
- **内部实现**：`GET /api/data/tables` 取清单（默认全选）；「全部/选中导出」打开 `ExportExcel` 弹窗（`hideFieldPicker` 隐藏选列 + `extraOptions` 插槽放「选择导出的表」和 zip 密码 + `customExport` 接管导出动作）；每行的「导出」也走同一个弹窗，只是恢复选列。
- **收据原件**：勾选了「班费记录」（key 为 `fees`）时，插槽里多一个「同时导出收据文件」开关（`AppSwitch`），开启后 zip 里多 `收据文件/{收支编码}/{原文件名}`。前端此时只有表格化文本、拿不到收据原始路径，所以传 `includeReceipts: true` 让后端按库里的 `fee_records` 自己分组（与班费页传 `receiptGroups` 的「页面口径」不同，见 [backend/routes.md](../../backend/routes.md) 第 9 节）。取消勾选班费表后开关消失，且 `runZip` 会再挡一次。
- **打包链路**：逐表用 `useExportFormats` 生成文件（注入 `saveFile` 收集 blob，不落单个文件）→ base64 → `POST /api/data/zip` → 现有 `SAVE_FILE` 通道落盘（因此**不需要新增 IPC 通道**）。
- **使用方**：`SettingsView`（数据管理分区）。

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

### [AccessLogDialog.vue](../../../../student-frontend/src/components/data-manage/AccessLogDialog.vue) · 数据访问记录弹窗
- **定位**：AI 与 MCP 两个入口共用的访问记录时间线，读与写合成一条，`source` 固定各自一侧。
- **内部实现**：已执行的写来自 `undo_history`，未执行的来自 MCP 提案，同一件事只出现一次。

### [AiPrivacyPanel.vue](../../../../student-frontend/src/components/data-manage/AiPrivacyPanel.vue) · AI 数据保护面板
- **定位**：总开关、敏感信息混淆与每张表权限档的面板，由 `AiPrivacyDialog` 装进弹窗。
- **内部实现**：读写、乐观更新与回滚全走 `usePrivacyConfig(scope)`，面板只负责排版与文案。

### [McpPermissionsDialog.vue](../../../../student-frontend/src/components/data-manage/McpPermissionsDialog.vue) · MCP 数据权限弹窗
- **定位**：MCP 侧的表级权限与混淆开关，配置与 AI 助手那份相互独立。
- **内部实现**：复用 `usePrivacyConfig('mcp')`，不自己发请求。

### [McpProposalsDialog.vue](../../../../student-frontend/src/components/data-manage/McpProposalsDialog.vue) · MCP 提案弹窗
- **定位**：外部 AI 写入提案的确认入口，分「未处理 / 已处理」两栏。
- **内部实现**：打开时拉取一次并支持手动刷新，关闭后设置页不再为它维持轮询。

### [McpSettingsPanel.vue](../../../../student-frontend/src/components/data-manage/McpSettingsPanel.vue) · MCP 服务设置面板
- **定位**：启用开关加令牌 / 数据权限 / 提案 / 访问记录四个入口，只展示状态摘要。
- **内部实现**：具体操作各自进入独立弹窗；加载与写入带序号守卫，旧响应不覆盖新状态。

### [McpTokensDialog.vue](../../../../student-frontend/src/components/data-manage/McpTokensDialog.vue) · MCP 令牌弹窗
- **定位**：令牌列表、新增、复制、失效与去除记录都在这一处。
- **内部实现**：加载按序号守卫，关闭即作废在途响应。

### [PrivacyToggles.vue](../../../../student-frontend/src/components/data-manage/PrivacyToggles.vue) · 敏感信息混淆开关组
- **定位**：姓名、电话、本地路径三个混淆项一行排布，总开关关闭时标注「暂不生效」。
- **内部实现**：纯展示，读写与回滚都在 `usePrivacyConfig`。

### [TableScopeList.vue](../../../../student-frontend/src/components/data-manage/TableScopeList.vue) · 表权限档清单
- **定位**：每张表一行（中文名、解释与档位下拉）的权限清单。
- **内部实现**：纯展示，档位判定与保存都在 `usePrivacyConfig`。

---

## 注意事项

- **技能文件名先校验**：`MarkdownEditDialog`（Markdown 编辑弹窗）的 `safeName`（文件名合法性校验）不能绕过；改名时由 `nameDisabled`（名称不可改标记）控制名称是否可编辑。
- **保存统一走导出面板**：`ExportMarkdownDialog`（Markdown 导出弹窗）/ `ExportChatDialog`（对话导出弹窗）只产出内容与默认文件名，保存对话框由导出面板统一弹，不要各自实现保存。
- **入口唯一**：新增数据管理类弹窗挂在 `DataManageDialog`（数据管理弹窗）下，不要从设置页另开入口。

---
