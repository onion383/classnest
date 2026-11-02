# 基础组件（`components/base/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── student-frontend/
    └── src/
        ├── components/
        │   └── base/
        │       ├── AccountDialog.vue  # 账户弹窗
        │       ├── AppHelp.vue  # 帮助气泡
        │       ├── AppSelect.vue  # 自定义下拉框
        │       ├── AppSwitch.vue  # 开关
        │       ├── ColorSwatch.vue  # 色块选择
        │       ├── ConfirmDialog.vue  # 通用确认弹窗
        │       ├── ContextMenu.vue  # 右键菜单
        │       ├── CustomScrollbar.vue  # 自定义滚动条
        │       ├── DialogShell.vue  # 弹窗外壳
        │       ├── EmptySnapshot.vue  # 空态占位
        │       ├── IconGlyph.vue  # 统一图标
        │       ├── LeaveTimeline.vue  # 通用时间轴
        │       ├── NotificationToast.vue  # 全局通知
        │       ├── SearchBar.vue  # 搜索面板
        │       ├── SearchDialog.vue  # 全局搜索弹窗
        │       ├── ShutdownMenuDialog.vue  # 关闭行为选择
        │       ├── StatBarList.vue  # 条形统计列表
        │       ├── Tabs.vue  # 标签页
        │       ├── ThemePickerDialog.vue  # 主题选择
        │       ├── ViewSwitch.vue  # 视图切换
        │       └── WeekSwitcher.vue  # 周切换条
        ├── composables/
        │   └── useNotification.js
        └── subwindows/
            └── widget/
                └── Note.vue
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口约定」；本节只补充组件特有接口。

21 个通用件，被各页面与弹窗复用。条目统一：定位 / 对外接口 / 内部实现 / 使用方与注意点。

## 综合概述

- **定位**：基础通用件（`components/base/`），21 个组件覆盖弹窗外壳、表单控件、通知、图标、时间轴与空态。
- **公共逻辑**：对外接口遵守 [components/README.md](./README.md) 的「通用对外接口约定」；弹窗统一用 `DialogShell`，图标统一用 `IconGlyph`，通知统一走 `useNotification()`。
- **局限**：本页只补充组件特有接口，通用 props / emits 的含义见 README，不重复；主题实现见 [misc.md](../misc.md)。

## 详细说明

### [AccountDialog.vue](../../../../student-frontend/src/components/base/AccountDialog.vue) · 账户弹窗
- **定位**：标题栏账户入口：显示用户名与权限（role），底部「退出登录」带二次确认。
- **对外接口**：`props`（组件属性）`visible(false)`（显隐，默认关闭）；`emits`（组件事件）`close`（关闭）。
- **内部实现**：自定义遮罩 + 卡片（带 `no-dialog-pulse`（不弹遮罩提示的标记类），点遮罩直接关闭）；退出登录走 `ConfirmDialog`（确认框）二次确认。
- 注意：属于 `no-dialog-pulse` 白名单，点遮罩不会弹「请关闭弹窗」。

### [AppHelp.vue](../../../../student-frontend/src/components/base/AppHelp.vue) · 帮助气泡
- **定位**：字段旁的「?」提示，悬停/聚焦后浮出说明。
- **对外接口**：`props`（组件属性）`text`（提示文本，必填）/ `ariaLabel`（无障碍标签）/ `size=14`（尺寸）/ `delay=60`（延迟毫秒）/ `zIndex=10000`（层叠层级）。
- **内部实现**：`mouseenter`（鼠标移入）延时打开，`mouseleave`（鼠标移出）关闭；浮层定位随触发器。
- 注意：`text` 必填；文案走纯文本，不渲染 `HTML`（网页标记）。

### [AppSelect.vue](../../../../student-frontend/src/components/base/AppSelect.vue) · 自定义下拉框
- **定位**：替代原生 `<select>`，圆角 + 毛玻璃，支持紧凑模式；用于设置页、表格筛选、弹窗等所有选择场景。
- **对外接口**：
  - `props`（组件属性）：`modelValue`（当前值，`[String,Number]`，默认空串）/ `options`（候选项数组，`['A']` 或 `[{value,label,disabled}]`）/ `placeholder`（占位文案，默认「请选择」）/ `disabled`（禁用，默认 false）/ `compact`（紧凑模式，默认 false）
  - `emits`（组件事件）：`update:modelValue(value)`（值更新）/ `change(value)`（变更）；无插槽。
- **内部实现**：`toggle()` 开合并按触发器矩形定位；`_layerZ()` 沿祖先链取最大 `z-index`（层叠层级）再 +10（保证压过宿主浮层）；`move(step)` 上下键循环并跳过 `disabled`（禁用项）；`commit(i)` 选中并触发事件；`onDocClick(e)` 外部点击关闭；`onViewportChange()` 滚动/`resize`（窗口尺寸变化）重排、抛出视口即收起。
- **使用方**：`GroupManageView`、`Login`、`DutyView`、`ScoreManagement`、`AlbumView`、`SettingsView`、`WeekSwitcher`、`SearchBar`、`DynamicTable`、`AiSettingsDialog`、`DutyArrangementDialog`、`SmartArrangementDialog` 等。
- 注意：菜单 `Teleport`（传送组件）到 `body`（页面主体）并手动同步父级字号；不要改成容器内绝对定位，会被 `overflow`（溢出裁剪）裁掉。

### [AppSwitch.vue](../../../../student-frontend/src/components/base/AppSwitch.vue) · 开关
- **定位**：设置项与弹窗里的布尔开关。
- **对外接口**：`props: modelValue(false) / disabled(false) / ariaLabel('')`；`emits: update:modelValue / change`。
- **内部实现**：点击切换并 `emit`（触发事件）；`disabled`（禁用）时拦截；带 `role="switch"`（声明为开关控件）与键盘响应。

### [ColorSwatch.vue](../../../../student-frontend/src/components/base/ColorSwatch.vue) · 色块选择
- **定位**：工具箱「屏幕注释」等场景的画笔颜色选择。
- **对外接口**：`props: modelValue('#000000') / presetColors`；`emits: update:modelValue`。
- **使用方**：[`subwindows/widget/Note.vue`](../../../../student-frontend/src/subwindows/widget/Note.vue)。

### [ConfirmDialog.vue](../../../../student-frontend/src/components/base/ConfirmDialog.vue) · 通用确认弹窗
- **定位**：全应用的二次确认；也用于「列名/列类型」编辑（列操作的统一入口）。
- **对外接口**：`props: visible / title / message / type / showCancel / confirmDisabled / confirmText('确定') / cancelText('取消') / extraText('') / columnName / columnType / errorMsg`；`emits: confirm / cancel / extra / update:columnName / update:columnType`。
- **内部实现**：`DialogShell` 外壳 + 按 `type` 渲染列名/列类型输入；组件只展示 `errorMsg`，**校验在宿主**（如 `useTableCRUD` 的列名校验）完成。
- **使用方**：`ClassroomView`、`FeeManagement`、`LeaveManagement`、`ScoreManagement`、`ScheduleView`、`DutyView`、`ActivitiesView`、`GroupManageView`、`AiAssistant`、`AiSettingsDialog` 等。

### [ContextMenu.vue](../../../../student-frontend/src/components/base/ContextMenu.vue) · 右键菜单
- **定位**：表格/网格的右键菜单容器，项由宿主传入。
- **对外接口**：`props: visible / x / y / items（含 action）`；`emits: close`。
- **内部实现**：`fixed` 定位 + 视口边界翻转；点击外部或选中项后关闭。
- 注意：菜单项动作由宿主执行，组件不发业务事件。

### [CustomScrollbar.vue](../../../../student-frontend/src/components/base/CustomScrollbar.vue) · 自定义滚动条
- **定位**：统一滚动条外观（细滑块、悬停淡入），支持普通容器与 `fixed` 浮层。
- **对外接口**：`props: target(滚动容器 ref) / arrows(true) / compact(false) / autoHide(false) / fixed(false) / zIndex(0) / arrowHeight(14) / scrollStep(40) / minThumb(28)`。
- **内部实现**：监听 `scroll`/`resize` 计算滑块位置与比例；拖动滑块反写 `target.scrollTop`；`autoHide` 用定时器淡出。
- **使用方**：`AppSelect` 菜单、表格容器、AI 面板等。

### [DialogShell.vue](../../../../student-frontend/src/components/base/DialogShell.vue) · 弹窗外壳
- **定位**：统一遮罩 + 卡片 + 过渡动画，业务弹窗只写内容。
- **对外接口**：`props: visible / zIndex(10006) / overlayClass`；`emits: overlay`；默认插槽为卡片内容。
- **内部实现**：`Transition name="dialog"`；遮罩点击 emit `overlay`（默认关闭；豁免组件自行忽略）。
- 注意：内含 `.dialog-card` 的遮罩会被全局事件委托识别，点遮罩只提示不关闭。

### [EmptySnapshot.vue](../../../../student-frontend/src/components/base/EmptySnapshot.vue) · 空态占位
- **定位**：历史快照/列表无数据时的统一空态，可带操作按钮。
- **对外接口**：`props: text('暂未有历史快照') / icon('🗓') / minHeight('320px') / actionText / actionIcon`；`emits: action`。
- **使用方**：`DutyView`、`ScheduleView`、`SeatView`、列表型表格。
- 注意：按钮必须带 `action-text` / `action-icon`，颜色用 `bg-info`，不要手搓插槽按钮。

### [IconGlyph.vue](../../../../student-frontend/src/components/base/IconGlyph.vue) · 统一图标
- **定位**：全应用图标入口，按主题 `iconStyle` 在 lucide 与 emoji 间切换。
- **对外接口**：`props: name(必填) / size(24) / strokeWidth(2) / tint('color') / glyph(false)`；内部维护名称映射表（lucide 名 + emoji + 颜色）。
- **内部实现**：`computed` 解析 `name` → 图标组件或 emoji 文本；`glyph` 用于内联 SVG 场景。
- **使用方**：全局（`main.js` 注册）；模板 `<IconGlyph name="chevronDown" :size="14" />`。
- 注意：新增图标要同时补 lucide 与 emoji，否则切换主题时缺图。

### [LeaveTimeline.vue](../../../../student-frontend/src/components/base/LeaveTimeline.vue) · 通用时间轴
- **定位**：请假/加减分/活动的时间轴展示，支持右侧操作区与空态。
- **对外接口**：`props: nodes / typeOptions / title('🗓️ 请假时间轴') / alignRight(false) / maxHeight(420) / fillHeight(false) / emptyText('暂无匹配的时间轴记录') / emptyActionText / loading`；`emits: emptyAction`；插槽 `content`、`ops`。
- **内部实现**：按节点日期分组渲染，虚拟化省略（数据量有限）。
- **使用方**：`LeaveManagement`、`ScoreManagement`、`ActivitiesView`。

### [NotificationToast.vue](../../../../student-frontend/src/components/base/NotificationToast.vue) · 全局通知
- **定位**：右上角 toast 列表，带进度条与合并提示。
- **对外接口**：无 props；数据来自 [`src/composables/useNotification.js`](../../../../student-frontend/src/composables/useNotification.js)。
- **内部实现**：`TransitionGroup` 进出场；`instanceof` 合并同文案；进度条按时长收缩。
- **使用方**：`App.vue` 挂载。

### [SearchBar.vue](../../../../student-frontend/src/components/base/SearchBar.vue) · 搜索面板
- **定位**：表格页的「按列搜索」工具条。
- **对外接口**：`props: fields / visible`；`v-model:keyword`、`v-model:searchField`；`emits: close`。
- **内部实现**：展开用 grid 高度过渡（避免表格跳动）；输入本地化处理以避开 IME 光标跳位。
- **使用方**：`ClassroomView`、`FeeManagement`。

### [SearchDialog.vue](../../../../student-frontend/src/components/base/SearchDialog.vue) · 全局搜索弹窗
- **定位**：跨表搜索（`/api/search`）的入口弹窗，豁免遮罩脉冲。
- **对外接口**：`emits: close`；结果分组由内部调用 `/api/search` 渲染，点击结果跳转对应页面。
- **使用方**：`App.vue` 标题栏搜索入口。

### [ShutdownMenuDialog.vue](../../../../student-frontend/src/components/base/ShutdownMenuDialog.vue) · 关闭行为选择
- **定位**：关闭主窗口时询问范围（主窗口 / 含工具箱 / 含桌面组件 / 全部），可记住选择。
- **对外接口**：`props: visible / hasToolbox / hasDesktop`；`emits: choose({action, remember}) / cancel`。
- **使用方**：`App.vue`；与主进程 `shutdown-menu` 广播配合。

### [StatBarList.vue](../../../../student-frontend/src/components/base/StatBarList.vue) · 条形统计列表
- **定位**：看板/详情里的横向占比条（如人数、值日完成度）。
- **对外接口**：`props: rows / nameKey('name') / valueKey('value') / barWidth(Function, 必填) / barClass / valueText / valueClass('text-text') / rowKey / emptyText('暂无数据') / maxVisible(5)`。
- **内部实现**：`barWidth(row)` 返回百分比宽度；超过 `maxVisible` 折叠为「其余 N 项」。
- **使用方**：`DashboardView` 等看板卡片。

### [Tabs.vue](../../../../student-frontend/src/components/base/Tabs.vue) · 标签页
- **定位**：页内多视图切换（学生/班干部、实行/一般课表等）。
- **对外接口**：`props: tabs(必填) / modelValue(必填)`；`emits: update:modelValue`；插槽 `extra`、默认插槽（透出 `activeTab`）。
- **内部实现**：预留一行高度避免 CLS。
- **使用方**：`ClassroomView`、`ScheduleView`、`SeatView`、`DutyView`、`LeaveManagement`、`ScoreManagement`、`ActivitiesView`、`GroupManageView`。

### [ThemePickerDialog.vue](../../../../student-frontend/src/components/base/ThemePickerDialog.vue) · 主题选择
- **定位**：设置页的主题预览与切换（base / glass / glass2 + 自定义），豁免遮罩脉冲。
- **对外接口**：`emits: close`；内部持有各主题预览色（`base/glass/glass2`）。
- **使用方**：`SettingsView`（外观设置）。

### [ViewSwitch.vue](../../../../student-frontend/src/components/base/ViewSwitch.vue) · 视图切换
- **定位**：两态/多态切换控件（相册「时间轴 / 相册」、新建相册「文件夹 / 其他相册」）。
- **对外接口**：`props: modelValue / options / thumbClass('bg-primary text-text-inverse')`；`emits: update:modelValue`。
- **内部实现**：滑块随选项宽度移动（用 `thumbClass` 适配主题）。
- **使用方**：`AlbumView`、`NewAlbumDialog`、`SettingsView`。

### [WeekSwitcher.vue](../../../../student-frontend/src/components/base/WeekSwitcher.vue) · 周切换条
- **定位**：座位/课表/值日的周快照切换与操作区。
- **对外接口**：`props: currentWeek(必填) / weeks`；`emits: update:currentWeek / direction`；插槽 `actions`。
- **内部实现**：上一周/下一周按钮 emit `direction`，下拉选择 emit `update:currentWeek`。
- **使用方**：`SeatView`、`ScheduleView`、`DutyView`。

## 注意事项

- **接口不要自造别名**：新增通用件沿用 `visible` / `modelValue` / `confirm` / `cancel` 等既有命名，否则与「通用对外接口约定」对不上。
- **弹窗一律走 `DialogShell`**：遮罩、`Esc`、层级与过渡由外壳统一；只做自定义遮罩会漏掉弹窗点击提示（`no-dialog-pulse` 白名单同理）。
- **通知走 `useNotification()`**：不要自己挂 toast，合并同文案与「撤销」按钮都由该组合式函数管理。
