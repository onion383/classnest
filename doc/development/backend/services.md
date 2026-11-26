# 后端公共服务（`student-backend/services/` 等）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
├── student-backend/
│   ├── routes/
│   │   ├── dynamicTable.js
│   │   └── historyRoutes.js  # 历史快照路由工厂
│   ├── services/
│   │   ├── accessLogStore.js  # 数据访问记录的持久层；只在 Store 里写 SQL，写入失败不影响主流程
│   │   ├── accessTimeline.js  # 访问记录弹窗的合并视图：读来自 access_log，已执行的写来自 undo_histor…
│   │   ├── accountRename.js  # 改用户名的跨库两写（带补偿）
│   │   ├── activityStore.js  # activities：列表、删除、导入批量插入
│   │   ├── aiConfigStore.js  # ai_settings / ai_models：开关、启用模型、密钥复用判断、模型 CRUD
│   │   ├── aiConversationStore.js  # ai_conversations / ai_messages：会话与消息分页、标题、摘要、t…
│   │   ├── aiEndpoint.js  # AI 出站地址的唯一校验入口：只放行 http/https、必须有主机名、拒绝云厂商元数据地…
│   │   ├── aiPrivacy.js  # 发给第三方模型前的身份替换：姓名可逆别名、电话可逆令牌、本地路径不可逆归一
│   │   ├── aiReadScope.js  # 按表关闭的读闸门单一作用域：effectiveReadTables() 与 isTableR…
│   │   ├── aiStore.js  # AI 域（routes/ai/）：表结构缓存、引用统计、工具所需的各业务表查询、按表单行 C…
│   │   ├── aiWriteScope.js  # 只读 / 读写档的唯一判定点：合并 readonly_tables 与 closed_tab…
│   │   ├── albumStore.js  # 相册索引 albums / album_photos：列表与封面、照片分页、索引复制与删除、…
│   │   ├── authPolicy.js  # 登录保持天数
│   │   ├── backupArchive.js  # 备份包 v3 写包
│   │   ├── bcryptAsync.js  # 用户名规则
│   │   ├── bundleRestore.js  # 备份包落盘还原
│   │   ├── businessRules.js  # 业务规则校验
│   │   ├── cadreStore.js  # cadres / cadre_members：树形层级、排序、级联删除、按名查重
│   │   ├── countdownStore.js  # countdowns：列表、删除、导入批量插入
│   │   ├── createdRows.js  # 导入结果回读
│   │   ├── importBatch.js  # 批量导入幂等（F07-04）：入参指纹 + import_batches 查/记，同事务
│   │   ├── credentialChange.js  # 凭证变更动作层
│   │   ├── dashboardAgg.js  # 首屏聚合的 SQL 出口：首页只取需要的列/聚合（学生 id + 姓名、班费余额/本月收支/…
│   │   ├── dutyCells.js
│   │   ├── dutyConfig.js  # 值日列名与模式配置
│   │   ├── dutyCycle.js  # 大扫除命中日
│   │   ├── dutyMode.js  # 值日单元格工具
│   │   ├── dutyWrite.js  # 值日域写入的事务唯一出口，供路由、AI 工具与撤销执行器复用
│   │   ├── exportQuery.js  # 导出侧只读查询：单表读取失败返回空结果，不拖垮整份导出
│   │   ├── ffmpeg.js  # 视频处理封装
│   │   ├── groupDim.js  # 分组维度 / 小组 / 成员：CRUD 与复合事务操作（改组数、删维度带快照、移动成员、智能…
│   │   ├── leaveStore.js  # leave_records + 今日到班列顺序：全量与分页列表、学生带出、三态写、导入、列顺…
│   │   ├── loginThrottle.js  # 登录失败节流与 /accounts 频控：同账号 + IP 失败 5 次锁 30 秒、10 …
│   │   ├── mcpProposalExec.js  # 执行已确认的 MCP 提案，复用本地 AI 的写入原语与学生引用保护
│   │   ├── mcpProposalStore.js  # MCP 写提案的持久层，只存意图，SQL 只在这里
│   │   ├── mcpProposalView.js  # 提案的人读视图：把表名 / 操作 / 字段翻成老师能判断的说明
│   │   ├── mcpRateLimit.js  # MCP 工具调用频率闸门：防止跑飞或脚本批量驱动堆满待确认提案
│   │   ├── mcpTokenStore.js  # MCP 访问令牌存储（core/.mcp-tokens.json，应用级配置）
│   │   ├── mcpTools.js  # 暴露给外部客户端的工具实现；写操作只生成提案不落库
│   │   ├── ocr.js  # 文字识别
│   │   ├── pdfDomShim.js  # PDF DOM 兼容层
│   │   ├── pendingRegs.js  # 注册草稿暂存
│   │   ├── perfMem.js  # 导出内存峰值探针（v6 · 0-5）：PERF_EXPORT=1 时 memSnapshot…
│   │   ├── provisionalStudents.js  # 临时学生建档
│   │   ├── receiptTrash.js  # 收据文件移进 dataDir/receipt-trash/。收据扩到视频后，删除只改数据库数…
│   │   ├── recoveryKey.js  # 恢复密钥
│   │   ├── retentionStore.js  # ai_settings.retention_json：四类数据（AI 消息 / 历史快照 /…
│   │   ├── sanitize.js  # 数据清洗
│   │   ├── scoreStore.js  # score_records：全量/分页列表、学生定位、导入、首页摘要
│   │   ├── searchLimits.js  # 全局搜索分页
│   │   ├── searchQuery.js  # 全局搜索的查询实现：各数据源 SQL 与内存 JSON 源、分页、展示文案
│   │   ├── seatGrid.js  # 座位网格几何（后端纯计算）
│   │   ├── seatSnapshot.js  # 座位快照 payload
│   │   ├── seatWrite.js  # 座位单格写入唯一入口
│   │   ├── secureChannel.js  # 安全通道
│   │   ├── semesterStore.js  # semesters：列表、增删改、切换当前；「当前学期」的唯一判定（无标记时回退最新一条）
│   │   ├── sessions.js  # 登录会话
│   │   ├── slotStore.js  # 槽位存储
│   │   ├── studentLookup.js  # 在 students 里认人的单源实现：按 id / 学号 / 姓名带出学生，列清单由调用方…
│   │   ├── studentRelations.js  # 学生引用维护
│   │   ├── studentCascadeDelete.js  # 级联删除+撤销同事务（v8 Q2-01）：登记失败连数据一起回滚
│   │   ├── errorResponse.js  # 全局 Express 错误处理（N3-09）：4xx 原文 / 5xx 脱敏，从 app.js 抽出供行为测试真跑
│   │   ├── studentRename.js  # 学生改名级联
│   │   ├── tableService.js  # 表格服务
│   │   ├── thumbPurge.js  # 清理缩略图文件（只删文件，不碰索引；逐文件容错，回报删除数与字节数）
│   │   ├── thumbSweep.js  # 按库对账回收孤儿缩略图（默认只读，apply=true 才删；库打不开则整目录跳过）
│   │   ├── tmpSweep.js  # 启动期回收崩溃遗留临时文件：AI 附件 / 还原上传 / 解包目录 / OCR 中转四处，只…
│   │   ├── undoStore.js  # undo_history + 撤销执行器：记录入栈与每 key 淘汰、方向 CAS、按批次取…
│   │   ├── unzipSafe.js  # 安全解压
│   │   ├── uploadSignatures.js  # 收据上传的类型判定：扩展名白名单（图片 20MB / PDF 30MB / ooxml 30…
│   │   ├── usernameRules.js
│   │   ├── userStore.js  # users：登录取凭据、改用户名、改密码、恢复哈希
│   │   ├── widgetSettingsStore.js  # widget_settings：挂件设置、桌面应用列表、班级信息
│   │   ├── zipStream.js  # 流式 ZIP 写入（备份包 / 数据导出共用）：条目「边读边写」，任何时刻只持有一个 256…
│   │   └── zipWriter.js  # ZIP 的共用零件（不含打包流程）：CRC32（含增量版，供流式大文件边读边算）、归档内路径…
│   ├── utils/
│   │   ├── backendRoot.js  # 后端根目录（student-backend/）的唯一来源。打包时后端被 esbuild 合成…
│   │   ├── date.js  # 本地日期字符串
│   │   ├── json.js  # JSON 安全读写
│   │   ├── scanTaskKey.js  # 扫描任务键的单一实现：slug:albumId，避免两班同号相册互相塌缩
│   │   ├── securityLevel.js  # 账号安全等级判定（plain / nopass / password / privacy）。…
│   │   ├── semester.js  # 学期推荐值（按当前月份推学期名与起止日期）。两个调用方共用这一份：设置页「增加学期」与课表路…
│   │   ├── slugScopes.js  # 按库（slug）隔离的进程内状态：各库 album_photos.id 独立自增，裸 id …
│   │   ├── sql.js  # SQL 辅助
│   │   └── textHead.js  # 只读文件头部 N 个字符：按字节读够用就停，避免「为截断而整份读入」（20MB 的 txt …
│   ├── albumExif.js  # EXIF/XMP 拍摄时间（读不到就是空串，不拿 mtime 冒充）
│   ├── albumOps.js  # 回收站移入/恢复、删缩略图
│   ├── albumScan.js  # 扫描引擎（主/子进程共用）：递归收集、断点推进、缩略图、批量写库、暂停等待。全量扫描分两阶段…
│   ├── albumThumbs.js  # 缩略图按库隔离 + 64MB LRU + 批量二进制读取
│   ├── scanWorker.js  # 扫描子进程生命周期与 IPC（懒启动、空闲 60s 退出、崩溃限流重建）
│   └── worker.scan.js  # 子进程本体（按 IPC 跑扫描与补图队列）
└── student-frontend/
    └── src/
        └── composables/
            └── secureChannel.js
```
<!-- doc-tree:end -->

本篇说明抽出的公共能力：存在原因、导出内容、调用方与注意事项。

---

## 综合概述

- **定位**：后端公共能力层（`services/`（公共服务目录）、`utils/`（通用小工具目录）、根级媒体 / 扫描文件与安全通道），被路由与数据层复用。
- **公共逻辑**：路由只做参数校验与编排；表格 / 历史 / 槽位 / 学生引用 / 账号会话 / 安全清洗 / 相册扫描等公共逻辑集中在这里；写库统一过 `sanitize`（数据清洗，按字段白名单过滤），跨表引用走 `studentRelations`（学生引用维护）/ `studentRename`（学生改名级联）。
- **局限**：不展开每个 HTTP 接口、数据层多库与安全通道协议细节；这些见 [routes.md](./routes.md)、[data-layer.md](./data-layer.md)、[topics/security.md](../topics/security.md)。

---

## 详细说明

### 1. 表格与历史

#### [`services/tableService.js`](../../../student-backend/services/tableService.js) · 表格服务
- **定位**：学生表与班费表共用的动态列表格逻辑，被 [`routes/dynamicTable.js`](../../../student-backend/routes/dynamicTable.js) 包成 `REST`（用 URL + HTTP 方法表达资源操作的接口风格）。
- **导出**：`queryAll`（查全部）、`insertRow`（插入行）、`updateRow`（更新行）、`deleteRow`（删除行）、`deleteRows`（批量删除，整批一个事务，任一失败整批回滚）、`moveRow`（移动行）、`addColumn`（新增列）、`deleteColumn`（删除列）、`reorderRows`（重排行）、`moveColumn`（移动列）、`importRows`（批量导入）、`renameColumn`（重命名列）。
- 内部：列元数据存 `table_meta.sort_order`（表元数据表的排序列）；`importRows` 自动补建缺失列并 `transaction`（事务）插入；`insertRow` 支持 `atPosition`（插入位置）与 `minCount`（最少行数）。
- **注意事项**：列名正则白名单，保留字段 `id/position/atPosition` 不可直接写；至少保留一个数据列。

#### [`services/createdRows.js`](../../../student-backend/services/createdRows.js) · 导入结果回读
- **定位**：所有导入端点共用的「本次真正新建的行」回读，统一响应形状为 `{ message, created: [完整行…] }`。
- **需求来源**：撤销导入要按真实列重建（`position`、`created_at` 猜不得），只回 id 或条数都做不出 inverse；前端据此一次导入只记一条撤销，也不受每 key 50 条上限截断。
- **导出**：`readRowsByIds(tableName, ids)`（表名由路由以字面量传入，`ids` 走参数绑定）。
- **调用方**：`routes/leaves.js`、`routes/scores.js`、`routes/activities.js`、`routes/countdowns.js`、`services/tableService.js` 的 `importRows`。

#### [`services/importBatch.js`](../../../student-backend/services/importBatch.js) · 批量导入幂等（F07-04）
- **定位**：同一份表重复导入不产生重复记录。不按内容去重（同学生同天同项目加两次分合法），按「是不是同一份文件」——对入参算稳定指纹，命中就回原结果不新建。
- **指纹**：`fingerprintOf({ fields, rows, mode, studentIds })`，sha256 + 键递归排序的稳定序列化；任一项变了就是另一份导入。
- **存储**：独立表 `import_batches`（fingerprint 主键 / created_json / created_at），不动主表——老库 `CREATE IF NOT EXISTS` 即可，无 ALTER / 数据迁移。`recordBatch` 用 `ON CONFLICT DO UPDATE` 覆盖，force 新建后指向最新那批。
- **导出**：`stableStringify`、`fingerprintOf`（纯函数）、`findBatch`、`recordBatch`（需与写记录同事务，由路由保证）。
- **调用方**：`routes/scores.js` 的 `POST /api/scores/import`。

#### [`routes/historyRoutes.js`](../../../student-backend/routes/historyRoutes.js) · 历史快照路由工厂
- **定位**：周历史快照的四个同构接口 `factory`（工厂函数：传配置进去，返回组装好的路由），供 duty、schedule 复用。
- **导出**：`registerHistoryRoutes(router, { table, includeId, parseSnapshot, stringifySnapshot })`（注册历史路由；表名 / 是否带 id / 快照解析 / 快照序列化）。
- **注意事项**：`seats.js` 的 `seat_history` 结构不同，**不能**并入该工厂。

#### [`services/slotStore.js`](../../../student-backend/services/slotStore.js) · 槽位存储
- **定位**：课表 / 值日 / 座位三域「单例槽位表」的统一读写层。
- 物理表：`schedule_slots`（current / master）、`duty_slots`（settings / current / template / weight / draft）、`seat_slots`（current / template / draft / weight）；三域历史快照合并为 `domain_history`。
- 逻辑表名（`schedule` / `duty_layout` / `seat_template` 等）保持不变：读走 `schema`（表结构）里的只读 `view`（数据库视图，不能直接写入），写统一走本模块（视图不可写）。
- **导出**：`isDoc`、`columnsOf`、`getDoc`、`setDoc` 等；可写列以 `SPEC` 的 `columns` 为准。
- **调用方**：AI 数据路由、各网格路由。
- **注意事项**：逻辑名对应的视图只读；写必须走 `setDoc`，且只允许 `SPEC` 列出的列。

#### [`services/businessRules.js`](../../../student-backend/services/businessRules.js) · 业务规则校验
- **定位**：跨表业务校验。
- **导出**：`ValidationError`、`validateRow`、`assertLeaveWindow`（请假时间窗与 SQL 时间戳）、`assertSeatRefs`（座位引用）、`assertDutyRefs`（值日引用）。
- **错误语义**：校验不通过统一抛 `ValidationError`（`status = 400`）—— 这是「用户填错了」，不是服务器故障；未捕获时由 `app.js` 的统一错误出口按 `err.status` 回 400。路由里若自行 `catch`，必须照抄 `err.status`，不要一律 500（`PUT /api/seats` 曾因此把「空位里还有人」报成服务器错误）。
- 被对应路由写操作前调用；`assertDutyRefs` 的单模式根分支是刻意兼容，勿删。
- `assertDutyRefs` 遇到名册外姓名不拒绝，改为调用 `provisionalStudents.resolveNames` 登记为临时学生（与座位表直接输入姓名同口径）。

#### [`services/dutyCells.js`](../../../student-backend/services/dutyCells.js) / [`services/dutyMode.js`](../../../student-backend/services/dutyMode.js) · 值日单元格工具
- `dutyCells`：值日单元格/姓名引用工具，导出 `DUTY_MODES`、`dutyRoots`、`countDutyRefs`、`collectDutyRefs`、`removeDutyName`、`renameDutyName`。
- `dutyMode`：模式打包解包，导出 `MODES`、`toModeMap`、`unpackMode`、`packMode`、`normalizeMode`；**`items` 为空必须返回数组**（该返回标准由单元测试固定）。
- **只认按模式分键**：非 `{daily,big}` 的旧/扁平值（发布前的试验数据、AI 误写）一律读空，**不做旧版兼容层** —— 发布前不积累兼容代码；这类库重建列或重建账号即可。

#### [`services/seatGrid.js`](../../../student-backend/services/seatGrid.js) · 座位网格几何（后端纯计算）
- **定位**：座位「第几列」对外文案与检索口径的唯一实现。数据模型与前端 `composables/useSeatGrid.geometry.js` 同构：`seats` 与 `types` 同下标 `rows×cols`，`cols` 是**网格总列数**（含走廊列）。
- **导出**：`columnKinds`、`columnLabels`、`gridToDenseCols`、`rowIsAisle`。
- **注意事项**：任何「第几列」文案都必须走 `columnLabels` / `gridToDenseCols`，不能拿网格下标当列号（否则 7 座位列的表会报出「第 13 列」）；此处只放纯计算，不读库、不解析 JSON。

#### [`services/seatSnapshot.js`](../../../student-backend/services/seatSnapshot.js) · 座位快照 payload
- **定位**：座位历史快照 payload 的唯一构造点（`/snapshot`、`/snapshot/backfill`、AI 整块写入前的自动快照三处共用）。
- **导出**：`seatSnapshotPayload(row)`。
- **注意事项**：payload **必须带 `types`**（缺了走廊列会被当成空座位，座位指数从此按错列位乘权重）；`aisleCols` / `groupsConfig` 是保留空值的老字段，供既有消费方读取。

#### [`services/seatWrite.js`](../../../student-backend/services/seatWrite.js) · 座位单格写入唯一入口
- **定位**：`writeSeatCell()` 是写一格座位的唯一函数，坐标、值形状、可写性、引用关系全在这里，路由只负责 HTTP 形状（v6 · P0-1）。
- **导出**：`writeSeatCell`、`SeatWriteError`、`SEAT_TABLES`（只允许 `seat_layout` / `seat_template`）。
- **注意事项**：`seats` 解析失败直接抛 500 **不降级**（降级会把整张表覆盖成只剩这一格）；`types` 解析失败按「全座位」处理并记日志，与 GET 同口径。判据本身在 `businessRules.assertSeatCellWritable`。

#### [`services/dutyConfig.js`](../../../student-backend/services/dutyConfig.js) · 值日列名与模式配置
- **定位**：值日「列名 + 模式配置」的唯一读写入口。列名按模式分键存 `{daily:[周一…], big:[第1大组…,全部]}`，与 `items` 的 `{daily,big}` 同构；模式配置存在 `settings` 列（大扫除为 `{cycle, weekday, groupType, groupCount}`）。
- **导出**：`DEFAULT_DAYS`、`ALL_COLUMN`、`CYCLES`、`WEEKDAYS`、`GROUP_TYPES`、`MAX_GROUPS`、`DEFAULT_CONFIG`、`cleanList`、`bigColumnNames` 等。
- **注意事项**：其它地方不许再直接 `SELECT days`（后端有 6 处读列名，各写一份就会出现「AI 出图列名跟界面对不上」）；大扫除列名是「任务分组 + 数量」的纯函数，不落库。

#### [`services/dutyCycle.js`](../../../student-backend/services/dutyCycle.js) · 大扫除命中日
- **定位**：大扫除「周期 + 星期几」→ 命中日的唯一计算实现（以学期开始日所在周为第 1 周；一周 = 每周、两周 = 隔周、一个月 = 每 4 周）。
- **导出**：`normalizeCycle`、命中日判定与批次计算等纯函数。
- **注意事项**：纯函数，基准周一由调用方算好传入；「一个月 = 4 周」是本项目定的口径（日历上的「每月第几个星期三」没有唯一解）。

#### [`services/searchLimits.js`](../../../student-backend/services/searchLimits.js) · 全局搜索分页
- **定位**：搜索分页与防失控阈值的唯一来源（v6 · P3-08）。
- **导出**：`LIMITS`（`PAGE_SIZE 12` / `MAX_PAGE` / 词数与拼音值上限）、页参数归一、`clipPage`、`windowOf` 等。
- **注意事项**：每页固定 12 且**不接受请求覆盖**（允许按请求放大就退回「调阈值」那条补丁路）；`hasMore` 用「每源多取一条」判定，不跑 COUNT。

### 2. 学生与账号

#### [`services/studentRelations.js`](../../../student-backend/services/studentRelations.js) · 学生引用维护
- **定位**：学生删除/改名时的引用维护（分组、座位、值日、分数、班干部、请假等）。
- **导出**：`studentRelations`、`purgeStudentRelations`、`restoreSeatCells`、`clearSeatCells`、`restoreDutySlots`、`clearDutySlots`。
- **调用方**：动态表删行、账号改名。

#### [`services/studentCascadeDelete.js`](../../../student-backend/services/studentCascadeDelete.js) · 级联删除与撤销同事务（v8 · 5-2 / Q2-01）
- **定位**：删学生 + 七处关联清理 + 撤销登记收进**同一个 `db.transaction`**（与 MCP `confirm()` 同事务登记同构）。登记失败连数据一起回滚，不留「已删、无栈可撤」的半截状态。
- **导出**：`deleteStudentCascade(id)` → `{ removed, undoId }`；`removed` 是七处快照（学生整行 + 六类关联），`undoId` 随 HTTP 响应回前端消费。
- **一律全删**：六类关联固定全选，不接部分勾选。新库有 `ON DELETE CASCADE`，若应用层留了勾选的行，数据库会绕过勾选把它们删掉，而快照只记应用层删的 —— 撤销救不回来。全删后 purge 快照与 CASCADE 删的是同一批，CASCADE 退成应用层漏清时的兜底。
- **调用方**：`app.js` 的 `POST /:id/delete-with-relations`（不读 `body.relations`）。前端不再发第二次 `POST /api/undo`（原 `recordStudentCascadeDelete` 已删），也不再有「仅删学生、保留关联」入口。
- **必须在 `withDb` 上下文调用**：本服务用全局 `db` Proxy（按当前请求 ALS 绑定连接），`undoStore.push` 内部嵌套事务在同一连接上退化为 SAVEPOINT。

#### [`services/errorResponse.js`](../../../student-backend/services/errorResponse.js) · 全局错误处理（v8 · N3-09 / N1-31）
- **定位**：Express 错误分层——4xx 保留业务 message、5xx 只回通用文案，原始现场（SQL / 路径 / 模块名）只进本地 `console.error`；`err.expose === true` 是 5xx 回传原始原因的唯一例外；响应头已发出时交回 `next(err)`。
- **导出**：`errorResponse(err, req, res, next)`。
- **调用方**：`app.js` 让路链末尾 `app.use(errorResponse)`（注册两次，覆盖 late loaders）。
- **为何独立成模块**：从 `app.js` 内联抽出，让判据能**真跑函数**（喂假 req/res 断言响应体）而不是读内联源码正则——N1-31 的纯静态测试改造实例。

#### [`services/studentRename.js`](../../../student-backend/services/studentRename.js) · 学生改名级联
- **定位**：学生姓名变更的级联更新（跨表改引用）。
- **调用方**：`routes/dynamicTable.js` 的 `PUT`、`students` 改名路径。
- **匹配口径（六处联写必须一致）**：一律「trim 后比较 + 写回**规范名**」。值日 `cells` 与座位 `seats` 是手工录入的 JSON，写入路径只查类型、**不 trim**（`assertDutyCellShape` / `assertSeatCell`），库里确实存在 `' 张三 '` 这种带空格的旧名。口径不一致时（有的 trim 比、有的严格比）改名后同一学生在不同表里名字对不上 → 值日指数再也归不到他名下，且界面不报错。写回不保留原空格：下游 `DutyView` / `SeatView` 的 `acc[name]` 是**精确键聚合**，留空格会让统计键分裂成两个桶。

#### [`services/accountRename.js`](../../../student-backend/services/accountRename.js) · 改用户名的跨库两写（带补偿）
- **定位**：用户名存在**两处** —— `index.db` 的 registry 登记表（跨库的登录真源）与业务库的 `users` 表。两个 SQLite 文件，**事务无法跨库**，所以不能靠包事务解决，只能显式补偿。
- **导出**：`renameUsernameWithCompensation`。
- **顺序**：先改 registry（权威侧，决定「能不能用这个名字登录」），再改业务库。
- **补偿**：业务库写失败（含 `changes = 0`）时把 registry 改回改之前的用户名，让「旧名仍可登录」重新成立；**回滚前必须确认 registry 当前仍是本次写入的新名**，否则会覆盖掉期间发生的并发改名。补偿本身失败时不掩盖原始错误。
- **调用方**：`routes/account.js` 的 `PUT /username`。

#### [`services/provisionalStudents.js`](../../../student-backend/services/provisionalStudents.js) · 临时学生建档
- **定位**：名册外姓名自动建档（AI/表格里输入未登记姓名时生成「临时学生」）。
- **导出**：`resolveOne`、`resolveNames`、`ensureProvisionalStudent`。
- **调用方**：`app.js`、AI 执行器。

#### [`services/pendingRegs.js`](../../../student-backend/services/pendingRegs.js) · 注册草稿暂存
- **定位**：注册草稿（抄写恢复密钥前）暂存与清理。
- **导出**：`PENDING_TTL_MS`、`PENDING_MAX`、`put`、`get`、`remove`、`size`。
- **调用方**：`routes/auth.js`。

#### [`services/sessions.js`](../../../student-backend/services/sessions.js) · 登录会话
- **定位**：登录会话（sid）登记与失效；`.sessions.json` 全局一份，因此账号维度是 `(userId, dbSlug)` 双键（各账号库 `users.id` 都可能是 1）。
- **导出**：`create`、`has`、`revoke`、`revokeAllByUser(userId, dbSlug)`。
- **调用方**：`middleware/auth.js`、`routes/auth.js`（登出）、`services/credentialChange.js`。
- **注意事项**：`has()` 会顺带刷新活动时间（有节流）并清理长期不活动的记录；`revoke` 是单点出口，`revokeAllByUser` 才是「这个账号的全部 sid」。清理期**按记录所属账号算**（`authPolicy.sessionTtlMsForSlug`，天数 + 5），不是全局一个常量 —— 登录保持天数改成按账号可配之后，同一个名单文件里会同时存在 6 天与 185 天的记录；比「最短清理期」还新的记录直接跳过，不为它反查 index.db。

#### [`services/authPolicy.js`](../../../student-backend/services/authPolicy.js) · 登录保持天数
- **定位**：登录保持天数（按账号）的唯一来源，落 `core/.auth-policy.json`（与 `.sessions.json` 同层同性质：本机凭据，不进备份包）。键是**账号名**而不是 `dbSlug`：一个账号可以有多个班，切班只换 `dbSlug`，按 slug 存会表现为「换个班设置就被重置」。
- **导出**：`daysFor`、`daysForSlug`、`setDays`、`renameKey`、`signOptsFor`、`slideWindowMs`、`sessionTtlMs`、`sessionTtlMsForSlug`、`mediaTtlFor`。
- **调用方**：`middleware/auth.js`（签发 / 滑动续期 / 媒体凭据）、`services/sessions.js`（名单清理期）、`routes/auth.js` 与 `routes/account.js` 的各签发点、`routes/account.js` 的 `GET/POST /login-policy`。
- **注意事项**：①续签窗口取天数的 1/4，**必须小于天数** —— 窗口一旦 ≥ 天数，token 从签发那一刻起就永远在「该续签」区间，每个请求都重签一次（慢而无报错）；②名单清理期取 `天数 + 5`，**必须大于 token 寿命**，否则活跃用户在名单被清掉那天被强制登出（V5-009 同类）；③不提供「永久」：省掉 `expiresIn` 能签出永不过期的 token，代价是名单清理、备份恢复、改密吊销全部失去兜底；④改小天数不会让已签出的旧 token 变短（它带着原 `exp`），只有当前窗口当场重签。

#### [`services/credentialChange.js`](../../../student-backend/services/credentialChange.js) · 凭证变更动作层
- **定位**：「凭证变更 → 会话失效」的唯一动作层（v6 · A1-16）。调用方只描述「哪个账号变了」，不自己决定吊销范围、也不自己拼 sid。
- **导出**：`revokeAccountSessions(userId, dbSlug)`（全部旧 token 作废）、`rotateAccountSessions(userId, dbSlug)`（全量吊销后换发新 sid，供设置页改密这类「改完仍要继续在线」的路径）。
- **注意事项**：缺任一维度直接抛 `TypeError`，绝不静默返回 0（静默等于「改完密码旧 token 还能用」）；凭证变更路径必须全部接入，不许在路由里另拼吊销逻辑。

#### [`services/recoveryKey.js`](../../../student-backend/services/recoveryKey.js) · 恢复密钥
- **定位**：中文恢复密钥。
- **导出**：`pickPhrase`（512 字池取 12 字）、`deriveRestoreHash`（`sha256('restore:'+phrase)`）、`normalizePhrase`（只留汉字，兼容序号/空格）、`formatPhrase`、`safeEqualHash`（常数时间）。
- **调用方**：注册、改恢复密钥、找回密码、备份解密。

#### [`services/usernameRules.js`](../../../student-backend/services/usernameRules.js) / [`services/bcryptAsync.js`](../../../student-backend/services/bcryptAsync.js) · 用户名规则
- `usernameRules`：用户名合法性/长度/保留字。
- `bcryptAsync`：`hash` / `compare` Promise 化，避免同步 bcrypt 阻塞事件循环（实测同步版 56~65ms/次）。

### 3. 安全与文件

#### [`services/secureChannel.js`](../../../student-backend/services/secureChannel.js) · 安全通道
- **导出**：`initMaster`、`hasMaster`、`sessionCount`、`genServerEphemeral`、`deriveEcdhShared`、`deriveSessionKey`、`seal`、`open`、`performHandshake`、`getSessionKey`、`destroySession`、`bindAuth`、`getBoundAuth`、`unbindAuth`、`requestDecrypt`、`responseEncrypt`、`cleanupSessions`、`cleanupNonces`、`sweepNow`、`startIdleSweep`、`stopIdleSweep`、`IDLE_SWEEP_MS`、`SESSION_TTL_MS`。
- 模块加载时 `initMaster(process.env.SECURE_MASTER)`；无 master 时全部降级为明文直通。
- **空闲清扫（v6 · 1-5）**：`initMaster` 成功后启动 60s 一次的 `setInterval(...).unref()`，同时清 `sessions`（15 分钟 TTL）与 `usedNonces`（120 秒窗口）；握手/凭据路径上的清扫保留作兜底。`unref` 保证不拖住进程退出。
- **响应单次序列化（v6 · 1-2）**：`responseEncrypt` 的加密分支直接把信封拼成 `{"d":"…"}` 交给 `res.send`，不再让 `res.json({ d })` 二次序列化（大响应下那等于把整段 base64 再拼一遍）。输出与 `JSON.stringify({ d })` 逐字节一致。
- 与前端 [`composables/secureChannel.js`](../../../student-frontend/src/composables/secureChannel.js) 参数一一对应。

#### [`services/sanitize.js`](../../../student-backend/services/sanitize.js) · 数据清洗
- **定位**：所有写接口的统一清洗/校验（字符串裁剪、类型归一、数组/JSON 结构校验、座位扁平→二维等）。
- **导出**：常量 `MAX_TEXT_LEN`、`MAX_JSON_LEN`、`SEAT_MAX_ROWS`、`SEAT_MAX_COLS`、`COLUMN_RULES`，以及 `cleanText`、`cleanByType`、`cleanDocValue`、`cleanPath`、`normBool`、`normNumber`、`normInt` 等清洗函数。
- **注意事项**：`sanitize seats` 的「扁平→二维」是刻意兼容，不要删。

#### [`services/unzipSafe.js`](../../../student-backend/services/unzipSafe.js) · 安全解压
- **定位**：自研安全解压（拦截符号链接、路径穿越、绝对路径、反斜杠）。
- **调用方**：备份恢复、字体/资源导入。

#### [`services/backupArchive.js`](../../../student-backend/services/backupArchive.js) · 备份包 v3 写包
- **定位**：整库备份包（ZIP：库 + 用户文件 + 清单）的**写包**实现（v6 · N2-02）。只写包，不碰还原。
- **导出**：`writeBundle`、`extractAndVerify`、`replaceDir`、`META_ENTRY` / `MANIFEST_ENTRY`、`ZIP64_LIMITS` 等。
- **ZIP64（>4GB）**：写侧 `services/zipStream.js` 在条目/整包超 32 位时自动切 ZIP64（本地头 extra + 24 字节描述符 + EOCD64）；本模块的 `ZIP64_LIMITS` 统一解包闸（单条目 64GB / 总量 512GB）与上传上限（见 `routes/account.js` 的 multer），三处同源，避免「写得出来、恢复不了」。压缩炸弹防护靠「按实际写入字节算 + 超限中断」机制，不靠具体数字。
- **包内结构**：`bundle.json`（包身份：slug / 用户名 / 是否加密 / 库钥匙）+ 各目录真实文件 + `manifest.json`（每项 `{path,size,sha256}` + `totalBytes` + `omitted`）。
- **注意事项**：条目名一律过 `sanitizeEntryName`；`album-thumbs`（缩略图）是派生数据不入包，但**必须写进 `omitted`**，否则用户会以为备份漏了东西；`bundle.json` 放在第一个条目且 store 不压缩，前端 `zipPeek` 才能只读 64KB 判断要不要口令。

#### [`services/bundleRestore.js`](../../../student-backend/services/bundleRestore.js) · 备份包落盘还原
- **定位**：把「已校验通过的 v3 包」落到磁盘的**唯一实现**，登录中恢复与新机离线恢复两个入口共用（v6 · N2-02）。
- **导出**：`receiveAndVerify(file)`（解到 `.restore-<时间戳>` 并逐项校验，**不碰现有数据**）、`applyVerifiedBundle(...)`（按目录计划替换，旧目录改名成 `.bak-<stamp>` 不删）。
- **注意事项**：包为空目录 / 缺 `uploads` / 缺 `memory.md` 时一律**不替换**（空目录等于没有，别把现有文件或 AI 记忆清空）；整库被换掉后必须同步失效列缓存（`ai.helpers` 反向引用是刻意保留的一处）；失败时清理临时目录，不在数据目录留 GB 级残骸。

#### [`services/pdfDomShim.js`](../../../student-backend/services/pdfDomShim.js) · PDF DOM 兼容层
- **定位**：纯 JS 最小 `DOMMatrix` 实现，供 pdfjs 文本提取（替代 35MB 的 canvas 依赖）。
- **导出**：`install()`、`DOMMatrix2D`（加载即自动 install）。

#### [`services/ffmpeg.js`](../../../student-backend/services/ffmpeg.js) · 视频处理封装
- **定位**：定位随包 LGPL 版 ffmpeg，缺省时按需下载；用于视频封面首帧。
- **导出**：`resolveFfmpegPath()`、`ensureFfmpeg()`。
- **注意事项**：临时文件保持 `.jpg` 后缀（ffmpeg 按扩展名推断封装）；不要动 `resources/ffmpeg/` 与打包脚本（红线）。

#### [`services/ocr.js`](../../../student-backend/services/ocr.js) · 文字识别
- **定位**：Windows OCR（截图/图片文字识别）封装，供 AI 图片理解与工具箱使用。
- **导出**：`recognizeFile`、`recognizeDataUrl`。

### 4. 相册

| 文件 | 定位 | 关键导出 |
| --- | --- | --- |
| [`albumScan.js`](../../../student-backend/albumScan.js) | 扫描引擎（主/子进程共用）：递归收集、断点推进、缩略图、批量写库、暂停等待。**全量扫描分两阶段**：先建索引（4.8ms/张），再**无条件重建**每一张缩略图（83ms/张）；**增量更新相反**：已有缩略图就跳过，只补丢的（`presentThumbIds` 一次 readdir），仅 mtime 变化时强制重建 | `collectMediaFiles`、`fullScan`、`incrementalScan`、`refreshVirtual`、`presentThumbIds`、`resolvePhotoDate`、`genThumb`、`createThumbWriter`、`claimScanTask`、`waitWhilePaused` |
| [`scanWorker.js`](../../../student-backend/scanWorker.js) | 扫描子进程生命周期与 IPC（懒启动、空闲 60s 退出、崩溃限流重建） | `dispatchScan`、`dispatchResume`、`requestStop`、`requestPause`、`forwardDemand`、`lockDb`、`shutdown`、`killNow` |
| [`worker.scan.js`](../../../student-backend/worker.scan.js) | 子进程本体（按 IPC 跑扫描与补图队列） | 无导出 |
| [`albumThumbs.js`](../../../student-backend/albumThumbs.js) | 缩略图按库隔离 + 64MB LRU + 批量二进制读取 | `thumbPathFor`、`rememberThumb`、`lookupThumb`、`readThumb`、`readThumbBatch`、`purgeCache` |
| [`services/thumbPurge.js`](../../../student-backend/services/thumbPurge.js) | 清理缩略图文件（只删文件，不碰索引；逐文件容错，回报删除数与字节数） | `purgeThumbFiles`、`collectTargets` |
| [`services/thumbSweep.js`](../../../student-backend/services/thumbSweep.js) | 按库对账回收孤儿缩略图（默认只读，`apply=true` 才删；库打不开则整目录跳过） | `sweepThumbOrphans` |
| [`albumExif.js`](../../../student-backend/albumExif.js) | EXIF/XMP 拍摄时间（读不到就是空串，**不拿 mtime 冒充**） | `readExifDate`、`normalizeExifDate`、`readExifBuf`、`readXmp`、`readExifDetail` |
| [`albumOps.js`](../../../student-backend/albumOps.js) | 回收站移入/恢复、删缩略图 | `TRASH_DIR`、`trashPathFor`、`moveToTrash`、`restoreToOriginal`、`deleteThumb` |

### 5. 通用工具（`utils/`）

| 文件 | 职责 | 导出 |
| --- | --- | --- |
| [`utils/date.js`](../../../student-backend/utils/date.js) | 本地日期字符串 | `pad2`、`localDateStr`、`todayStr` |
| [`utils/json.js`](../../../student-backend/utils/json.js) | JSON 安全读写 | `safeJson`、`readDocJson` |
| [`utils/sql.js`](../../../student-backend/utils/sql.js) | SQL 辅助 | `now`、`isDateStr`、`cleanUp`、`maxPosition`、`buildInsert`、`buildUpdate` |
| [`utils/sendError.js`](../../../student-backend/utils/sendError.js) | 路由 catch 的统一错误响应（V9-K01-07）：500 通用文案 + 原文只进日志，与全局 errorResponse 同口径 | `sendError` |
| [`utils/publicToolError.js`](../../../student-backend/utils/publicToolError.js) | MCP 外部错误文案脱敏（V9-K02-01）：server 与 stdio 转发器共用，避免两处正则漂移 | `publicToolError` |
| [`utils/textHead.js`](../../../student-backend/utils/textHead.js) | 只读文件头部 N 个字符：按字节读够用就停，避免「为截断而整份读入」（20MB 的 txt 会先变成约 40MB 的 UTF-16 字符串）；读满时裁掉落在多字节序列中间的不完整尾字节，不产生 U+FFFD | `readTextHead`、`decodeHead`、`trimIncomplete` |
| [`utils/slugScopes.js`](../../../student-backend/utils/slugScopes.js) | 按库（slug）隔离的进程内状态：各库 `album_photos.id` 独立自增，裸 id 键 / 全局攒批会串库。状态自己登记，登出统一失效 | `safeSlug`、`createSlugBuckets`、`createSlugBatch`、`clearAllForSlug` |
| [`utils/securityLevel.js`](../../../student-backend/utils/securityLevel.js) | 账号安全等级判定（`plain` / `nopass` / `password` / `privacy`）。**口径单源**：设置页判档与「本机信息恢复」分流都走这里，各写一份会分叉成「显示免密、登录却要密码」。明文库判定排在密码判定之前（明文档不该有密码哈希） | `resolveSecurityLevel` |
| [`utils/semester.js`](../../../student-backend/utils/semester.js) | 学期推荐值（按当前月份推学期名与起止日期）。**两个调用方共用这一份**：设置页「增加学期」与课表路由、首次引导页（引导时库还没打开，走 routes 的实现会直接撞上未打开的 db）。抄两份会导致「设置页推荐的学期和引导页不一样」 | `autoSemester` |
| [`utils/backendRoot.js`](../../../student-backend/utils/backendRoot.js) | 后端根目录（`student-backend/`）的唯一来源。打包时后端被 esbuild 合成单文件（v6 · 2-17），合并后所有模块共用一个 `__dirname`，源码态 `path.resolve(__dirname, '..')` 会整体上移一级；`.env`、`data/`、`resources/`、`worker.scan.js` 这些「相对后端根目录」的路径统一走这里。源码态按本文件位置推导，bundle 态由主进程 fork 时注入 `BACKEND_ROOT` | `BACKEND_ROOT` |
| [`services/zipWriter.js`](../../../student-backend/services/zipWriter.js) | ZIP 的共用零件（不含打包流程）：CRC32（含增量版，供流式大文件边读边算）、归档内路径净化、ZipCrypto key 流。**刻意不用 AES**：Windows 资源管理器只认传统加密，AES 必须装 7-Zip，普通用户会看到「文件已损坏」；代价是只能防随手打开，不能当强加密宣传。无第三方依赖（后端原有依赖里没有 zip 写库） | `crc32`、`crc32Start/Update/End`、`sanitizeEntryName`、`createZipCrypto` |
| [`services/zipStream.js`](../../../student-backend/services/zipStream.js) | 流式 ZIP 写入（备份包 / 数据导出共用）：条目「边读边写」，任何时刻只持有一个 256KB 块；明文条目用数据描述符（bit 3），加密条目把 CRC 写进本地头（ZipCrypto 校验口令要用），文件条目加密时走 store 以便写头前就拿到尺寸。**单一入口**：不允许再出现「全部读进内存再拼终包」的第二套实现（v6 · P2-01：旧实现同时驻留 raw / deflate / parts / 终包四份） | `createZipWriter`、`writeZip` |
| [`services/perfMem.js`](../../../student-backend/services/perfMem.js) | 导出内存峰值探针（v6 · 0-5）：`PERF_EXPORT=1` 时 `memSnapshot()` 采 `process.memoryUsage()`，导出 `finally` 里用 `logExportMemory(label, before)` 打 rss / heap / external 差值；关闭时两个函数分别返回 `null` 与空操作，普通导出零额外开销。用环境变量而非面板开关，是为了真机大收据导出时不用重新打包 | `memSnapshot`、`logExportMemory`、`enabled` |
| [`services/uploadSignatures.js`](../../../student-backend/services/uploadSignatures.js) | 收据上传的类型判定：扩展名白名单（图片 20MB / PDF 30MB / ooxml 30MB / ole 30MB / 视频 200MB / 纯文本 md 5MB）+ 真实字节魔数。**md 没有魔数**，判据改成「前 512 字节没有 NUL 字节、且非空」（二进制改后缀开头几乎必然带 0x00；512 而不是 16，是因为 16 字节太短，二进制可能还没出现 NUL）。**Windows 上 docx/xlsx 的 mimetype 不可靠**，multer 只按扩展名初筛，真正判断走魔数。另含 `decodeFileName`：busboy 按 latin1 解析 multipart 文件名，中文名会变成乱码，这里按 latin1→字节→utf8 转回来（转换出 `�` 说明原字节不是 UTF-8，返回原串防二次破坏） | `KINDS`、`EXT_TO_KIND`、`ALLOWED_EXT_RE`、`sniff`、`checkUpload`、`decodeFileName` |
| [`services/receiptTrash.js`](../../../student-backend/services/receiptTrash.js) | 收据文件移进 `dataDir/receipt-trash/`。收据扩到视频后，删除只改数据库数组会让 uploads 悄悄涨到几个 G。**安全边界：一律 `path.basename` 再拼回 uploads**，`../`、绝对路径、反斜杠穿越都出不去 —— 这个函数能搬动磁盘文件，边界写错就是「把机器上任意文件挪走」的入口 | `moveReceiptsToTrash` |


### 6. 数据访问出口（SQL 下沉）

> 档 C · M12：路由层不再持有裸 SQL。语句按「一张表的同一件事只有一份实现」收进各域 store，新增调用方不会各抄一条。

| 文件 | 覆盖的表 / 职责 | 关键导出 |
| --- | --- | --- |
| [`services/activityStore.js`](../../../student-backend/services/activityStore.js) | `activities`：列表、删除、导入批量插入 | `readAll`、`removeById`、`insertMany` |
| [`services/countdownStore.js`](../../../student-backend/services/countdownStore.js) | `countdowns`：列表、删除、导入批量插入 | `readAll`、`removeById`、`insertMany` |
| [`services/scoreStore.js`](../../../student-backend/services/scoreStore.js) | `score_records`：全量/分页列表、学生定位、导入、首页摘要 | `readAll`、`list`、`findStudentById`、`insertMany`、`dashboardSummary` |
| [`services/leaveStore.js`](../../../student-backend/services/leaveStore.js) | `leave_records` + 今日到班列顺序：全量与分页列表、学生带出、三态写、导入、列顺序替换 | `readList`、`findWindow`、`markReturned`、`markUnreturned`、`markCanceled`、`insertMany`、`listTodayColumns`、`replaceTodayColumns` |
| [`services/cadreStore.js`](../../../student-backend/services/cadreStore.js) | `cadres` / `cadre_members`：树形层级、排序、级联删除、按名查重 | `allCadres`、`membersOf`、`insertCadre`、`deleteCadreCascade`、`moveCadre`、`moveMember`、`findStudentIdsByName` |
| [`services/groupDim.js`](../../../student-backend/services/groupDim.js) | 分组维度 / 小组 / 成员：CRUD 与复合事务操作（改组数、删维度带快照、移动成员、智能分组写回、导入） | `createDimension`、`updateDimension`、`deleteDimension`、`moveDimension`、`addMember`、`moveMember`、`importMembers` |
| [`services/semesterStore.js`](../../../student-backend/services/semesterStore.js) | `semesters`：列表、增删改、切换当前；**「当前学期」的唯一判定**（无标记时回退最新一条） | `list`、`findCurrent`、`findById`、`create`、`setCurrent`、`update`、`updateRange`、`remove` |
| [`services/searchQuery.js`](../../../student-backend/services/searchQuery.js) | 全局搜索的查询实现：各数据源 SQL 与内存 JSON 源、分页、展示文案 | `runSearch` |
| [`services/userStore.js`](../../../student-backend/services/userStore.js) | `users`：登录取凭据、改用户名、改密码、恢复哈希 | `findById`、`findCredentials`、`updateUsername`、`updatePassword`、`updateRecoveryHash` |
| [`services/widgetSettingsStore.js`](../../../student-backend/services/widgetSettingsStore.js) | `widget_settings`：挂件设置、桌面应用列表、班级信息 | `readSettings`、`updateSettings`、`readDesktopApps`、`writeDesktopApps` |
| [`services/aiStore.js`](../../../student-backend/services/aiStore.js) | AI 域（`routes/ai/**`）：表结构缓存、引用统计、工具所需的各业务表查询、按表单行 CRUD | `tableColumns`、`countReferences`、`rowsByIds`、`insertRow`、`updateColumns`、`deleteRow`、`queryAll` |
| [`services/aiConfigStore.js`](../../../student-backend/services/aiConfigStore.js) | `ai_settings` / `ai_models`：开关、启用模型、密钥复用判断、模型 CRUD | `readFlags`、`readActiveModel`、`listModels`、`activateModel`、`updateModel`、`setReasoning` |
| [`services/aiConversationStore.js`](../../../student-backend/services/aiConversationStore.js) | `ai_conversations` / `ai_messages`：会话与消息分页、标题、摘要、token 记账 | `listConversations`、`listMessagesPage`、`insertMessage`、`updateMessage`、`getSummary`、`updateSummary` |
| [`services/retentionStore.js`](../../../student-backend/services/retentionStore.js) | `ai_settings.retention_json`：四类数据（AI 消息 / 历史快照 / 相册回收站 / 收据回收站）的保留偏好（默认永久）、占用统计、明细、手动清除。前两类走 SQL `created_at`，回收站两类走目录文件 `mtime`；目录只从 `dbManager` 受信任常量取，符号链接不跟随也不删。回收站是撤销还原源，**不接写入路径自动清理**，`clear` 只由设置页显式调用 | `readPolicy`、`writePolicy`、`stats`、`list`、`deleteAll`、`preview`、`applyNow`、`autoClean` |
| [`services/albumStore.js`](../../../student-backend/services/albumStore.js) | 相册索引 `albums` / `album_photos`：列表与封面、照片分页、索引复制与删除、缩略图路径、日期计数 | `listAlbums`、`listPhotos`、`photoDateCountsPage`、`copyPhotoRow`、`updateThumbPath`、`randomPhotoId` |
| [`services/exportQuery.js`](../../../student-backend/services/exportQuery.js) | 导出侧只读查询：单表读取失败返回空结果，不拖垮整份导出 | `all`、`get`、`countOf` |
| [`services/undoStore.js`](../../../student-backend/services/undoStore.js) | `undo_history` + 撤销执行器：记录入栈与每 key 淘汰、方向 CAS、按批次取 id、各执行器的复合动作（删维度 / 合并相册 / 删职务 / 删学生 / 相册增删 / 照片移动）、动态表行级与网格列写 | `push`、`claimDir`、`idsByOrigin`、`restoreDimension`、`restoreMergedAlbum`、`restoreStudentCascade`、`applyRowPositions`、`writeGridSnapshot` |

- **搬进 store 判据（三档）**：①单例槽位读 —— 直接用 `slotStore.getDoc(逻辑名)`，路由里不再抄列清单（那份清单是 `SPEC` 的手抄副本，加列时会静默漏读）；②单表语句 —— 进对应 `*Store`，路由只做参数归一与字段清洗；③「必须在一个事务里才一致」的复合操作 —— 整条进 service，事务边界跟着数据操作走，路由只收结果（`groupDim` 的改组数、删维度带快照、移动成员都属这一档）。
- **例外：事务里夹着文件系统副作用时，事务留在路由**（`album`：先 `unlink` 缩略图再删索引、删完派发或停止 `scanWorker`）。搬进 service 会把「先删缓存再删库」的顺序藏起来，评审时看不见。
- **依赖方向**：store 只依赖 `db` 与同级 service，不得反向 require `routes/`。`serializeColVal` 导出在 `routes/ai/ai.helpers.js`，因此 `aiStore` 只拼语句与绑定，序列化仍由路由完成。
- **撤销域（B8）的额外一条**：带文件系统副作用的顺序留在执行器 —— 照片「先搬文件再插索引」「先删索引再搬文件」、相册删缩略图、加相册后派发扫描；`undoStore` 只提供 `insertPhotoIndex` / `deletePhotoIndex` / `insertAlbumWithPhotos` 这类纯 DB 段，事务由 `runInTransaction` 提供。
- **守卫**：每条下沉过的路由都有「不许出现 `db.prepare(`，且必须真的调用对应 store」的判据（`leaves-paging`、`seat-cell-write`、`ai-doc-transaction`、`semester-crud`、`group-manage`、`album-paging`），逐条做过变异反证。

### 其他服务与工具模块

| 文件 | 职责 |
| --- | --- |
| [`services/accessLogStore.js`](../../../student-backend/services/accessLogStore.js) | 数据访问记录的持久层；只在 Store 里写 SQL，写入失败不影响主流程 |
| [`services/accessTimeline.js`](../../../student-backend/services/accessTimeline.js) | 访问记录弹窗的合并视图：读来自 `access_log`，已执行的写来自 `undo_history`，未执行的写来自 MCP 提案 |
| [`services/aiPrivacy.js`](../../../student-backend/services/aiPrivacy.js) | 发给第三方模型前的身份替换：姓名可逆别名、电话可逆令牌、本地路径不可逆归一 |
| [`services/aiReadScope.js`](../../../student-backend/services/aiReadScope.js) | 按表关闭的读闸门单一作用域：`effectiveReadTables()` 与 `isTableReadable()` |
| [`services/aiWriteScope.js`](../../../student-backend/services/aiWriteScope.js) | 只读 / 读写档的唯一判定点：合并 `readonly_tables` 与 `closed_tables` |
| [`services/dutyWrite.js`](../../../student-backend/services/dutyWrite.js) | 值日域写入的事务唯一出口，供路由、AI 工具与撤销执行器复用 |
| [`services/mcpProposalStore.js`](../../../student-backend/services/mcpProposalStore.js) | MCP 写提案的持久层，只存意图，SQL 只在这里 |
| [`services/mcpProposalExec.js`](../../../student-backend/services/mcpProposalExec.js) | 执行已确认的 MCP 提案，复用本地 AI 的写入原语与学生引用保护 |
| [`services/mcpProposalView.js`](../../../student-backend/services/mcpProposalView.js) | 提案的人读视图：把表名 / 操作 / 字段翻成老师能判断的说明 |
| [`services/mcpRateLimit.js`](../../../student-backend/services/mcpRateLimit.js) | MCP 工具调用频率闸门：防止跑飞或脚本批量驱动堆满待确认提案 |
| [`services/mcpTokenStore.js`](../../../student-backend/services/mcpTokenStore.js) | MCP 访问令牌存储（`core/.mcp-tokens.json`，应用级配置） |
| [`services/mcpTools.js`](../../../student-backend/services/mcpTools.js) | 暴露给外部客户端的工具实现；写操作只生成提案不落库 |
| [`services/studentLookup.js`](../../../student-backend/services/studentLookup.js) | 在 `students` 里认人的单源实现：按 id / 学号 / 姓名带出学生，列清单由调用方点单 |
| [`utils/scanTaskKey.js`](../../../student-backend/utils/scanTaskKey.js) | 扫描任务键的单一实现：`slug:albumId`，避免两班同号相册互相塌缩 |
| [`services/aiEndpoint.js`](../../../student-backend/services/aiEndpoint.js) | AI 出站地址的唯一校验入口：只放行 http/https、必须有主机名、拒绝云厂商元数据地址；**刻意不封** localhost / 局域网（本地 LLM 是核心用法） |
| [`services/dashboardAgg.js`](../../../student-backend/services/dashboardAgg.js) | 首屏聚合的 SQL 出口：首页只取需要的列/聚合（学生 `id + 姓名`、班费余额/本月收支/条数），避免整表读进内存 |
| [`services/loginThrottle.js`](../../../student-backend/services/loginThrottle.js) | 登录失败节流与 `/accounts` 频控：同账号 + IP 失败 5 次锁 30 秒、10 次锁 15 分钟，成功清零；账号列表按 IP 限 60 次/分钟 |
| [`services/tmpSweep.js`](../../../student-backend/services/tmpSweep.js) | 启动期回收崩溃遗留临时文件：AI 附件 / 还原上传 / 解包目录 / OCR 中转四处，只删超过 24 小时的条目，失败静默 |

---

## 注意事项

- 公共逻辑一旦被两个以上路由使用就下沉到 `services/`（后端公共服务目录），路由只做参数校验与编排。
- 所有写库入口必须先过 `sanitize`（数据清洗，按字段白名单过滤）；所有跨表引用变更走 `studentRelations`（学生引用维护）/ `studentRename`（学生改名级联）。
- 扫描不再与 HTTP 共用进程：`sharp`（图片处理库）的 `libuv`（Node 异步 I/O 线程池）是**进程级**的，只有 `fork`（创建子进程）才有独立池。
- `fullScan`（全量扫描）先收齐清单、最后才删清单外的行；`collectMediaFiles`（收集媒体文件）返回 `null` 表示被中断，禁止兜成空数组（会删光索引）。
- 断点用**文件路径**（增量扫描）或**行 id**（虚拟相册），不用序号。
- `state`（扫描状态）只由主进程写，`token`（扫描归属标记）标识本次扫描归属（防止旧扫描删掉新扫描记录）。
- `INSERT OR IGNORE`（冲突则忽略的插入语句）冲突时 `lastInsertRowid`（最后插入的行号）不可靠，必须回查真实 id。
- 缩略图版本 `THUMB_VERSION`（后端缩略图版本号）与前端 `ALBUM_THUMB_VERSION`（前端缩略图版本号）必须同时 +1。

---
