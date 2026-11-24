# 业务弹窗（`components/dialogs/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
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
                ├── AddClassDialog.vue  # 新增班级
                ├── AddCountdownDialog.vue  # 新增/编辑倒计时
                ├── AddLeaveDialog.vue  # 新增/编辑请假
                ├── AddModelDialog.vue  # 添加 AI 模型
                ├── AddScoreDialog.vue  # 新增/编辑加减分
                ├── AddStudentDialog.vue  # 添加学生/记录
                ├── AiPrivacyDialog.vue  # AI 数据保护弹窗
                ├── AiSettingsDialog.vue  # AI 设置
                ├── AlbumManageDialog.vue  # 相册管理
                ├── AlbumPhotoPickerDialog.vue  # 选照片
                ├── AlbumTaskDialog.vue  # 扫描任务管理
                ├── ClassInfoDialog.vue  # 班级信息
                ├── CreateTokenDialog.vue  # 令牌选项
                ├── DeduplicateDialog.vue  # 去重
                ├── DuplicateNameDialog.vue  # 导入时同名学生逐行选人
                ├── DutyBackfillDialog.vue  # 值日回填
                ├── DutyRecordSettingsDialog.vue  # 值日记录设置
                ├── DutySettingsDialog.vue  # 值日设置
                ├── DutyWeightAlgorithmDialog.vue  # 值日权重算法
                ├── ScheduleRecordDialog.vue  # 课表记录管理（周列表 + 删除）
                ├── SnapshotPickerDialog.vue  # 查看快照的选择弹窗（座位/值日/课表）
                ├── LocalRecoverDialog.vue  # 已登录时忘记密码（本机恢复）
                ├── MoveAlbumDialog.vue  # 移动照片到相册
                ├── NewAlbumDialog.vue  # 新建相册
                ├── NewComerConfirm.vue  # 新成员参与确认
                ├── OverdueLeaveDialog.vue  # 逾期未销假
                ├── ProvisionalStudentsDialog.vue  # 临时学生
                ├── ReceiptDialog.vue  # 管理收据
                ├── RecoveryKeyDialog.vue  # 恢复词展示与抄写确认
                ├── SeatBackfillDialog.vue  # 座位回填
                ├── SeatRecordSettingsDialog.vue  # 座位记录设置
                ├── SeatSettingsDialog.vue  # 座位设置
                ├── SettingsDialog.vue  # 课程表设置
                ├── TodoCenterDialog.vue  # 待处理中心
                └── WeightAlgorithmDialog.vue  # 座位权重算法
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

31 个弹窗。统一标准：`DialogShell`（弹窗外壳）+ `visible`（显隐属性）控制（少数由 `v-if`（条件渲染）挂载，无 `visible`）+ 异步加载（页面用 `v-preload`（悬停预取指令）预取）。

---

## 综合概述

- **定位**：业务弹窗层（`components/dialogs/`），31 个弹窗按记录类、设置与编排类、相册类分组。
- **公共逻辑**：统一用 `DialogShell`（弹窗外壳组件）+ `visible`（显隐属性）控制显隐（少数由 `v-if`（条件渲染指令）挂载），页面用 `v-preload`（悬停预取指令）预取 `chunk`（代码分包）；通用 `props` / `emits`（组件属性 / 事件）见 README。
- **局限**：不展开每个弹窗的字段校验规则（在各自小节），也不展开页面如何调用（见 [views.md](../views.md)）。

---

## 详细说明

### 记录类

#### [AddStudentDialog.vue](../../../../student-frontend/src/components/dialogs/AddStudentDialog.vue) · 添加学生/记录
- **定位**：按表字段动态渲染表单（学生表、班费表共用）。
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `fields`（动态字段）/ `requiredField`（必填字段）/ `title`（标题，默认「添加学生」）/ `initialValues`（初始值）；`emits`（组件事件）：`confirm`（确认）/ `cancel`（取消）。
- **内部实现**：按 `fields`（字段列表）生成输入项与必填校验；提交前 `trim`（去掉首尾空格）；`initialValues`（初始值）支持编辑态回填。
- **使用方**：`ClassroomView`、`FeeManagement`。

#### [AddActivityDialog.vue](../../../../student-frontend/src/components/dialogs/AddActivityDialog.vue) · 新增/编辑活动
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `editingRecord`（编辑中的记录，新增时为空）；`emits`（组件事件）：`confirm`（确认新增）/ `update`（保存编辑）/ `delete`（删除）/ `cancel`（取消）。
- **使用方**：`ActivitiesView`。

#### [AddCountdownDialog.vue](../../../../student-frontend/src/components/dialogs/AddCountdownDialog.vue) · 新增/编辑倒计时
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `editingRecord`（编辑中的记录，新增时为空）；`emits`（组件事件）：`confirm`（确认新增）/ `update`（保存编辑）/ `delete`（删除）/ `cancel`（取消）。
- **使用方**：`ActivitiesView`（倒计时 Tab）。

#### [AddLeaveDialog.vue](../../../../student-frontend/src/components/dialogs/AddLeaveDialog.vue) · 新增/编辑请假
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `students`（学生名单）/ `typeOptions`（请假类型选项）/ `editingRecord`（编辑中的记录）；`emits`（组件事件）：`confirm`（确认）/ `update`（保存编辑）/ `delete`（删除）/ `cancel`（取消）/ `ask-save-phones`（询问是否把联系电话存入学生档案）。
- **内部实现**：可联动询问「是否把联系电话保存到学生档案」（`ask-save-phones`）。
- **使用方**：`LeaveManagement`。

#### [AddScoreDialog.vue](../../../../student-frontend/src/components/dialogs/AddScoreDialog.vue) · 新增/编辑加减分
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `students`（学生名单）/ `mode`（加减分对象：`personal`（个人）/ `group`（小组））/ `editingRecord`（编辑中的记录）；`emits`（组件事件）：`confirm`（确认）/ `update`（保存编辑）/ `delete`（删除）/ `cancel`（取消）。
- **使用方**：`ScoreManagement`。

#### [AddModelDialog.vue](../../../../student-frontend/src/components/dialogs/AddModelDialog.vue) · 添加 AI 模型
- **对外接口**：`props`（组件属性）：`show`（是否显示）；`emits`（组件事件）：`close`（关闭）/ `saved`（已保存）。
- **内部实现**：模型识别输入/选择，保存后通知 `AiSettingsDialog`。
- **使用方**：`AiSettingsDialog`。

### 设置与编排类

#### [AiSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/AiSettingsDialog.vue) · AI 设置
- **对外接口**：`props`（组件属性）：`show`（是否显示）；`emits`（组件事件）：`close`（关闭）/ `saved`（已保存）。
- **内部实现**：启用开关、模型列表（增/选/删/测连通）、打开 `AddModelDialog`。
- **使用方**：`AiAssistant`。

#### [ClassInfoDialog.vue](../../../../student-frontend/src/components/dialogs/ClassInfoDialog.vue) · 班级信息
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `classData`（班级信息对象）；`emits`（组件事件）：`confirm`（确认保存）/ `cancel`（取消）。
- **使用方**：`DashboardView`。

#### [DeduplicateDialog.vue](../../../../student-frontend/src/components/dialogs/DeduplicateDialog.vue) · 去重
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `rows`（行数据）/ `fields`（字段定义）；`emits`（组件事件）：`delete-rows`（删除选中的重复行）/ `cancel`（取消）。
- **内部实现**：按字段组合展示重复行，勾选保留项后批量删除。
- **使用方**：`ClassroomView`、`FeeManagement`。

#### [SeatSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SeatSettingsDialog.vue) · 座位设置
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `rows`（行数，必填）/ `cols`（列数，必填）/ `mode`（记录模式）/ `showAisle`（是否显示走廊列）；`emits`（组件事件）：`save`（保存）/ `cancel`（取消）。
- **使用方**：`SeatView`。

#### [SeatRecordSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SeatRecordSettingsDialog.vue) · 座位记录设置
- **对外接口**：`props`（组件属性）：`visible`（显隐）、`zIndex`（层级，默认 10004；从账号数据管理打开时传更高值）；`emits`（组件事件）：`close`（关闭）。
- **内部实现**：座位历史记录的保留/展示设置（写 `seat_settings`）。
- **使用方**：`SeatView`（记录/历史入口）。

#### [SnapshotPickerDialog.vue](../../../../student-frontend/src/components/dialogs/SnapshotPickerDialog.vue) · 查看快照选择
- **定位**：账号数据管理点「查看」后单独一层，列座位/值日/课表三项，点选进入对应管理界面。
- **对外接口**：`props`：`visible`、`zIndex`（默认 10014，介于管理弹窗与快照管理弹窗之间）；`emits`：`close`、`pick`（带回域 key）。
- **使用方**：`SettingsView`。

#### [ScheduleRecordDialog.vue](../../../../student-frontend/src/components/dialogs/ScheduleRecordDialog.vue) · 课表记录管理
- **定位**：课表历史快照的列周 + 删除。课表历史入口原本内联在 `ScheduleView`，这里补一个独立弹窗供「账号数据管理 → 查看（课表快照）」直达。
- **对外接口**：`props`：`visible`、`zIndex`（默认 10014，兼容嵌套层级）；`emits`：`close`、`changed`。
- **内部实现**：`GET /api/schedule/history` 拉周列表，`DELETE /api/schedule/history/:week` 删除（二次确认）。
- **使用方**：`SettingsView`。

#### [SeatBackfillDialog.vue](../../../../student-frontend/src/components/dialogs/SeatBackfillDialog.vue) · 座位回填
- **对外接口**：`props`（组件属性）：`visible`（显隐）；`emits`（组件事件）：`close`（关闭）/ `changed`（数据已变更）。
- **内部实现**：把某周快照回填到当前表，完成后通知页面刷新。
- **使用方**：`SeatView`。

#### [WeightAlgorithmDialog.vue](../../../../student-frontend/src/components/dialogs/WeightAlgorithmDialog.vue) · 座位权重算法
- **对外接口**：`props`（组件属性）：`rows`（行数，默认 6）/ `cols`（列数，默认 7）；`emits`（组件事件）：`close`（关闭）/ `apply`（应用权重）。
- **内部实现**：编辑每个座位的权重（近视/身高/注意力等维度），应用后写权重表。
- **使用方**：`SeatView` / `SmartArrangementDialog`。

#### [DutySettingsDialog.vue](../../../../student-frontend/src/components/dialogs/DutySettingsDialog.vue) · 值日设置
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `days`（值日天数与结构）/ `items`（值日条目）/ `studentCount`（班级学生数，用于保存时判断人数是否够排）；`emits`（组件事件）：`save`（保存）/ `cancel`（取消）。
- **内部实现**：保存前若「天数 × 每班人数」小于学生数，先弹人数不足确认。
- **使用方**：`DutyView`。

#### [DutyRecordSettingsDialog.vue](../../../../student-frontend/src/components/dialogs/DutyRecordSettingsDialog.vue) · 值日记录设置
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `mode`（值日模式，默认 `daily`（日常））/ `zIndex`（层级，默认 10004；从账号数据管理打开时传更高值）；`emits`（组件事件）：`close`（关闭）。
- **使用方**：`DutyView`（记录/历史入口）。

#### [DutyBackfillDialog.vue](../../../../student-frontend/src/components/dialogs/DutyBackfillDialog.vue) · 值日回填
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `mode`（值日模式，默认 `daily`（日常））；`emits`（组件事件）：`close`（关闭）/ `changed`（数据已变更）。
- **使用方**：`DutyView`。

#### [DutyWeightAlgorithmDialog.vue](../../../../student-frontend/src/components/dialogs/DutyWeightAlgorithmDialog.vue) · 值日权重算法
- **对外接口**：`props`（组件属性）：`days`（值日天数与结构）/ `items`（值日条目）/ `dimension`（权重维度，`1d` 按项目 / `2d` 项目 × 星期，默认 `1d`）；`emits`（组件事件）：`cancel`（取消）/ `apply`（应用权重）。
- **内部实现**：一维只按项目轴生成权重并平铺到所有天；二维按项目 × 星期生成梯度矩阵，应用后供智能编排使用。
- **使用方**：`DutyView` / `DutyArrangementDialog`。

#### [SettingsDialog.vue](../../../../student-frontend/src/components/dialogs/SettingsDialog.vue) · 课程表设置
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `settings`（课程表设置）/ `semesterStart`（学期开始日）/ `showSemesterStart`（是否显示学期开始日）；`emits`（组件事件）：`save`（保存）/ `cancel`（取消）/ `update:semesterStart`（学期开始日更新）。
- **使用方**：`ScheduleView`。

#### [DutyArrangementDialog/DutyArrangementDialog.vue](../../../../student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.vue) · 值日编排
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `days`（值日天数与结构）/ `items`（值日条目）/ `students`（学生名单）/ `weights`（权重，默认空对象）/ `ledger`（已排记录，默认空对象）/ `draft`（草稿，默认 `{exists:false}`（不存在））/ `baseCells`（当前值日表，作为流水线起点）/ `seat`（当前座位表快照，用于抽取同桌/六位/一列等学生分组）；`emits`（组件事件）：`cancel`（取消）/ `confirm`（确认）/ `save-draft`（保存草稿）/ `clear-draft`（清除草稿）/ `open-settings`（人数不足时打开值日设置）。
- **内部实现**：一级条件列表（随机/分组/特殊关系/特殊劳动/辛苦度公平），条件可重复、按顺序执行；从当前值日表起步，结果只预览，确认后写回；总槽位小于学生数时先弹确认。
- **使用方**：`DutyView`（`v-if` 挂载，`visible` 控制显隐）。

#### [SmartArrangementDialog/SmartArrangementDialog.vue](../../../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.vue) · 智能排表
- **对外接口**：`props`（组件属性）：`rows`（行数，默认 6）/ `cols`（列数，默认 7）/ `mode`（排表模式，默认 `single`（单人单桌））/ `showAisle`（是否显示走廊，默认 `true`）/ `students`（学生名单）/ `initialSeats`（初始座位）/ `weights`（权重）/ `ledger`（已排记录，默认空对象）；`emits`（组件事件）：`cancel`（取消）/ `confirm`（确认）。
- **内部实现**：排表方式树 + 条件 + `GridView` 预览 + 新成员确认（`NewComerConfirm`）；算法在 `SmartArrangementDialog.*.js`（pipeline/blocks/options）。
- **使用方**：`SeatView`。

#### [SmartGroupDialog/SmartGroupDialog.vue](../../../../student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.vue) · 智能分组
- **对外接口**：`props`（组件属性）：`students`（学生名单）/ `groups`（小组列表）/ `leaderTitle`（组长称谓，默认「组长」）；`emits`（组件事件）：`cancel`（取消）/ `confirm`（确认）。
- **使用方**：`GroupManageView`。

#### [NewComerConfirm.vue](../../../../student-frontend/src/components/dialogs/NewComerConfirm.vue) · 新成员参与确认
- **对外接口**：`props`（组件属性）：`names`（新成员姓名）/ `action`（操作名称，默认「排表」）；`emits`（组件事件）：`participate`（参与）/ `not`（不参与）。
- **使用方**：`SmartArrangementDialog`、`SmartGroupDialog`。

#### [RecoveryKeyDialog.vue](../../../../student-frontend/src/components/dialogs/RecoveryKeyDialog.vue) · 恢复词展示与抄写确认
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `phrase`（12 个恢复词）/ `username`（写进 txt 的账号）/ `title` / `description` / `confirmText` / `cancelText`（空串则不显示取消按钮）；`emits`（组件事件）：`confirm`（已下载且抄写正确）/ `cancel`（取消）。
- **内部实现**：展示 12 词 → `下载文本`（`INVOKE.SAVE_FILE`，写盘成功才解锁确认）→ 核对抄写的前 3 词（兼容空格分词 / 带序号 / 连写三种输入）→ 放行；`复制` 走 `INVOKE.COPY_SENSITIVE_TEXT`（写剪贴板并 60 秒后清空）。`visible` 或 `phrase` 变化时重置内部状态，避免上一份的「已下载」串到下一份。
- **使用方**：`Login`（注册超级隐私）、`SettingsView`（切换安全等级 → 超级隐私）。两处共用同一个组件，是为了让「恢复词只此一份」这套强制约束只有一处实现。

#### [LocalRecoverDialog.vue](../../../../student-frontend/src/components/dialogs/LocalRecoverDialog.vue) · 已登录时忘记密码（本机恢复）
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `slug`（当前账号库标识，拼成 `<slug>.db`）/ `username`（当前账号名，后端据此确认恢复的是同一账号）；`emits`（组件事件）：`done`（新密码已生效）/ `close`（取消或关闭）。
- **内部实现**：打开即用当前账号的库文件调 `POST /api/db-recover`，**不列账号列表**（已登录，账号已知）；成功后进「设置新密码」阶段，调 `PUT /api/account/password` 换发常规 token。请求层在 `utils/localRecover.js`，与登录页共用；`watch(visible)` 带 `immediate`（`defineAsyncComponent` 首次挂载时 `visible` 已是 `true`）。
- **使用方**：`SettingsView`（修改密码弹窗 → 忘记密码？）。超级隐私档没有主密钥包裹，本机恢复不适用，入口处直接提示改用恢复词，不打开本弹窗。

### 相册类

#### [AlbumManageDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumManageDialog.vue) · 相册管理
- **对外接口**：`props`（组件属性）：`visible`（显隐）；`emits`（组件事件）：`close`（关闭）/ `changed`（数据已变更）。
- **内部实现**：添加相册文件夹（系统选目录）、拖拽排序、删除（仅删索引，可撤销）、打开文件夹；虚拟相册显示「虚拟」角标。
- **使用方**：`AlbumView`。

#### [NewAlbumDialog.vue](../../../../student-frontend/src/components/dialogs/NewAlbumDialog.vue) · 新建相册
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `albums`（相册列表）；`emits`（组件事件）：`close`（关闭）/ `created`（已创建，带新相册 id）。
- **内部实现**：`ViewSwitch` 切「文件夹 / 其他相册」；文件夹来源递归扫描；其他相册来源打开 `AlbumPhotoPickerDialog` 选照片生成虚拟相册。
- **使用方**：`AlbumView`。

#### [AlbumPhotoPickerDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumPhotoPickerDialog.vue) · 选照片
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `albumId`（目标相册 id）/ `albumName`（目标相册名称）/ `initialIds`（初始选中的照片 id）；`emits`（组件事件）：`close`（关闭）/ `confirm`（确认，带所选照片 `photos`）。
- **内部实现**：按日期分组的时间轴网格（与相册页共用 `usePhotoTimeline`），单选框 + 全选/取消。
- **使用方**：`NewAlbumDialog`。

#### [AlbumTaskDialog.vue](../../../../student-frontend/src/components/dialogs/AlbumTaskDialog.vue) · 扫描任务管理
- **对外接口**：`props`（组件属性）：`visible`（显隐）；`emits`（组件事件）：`close`（关闭）/ `changed`（数据已变更）。
- **内部实现**：每册一行（增量/全量/停止/暂停继续），首行「更新所有相册」串行排队；800ms 轮询 `GET /api/album/tasks`。
- **使用方**：`AlbumView`。

#### [MoveAlbumDialog.vue](../../../../student-frontend/src/components/dialogs/MoveAlbumDialog.vue) · 移动照片到相册
- **对外接口**：`props`（组件属性）：`visible`（显隐）/ `albums`（相册列表）/ `currentAlbumId`（当前相册 id）/ `photoIds`（待移动的照片 id）；`emits`（组件事件）：`close`（关闭）/ `moved`（已移动）。
- **内部实现**：只列虚拟相册（排除当前）；成功后登记 `album_photo_move` 撤销记录。
- **使用方**：`AlbumView`（时间轴多选后打开）。

#### [OverdueLeaveDialog.vue](../../../../student-frontend/src/components/dialogs/OverdueLeaveDialog.vue) · 逾期未销假
- **对外接口**：`props`（组件属性）：`records`（逾期请假记录）；`emits`（组件事件）：`not`（保持逾期，暂不销假）/ `ret`（销假）。
- **使用方**：`LeaveManagement`。

#### [ReceiptDialog.vue](../../../../student-frontend/src/components/dialogs/ReceiptDialog.vue) · 管理收据
- **定位**：班费收据的上传、列表、预览、下载与删除（一个弹窗覆盖全流程）。
- **对外接口**：`props`（组件属性）：`visible`（显隐，默认 `false`）/ `receipts`（已归一化数组 `[{ path, name, size, kind }]`，默认空数组）/ `apiBase`（接口前缀，默认 `/api`）；`emits`（组件事件）：`update:visible`（显隐双向绑定）、`change`（文件列表已变更，回写父级）。
- **内部实现**：支持多选与拖入（虚线框与「从文件导入数据」同款 `.dropzone`）；上传按 `ACCEPT`（与后端 `services/uploadSignatures.js` 的 `KINDS` 一致）校验，逐项上报进度；图片 / 视频走 [`MediaViewer`](./base.md)，PDF / Markdown 走文档灯箱；下载走安全通道换 Blob。
- **注意点**：`kind` 必须是归一后的 `office`（后端按魔数分出 `ooxml` / `ole`，见 4-1）；`viewMode` 同时兼容旧值，否则历史 Office 收据点开没反应。
- **使用方**：`FeeManagement`（懒加载）。

#### [AccountDataDialog.vue](../../../../student-frontend/src/components/dialogs/AccountDataDialog.vue) · 账号数据管理
- **定位**：从系统设置「空间管理 → 管理」打开，管理 AI 聊天记录、历史快照、相册回收站、收据回收站的占用、保留偏好与清除。
- **对外接口**：`props`：`visible`；`emits`：`update:visible`、`view`（打开聊天记录）、`viewSnapshots`（打开快照选择层）、`changed`（清除后通知父级重新统计）。
- **铁律**：默认「永久保存」，程序不自动删数据；档位先进 `draft`，点「确定」才提交，若有数据超期先提示再确认；`删除全部` 立即清空且必须二次确认。回收站清空后，对应删除记录不能再撤销还原。
- **使用方**：`SettingsView`。

#### [SnapshotPickerDialog.vue](../../../../student-frontend/src/components/dialogs/SnapshotPickerDialog.vue) · 查看快照
- **定位**：账号数据管理「历史快照 → 查看」打开的选择层，列出座位 / 值日 / 课表三个入口。
- **对外接口**：`props`：`visible`、`zIndex`；`emits`：`close`、`pick`（域 key，交给宿主打开对应快照管理弹窗）。
- **使用方**：`SettingsView`。

#### [DuplicateNameDialog.vue](../../../../student-frontend/src/components/dialogs/DuplicateNameDialog.vue) · 导入同名选人
- **定位**：Excel 导入前发现某姓名在名册里有 ≥2 位正式学生时弹出；每组同名一行一个下拉，默认选中第一位，另有「这是一位新同学」。
- **对外接口**：`props`：`visible`、`name`、`rows`（`[{ key, label, options: [{ value, label }] }]`，value 为 `id:<学生id>` 或 `new`）；`emits`：`confirm`（`{ 行号: 'id:n'|'new' }`）、`cancel`。
- **使用方**：`ImportExcel`（仅传了 `students` 的学生类导入；成绩、请假）。

### [AddClassDialog.vue](../../../../student-frontend/src/components/dialogs/AddClassDialog.vue) · 新增班级
- **定位**：从「班级信息设置」再开一层的二级弹窗，层级比 `ClassInfoDialog` 高一级。
- **内部实现**：`Esc` 由 `DialogShell` 的层级栈判断，只让最上层响应。

### [AiPrivacyDialog.vue](../../../../student-frontend/src/components/dialogs/AiPrivacyDialog.vue) · AI 数据保护弹窗
- **定位**：AI 助手页标题栏「数据保护」按钮的落地层，只做外壳与滚动区。
- **内部实现**：开关与文案全在 `AiPrivacyPanel`，逻辑不重复一份。

### [CreateTokenDialog.vue](../../../../student-frontend/src/components/dialogs/CreateTokenDialog.vue) · 令牌选项
- **定位**：新建 MCP 令牌前的选项弹窗。
- **内部实现**：busy 期间只允许单次提交，防重复创建。

### [ProvisionalStudentsDialog.vue](../../../../student-frontend/src/components/dialogs/ProvisionalStudentsDialog.vue) · 临时学生
- **定位**：值日、座位、分组、加分里直接填名字时自动建的档，在这里统一转正。
- **内部实现**：学生管理工具栏的独立入口，列表来自 `GET /api/students/provisional`。

### [TodoCenterDialog.vue](../../../../student-frontend/src/components/dialogs/TodoCenterDialog.vue) · 待处理中心
- **定位**：标题栏待办胶囊点开后的通知中心，汇总销假与临时学生两类待办。
- **内部实现**：数据来自 `useTodoCenter`，点条目跳转到对应页面处理。

---

## 注意事项

- **两种挂载方式不要混**：有 `visible`（显隐属性）的走属性控制，`v-if`（条件渲染指令）挂载的不要改成 `visible`，预取时机与卸载行为都会变。
- **新增 / 编辑复用一份**：同一弹窗用 `mode`（新增 / 编辑模式）+ `initialValues`（初始值）区分，不要复制第二个组件。
- **写库与撤销归父级**：弹窗只发 `save`（保存）/ `confirm`（确认）事件，撤销登记由页面或组合式函数负责（见 [composables.md](../composables.md)）。
- **保持懒加载**：弹窗按 `chunk`（代码分包）懒加载、页面按钮用 `v-preload`（悬停预取指令）预取，不要在首屏静态 `import`（导入语句）。

---
