# AI 界面组件（`components/ai/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── student-frontend/
    └── src/
        ├── components/
        │   ├── ai/
        │   │   ├── AiComposer/
        │   │   │   └── AiComposer.vue  # 输入器
        │   │   ├── AiChangePanel.vue  # 变更/提案面板
        │   │   ├── AiChatMessages.vue  # 消息列表
        │   │   ├── AiConversationPanel.vue  # 会话列表
        │   │   ├── AiLinkPanel.vue  # 链接预览
        │   │   └── AiStreamTail.vue  # 流式尾巴
        │   └── tables/
        │       └── AiProposalTable.vue
        └── views/
            └── AiAssistant.vue
```
<!-- doc-tree:end -->

6 个文件，只负责渲染与交互；对话状态、流式解析、提案执行都在 [`views/AiAssistant.vue`](../../../../student-frontend/src/views/AiAssistant.vue) 与后端 `routes/ai/*`（跨层机制见 [topics/ai.md](../../topics/ai.md)）。

## 综合概述

- **定位**：AI 界面的纯展示 / 交互组件，属于 `components/ai/`，由 [AiAssistant.vue](../../../../student-frontend/src/views/AiAssistant.vue) 页面组装。
- **公共逻辑**：只通过 `props` 接收状态、通过 `emits` 把动作交回父级；覆盖消息流、会话列表、提案面板、链接预览、流式尾巴与输入器。
- **局限**：不处理路由跳转、AI 请求、提案执行与撤销；这些在 `views/AiAssistant.vue` 与后端 `routes/ai/*`，跨层机制见 [topics/ai.md](../../topics/ai.md)。

## 详细说明

### [AiChatMessages.vue](../../../../student-frontend/src/components/ai/AiChatMessages.vue) · 消息列表
- **定位**：对话消息流（用户/AI/工具块/提案块），支持重试、回滚、撤销、复制、跳转。
- **对外接口**：
  - `props`（父级传入的消息与判定函数）
    - `messages`（消息数组；元素含角色、正文、推理段、提案块、工具块等）。
    - `busy`（本轮是否仍在流式/处理中；为 `true` 时隐藏「开始新对话」）。
    - `activeReasoningOn`（是否默认展开推理段，默认 `false`）。
    - `floating`（浮窗模式：隐藏用时 / token 统计与数据改动入口，默认 `false`）。
    - `isRetryable`（父级判定函数：该消息是否可重试）。
    - `isRollbackable`（父级判定函数：该消息是否可回滚）。
    - `canUndo`（父级判定函数：本轮 AI 写入是否可撤销）。
  - `emits`（向父级抛出的动作）
    - `new`（开始新对话，无 payload）。
    - `copy`（复制消息，payload 为消息对象）。
    - `retry`（重试某条回复，payload 为消息下标）。
    - `undo`（撤销某条 AI 写入，payload 为消息对象）。
    - `rollback`（回滚到该条消息，无 payload）。
    - `open-changes`（打开数据改动抽屉，payload 为消息对象）。
    - `goto`（跳转到业务表，payload `{ table, id }`；`id` 为 `null` 时只跳页面）。
- **内部实现**：按消息类型渲染 `Markdown`（轻量标记文本，`marked`（解析库）+ `dompurify`（HTML 清洗库））、推理段折叠、变更摘要（`_changeSummary`）、工具调用块；`tableOfItem(it)` 从 `key`（数据项标识，如 `grid:schedule` / `table:students`）还原表名供预览。
- **使用方**：`AiAssistant`。

### [AiConversationPanel.vue](../../../../student-frontend/src/components/ai/AiConversationPanel.vue) · 会话列表
- **对外接口**：
  - `props`（父级传入的会话数据）
    - `conversations`（已加载的会话数组，默认 `[]`）。
    - `activeId`（当前会话 id，`Number` / `String`，默认 `null`）。
    - `busy`（加载或操作中，禁用操作，默认 `false`）。
    - `hiddenCount`（尚未渲染的更早会话数量，默认 `0`；用于「暂无历史对话」判断与总数）。
  - `emits`（向父级抛出的动作）
    - `new`（新建会话，无 payload）。
    - `select`（切换会话，payload 为会话 id）。
    - `delete`（删除会话，payload 为会话 id；组件内部先二次确认）。
    - `close`（收起会话列表，无 payload）。
    - `load-more`（加载更早一页会话，无 payload）。
- **内部实现**：会话切换与分页加载（`load-more`）；删除需二次确认。
- **使用方**：`AiAssistant`。

### [AiChangePanel.vue](../../../../student-frontend/src/components/ai/AiChangePanel.vue) · 变更/提案面板
- **对外接口**：
  - `props`（父级传入的提案数据）
    - `proposal`（待展示的提案对象，`null` 表示无）。
  - `emits`（向父级抛出的动作）
    - `close`（关闭抽屉，无 payload）。
    - `goto`（跳转，payload `{ table, id, focus }`；`focus` 为网格表精确定位串，`null` 表示只跳页面）。
- **内部实现**：按项分组展示 `proposal`（提案，单条「字段: 新值」、批量「旧值 → 新值」）；网格类提案交给 `AiGridPreview`（网格预览）。
- **使用方**：`AiAssistant`。

### [AiProposalTable.vue](../../../../student-frontend/src/components/tables/AiProposalTable.vue)
见 [tables.md](./tables.md)（放在 `tables/`，被本组复用）。

### [AiLinkPanel.vue](../../../../student-frontend/src/components/ai/AiLinkPanel.vue) · 链接预览
- **对外接口**：
  - `props`（父级传入的链接）
    - `url`（要预览的链接地址，默认空串）。
  - `emits`（向父级抛出的动作）
    - `close`（关闭预览，无 payload）。
    - `open-external`（在系统浏览器打开，payload 为链接地址）。
- **内部实现**：浮层展示链接与「在浏览器打开」（走主进程 `open-external`）。
- **使用方**：`AiChatMessages`。

### [AiStreamTail.vue](../../../../student-frontend/src/components/ai/AiStreamTail.vue) · 流式尾巴
- **对外接口**：
  - `props`（父级传入的流式文本）
    - `text`（本轮新增的文本，默认空串）。
  - `emits`：无。
- **内部实现**：把新增文本切成段做淡入动画（`ai-stream-in`），`prefers-reduced-motion` 时关闭动画。
- **使用方**：`AiChatMessages`。

### [AiComposer/AiComposer.vue](../../../../student-frontend/src/components/ai/AiComposer/AiComposer.vue) · 输入器
- **定位**：输入框 + 附件 + 权限模式 + 模型选择 + 提问（`ask`）分步表单。
- **对外接口**：
  - `props`（父级传入的受控状态）
    - 输入：`input`（输入框文本，默认空串）、`busy`（本轮请求进行中，禁用发送/附件）、`capturing`（截屏选区中，用于按钮态）。
    - 附件：`attachedFile`（已选附件对象，`null` 表示无）。
    - 分步提问：`pendingAsk`（待回答的 `ask_user`（提问）结构，`null` 表示无）、`askCurrent`（当前题）、`askPage`（当前题下标，默认 `0`）、`askCanSubmit`（是否可提交本轮答案）、`askCanAdvance`（是否可进入下一题）。
    - 提案：`pendingProposal`（待确认的写入提案，`null` 表示无）。
    - 权限与联网：`permissionMode`（`'approve'`（全部审批）/ `'full'`（完全权限），默认 `'approve'`）、`webSearch`（是否开启联网搜索，默认 `true`）、`searchAvailable`（当前模型是否支持联网，默认 `false`，仅 DeepSeek）。
    - 模型与技能：`modelId`（当前模型 id，默认 `null`）、`modelOptions`（可选模型列表）、`skillOptions`（可用技能名列表）、`selectedSkills`（本轮已选技能名列表）。
  - `emits`（向父级抛出的动作）
    - 输入与发送：`update:input`（新文本）、`send`（提交本轮输入，无 payload）、`interrupt`（中断流式，无 payload）。
    - 附件与截屏：`attach`（附件对象：`name` / `isImage` / `dataUrl` / `textContent` / `sizeLabel`）、`screenshot`（请求截屏，无 payload）。
    - 分步提问：`pick`（`page` + 选项值）、`other`（`page` + 自定义文本）、`next` / `submit` / `skip` / `dismiss`（下一题 / 提交 / 跳过 / 关闭，无 payload）。
    - 提案：`confirm`（确认执行提案）、`dismiss-proposal`（关闭提案，无 payload）。
    - 设置：`pick-permission`（目标权限模式）、`update:modelId`（目标模型 id）、`select-skill`（技能名）、`remove-skill`（技能名）、`toggle-search`（切换联网，无 payload）。
- **内部实现**：`/` 触发技能候选（展开时上下键、回车、ESC 接管键盘），Enter 发送、Shift+Enter 换行；附件走 `POST /api/ai/upload`；权限、模型与联网开关由父级持久化。
- **使用方**：`AiAssistant`。

## 注意事项

- `AiChatMessages` 与 `AiChangePanel` 的 `goto` 最终都由宿主 `AiAssistant` 处理路由，改 payload 形状时要同步父级。
- `AiComposer` 的 `/` 技能、Enter/Shift+Enter、附件上传依赖父级传入的 `busy` / `askCurrent` 等状态，不能改成组件内部自持。
- `AiProposalTable` 在 `tables/` 维护，本组只链接，避免两处改列或样式。
