# 后端公共服务（`student-backend/services/` 等）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
├── student-backend/
│   ├── routes/
│   │   ├── dynamicTable.js
│   │   └── historyRoutes.js  # 历史快照路由工厂
│   ├── services/
│   │   ├── bcryptAsync.js  # 用户名规则
│   │   ├── businessRules.js  # 业务规则校验
│   │   ├── dutyCells.js
│   │   ├── dutyMode.js  # 值日单元格工具
│   │   ├── ffmpeg.js  # 视频处理封装
│   │   ├── ocr.js  # 文字识别
│   │   ├── pdfDomShim.js  # PDF DOM 兼容层
│   │   ├── pendingRegs.js  # 注册草稿暂存
│   │   ├── provisionalStudents.js  # 临时学生建档
│   │   ├── recoveryKey.js  # 恢复密钥
│   │   ├── sanitize.js  # 数据清洗
│   │   ├── secureChannel.js  # 安全通道
│   │   ├── sessions.js  # 登录会话
│   │   ├── slotStore.js  # 槽位存储
│   │   ├── studentRelations.js  # 学生引用维护
│   │   ├── studentRename.js  # 学生改名级联
│   │   ├── tableService.js  # 表格服务
│   │   ├── unzipSafe.js  # 安全解压
│   │   └── usernameRules.js
│   ├── utils/
│   │   ├── date.js  # 本地日期字符串
│   │   ├── json.js  # JSON 安全读写
│   │   └── sql.js  # SQL 辅助
│   ├── albumExif.js  # EXIF/XMP 拍摄时间（读不到就是空串，不拿 mtime 冒充）
│   ├── albumOps.js  # 回收站移入/恢复、删缩略图
│   ├── albumScan.js  # 扫描引擎（主/子进程共用）：递归收集、断点推进、缩略图、批量写库、暂停等待
│   ├── albumThumbs.js  # 缩略图按库隔离 + 64MB LRU + 批量二进制读取
│   ├── scanWorker.js  # 扫描子进程生命周期与 IPC（懒启动、空闲 60s 退出、崩溃限流重建）
│   └── worker.scan.js  # 子进程本体（按 IPC 跑扫描与补图队列）
└── student-frontend/
    └── src/
        └── composables/
            └── secureChannel.js
```
<!-- doc-tree:end -->

抽出来的公共能力：为什么存在、导出什么、谁在用、有什么注意事项。--

---
## 综合概述

- **定位**：后端公共能力层（`services/`、`utils/`、根级媒体/扫描文件与安全通道），被路由与数据层复用。
- **公共逻辑**：路由只做参数校验与编排；表格/历史/槽位/学生引用/账号会话/安全清洗/相册扫描等公共逻辑集中在这里；写库统一过 `sanitize`，跨表引用走 `studentRelations` / `studentRename`。
- **局限**：不展开每个 HTTP 接口、数据层多库与安全通道协议细节；这些见 [routes.md](./routes.md)、[data-layer.md](./data-layer.md)、[topics/security.md](../topics/security.md)。
---
## 详细说明

### 1. 表格与历史

#### [`services/tableService.js`](../../../student-backend/services/tableService.js) · 表格服务
- **定位**：学生表与班费表共用的动态列表格逻辑，被 [`routes/dynamicTable.js`](../../../student-backend/routes/dynamicTable.js) 包成 `REST`（用 URL + HTTP 方法表达资源操作的接口风格）。
- **导出**：`queryAll`（查全部）、`insertRow`（插入行）、`updateRow`（更新行）、`deleteRow`（删除行）、`moveRow`（移动行）、`addColumn`（新增列）、`deleteColumn`（删除列）、`reorderRows`（重排行）、`moveColumn`（移动列）、`importRows`（批量导入）、`renameColumn`（重命名列）。
- 内部：列元数据存 `table_meta.sort_order`（表元数据表的排序列）；`importRows` 自动补建缺失列并 `transaction`（事务）插入；`insertRow` 支持 `atPosition`（插入位置）与 `minCount`（最少行数）。
- **注意事项**：列名正则白名单，保留字段 `id/position/atPosition` 不可直接写；至少保留一个数据列。

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
- **导出**：`validateRow`、`assertLeaveWindow`（请假时间窗与 SQL 时间戳）、`assertSeatRefs`（座位引用）、`assertDutyRefs`（值日引用）。
- 被对应路由写操作前调用；`assertDutyRefs` 的单模式根分支是刻意兼容，勿删。

#### [`services/dutyCells.js`](../../../student-backend/services/dutyCells.js) / [`services/dutyMode.js`](../../../student-backend/services/dutyMode.js) · 值日单元格工具
- `dutyCells`：值日单元格/姓名引用工具，导出 `DUTY_MODES`、`dutyRoots`、`countDutyRefs`、`removeDutyName`、`renameDutyName`。
- `dutyMode`：模式打包解包，导出 `MODES`、`toModeMap`、`unpackMode`、`packMode`、`normalizeMode`；**`items` 为空必须回数组**（契约被单测钉住）。

### 2. 学生与账号

#### [`services/studentRelations.js`](../../../student-backend/services/studentRelations.js) · 学生引用维护
- **定位**：学生删除/改名时的引用维护（分组、座位、值日、分数、班干部、请假等）。
- **导出**：`studentRelations`、`purgeStudentRelations`、`collectSeatRefs`。
- **调用方**：动态表删行、账号改名。

#### [`services/studentRename.js`](../../../student-backend/services/studentRename.js) · 学生改名级联
- **定位**：学生姓名变更的级联更新（跨表改引用）。
- **调用方**：`routes/dynamicTable.js` 的 `PUT`、`students` 改名路径。

#### [`services/provisionalStudents.js`](../../../student-backend/services/provisionalStudents.js) · 临时学生建档
- **定位**：名册外姓名自动建档（AI/表格里输入未登记姓名时生成「临时学生」）。
- **导出**：`resolveOne`、`resolveNames`、`ensureProvisionalStudent`。
- **调用方**：`app.js`、AI 执行器。

#### [`services/pendingRegs.js`](../../../student-backend/services/pendingRegs.js) · 注册草稿暂存
- **定位**：注册草稿（抄写恢复密钥前）暂存与清理。
- **导出**：`PENDING_TTL_MS`、`PENDING_MAX`、`put`、`get`、`remove`、`size`。
- **调用方**：`routes/auth.js`。

#### [`services/sessions.js`](../../../student-backend/services/sessions.js) · 登录会话
- **定位**：登录会话（sid）登记与失效。
- **导出**：`create`、`has`、`revoke`。
- **调用方**：`middleware/auth.js`、`routes/auth.js`（登出）。

#### [`services/recoveryKey.js`](../../../student-backend/services/recoveryKey.js) · 恢复密钥
- **定位**：中文恢复密钥。
- **导出**：`pickPhrase`（512 字池取 12 字）、`deriveRestoreHash`（`sha256('restore:'+phrase)`）、`normalizePhrase`（只留汉字，兼容序号/空格）、`formatPhrase`、`safeEqualHash`（常数时间）。
- **调用方**：注册、改恢复密钥、找回密码、备份解密。

#### [`services/usernameRules.js`](../../../student-backend/services/usernameRules.js) / [`services/bcryptAsync.js`](../../../student-backend/services/bcryptAsync.js) · 用户名规则
- `usernameRules`：用户名合法性/长度/保留字。
- `bcryptAsync`：`hash` / `compare` Promise 化，避免同步 bcrypt 阻塞事件循环（实测同步版 56~65ms/次）。

### 3. 安全与文件

#### [`services/secureChannel.js`](../../../student-backend/services/secureChannel.js) · 安全通道
- **导出**：`initMaster`、`hasMaster`、`sessionCount`、`genServerEphemeral`、`deriveEcdhShared`、`deriveSessionKey`、`seal`、`open`、`performHandshake`、`getSessionKey`、`destroySession`、`bindAuth`、`getBoundAuth`、`unbindAuth`、`requestDecrypt`、`responseEncrypt`、`SESSION_TTL_MS`。
- 模块加载时 `initMaster(process.env.SECURE_MASTER)`；无 master 时全部降级为明文直通。
- 与前端 [`composables/secureChannel.js`](../../../student-frontend/src/composables/secureChannel.js) 参数一一对应。

#### [`services/sanitize.js`](../../../student-backend/services/sanitize.js) · 数据清洗
- **定位**：所有写接口的统一清洗/校验（字符串裁剪、类型归一、数组/JSON 结构校验、座位扁平→二维等）。
- **导出**：常量 `MAX_TEXT_LEN`、`MAX_JSON_LEN`、`SEAT_MAX_ROWS`、`SEAT_MAX_COLS`、`COLUMN_RULES`，以及 `cleanText`、`cleanByType`、`cleanDocValue`、`cleanPath`、`normBool`、`normNumber`、`normInt` 等清洗函数。
- **注意事项**：`sanitize seats` 的「扁平→二维」是刻意兼容，不要删。

#### [`services/unzipSafe.js`](../../../student-backend/services/unzipSafe.js) · 安全解压
- **定位**：自研安全解压（拦截符号链接、路径穿越、绝对路径、反斜杠）。
- **调用方**：备份恢复、字体/资源导入。

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
| [`albumScan.js`](../../../student-backend/albumScan.js) | 扫描引擎（主/子进程共用）：递归收集、断点推进、缩略图、批量写库、暂停等待 | `collectMediaFiles`、`fullScan`、`incrementalScan`、`refreshVirtual`、`resolvePhotoDate`、`genThumb`、`createThumbWriter`、`claimScanTask`、`waitWhilePaused` |
| [`scanWorker.js`](../../../student-backend/scanWorker.js) | 扫描子进程生命周期与 IPC（懒启动、空闲 60s 退出、崩溃限流重建） | `dispatchScan`、`dispatchResume`、`requestStop`、`requestPause`、`forwardDemand`、`lockDb`、`shutdown`、`killNow` |
| [`worker.scan.js`](../../../student-backend/worker.scan.js) | 子进程本体（按 IPC 跑扫描与补图队列） | 无导出 |
| [`albumThumbs.js`](../../../student-backend/albumThumbs.js) | 缩略图按库隔离 + 64MB LRU + 批量二进制读取 | `thumbPathFor`、`rememberThumb`、`lookupThumb`、`readThumb`、`readThumbBatch` |
| [`albumExif.js`](../../../student-backend/albumExif.js) | EXIF/XMP 拍摄时间（读不到就是空串，**不拿 mtime 冒充**） | `readExifDate`、`normalizeExifDate`、`readExifBuf`、`readXmp`、`readExifDetail` |
| [`albumOps.js`](../../../student-backend/albumOps.js) | 回收站移入/恢复、删缩略图 | `TRASH_DIR`、`trashPathFor`、`moveToTrash`、`restoreToOriginal`、`deleteThumb` |

### 5. 通用工具（`utils/`）

| 文件 | 职责 | 导出 |
| --- | --- | --- |
| [`utils/date.js`](../../../student-backend/utils/date.js) | 本地日期字符串 | `pad2`、`localDateStr`、`todayStr` |
| [`utils/json.js`](../../../student-backend/utils/json.js) | JSON 安全读写 | `safeJson`、`readDocJson` |
| [`utils/sql.js`](../../../student-backend/utils/sql.js) | SQL 辅助 | `now`、`isDateStr`、`cleanUp`、`maxPosition`、`buildInsert`、`buildUpdate` |

---
## 注意事项

- 公共逻辑一旦被两个以上路由使用就下沉到 `services/`，路由只做参数校验与编排。
- 所有写库入口必须先过 `sanitize`；所有跨表引用变更走 `studentRelations` / `studentRename`。
- 扫描不再与 HTTP 共用进程：sharp 的 libuv 线程池是**进程级**的，只有 fork 才有独立池。
- `fullScan` 先收齐清单、最后才删清单外的行；`collectMediaFiles` 返回 `null` 表示被中断，禁止兜成空数组（会删光索引）。
- 断点用**文件路径**（增量）或**行 id**（虚拟相册），不用序号。
- `state` 只由主进程写，`token` 标识本次扫描归属（防止旧扫描删掉新扫描记录）。
- `INSERT OR IGNORE` 冲突时 `lastInsertRowid` 不可靠，必须回查真实 id。
- 缩略图版本 `THUMB_VERSION` 与前端 `ALBUM_THUMB_VERSION` 必须同时 +1。
