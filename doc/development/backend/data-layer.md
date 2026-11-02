# 后端数据层（加密 SQLite / 多库）

## 本篇涉及的文件

只展示本篇会讲到的代码文件；其余后端文件见 [backend/README.md](./README.md) 的逐文件清单。

```text
student-backend/
├── db.js                          # 统一入口：db 代理、getFields、renumber
├── dbManager/
│   ├── dbManager.js               # 门面：汇总导出 + 目录常量
│   ├── dbManager.base.js          # 主密钥派生、建/删账号库、initSchema 调用、暖机
│   ├── dbManager.conn.js          # 连接缓存与请求绑定
│   ├── dbManager.account.js       # 账号 / 登记表
│   ├── dbManager.backup.js        # 备份包导出/恢复、库钥匙包裹、加密转换
│   ├── dbManager.memory.js        # AI 长期记忆目录（固定位置）
│   └── dbManager.skills.js        # AI 技能 md 目录（可搬迁）
├── schema/
│   ├── schema.js                  # initSchema 入口：统一建表 + 迁移
│   ├── schema.core.js             # 学生、表元数据、用户、待处理请求
│   ├── schema.fee.js              # 班费
│   ├── schema.leave.js            # 请假
│   ├── schema.score.js            # 分数
│   ├── schema.schedule.js         # 课程表槽位与只读视图
│   ├── schema.seat.js             # 座位槽位与只读视图
│   ├── schema.duty.js             # 值日槽位与只读视图
│   ├── schema.history.js          # 三域历史合并 + 历史只读视图
│   ├── schema.group.js            # 分组维度 / 小组 / 成员
│   ├── schema.cadre.js            # 班干部职务与成员
│   ├── schema.activity.js         # 活动、倒计时
│   ├── schema.album.js            # 相册、照片、扫描任务
│   ├── schema.ai.js               # AI 配置、模型、会话、消息、快照
│   ├── schema.undo.js             # 撤销历史
│   └── schema.widget.js           # 桌面小组件设置
└── services/
    └── slotStore.js               # 物理槽位写入（逻辑名视图只读）
```

---

## 综合概述

- **定位**：后端数据层（加密 SQLite / 多库），覆盖 `db.js`（数据库统一入口）、`dbManager/`（多库管理目录）、`schema/`（建表定义目录）与备份 / 加密转换。
- **公共逻辑**：每个请求经 `dbManager.withDb`（按当前班主任库执行回调的包装函数）绑定当前库；主密钥包裹 / 解包库钥匙；`initSchema`（建表与补列的初始化函数）每次打开连接执行建表与迁移；备份包与库加密转换按固定顺序执行。
- **局限**：不展开 HTTP 路由、业务规则与安全通道协议；这些见 [routes.md](./routes.md)、[services.md](./services.md)、[topics/security.md](../topics/security.md)。

---

## 详细说明

### 1. 总览

```mermaid
flowchart LR
  A["请求"] --> B["auth（鉴权）中间件"]
  B --> C["dbManager.withDb(slug, next)（绑定当前库并继续）"]
  C --> D["AsyncLocalStorage（异步上下文存储）写入当前 slug"]
  D --> E["db.js 的 db Proxy（代理对象）"]
  E --> F["dbManager.current()（当前库）"]
  F --> G["getConn(slug)（取连接，LRU（最近最少使用缓存））"]
  G --> H["better-sqlite3-multiple-ciphers（加密 SQLite 驱动）"]
```

- 驱动：`better-sqlite3-multiple-ciphers`（`SQLCipher`（加密 SQLite 扩展）兼容），在 dbManager 中**懒加载**，缩短就绪时间。
- 目录：`DATA_DIR`（默认 `userData/data`，可由 `app-config.json` 覆盖）下的 `index.db`、`<slug>.db`、`.jwt-secret`、`db-master.key`、`album-thumbs/`、`album-trash/`。

### 2. [`db.js`](../../../student-backend/db.js) · 统一入口

- 导出 `db`（`Proxy`（代理对象））：`prepare`（预编译语句）/ `exec`（执行 SQL）/ `transaction`（事务）等访问转发到 `dbManager.current()` 的当前请求库连接。
- 导出 `getFields(tableName)`（取列元数据）与 `renumber(tableName)`（重排行 `position`）。
- **注意事项**：未绑定库（没走 `auth`）时 `current()` 直接抛「未绑定数据库连接」。

### 3. [`dbManager/`](../../../student-backend/dbManager/dbManager.js) · 七个模块

| 文件                                                                                | 职责                                   | 关键导出                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dbManager.js`](../../../student-backend/dbManager/dbManager.js)                 | 门面：汇总导出 + 目录常量                       | `dataDir`（数据根目录）/ `uploadsDir`（上传图片目录）/ `backgroundDir`（背景图目录）/ `thumbsDir`（相册缩略图目录）/ `trashDir`（相册回收站目录）                                                                                           |
| [`dbManager.base.js`](../../../student-backend/dbManager/dbManager.base.js)       | 主密钥派生、建/删账号库、`initSchema` 调用、暖机      | `ensureIndex`（确保登记库存在）、`createTeacher`（新建班主任库）、`deleteTeacher`（删除班主任库）、`warmup`（启动暖机）、`convertDbEncryption`（库加密/明文转换）                                                                            |
| [`dbManager.conn.js`](../../../student-backend/dbManager/dbManager.conn.js)       | 连接缓存与请求绑定                            | `withDb`（绑定当前请求的库并执行回调）、`current`（当前请求的库连接）、`currentSlug`（当前库标识）、`evictConn`（驱逐连接缓存）                                                                                                            |
| [`dbManager.account.js`](../../../student-backend/dbManager/dbManager.account.js) | 账号/登记表                               | `resolveByUsername`（按账号定位库）、`resolveByDbFile`（按库文件定位账号）、`registryFindByUsername`（按账号查登记）、`registryList`（列出登记项）、`registryUpsert`（写入/更新登记）、`registrySetEncrypted`（更新加密标记）、`registryDelete`（删除登记）、`registryRename`（登记改名） |
| [`dbManager.backup.js`](../../../student-backend/dbManager/dbManager.backup.js)   | 备份包导出/恢复、库钥匙包裹                       | `wrapKey`（主密钥包裹库钥匙）、`unwrapKey`（主密钥解包库钥匙）、`wrapKeyBySecret`（用密码/助记词包裹库钥匙）、`decryptBundleKey`（解包备份中的库钥匙）、`exportBundle`（取出备份所需的库文件与钥匙）、`restoreBundle`（用备份数据重建库并登记）                               |
| [`dbManager.memory.js`](../../../student-backend/dbManager/dbManager.memory.js)   | AI 长期记忆目录（固定位置，不可搬迁）                 | `memoryDir`（AI 长期记忆目录）                                                                                                                           |
| [`dbManager.skills.js`](../../../student-backend/dbManager/dbManager.skills.js)   | AI 技能 md 目录（`AI_SKILLS_DIR`，可在设置页搬迁） | `skillsDirRoot`（AI 技能文件根目录）                                                                                                                      |

### 4. 库与密钥体系

- `index.db`：主密钥加密的**登记表**（`registry`：slug / username / wrapped_key / encrypted / created_at）。
- `<slug>.db`：每位班主任一个自含加密库（业务数据 + 设置 + `users` 同行），slug 形如 `@` + 12 位十六进制。
- 主密钥 `DB_MASTER_KEY`（Electron 主进程首启生成，经 `safeStorage`（Electron 安全存储）/ `DPAPI`（Windows 数据保护接口）持久化后随 `fork`（创建子进程）注入）→ `sha256`（安全哈希）派生 `WRAP_KEY`（包裹密钥）→ `AES-256-GCM`（对称加密 + 完整性认证）包裹/解包库密钥（`wrapKey`（包裹钥匙）/ `unwrapKey`（解包钥匙））。
- 便携备份另用「用户密码 / 助记词」派生钥匙包裹库密钥（`wrapKeyBySecret` / `decryptBundleKey`），备份包不依赖本机主密钥。
- 明文库（`encrypted=0`）不下发 `PRAGMA key`，`wrapped_key` 为空串占位。
- 连接上限 `CONN_CACHE_MAX = 10`（`LRU`（最近最少使用）驱逐）；`PRAGMA`（SQLite 配置命令）：`busy_timeout=5000`（忙等超时 5 秒）、`journal_mode=WAL`（预写日志模式）、`synchronous=NORMAL`（普通同步级别）、`cache_size=-20000`（页缓存大小）、`temp_store=MEMORY`（临时数据放内存）。

### 5. 表结构（[`schema/`](../../../student-backend/schema/schema.js)）

`initSchema(conn)` 对任一班主任库建表，全部 `CREATE TABLE IF NOT EXISTS`；每次打开连接都会执行，因此存量库自动迁移。

| 文件 | 主要表 |
| --- | --- |
| [`schema.core.js`](../../../student-backend/schema/schema.core.js) | `students`（学生）、`table_meta`（表元数据）、`users`（用户）、`pending_requests`（待处理请求） |
| [`schema.fee.js`](../../../student-backend/schema/schema.fee.js) / [`schema.leave.js`](../../../student-backend/schema/schema.leave.js) / [`schema.score.js`](../../../student-backend/schema/schema.score.js) | 班费、请假、分数 |
| [`schema.schedule.js`](../../../student-backend/schema/schema.schedule.js) / [`schema.seat.js`](../../../student-backend/schema/schema.seat.js) / [`schema.duty.js`](../../../student-backend/schema/schema.duty.js) | 物理槽位表 `*_slots`（按 kind 分行）+ 逻辑名只读视图（`schedule` / `master_schedule` / `duty_layout` / `seat_template` 等），写入走 [`services/slotStore.js`](../../../student-backend/services/slotStore.js) |
| [`schema.history.js`](../../../student-backend/schema/schema.history.js) | `domain_history`（三域历史合并）+ `schedule_history` / `duty_history` / `seat_history` 只读视图 |
| [`schema.group.js`](../../../student-backend/schema/schema.group.js) | 分组维度/小组/成员 |
| [`schema.cadre.js`](../../../student-backend/schema/schema.cadre.js) | 班干部职务与成员 |
| [`schema.activity.js`](../../../student-backend/schema/schema.activity.js) | 活动、倒计时 |
| [`schema.album.js`](../../../student-backend/schema/schema.album.js) | `albums`（相册）、`album_photos`（相册照片，含 `exif_date`（拍摄时间）/ `date_src`（时间来源）/ `thumb_v`（缩略图版本））、`album_scan_tasks`（扫描任务） |
| [`schema.ai.js`](../../../student-backend/schema/schema.ai.js) | AI 配置、模型、会话、消息、快照 |
| [`schema.undo.js`](../../../student-backend/schema/schema.undo.js) | `undo_history`（撤销历史） |
| [`schema.widget.js`](../../../student-backend/schema/schema.widget.js) | `widget_settings`（含 `desktop_apps` / `class_info`） |

迁移方式：`PRAGMA table_info` → 缺列时 `ALTER TABLE ADD COLUMN`；表级差异用 `ensureTableWithMigration`；索引 `CREATE INDEX IF NOT EXISTS` 幂等。

### 6. 备份与加密转换

- 备份包 v2：`encrypted` 标记来源是否加密库；`key`（明文库钥匙）/ `wrappedByPassword` / `wrappedByMnemonic` 三选一，`decryptBundleKey` 按「明文 key → 密码 → 助记词」顺序尝试。
- `convertDbEncryption(slug, encrypt, onProgress)` 严格顺序：关连接 → 退 WAL → 完整性预检 → 备份 → rekey → 转换后校验 → 回写登记 → 删备份；任一步失败从备份回滚，不留中间态。接口以 NDJSON 流上报步骤进度。
- 删除账号不清理共享目录（`uploads/`、缩略图、回收站）。

---

## 注意事项

- 不要提前于 `app ready`（Electron 应用就绪事件）读取 `DB_MASTER_KEY`（数据库主密钥）：`safeStorage`（Electron 安全存储）在 Windows 上就绪后才可用，否则会误生成随机新密钥，导致旧库打不开。
- 改库密钥 / 目录前先 `backend.stopBackendProcess()`（停止后端子进程），等进程真正退出再操作（Windows 上文件句柄释放有延迟）。
- 新增列必须同时更新 `initSchema`（建表 / 补列的初始化函数）与相关路由的 `INSERT`（写库语句）/ `UNDO`（撤销载荷），否则移动、撤销会丢字段（如相册的 `exif_date`（拍摄时间）/ `date_src`（时间来源））。

---
