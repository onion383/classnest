# 单元测试（`testjs/units/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── units/
        ├── account/
        │   ├── auth-policy.test.js  # 登录保持天数（按账号）：默认 30 天、按账号隔离、派生值自洽（续签窗口必须 < 天数、名单清理期必须 > token 寿命）、改名搬迁、坏文件退回默认
        │   ├── auth-sync.test.js  # 跨窗口登录态同步（v6 · 2-3b）：滑动续期只换 token 不算换人；换号/登出先清用户级缓存再广播 AUTH_CHANGED_EVENT，三个窗口入口共用一份判定
        │   ├── account-data-dialog.test.js  # 查看 AI 记录时管理弹窗必须保留、聊天记录弹窗层级更高
        │   ├── login-contrast.test.js  # 登录页文字对比度按 WCAG 现算：登录页直接压在背景图上、卡片是半透明玻璃，换背景图就可能…
        │   ├── login-file-picker.test.js  # 「从数据库登录」是唯一的文件入口：渲染层一个 按扩展名分派，不再有第二个「从备份包恢复」按钮
        │   ├── session-revocation.test.js  # 凭证变更 → 全账号会话失效（A1-16）：账号维度必须是 (userId, dbSlug)…
        │   ├── sessions-ttl.test.js  # 会话名单的活动时间与清理（V5-009）：at 改为最后一次活动时间（1 小时节流落盘），否…
        │   ├── token-renewal.test.js  # 滑动续期「换代即作废」（X2-08）：响应合法，唯一线索是「发请求时是哪一代」；代次不符一律…
        │   ├── user-scoped-race.test.js  # 换号后在途请求不得写回（V5-004）：请求发出时记登录代次，响应回来代次变了就丢弃并重拉
        │   ├── account-delete-all-classes.test.js  # 删账号销毁全部班级（1-11 / #4）
        │   ├── account-rename-visibility.test.js  # 多班改名后其它班仍列在登录列表（1-3 / H2）
        │   ├── auth-expired-clears-user.test.js  # 401 失效必须换「人」，不能只丢 token（v7 §5-2）
        │   ├── auth-recover-hash-sync.test.js  # 恢复改密必须同步账号权威哈希（1-1 / #3 / 独立 H1）
        │   ├── auth-recover-revoke-all.test.js  # 恢复改密吊销账号全部班级会话（1-2 / N1 / H7）
        │   ├── auth-recovery-rename-fallback.test.js  # 改名后本机恢复通道仍可用（2-2 / 第二轮 N4）
        │   ├── auth-user-store-sink.test.js  # users 表「登录前路径」的 SQL 出口判据
        │   ├── login-days-sign-key.test.js  # 登录保持天数签发键（2-3 / 第二轮 N3）
        │   ├── logout-toast.test.js  # 主动登出必须是「已退出登录」，不能变成红色「登录已过期」
        │   └── privacy-cache-invalidate.test.js  # 1-9 遗留：脱敏映射必须随库内数据自动失效
        ├── ai/
        │   ├── ai-doc-transaction.test.js  # AI 单块写入（POST /api/ai/doc）的「校验 + 快照 + 写入」同事务：校验…
        │   ├── ai-limits.test.js  # AI 链路的边界校验与预算闸门：①上游 tool_call 的空 id / 空 name /…
        │   ├── smart-group-student-id.test.js  # 智能分组写回同名定人：emit 带 id 矩阵（组:位置），写回按 id 落，同名两人不同组不合并
        │   ├── smart-group.test.js  # 智能分组算法（SmartGroupDialog.pipeline.js）的回归：这套算法此前…
        │   ├── ai-subagent-live.test.js  # 子助手轨迹实时下发、done 覆盖实时结构、缩进与聊天气泡复制豁免
        │   ├── ai-tool-evidence.test.js  # AI 工具调用证据跨轮可见 + 收尾对账（process_json 必须被读回）
        │   ├── mcp-forwarder-discovery.test.js  # MCP 转发器的后端地址发现：env → 端口发现文件 → 默认端口
        │   ├── ai-batch-cascade-undo.test.js  # AI 批量删学生的级联撤销（1-4 / 第二轮 N2）
        │   ├── ai-batch-rename-cascade.test.js  # AI 批量改学生姓名级联（3-1 / #44 / 独立 M2）
        │   ├── ai-busy-queue.test.js  # 忙碌队列丢附件 + 部分失败无法撤回（3-4 / #17）
        │   ├── ai-checks-read-scope.test.js  # 1-6 遗留：体检 / 冲突 / 指数工具的表级读闸门
        │   ├── ai-privacy-batch3.test.js  # AI 数据保护第 3 批：全出口补齐
        │   ├── ai-privacy-batch4.test.js  # AI 数据保护第 4 批：按表关闭 + web_search 拦截 + 前端设置
        │   ├── ai-privacy-batch5.test.js  # AI 数据保护第 5 批：电话宽松格式校验
        │   ├── ai-privacy-outbound.test.js  # 脱敏异常不发原文 + 附件文件名出站替换（1-9 / #1）
        │   ├── ai-privacy-wiring.test.js  # AI 数据保护第 2 批：存储开关 + 最小闭环接线
        │   ├── ai-privacy.test.js  # AI 数据保护第 1 批：纯模块判据，不接线、零行为变化
        │   ├── ai-read-scope-gate.test.js  # AI 读权限闸门覆盖派生读工具（1-6 / #38）
        │   ├── ai-rollback-busy.test.js  # 回退会话期间忙碌锁（3-3 / #40）
        │   ├── ai-score-seat-layout.test.js  # 4-9 / H4：AI 的 score_weights 座位指数
        │   ├── ai-stream-class-scope.test.js  # 切班后旧 AI 流不得在新班执行提案（3-2 / #39）
        │   ├── mcp-auto-exec.test.js  # 「自动执行提案」开关
        │   ├── mcp-cross-class-scope.test.js  # MCP 令牌跨班越权 + 限流原子性（2-10 / #8）
        │   ├── mcp-privacy-split.test.js  # 数据保护「分权」：AI 与 MCP 各一份配置
        │   ├── mcp-privacy.test.js  # U6：数据保护真正作用于 MCP 读写（不是假开关）
        │   ├── mcp-proposal-history.test.js  # 提案的「未处理 / 已处理」两栏与保留条数
        │   ├── mcp-rate-limit.test.js  # 方向 B：工具调用频率闸门
        │   ├── mcp-read-scope.test.js  # U7：按表「完全禁止 AI 读取」在 MCP 三处读入口强制执行
        │   ├── mcp-server.test.js  # 方向 B（班集作为 MCP 服务端）端到端验证
        │   ├── mcp-token-copy-status.test.js  # 复制失败不能提示成功（v7 §5-8 / #27b）
        │   ├── mcp-token-store.test.js  # U4：令牌明文可复制（明文存加密班级库，core 只留索引）
        │   └── smart-arrange-save-guard.test.js  # 智能排表保存失败不能提示成功（4-6 / #43）
        ├── album/
        │   ├── album-merge-undo.test.js  # 合并相册的撤销（Q2-09）：建新虚拟相册 + 复制照片索引 + 删掉全部源相册作为一条撤销…
        │   ├── albumScan.test.js  # 相册扫描的「索引被误删/清空」防护
        │   ├── media-credential.test.js  # 静态资源凭据（V5-005）：打包版页面是 file://，取图属跨站，SameSite=L…
        │   ├── photo-info-cache.test.js  # 相册信息缓存（v6 · 1-4）：200 条上限 LRU、命中刷新顺序、换号清空；AlbumView 不再自带无上限 Map
        │   ├── thumb-cache.test.js  # 缩略图缓存三层（合并自 thumb-batch / thumb-cache-policy / thumb-idle）：A 淘汰策略纯函数、B 批量接口失败与「服务端没这张」语义分离（失败不写状态、网络恢复自动拿到 blob）、C 空闲 2 秒收缩集成
        │   ├── album-grid-rows.test.js  # 组内按行虚拟裁剪的算术与接线
        │   ├── album-paging.test.js  # 日期索引 + 日期游标分页，与全量路径同源
        │   ├── album-photo-focus.test.js  # 首页配图点进相册定位到这一张
        │   ├── album-photo-pages.test.js  # 日期分页纯逻辑（日期步进 / 锚点 / 合并已加载组）
        │   ├── album-random-thumb.test.js  # 首页随机配图接口（exclude 退回、X-Photo-Id）
        │   ├── album-resize-throttle.test.js  # 改窗口时别打断正在生成的缩略图
        │   ├── album-scan-incremental-thumb.test.js  # 增量跳过已有 vs 全量无条件重建
        │   ├── album-scan-two-phase.test.js  # 全量扫描先建索引再补缩略图
        │   ├── album-thumb-priority.test.js  # 缩略图插队的粒度与中断
        │   ├── album-thumb-retry.test.js  # 缩略图 404 之后的自愈重试
        │   ├── album-virtual-all.test.js  # 虚拟相册整册全选（all_from 由后端展开）
        │   ├── thumb-purge.test.js  # 「清理图片微缩图」只删文件
        │   ├── thumb-sweep.test.js  # 「回收孤儿微缩图」的对账与删除
        │   └── album-delete-compensation.test.js  # 删除照片双写失败补偿（2-5 / #13）
        ├── backend/
        │   ├── api-proxy.test.js  # B1 的 /api 同源代理（v6 · 2-15）：只代 /api 与 /api/*、目标 URL 保留 query、方法/请求体/响应流透传、Host/Content-Length 被清理、后端不可达回 503
        │   ├── backend-origin.test.js  # B1 地址口径（v6 · 2-15）：apiBaseUrl 永远相对、mediaBaseUrl 打包补后端、三处调用方共用；app:// 协议代理 /api，主窗口/引导/挂件不再换源
        │   ├── api-paths.test.js  # 认证端点路径单一来源：前端 apiPaths.js 的每个常量都在后端真实路由里存在（防止又…
        │   ├── backend-boundary.test.js  # 写入边界与实际结构脱节：①PATCH /cell 是唯一不经过 normalizeSeats…
        │   ├── backend-consistency.test.js  # 跨库写补偿与信号透传：①PUT /username 的用户名存在两处（index.db 的 …
        │   ├── backend-date.test.js  # 后端日期工具（student-backend/utils/date.js）的回归。这些函数此…
        │   ├── backend-limits.test.js  # 无界资源与入口收敛：①ffmpeg 下载递归跟随重定向无次数上限 → 重定向环会无限递归爆栈…
        │   ├── backend-multiwrite.test.js  # 多步写的一致性保障：逐日/逐条的批量写若没有事务，中途失败会留下半截状态（补存留下部分快照、…
        │   ├── backend-sideeffect.test.js  # 校验阶段的副作用与文件+索引非原子：①assertDutyRefs 在校验阶段就写库（建临时…
        │   ├── backend.test.js  # 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、domai…
        │   ├── batch-delete.test.js  # 批量删除端点（v6 · 1-8）：一次 POST 删 N 条、position 重排、脏 id 整批回滚、minCount 不绕过、单条 DELETE 保留
        │   ├── backup-archive.test.js  # 备份包 v3「带全了哪些东西」（N2-02）：库三件套（含 -wal / -shm）+ 长期…
        │   ├── backup-restore.test.js  # 还原侧的「允许动现有文件的时机」：解包与逐项校验先做完（缺项 / 内容被改 / 名字不安全都…
        │   ├── backup-wal-roundtrip.test.js  # 备份一致性真库往返（v8 · 5-1 / N2-01）：连接常开+WAL尾页复现「刚编辑就备份」——checkpoint 并回主库、恢复侧回放 srcWal
        │   ├── db-size-probe.test.js  # 库体积探针（v6 · 0-4）：明文库读出 page_count/freelist、非法库标 encrypted、目录只认 .db、自证脚本能跑通
        │   ├── db-master-key.test.js  # 数据库主密钥 safeStorage 异步化（Electron 46 适配）的行为回归：①只…
        │   ├── get-share.test.js  # 通用 GET 在途共享（v6 · 1-7）：同 key 并发只发一次、TTL 复用/过期重发、换号旧响应作废、写操作只清缓存不取消在途、key 判定与上限淘汰
        │   ├── orphan-check.test.js  # 只读孤儿检查器的可信度（v6 §0-4）：一个「永远返回 0」的检查器最容易是假的，所以把 …
        │   ├── overview-endpoints.test.js  # 座位/值日首屏概览（P3-15）：overview 与各单端点逐字段一致、名册只含 id/姓名/学号、前端首屏 1 请求且失败回退
        │   ├── receipt-kind.test.js  # 收据 Office 文件打不开（4-1）：校验层按魔数分出 ooxml / ole，落库前必…
        │   ├── restore-bundle.test.js  # v2 恢复的完整性预检（V4-B05-13）：先写临时文件 → integrity_chec…
        │   ├── save-outcome.test.js  # save-file 三态判定（V5-002）：ok / fail / canceled 互斥…
        │   ├── schema-foreign-keys.test.js  # 外键声明（N2-03 第一步）：9 处 ON DELETE CASCADE 齐全、3 处（c…
        │   ├── search-limits.test.js  # 全局搜索分页（P3-08）：根因是没有分页而非上限太小 —— LIMIT ? OFFSET …
        │   ├── sequenced-cache.test.js  # 带账号代次的进程内缓存（P0-6）：TTL 复用 + 写入前核对代次 + 失败不缓存；inv…
        │   ├── single-flight.test.js  # 启动单飞守卫（P0-5）：并发调用只跑一次且拿到同一 Promise，同步副作用不延后微任务…
        │   ├── undo-batch-coverage.test.js  # 一次动作改多行必须整批可撤（Q2-04 / Q2-05 / Q2-06）：row_reord…
        │   ├── undo-cascade-same-tx.test.js  # 级联删除与撤销登记同事务（v8 · 5-2 / Q2-01）：删除后 undo_history 立即可见；登记失败连七处清理一起回滚
        │   ├── undo-recorder.test.js  # 撤销登记只能有一个入口（Q2-10）：失败必须弱提示、不许 .catch(() => {})…
        │   ├── leaves-paging.test.js  # 请假列表分页与「今日到班」范围
        │   ├── live-blocks.test.js  # AI 流式渲染按块缓存（切块不改变渲染结果）
        │   ├── undo-retention.test.js  # 撤销记录每 key 50 条上限
        │   ├── undo-sql-outlet.test.js  # 撤销域 4 个文件不许有裸 SQL（M12-B8）
        │   ├── undo-replay-sanitize.test.js  # 撤销回放前按列级规则清洗脏值（X3-06）
        │   ├── access-log.test.js  # 数据访问记录（schema.log.js / accessLogStore / 接口）
        │   ├── access-timeline-total.test.js  # 访问记录时间线的「条数口径」（#33）
        │   ├── backend-kill-tree.test.js  # 后端子进程必须整树清理，不留孙进程
        │   ├── backup-key-scrypt.test.js  # 备份包口令派生必须是有 salt 的 scrypt
        │   ├── cors-origin-null.test.js  # CORS 不许无条件信任 Origin: null（判定函数边界）
        │   ├── cors-mechanism.test.js  # CORS 白名单/暴露头固定机制：AST 抽产品配置 + 真 cors/express 请求，不写死源码文本
        │   ├── data-checks-dangling.test.js  # 数据体检的「孤立数据」规则
        │   ├── date-column-validation.test.js  # 日期列拒绝非法日期（4-2 / #61）
        │   ├── column-rules-ddl-parity.test.js  # 列级规则列名 ↔ 真 DDL（v8 · 5-3 / Q4-01⑤）：PRAGMA 取真列集，规则列拼错/DDL 改名即红
        │   ├── filter-present-identity.test.js  # 点名候选名单按 ID 排除请假，不按姓名（v7 §5-4 / #20）
        │   ├── fk-probe.test.js  # 外键探测（施工清单 P0-1）
        │   ├── import-transaction-rollback.test.js  # 导入失败不留孤儿临时学生（2-1 / #14 / 独立 M3）
        │   ├── not-found-404.test.js  # PUT/DELETE 不存在的 id 必须 404（4-3）
        │   ├── receipt-attach-rollback.test.js  # 收据关联写库失败要回滚弹窗列表（v7 §5-9 / #28）
        │   ├── receipt-media-token.test.js  # 收据预览/下载要走媒体凭据刷新（v7 §5-9 / #28）
        │   ├── restore-shared-dirs.test.js  # 恢复单班备份不覆盖全局共享文件（1-8 / #11）
        │   ├── restore-stops-scanner.test.js  # 整库恢复前停扫描子进程连接（2-6 / #12）
        │   ├── search-debounce-stale.test.js  # 防抖窗口里旧词的结果不许落地（v7 §5-9 / #28）
        │   ├── duplicate-name-pick.test.js  # 手工填表同名选人：班干部点谁认谁 + 格内候选带学号
        │   ├── import-duplicate-name-pick.test.js  # 批量导入同名逐行选人（弹窗 + 后端按行 id 落库）
        │   ├── undo-result-toast.test.js  # 更改审查：回退/撤销/重做的结果走提示条
        │   ├── undo-rewind.test.js  # 撤销统一 B3 判据：「回退到这条记录之前」原子批量入口
        │   ├── undo-source-converge.test.js  # 撤销统一 B5 判据：三入口收敛到同一原子内核
        │   ├── undo-source-expected.test.js  # 撤销统一 B1+B2 判据
        │   └── write-scope-closed.test.js  # 「完全禁止」必须同时阻断写入（1-5 / #5 / M1）
        ├── desktop/
        │   ├── ipc-binary-payload.test.js  # IPC 大对象载荷（P3-07 / N2-07）：背景图走 ArrayBuffer 不再 base64；业务 ZIP 走磁盘中转且只允许搬临时目录内的 .zip
        │   ├── kill-tree.test.js  # 「杀进程树」端到端（V5-010/011/013）：真实三层进程树（父 → 子 → 孙），W…
        │   ├── main-ipc-contract.test.js  # 主进程 IPC 契约的行为断言：① ok/fail/canceled 三态互斥且带可读 me…
        │   ├── main-env.test.js  # 开发/打包判定（v6 · 2-20）：打包 / Electron45 源码 / 常规源码三种组合；main.env 之外不得再出现 app.isPackaged；关键模块接线
        │   ├── secure-channel-idle-sweep.test.js  # 安全通道空闲清扫（v6 · 1-5）：过期会话清掉、未过期不动；定时器幂等/unref/可停；只有 initMaster 成功才启动
        │   ├── updateIntegrity.test.js  # 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小
        │   ├── widget-capture.test.js  # 浮窗截屏必须「自己先藏好」。工具箱浮窗是 transparent: true，Windows…
        │   ├── widget-data-changed.test.js  # 挂件不再只靠 5 分钟轮询（A5-02）：写请求成功后按域广播，基础设施写（聊天/相册/账户…
        │   ├── widget-overview.test.js  # 挂件单请求概览（P3-14）：5 份文档合成 1 条，名册只回 id/姓名
        │   ├── deferred-ipc-startup.test.js  # 延迟 IPC 注册全局化、低配模式已删除
        │   ├── packaged-csp.test.js  # 打包版 CSP 与构建产物内联脚本的对账
        │   ├── ports-config.test.js  # 端口单一口径：ports.json / 环境变量覆盖 / 运行期顺延后，主进程、后端、Vite、CSP 一起变
        │   ├── vite-outdir-empty.test.js  # 构建输出目录的小批量清空
        │   ├── app-wiring-static.test.js  # 后端 app.js 相关静态接线守卫聚合（相册定位/保活超时/收据归一/删学生放行）
        │   ├── dev-subwindow-identity.test.js  # dev 子窗口加载前必须校验页面身份
        │   ├── install-warmup-no-db.test.js  # 安装器预热不许建 index.db（否则跳过首启引导）
        │   ├── secure-channel-smoke-gate.test.js  # 安全通道 smoke 不许凭部分 PASS 假绿
        │   ├── mock-update-server.test.js  # 本地 mock Release：真发 HTTP 请求、核对 digest 与预览包挑选
        │   ├── updater-manual-install.test.js  # 更新链不静默执行未签名包：openPath / mock 定位两条路径
        │   ├── usb-auto-open-generation.test.js  # 关闭后迟到探测不开新盘（3-6 / #41）
        │   ├── usb-auto-open-persist.test.js  # USB 开关写盘失败不能假装成功（#46）
        │   └── widget-apps-save-queue.test.js  # 桌面挂件「常用软件」保存：连续编辑必须按顺序落库（审查 v7 · #75）
        ├── duty/
        │   ├── duty-config.test.js  # 值日列名按模式分键（daily 星期 / big 分组名 + 全部）后的读写对称：读走 re…
        │   ├── duty-dedupe-whole-table.test.js  # 「整表去重」开关必须真的生效（A3-01）：ctx 里状态都是 ref/computed，r…
        │   ├── duty-index.test.js  # 值日指数累加单源化：展示值与排表账本共用 accumulateDutyIndex，只有结算区…
        │   ├── duty-ordered-arrange.test.js  # 独立条件「顺序选项」：行优先 / 列优先与反向只作用于行内、列内，不改变跨行列的填充顺序
        │   ├── duty-packed-arrange.test.js  # 「随机分组」接入流水线：与 duty-packing 分工不同，这里锁「整条 pipelin…
        │   ├── duty-packing.test.js  # 分组装箱 + 整天随机映射内核：intactGroups 必须能从 buckets 反推（不…
        │   ├── duty-save-transaction.test.js  # 建档副作用与写入同事务（N2-06）：PUT /api/duty/save 的 valida…
        │   ├── duty-settings-hydrate.test.js  # 值日设置弹窗「首次打开即初始化」：父组件按 mounted 标记懒挂载，首次挂载时…
        │   ├── duty-slot-warning.test.js  # 「值日位置不足，有 X 人排不进」确认框：X 必须来自 shortageCount 单源；「…
        │   ├── duty-weight-linkage.test.js  # 权重表多子行联动：底层一个项目只有一个权重值，编辑任一子行必须同步到该项目所有天，一维表按均…
        │   ├── leave-state.test.js  # 「今天在不在校」的唯一口径（utils/leaveState.js）。回归首页右上角「请假 …
        │   ├── leave-undo-wiring.test.js  # 请假记录全链路撤销（Q2-05）：新增（弹窗 / 行内）、编辑、删除、销假、撤销销假都要登记…
        │   ├── leave-return-batch.test.js  # 批量销假端点：一次请求写完全部 id，回 updatedIds / missingIds（P3-11）
        │   ├── duty-arrange-scope-labor.test.js  # 值日智能排表的作用域与特殊劳动（v7 §5-5）
        │   ├── duty-cell-undo.test.js  # 值日表「按格撤销」
        │   ├── duty-hitday-backfill.test.js  # 大扫除补存只写命中日（审查 v7 · #79）
        │   ├── duty-ledger-by-id.test.js  # 值日账本按「学生身份」而不是按姓名统计
        │   ├── duty-mode-snapshot.test.js  # 值日切模式不写旧数据到新模式（3-7 / #50）
        │   ├── duty-student-id.test.js  # P2-2：值日格存学生 id
        │   ├── duty-template-delete.test.js  # 删学生要连值日模板一起清（2-11 / #9a）
        │   ├── duty-weight-mode-guard.test.js  # 值日权重表不能与设置抢跑、也不能被旧模式覆盖（v7 §5-7 / #25a）
        │   ├── leave-provisional.test.js  # 请假里的名册外姓名（P0-2 / P0-3 口径对齐）
        │   ├── leave-quick-tomorrow.test.js  # 「明天全天」= 明天 7 点 → 后天 7 点（v7 §5-7 / #25b）
        │   ├── leave-timeline-search.test.js  # 时间轴「任意关键词」搜索的索引边界
        │   └── rollcall-exclude-absent.test.js  # 「点名排除没有在校的同学」开关全链路
        ├── meta/
        │   ├── about-update-dialog.test.js  # 版本弹窗手动安装入口：两个按钮的模板绑定与 script 定义对账
        │   ├── architecture-guard.test.js  # 架构守卫（v6 · 6-2 / 6-3）：①schema/*.js 的 CREATE TAB…
        │   ├── changelog.test.js  # 更新历史解析：版本标题写法（v 前缀 / · 分隔 / 括号日期）、条目清理、HTML 注释…
        │   ├── docs-counts.test.js  # 文档计数唯一来源（v6 · 5-3）：①9 项计数都能从源码现算，且每份文档里确实存在可替换…
        │   ├── event-loop-stats.test.js  # 主进程事件循环延迟（v6 · 0-7）：ns→ms 口径、空 histogram 返回 null、start 幂等、stop 后不读数；perf-snapshot 带 eventLoop、启动后 3s 观测窗口
        │   ├── first-paint-batching.test.js  # 首屏并发编排（F07-10）：设置页非首屏请求进延迟清单、首帧后逐条发；课表页首屏不拉历史周，切页签仍拉
        │   ├── inp-longtask.test.js  # 主线程长任务观察（v6 · 0-2）：16ms 起记录、不支持时不装配、observe/单条 onRecord 抛错不影响后续；longTasks 必须随 INP_REPORT 落盘且 reset 清空
        │   ├── log-rotator.test.js  # 日志体积收口（v6 · 1-1）：超限只留尾部、串行追加不乱序、四个出口共用轮转器；接线判据锁 backend.log 全程异步
        │   ├── pkg-size-probe.test.js  # 打包体积探针（v6 · 1-12）：字节格式化边界、分桶（asar/根依赖/后端依赖/locales/根二进制）、汇总降序累加、生产依赖全部可解析
        │   ├── probe-gating.test.js  # 探针闸门登记（X1-02）：run-probes 白名单里的脚本必须真实存在；IPC 四件套（guard/policy/usage/contract）必须在白名单里
        │   ├── test-assets.test.js  # 测试资产自身的回归（批 19 B13 5 条 + B14 8 条）：这些修的是测试与工具自己…
        │   ├── about-license-timeout-recover.test.js  # 超时后又加载成功要清掉错误（#48）
        │   ├── async-scope-guard.test.js  # 旧请求覆盖当前状态（3-5 / #18 #45 #55 #27a）
        │   ├── audit-coverage.test.js  # 覆盖矩阵检查器的自测与变异反证
        │   ├── draft-release-assets.test.js  # 草稿发布的产物 glob 必须匹配实际下载层级
        │   ├── fixture-data-dir-isolation.test.js  # 测试夹具不许继承外部 DATA_DIR
        │   ├── frontend-relative-imports.test.js  # 前端相对 import 必须指向真实存在的文件
        │   ├── json-version.test.js  # JSON 列的 __v 结构版本标记
        │   ├── smoke-skip-gate.test.js  # CI 不许让关键 smoke 用例静默跳过
        │   └── smoke-truthfulness.test.js  # 四处「测试工具假绿」修复的判据
        ├── runtime/
        │   ├── client-cache.test.js  # 用户作用域缓存：旧令牌必须失效、某个清理函数抛错不能拖垮登出、两个缓存模块确实登记了清理函数
        │   ├── disposables.test.js  # 「资源随作用域释放」底座语义：登记的定时器/周期器在 dispose() 后不再触发、lis…
        │   ├── lifecycle-resources.test.js  # 定时器/监听器配对守卫（v6 · 1-11 + 1-13）：setInterval 必须有 clearInterval 或 d.interval；window/document 级 addEventListener 必须被移除/登记/once/signal 覆盖；豁免表不得过期
        │   ├── perf-mem.test.js  # 导出内存探针（v6 · 0-5）：默认关闭时 snapshot 为 null 且不打日志；PERF_EXPORT=1 时打 rss/heap/external 差值；导出路由 finally 成功/失败都留痕
        │   ├── perf-mark.test.js  # 首屏分段打点（v6 · P1-01）：①perfNow 是 epoch 毫秒、能与后端/主进…
        │   ├── slug-scopes.test.js  # 按库隔离状态底座行为契约：两库同号 id 互不覆盖、totalSize() 为各桶之和、pe…
        │   ├── startup-io.test.js  # 启动期同步 IO 打点（v6 · 1-10）：开关未开不安装、计时不改语义（返回值/异常透传）、重复安装不叠加、summarize 落启动时间线
        │   ├── sweep-fixes-b19.test.js  # 批 19 基础组件与前端工具的回归（表驱动 + 真跑源码）：①写请求重发守卫的默认值必须只放…
        │   ├── sweep-fixes.test.js  # 模式扫描批的行为回归（表驱动，一个文件覆盖一批同款修法）：①日期拼接收口 —— 后端 4 处…
        │   ├── fast-startup.test.js  # 「性能 → 快速启动」开关的两处同时生效
        │   ├── lifecycle-migration.test.js  # §5-17 生命周期批的结构判据
        │   └── perf-gc-all-renderers.test.js  # 「回收全部」要覆盖所有存活 renderer（#42）
        ├── seat/
        │   ├── arrange-datasource.test.js  # 智能排表「选择数据源」：只排当前表已有的人 / 从名册取人两种语义，切换数据源时清掉上一次的…
        │   ├── arrange-desk-mixed.test.js  # 智能排表按「桌号表」工作：混合桌（两列之间是走廊）下同桌判定不能再用列号奇偶，判据换成按桌号…
        │   ├── arrange-grid-boundary.test.js  # 智能排表弹窗的「网格 ↔ dense」边界：库里 seats 是网格（走廊是真实列），算法按…
        │   ├── dashboard-summary.test.js  # 首屏 dashboard 摘要化（v6 · 2-1）：不再下发全量 scores/fees、students 只剩 id+姓名、summary 四个口径与旧 computed 逐项一致、1000 条加分下整包 <30KB
        │   ├── dynamic-table-paging.test.js  # 动态表分页（P3-10）：不传 limit 时整表返回行为不变；limit/offset 按 position 切片并回 total；非法参数 400
        │   ├── seat-ai-align.test.js  # 座位网格与「对外文案 / 快照 / AI 输出」对齐：走廊是 seats 里的真实列，一张 …
        │   ├── seat-aisle-col.test.js  # 整列走廊（列头右键「左/右插入」「删除这条走廊」）：插入不动左右两列、删除逐格还原、cols…
        │   ├── seat-aisle-row.test.js  # 整行走廊（行标签右键「上方/下方插入」「删除这条走廊」）的几何语义：插入 / 删除后行数、t…
        │   ├── seat-cell-write.test.js  # 座位单格写入（PATCH /cell、PATCH /master/cell）：收敛到 ser…
        │   ├── seat-daily-aggregate.test.js  # 座位账本/指数单遍结算（v6 · 1-9）：与改造前两份遍历逐学生等价、两个 to 上限互不串口径、SeatView 只剩一处 /seats/daily
        │   ├── seat-desk-pattern.test.js  # 混合桌：不另存桌型序列，桌型从「走廊在哪」派生 —— 拆桌 = 两列之间插一条走廊，合并 =…
        │   ├── seat-draft-reset.test.js  # 排表草稿的模块级单例跟着账号走（X2-07）：换号既要清值又要作废在途响应，否则 B 打开智…
        │   ├── seat-fair-conservation.test.js  # 位置公平（applyFair）的人数守恒：按目标块位置数遍历落盘时不能多塞或漏人
        │   ├── seat-geometry.test.js  # 座位网格几何的回归锚点：把改造前的旧公式原样冻结在测试里当参考实现，而不是拿新实现跟自己对
        │   ├── seat-hole-paint.test.js  # 「设置空位」画笔：纯函数规则（toggleHole / usableSeatCount / …
        │   ├── seat-types.test.js  # 格子类型矩阵（types）的存取契约：必须穿过 schema、slotStore 白名单、视…
        │   ├── seat-undo-geometry.test.js  # 撤销的几何契约（P0-3 / P0-2）：几何只从快照 types 形状推，前端四元组降级为…
        │   ├── seat-undo-rows.test.js  # 撤销「插入/删除行走廊」时行数必须与 types 一起回写：grid_snapshot 原先…
        │   ├── seat-weight-align.test.js  # 权重表跟随座位表几何：权重矩阵独立存储，划成走廊或挖洞后旧数字仍在，取消走廊时必须重新对齐
        │   ├── week-dates.test.js  # 「星期列 → 具体日期」换算：按星期名取而不按列下标取（表头可拖拽），月和日不补零，非法日期…
        │   ├── custom-scrollbar-reflow.test.js  # 滚动条测量不许制造强制同步布局
        │   ├── dynamic-table-resize-quiet.test.js  # 容器尺寸变化时行高测量必须走「安静窗口」
        │   ├── seat-ai-hole-image.test.js  # AI 座位图必须把「空位」画出来（4-8 / #80）
        │   ├── seat-history-cache-invalidate.test.js  # 快照变更后座位账本/指数缓存必须作废（4-7 / #26）
        │   ├── seat-name-preview.test.js  # AI 写座位表时「认不出的人」必须被说出来
        │   ├── seat-name-provisional.test.js  # 座位格里的姓名要变成「一个人」（P1-5）
        │   ├── seat-same-cell-order.test.js  # 同格快速编辑乱序落库（3-10 / #23）
        │   ├── seat-snapshot-validation.test.js  # 座位快照写接口必须与座位写入口同口径（4-10）
        │   ├── seat-move-occupied.test.js  # 已入座学生候选标位置 + 选中即移动 + 无匹配可新增临时学生
        │   ├── table-drag-select-guard.test.js  # 动态表格的三处交互陷阱（v7 §5-6）
        │   └── seat-move-occupied.test.js  # 候选选中已入座学生：原位清空 + 新位落人
        ├── security/
        │   ├── pathGuard.test.js  # 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建…
        │   ├── secure-bridge.test.js  # 安全通道握手报文桥（v6 · 2-19）：只转发公钥、非法公钥不发请求、后端非 2xx/缺字段必须报错；授权与 get-master-key 一致
        │   ├── secure-response-serialize.test.js  # 响应只序列化一次（v6 · 1-2）：信封与 JSON.stringify({ d }) 逐字节一致、不再过 res.json；密文可被同一会话密钥解回原对象
        │   ├── secure-retry.test.js  # 安全信道 401 重试的分支判定（N1-02）：凭据降级 / auth-required /…
        │   ├── key-pair-prewarm.test.js  # 握手临时密钥对「预生成 + 用后补齐」回归
        │   ├── owned-electron-child.test.js  # 性能探针退出时必须关掉自己启动的 Electron
        │   ├── secure-write-proof.test.js  # 安全信道写请求强制一次性凭据（1-10 / #2）
        │   └── security-level-hash-sync.test.js  # 切换安全等级同步权威凭证（1-12 / #5a）
        ├── storage/
        │   ├── blob-error.test.js  # 二进制下载失败体归一（A4-01）：responseType:'blob' 时 4xx 的 …
        │   ├── bundle-restore.test.js  # v3 包落盘的四种坏情况：包里缺某目录 / 坏包 / 缺库文件时都不许把本机目录清空；替换与…
        │   ├── data-export-zip.test.js  # 数据导出 /api/data/zip 的流式打包（v6 · P2-01）：①收据按磁盘路径流…
        │   ├── dbConnCache.test.js  # 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶
        │   ├── data-export-tables.test.js  # /api/data/tables 只计数不物化（v6 · 1-3）：计数正确、GET 期间无 SELECT * FROM students、派生表走 build 兜底
        │   ├── refresh-virtual.test.js  # 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项）
        │   ├── storage-size-probe.test.js  # 目录 / 日志体积探针（v6 · 0-5）：嵌套目录按文件累加、缺失目录标 missing、data/userData 两处日志分别统计、自证脚本能跑通
        │   ├── zip64.test.js  # 备份包 >4GB 的 ZIP64 写出结构：条目 extra / 24 字节描述符 / EOCD64 + locator + 哨兵；写侧与读侧闸值同源
        │   ├── zip-bundle.test.js  # 备份包两块地基（A1-03 / N3-03）：sanitizeEntryName 拦 Zip…
        │   ├── disk-usage.test.js  # 性能面板「空间管理」的磁盘归账
        │   ├── text-head.test.js  # AI 附件只读头部（不为截断整份读入）
        │   ├── zip-peek.test.js  # 「这个备份包要不要口令」的判断必须与真包一致：误判「不用口令」会让用户卡在解不出钥匙，误判「…
        │   ├── refresh-virtual-dir-isolation.test.js  # 虚拟相册刷新测试的目录隔离
        │   ├── scan-task-key.test.js  # 扫描任务键含班级 slug（2-9 / #6）
        │   ├── trash-slug-bucket.test.js  # 全局回收站归档跨班碰撞（2-8 / #7）
        │   ├── unzip-path-conflict.test.js  # 离线恢复 ZIP 路径冲突不崩进程（2-7 / #35）
        │   ├── unzip-safe-test-isolation.test.js  # smoke 测试不许删别人在系统 temp 的文件
        │   └── upload-signature-ftyp.test.js  # 带前置盒的 MP4 不该被判「内容不是有效 mp4」
        ├── student/
        │   ├── group-dimension-delete.test.js  # 分组维度删除的撤销（Q2-08）：维度 + 该维度全部小组 + 全部成员 + 剩余维度重排合…
        │   ├── note-curve.test.js  # 荧光笔笔锋：按点分组描边后线宽确有变化（旧实现整条路径只描一次，宽度被末端值压平 → 此断言…
        │   ├── student-cascade-delete.test.js  # 删除学生的级联撤销（Q2-03）：七处（学生 / 请假 / 加减分 / 小组 / 班干部 /…
        │   ├── student-delete-guard.test.js  # 删学生不许留孤儿（N2-05）：通用删除入口先算关联，有就拒并列出明细，让调用方走「一并删除…
        │   ├── group-manage.test.js  # 分组管理的读写路径（档 C · M12-B1）
        │   ├── group-rename-batch.test.js  # 组名批量改名端点：整批一事务、任一 id 缺失整体回滚（P3-12）
        │   ├── score-paging.test.js  # 成绩列表分页与统计页签全量
        │   ├── score-provisional.test.js  # 加分记录里的名册外姓名
        │   ├── score-import-idempotency.test.js  # 成绩导入幂等（F07-04）：同表重导不新建、force 出口、批次同事务
        │   ├── semester-crud.test.js  # 学期 CRUD 与「当前学期」镜像（档 C · M12-B4）
        │   ├── activities-import-undo-key.test.js  # 切标签撤销记错历史栈（3-9 / #49）
        │   ├── cadre-member-authority.test.js  # cadre_members 的权威字段守门
        │   ├── cadre-import-duplicate-pick.test.js  # 班干部导入同名选人：一行多名的 key（行:slot）、按选中 id 落库、新同学建临时、非法 id 400
        │   ├── cadre-member-provisional.test.js  # 班干部成员自己认人（P1-3）
        │   ├── cadre-tree-member-remove.test.js  # 递归组件的事件转发必须带全参数（#58）
        │   ├── class-scope.test.js  # 「切班不重启」接线判据
        │   ├── e2e-seat-score-undo.test.js  # 端到端流水线：排座→加分→改格→撤销→重做，验跨模块状态一致
        │   ├── group-dim-naming-guard.test.js  # 维度详情加载失败自动命名改错旧维度（3-8 / #51）
        │   ├── group-member-provisional.test.js  # 小组成员的每个写入口都要给姓名建档
        │   ├── group-import-duplicate-pick.test.js  # 分组导入同名选人：按行 studentIds 落 id、新同学建临时、非法 id 400、不传维持旧行为
        │   ├── group-member-student-id.test.js  # P2-1：小组成员指针化（member_name → student_id）
        │   ├── group-rename-undo-ref.test.js  # 撤销「分组页改名」必须按 ID 恢复引用（v7 §5-4 / #57）
        │   ├── multi-class.test.js  # 「一个账号多个班级」接线判据
        │   ├── schedule-cells-validation.test.js  # 课表接口拒绝畸形 cells（4-1 / #60）
        │   ├── schedule-import-save.test.js  # 课表 Excel 导入必须调到真的保存方法（v7 §5-7 / #25）
        │   ├── score-aggregate-identity.test.js  # 成绩统计按身份聚合，不按姓名（v7 §5-4 / #20）
        │   ├── student-list-paging.test.js  # 学生名单首屏分页（V9 · 5-5）：limit/offset、全量补齐、hasMore 变异反证
        │   ├── student-formal-filter.test.js  # 学生管理只列正式学生（?formal=1）
        │   ├── student-lookup.test.js  # 学生「认人」的单源实现（services/studentLookup.js）
        │   ├── student-provisional-visibility.test.js  # 临时学生在「点名器 / AI 找人 / AI 聚合」里可见
        │   ├── student-ref-frontend-wiring.test.js  # 前端「成员提交口径」（P1-4）
        │   ├── student-ref-write-paths.test.js  # 「写入路径有没有认人」的验收判据
        │   ├── student-relations-namesake.test.js  # 删学生不误删同名学生的关联（1-7 / #9）
        │   ├── todo-center.test.js  # 标题栏「N 项待处理」胶囊的接线判据
        │   └── todo-realtime.test.js  # 写成功后标题栏待办要立刻重拉，不能等 10 分钟
        └── ui/
            ├── app-select-esc.test.js  # Esc 让位协议（A5-05）：弹层在下拉展开时消费 Esc（defaultPrevente…
            ├── context-menu-exclusive.test.js  # 右键菜单互斥：座位页行标签与列头是两个组件实例，只能靠模块级登记表让新菜单把旧菜单关掉
            ├── context-menu-transition.test.js  # 右键菜单过渡：先用 visibility: hidden 量尺寸再显示（避免贴边溢出），过渡…
            ├── dialog-stack.test.js  # 弹窗层级栈（V5-003）：openStack 原先写在 里、每个实例一份，抽成模块级后一次…
            ├── frontend.test.js  # 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼…
            ├── settings-view-ctx-binding.test.js  # 设置页模板绑定必须来自解构出的名字
            ├── viewer-pan.test.js  # 查看器放大后拖动平移
            ├── frontend-static-wiring.test.js  # 前端静态接线守卫聚合（导入提示/弹窗动画/splash 撞名/视频兜底）
            ├── layout-shift-hint.test.js  # 表格冻结期间必须有「正在调整表格布局」状态提示
            ├── layout-shift-resize.test.js  # 拖窗口改大小必须复用同一套表格冻结窗口
            ├── lazy-dialog-first-open.test.js  # v-if 懒挂载弹窗的「首次打开」必须初始化（v7 §5-3）
            ├── row-focus-cancel-registry.test.js  # 反复跨页定位不能攒住旧闭包与 DOM（v7 §5-9 / #28）
            ├── select-bidi.test.js  # 下拉当前值「天 30」倒装的回归钉子
            ├── sidebar-collapse-freeze.test.js  # 折叠侧栏时表格内部不许逐帧重排
            ├── theme-persist-after-ready.test.js  # 主题备料失败不能留下「持久态分叉」
            └── virtual-rows.test.js  # 已处理列表的行虚拟滚动纯计算
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：单元测试层（`testjs/units/`），362 个 `node:test`（Node 内置测试框架）文件，覆盖纯函数与内存库上的数据层逻辑。
- **公共逻辑**：零第三方依赖（`node:test`（Node 内置测试框架）+ `node:assert`（Node 内置校验库）），不启动后端与前端；失败退出码非 0，可直接接 CI。运行：`npm run test:units`（支持 `--only=`（只跑指定文件）/ `--skip=`（跳过指定文件）/ `--bail`（首个失败即停）/ `--list`（只列用例不执行））。
- **公共夹具**：后端路由测试统一用 `testjs/units/_db-express-fixture.cjs`，不要各自再抄「env 兜底 → 内存库 → 换 `db.js` 的 Proxy → `express.listen(0)`」。它提供 `createBackendDb({ label, dataDir, extraDbExports })`、`fx.reset()`（每个用例换干净库，`db.js` 的导出是转发到当前库的 Proxy，模块顶层 require 的引用才不会失效）、`fx.mount(path, routerOrRel)`（可多次挂不同前缀，也接受 `createDynamicTableRouter(...)` 这类实例）、`fx.call(method, path, body)`（返回 `{ status, text, json }`，`path` 可写相对挂载点或 `/api/...` 绝对路径）。`getFields` 默认按 `table_meta` 真查；`renumber` 这类闭包导出用 `extraDbExports` 覆盖。要测「多步写中途失败」时给 `createBackendDb` 加 `faults: true`，再用 `fx.inject({ failAt: N })`（第 N 次 `run()` 抛错）或 `fx.inject({ failMatch: /表名/i, failAtMatch: N })`（按 SQL 锁定注入点，业务新增一次写也不会把故障落错步骤）；`reset()` 会清掉注入。`test-assets.test.js` 有一条守卫：旧样板文件数必须为 0（历史 21 个已全部迁到夹具），新写的测试自己再抄一份 `require.cache[dbPath].exports` 就会红。
- **局限**：不覆盖 UI、进程间链路与真实数据目录；部分数据层用例会用「内存库 + 真 Express router」跑 HTTP（如座位单格写入、分组维度删除、相册合并）。分层说明见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 详细说明

| 文件 | 覆盖点 | 前置 / 写法 |
| --- | --- | --- |
| [`backend.test.js`](../../../testjs/units/backend/backend.test.js) | 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、`domain_history` payload → 三域历史视图的 JSON 映射、二次 `initSchema` 幂等、`slotStore` 逻辑名/可写列映射、`sanitize` 系列、恢复密钥归一化/哈希/常数时间比较、请假时间窗与 SQL 时间戳、`dutyMode` 解包（items 空值必须回数组） | 需 `student-backend` 依赖，用 `createRequire(path.join(ROOT,'student-backend/package.json'))` 解析 |
| [`backend-multiwrite.test.js`](../../../testjs/units/backend/backend-multiwrite.test.js) | **多步写的一致性保障**：逐日/逐条的批量写若没有事务，中途失败会留下半截状态（补存留下部分快照、排序只改了一半、「确保默认维度存在」这个隐藏写凭空留下一个维度）。手法：把 `student-backend/db.js` 的 `db` 导出换成「代理到真内存库 + 第 K 次写抛错」的代理，再在**同进程**起 Express 挂真实 router、用 `fetch` 打真实 HTTP —— 路由、slotStore、SQLite、事务全是真的，只有「写」这一下是注入的故障（隔离后端是独立子进程，注入不进，这层只能在同进程做） | 需 `student-backend` 依赖；`require.cache` 换掉 `db.js` 的 `db` 导出（**必须早于 require 路由/slotStore**，它们解构捕获 `db`）；4 条用例 |
| [`backend-boundary.test.js`](../../../testjs/units/backend/backend-boundary.test.js) | **写入边界与实际结构脱节**：①`PATCH /cell` 是唯一不经过 `normalizeSeats` 的座位写入口 —— 只校全局上限 50×30 时，单格提交能把 seats 撑出当前布局之外的多余行（前端按 rows/cols 渲染，多出来的行永远看不见，下一次整块 PUT 又会被 `slice(0, rows)` 静默丢掉）；②改名级联的**六处联写匹配口径不一致**（值日/座位/四张 SQL 表有的 trim 比、有的严格比）→ 同一个带空格的旧名只在一部分表被改，同一学生在不同表里名字对不上。手法同 `backend-multiwrite`（`require.cache` 换 `db.js` 的 `db` + `getFields`，同进程真 HTTP）；删除学生路径（`studentRelations`）的口径一并覆盖 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` **与 `getFields`**（后者不走 `db` 导出、直接读 dbManager 的 ALS 上下文，不换会报「未绑定数据库连接」）；10 条用例 |
| [`backend-consistency.test.js`](../../../testjs/units/backend/backend-consistency.test.js) | **跨库写补偿与信号透传**：①`PUT /username` 的用户名存在两处（`index.db` 的 registry + 业务库 `users`），两个 SQLite 文件事务无法跨库 → 业务库写失败时必须**补偿**（把 registry 改回旧名，且回滚前确认 registry 当前仍是本次写入的新名，否则会覆盖并发改名）；②`album` 的 `DELETE /:id` 两条 DELETE 各自提交 → 中途失败留下「照片索引已删、相册还在」的半截状态；③改名跳过级联时后端已回 `skipped='duplicate-name'`，前端必须消费并提示 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db`（第 K 次写抛错）+ `getFields`；11 条用例 |
| [`backend-limits.test.js`](../../../testjs/units/backend/backend-limits.test.js) | **无界资源与入口收敛**：①`ffmpeg` 下载递归跟随重定向**无次数上限** → 重定向环会无限递归爆栈；②`sessions` 的 sid 名单**无 TTL / 无容量上限** → `.sessions.json` 单调增长，登出只删一个 sid；③恢复词哈希**没有版本标识** → 将来换算法时无法区分新旧哈希（台账说的「确认门熵不足」在代码里并不存在）；④`undo` 路由的 `:id` 未按项目既有口径收敛整数 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` 导出（**必须早于 require 路由/slotStore**，它们解构捕获 `db`） |
| [`backend-sideeffect.test.js`](../../../testjs/units/backend/backend-sideeffect.test.js) | **校验阶段的副作用与文件+索引非原子**：①`assertDutyRefs` 在**校验阶段**就写库（建临时学生），而 `resolveNames` 自带事务 → 提前提交，后续 `setDoc` 失败救不回来 → 名册凭空多一个学生、值日表却没存（孤儿）；②`photo_trash` 的 undo 先搬文件再插索引，两步非原子 → 中间态「文件在、索引不在」，用户看不到照片但文件已归位 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` 导出 + `getFields`，同进程起 Express 打真实 HTTP |
| [`ai-limits.test.js`](../../../testjs/units/ai/ai-limits.test.js) | **AI 链路的边界校验与预算闸门**：①上游 tool_call 的空 id / 空 name / 重复 id 必须收口（空 `tool_call_id` 会让上游 400），且工具名分片下发与整名重复下发都要拼对；②快照标识必须唯一（同毫秒创建不互相覆盖）且列表按真实时间排序；③「会话不存在」与「没有会话」两种语义必须区分 —— 前者明确报错、前端自愈，不能静默回退；④`web_search` 要接客户端取消信号（用户中断后不必等满 30s）；⑤统一预算闸门：子助手的 `usage` 必须记进共享账本（原先被直接丢弃）、超限即拦 | 需 `student-backend` 依赖；桩掉 `fetch` 跑真实 `consumeStream`，桩掉 `fs.readdirSync` 跑真实 `snapshotFiles`，桩掉 `consumeStream` 跑真实 `runOneSubagent`；21 条用例 |
| [`api-proxy.test.js`](../../../testjs/units/backend/api-proxy.test.js) | B1 的 `/api` 同源代理（v6 · 2-15）：只代 `/api` 与 `/api/*`，静态路径返回 null；目标 URL 保留 path/query；方法、请求体流、响应流原样透传；Host/Content-Length 等帧级头被清理；后端不可达回 503 | 纯逻辑 + 注入假 fetch；5 条用例 |
| [`backend-origin.test.js`](../../../testjs/units/backend/backend-origin.test.js) | B1 地址口径（v6 · 2-15）：`apiBaseUrl()` 永远相对路径、`mediaBaseUrl()` 打包补后端绝对地址；httpClient/apiUrl/secureChannel 共用一份；`app://` 协议必须代理 `/api`，主窗口/引导/挂件保持 `app://local` 不换源 | 前端 ESM 动态 `import()` + 源码接线判据；4 条用例 |
| [`frontend.test.js`](../../../testjs/units/ui/frontend.test.js) | 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼图 Top N + 其他）、热力配色、`collectPdfText` 边界（循环引用/超深递归/空输入）、表格关键字过滤与「无结果」判定 | 前端是 ESM，用 `pathToFileURL` + 动态 `import()` |
| [`sweep-fixes-b19.test.js`](../../../testjs/units/runtime/sweep-fixes-b19.test.js) | **批 19 基础组件与前端工具的回归**（表驱动 + 真跑源码）：①写请求重发守卫的默认值必须只放行 GET/HEAD（子窗口没传守卫时，写请求在后端重连期间不能重发，否则重复落库）；②字体必须走 `new URL(..., import.meta.url)`（`public/` 下的资源 Vite 不加 content hash → 换字体后仍命中旧缓存）；③明文模式不把登录 JWT 拼进图片 URL（改靠 httpOnly Cookie 同源带凭据）；④`serialSaver` 的静默期要合并连续输入，且 `dirty` 必须在等待**之后**清（反了会多存一轮）；⑤`tableSearch` 的小写缓存必须按原值失效（只看关键字命中会让改过的值搜不到）；⑥`IconGlyph` 的 84 项 `MAP` 不能在 `<script setup>` 里（每实例重建）；⑦`AppSelect` 键盘打开要先初始化 `hoverIdx`（否则二次 Enter 变成 `commit(-1)`）；⑧`rowHeights` 只删失效键、不清空（清空会让滚动位置跳变）；⑨请假编辑模式 `student_id` 为空时不发起保存；⑩`undo_history` 与 `album_photos` 的覆盖索引要真建出来 | 静态形态用 `STATIC_CASES` 表驱动（`forbid` 去注释后匹配、`mustHave` 看全文、`mustNotBeInSetup` 只切 `<script setup>` 块、`minCount` 防「只改一处」）；行为侧用 `new Function` 抽出 `defaultWriteRetryGuard` 的真实函数体、用 `import()` 真跑 `tableSearch` / `serialSaver`；18 条用例 |
| [`backend-date.test.js`](../../../testjs/units/backend/backend-date.test.js) | **后端日期工具（`student-backend/utils/date.js`）的回归**。这些函数此前在 `routes/duty.js`、`routes/seats.js` 各有一份逐字重复的私有副本，`ai.dataRoutes.js` 还有第三份 `mondayOf`——三份拷贝、零测试。本文件锁三件事：①本地时区口径（`toISOString` 是 UTC，东八区 00:00–08:00 会得到「昨天」）；②`mondayOf` 的周一归属（周日归**上一周**），且传 `Date` 时**不得就地改写**调用方对象（`snapshotBeforeWrite` 后面还要用同一个 `Date` 取快照日期）；③静态守卫——路由层不许再复制一份日期函数，草稿 `savedAt` 不许退回 `toISOString` |
| [`leave-state.test.js`](../../../testjs/units/duty/leave-state.test.js) | **「今天在不在校」的唯一口径**（`utils/leaveState.js`）。回归首页右上角「请假 N」和下面「今日请假」卡片对不上的问题：数字数的是「所有 状态=请假中」（不看日期），卡片筛的是「开始时间=今天」，跨天假只进数字不进卡片。归一后为「状态=请假中 且 开始时间 ≤ 今天 ≤ 结束时间（首尾都算）」，并覆盖提前登记（不算）、过期未销假（不算）、`Date`/带时间串入参、脏数据。末尾静态守卫：首页与桌面挂件都不许再自己写 `状态 === '请假中'` |
| [`widget-capture.test.js`](../../../testjs/units/desktop/widget-capture.test.js) | **浮窗截屏必须「自己先藏好」**。工具箱浮窗是 `transparent: true`，Windows 上 `setOpacity` 对透明窗口不生效——主进程 `hideWidget`（`setOpacity(0)` + 等 150ms）等于没做，便签窗口那张「加载中」卡片就这样被拍进了自己的注释背景。判据锁调用形态（画面没法在单测里验）：所有浮窗截屏调用方都必须 `from './captureHide.js'` 引入并用 `hideForCapture/restoreAfterCapture`，且传 `hideWidget:false`，不许自己再写一份 `documentElement.style.visibility` |
| [`smart-group.test.js`](../../../testjs/units/ai/smart-group.test.js) | **智能分组算法（`SmartGroupDialog.pipeline.js`）的回归**：这套算法此前一条单测都没有，于是 `single` 模式在男女比例悬殊时会**静默丢学生**（4 男 4 女分 3 组少 1 人、10 男 1 女分 3 组少 2 人，界面上完全看不出来）。三条判据：①**守恒** —— 任意人数/组数组合下，分配后人数必须恰好等于名册人数；②**语义** —— `G ≥ 2` 时不能出现混性别组；③**均匀** —— 同一性别池内各组人数差 ≤ 1（跨池不能比：5 男 1 女分 3 组时男生组必然 5 人、女生组 1 人）。另含 `G = 1` 边界（男女混合物理上分不开 → 全部塞进唯一那组、满足率如实记 0 而不是谎报 100%）与 1~12 人 × 1~5 组笛卡尔积穷举 | 用 `{ value }` 形状模拟组件的 ref 上下文，经 `pathToFileURL + import()` 真跑源码；判据能区分「改了」与「没改」——把容量退回全局 `target`、把丢弃 `break` 加回去、删掉 `G < 2` 特判，三者都会让测试变红（见 `mutate-sweep-b19.cjs` 的同类做法）；13 条用例 |
| [`test-assets.test.js`](../../../testjs/units/meta/test-assets.test.js) | **测试资产自身的回归**（批 19 B13 5 条 + B14 8 条）：这些修的是**测试与工具自己**的毛病 —— ①设置探针的用例必须三元组（缺 `expected` 时断言恒真 = 空串边界假覆盖）；②临时库目录要删（`dataDir` 在仓库里，不删会进 `git status`）；③页面探针要轮询而非死等 5 秒（写完了立刻走，超时才兜底）；④`pathGuard` 的临时目录统一登记、`after` 一次清（原来 6 个用例只有一个清了）；⑤错误边界扫描要认跨行空 `catch`、且 `.catch(` 不计入分母；⑥嵌入 Python 的路径用正斜杠（反斜杠翻倍会让 `r''` 里出现两个）；⑦关服务要 `await closeServer`；⑧结束 dev server 要杀进程树；⑨Electron 子进程要有超时上限；⑩撤销用例的断言标签要与逻辑一致；⑪未捕获异常要记日志后退出；⑫`run-smoke` 要有单脚本超时与统一临时根目录 | 静态：`CASES` 表驱动 `includes` 判据（`forbid` 精确到断言调用形式，**不用裸标签** —— 修复注释里写着旧标签，会命中自己）；行为：①从源码里抽出 `EMPTY_CATCH_BLOCK` / `CATCH_KEYWORD` 正则真跑（单行版正则同样含这两个词，只判词是假绿），②解析 7 个文件头部注释里的 `node testjs/...` 路径并逐个 `existsSync`；14 条用例 |
| [`sweep-fixes.test.js`](../../../testjs/units/runtime/sweep-fixes.test.js) | **模式扫描批的行为回归**（表驱动，一个文件覆盖一批同款修法）：①日期拼接收口 —— 后端 4 处 + 前端 4 处统一走 `localDateStr`，前后端同一 `Date` 必须得同一结果；②下载 Blob 后 `revokeObjectURL` 必须延迟（同步撤销 → 0 字节文件）；③附件/粘贴 `readFile` 必须包 try（两处都要有，只改一处 = 改坏）；④`normalizeExifDate` 必须往返校验月日（2/31 不再滚到 3/2）；⑤`IconGlyph` 旋转选择器必须写成 `.icon-loading:deep(svg)`；⑥`duration=0` 常驻通知不能被 `setTimeout(remove,0)` 误杀；⑦`VideoThumb` 的 `ok` 必须随 `src` 复位；⑧Setup 只能在「用户从未选过主题」时落默认；⑨倒计时时长为 0 必须给可见提示；⑩`executeProposal` 必须 `await` 完才把 `busy` 置 false（否则并发写同表）；⑪`albumScan` 的 ffmpeg 抓帧必须带超时（否则坏视频 → 槽位永不释放 → 扫描 worker 卡死）；⑫挂载链与补发凭据的 promise 必须接住失败 | 表驱动：`STATIC_CASES` 数组逐条断言（`forbid` 去注释后匹配、`mustHave` 看全文、`minCount` 防「只改一处」）；前端 ESM 用 `file:///` URL 动态 `import()`；22 条用例 |
| [`changelog.test.js`](../../../testjs/units/meta/changelog.test.js) | 更新历史解析：版本标题写法（v 前缀 / `·` 分隔 / 括号日期）、条目清理、HTML 注释里的示例条目忽略、CRLF、日期倒序，并校验仓库真实 `CHANGELOG.md` | 前端是 ESM，用 `pathToFileURL` + 动态 `import()`；真实文件按相对路径读取 |
| [`albumScan.test.js`](../../../testjs/units/album/albumScan.test.js) | 相册扫描的「索引被误删/清空」防护 | 纯函数 + 内存库 |
| [`api-paths.test.js`](../../../testjs/units/backend/api-paths.test.js) | 认证端点路径单一来源（前端 `apiPaths.js` 常量 ↔ 后端真实路由，防 `/api/auth/logout` 错串）+ 前端全部静态 API 路径 vs 后端真实挂载（v8 · 5-4 / G10）：从 `app.js` 现读挂载前缀 + 直挂路由 + auth router，断言 92 条前端静态路径都落在已知挂载下，抓幽灵端点。清单对账（真跑 404 需鉴权/数据/写库）；前缀匹配抓不到同 router 内拼写错 | 源码解析 + 集合对账；6 条用例 |
| [`client-cache.test.js`](../../../testjs/units/runtime/client-cache.test.js) | 用户作用域缓存：旧令牌必须失效、某个清理函数抛错不能拖垮登出、两个缓存模块确实登记了清理函数 | 纯函数 |
| [`note-curve.test.js`](../../../testjs/units/student/note-curve.test.js) | 荧光笔笔锋：按点分组描边后线宽确有变化（旧实现整条路径只描一次，宽度被末端值压平 → 此断言在旧实现上必挂） | 纯函数 |
| [`slug-scopes.test.js`](../../../testjs/units/runtime/slug-scopes.test.js) | 按库隔离状态底座行为契约：两库同号 id 互不覆盖、`totalSize()` 为各桶之和、`peek` 不建空桶、交错 `push` 后 `flush(A)` 只发 A 的条目（旧全局数组实现必挂）、达到 limit 自动发自己库、发送失败不残留、`clearAllForSlug` 只清该库 | 纯函数 |
| [`thumb-cache.test.js`](../../../testjs/units/album/thumb-cache.test.js) | 缩略图缓存三层：淘汰策略按真 blob 数（含「几千个 miss 标记不许误撤 blob」回归）、批量接口失败与「服务端确实没这张」语义分离（失败不写状态）、空闲 2 秒主动收缩集成 | 纯函数 + Vite SSR（集成） |
| [`refresh-virtual.test.js`](../../../testjs/units/storage/refresh-virtual.test.js) | 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项） | 需先 `claimScanTask`（否则 `waitWhilePaused` 误判取消） |
| [`dbConnCache.test.js`](../../../testjs/units/storage/dbConnCache.test.js) | 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶 | 内存连接桩 |
| [`pathGuard.test.js`](../../../testjs/units/security/pathGuard.test.js) | 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建议文件名压平 | 纯函数 |
| [`updateIntegrity.test.js`](../../../testjs/units/desktop/updateIntegrity.test.js) | 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小；本地 mock 只放行回环 http | 纯函数 |
| [`updater-manual-install.test.js`](../../../testjs/units/desktop/updater-manual-install.test.js) | 更新链不再静默执行未签名安装包：源解析 / 安装动作两个纯函数，真跑 UPDATE_INSTALL handler 的打开与 mock 定位两条路径、复核失败分支 | 注入假 electron 加载真实模块 + 抽 handler body 执行 |
| [`about-update-dialog.test.js`](../../../testjs/units/meta/about-update-dialog.test.js) | 版本弹窗「打开安装包 / 去发布页下载」模板绑定与 script 定义对账，未签名提示与 opened 文案 | 源码判据 |
| [`mock-update-server.test.js`](../../../testjs/units/desktop/mock-update-server.test.js) | 本地 mock Release：真启动服务、真发 HTTP，核对 digest 与实际内容一致、预览包干扰项不被选中 | 临时端口 + 真 HTTP |
| [`seat-move-occupied.test.js`](../../../testjs/units/seat/seat-move-occupied.test.js) | 候选选中已入座学生：原位清空 + 新位落人 | 源码判据 |
| [`main-ipc-contract.test.js`](../../../testjs/units/desktop/main-ipc-contract.test.js) | 主进程 IPC 契约的**行为**断言：① `ok`/`fail`/`canceled` 三态互斥且带可读 message；② `safe()` 把异常转成失败**返回值**、`safeReject()` 保留 reject 语义；③ `save-file` 真写盘失败（指向不存在的目录触发 ENOENT）必须回 `fail` 而不是伪装成取消；④ 选区会话残留时「先还原再重新开始」、看门狗常量存在且被调用；⑤ `normalizeAssetFileName` 挡住 `'.'` / `'..'` / 含分隔符的名字，且归一化后仍落在缓存目录内；⑥ 导航等待在窗口销毁 / 超时两条路都会收尾；⑦ 鼠标穿透态挂在窗口实例上；⑧ 前端 `saveFile.js` 对「失败」抛错、对「取消」返回空串 | 用 `require.cache` 注入假 electron，**直接 require 真实模块**（不复现逻辑），前端部分走 ESM 动态 `import()` |
| [`disposables.test.js`](../../../testjs/units/runtime/disposables.test.js) | 「资源随作用域释放」底座语义：登记的定时器/周期器在 `dispose()` 后不再触发、`listen` 与 `removeEventListener` 严格配对（capture 选项原样传回）、`defer` 是可替换的防抖语义（连排三次只触发一次）、`dispose` 幂等且单个清理函数抛错不连累其它资源、作用域停止后定时器确实不再触发（用 Vue `effectScope` 模拟组件卸载） | 前端是 ESM，用 `pathToFileURL` + 动态 `import()` |
| [`db-master-key.test.js`](../../../testjs/units/backend/db-master-key.test.js) | **数据库主密钥 safeStorage 异步化（Electron 46 适配）的行为回归**：①只用异步 API（替身故意不提供同步方法，退回同步必挂）；②并发取钥匙靠单飞 Promise 只解析一次 —— 异步化后若两处 fork 各生成一把新钥匙，后者写回文件会让旧加密库再也打不开；③旧密文二次加载必须复用同一把钥匙；④ `shouldReEncrypt` 时明文不变、先备份再用新密文写回；⑤解密失败时备份成功才重新生成，备份失败绝不覆盖原密文；⑥异步解密返回空结果当失败处理，不许拿空密钥去起后端；⑦静态对账 fork 两条分支都用预取的 `dbKey`、入口有 ready 后预热 | `require.cache` 注入假 electron + 真跑 `electron/main/main.config.js`（不复现逻辑）；每个用例独立 userData 临时目录并在 `after` 清理；变异验证（可用性检查改回同步 API）会让 6 条用例变红；8 条用例 |
| [`data-export-zip.test.js`](../../../testjs/units/storage/data-export-zip.test.js) | **数据导出 `/api/data/zip` 的流式打包**（v6 · P2-01）：①收据按磁盘路径流式读，Spy 住 `readFileSync` 断言整文件没被读进内存；②响应不预置 `Content-Length`（预置就必须先拼出整包）；③出来的包能被标准解压器逐字节读回，缺文件只跳过该条目，密码确实置上加密位。变异反证：把收据改回 `readFileSync`、或让加密条目开数据描述符，都会让本文件变红 | 真 `DATA_DIR`（临时目录）+ 真 Express router + 真 HTTP + `yauzl` 读回；`process.env.DATA_DIR` 必须在 require 路由之前设置（dbManager 加载时就算好目录）；3 条用例 |
| [`db-size-probe.test.js`](../../../testjs/units/backend/db-size-probe.test.js) | 库体积探针（v6 · 0-4）：明文库能读出 `page_count` / `freelist_count` / 文件与 WAL 体积；非法库必须标 `encrypted=true` 而不是静默 0 页；目录扫描只认 `.db`；`--selftest` 自证两类样本都能跑通 | 临时明文库 + 随机字节文件；4 条用例 |
| [`storage-size-probe.test.js`](../../../testjs/units/storage/storage-size-probe.test.js) | 目录 / 日志体积探针（v6 · 0-5）：嵌套目录按文件字节累加、缺失目录标 `missing`、`dataDir` 与 `userData` 两处日志分别统计且合计一致 | 临时目录；4 条用例 |
| [`perf-mem.test.js`](../../../testjs/units/runtime/perf-mem.test.js) | 导出内存探针（v6 · 0-5）：默认关闭时 `memSnapshot()` 返回 `null` 且不产出日志；`PERF_EXPORT=1` 时才打 rss / heap / external 差值；没有 before 时不采样；导出路由必须在 `finally` 里记录，成功/失败都留痕 | 环境变量切换 + 源码接线判据；4 条用例 |
| [`perf-mark.test.js`](../../../testjs/units/runtime/perf-mark.test.js) | **首屏分段打点**（v6 · P1-01）：①`perfNow` 是 epoch 毫秒、能与后端/主进程日志直接相减；②一条汇总里同时有总耗时与各段（排队 / 凭据 / 加密 / 发送 / 解密），并带 `@epoch` 兼容启动探针；③没有 `__perf` 的普通请求完全空转、`console.log` 抛错也不影响请求；④关键接线段真的插上了（含 Dashboard 的 `nextTick` 渲染段）。**注意**：它验证的是「打点接好了」，不是「首屏变快」——95ms 归因仍要真机跑 `measure-startup.mjs` 取数 | 直接 `import()` 前端 ESM（`student-frontend` 是 `type: module`），无需浏览器；4 条用例 |
| [`crypto-stat.test.js`](../../../testjs/units/security/crypto-stat.test.js) | 安全通道加解密分段计时（v6 · 0-3）：无收集器时空转、只结算一次、收集器抛错静默；三段打点必须挂在 `encryptAuthProof` / `encryptBody` / `decryptBody` 原语上，前后端接线齐全 | 前端 ESM 动态 `import()`；5 条用例 |
| [`docs-counts.test.js`](../../../testjs/units/meta/docs-counts.test.js) | **文档计数唯一来源**（v6 · 5-3）：①9 项计数都能从源码现算，且每份文档里确实存在可替换的数字位置；②`replaceCount` 只替换捕获到的数字、前后缀原样保留、同值幂等；③文档结构变了匹配不到时必须返回 null（让 `docs:sync` 报错，而不是静默跳过）。它锁的是「验数」与「改数」共用一张表，不锁具体数值（数值由 `docs:verify` 对账） | 直接 `import()` ESM 工具模块；3 条用例 |
| [`event-loop-stats.test.js`](../../../testjs/units/meta/event-loop-stats.test.js) | 主进程事件循环延迟（v6 · 0-7）：`statsFromHistogram` 的 ns→ms 口径、空 histogram 返回 `null`、`start` 幂等、`stop` 后不再读数；接线判据锁 `perf-snapshot` 带 `eventLoop`、启动后 3s 有观测窗口、内存首采延后且计耗时 | 真 `perf_hooks` + 假 histogram；4 条用例 |
| [`architecture-guard.test.js`](../../../testjs/units/meta/architecture-guard.test.js) | **架构守卫**（v6 · 6-2 / 6-3）：①`schema/*.js` 的 `CREATE TABLE` 与 `schema/tableRegistry.js` 双向一致（多一张、少一张、分组写错都红）；②`slotStore` 的逻辑表名与 `registry.LOGICAL` 完全一致且都指向真实物理表；③业务层没有表名字面量数组；④`electron` 里的通道名全部在 `ipc-channels.json` 里、`preload` 直接引用该文件。检查函数都接收源码文本，测试同时喂真实文件与注入的违规片段 —— 只跑真实文件的话，正则写错（永远匹配不到）也会一直绿 | 源码文本扫描；8 条用例 |
| [`ai-doc-transaction.test.js`](../../../testjs/units/ai/ai-doc-transaction.test.js) | AI 单块写入（`POST /api/ai/doc`）的「校验 + 快照 + 写入」同事务：校验阶段建的临时学生不许在写入失败后留在名册（v6 · Q4-01） | 内存库 + 真 router；3 条用例 |
| [`album-merge-undo.test.js`](../../../testjs/units/album/album-merge-undo.test.js) | 合并相册的撤销（Q2-09）：建新虚拟相册 + 复制照片索引 + 删掉全部源相册作为**一条**撤销登记，撤回来不能只剩半套 | 内存库 + 真 router；4 条用例 |
| [`app-select-esc.test.js`](../../../testjs/units/ui/app-select-esc.test.js) | Esc 让位协议（A5-05）：弹层在下拉展开时消费 Esc（`defaultPrevented`），父弹窗不再被连带关闭；判据锁「生产端统一走 `consumeEscape`」，不逐个弹层手写 | 前端 ESM 动态 `import()`；4 条用例 |
| [`arrange-datasource.test.js`](../../../testjs/units/seat/arrange-datasource.test.js) | 智能排表「选择数据源」：只排当前表已有的人 / 从名册取人两种语义，切换数据源时清掉上一次的落位与 `allowNew` | 纯函数；4 条用例 |
| [`arrange-desk-mixed.test.js`](../../../testjs/units/seat/arrange-desk-mixed.test.js) | 智能排表按「桌号表」工作：混合桌（两列之间是走廊）下同桌判定不能再用列号奇偶，判据换成按桌号成组 | 纯函数；4 条用例 |
| [`arrange-grid-boundary.test.js`](../../../testjs/units/seat/arrange-grid-boundary.test.js) | 智能排表弹窗的「网格 ↔ dense」边界：库里 `seats` 是网格（走廊是真实列），算法按 dense 下标工作，出入两向都必须映射，不能把走廊当座位 | 纯函数；4 条用例 |
| [`auth-sync.test.js`](../../../testjs/units/account/auth-sync.test.js) | 跨窗口登录态同步（v6 · 2-3b）：按「账号 + 库 + 会话」判身份，滑动续期不算换人（否则每次续期都误清缓存）；换号/登出先换代次再广播；三个窗口入口都必须走 `installAuthSync` | 前端 ESM 动态 `import()`；8 条用例 |
| [`backup-archive.test.js`](../../../testjs/units/backend/backup-archive.test.js) | 备份包 v3「带全了哪些东西」（N2-02）：库三件套（含 `-wal` / `-shm`）+ 长期记忆 + 五个目录 + 清单；缩略图不入包但必须写进 `omitted` | 临时目录 + 真 `writeBundle`；2 条用例 |
| [`backup-restore.test.js`](../../../testjs/units/backend/backup-restore.test.js) | 还原侧的「允许动现有文件的时机」：解包与逐项校验先做完（缺项 / 内容被改 / 名字不安全都在这步失败），校验通过才换目录，旧目录改名 `.bak-<stamp>` 不删 | 临时目录 + 真 zip；4 条用例 |
| [`backup-wal-roundtrip.test.js`](../../../testjs/units/backend/backup-wal-roundtrip.test.js) | 备份一致性真库往返（v8 · 5-1 / N2-01）：连接常开 + WAL 尾页复现「刚编辑就备份」生产常态——① 导出前 `checkpointForBackup` 把尾页并回主库，只拷主库仍能读到最近提交；② checkpoint 失败退回三件套时恢复侧落位并回放 `srcWal`，WAL 里的提交不丢。生产修复已在 fc41e39 落地，本测试是行为守卫（SQLite online backup API 因加密库目标不带 key 被否决，见 snapshot.js 注释） | 真库 + 常驻连接 + WAL 尾页；2 条用例 |
| [`undo-cascade-same-tx.test.js`](../../../testjs/units/backend/undo-cascade-same-tx.test.js) | 级联删除与撤销登记同事务（v8 · 5-2 / Q2-01）：服务端 `deleteStudentCascade` 把七处清理 + 删学生 + `undoStore.push` 收进一个事务，① 删除后 `undo_history` 立即可见（无第二次请求）、② 让撤销 INSERT 失败则七处一起回滚、③ 前端消费响应 `undoId` 不再二次登记 | 真内存库 + 故障注入 + 接线断言；3 条用例 |
| [`blob-error.test.js`](../../../testjs/units/storage/blob-error.test.js) | 二进制下载失败体归一（A4-01）：`responseType:'blob'` 时 4xx 的 `data` 也是 Blob，必须还原成对象，既有 `err.response?.data?.error` 才能拿到后端原因 | 前端 ESM 动态 `import()`；4 条用例 |
| [`bundle-restore.test.js`](../../../testjs/units/storage/bundle-restore.test.js) | v3 包落盘的四种坏情况：包里缺某目录 / 坏包 / 缺库文件时**都不许**把本机目录清空；替换与备份目录成对，失败不留一半 | 临时目录 + 真包；4 条用例 |
| [`context-menu-exclusive.test.js`](../../../testjs/units/ui/context-menu-exclusive.test.js) | 右键菜单互斥：座位页行标签与列头是**两个组件实例**，只能靠模块级登记表让新菜单把旧菜单关掉 | 前端 ESM 动态 `import()`；4 条用例 |
| [`context-menu-transition.test.js`](../../../testjs/units/ui/context-menu-transition.test.js) | 右键菜单过渡：先用 `visibility: hidden` 量尺寸再显示（避免贴边溢出），过渡结束态必须与量尺寸时的定位一致 | 前端 ESM 动态 `import()`；3 条用例 |
| [`crypto-stat.test.js`](../../../testjs/units/security/crypto-stat.test.js) | 安全通道加解密分段计时（v6 · 0-3）：无收集器时完全空转、只结算一次、收集器抛错静默；三段打点必须挂在 `encryptAuthProof` / `encryptBody` / `decryptBody` 原语上，前后端接线齐全 | 前端 ESM 动态 `import()`；5 条用例 |
| [`dialog-stack.test.js`](../../../testjs/units/ui/dialog-stack.test.js) | 弹窗层级栈（V5-003）：`openStack` 原先写在 `<script setup>` 里、每个实例一份，抽成模块级后一次 Esc 只关最上层 | 前端 ESM 动态 `import()`；4 条用例 |
| [`account-data-dialog.test.js`](../../../testjs/units/account/account-data-dialog.test.js) | 「查看 AI 记录」时账号数据管理弹窗必须保留：`view()` 只 emit view 不 close；聊天记录弹窗层级走 `zIndex` prop 且设置页传值高于管理弹窗；`v-if` 懒挂载需 immediate watcher 保证首开有数据；档位草稿/预览确认/关闭按钮主题适配；历史快照选择层与四层弹窗层级；回收站两行档位接线、dirty/预览覆盖四类、撤销影响文案 | 源码判据；11 条用例 |
| [`receipt-download-all.test.js`](../../../testjs/units/backend/receipt-download-all.test.js) | 「管理收据 → 下载全部」必须一次打 ZIP：`downloadAll` 把当前列表交给 `saveZipWithDialog` 的 `receiptGroups`，不逐条弹保存框；取消不提示、失败才提示；变异成逐条保存必须红 | 源码判据；4 条用例 |
| [`duplicate-name-pick.test.js`](../../../testjs/units/backend/duplicate-name-pick.test.js) | 手工填表同名选人：班干部 `pickCandidate` 必须记住选中对象（同名不按姓名取第一个）、手输同名提示；座位/值日格内候选显示「姓名 · 学号」，课表候选不受影响 | 源码判据 + 变异反证；2 条用例 |
| [`import-duplicate-name-pick.test.js`](../../../testjs/units/backend/import-duplicate-name-pick.test.js) | 批量导入同名选人：后端按行 `studentIds` 落指定 id（不存在 400）、`new` 建临时学生、不传保持旧行为；前端只在传名册时检测、弹窗默认第一位、确认后才 emit | 内存库 + 源码判据 + 变异反证；5 条用例 |
| [`cadre-import-duplicate-pick.test.js`](../../../testjs/units/student/cadre-import-duplicate-pick.test.js) | 班干部导入同名选人：「担任学生」列一行多名，key 用 `${行}:${slot}`；按选中 id 落库且姓名以库为准、`new` 建临时、非法 id 400 整批回滚、不传维持旧行为；前端传名册+列名+多名标记并透传 `studentIds` | 内存库 + 源码判据 + 变异反证；7 条用例 |
| [`group-import-duplicate-pick.test.js`](../../../testjs/units/student/group-import-duplicate-pick.test.js) | 分组导入同名选人：按行 `studentIds` 落指定 id、`new` 建临时、非法 id 400 整批回滚、不传维持旧行为；前端传名册并透传 `studentIds` | 内存库 + 源码判据 + 变异反证；5 条用例 |
| [`smart-group-student-id.test.js`](../../../testjs/units/ai/smart-group-student-id.test.js) | 智能分组写回同名定人：`emit('confirm')` 带 `studentIds` 矩阵（key = 组:位置），后端按 id 落权威字段，同名两人分不同组各自独立、非法 id 400 整批回滚、不传维持按姓名认人 | 内存库 + 源码判据 + 变异反证；6 条用例 |
| [`seat-move-occupied.test.js`](../../../testjs/units/seat/seat-move-occupied.test.js) | 座位候选不再剔除已入座学生：标「已排座：第X行第Y座」，选中后 `relocateDuplicateSeats` 清旧格；姓名串不参与；无匹配时给「新增临时学生」入口且只对落 id 的候选 | 纯函数 + 源码判据 + 变异反证；6 条用例 |
| [`duty-config.test.js`](../../../testjs/units/duty/duty-config.test.js) | 值日列名按模式分键（`daily` 星期 / `big` 分组名 + 全部）后的读写对称：读走 `readDays`、写走 `writeDays`，模式配置落 `settings`，不得退回单一全局列名 | 内存库；4 条用例 |
| [`duty-enum-roundtrip.test.js`](../../../testjs/units/duty/duty-enum-roundtrip.test.js) | 值日周期/星期枚举前后端一致性（v8 · 5-4 / G11）的**行为测试**：把前端设置弹窗每个选项经后端 `writeConfig`→`readConfig` 真库往返，断言原样取回；两侧枚举漂移时后端会把界面能选的值静默退回默认 | 真库往返 + 前端 ESM 动态 `import()`；2 条用例 |
| [`duty-dedupe-whole-table.test.js`](../../../testjs/units/duty/duty-dedupe-whole-table.test.js) | 「整表去重」开关必须真的生效（A3-01）：`ctx` 里状态都是 ref/computed，`ref(true) === true` 恒为 false，判据必须解包后再比较 | 纯函数；4 条用例 |
| [`duty-index.test.js`](../../../testjs/units/duty/duty-index.test.js) | 值日指数累加单源化：展示值与排表账本共用 `accumulateDutyIndex`，只有结算区间不同；刷新必须同时刷两处 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-ordered-arrange.test.js`](../../../testjs/units/duty/duty-ordered-arrange.test.js) | 独立条件「顺序选项」：行优先 / 列优先与反向只作用于行内、列内，不改变跨行列的填充顺序 | 纯函数；4 条用例 |
| [`duty-packed-arrange.test.js`](../../../testjs/units/duty/duty-packed-arrange.test.js) | 「随机分组」接入流水线：与 `duty-packing` 分工不同，这里锁「整条 pipeline 真的调用了装箱内核」，而不是内核本身 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-packing.test.js`](../../../testjs/units/duty/duty-packing.test.js) | 分组装箱 + 整天随机映射内核：`intactGroups` 必须能从 buckets 反推（不许「显示 100% 但组被拆」），已满足的组不再打乱 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-save-transaction.test.js`](../../../testjs/units/duty/duty-save-transaction.test.js) | 建档副作用与写入同事务（N2-06）：`PUT /api/duty/save` 的 `validateRow` 挪进事务，避免「值日表回滚了、临时学生已提交」；另锁「名册外姓名照常建档」不被修死 | 内存库 + 真 router；3 条用例 |
| [`duty-slot-warning.test.js`](../../../testjs/units/duty/duty-slot-warning.test.js) | 「值日位置不足，有 X 人排不进」确认框：X 必须来自 `shortageCount` 单源；「重复值日」那一支方向相反，不能被新文案吞掉 | 前端 ESM 动态 `import()`；3 条用例 |
| [`duty-settings-hydrate.test.js`](../../../testjs/units/duty/duty-settings-hydrate.test.js) | 值日设置弹窗「首次打开即初始化」：父组件 `v-if="settingsMounted"` 懒挂载，首次挂载时 `visible` 已为 true，`watch` 不带 `immediate` 就一次都不跑 → 重启后首次打开星期与劳动项目全空（真实故障）；权重算法弹窗同理 | 读真实源码（去注释）；3 条用例 |
| [`duty-weight-linkage.test.js`](../../../testjs/units/duty/duty-weight-linkage.test.js) | 权重表多子行联动：底层一个项目只有一个权重值，编辑任一子行必须同步到该项目所有天，一维表按均值口径比对 | 前端 ESM 动态 `import()`；4 条用例 |
| [`group-dimension-delete.test.js`](../../../testjs/units/student/group-dimension-delete.test.js) | 分组维度删除的撤销（Q2-08）：维度 + 该维度全部小组 + 全部成员 + 剩余维度重排合成一条撤销，不许留下只能手工重建的状态 | 内存库 + 真 router；4 条用例 |
| [`kill-tree.test.js`](../../../testjs/units/desktop/kill-tree.test.js) | 「杀进程树」端到端（V5-010/011/013）：真实三层进程树（父 → 子 → 孙），Windows 与 POSIX 分支都不许留孤儿 | 真子进程；3 条用例 |
| [`leave-undo-wiring.test.js`](../../../testjs/units/duty/leave-undo-wiring.test.js) | 请假记录全链路撤销（Q2-05）：新增（弹窗 / 行内）、编辑、删除、销假、撤销销假都要登记，不能只有单元格编辑可撤 | 内存库 + 真 router；4 条用例 |
| [`login-contrast.test.js`](../../../testjs/units/account/login-contrast.test.js) | 登录页文字对比度按 WCAG 现算：登录页直接压在背景图上、卡片是半透明玻璃，换背景图就可能从「能看清」变成「整片糊」 | 前端 ESM 动态 `import()`；4 条用例 |
| [`inp-longtask.test.js`](../../../testjs/units/meta/inp-longtask.test.js) | 主线程长任务观察（v6 · 0-2）：16ms 起记录、不支持 `longtask` 时不装配、`observe` 抛错返回 `null`、单条 `onRecord` 抛错不影响后续；渲染层必须把 `longTasks` 汇总进 `dump` 并落 `inp.log`，`reset` 清空 | 前端 ESM 动态 `import()`；6 条用例 |
| [`ipc-binary-payload.test.js`](../../../testjs/units/desktop/ipc-binary-payload.test.js) | IPC 大对象载荷（P3-07 / N2-07）：背景图 >2MB 直接传 `ArrayBuffer`（主进程拒收非二进制、不再解 base64）；业务 ZIP 走磁盘中转，主进程只搬 `classnest-export/` 内的 `.zip`、不设 50MB 上限 | AST 取处理器范围；2 条用例 |
| [`login-file-picker.test.js`](../../../testjs/units/account/login-file-picker.test.js) | 「从数据库登录」是**唯一**的文件入口：渲染层一个 `<input type="file" accept=".db,.json,.zip">` 按扩展名分派，不再有第二个「从备份包恢复」按钮 | 前端 ESM 动态 `import()`；4 条用例 |
| [`media-credential.test.js`](../../../testjs/units/album/media-credential.test.js) | 静态资源凭据（V5-005）：打包版页面是 `file://`，取图属跨站，`SameSite=Lax` 的 httpOnly Cookie 不随 `<img>` 发送，两种模式都必须用 `scope=media` 受限凭据 | 纯函数；3 条用例 |
| [`orphan-check.test.js`](../../../testjs/units/backend/orphan-check.test.js) | 只读孤儿检查器的可信度（v6 §0-4）：一个「永远返回 0」的检查器最容易是假的，所以把 `--selftest`（种 6 条已知孤儿）挂进 CI，改坏判定就变红 | 临时明文库；2 条用例 |
| [`overview-endpoints.test.js`](../../../testjs/units/backend/overview-endpoints.test.js) | 座位/值日首屏概览（P3-15）：`/seats/overview` 与三个单端点、`/duty/overview` 与四个单端点逐字段一致；名册只含 id/姓名/学号；两个前端首屏只发 1 个请求且失败回退单端点 | 内存库 + 真 router；4 条用例 |
| [`receipt-kind.test.js`](../../../testjs/units/backend/receipt-kind.test.js) | 收据 Office 文件打不开（4-1）：校验层按魔数分出 `ooxml` / `ole`，落库前必须归一成 `office`，前端 `viewMode` 同时兼容旧值 | 内存库 + 真 router；4 条用例 |
| [`restore-bundle.test.js`](../../../testjs/units/backend/restore-bundle.test.js) | v2 恢复的完整性预检（V4-B05-13）：先写临时文件 → `integrity_check` 通过才覆盖，坏包不许毁掉本来能用的旧库 | 临时目录；2 条用例 |
| [`save-outcome.test.js`](../../../testjs/units/backend/save-outcome.test.js) | `save-file` 三态判定（V5-002）：`ok` / `fail` / `canceled` 互斥，写盘失败不能被当成用户取消；前端对「失败」抛错、对「取消」返回空串 | 纯函数 + 前端 ESM；4 条用例 |
| [`schema-foreign-keys.test.js`](../../../testjs/units/backend/schema-foreign-keys.test.js) | 外键声明（N2-03 第一步）：9 处 `ON DELETE CASCADE` 齐全、3 处（`cadres.parent_id` / 组员姓名 / 多态 `target_id`）故意不加；新建库立即受约束，老库不回填也不报错 | 内存库；4 条用例 |
| [`search-limits.test.js`](../../../testjs/units/backend/search-limits.test.js) | 全局搜索分页（P3-08）：根因是没有分页而非上限太小 —— `LIMIT ? OFFSET ?` 真翻页、`hasMore` 由每源多取一条精确判定、页参数不接受请求放大 | 纯函数；4 条用例 |
| [`dynamic-table-paging.test.js`](../../../testjs/units/seat/dynamic-table-paging.test.js) | 动态表分页（P3-10）：不传 `limit` 时整表返回、不多回分页字段（行为不变）；`limit/offset` 按 position 切片并回 `total`；`limit` 0/非整数/超 5000 与负 `offset` 一律 400 | 内存库 + 真 router；3 条用例 |
| [`first-paint-batching.test.js`](../../../testjs/units/meta/first-paint-batching.test.js) | 首屏并发编排（F07-10）：设置页把 U 盘/目录/安全级别/登录策略/启动耗时/磁盘占用移入延迟清单，首帧后逐条发；课表页 onMounted 不再拉历史周，切到「历史」页签仍会拉 | 前端 AST；2 条用例 |
| [`seat-ai-align.test.js`](../../../testjs/units/seat/seat-ai-align.test.js) | 座位网格与「对外文案 / 快照 / AI 输出」对齐：走廊是 `seats` 里的真实列，一张 7 座位列的表网格宽 13，任何「第几列」都必须走 `columnLabels`，不能用网格下标 | 内存库 + 真 router；4 条用例 |
| [`seat-aisle-col.test.js`](../../../testjs/units/seat/seat-aisle-col.test.js) | 整列走廊（列头右键「左/右插入」「删除这条走廊」）：插入不动左右两列、删除逐格还原、`cols` 跟着变 | 纯函数；4 条用例 |
| [`seat-aisle-row.test.js`](../../../testjs/units/seat/seat-aisle-row.test.js) | 整行走廊（行标签右键「上方/下方插入」「删除这条走廊」）的几何语义：插入 / 删除后行数、`types`、`seats` 三者同步 | 纯函数；4 条用例 |
| [`seat-cell-write.test.js`](../../../testjs/units/seat/seat-cell-write.test.js) | 座位单格写入（`PATCH /cell`、`PATCH /master/cell`）：收敛到 `services/seatWrite.js` 后，洞 / 走廊 / 不存在的学生 id / 一人占两座都拒绝；整表 PUT 与单格判据同源、业务校验失败都回 400 | 内存库 + 真 router + 真 HTTP；15 条用例 |
| [`seat-desk-pattern.test.js`](../../../testjs/units/seat/seat-desk-pattern.test.js) | 混合桌：不另存桌型序列，桌型从「走廊在哪」派生 —— 拆桌 = 两列之间插一条走廊，合并 = 删掉中间那条 | 纯函数；4 条用例 |
| [`seat-draft-reset.test.js`](../../../testjs/units/seat/seat-draft-reset.test.js) | 排表草稿的模块级单例跟着账号走（X2-07）：换号既要清值又要作废在途响应，否则 B 打开智能排表看到 A 的草稿 | 前端 ESM + 拦截器桩；4 条用例 |
| [`seat-fair-conservation.test.js`](../../../testjs/units/seat/seat-fair-conservation.test.js) | 位置公平（`applyFair`）的人数守恒：按目标块位置数遍历落盘时不能多塞或漏人 | 纯函数；4 条用例 |
| [`seat-geometry.test.js`](../../../testjs/units/seat/seat-geometry.test.js) | 座位网格几何的回归锚点：把改造前的旧公式**原样冻结**在测试里当参考实现，而不是拿新实现跟自己对 | 纯函数；4 条用例 |
| [`seat-hole-paint.test.js`](../../../testjs/units/seat/seat-hole-paint.test.js) | 「设置空位」画笔：纯函数规则（`toggleHole` / `usableSeatCount` / `clearHoles`）+ 真实写入口（能存空位、拒绝「有人的格子挖洞」） | 纯函数 + 内存库 + 真 router；4 条用例 |
| [`seat-types.test.js`](../../../testjs/units/seat/seat-types.test.js) | 格子类型矩阵（`types`）的存取契约：必须穿过 schema、`slotStore` 白名单、视图三层，漏一层就是「PUT 不报错、GET 读到旧值」 | 内存库；4 条用例 |
| [`seat-undo-geometry.test.js`](../../../testjs/units/seat/seat-undo-geometry.test.js) | 撤销的几何契约（P0-3 / P0-2）：几何只从快照 `types` 形状推，前端四元组降级为漂移告警；漏 `cols` 会让座位图整体错列 | 内存库；4 条用例 |
| [`seat-undo-rows.test.js`](../../../testjs/units/seat/seat-undo-rows.test.js) | 撤销「插入/删除行走廊」时行数必须与 `types` 一起回写：`grid_snapshot` 原先只回写 JSON 列，会留下「`types` 少一行、`rows` 还是多的」 | 内存库；4 条用例 |
| [`seat-weight-align.test.js`](../../../testjs/units/seat/seat-weight-align.test.js) | 权重表跟随座位表几何：权重矩阵独立存储，划成走廊或挖洞后旧数字仍在，取消走廊时必须重新对齐 | 内存库；4 条用例 |
| [`secure-retry.test.js`](../../../testjs/units/security/secure-retry.test.js) | 安全信道 401 重试的分支判定（N1-02）：凭据降级 / `auth-required` / `session-expired` 三个分支抽成纯函数后可单测，不再只靠需要 Vite + Electron 的冒烟脚本 | 纯函数 + 前端 ESM；4 条用例 |
| [`sequenced-cache.test.js`](../../../testjs/units/backend/sequenced-cache.test.js) | 带账号代次的进程内缓存（P0-6）：TTL 复用 + 写入前核对代次 + 失败不缓存；`invalidate()` 同时清值并作废在途，`clear()` 只清值 | 前端 ESM；4 条用例 |
| [`session-revocation.test.js`](../../../testjs/units/account/session-revocation.test.js) | 凭证变更 → 全账号会话失效（A1-16）：账号维度必须是 `(userId, dbSlug)` 双键（各库 `users.id` 都可能是 1）；改密后走响应头换发新凭据，图片不裂 | 真 `sessions` + 隔离 `dataDir`；4 条用例 |
| [`auth-policy.test.js`](../../../testjs/units/account/auth-policy.test.js) | **登录保持天数（按账号）**：这套配置在每个鉴权请求的路径上（签发 / 续期 / 名单清理都读它），三类错必须被挡住 —— ①默认值错 → 老用户升级后行为突变；②按账号隔离失效 → 键用错维度（`dbSlug` vs `username`）时，切个班设置就丢；③派生值不自洽 → 续签窗口 ≥ 天数（每个请求都重签，慢而无报错）、名单清理期 ≤ token 寿命（活跃用户被踢下线，V5-009 同类）。另含坏文件退回默认、改名搬迁、按班级 slug 反查账号 | 临时 `dataDir`；10 条用例 |
| [`sessions-ttl.test.js`](../../../testjs/units/account/sessions-ttl.test.js) | 会话名单的活动时间与清理（V5-009）：`at` 改为最后一次活动时间（1 小时节流落盘），否则持续使用的会话会在下一次 prune 时被当成弃用踢掉；另含「清理期按账号算」——1 天配置（6 天 TTL）的会话先被清，默认账号（35 天）不受影响 | 临时状态文件；8 条用例 |
| [`single-flight.test.js`](../../../testjs/units/backend/single-flight.test.js) | 启动单飞守卫（P0-5）：并发调用只跑一次且拿到同一 Promise，同步副作用不延后微任务，失败后可重试 | 纯 Promise；4 条用例 |
| [`student-cascade-delete.test.js`](../../../testjs/units/student/student-cascade-delete.test.js) | 删除学生的级联撤销（Q2-03）：七处（学生 / 请假 / 加减分 / 小组 / 班干部 / 座位 / 值日）合成**一条**撤销，不许按七次撤、也不许留半个 | 内存库 + 真 router；4 条用例 |
| [`student-delete-guard.test.js`](../../../testjs/units/student/student-delete-guard.test.js) | 删学生不许留孤儿（N2-05）：通用删除入口先算关联，有就拒并列出明细，让调用方走「一并删除」（偷偷清会绕过撤销登记） | 内存库；4 条用例 |
| [`token-renewal.test.js`](../../../testjs/units/account/token-renewal.test.js) | 滑动续期「换代即作废」（X2-08）：响应合法，唯一线索是「发请求时是哪一代」；代次不符一律丢弃，缺参数抛 `TypeError` | 纯函数（依赖注入）；4 条用例 |
| [`undo-recorder.test.js`](../../../testjs/units/backend/undo-recorder.test.js) | 撤销登记只能有一个入口（Q2-10）：失败必须弱提示、不许 `.catch(() => {})`；成功后刷新 Ctrl+Z 可用态，批次不逐条刷 | 前端 ESM；4 条用例 |
| [`user-scoped-race.test.js`](../../../testjs/units/account/user-scoped-race.test.js) | 换号后在途请求不得写回（V5-004）：请求发出时记登录代次，响应回来代次变了就丢弃并重拉 | 前端 ESM；4 条用例 |
| [`week-dates.test.js`](../../../testjs/units/seat/week-dates.test.js) | 「星期列 → 具体日期」换算：按星期名取而不按列下标取（表头可拖拽），月和日不补零，非法日期返回空串 | 前端 ESM 动态 `import()`；4 条用例 |
| [`widget-data-changed.test.js`](../../../testjs/units/desktop/widget-data-changed.test.js) | 挂件不再只靠 5 分钟轮询（A5-02）：写请求成功后按域广播，基础设施写（聊天/相册/账户/导出/握手）排除，未知业务写保守全量失效 | 前端 ESM；4 条用例 |
| [`widget-overview.test.js`](../../../testjs/units/desktop/widget-overview.test.js) | 挂件单请求概览（P3-14）：一次回 5 项、名册只含 id/姓名、单项失败不影响其余、前端每轮只发 1 个请求 | 内存库 + 真 router |
| [`zip-bundle.test.js`](../../../testjs/units/storage/zip-bundle.test.js) | 备份包两块地基（A1-03 / N3-03）：`sanitizeEntryName` 拦 Zip Slip（`../` 与盘符），`writeZip` 流式打包后能被标准解压器逐项读回（名字、内容、CRC / 尺寸都对得上） | `yauzl` 读回；4 条用例 |
| [`zip64.test.js`](../../../testjs/units/storage/zip64.test.js) | 备份包**统一 ZIP64** 的写出结构：条目本地头 extra（0x0001/16）/ 24 字节 64 位数据描述符 / 中央目录 extra（0x0001/24）/ EOCD64 + locator + 经典 EOCD 哨兵；小包也写 ZIP64 且能被 yauzl 原样读回（结构统一不牺牲可读性）；写侧与读侧闸值（解包 + 上传）统一从 `ZIP64_LIMITS` 派生 | 稀疏 >4GB 源 + 丢弃型 sink（不落盘、只留结构字节）+ 落盘小包 yauzl 往返；4 条用例 |
| [`zip-peek.test.js`](../../../testjs/units/storage/zip-peek.test.js) | 「这个备份包要不要口令」的判断必须与真包一致：误判「不用口令」会让用户卡在解不出钥匙，误判「要口令」只多问一句 | 前端 ESM + 真 zip；4 条用例 |
| [`undo-batch-coverage.test.js`](../../../testjs/units/backend/undo-batch-coverage.test.js) | 一次动作改多行必须整批可撤（Q2-04 / Q2-05 / Q2-06）：`row_reorder` / `rows_batch_insert` / `rows_batch_delete` 真能回滚；导入端点与 `tableService.importRows` 都回传完整 `created`（否则几百行会被「每 key 50 条」上限截断） | 内存库 + 真 router；3 条用例 |
| [`log-rotator.test.js`](../../../testjs/units/meta/log-rotator.test.js) | 日志体积收口（v6 · 1-1）：`rotateIfNeeded` 对不存在/未超限的文件不动，超限只留「提示行 + 最近尾部」且不整份读入内存；`appendWithRotation` 自动建目录、同一文件串行追加（20 行不乱序不丢行）、超限前先截断；接线判据锁 `backend.log` 建流与截断全程异步（不再有 `fs.appendFileSync`）、`inp.log` / `desktop-layer.log` 共用同一出口、运行期有 5 分钟低频巡检 | 临时目录；3 条用例 |
| [`secure-bridge.test.js`](../../../testjs/units/security/secure-bridge.test.js) | 安全通道握手报文桥（v6 · 2-19）：请求体只有 `{ pub }`、URL 固定指向后端握手端点；公钥形状非法时不发出任何请求；后端非 2xx、响应缺 `sessionId`、响应非 JSON 都必须报错；接线判据锁 `ipc-channels.json` 已登记、授权与 `get-master-key` **完全一致**、渲染层走 IPC 且保留纯浏览器下的 `fetch` 兜底、私钥从不导出 | 注入 fake `fetchImpl`；4 条用例 |
| [`photo-info-cache.test.js`](../../../testjs/units/album/photo-info-cache.test.js) | 相册「信息」缓存封顶（v6 · 1-4）：超过 200 条淘汰最久未使用、命中会刷新顺序；模块加载时已登记用户级清理（登出/换号后为空）；接线判据锁 `AlbumView` 不再自带无上限 `Map`、读写与卸载都走该模块 | 前端 ESM 动态 `import()`；3 条用例 |
| [`secure-channel-idle-sweep.test.js`](../../../testjs/units/desktop/secure-channel-idle-sweep.test.js) | 安全通道空闲清扫（v6 · 1-5）：`now` 可注入 → 推进到 TTL 之后会话必被清、未过期不动；清扫定时器幂等、`unref`（不拖住进程退出）、可停；接线判据锁「只有 `initMaster` 成功才启动」且握手/凭据路径上的兜底清扫仍在 | 真 `node:crypto` 生成公钥；3 条用例 |
| [`secure-response-serialize.test.js`](../../../testjs/units/security/secure-response-serialize.test.js) | 响应只序列化一次（v6 · 1-2）：加密分支信封与 `JSON.stringify({ d })` **逐字节一致**且不再经过 `res.json`；密文能被同一会话密钥解回原对象；非加密 / 豁免路径 / 会话失效仍走 `res.json` 原路；`no-store` 头保留 | 假 `req`/`res` + 真 seal/open；3 条用例 |
| [`lifecycle-resources.test.js`](../../../testjs/units/runtime/lifecycle-resources.test.js) | 定时器/监听器「创建处 = 销毁处」守卫（v6 · 1-11 + 1-13）：全量扫描 `src/**`，`setInterval` 必须有 `clearInterval` 或 `d.interval`；`window`/`document` 级 `addEventListener` 必须被移除、`.listen()`、`{ once: true }` 或 `{ signal }` 覆盖（元素级监听随元素销毁不计）；豁免表每项都必须仍需要豁免（防止过期白名单）；并用注入样本自证规则真的会判红 | 源码文本审计；4 条用例 |
| [`data-export-tables.test.js`](../../../testjs/units/storage/data-export-tables.test.js) | `/api/data/tables` 只计数不物化（v6 · 1-3）：内存库 + 真 router，插入 3 名学生 / 2 个活动后计数正确；用 SQL spy 断言整个 GET 期间**没有任何** `SELECT * FROM students\\|activities`、且确实走了 `COUNT(*)`；没有物理表的「应用设置」仍走 `build` 兜底；再按源码判据锁「除派生表外每张表都配了 count」 | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；2 条用例 |
| [`pkg-size-probe.test.js`](../../../testjs/units/meta/pkg-size-probe.test.js) | 打包体积探针（v6 · 1-12）：`fmtBytes` 的 B/KB/MB 边界与异常值；分桶把 asar / 根依赖 / 作用域依赖 / 后端依赖 / 语言包 / 根目录二进制分开（resources 下的 ffmpeg 不混进主程序）；汇总同桶累加并按体积降序；`package.json` 的每个生产依赖都必须能 `require.resolve` | 纯函数 + 真实 package.json；4 条用例 |
| [`probe-gating.test.js`](../../../testjs/units/meta/probe-gating.test.js) | 探针闸门登记（X1-02）：`run-probes.cjs` 白名单里的脚本都必须真实存在；IPC 四件套（`ipc-guard` / `ipc-policy` / `ipc-usage` / `main-ipc-contract`）必须在白名单里，否则失败不会让 `npm test` 变红 | 纯静态解析白名单；2 条用例 |
| [`get-share.test.js`](../../../testjs/units/backend/get-share.test.js) | 通用 GET 在途共享（v6 · 1-7）：同 key 并发只调一次底层请求且两个调用方拿同一份响应；成功后 TTL 内复用、过期重发；换号后旧响应 reject 成 `ERR_CANCELED` 且不写缓存；写操作 `markDirty` 只清缓存、不取消在途，写后新调用重新发请求；`keyOf` 只认普通 GET（写 / blob / `signal` / `__noShare` 均不共享）；条目超上限淘汰最旧；接线判据锁 `httpClient` 装适配器 + 登记换号清理 + 写成功 `markDirty` | 前端 ESM 动态 `import()` + 注入时钟/代次；7 条用例 |
| [`seat-daily-aggregate.test.js`](../../../testjs/units/seat/seat-daily-aggregate.test.js) | 座位账本 / 座位指数单遍结算（v6 · 1-9）：5 组确定性随机快照下，单遍合并结果与改造前「loadSeatLedger + seatIndexRows」两份遍历逐学生 `deepEqual`；账本不含今日、指数不含所选周之后（并集多拉的天数不能串口径）；`indexTo` 为空表示不设上限；`unionCutoff` 的 `''` 语义；接线判据锁 `SeatView` 只剩 1 处 `/seats/daily`、缓存命中 + 在途复用、旧的 `seatIndexDaily` 已移除 | 前端 ESM 动态 `import()`；5 条用例 |
| [`batch-delete.test.js`](../../../testjs/units/backend/batch-delete.test.js) | 批量删除端点（v6 · 1-8）：内存库 + 真 router，一次 `POST /batch-delete` 删 2 条并去重、position 重排连续；夹一个不存在的 id → 400 且合法那条也没被删（真事务回滚）；`minCount=1` 时删空 → 400 一行不掉；单条 `DELETE /:id` 仍可用；缺 ids / 全非法 id 直接拒绝；源码判据锁前端两处删除各只发 1 个 `batch-delete`、不再逐条 DELETE | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；6 条用例 |
| [`startup-io.test.js`](../../../testjs/units/runtime/startup-io.test.js) | 启动期同步 IO 打点（v6 · 1-10）：`PERF_STARTUP` 未开时一个 fs 方法都不替换；开启后按方法计数且返回值/异常原样透传（计时不能改语义）；重复 `install` 不叠加；`summarize` 打印合计并把 mark 写进启动时间线；未安装时空转；接线判据锁 `main.js` 的安装早于首个同步 IO、`summarize` 早于 `report` | 注入假 fs；5 条用例 |
| [`dashboard-summary.test.js`](../../../testjs/units/seat/dashboard-summary.test.js) | 首屏 dashboard 摘要化（v6 · 2-1）：内存库 + 真 router 造 45 人 / 1000 条加减分 / 7 条班费 —— 响应里不再有全量 `scores`/`fees`、`students` 只剩 `id+姓名`；`summary` 的 Top4（含扣分转负、小组名）与班费三口径与改造前 `DashboardView` 的 computed 逐项一致；同数据量下整包 < 30KB（改造前 358.8KB）；并锁前端不再读 `d.scores`/`d.fees`、造数工具改读 `summary` | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；4 条用例 |
| [`main-env.test.js`](../../../testjs/units/desktop/main-env.test.js) | 开发/打包模式判定唯一口径（v6 · 2-20）：Electron 45 下 `app.isPackaged` 在源码模式误报 true，用 `process.defaultApp` 纠正；三种组合（打包 / Electron45 源码 / 常规源码）逐一断言；`electron/main/*.js`（除 `main.env.js`）不得再出现 `app.isPackaged`；`main.*.js` 都从 `main.env` 取值、更新入口用 `isPackaged` 挡住开发环境 | 注入假 electron + 改写 `process.defaultApp`；5 条用例 |
| [`undo-sql-outlet.test.js`](../../../testjs/units/backend/undo-sql-outlet.test.js) | 撤销域的 SQL 出口（档 C · M12-B8）：`undo.*` 的 4 个文件都不许有 `db.prepare(`、不许持有 db；`undoStore` 必须承担记录表的插入与方向 CAS、每 key 淘汰；执行器的 8 个复合动作必须真的经 store。**这条判据锁的是双份口径**：同一条 `undo_history` 查询原先抄在入口与记录两处，一处改了另一处没改，表现是「面板里有记录、Ctrl+Z 说没有」 | 源码判据 |
| [`undo-replay-sanitize.test.js`](../../../testjs/units/backend/undo-replay-sanitize.test.js) | 撤销回放前按列级规则清洗脏值（X3-06）：`insertRow` / `updateRowById` / `setCellValue` 三条路径都对声明了规则的标量列过 `sanitizeField`（脏格式日期归一），无规则列与 JSON 列跳过（避免合法数字被 String 化、`[object Object]`），清洗抛错时保留原值——恢复语义优先，撤销按钮不能失效 | 内存库 |
| [`ai-subagent-live.test.js`](../../../testjs/units/ai/ai-subagent-live.test.js) | 子助手轨迹**实时下发**：一份轨迹源同时供增量事件与最终全量步骤使用，`done` 事件整体覆盖实时结构（不重复、不跳变）；缩进与聊天气泡的复制豁免不外溢。修的是「子助手做完才冒出来」 | 桩 `fetch` 跑真实 `consumeStream` + 前端 ESM |
| [`ai-tool-evidence.test.js`](../../../testjs/units/ai/ai-tool-evidence.test.js) | **AI 工具调用证据跨轮可见**：工具调用与 tool 角色结果原先只活在单次请求里，`loadConversationContext` 连 `process_json` 都没 `SELECT` → 下一轮模型不知道自己调过哪些工具。判据锁读回与收尾对账，并锁写入侧仍走 `aiConversationStore` | 内存库 + 真 router |
| [`album-grid-rows.test.js`](../../../testjs/units/album/album-grid-rows.test.js) | 相册「组内按行虚拟滚动」：A 行裁剪的算术（位置、切片、高度预留、边界）；B 接线（`AlbumView` 只渲染可见行、几何常量取自同一处，不再整组 `v-for`） | 纯函数 + 源码判据 |
| [`album-paging.test.js`](../../../testjs/units/album/album-paging.test.js) | 相册照片分页（v6 性能专题 · 2-23）：日期索引 `/:id/dates` 与「日期游标」分页；**全量与分页必须同源**（列与排序只有一份）；分页只对列表 opt-in（导出、删前快照、首页随机图仍要全量）；末尾一条 SQL 出口判据锁 `albumStore` | 内存库 + 真 router |
| [`album-photo-focus.test.js`](../../../testjs/units/album/album-photo-focus.test.js) | 首页配图点进相册的定位链路：`GET /random-photo/thumb` 的 `X-Photo-Id` → `/album?photo=<id>` → `GET /photo/:id/locate` 查到相册与日期 → 滚到那一天并打开查看器。锁「定位只读索引一行」，不 stat 源文件、不拉整册分页 | 内存库 + 真 router + 前端源码判据 |
| [`album-photo-pages.test.js`](../../../testjs/units/album/album-photo-pages.test.js) | 日期分页的纯逻辑：日期步进差一天会让同一页反复请求；锚点落在已加载组上会白拿整页；合并时连已加载组一起覆盖会让对象 URL 失效、画面闪白。另锁「组头张数取后端日期计数」与未知时间组永远在最后 | 纯函数 |
| [`album-random-thumb.test.js`](../../../testjs/units/album/album-random-thumb.test.js) | 首页随机配图接口：`exclude` 排掉当前张、排除后查不到要**退回不排除**（不能回 404，否则首页会清掉现有配图）；`X-Photo-Id` 随图带回；不再让前端遍历各相册拉全量列表 | 内存库 + 真 router |
| [`album-resize-throttle.test.js`](../../../testjs/units/album/album-resize-throttle.test.js) | 改窗口时不要反复掐断在途缩略图：`resizing` 安静窗口只冻结**视口重测**，布局本身照常跟随；否则每帧 abort 一次生成请求，越拖越卡 | 纯函数 + 源码判据 |
| [`album-scan-incremental-thumb.test.js`](../../../testjs/units/album/album-scan-incremental-thumb.test.js) | 两套刻意相反的语义（别合并）：增量「已有就跳过、只补丢的」按文件存在判定、不读内容；全量「无条件重建」是修坏图与刷缓存的唯一入口 | 内存库 + 临时目录 |
| [`album-scan-two-phase.test.js`](../../../testjs/units/album/album-scan-two-phase.test.js) | 全量扫描的**两阶段**：先建索引（stat + EXIF），再逐张生成缩略图；阶段名 `phase`（`index` / `thumb`），续扫分支不许覆盖 phase；直接调 `fullScan` 前必须先 `claimScanTask` | 内存库 |
| [`album-thumb-priority.test.js`](../../../testjs/units/album/album-thumb-priority.test.js) | 缩略图「插队」的粒度与中断：粒度是**行**（用户看到的这几行）而不是整天；新请求到达时旧请求 abort；重复 id 去重；断开立刻归还尚未开工的额度 | 纯函数 + 源码判据 |
| [`album-thumb-retry.test.js`](../../../testjs/units/album/album-thumb-retry.test.js) | 缩略图 404 **不等于**没图：前端按 `THUMB_RETRY_MAX` 退避重试并在 URL 上带 `&r=N`，否则 Vapor 下不碰 DOM，空白永不恢复；失败立刻盖占位层但**不用 `v-if` 移除** `img` | 纯函数 + 前端源码判据 |
| [`album-virtual-all.test.js`](../../../testjs/units/album/album-virtual-all.test.js) | 虚拟相册「整册全选」：前端只交 `all_from` + 排除集，由后端展开；锁排除生效、源相册不存在 404、虚拟相册取索引而不重复行、只从虚拟源移除索引 | 内存库 + 真 router |
| [`deferred-ipc-startup.test.js`](../../../testjs/units/desktop/deferred-ipc-startup.test.js) | 延迟 IPC 注册全局化，以及「低配模式」已删除的回归：真机 2 核 4GB 的 21 段 startup.log 证明按核数错峰无可测收益（开/关中位差 11ms，落在噪声内），模式连同开关与通道一起删掉，不许长回来 | 源码判据 + 启动时间线解析 |
| [`disk-usage.test.js`](../../../testjs/units/storage/disk-usage.test.js) | 性能面板「空间管理」的磁盘归账：A `classifyEntry` 纯函数（库 / 缩略图 / 上传 / 日志 / 其他）；B `scanDiskUsage` 真扫临时目录，七类字节数与合计；缩略图与日志目录在数据目录之外时补扫且不重复计 | 纯函数 + 临时目录 |
| [`fast-startup.test.js`](../../../testjs/units/runtime/fast-startup.test.js) | 「性能 → 快速启动」开关：`main.js` 必须在启动关键路径上**同步**读 localStorage（走接口会变成「先等一个接口才知道要不要等接口」），设置页负责写，默认开启；两处共用 `utils/fastStartup.js` 的 key | 源码判据 + 桩 localStorage |
| [`group-manage.test.js`](../../../testjs/units/student/group-manage.test.js) | 分组管理读写路径（档 C · M12-B1）：默认维度自动建且不重复、组数增减连带成员、**宿舍改组保留组 id 与成员**（全删重建会清空全班分配）、维度排序边界、成员增删改移与满员拒绝、智能分组写回、导入合并追加/跳过重名；末尾一条 SQL 出口判据 | 内存库 + 真 router |
| [`group-rename-batch.test.js`](../../../testjs/units/student/group-rename-batch.test.js) | 组名批量改名端点（P3-12）：一次请求改完全部、重复 id 去重、任一 id 不存在整批回滚、非法/空/超量 400、路由不被 `/groups/:id` 抢走；前端接线只发 1 个请求 | 内存库 + 真 router |
| [`leaves-paging.test.js`](../../../testjs/units/backend/leaves-paging.test.js) | 请假列表分页与「今日到班」范围：全量语义保留（挂件、导出、AI 工具依赖）；`hasMore` 用「多取一条」不跑 COUNT；`scope=today` 单独取「请假中 + 今天已返校」两类；末尾一条 SQL 出口判据锁 `leaveStore` | 内存库 + 真 router |
| [`leave-return-batch.test.js`](../../../testjs/units/duty/leave-return-batch.test.js) | 批量销假端点（P3-11）：一次请求写完全部 id、重复去重、缺失 id 只进 `missingIds`、非法/空/超量 400 不写库、单条端点保留、前端「全部销假」只发 1 个请求 | 内存库 + 真 router |
| [`live-blocks.test.js`](../../../testjs/units/backend/live-blocks.test.js) | AI 流式渲染分块（v6 性能专题 · 2-4）：原实现每跨一行就重跑整段 `marked.parse` + `DOMPurify.sanitize`（O(n²)，500 行时单次 47.9ms）。按块缓存后每块只算一次，判据锁「切块不改变渲染结果」 | 前端 ESM |
| [`mcp-forwarder-discovery.test.js`](../../../testjs/units/ai/mcp-forwarder-discovery.test.js) | MCP 转发器在后端端口顺延后怎么找到后端：候选顺序 `env CLASSNEST_MCP_URL` → `runtime-port.json` → 默认端口、同一地址不重复试连、文件半写入/损坏/缺失一律当没有；另有接线判据（主进程写文件、设置页传 `CLASSNEST_RUNTIME_FILE`、转发器不再顶层解析一次地址） | 纯函数 + 接线判据 |
| [`packaged-csp.test.js`](../../../testjs/units/desktop/packaged-csp.test.js) | 打包版 CSP 与构建产物内联脚本的对账：入口 CSS 的 `onload`、启动页脚本、PDF 字体子集化的 `wasm-unsafe-eval` 三类 hash 必须同时留在 `script-src`，且 style 标签要的 `unsafe-hashes` 不能删；改 CSP 就要重算 hash | 真实构建产物 + 源码对账 |
| [`ports-config.test.js`](../../../testjs/units/desktop/ports-config.test.js) | 端口单一口径的变异反证：`config/ports.json` 改一处，主进程代理 / 后端 fork / Vite 代理 / CSP / 渲染层媒体地址同时跟着变；环境变量覆盖与 `BACKEND_PORT > PORT` 优先级在子进程里重读配置验证；另测运行期顺延后 getter 与代理目标同步变化、dev 就绪判据能命中真实 `index.html` | 子进程重载配置 + 源码接线判据 |
| [`score-paging.test.js`](../../../testjs/units/student/score-paging.test.js) | 成绩列表分页与首页聚合：列表按页取、统计页签仍走全量（它要汇总而不是逐条）；首页摘要与旧 `computed` 逐项一致；分页只对列表 opt-in | 内存库 + 真 router |
| [`student-list-paging.test.js`](../../../testjs/units/student/student-list-paging.test.js) | 学生名单首屏分页（V9 · 5-5）：首屏 `limit=50` 且保留 `formal=1`，滚到底 offset 递增；导出/定位的全量请求不带 limit、补过全量后刷新不缩回第一页；`hasMore` 边界与全量模式恒 false；三条变异反证真改源码执行 | 纯函数真执行 + 变异反证 |
| [`score-provisional.test.js`](../../../testjs/units/student/score-provisional.test.js) | 加分记录里的名册外姓名：允许直接写名字，由后端走与值日/座位/分组同一套 `provisionalStudents`（建 `is_provisional=1` 并回填 `student_id`）；转正只改状态位，引用不断 | 内存库 + 真 router |
| [`score-import-idempotency.test.js`](../../../testjs/units/student/score-import-idempotency.test.js) | 成绩导入幂等（F07-04）：同一份表重导 `alreadyImported` 不新建、回原结果供撤销；`force=true` 强制新建并更新批次；内容不同算另一份表；批次与写记录同事务（中途失败不留半条）；指纹稳定 hash（键序无关、内容变即变）；前端提示分支不登记撤销 + 「仍然新建」出口 | 内存库 + 真 router + 前端接线判据 |
| [`semester-crud.test.js`](../../../testjs/units/student/semester-crud.test.js) | 学期 CRUD 与「当前学期」镜像（档 C · M12-B4）：新增即当前且当前唯一、列表把空日期排最后、切换互斥、删当前自动补选、**只传 `semester_start` 不能清空 `end_date`**（结束日期是快照补存的上界）、老库无 `is_current` 时回退最新；另含两条 SQL 出口判据 | 内存库 + 真 router |
| [`settings-view-ctx-binding.test.js`](../../../testjs/units/ui/settings-view-ctx-binding.test.js) | 设置页「模板绑定必须真的可见」：`SettingsView.vue` 把状态与方法拆在三个逻辑模块里经 `ctx` 袋互调，模板只认 `<script setup>` 的顶层绑定 —— **漏解构在 Vapor 下静默无反应**，判据逐个比对模板用到的名字与解构清单 | 源码判据 |
| [`text-head.test.js`](../../../testjs/units/storage/text-head.test.js) | AI 附件只读头部（v6 性能专题 · 2-12）：大文件只读 `maxChars*4` 字节（`bytesRead` 可证）、末尾不完整多字节序列被裁掉不产生 U+FFFD、空文件与纯 ASCII 边界、接线锁上传解析走 `readTextHead` | 临时文件 |
| [`thumb-purge.test.js`](../../../testjs/units/album/thumb-purge.test.js) | 「清理图片微缩图」：只删缩略图文件，索引（`album_photos` 行、`thumb_path`、`thumb_v`）一概不动；按库目录与旧扁平结构都要清；不存在的文件跳过不报错 | 临时目录 |
| [`thumb-sweep.test.js`](../../../testjs/units/album/thumb-sweep.test.js) | 「回收孤儿微缩图」：默认只读（只报数一个不删），`apply=true` 只删「确定没人引用」的 jpg —— 库能打开时按 `album_photos.id` 集合比对，无主账号目录与旧扁平残留单独判定，库打不开的 slug 整目录跳过 | 临时目录 |
| [`retention.test.js`](../../../testjs/units/backend/retention.test.js) | 账号数据管理保留策略：默认五类全永久、坏配置不意外开删、写策略只记偏好不删数据；回收站两类走目录 `mtime`（夹具临时 `DATA_DIR`）：预览只读、确定只清超期、不碰另一类、清空保留目录且符号链接不跟随不删除 | 内存库 + 临时目录；10 条用例 |
| [`conversation-shell-retention.test.js`](../../../testjs/units/backend/conversation-shell-retention.test.js) | AI 会话空壳纳入保留期（V9 · 5-6）：默认 forever 且写入路径 `autoClean` 不删；占用统计/明细只数无消息空壳；`deleteAll` 与 `applyNow` 都只清空壳，`ON DELETE CASCADE` 不会带走用户消息；变异反证真改源码抹掉 `SHELL_ONLY`，证明 4 个会话连 2 条消息一起被删正是所防的数据丢失 | 真库行为 + 真变异反证 |
| [`scan-worker-lock-ack.test.js`](../../../testjs/units/backend/scan-worker-lock-ack.test.js) | 锁库回执的真 IPC 往返（V9 · 2-3）：真 fork `worker.scan.js`，验 `lock → locked` 往返与非法 slug 拒绝；变异反证真改 worker 源码让它不发回执，等待方必须超时失败（防「消息发了但子进程没处理」） | 真子进程 IPC + 变异反证 |
| [`undo-retention.test.js`](../../../testjs/units/backend/undo-retention.test.js) | 撤销记录「每 key 50 条」上限：`pushRecord` 的 `MAX_PER_KEY` 一旦被改掉或加进动态 key，`undo_history` 就会无限增长，而「撤销不需要分页」的结论完全建立在这个上限上 | 内存库 |
| [`viewer-pan.test.js`](../../../testjs/units/ui/viewer-pan.test.js) | 查看器「放大之后能拖动平移」：`translate` 必须在 `rotate` / `scale` 之前（写在后面位移会被倍率再乘一遍）；平移量夹在可露出余量内，缩小/转正/改窗口都要重新夹；旋转 90/270 时宽高互换 | 纯函数 + 前端 ESM |
| [`vite-outdir-empty.test.js`](../../../testjs/units/desktop/vite-outdir-empty.test.js) | 构建输出目录的「小批量清空」：Vite 自带的 `emptyOutDir` 是一次递归删除，`dist/assets` 上百文件时会撞上宿主环境的删目录失败；改为分批删并保留非构建产物 | 临时目录 |
| [`a11y-contract.test.js`](../../../testjs/units/ui/a11y-contract.test.js) | 可访问性回归（档 C-3）：Tabs / MediaViewer / ClippedText / AppSelect / ContextMenu / DialogShell / NotificationToast 的角色与键盘操作、表单可访问名、`div` 做链接、页面 `lang` | 前端 ESM + 从 `.vue` 抽函数体执行 |
| [`about-deps-inventory.test.js`](../../../testjs/units/meta/about-deps-inventory.test.js) | 关于页「使用的开源项目」清单完整性：新增运行时依赖必须进 `libGroups`，否则随包分发却缺许可证展示 | 读三份 `package.json`；纯函数 |
| [`add-action-route-scope.test.js`](../../../testjs/units/ui/add-action-route-scope.test.js) | 首页 `?action=add` 只在本页命中：KeepAlive 缓存页 `deactivated` 后 watcher 仍在，裸判 `action` 会同时打开别页新增弹窗 | 纯函数 + 7 页接线判据 |
| [`ai-egress.test.js`](../../../testjs/units/ai/ai-egress.test.js) | AI 出站地址白名单（N3-08）：只放行 http/https、拒绝 `file:`/`ftp:`/云元数据，localhost / 局域网仍可用；四条出站路径共用同一入口 | 纯函数 + 接线判据 |
| [`atomic-write.test.js`](../../../testjs/units/backend/atomic-write.test.js) | 主进程配置/状态文件原子写（E01-05 / E02-01 / N3-15）：正常写入不残留临时文件、中途失败保留旧内容、异步版语义一致 | 临时目录 |
| [`cache-guards.test.js`](../../../testjs/units/runtime/cache-guards.test.js) | 缓存 / 代次 / 变更判据（B-7）：删当前会话作废在途、`useAccessLog`/`usePrivacyConfig`/`useSeatGrid` 代次、限流桶回收、列名缓存硬顶、ffmpeg 旧版本清理 | 源码结构 + 纯函数 |
| [`cadre-tab-no-flicker.test.js`](../../../testjs/units/student/cadre-tab-no-flicker.test.js) | 班干部 tab 来回切不闪空态：改用 `v-show` 保活（Vapor 下 KeepAlive 包 `v-if` 异步组件会崩），选中/折叠/滚动不丢、不重复拉取 | 源码文本判据 |
| [`ctx-shape.test.js`](../../../testjs/units/ui/ctx-shape.test.js) | `ctx` 共享上下文形状判据：全仓不得 `delete ctx.xxx` 或 `ctx[...]`（否则对象永久进入字典模式）；表格组件的 `ctx._` 运行时字段必须先在字面量 / 模块返回对象里声明，交互期不再新增键；附「扫到 0 个赋值即判据失效」自检 | 源码文本审计；3 条用例 |
| [`e2e-seat-score-undo.test.js`](../../../testjs/units/student/e2e-seat-score-undo.test.js) | 端到端流水线（真 HTTP）：排座 → 加分 → 改座位格 → 撤销 → 重做；守跨模块边界——撤销一格不误伤成绩/学生/其它格。两种变异反证通过 | 真内存库 + 3 路由 + fetch；1 条用例 |
| [`error-leak.test.js`](../../../testjs/units/backend/error-leak.test.js) | 5xx 不回传内部细节（N3-09）：4xx 保留业务文案，5xx 只回通用文案，原始 message 只进日志，例外需 `err.expose` | 纯函数 + 中间件 |
| [`history-load-guard.test.js`](../../../testjs/units/backend/history-load-guard.test.js) | 历史 tab「数据已在就不再重复拉」：周列表为空 / 选中周失效 / 值日维度变了才拉；SeatView、DutyView 必须经该判定 | 纯函数 + 接线判据 |
| [`interaction-safety.test.js`](../../../testjs/units/ui/interaction-safety.test.js) | 交互安全接线（A-4）：破坏性动作必须经确认层、提交按钮必须绑在途态（F02-01/03/07/08/11、F06-10） | 源码结构断言 |
| [`ipc-coverage.test.js`](../../../testjs/units/desktop/ipc-coverage.test.js) | IPC 包装层覆盖（档 C-5）：`ipcMain.once` 也过守卫、preload 预取主密钥走白名单、widget 两条通道有第二道 sender 闸 | 静态形态 + 假 `ipcMain` |
| [`ipc-handler-contract.test.js`](../../../testjs/units/desktop/ipc-handler-contract.test.js) | 主进程 `IPC.handle` 统一错误出口（档 B-3 E01-03/X1-04）：例外白名单逐条写理由且不得留过期项 | 源码扫描 + 白名单对账 |
| [`lifecycle-cleanup.test.js`](../../../testjs/units/runtime/lifecycle-cleanup.test.js) | 资源 / 会话 / 监听器生命周期（B-2）：连接硬顶摘除即关、撤销 TTL、信道会话硬顶、扫描计数 TTL、登出销毁会话、弹窗 Esc、轮询与拖拽回收等 | 源码 + 行为 |
| [`login-throttle.test.js`](../../../testjs/units/account/login-throttle.test.js) | 登录失败节流与 `/accounts` 频控（F06-01 / N3-02）：同账号 + IP 失败 5 次锁 30 秒、10 次锁 15 分钟，成功清零 | 纯函数，显式 `now` 推时间 |
| [`registry-parity.test.js`](../../../testjs/units/backend/registry-parity.test.js) | 注册表 / 名单对账（B-3）：凡是表名清单都必须落在 `tableRegistry` 的已知名字里；历史只读视图可查询 | 内存库 + 枚举 |
| [`front-back-constant-parity.test.js`](../../../testjs/units/ai/front-back-constant-parity.test.js) | 前后端 AI 常量一致性（v8 · 5-3 / Q4-01 缺口 ④⑥）的**行为测试**：把后端提案下发的每个可写表 / 设置项 key 喂给前端真实函数 `tableLabel` / `frontProposalHint`，断言显示的是后端给定中文名而非静默退回的英文 key。不比对清单键集——前端漏映射时行为失败，正是 Q3-01 的用户可见后果 | 前端 ESM 动态 `import()` 真跑函数 + 后端 `require` 取下发值；4 条用例 |
| [`subagent-tool-dispatch.test.js`](../../../testjs/units/ai/subagent-tool-dispatch.test.js) | 子助手工具白名单无幽灵工具（v8 · 5-4 / G9）的**行为测试**：真跑 `getSubagentTools()` 拿实际下发清单，断言白名单每个工具都被真的下发、且下发工具都过执行侧校验 | 真跑后端函数（fixture 注入主密钥）；2 条用例 |
| [`resource-bounds.test.js`](../../../testjs/units/backend/resource-bounds.test.js) | 资源上限 / 往返（B-4）：首屏聚合下推、访问时间线下推、解压闸、AI 上下文裁剪、排座 id 索引、点名并行 | 源码 + 行为 |
| [`score-full-inflight.test.js`](../../../testjs/units/student/score-full-inflight.test.js) | 加分统计整表拉取的在途单飞：同一 mode 并发只发一次，`finally` 清槽可重试，`resetPaging` 不复用旧 Promise | 源码判据 |
| [`search-shortcut.test.js`](../../../testjs/units/backend/search-shortcut.test.js) | 全局搜索快捷键 Ctrl/Cmd+K 的纯判定与 `App.vue` 接线（不抢 Shift/Alt） | 纯函数 + 接线 |
| [`secure-no-token-plaintext.test.js`](../../../testjs/units/security/secure-no-token-plaintext.test.js) | 无登录态请求必须走明文：加密拦截器不得把无 token 的公开写请求封包，否则登录/注册/恢复等接口全部 401 | 纯函数 + 接线 |
| [`shape-errors.test.js`](../../../testjs/units/backend/shape-errors.test.js) | 响应形状 / 失败与空结果区分（B-5）：关联预览失败不当无关联、`DB_LOCKED`→401、不存在 id→404、座位快照带 `types` | 内存库 |
| [`silent-failure.test.js`](../../../testjs/units/backend/silent-failure.test.js) | 静默失败 / 假成功（A-5）：失败必须可见反馈、不关闭弹窗、回传真实条数（E02-07 / F02-02/06/10 / K03-14） | 源码判据 |
| [`state-lifecycle.test.js`](../../../testjs/units/runtime/state-lifecycle.test.js) | 模块状态 / 用户级重置（B-6）：撤销状态换号复位、退出先收子进程、取消保留续扫断点、探活结果必判、活动加载只认最后一次等 | 源码 + 行为 |
| [`sweep-fixes-c2.test.js`](../../../testjs/units/runtime/sweep-fixes-c2.test.js) | 档 C-2 业务规则与算法单点：满组跨组交换兜底、空命题不误报、装饰字段保留、分组快照回填 `student_id`、课表几何越界、`restartWindow` 顺序、`ai.config` 双挂载 | 算法真跑 + 真内存库 |
| [`tab-chunk-split.test.js`](../../../testjs/units/ui/tab-chunk-split.test.js) | tab 内容分块（异步组件 + hover 预取）接线：两个分支都换子组件、`defineAsyncComponent` 包命名 loader、`tabCtx` 透传 | 源码文本判据 |
| [`tmp-sweep.test.js`](../../../testjs/units/storage/tmp-sweep.test.js) | 启动期回收崩溃遗留临时文件（P2-08）：四类位置（AI 附件 / 还原上传 / OCR 中转 / 解包目录），只删超龄孤儿 | 临时目录 |
| [`tx-boundaries.test.js`](../../../testjs/units/backend/tx-boundaries.test.js) | 事务边界（B-9）：活动导入同事务、模型插入后收敛 active、会话名单 tmp+rename、批量写逐项绑 `undoId` | 源码结构 + 行为 |
| [`write-with-undo.test.js`](../../../testjs/units/backend/write-with-undo.test.js) | 写与撤销登记同事务（V9-I-13）：`writeWithUndo` 写+登记回 `undoId`、失败整笔回滚、`_undoSpec` 保留字段不落库；真跑 EXPRESS 路由 + 无事务变异反证 | 真内存库 + 真 router + 真 HTTP |
| [`write-undo-second-post-fail.test.js`](../../../testjs/units/backend/write-undo-second-post-fail.test.js) | 验收①（V9 2-5）：真库注入「写入成功、第二次登记 POST 失败」，带 spec 的新模式撤销栈仍在、老两写模式则空 —— 证明记录来自同事务 | 真库 + 真 HTTP + 注入失败 |
| [`ai-batch-undo-same-tx.test.js`](../../../testjs/units/ai/ai-batch-undo-same-tx.test.js) | AI 写（`apply-batch` / `doc`）的撤销同事务：带 `_undoSpec` 时后端用写结果生成 payload 并登记、响应回 `undoId(s)`；单一 fixture 实例 | 真内存库 + 真 router |
| [`group-snapshot-same-tx.test.js`](../../../testjs/units/backend/group-snapshot-same-tx.test.js) | `group_snapshot` 写后补登记收口：`apply-grouping` 带 before spec，后端同事务用写后结构生成 after 并登记，撤销 payload 前后态正确 | 真内存库 + 真 router |
| [`group-structure-snapshot.test.js`](../../../testjs/units/backend/group-structure-snapshot.test.js) | `structureSnapshot` 与前端 `buildGroupSnapshot` 同构：字段一致、成员 id 保留、`sort_order` 按组内序号，才能被执行器按 id 回插 | 真内存库 |
| [`activity-countdown-undo-same-tx.test.js`](../../../testjs/units/backend/activity-countdown-undo-same-tx.test.js) | 活动/倒计时 PUT/DELETE 同事务（保留 404 语义）：带 spec 回 `undoId`、`changes===0` 不登记、无 spec 变异反证；守卫钉的 `changes===0→404` 复核 | 真内存库 + 真 router + 真 HTTP；6 条 |
| [`score-leave-undo-same-tx.test.js`](../../../testjs/units/backend/score-leave-undo-same-tx.test.js) | 成绩/请假 PUT/DELETE 同事务：`cell_update` 逐字段与 `row_delete` 整行 payload 按前端 spec 原样登记、404 不登记、无 spec 变异反证 | 真内存库 + 真 router + 真 HTTP；5 条 |
| [`seat-cell-undo-same-tx.test.js`](../../../testjs/units/seat/seat-cell-undo-same-tx.test.js) | 座位单格 PATCH 同事务：带 spec 回 `undoId`、`grid_cell` payload 原样保留、洞里塞人被拒不登记、几何（types/rows/cols）不动、无 spec 变异反证 | 真内存库 + 真 router + 真 HTTP；4 条 |
| [`group-dimension-settings-same-tx.test.js`](../../../testjs/units/student/group-dimension-settings-same-tx.test.js) | 899 维度设置：组名批量改 + 结构快照同事务 —— `groupRenames` 合进 dimensions PUT，撤销 `newValue` 是改名后组名；去掉改名则保留旧名（变异反证） | 真内存库 + 真 router + 真 HTTP；2 条 |

新增：在 `units/` 建 `*.test.js`，用 `node:test` 的 `test()` 编写，无需改配置。

---

## 注意事项

- **分层不要混写**：纯算法留在本层；组件行为语义放 [behavior.md](./behavior.md)，HTTP ↔ 前后端链路放 [smoke.md](./smoke.md)。
- **不碰真实数据**：本层只用内存库、连接桩与纯函数；需要启动真实后端或真实 `DATA_DIR`（数据目录）的用例不属于这一层。
- **`_vue-loader.cjs` 不是用例**：它是加载 `.vue` 单文件组件的辅助（编译模板后交给 ESM 动态 `import()`），供需要真跑组件脚本的用例复用；新增这类辅助仍沿用 `_` 前缀。

---
| [`mcp-error-redaction.test.js`](../../../testjs/units/ai/mcp-error-redaction.test.js) | MCP 外部错误文案统一脱敏（V9-K02-01）：server 与 stdio 转发器共用 `publicToolError`，SQL / 路径不进响应 | 真跑共享函数 + 接线判据 |
| [`mcp-pending-guard.test.js`](../../../testjs/units/ai/mcp-pending-guard.test.js) | MCP 提案积压原子守卫（V9-I-05/06）：create 内同步计数，并发都过闸门时仍能拦住第 31 条 | 真库 + 行为 |
| [`student-candidate-filter.test.js`](../../../testjs/units/ui/student-candidate-filter.test.js) | 学生候选下拉统一口径（V9-I-11/12）：归一化 + 拼音，四处下拉共用 `studentCandidateHit` | 真跑共享函数 + 接线判据 |

---
