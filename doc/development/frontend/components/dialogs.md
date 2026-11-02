# 业务弹窗（`components/dialogs/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── student-frontend/
    └── src/
        └── components/
            └── dialogs/
                ├── DutyArrangementDialog/
                │   └── DutyArrangementDialog.vue  # 值日编排
                ├── SmartArrangementDialog/
                │   └── SmartArrangementDialog.vue  # 智能排表
                ├── SmartGroupDialog/
                │   └── SmartGroupDialog.vue  # 智能分组
                ├── AddActivityDialog.vue  # 新增/编辑活动
                ├── AddCountdownDialog.vue  # 新增/编辑倒计时
                ├── AddLeaveDialog.vue  # 新增/编辑请假
                ├── AddModelDialog.vue  # 添加 AI 模型
                ├── AddScoreDialog.vue  # 新增/编辑加减分
                ├── AddStudentDialog.vue  # 添加学生/记录
                ├── AiSettingsDialog.vue  # AI 设置
                ├── AlbumManageDialog.vue  # 相册管理
                ├── AlbumPhotoPickerDialog.vue  # 选照片
                ├── AlbumTaskDialog.vue  # 扫描任务管理
                ├── ClassInfoDialog.vue  # 班级信息
                ├── DeduplicateDialog.vue  # 去重
                ├── DutyBackfillDialog.vue  # 值日回填
                ├── DutyRecordSettingsDialog.vue  # 值日记录设置
                ├── DutySettingsDialog.vue  # 值日设置
                ├── DutyWeightAlgorithmDialog.vue  # 值日权重算法
                ├── MoveAlbumDialog.vue  # 移动照片到相册
                ├── NewAlbumDialog.vue  # 新建相册
                ├── NewComerConfirm.vue  # 新成员参与确认
                ├── OverdueLeaveDialog.vue  # 逾期未销假
                ├── SeatBackfillDialog.vue  # 座位回填
                ├── SeatRecordSettingsDialog.vue  # 座位记录设置
                ├── SeatSettingsDialog.vue  # 座位设置
                ├── SettingsDialog.vue  # 课程表设置
                └── WeightAlgorithmDialog.vue  # 座位权重算法
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口约定」；本节只补充组件特有接口。

28 个弹窗。统一标准：`DialogShell`（弹窗外壳）+ `visible`（显隐属性）控制（少数由 `v-if`（条件渲染）挂载，无 `visible`）+ 异步加载（页面用 `v-preload`（悬停预取指令）预取）。

## 综合概述

- **定位**：业务弹窗层（`components/dialogs/`），28 个弹窗按记录类、设置与编排类、相册类分组。
- **公共逻辑**：统一用 `DialogShell` + `visible` 控制显隐（少数由 `v-if` 挂载），页面用 `v-preload` 预取 `chunk`；通用 props / emits 见 README。
- **局限**：不展开每个弹窗的字段校验规则（在各自小节），也不展开页面如何调用（见 [views.md](../views.md)）。

## 详细说明

### 记录类

#### [AddStudentDialog.vue](../../../../student-frontend/src/components/dialogs/AddStudentDialog.vue) · 添加学生/记录
- **定位**：按表字段动态渲染表单（学生表、班费表共用）。
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `fields`（动态字段）/ `requiredField`（必填字段）/ `title`（标题，默认「添加学生」）/ `initialValues`（初始值）；`emits`（组件事件）：`confirm`（确认）/ `cancel`（取消）。
- **内部实现**：按 `fields`（字段列表）生成输入项与必填校验；提交前 `trim`（去掉首尾空格）；`initialValues`（初始值）支持编辑态回填。
- **使用方**：`ClassroomView`、`FeeManagement`。

#### [AddActivityDialog.vue](../../../../student-frontend/src/components/dialogs/AddActivityDialog.vue) · 新增/编辑活动
- **对外接口**：`props: visible / editingRecord`；`emits: confirm / update / delete / cancel`。
- **使用方**：`ActivitiesView`。

#### [AddCountdownDialog.vue](../../../../student-frontend/src/components/dialogs/AddCountdownDialog.vue) · 新增/编辑倒计时
- **对外接口**：`props: visible / editingRecord`；`emits: confirm / update / delete / cancel`。
- **使用方**：`ActivitiesView`（倒计时 Tab）。

#### [AddLeaveDialog.vue](../../../../student-frontend/src/components/dialogs/AddLeaveDialog.vue) · 新增/编辑请假
- **对外接口**：`props: visible / students / typeOptions / editingRecord`；`emits: confirm / update / delete / cancel / ask-save-phones`。
- **内部实现**：可联动询问「是否把联系电话保存到学生档案」（`ask-save-phones`）。
- **使用方**：`LeaveManagement`。

#### [AddScoreDialog.vue](../../../../student-frontend/src/components/dialogs/AddScoreDialog.vue) · 新增/编辑加减分
- **对外接口**：`props: visible / students / mode('personal'|'group') / editingRecord`；`emits: confirm / update / delete / cancel`。
- **使用方**：`ScoreManagement`。

#### [AddModelDialog.vue](../../../../student-frontend/src/components/dialogs/AddModelDialog.vue) · 添加 AI 模型
- **对外接口**：`props: show`；`emits: close / saved`。
- **内部实现**：模型识别输入/选择，保存后通知 `AiSettingsDialog`。
- **使用方**：`AiSettingsDialog`。

### 设置与编排类

#### [AiSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/AiSettingsDialog.vue) · AI 设置
- **对外接口**：`props: show`；`emits: close / saved`。
- **内部实现**：启用开关、模型列表（增/选/删/测连通）、打开 `AddModelDialog`。
- **使用方**：`AiAssistant`。

#### [ClassInfoDialog.vue](../../../../student-frontend/src/components/dialogs/ClassInfoDialog.vue) · 班级信息
- **对外接口**：`props: visible / classData`；`emits: confirm / cancel`。
- **使用方**：`DashboardView`。

#### [DeduplicateDialog.vue](../../../../student-frontend/src/components/dialogs/DeduplicateDialog.vue) · 去重
- **对外接口**：`props: visible / rows / fields`；`emits: delete-rows / cancel`。
- **内部实现**：按字段组合展示重复行，勾选保留项后批量删除。
- **使用方**：`ClassroomView`、`FeeManagement`。

#### [SeatSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SeatSettingsDialog.vue) · 座位设置
- **对外接口**：`props: visible / rows(必填) / cols(必填) / mode / showAisle`；`emits: save / cancel`。
- **使用方**：`SeatView`。

#### [SeatRecordSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SeatRecordSettingsDialog.vue) · 座位记录设置
- **对外接口**：`props: visible`；`emits: close`。
- **内部实现**：座位历史记录的保留/展示设置（写 `seat_settings`）。
- **使用方**：`SeatView`（记录/历史入口）。

#### [SeatBackfillDialog.vue](../../../../student-frontend/src/components/dialogs/SeatBackfillDialog.vue) · 座位回填
- **对外接口**：`props: visible`；`emits: close / changed`。
- **内部实现**：把某周快照回填到当前表，完成后通知页面刷新。
- **使用方**：`SeatView`。

#### [WeightAlgorithmDialog.vue](../../../../student-frontend/src/components/dialogs/WeightAlgorithmDialog.vue) · 座位权重算法
- **对外接口**：`props: rows(6) / cols(7)`；`emits: close / apply`。
- **内部实现**：编辑每个座位的权重（近视/身高/注意力等维度），应用后写权重表。
- **使用方**：`SeatView` / `SmartArrangementDialog`。

#### [DutySettingsDialog.vue](../../../../student-frontend/src/components/dialogs/DutySettingsDialog.vue) · 值日设置
- **对外接口**：`props: visible / days / items`；`emits: save / cancel`。
- **使用方**：`DutyView`。

#### [DutyRecordSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/DutyRecordSettingsDialog.vue) · 值日记录设置
- **对外接口**：`props: visible / mode('daily')`；`emits: close`。
- **使用方**：`DutyView`（记录/历史入口）。

#### [DutyBackfillDialog.vue](../../../../student-frontend/src/components/dialogs/DutyBackfillDialog.vue) · 值日回填
- **对外接口**：`props: visible / mode('daily')`；`emits: close / changed`。
- **使用方**：`DutyView`。

#### [DutyWeightAlgorithmDialog.vue](../../../../student-frontend/src/components/dialogs/DutyWeightAlgorithmDialog.vue) · 值日权重算法
- **对外接口**：`props: days / items`；`emits: cancel / apply`。
- **内部实现**：编辑劳动项目与星期维度权重，应用后供智能编排使用。
- **使用方**：`DutyView` / `DutyArrangementDialog`。

#### [SettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SettingsDialog.vue) · 课程表设置
- **对外接口**：`props: visible / settings / semesterStart / showSemesterStart`；`emits: save / cancel / update:semesterStart`。
- **使用方**：`ScheduleView`。

#### [DutyArrangementDialog/DutyArrangementDialog.vue](../../../../student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.vue) · 值日编排
- **对外接口**：`props: days / items / students / weights({}) / ledger({}) / draft({exists:false})`；`emits: cancel / confirm / save-draft / clear-draft`。
- **内部实现**：随机排表 + 预览 + 应用；草稿可暂存/清除（`/api/duty/template` 相关）。
- **使用方**：`DutyView`（`v-if` 挂载，无 `visible`）。

#### [SmartArrangementDialog/SmartArrangementDialog.vue](../../../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.vue) · 智能排表
- **对外接口**：`props: rows(6) / cols(7) / mode('single') / showAisle(true) / students / initialSeats / weights / ledger({})`；`emits: cancel / confirm`。
- **内部实现**：排表方式树 + 条件 + `GridView` 预览 + 新成员确认（`NewComerConfirm`）；算法在 `SmartArrangementDialog.*.js`（pipeline/blocks/options）。
- **使用方**：`SeatView`。

#### [SmartGroupDialog/SmartGroupDialog.vue](../../../../student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.vue) · 智能分组
- **对外接口**：`props: students / groups / leaderTitle('组长')`；`emits: cancel / confirm`。
- **使用方**：`GroupManageView`。

#### [NewComerConfirm.vue](../../../../student-frontend/src/components/dialogs/NewComerConfirm.vue) · 新成员参与确认
- **对外接口**：`props: names / action('排表')`；`emits: participate / not`。
- **使用方**：`SmartArrangementDialog`、`SmartGroupDialog`。

### 相册类

#### [AlbumManageDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumManageDialog.vue) · 相册管理
- **对外接口**：`props: visible`；`emits: close / changed`。
- **内部实现**：添加相册文件夹（系统选目录）、拖拽排序、删除（仅删索引，可撤销）、打开文件夹；虚拟相册显示「虚拟」角标。
- **使用方**：`AlbumView`。

#### [NewAlbumDialog.vue](../../../../student-frontend/src/components/dialogs/NewAlbumDialog.vue) · 新建相册
- **对外接口**：`props: visible / albums`；`emits: close / created(新相册 id)`。
- **内部实现**：`ViewSwitch` 切「文件夹 / 其他相册」；文件夹来源递归扫描；其他相册来源打开 `AlbumPhotoPickerDialog` 选照片生成虚拟相册。
- **使用方**：`AlbumView`。

#### [AlbumPhotoPickerDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumPhotoPickerDialog.vue) · 选照片
- **对外接口**：`props: visible / albumId / albumName / initialIds`；`emits: close / confirm(photos)`。
- **内部实现**：按日期分组的时间轴网格（与相册页共用 `usePhotoTimeline`），单选框 + 全选/取消。
- **使用方**：`NewAlbumDialog`。

#### [AlbumTaskDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumTaskDialog.vue) · 扫描任务管理
- **对外接口**：`props: visible`；`emits: close / changed`。
- **内部实现**：每册一行（增量/全量/停止/暂停继续），首行「更新所有相册」串行排队；800ms 轮询 `GET /api/album/tasks`。
- **使用方**：`AlbumView`。

#### [MoveAlbumDialog.vue](../../../../student-frontend/src/components/dialogs/MoveAlbumDialog.vue) · 移动照片到相册
- **对外接口**：`props: visible / albums / currentAlbumId / photoIds`；`emits: close / moved`。
- **内部实现**：只列虚拟相册（排除当前）；成功后登记 `album_photo_move` 撤销记录。
- **使用方**：`AlbumView`（时间轴多选后打开）。

#### [OverdueLeaveDialog.vue](../../../../student-frontend/src/components/dialogs/OverdueLeaveDialog.vue) · 逾期未销假
- **对外接口**：`props: records`；`emits: not / ret`。
- **使用方**：`LeaveManagement`。

## 注意事项

- **两种挂载方式不要混**：有 `visible` 的走属性控制，`v-if` 挂载的不要改成 `visible`（预取时机与卸载行为都会变）。
- **新增 / 编辑复用一份**：同一弹窗用 `mode` + `initialValues` 区分，不要复制第二个组件。
- **写库与撤销归父级**：弹窗只发 `save` / `confirm` 事件，撤销登记由页面或组合式函数负责（见 [composables.md](../composables.md)）。
- **保持懒加载**：弹窗按 `chunk` 懒加载、页面按钮用 `v-preload` 预取，不要在首屏静态 `import`。
