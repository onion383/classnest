# 后端（`student-backend/`）

Express 5 服务，由主进程 `child_process.fork`（创建 Node 子进程）拉起为独立子进程，仅监听 `127.0.0.1`（本机回环地址；端口取 `PORT`（后端监听端口环境变量），默认 3000），数据存放在本地加密 `SQLite`（嵌入式数据库）。

本文件按「整体机制 → 逐文件清单 → 维护规则」组织：整体机制讲跨文件的运行标准，逐文件清单讲单个文件的实现细节，维护规则讲新增/修改时必须遵守的约束。

---
## 一、后端整体机制

### 1. 后端职责与运行方式

- 提供全部业务 `HTTP`（超文本传输协议）接口（`/api/*`，业务接口前缀）、静态资源（`/uploads`、`/api/background`）与安全通道握手（`/api/secure`）。
- 每个请求经 `JWT`（JSON Web Token，登录令牌）鉴权后通过 `AsyncLocalStorage`（异步上下文存储，简称 `ALS`）绑定到「当前班主任的加密库」。
- 启动完成后向父进程 `process.send({ type:'backend-ready', port })`（向主进程发送「后端就绪」消息）；之后响应 `ping`（心跳）、接受 `mem-report`（内存报告）/ `gc-report`（垃圾回收报告）查询。
- 关键环境变量：`DB_MASTER_KEY`（数据库主密钥，缺省即抛错）、`SECURE_MASTER`（安全通道主密钥，缺失则降级为明文）、`JWT_SECRET`（JWT 签名密钥）、`DATA_DIR`（数据目录）、`AI_SKILLS_DIR`（AI 技能目录）、`PORT`（后端监听端口）。

### 2. 后端启动与初始化时序

入口：[`app.js`](../../../student-backend/app.js)。

1. 顶部加载 `db`（数据库入口）→ `dbManager`（多库管理器，解析 `DB_MASTER_KEY`）→ `services/secureChannel`（安全通道服务，读 `SECURE_MASTER`），并立即挂载登录必需路由 `routes/auth`、`routes/account`。
2. 中间件顺序：`cors()`（跨域资源共享中间件）→ Host（请求主机头）校验（仅放行 `localhost` / `127.0.0.1` / `[::1]`，否则 `403`（禁止访问））→ `express.json({ limit:'200mb' })`（JSON 请求体解析，上限 200MB）→ `requestDecrypt`（请求解密）+ `responseEncrypt`（响应加密）（仅当 `hasMaster()`（存在主密钥））→ `/api/secure`（安全通道）握手。
3. 静态鉴权：`/uploads`、`/api/background` 经 `authStatic()`（静态资源鉴权，只校验 token 不校验角色）后托管 `dbManager.uploadsDir`（上传目录）/ `backgroundDir`（背景图目录）。
4. 路由分两批：关键路由（登录即可用）同步挂载；其余在 `listen`（监听端口）回调里用 `setImmediate`（下一轮事件循环执行）逐个 `require`（加载模块）并挂载（把 `sharp`（图像处理库）/ `pdf-parse`（PDF 解析库）等重依赖的加载推到就绪信号之后）。
5. `app.listen(port, '127.0.0.1')`（监听本机端口）成功后上报 `backend-ready`（后端就绪），再 `setImmediate` 调 `dbManager.warmup()`（后台暖机）。
6. `init.js` 不是初始化脚本，只导出 `mapType(sqlType)`（SQL 类型 → 中文类型名）；真正的建表在 [`schema/schema.js`](../../../student-backend/schema/schema.js) 的 `initSchema`（初始化表结构）。

### 3. 后端鉴权与安全

- **`JWT`（JSON Web Token，登录令牌）**（[`middleware/auth.js`](../../../student-backend/middleware/auth.js)）：密钥优先 `JWT_SECRET`（JWT 签名密钥，≥16 字符），否则读 `DATA_DIR/.jwt-secret`（不存在则生成并持久化）；Token 解析顺序 `Authorization: Bearer`（请求头）→ `Cookie: token=`（Cookie）→ `?token=`（查询参数）；`auth(requiredRoles)`（鉴权中间件，校验角色）后 `dbManager.withDb(user.dbSlug || 'default', next)`（绑定当前库并继续）；业务接口普遍 `auth(['teacher'])`（只允许教师角色）；`authStatic()`（静态鉴权）只校验有效性。
- **令牌载荷**：`{ userId, username, role, dbSlug }`（用户 ID / 用户名 / 角色 / 库标识），有效期 7 天；登录同时写 `token` `Cookie`（`httpOnly`（禁止脚本读取）、`sameSite=lax`（同站宽松策略））。
- **安全通道**（[`services/secureChannel.js`](../../../student-backend/services/secureChannel.js)）：仅当 `SECURE_MASTER`（安全通道主密钥）存在时启用；握手 `POST /api/secure/handshake`，`ECDH P-256`（椭圆曲线密钥交换）→ `HKDF-SHA256`（密钥派生，`campus-secure-v1` 为上下文）→ `AES-256-GCM`（对称加密与认证）；会话 `TTL`（有效期）15 分钟；请求体 `{ session, d }`（会话标识 + 密文数据），响应 `{ d }`；豁免 `/api/secure`、`/uploads`、`/api/background`；非密文请求明文放行。
- **Host/CORS**（请求主机头 / 跨域资源共享）：只监听回环地址，Host 头非白名单一律 `403`（禁止访问）。
- **列名/表名**：动态列走 `tableService`（表格服务）正则白名单；直接拼 `SQL`（结构化查询语言）的路由用固定集合或 `PRAGMA table_info`（读取表结构）校验。

### 4. 后端错误处理与日志

- 路由内校验失败返回 `4xx`（客户端错误状态码）+ `{ error }`（错误信息）；统一错误中间件在最末捕获，避免把栈信息回传给前端。
- 后端日志由主进程重定向到 `userData/data/backend.log`（Electron 用户数据目录下的后端日志）；启动阶段关键节点打印 `[boot] +Nms ...`（启动日志前缀 + 毫秒）供启动计时对齐。
- 关闭信号：`app.js` 在 `process.on('exit')`（进程退出事件）调 `scanWorker.shutdown()`（关闭扫描子进程），避免 `fork`（创建）出的扫描进程变成孤儿。

### 5. 后端路由前缀 ↔ 前端页面

| 前缀                                  | 后端文件                                                                    | 前端页面                                                |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| `/api`（登录/注册/恢复）                    | [routes/auth.js](./routes.md)                                           | `Login`（登录）、`Setup`                                 |
| `/api/account`                      | [routes/account.js](./routes.md)                                        | `SettingsView`（系统设置）、`Migration`（数据库迁移）             |
| `/api/students`、`/api/fee-records`  | [routes/dynamicTable.js](./routes.md)                                   | `ClassroomView`（学生管理）、`FeeManagement`（班费管理）         |
| `/api/schedule`                     | [routes/schedule.js](./routes.md)                                       | `ScheduleView`（课程表）                                 |
| `/api/seats`                        | [routes/seats.js](./routes.md)                                          | `SeatView`（座位管理）                                    |
| `/api/duty`                         | [routes/duty.js](./routes.md)                                           | `DutyView`（卫生值日）                                    |
| `/api/leaves`                       | [routes/leaves.js](./routes.md)                                         | `LeaveManagement`（请假管理）                             |
| `/api/scores`                       | [routes/scores.js](./routes.md)                                         | `ScoreManagement`（加分管理）                             |
| `/api/group-manage`                 | [routes/groupManage.js](./routes.md)                                    | `GroupManageView`（分组管理）                             |
| `/api/activities`、`/api/countdowns` | [routes/activities.js](./routes.md)、[routes/countdowns.js](./routes.md) | `ActivitiesView`（班级活动）                              |
| `/api/cadres`                       | [routes/cadres.js](./routes.md)                                         | `ClassroomView`（班干部 Tab）                            |
| `/api/album`                        | [routes/album.js](./routes.md)                                          | `AlbumView`（班级相册）                                   |
| `/api/ai`                           | [routes/ai/ai.js](./routes.md)                                          | `AiAssistant`（详见 [topics/ai.md](../topics/ai.md)）   |
| `/api/undo`                         | [routes/undo/undo.js](./routes.md)                                      | 全应用（横切）                                             |
| `/api/search`                       | [routes/search.js](./routes.md)                                         | 全局搜索                                                |
| `/api/dashboard`                    | [routes/dashboard.js](./routes.md)                                      | `DashboardView`（概览首页）                               |
| `/api/widget-settings`              | [routes/widgetSettings.js](./routes.md)                                 | `DashboardView`（概览首页）、`SettingsView`（系统设置）、工具箱/桌面组件 |

---

## 二、后端逐文件清单

<!-- doc-tree:start -->
### 1. 后端目录树

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-backend/
    ├── dbManager/
    │   ├── dbManager.account.js  # 账号解析、注册/改名/恢复、登记表读写
    │   ├── dbManager.backup.js  # 导出/恢复备份、加密↔明文转换
    │   ├── dbManager.base.js  # 目录解析、主密钥派生、建/删账号库、暖机
    │   ├── dbManager.conn.js  # 连接 LRU（最近最少使用）缓存、withDb（绑定请求库并执行）/ current（当前库…
    │   ├── dbManager.js  # 门面与导出汇总
    │   ├── dbManager.memory.js  # AI 记忆目录
    │   └── dbManager.skills.js  # AI 技能目录
    ├── middleware/
    │   └── auth.js
    ├── schema/
    │   └── schema.js
    ├── services/
    │   └── secureChannel.js
    ├── albumExif.js  # EXIF（照片拍摄元数据）/ XMP（可扩展元数据）拍摄时间解析
    ├── albumOps.js  # 相册文件操作（回收站/恢复/删缩略图）
    ├── albumScan.js  # 扫描引擎（主/子进程共用）
    ├── albumThumbs.js  # 缩略图缓存（按库隔离 + 内存 LRU（最近最少使用缓存）+ 批量读）
    ├── app.js
    ├── db.js  # 统一数据库入口（Proxy（代理对象）转发到当前请求库）
    ├── init.js  # SQL 类型名映射
    ├── scanWorker.js  # 扫描子进程管理（fork（创建子进程）/派活/暂停/空闲退出/崩溃重建）
    └── worker.scan.js  # 扫描子进程本体（IPC（进程间通信）协议）
```
<!-- doc-tree:end -->

### 2. 目录与入口

| 位置                                 | 内容                                                                                            | 详见                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 根目录入口                              | `app.js`（应用装配与启动）、`init.js`（SQL 类型名映射）                                                        | [2. 后端启动与初始化时序](#2.-后端启动与初始化时序)                        |
| 根目录数据入口                            | `db.js`（统一数据库入口）                                                                              | [data-layer.md](./data-layer.md)                       |
| 根目录媒体/扫描                           | `albumOps.js`、`albumThumbs.js`、`albumExif.js`、`albumScan.js`、`scanWorker.js`、`worker.scan.js` | [services.md](./services.md)                           |
| `dbManager/`                       | 多库、连接、账号、备份、AI 目录                                                                             | [data-layer.md](./data-layer.md)                       |
| `schema/`                          | 建表与迁移                                                                                         | [data-layer.md](./data-layer.md)                       |
| `routes/`                          | HTTP 接口与处理链                                                                                   | [routes.md](./routes.md)                               |
| `services/`、`utils/`、`middleware/` | 公共能力、安全通道、清洗、工具、鉴权                                                                            | [services.md](./services.md)、[3. 后端鉴权与安全](#3.-后端鉴权与安全) |

根目录媒体 / 扫描文件的分工：`albumOps.js`（相册回收站与缩略图删除）、`albumThumbs.js`（按库隔离的缩略图缓存）、`albumExif.js`（拍摄时间读取）、`albumScan.js`（扫描引擎，主 / 子进程共用）、`scanWorker.js`（扫描子进程生命周期）、`worker.scan.js`（子进程本体）。

---

## 三、后端维护规则

- 新增业务路由必须挂在 `auth(['teacher'])`（鉴权中间件，只允许教师角色）之后，否则 `db` Proxy（数据库代理对象，按当前库转发查询）会抛「未绑定数据库连接」。
- 每次写操作要同步登记撤销记录（见 [routes.md](./routes.md) 撤销小节），否则 `Ctrl+Z`（撤销快捷键）无效。
- 新增表同时补 `schema/`（建表定义目录）与迁移（`CREATE TABLE IF NOT EXISTS`（表不存在才创建）+ `ALTER TABLE ADD COLUMN`（缺列时补列））；打开连接即执行 `initSchema`（建表 / 补列初始化函数），存量库自动迁移。
- 共享目录（`uploads/`（上传文件目录）、缩略图、回收站）不随删账号清理。

---
