# 组合式函数（`src/composables/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    └── src/
        ├── composables/
        │   ├── ai/
        │   │   ├── aiChat.js  # SSE 流式对话与中断控制（fetch + AbortController）
        │   │   ├── aiConstants.js  # 前端 AI 常量：权限键与模式（AI_PERMISSION_KEY / AI_PERMISS…
        │   │   ├── aiConversations.js  # 会话/消息 CRUD 与加载更多
        │   │   ├── aiExec.js  # 提案执行：确认后调用既有 CRUD、登记撤销、回填消息
        │   │   ├── aiFiles.js  # 附件上传与文件列表管理
        │   │   ├── aiMarkdown.js  # Markdown 渲染：懒加载 marked + dompurify，模块级单例
        │   │   └── aiMessages.js  # 消息解析与展示辅助：parseMessages、lastAssistant、buildPro…
        │   ├── exportFormats.js  # 导出格式实现
        │   ├── secureAxios.js  # axios 加解密装配
        │   ├── secureChannel.js  # 加密原语
        │   ├── secureRetry.js  # 安全信道 401 重试判定
        │   ├── tableDragFx.js  # 拖拽让位算法
        │   ├── useAlbumScan.js  # 扫描轮询
        │   ├── useAlbumTaskResume.js  # 断点续扫
        │   ├── useCardHeightAnimation.js  # 卡片高度过渡
        │   ├── useDashboardData.js  # 首页聚合
        │   ├── useElasticScroll.js  # 橡皮筋滚动
        │   ├── useNotification.js  # 全局通知
        │   ├── usePhotoTimeline.js  # 时间轴虚拟滚动
        │   ├── useRowFocus.js  # 跨页行定位
        │   ├── useRowSortDrag.js  # 行排序拖拽
        │   ├── useSeatDraft.js  # 座位草稿
        │   ├── useSeatGrid.geometry.js  # 座位网格几何（纯函数）
        │   ├── useSeatGrid.js  # 座位/网格
        │   ├── useSyncStudentNames.js  # 人名自动补建
        │   ├── useTableCRUD.js  # 动态列 CRUD（增删改查）
        │   ├── useThumbBatch.js  # 缩略图批量预取
        │   ├── useUndo.js  # 撤销/重做
        │   └── useWeekDates.js  # 今天的响应式日期
        └── utils/
            ├── httpClient.js
            └── latestOnly.js
```
<!-- doc-tree:end -->

29 个文件：根目录 22 个 + `ai/` 子目录 7 个。条目统一：签名 / 返回字段 / 内部时序与副作用 / 调用方 / 注意事项。这里说的「组合式函数」就是 `composable`（以 `useXxx` 命名、可复用的状态与逻辑）。

---

## 综合概述

- **定位**：前端组合式函数层（`src/composables/`），封装表格、网格、相册、数据请求与 AI 对话的复用逻辑。
- **公共逻辑**：页面只负责组装与渲染，状态与写操作走 `useXxx`（以 `use` 开头的组合式函数）；写操作按表格 / 网格登记撤销；AI 状态与流式解析集中在 `composables/ai/`（AI 专用组合式函数目录）。
- **局限**：不渲染 UI、不定义路由与后端接口；页面职责见 [views.md](./views.md)，接口标准见 [backend/routes.md](../backend/routes.md)。

---

## 详细说明

### 表格与网格

#### [`useTableCRUD.js`](../../../student-frontend/src/composables/useTableCRUD.js) · 动态列 CRUD（增删改查）
- **签名**：`useTableCRUD(apiBase, defaultFields, options)`（表格增删改查组合式函数；`apiBase`（接口基址）、`defaultFields`（默认字段）、`options`（选项））；`options = { requiredField, protectedColumns, enableRenameColumn, customValidate, undoTableKey }`（必填字段 / 受保护列 / 是否允许重命名列 / 自定义校验 / 撤销表键）。
- 返回（关键）：`rows / fields / newRow / editingCell / loadError / contextMenu / dialog / columnForm / sortField / sortOrder / searchField / searchKeyword / searchKeywordDebounced / searchNoResult / selectedCount / selectedRowKeys / clipboard / displayRows / displayIndexes / visibleFields / allBusinessFields / importDialogVisible / dedupeDialogVisible / fetchRows`，以及 `startEditCell / saveCell / addNewRowAtBottom / insertRowAbove / insertRowBelow / saveNewRow / cancelNewRow / moveRow / deleteRow / deleteColumn / addColumn / renameColumn / moveColumn / importRows / dedupe / toggleSort / setSearch / applyUndoChange / showAlert / showConfirm / onDialogConfirm` 等。
- **内部时序**：所有写操作先记 `rowsSnapshot`（行快照）→ 调接口 → 成功后就地更新 → `recordCellUndo` / `recordRow*` 登记 `/api/undo`；搜索用 `debounce`（防抖，停止输入一段后才执行）；`perfMark`（性能打点）记录耗时。
- **接口**：`GET`（查询）/`POST`（新增）`{apiBase}`、`PUT`（整体更新）/`DELETE`（删除）`{apiBase}/:id`、`POST /batch-delete`（批量删除，一次请求）、`POST /add-column`、`/rename-column`、`/move-row`、`/move-column`、`/reorder`、`/import`、`DELETE /columns/:name`。
- **调用方**：`ClassroomView`（学生页）、`FeeManagement`（班费页）。
- **注意事项**：列名走后端正则白名单；`protectedColumns`（受保护列，学生表 `学号/姓名`）不可删改。

#### [`useSeatGrid.js`](../../../student-frontend/src/composables/useSeatGrid.js) · 座位/网格
- **签名**：`useSeatGrid(apiBase, options)`；`options = { getStudentName, getStudentId, undo({ key, table }), cellBase }`。
- **导出**：`useSeatGrid(apiBase, options)`；几何纯函数全部来自 `useSeatGrid.geometry.js` 并由本文件 `export *` 转发（`SeatView` / `AiGridPreview` / `useSeatDraft` 仍从这里取），不在此处另行维护。
- **内部时序**：整表保存 `PUT {apiBase}`（整体更新，提交 rows/cols/seats/mode/showAisle/types）；单格 `PATCH {apiBase}/master/cell`（局部更新）；开启撤销时写前 `recordGridSnapshotUndo`（记录网格快照）；走廊是 `types` 里的真实行/列，不再由 `showAisle` 在渲染期插虚拟列。
- **调用方**：`SeatView`。

#### [`useSeatGrid.geometry.js`](../../../student-frontend/src/composables/useSeatGrid.geometry.js) · 座位网格几何（纯函数）
- **定位**：座位网格的全部纯计算。单独成文件是为了能在 node 下单测（`seat-geometry` / `seat-aisle-row` / `seat-hole-paint` 等），避免一 import 就把 axios 与路径别名带进单测环境。
- **导出**：`CELL`（`SEAT=0` / `AISLE=1` / `BLANK=2`）、`SEAT_MAX_ROWS` / `SEAT_MAX_GRID_COLS`（与后端 `services/sanitize.js` 同值）、`normalizeTypes`、`columnKinds` / `columnLabels` / `seatColumnIndices` / `rowIsAisle`、`generateColHeaders` / `buildSeatLikeRows` / `applyEditedRows` / `reshapeGeometry`、`usableSeatCount` / `toggleHole` / `clearHoles`、`insertAisleRow` / `removeGridRow` / `insertAisleColumn` / `removeGridColumn`。
- **数据模型**：`seats` 与 `types` 同下标 `rows×cols`；`cols` 是**网格总列数**（含走廊列），不是座位列数。旧的 `getDisplayColCount` / `isAisleCol` / `displayColOfReal` 一套「显示列 ↔ 真实列」换算已随模型整体删除，需要座位列序号时用 `seatColumnIndices()` 现算。
- **注意事项**：上限常量与后端必须成对修改；真正的形状权威在后端，这里只做「别让用户白操作一次」的前置拦截。

#### [`useWeekDates.js`](../../../student-frontend/src/composables/useWeekDates.js) · 今天的响应式日期
- **导出**：`useWeekDates()` → `{ today, monday, todayName }`（今天的本地日期串 / 所在自然周周一 / 今天星期名）。
- **内部时序**：`today` 每分钟刷新一次（跨零点自动翻页），定时器经 `utils/disposables.js` 就地登记、随作用域释放；换算函数来自 `utils/weekDates.js`。
- **调用方**：课表页与值日页（列头日期副行、今天列高亮）。

#### [`useSeatDraft.js`](../../../student-frontend/src/composables/useSeatDraft.js) · 座位草稿
- **签名**：`useSeatDraft(...)`；负责智能排表/回填的草稿暂存与恢复（与弹窗 `draft` 参数配合）。
- **调用方**：`SeatView`、`SmartArrangementDialog`。

#### [`useRowSortDrag.js`](../../../student-frontend/src/composables/useRowSortDrag.js) · 行排序拖拽
- 内部：行拖拽的让位/落点计算与 `FLIP`（先记录首尾位置、再反向补偿的动画技法），表格与分组共用。
- **调用方**：`useTableCRUD`、`GroupManageView`。
- **注意事项**：让位链路上不能用视觉位置判定；落位行不能用 `el.animate()`；带让位动画的拖拽不能用原生 HTML5 dnd。

#### [`useRowFocus.js`](../../../student-frontend/src/composables/useRowFocus.js) · 跨页行定位
- **导出**：`flashRowById(container, id)`（滚动并闪烁高亮）、`focusRowWhenReady(containerGetter, id, { tries = 25, interval = 80 })`（页面未就绪时重试）、`applyRouteRowFocus(host, options)`（按路由 query 里的 `focus` 定位，内部重试直到命中/超时）。
- **调用方**：`ScheduleView.common.js`（以及同样接受 `?focus=` 的表格页），配合 `AiChatMessages` 的 `goto`。
- **注意事项**：`parse` 依赖的页签/数据未就绪时会重试，不要在调用点再包一层定时器。

#### [`useSeatDraft.js`](../../../student-frontend/src/composables/useSeatDraft.js) · 座位排表草稿
- **导出**：`useSeatDraft()` → `{ draft, fetchDraft, saveDraft, clearDraft }`。
- **调用方**：`SeatView` / `SmartArrangementDialog`（排表草稿的读取、保存与清除）。

#### [`useRowSortDrag.js`](../../../student-frontend/src/composables/useRowSortDrag.js) · 行排序拖拽
- **签名**：`useRowSortDrag({ items, dragIdx, overIdx, attr, rowClass, onMoved })` → `{ handleDown, clear, onScroll, enterAt, leaveAt }`。
- 内部：行拖拽的让位/落点计算与滚动处理，`onMoved` 在落位后回调。
- **调用方**：分组管理、需要行排序的列表。
- **注意事项**：让位链路上不能用视觉位置判定；落位行不能用 `el.animate()`；带让位动画的拖拽不能用原生 HTML5 dnd。

#### [`tableDragFx.js`](../../../student-frontend/src/composables/tableDragFx.js) · 拖拽让位算法
- **导出**：`clearShift(root)`、`computeRowReorder(geom, from, to)`、`applyRowShift(rows, from, to, geom, fallback, counterOf)`、`computeColReorder(geom, from, to)`、`applyColShift(colEls, from, to, geom, fallback, counterOf)`、`applyRowTops(rows, targetTops, geom, counterOf, skipIdx)`。
- **调用方**：`DynamicTable`、`GridView` 的拖拽逻辑。
- **备注**：纯计算函数，便于单测；位移量由被拖行自身高度决定。

#### [`useSyncStudentNames.js`](../../../student-frontend/src/composables/useSyncStudentNames.js) · 人名自动补建
- **导出**：`extractNamesFromRows(rows)`、`syncStudentNames(namesArr, scope)`、`syncStudentNamesFromRows(rows, scope)`。
- **调用方**：`DutyView`、`SeatView`（把网格里输入的新姓名同步进学生名册）。
- **备注**：名册外姓名由后端 `ensureProvisionalStudent` 建「临时学生」，不是直接拒绝。

### 相册

#### [`usePhotoTimeline.js`](../../../student-frontend/src/composables/usePhotoTimeline.js) · 时间轴虚拟滚动
- **签名**：`usePhotoTimeline(groupsRef, options)` → `{ containerRef, scrollTop, clientH, viewW, cols, cell, cellStyle, layout, totalH, visibleGroups, measure, onScroll, onResize, reset }`。
- 内部：按日期分组为窗口单元；按目标格宽 200px 反推列数（3~12）；只挂载视口附近分组（900px 缓冲），外部用总高度撑滚动条。
- **调用方**：`AlbumView`、`AlbumPhotoPickerDialog`。

#### [`useThumbBatch.js`](../../../student-frontend/src/composables/useThumbBatch.js) · 缩略图批量预取
- **签名**：`useThumbBatch(getVisibleIds, opts)` → `{ thumbUrlFor(photoId), refresh, clear }`。
- 内部：可视区 id 变化后 120ms 防抖，一次批量请求 `POST /api/album/photo/thumbs`（上限 200），解析二进制流为 objectURL；滚出视口裁剪释放、卸载全清；批量没拿到的回落单张 `/thumb`。
- **调用方**：`AlbumView`、`AlbumPhotoPickerDialog`。
- **注意事项**：objectURL 必须 revoke；批量响应是「4 字节长度 + JPEG」逐张拼接。

#### [`useAlbumScan.js`](../../../student-frontend/src/composables/useAlbumScan.js) · 扫描轮询
- **签名**：`useAlbumScan()` → `{ waitScan(id, { onProgress, onTick }), stopAll }`。
- 内部：`POST /:id/rescan` 立即返回，前端按 800ms 轮询 `/status` 直到 `scanning=false`；定时器集中登记，卸载 `stopAll`。
- **调用方**：`AlbumView`（刷新、撤销重做后渐进刷新）。`AlbumTaskDialog` 不走它，直接轮询 `/api/album/tasks`。

#### [`useAlbumTaskResume.js`](../../../student-frontend/src/composables/useAlbumTaskResume.js) · 断点续扫
- **签名**：`useAlbumTaskResume()` → `{ schedule, cancel, checkAndResume, resumed, hasPending, pendingCount }`。
- 时序：占位页移除 → 小组件就绪 → **延迟 4 秒** → `GET /tasks/pending` → 通知条 → `POST /tasks/resume`；未登录不做任何事；查询失败静默。
- **调用方**：`App.vue`（`reportWidgetsOnce` 内 `schedule()`）。

### 数据与网络

#### [`useDashboardData.js`](../../../student-frontend/src/composables/useDashboardData.js) · 首页聚合
- **签名**：`ensureDashboardData(force)`；单次 `/api/dashboard` 聚合请求 + 模块级缓存 + pending 共享。
- **数据形状（v6 · 2-1）**：`{ schedule, duty, countdowns, leaves, students:[{id,姓名}], activities, album, summary }`；`summary` 含 `studentCount / scoreCount / feeCount / topScores / feeBalance / monthIncome / monthExpense`。缺 `summary` 时按空班兜底（显示 0，不崩）。
- **调用方**：`router/index.js`（进首页前）、`DashboardView`。

#### [`useUndo.js`](../../../student-frontend/src/composables/useUndo.js) · 撤销/重做
- **导出**：`warnUndoFailed(label)`、`cellText(v)`、`newUndoBatchId()`、`flushUndoStatus()`，以及 `recordCellUndo / recordGridCellUndo / recordGridSnapshotUndo / recordRowInsert / recordRowDelete / recordRowUpdate / useUndoShortcut`。
- 内部：记录持久化到 `/api/undo`；快捷键 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`；`onActivated/onDeactivated` 维护 KeepAlive 下当前页。
- **批次**：一次动作登记多条时（一次改动多格）由 `newUndoBatchId()` 生成同一个 `origin` 传入 `recordGridCellUndo` 的第 8 个参数，后端按 `origin` 整批回退/重做；只改一处不要加批次，保持单条增量语义。带 `origin` 的记录**不逐条刷状态**（否则一次粘贴上百格就是上百次 `/status`），由调用方在循环结束后调 `flushUndoStatus()` 统一刷一次。
- **调用方**：`useSeatGrid`、`useTableCRUD`、`DutyView`、`AlbumView`、`GroupManageView`、`ActivitiesView` 等。

#### [`useNotification.js`](../../../student-frontend/src/composables/useNotification.js) · 全局通知
- **签名**：`useNotification()` → `{ notifications, show, remove, success, error, warning, info, undoable }`；`undoable(message, onUndo, duration = 8000)` 是带「撤销」按钮的提示。
- 内部：全局 `reactive` 列表；`localStorage.mergeNotifications` 控制同文案合并。
- **调用方**：几乎所有视图与弹窗、`NotificationToast`。

#### [`secureChannel.js`](../../../student-frontend/src/composables/secureChannel.js) · 加密原语
- **导出**：`safe()`、`markAuthBound()`、`resetAuthBinding()`、`applyAuthHeader(headers, token, { forceToken })`、`encryptBody()`、`decryptBody()`、`clearSession()`。
- **握手传输（v6 · 2-19）**：`requestHandshake(pub)` 有两条路——有 Electron 外壳时走 IPC 通道 `secure-handshake`（主进程用 Node http 直连后端，只转公钥与 `sessionId`，临时私钥/共享密/会话密钥都不出渲染层）；纯浏览器下退回 `app://` 相对路径的裸 `fetch`。两条路返回形状一致（`{ pub, sessionId }`）。
- 内部：ECDH P-256 + HKDF(`campus-secure-v1`) + AES-256-GCM；与后端 `services/secureChannel.js` 参数一一对应。
- **主密钥来源**：`preload.js` 在页面脚本之前发起白名单 IPC `get-master-key`，本模块经 `window.__MASTER_KEY__.get()` 复用同一个在途 `promise`，取不到时回退 `window.electron.invoke`。取回值按 64 位十六进制校验后缓存在模块级 `kMaster`（应用级状态，登出不清）。这把 18~30ms 的跨进程往返从握手关键路径挪到页面解析之前。⚠️ 相位副作用：省下的约 20ms 会让握手那条裸 `fetch` 早于后端 `listen`（监听）发出，撞连接被拒并触发约 210ms 固定退避，故本模块在裸 `fetch` 之前另有 `await waitForBackendReady(1500)`（等待后端就绪），两者必须配套（判据见 `topics/performance.md` 第 7 节）。
- **握手分段打点**：`握手完成 Nms 分段(IPC / keygen / fetch / derive)` 把一次握手拆成主进程往返、密钥生成、网络往返、密钥派生四段，供启动归因区分本机阻塞与后端排队；`waitForBackendReady` 的等待计入 `keygen` 段，不改 `IPC` / `fetch` 口径。

#### [`secureAxios.js`](../../../student-frontend/src/composables/secureAxios.js) · axios 加解密装配
- **签名**：`setupSecureAxios(axios)`。
- 内部：请求拦截加密 JSON 体（FormData/GET 直通）；响应拦截检测 `{ d }` 解密；失败 `clearSession` 后重新握手重试一次；错误响应同样解密。
- **调用方**：`main.js`；其他窗口经 [`utils/httpClient.js`](../../../student-frontend/src/utils/httpClient.js) 转调。

#### [`secureRetry.js`](../../../student-frontend/src/composables/secureRetry.js) · 安全信道 401 重试判定
- **导出**：`decideSecureRetry({ status, headers, data, config })`，返回 `degraded / auth / session / null`。
- **顺序**：凭据降级 > auth-required > 会话过期；顺序不能改（降级时后端也回 401，先判 auth 会误清 token）。
- **调用方**：`secureAxios.js` 的响应错误拦截器；清会话、重新加密、重发等副作用仍留在调用方。
- **测试**：纯函数、零依赖，`testjs/units/secure-retry.test.js` 直接覆盖，不再只靠需要 Vite 的冒烟脚本。

#### [`exportFormats.js`](../../../student-frontend/src/composables/exportFormats.js) · 导出格式实现
- **导出**：`FORMAT_OPTIONS`（html / xlsx / csv / md / txt / json / image / pdf）、`FORMAT_LABELS`、`runTableExport({ format, columns, rows, filename, title })`；负责各格式的实际生成与保存。
- **调用方**：`ExportExcel`、`ExportMarkdownDialog`。
- **注意事项**：PDF 用中文字体动态子集（`utils/pdfFont.js`），失败回退全量字体。

#### [`useElasticScroll.js`](../../../student-frontend/src/composables/useElasticScroll.js) · 橡皮筋滚动
- **导出**：`bindElastic`、`startElasticScroll`；**当前停用**（`main.js` 中调用被注释），保留备查。

#### [`useCardHeightAnimation.js`](../../../student-frontend/src/composables/useCardHeightAnimation.js) · 卡片高度过渡
- **签名**：`useCardHeightAnimation(elRef, options)`；`options = { duration = 260, easing = 'cubic-bezier(0.4, 0, 0.2, 1)' }`（时长 / 缓动）。
- **返回**：无（只挂副作用）。
- **内部时序**：`ResizeObserver` 观察卡片元素 → 回调里用 `lastHeight` 当起点、`offsetHeight` 当终点 → 先把 `style.height` 钉回起点（WAAPI 起始帧要到下一次渲染步骤才生效，不钉会先闪一下新高度）→ `el.animate` 播 `height` → 结束后交还 `auto` 并恢复观察。动画期间 `unobserve` + `overflow: hidden`（前者避免每帧回调，后者防止变矮时旧内容溢出）。
- **调用方**：`ExportExcel`（导出选项弹窗）。
- **注意事项**：用 `ResizeObserver` 而不是让调用方 `watch` 状态，是因为弹窗的高度变化常来自**插槽内容**（勾选开关多出两个输入框），组件内部看不到那些状态。改这里必须跑 `testjs/probe/card-height-anim-probe.cjs`；用 `show: false` 的隐藏窗口测会得到「动画瞬间到终点」的假结论（合成器不跑）。登录页 `Login.vue` 另有一份**状态驱动**的高度动画（`watch` + WAAPI），两者触发源不同，暂未合并。

### AI 组合式（`composables/ai/`）

| 文件 | 定位 / 关键导出 |
| --- | --- |
| [`aiConstants.js`](../../../student-frontend/src/composables/ai/aiConstants.js) | 前端 AI 常量：权限键与模式（`AI_PERMISSION_KEY` / `AI_PERMISSION_FULL`）、联网开关键、表格跳转目标映射 |
| [`aiMessages.js`](../../../student-frontend/src/composables/ai/aiMessages.js) | 消息解析与展示辅助：`parseMessages`、`lastAssistant`、`buildProc`、`isAutoMessage` 等 |
| [`aiChat.js`](../../../student-frontend/src/composables/ai/aiChat.js) | SSE 流式对话与中断控制（`fetch` + `AbortController`） |
| [`aiConversations.js`](../../../student-frontend/src/composables/ai/aiConversations.js) | 会话/消息 CRUD 与加载更多 |
| [`aiExec.js`](../../../student-frontend/src/composables/ai/aiExec.js) | 提案执行：确认后调用既有 CRUD、登记撤销、回填消息 |
| [`aiFiles.js`](../../../student-frontend/src/composables/ai/aiFiles.js) | 附件上传与文件列表管理 |
| [`aiMarkdown.js`](../../../student-frontend/src/composables/ai/aiMarkdown.js) | Markdown 渲染：懒加载 `marked` + `dompurify`，模块级单例 |

---

## 注意事项

- 并发请求统一用 `createLatest`（竞态序号守卫，在 [`utils/latestOnly.js`](../../../student-frontend/src/utils/latestOnly.js)）判断「是否最新」，`await`（等待异步请求返回）后写状态前必须校验，避免旧响应覆盖新状态。**全库只有这一份实现**（原 `composables/useSeq.js` 已于 2026-11-04 合并过来）。
- 写操作登记撤销时，撤销键与对应页面/表格保持一致，否则 `Ctrl+Z`（撤销快捷键）无法回退。
- `composables/ai/`（AI 专用组合式函数目录）只服务 AI 页面与组件，不要在其他页面直接复用其流式状态。

---
