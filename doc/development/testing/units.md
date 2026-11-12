# 单元测试（`testjs/units/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── units/
        ├── ai-doc-transaction.test.js  # AI 单块写入（POST /api/ai/doc）的「校验 + 快照 + 写入」同事务：校验…
        ├── ai-limits.test.js  # AI 链路的边界校验与预算闸门：①上游 tool_call 的空 id / 空 name /…
        ├── api-proxy.test.js  # B1 的 /api 同源代理（v6 · 2-15）：只代 /api 与 /api/*、目标 URL 保留 query、方法/请求体/响应流透传、Host/Content-Length 被清理、后端不可达回 503
        ├── backend-origin.test.js  # B1 地址口径（v6 · 2-15）：apiBaseUrl 永远相对、mediaBaseUrl 打包补后端、三处调用方共用；app:// 协议代理 /api，主窗口/引导/挂件不再换源
        ├── album-merge-undo.test.js  # 合并相册的撤销（Q2-09）：建新虚拟相册 + 复制照片索引 + 删掉全部源相册作为一条撤销…
        ├── albumScan.test.js  # 相册扫描的「索引被误删/清空」防护
        ├── api-paths.test.js  # 认证端点路径单一来源：前端 apiPaths.js 的每个常量都在后端真实路由里存在（防止又…
        ├── app-select-esc.test.js  # Esc 让位协议（A5-05）：弹层在下拉展开时消费 Esc（defaultPrevente…
        ├── architecture-guard.test.js  # 架构守卫（v6 · 6-2 / 6-3）：①schema/*.js 的 CREATE TAB…
        ├── arrange-datasource.test.js  # 智能排表「选择数据源」：只排当前表已有的人 / 从名册取人两种语义，切换数据源时清掉上一次的…
        ├── arrange-desk-mixed.test.js  # 智能排表按「桌号表」工作：混合桌（两列之间是走廊）下同桌判定不能再用列号奇偶，判据换成按桌号…
        ├── arrange-grid-boundary.test.js  # 智能排表弹窗的「网格 ↔ dense」边界：库里 seats 是网格（走廊是真实列），算法按…
        ├── auth-sync.test.js  # 跨窗口登录态同步（v6 · 2-3b）：滑动续期只换 token 不算换人；换号/登出先清用户级缓存再广播 AUTH_CHANGED_EVENT，三个窗口入口共用一份判定
        ├── backend-boundary.test.js  # 写入边界与实际结构脱节：①PATCH /cell 是唯一不经过 normalizeSeats…
        ├── backend-consistency.test.js  # 跨库写补偿与信号透传：①PUT /username 的用户名存在两处（index.db 的 …
        ├── backend-date.test.js  # 后端日期工具（student-backend/utils/date.js）的回归。这些函数此…
        ├── backend-limits.test.js  # 无界资源与入口收敛：①ffmpeg 下载递归跟随重定向无次数上限 → 重定向环会无限递归爆栈…
        ├── backend-multiwrite.test.js  # 多步写的一致性保障：逐日/逐条的批量写若没有事务，中途失败会留下半截状态（补存留下部分快照、…
        ├── backend-sideeffect.test.js  # 校验阶段的副作用与文件+索引非原子：①assertDutyRefs 在校验阶段就写库（建临时…
        ├── backend.test.js  # 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、domai…
        ├── batch-delete.test.js  # 批量删除端点（v6 · 1-8）：一次 POST 删 N 条、position 重排、脏 id 整批回滚、minCount 不绕过、单条 DELETE 保留
        ├── backup-archive.test.js  # 备份包 v3「带全了哪些东西」（N2-02）：库三件套（含 -wal / -shm）+ 长期…
        ├── backup-restore.test.js  # 还原侧的「允许动现有文件的时机」：解包与逐项校验先做完（缺项 / 内容被改 / 名字不安全都…
        ├── blob-error.test.js  # 二进制下载失败体归一（A4-01）：responseType:'blob' 时 4xx 的 …
        ├── bundle-restore.test.js  # v3 包落盘的四种坏情况：包里缺某目录 / 坏包 / 缺库文件时都不许把本机目录清空；替换与…
        ├── changelog.test.js  # 更新历史解析：版本标题写法（v 前缀 / · 分隔 / 括号日期）、条目清理、HTML 注释…
        ├── client-cache.test.js  # 用户作用域缓存：旧令牌必须失效、某个清理函数抛错不能拖垮登出、两个缓存模块确实登记了清理函数
        ├── context-menu-exclusive.test.js  # 右键菜单互斥：座位页行标签与列头是两个组件实例，只能靠模块级登记表让新菜单把旧菜单关掉
        ├── context-menu-transition.test.js  # 右键菜单过渡：先用 visibility: hidden 量尺寸再显示（避免贴边溢出），过渡…
        ├── data-export-zip.test.js  # 数据导出 /api/data/zip 的流式打包（v6 · P2-01）：①收据按磁盘路径流…
        ├── db-size-probe.test.js  # 库体积探针（v6 · 0-4）：明文库读出 page_count/freelist、非法库标 encrypted、目录只认 .db、自证脚本能跑通
        ├── db-master-key.test.js  # 数据库主密钥 safeStorage 异步化（Electron 46 适配）的行为回归：①只…
        ├── dbConnCache.test.js  # 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶
        ├── dialog-stack.test.js  # 弹窗层级栈（V5-003）：openStack 原先写在 里、每个实例一份，抽成模块级后一次…
        ├── disposables.test.js  # 「资源随作用域释放」底座语义：登记的定时器/周期器在 dispose() 后不再触发、lis…
        ├── docs-counts.test.js  # 文档计数唯一来源（v6 · 5-3）：①9 项计数都能从源码现算，且每份文档里确实存在可替换…
        ├── data-export-tables.test.js  # /api/data/tables 只计数不物化（v6 · 1-3）：计数正确、GET 期间无 SELECT * FROM students、派生表走 build 兜底
        ├── dashboard-summary.test.js  # 首屏 dashboard 摘要化（v6 · 2-1）：不再下发全量 scores/fees、students 只剩 id+姓名、summary 四个口径与旧 computed 逐项一致、1000 条加分下整包 <30KB
        ├── duty-config.test.js  # 值日列名按模式分键（daily 星期 / big 分组名 + 全部）后的读写对称：读走 re…
        ├── duty-dedupe-whole-table.test.js  # 「整表去重」开关必须真的生效（A3-01）：ctx 里状态都是 ref/computed，r…
        ├── duty-index.test.js  # 值日指数累加单源化：展示值与排表账本共用 accumulateDutyIndex，只有结算区…
        ├── duty-ordered-arrange.test.js  # 独立条件「顺序选项」：行优先 / 列优先与反向只作用于行内、列内，不改变跨行列的填充顺序
        ├── duty-packed-arrange.test.js  # 「随机分组」接入流水线：与 duty-packing 分工不同，这里锁「整条 pipelin…
        ├── duty-packing.test.js  # 分组装箱 + 整天随机映射内核：intactGroups 必须能从 buckets 反推（不…
        ├── duty-save-transaction.test.js  # 建档副作用与写入同事务（N2-06）：PUT /api/duty/save 的 valida…
        ├── duty-settings-hydrate.test.js  # 值日设置弹窗「首次打开即初始化」：父组件按 mounted 标记懒挂载，首次挂载时…
        ├── duty-slot-warning.test.js  # 「值日位置不足，有 X 人排不进」确认框：X 必须来自 shortageCount 单源；「…
        ├── duty-weight-linkage.test.js  # 权重表多子行联动：底层一个项目只有一个权重值，编辑任一子行必须同步到该项目所有天，一维表按均…
        ├── event-loop-stats.test.js  # 主进程事件循环延迟（v6 · 0-7）：ns→ms 口径、空 histogram 返回 null、start 幂等、stop 后不读数；perf-snapshot 带 eventLoop、启动后 3s 观测窗口
        ├── frontend.test.js  # 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼…
        ├── get-share.test.js  # 通用 GET 在途共享（v6 · 1-7）：同 key 并发只发一次、TTL 复用/过期重发、换号旧响应作废、写操作只清缓存不取消在途、key 判定与上限淘汰
        ├── group-dimension-delete.test.js  # 分组维度删除的撤销（Q2-08）：维度 + 该维度全部小组 + 全部成员 + 剩余维度重排合…
        ├── inp-longtask.test.js  # 主线程长任务观察（v6 · 0-2）：16ms 起记录、不支持时不装配、observe/单条 onRecord 抛错不影响后续；longTasks 必须随 INP_REPORT 落盘且 reset 清空
        ├── keep-alive.test.js  # 后端 keep-alive 显式配置（v6 · 1-6）：listen 后设 keepAliveTimeout/headersTimeout，且前者必须大于后者
        ├── kill-tree.test.js  # 「杀进程树」端到端（V5-010/011/013）：真实三层进程树（父 → 子 → 孙），W…
        ├── leave-state.test.js  # 「今天在不在校」的唯一口径（utils/leaveState.js）。回归首页右上角「请假 …
        ├── leave-undo-wiring.test.js  # 请假记录全链路撤销（Q2-05）：新增（弹窗 / 行内）、编辑、删除、销假、撤销销假都要登记…
        ├── lifecycle-resources.test.js  # 定时器/监听器配对守卫（v6 · 1-11 + 1-13）：setInterval 必须有 clearInterval 或 d.interval；window/document 级 addEventListener 必须被移除/登记/once/signal 覆盖；豁免表不得过期
        ├── log-rotator.test.js  # 日志体积收口（v6 · 1-1）：超限只留尾部、串行追加不乱序、四个出口共用轮转器；接线判据锁 backend.log 全程异步
        ├── login-contrast.test.js  # 登录页文字对比度按 WCAG 现算：登录页直接压在背景图上、卡片是半透明玻璃，换背景图就可能…
        ├── login-file-picker.test.js  # 「从数据库登录」是唯一的文件入口：渲染层一个 按扩展名分派，不再有第二个「从备份包恢复」按钮
        ├── main-ipc-contract.test.js  # 主进程 IPC 契约的行为断言：① ok/fail/canceled 三态互斥且带可读 me…
        ├── media-credential.test.js  # 静态资源凭据（V5-005）：打包版页面是 file://，取图属跨站，SameSite=L…
        ├── main-env.test.js  # 开发/打包判定（v6 · 2-20）：打包 / Electron45 源码 / 常规源码三种组合；main.env 之外不得再出现 app.isPackaged；关键模块接线
        ├── note-curve.test.js  # 荧光笔笔锋：按点分组描边后线宽确有变化（旧实现整条路径只描一次，宽度被末端值压平 → 此断言…
        ├── orphan-check.test.js  # 只读孤儿检查器的可信度（v6 §0-4）：一个「永远返回 0」的检查器最容易是假的，所以把 …
        ├── pathGuard.test.js  # 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建…
        ├── perf-mem.test.js  # 导出内存探针（v6 · 0-5）：默认关闭时 snapshot 为 null 且不打日志；PERF_EXPORT=1 时打 rss/heap/external 差值；导出路由 finally 成功/失败都留痕
        ├── perf-mark.test.js  # 首屏分段打点（v6 · P1-01）：①perfNow 是 epoch 毫秒、能与后端/主进…
        ├── photo-info-cache.test.js  # 相册信息缓存（v6 · 1-4）：200 条上限 LRU、命中刷新顺序、换号清空；AlbumView 不再自带无上限 Map
        ├── pkg-size-probe.test.js  # 打包体积探针（v6 · 1-12）：字节格式化边界、分桶（asar/根依赖/后端依赖/locales/根二进制）、汇总降序累加、生产依赖全部可解析
        ├── receipt-kind.test.js  # 收据 Office 文件打不开（4-1）：校验层按魔数分出 ooxml / ole，落库前必…
        ├── refresh-virtual.test.js  # 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项）
        ├── restore-bundle.test.js  # v2 恢复的完整性预检（V4-B05-13）：先写临时文件 → integrity_chec…
        ├── save-outcome.test.js  # save-file 三态判定（V5-002）：ok / fail / canceled 互斥…
        ├── schema-foreign-keys.test.js  # 外键声明（N2-03 第一步）：9 处 ON DELETE CASCADE 齐全、3 处（c…
        ├── search-limits.test.js  # 全局搜索分页（P3-08）：根因是没有分页而非上限太小 —— LIMIT ? OFFSET …
        ├── seat-ai-align.test.js  # 座位网格与「对外文案 / 快照 / AI 输出」对齐：走廊是 seats 里的真实列，一张 …
        ├── seat-aisle-col.test.js  # 整列走廊（列头右键「左/右插入」「删除这条走廊」）：插入不动左右两列、删除逐格还原、cols…
        ├── seat-aisle-row.test.js  # 整行走廊（行标签右键「上方/下方插入」「删除这条走廊」）的几何语义：插入 / 删除后行数、t…
        ├── seat-cell-write.test.js  # 座位单格写入（PATCH /cell、PATCH /master/cell）：收敛到 ser…
        ├── seat-daily-aggregate.test.js  # 座位账本/指数单遍结算（v6 · 1-9）：与改造前两份遍历逐学生等价、两个 to 上限互不串口径、SeatView 只剩一处 /seats/daily
        ├── seat-desk-pattern.test.js  # 混合桌：不另存桌型序列，桌型从「走廊在哪」派生 —— 拆桌 = 两列之间插一条走廊，合并 =…
        ├── seat-draft-reset.test.js  # 排表草稿的模块级单例跟着账号走（X2-07）：换号既要清值又要作废在途响应，否则 B 打开智…
        ├── seat-fair-conservation.test.js  # 位置公平（applyFair）的人数守恒：按目标块位置数遍历落盘时不能多塞或漏人
        ├── seat-geometry.test.js  # 座位网格几何的回归锚点：把改造前的旧公式原样冻结在测试里当参考实现，而不是拿新实现跟自己对
        ├── seat-grid-migration.test.js  # 座位几何 dense → 网格的一次性迁移：这是唯一一处不可逆且静默的改动（迁错后界面看不出…
        ├── seat-hole-paint.test.js  # 「设置空位」画笔：纯函数规则（toggleHole / usableSeatCount / …
        ├── seat-types.test.js  # 格子类型矩阵（types）的存取契约：必须穿过 schema、slotStore 白名单、视…
        ├── seat-undo-geometry.test.js  # 撤销的几何契约（P0-3 / P0-2）：几何只从快照 types 形状推，前端四元组降级为…
        ├── seat-undo-rows.test.js  # 撤销「插入/删除行走廊」时行数必须与 types 一起回写：grid_snapshot 原先…
        ├── seat-weight-align.test.js  # 权重表跟随座位表几何：权重矩阵独立存储，划成走廊或挖洞后旧数字仍在，取消走廊时必须重新对齐
        ├── secure-bridge.test.js  # 安全通道握手报文桥（v6 · 2-19）：只转发公钥、非法公钥不发请求、后端非 2xx/缺字段必须报错；授权与 get-master-key 一致
        ├── secure-channel-idle-sweep.test.js  # 安全通道空闲清扫（v6 · 1-5）：过期会话清掉、未过期不动；定时器幂等/unref/可停；只有 initMaster 成功才启动
        ├── secure-response-serialize.test.js  # 响应只序列化一次（v6 · 1-2）：信封与 JSON.stringify({ d }) 逐字节一致、不再过 res.json；密文可被同一会话密钥解回原对象
        ├── secure-retry.test.js  # 安全信道 401 重试的分支判定（N1-02）：凭据降级 / auth-required /…
        ├── sequenced-cache.test.js  # 带账号代次的进程内缓存（P0-6）：TTL 复用 + 写入前核对代次 + 失败不缓存；inv…
        ├── session-revocation.test.js  # 凭证变更 → 全账号会话失效（A1-16）：账号维度必须是 (userId, dbSlug)…
        ├── sessions-ttl.test.js  # 会话名单的活动时间与清理（V5-009）：at 改为最后一次活动时间（1 小时节流落盘），否…
        ├── single-flight.test.js  # 启动单飞守卫（P0-5）：并发调用只跑一次且拿到同一 Promise，同步副作用不延后微任务…
        ├── slug-scopes.test.js  # 按库隔离状态底座行为契约：两库同号 id 互不覆盖、totalSize() 为各桶之和、pe…
        ├── smart-group.test.js  # 智能分组算法（SmartGroupDialog.pipeline.js）的回归：这套算法此前…
        ├── startup-io.test.js  # 启动期同步 IO 打点（v6 · 1-10）：开关未开不安装、计时不改语义（返回值/异常透传）、重复安装不叠加、summarize 落启动时间线
        ├── storage-size-probe.test.js  # 目录 / 日志体积探针（v6 · 0-5）：嵌套目录按文件累加、缺失目录标 missing、data/userData 两处日志分别统计、自证脚本能跑通
        ├── student-cascade-delete.test.js  # 删除学生的级联撤销（Q2-03）：七处（学生 / 请假 / 加减分 / 小组 / 班干部 /…
        ├── student-delete-guard.test.js  # 删学生不许留孤儿（N2-05）：通用删除入口先算关联，有就拒并列出明细，让调用方走「一并删除…
        ├── sweep-fixes-b19.test.js  # 批 19 基础组件与前端工具的回归（表驱动 + 真跑源码）：①写请求重发守卫的默认值必须只放…
        ├── sweep-fixes.test.js  # 模式扫描批的行为回归（表驱动，一个文件覆盖一批同款修法）：①日期拼接收口 —— 后端 4 处…
        ├── test-assets.test.js  # 测试资产自身的回归（批 19 B13 5 条 + B14 8 条）：这些修的是测试与工具自己…
        ├── thumb-batch.test.js  # 缩略图批量：失败与「服务端确实没这张」语义分离（失败不写状态）、网络恢复后自动拿到 blob
        ├── token-renewal.test.js  # 滑动续期「换代即作废」（X2-08）：响应合法，唯一线索是「发请求时是哪一代」；代次不符一律…
        ├── undo-batch-coverage.test.js  # 一次动作改多行必须整批可撤（Q2-04 / Q2-05 / Q2-06）：row_reord…
        ├── undo-recorder.test.js  # 撤销登记只能有一个入口（Q2-10）：失败必须弱提示、不许 .catch(() => {})…
        ├── updateIntegrity.test.js  # 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小
        ├── user-scoped-race.test.js  # 换号后在途请求不得写回（V5-004）：请求发出时记登录代次，响应回来代次变了就丢弃并重拉
        ├── week-dates.test.js  # 「星期列 → 具体日期」换算：按星期名取而不按列下标取（表头可拖拽），月和日不补零，非法日期…
        ├── widget-capture.test.js  # 浮窗截屏必须「自己先藏好」。工具箱浮窗是 transparent: true，Windows…
        ├── widget-data-changed.test.js  # 挂件不再只靠 5 分钟轮询（A5-02）：写请求成功后按域广播，基础设施写（聊天/相册/账户…
        ├── zip-bundle.test.js  # 备份包两块地基（A1-03 / N3-03）：sanitizeEntryName 拦 Zip…
        └── zip-peek.test.js  # 「这个备份包要不要口令」的判断必须与真包一致：误判「不用口令」会让用户卡在解不出钥匙，误判「…
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：单元测试层（`testjs/units/`），121 个 `node:test`（Node 内置测试框架）文件，覆盖纯函数与内存库上的数据层逻辑。
- **公共逻辑**：零第三方依赖（`node:test`（Node 内置测试框架）+ `node:assert`（Node 内置校验库）），不启动后端与前端；失败退出码非 0，可直接接 CI。运行：`npm run test:units`（支持 `--only=`（只跑指定文件）/ `--skip=`（跳过指定文件）/ `--bail`（首个失败即停）/ `--list`（只列用例不执行））。
- **局限**：不覆盖 UI、进程间链路与真实数据目录；部分数据层用例会用「内存库 + 真 Express router」跑 HTTP（如座位单格写入、分组维度删除、相册合并）。分层说明见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 详细说明

| 文件 | 覆盖点 | 前置 / 写法 |
| --- | --- | --- |
| [`backend.test.js`](../../../testjs/units/backend.test.js) | 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、`domain_history` payload → 三域历史视图的 JSON 映射、二次 `initSchema` 幂等、`slotStore` 逻辑名/可写列映射、`sanitize` 系列、恢复密钥归一化/哈希/常数时间比较、请假时间窗与 SQL 时间戳、`dutyMode` 解包（items 空值必须回数组） | 需 `student-backend` 依赖，用 `createRequire(path.join(ROOT,'student-backend/package.json'))` 解析 |
| [`backend-multiwrite.test.js`](../../../testjs/units/backend-multiwrite.test.js) | **多步写的一致性保障**：逐日/逐条的批量写若没有事务，中途失败会留下半截状态（补存留下部分快照、排序只改了一半、「确保默认维度存在」这个隐藏写凭空留下一个维度）。手法：把 `student-backend/db.js` 的 `db` 导出换成「代理到真内存库 + 第 K 次写抛错」的代理，再在**同进程**起 Express 挂真实 router、用 `fetch` 打真实 HTTP —— 路由、slotStore、SQLite、事务全是真的，只有「写」这一下是注入的故障（隔离后端是独立子进程，注入不进，这层只能在同进程做） | 需 `student-backend` 依赖；`require.cache` 换掉 `db.js` 的 `db` 导出（**必须早于 require 路由/slotStore**，它们解构捕获 `db`）；4 条用例 |
| [`backend-boundary.test.js`](../../../testjs/units/backend-boundary.test.js) | **写入边界与实际结构脱节**：①`PATCH /cell` 是唯一不经过 `normalizeSeats` 的座位写入口 —— 只校全局上限 50×30 时，单格提交能把 seats 撑出当前布局之外的多余行（前端按 rows/cols 渲染，多出来的行永远看不见，下一次整块 PUT 又会被 `slice(0, rows)` 静默丢掉）；②改名级联的**六处联写匹配口径不一致**（值日/座位/四张 SQL 表有的 trim 比、有的严格比）→ 同一个带空格的旧名只在一部分表被改，同一学生在不同表里名字对不上。手法同 `backend-multiwrite`（`require.cache` 换 `db.js` 的 `db` + `getFields`，同进程真 HTTP）；删除学生路径（`studentRelations`）的口径一并覆盖 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` **与 `getFields`**（后者不走 `db` 导出、直接读 dbManager 的 ALS 上下文，不换会报「未绑定数据库连接」）；10 条用例 |
| [`backend-consistency.test.js`](../../../testjs/units/backend-consistency.test.js) | **跨库写补偿与信号透传**：①`PUT /username` 的用户名存在两处（`index.db` 的 registry + 业务库 `users`），两个 SQLite 文件事务无法跨库 → 业务库写失败时必须**补偿**（把 registry 改回旧名，且回滚前确认 registry 当前仍是本次写入的新名，否则会覆盖并发改名）；②`album` 的 `DELETE /:id` 两条 DELETE 各自提交 → 中途失败留下「照片索引已删、相册还在」的半截状态；③改名跳过级联时后端已回 `skipped='duplicate-name'`，前端必须消费并提示 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db`（第 K 次写抛错）+ `getFields`；11 条用例 |
| [`backend-limits.test.js`](../../../testjs/units/backend-limits.test.js) | **无界资源与入口收敛**：①`ffmpeg` 下载递归跟随重定向**无次数上限** → 重定向环会无限递归爆栈；②`sessions` 的 sid 名单**无 TTL / 无容量上限** → `.sessions.json` 单调增长，登出只删一个 sid；③恢复词哈希**没有版本标识** → 将来换算法时无法区分新旧哈希（台账说的「确认门熵不足」在代码里并不存在）；④`undo` 路由的 `:id` 未按项目既有口径收敛整数 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` 导出（**必须早于 require 路由/slotStore**，它们解构捕获 `db`） |
| [`backend-sideeffect.test.js`](../../../testjs/units/backend-sideeffect.test.js) | **校验阶段的副作用与文件+索引非原子**：①`assertDutyRefs` 在**校验阶段**就写库（建临时学生），而 `resolveNames` 自带事务 → 提前提交，后续 `setDoc` 失败救不回来 → 名册凭空多一个学生、值日表却没存（孤儿）；②`photo_trash` 的 undo 先搬文件再插索引，两步非原子 → 中间态「文件在、索引不在」，用户看不到照片但文件已归位 | 需 `student-backend` 依赖；`require.cache` 换 `db.js` 的 `db` 导出 + `getFields`，同进程起 Express 打真实 HTTP |
| [`ai-limits.test.js`](../../../testjs/units/ai-limits.test.js) | **AI 链路的边界校验与预算闸门**：①上游 tool_call 的空 id / 空 name / 重复 id 必须收口（空 `tool_call_id` 会让上游 400），且工具名分片下发与整名重复下发都要拼对；②快照标识必须唯一（同毫秒创建不互相覆盖）且列表按真实时间排序；③「会话不存在」与「没有会话」两种语义必须区分 —— 前者明确报错、前端自愈，不能静默回退；④`web_search` 要接客户端取消信号（用户中断后不必等满 30s）；⑤统一预算闸门：子助手的 `usage` 必须记进共享账本（原先被直接丢弃）、超限即拦 | 需 `student-backend` 依赖；桩掉 `fetch` 跑真实 `consumeStream`，桩掉 `fs.readdirSync` 跑真实 `snapshotFiles`，桩掉 `consumeStream` 跑真实 `runOneSubagent`；21 条用例 |
| [`api-proxy.test.js`](../../../testjs/units/api-proxy.test.js) | B1 的 `/api` 同源代理（v6 · 2-15）：只代 `/api` 与 `/api/*`，静态路径返回 null；目标 URL 保留 path/query；方法、请求体流、响应流原样透传；Host/Content-Length 等帧级头被清理；后端不可达回 503 | 纯逻辑 + 注入假 fetch；5 条用例 |
| [`backend-origin.test.js`](../../../testjs/units/backend-origin.test.js) | B1 地址口径（v6 · 2-15）：`apiBaseUrl()` 永远相对路径、`mediaBaseUrl()` 打包补后端绝对地址；httpClient/apiUrl/secureChannel 共用一份；`app://` 协议必须代理 `/api`，主窗口/引导/挂件保持 `app://local` 不换源 | 前端 ESM 动态 `import()` + 源码接线判据；4 条用例 |
| [`frontend.test.js`](../../../testjs/units/frontend.test.js) | 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼图 Top N + 其他）、热力配色、`collectPdfText` 边界（循环引用/超深递归/空输入）、表格关键字过滤与「无结果」判定 | 前端是 ESM，用 `pathToFileURL` + 动态 `import()` |
| [`sweep-fixes-b19.test.js`](../../../testjs/units/sweep-fixes-b19.test.js) | **批 19 基础组件与前端工具的回归**（表驱动 + 真跑源码）：①写请求重发守卫的默认值必须只放行 GET/HEAD（子窗口没传守卫时，写请求在后端重连期间不能重发，否则重复落库）；②字体必须走 `new URL(..., import.meta.url)`（`public/` 下的资源 Vite 不加 content hash → 换字体后仍命中旧缓存）；③明文模式不把登录 JWT 拼进图片 URL（改靠 httpOnly Cookie 同源带凭据）；④`serialSaver` 的静默期要合并连续输入，且 `dirty` 必须在等待**之后**清（反了会多存一轮）；⑤`tableSearch` 的小写缓存必须按原值失效（只看关键字命中会让改过的值搜不到）；⑥`IconGlyph` 的 84 项 `MAP` 不能在 `<script setup>` 里（每实例重建）；⑦`AppSelect` 键盘打开要先初始化 `hoverIdx`（否则二次 Enter 变成 `commit(-1)`）；⑧`rowHeights` 只删失效键、不清空（清空会让滚动位置跳变）；⑨请假编辑模式 `student_id` 为空时不发起保存；⑩`undo_history` 与 `album_photos` 的覆盖索引要真建出来 | 静态形态用 `STATIC_CASES` 表驱动（`forbid` 去注释后匹配、`mustHave` 看全文、`mustNotBeInSetup` 只切 `<script setup>` 块、`minCount` 防「只改一处」）；行为侧用 `new Function` 抽出 `defaultWriteRetryGuard` 的真实函数体、用 `import()` 真跑 `tableSearch` / `serialSaver`；18 条用例 |
| [`backend-date.test.js`](../../../testjs/units/backend-date.test.js) | **后端日期工具（`student-backend/utils/date.js`）的回归**。这些函数此前在 `routes/duty.js`、`routes/seats.js` 各有一份逐字重复的私有副本，`ai.dataRoutes.js` 还有第三份 `mondayOf`——三份拷贝、零测试。本文件锁三件事：①本地时区口径（`toISOString` 是 UTC，东八区 00:00–08:00 会得到「昨天」）；②`mondayOf` 的周一归属（周日归**上一周**），且传 `Date` 时**不得就地改写**调用方对象（`snapshotBeforeWrite` 后面还要用同一个 `Date` 取快照日期）；③静态守卫——路由层不许再复制一份日期函数，草稿 `savedAt` 不许退回 `toISOString` |
| [`leave-state.test.js`](../../../testjs/units/leave-state.test.js) | **「今天在不在校」的唯一口径**（`utils/leaveState.js`）。回归首页右上角「请假 N」和下面「今日请假」卡片对不上的问题：数字数的是「所有 状态=请假中」（不看日期），卡片筛的是「开始时间=今天」，跨天假只进数字不进卡片。归一后为「状态=请假中 且 开始时间 ≤ 今天 ≤ 结束时间（首尾都算）」，并覆盖提前登记（不算）、过期未销假（不算）、`Date`/带时间串入参、脏数据。末尾静态守卫：首页与桌面挂件都不许再自己写 `状态 === '请假中'` |
| [`widget-capture.test.js`](../../../testjs/units/widget-capture.test.js) | **浮窗截屏必须「自己先藏好」**。工具箱浮窗是 `transparent: true`，Windows 上 `setOpacity` 对透明窗口不生效——主进程 `hideWidget`（`setOpacity(0)` + 等 150ms）等于没做，便签窗口那张「加载中」卡片就这样被拍进了自己的注释背景。判据锁调用形态（画面没法在单测里验）：所有浮窗截屏调用方都必须 `from './captureHide.js'` 引入并用 `hideForCapture/restoreAfterCapture`，且传 `hideWidget:false`，不许自己再写一份 `documentElement.style.visibility` |
| [`smart-group.test.js`](../../../testjs/units/smart-group.test.js) | **智能分组算法（`SmartGroupDialog.pipeline.js`）的回归**：这套算法此前一条单测都没有，于是 `single` 模式在男女比例悬殊时会**静默丢学生**（4 男 4 女分 3 组少 1 人、10 男 1 女分 3 组少 2 人，界面上完全看不出来）。三条判据：①**守恒** —— 任意人数/组数组合下，分配后人数必须恰好等于名册人数；②**语义** —— `G ≥ 2` 时不能出现混性别组；③**均匀** —— 同一性别池内各组人数差 ≤ 1（跨池不能比：5 男 1 女分 3 组时男生组必然 5 人、女生组 1 人）。另含 `G = 1` 边界（男女混合物理上分不开 → 全部塞进唯一那组、满足率如实记 0 而不是谎报 100%）与 1~12 人 × 1~5 组笛卡尔积穷举 | 用 `{ value }` 形状模拟组件的 ref 上下文，经 `pathToFileURL + import()` 真跑源码；判据能区分「改了」与「没改」——把容量退回全局 `target`、把丢弃 `break` 加回去、删掉 `G < 2` 特判，三者都会让测试变红（见 `mutate-sweep-b19.cjs` 的同类做法）；13 条用例 |
| [`test-assets.test.js`](../../../testjs/units/test-assets.test.js) | **测试资产自身的回归**（批 19 B13 5 条 + B14 8 条）：这些修的是**测试与工具自己**的毛病 —— ①设置探针的用例必须三元组（缺 `expected` 时断言恒真 = 空串边界假覆盖）；②临时库目录要删（`dataDir` 在仓库里，不删会进 `git status`）；③页面探针要轮询而非死等 5 秒（写完了立刻走，超时才兜底）；④`pathGuard` 的临时目录统一登记、`after` 一次清（原来 6 个用例只有一个清了）；⑤错误边界扫描要认跨行空 `catch`、且 `.catch(` 不计入分母；⑥嵌入 Python 的路径用正斜杠（反斜杠翻倍会让 `r''` 里出现两个）；⑦关服务要 `await closeServer`；⑧结束 dev server 要杀进程树；⑨Electron 子进程要有超时上限；⑩撤销用例的断言标签要与逻辑一致；⑪未捕获异常要记日志后退出；⑫`run-smoke` 要有单脚本超时与统一临时根目录 | 静态：`CASES` 表驱动 `includes` 判据（`forbid` 精确到断言调用形式，**不用裸标签** —— 修复注释里写着旧标签，会命中自己）；行为：①从源码里抽出 `EMPTY_CATCH_BLOCK` / `CATCH_KEYWORD` 正则真跑（单行版正则同样含这两个词，只判词是假绿），②解析 7 个文件头部注释里的 `node testjs/...` 路径并逐个 `existsSync`；14 条用例 |
| [`sweep-fixes.test.js`](../../../testjs/units/sweep-fixes.test.js) | **模式扫描批的行为回归**（表驱动，一个文件覆盖一批同款修法）：①日期拼接收口 —— 后端 4 处 + 前端 4 处统一走 `localDateStr`，前后端同一 `Date` 必须得同一结果；②下载 Blob 后 `revokeObjectURL` 必须延迟（同步撤销 → 0 字节文件）；③附件/粘贴 `readFile` 必须包 try（两处都要有，只改一处 = 改坏）；④`normalizeExifDate` 必须往返校验月日（2/31 不再滚到 3/2）；⑤`IconGlyph` 旋转选择器必须写成 `.icon-loading:deep(svg)`；⑥`duration=0` 常驻通知不能被 `setTimeout(remove,0)` 误杀；⑦`VideoThumb` 的 `ok` 必须随 `src` 复位；⑧Setup 只能在「用户从未选过主题」时落默认；⑨倒计时时长为 0 必须给可见提示；⑩`executeProposal` 必须 `await` 完才把 `busy` 置 false（否则并发写同表）；⑪`albumScan` 的 ffmpeg 抓帧必须带超时（否则坏视频 → 槽位永不释放 → 扫描 worker 卡死）；⑫挂载链与补发凭据的 promise 必须接住失败 | 表驱动：`STATIC_CASES` 数组逐条断言（`forbid` 去注释后匹配、`mustHave` 看全文、`minCount` 防「只改一处」）；前端 ESM 用 `file:///` URL 动态 `import()`；22 条用例 |
| [`changelog.test.js`](../../../testjs/units/changelog.test.js) | 更新历史解析：版本标题写法（v 前缀 / `·` 分隔 / 括号日期）、条目清理、HTML 注释里的示例条目忽略、CRLF、日期倒序，并校验仓库真实 `CHANGELOG.md` | 前端是 ESM，用 `pathToFileURL` + 动态 `import()`；真实文件按相对路径读取 |
| [`albumScan.test.js`](../../../testjs/units/albumScan.test.js) | 相册扫描的「索引被误删/清空」防护 | 纯函数 + 内存库 |
| [`api-paths.test.js`](../../../testjs/units/api-paths.test.js) | 认证端点路径单一来源：前端 `apiPaths.js` 的每个常量都在后端真实路由里存在（防止又出现 `/api/auth/logout` 这类「以为路由多一层」的错串） | 纯函数 |
| [`client-cache.test.js`](../../../testjs/units/client-cache.test.js) | 用户作用域缓存：旧令牌必须失效、某个清理函数抛错不能拖垮登出、两个缓存模块确实登记了清理函数 | 纯函数 |
| [`note-curve.test.js`](../../../testjs/units/note-curve.test.js) | 荧光笔笔锋：按点分组描边后线宽确有变化（旧实现整条路径只描一次，宽度被末端值压平 → 此断言在旧实现上必挂） | 纯函数 |
| [`slug-scopes.test.js`](../../../testjs/units/slug-scopes.test.js) | 按库隔离状态底座行为契约：两库同号 id 互不覆盖、`totalSize()` 为各桶之和、`peek` 不建空桶、交错 `push` 后 `flush(A)` 只发 A 的条目（旧全局数组实现必挂）、达到 limit 自动发自己库、发送失败不残留、`clearAllForSlug` 只清该库 | 纯函数 |
| [`thumb-batch.test.js`](../../../testjs/units/thumb-batch.test.js) | 缩略图批量：失败与「服务端确实没这张」语义分离（失败不写状态）、网络恢复后自动拿到 blob | 纯函数 |
| [`refresh-virtual.test.js`](../../../testjs/units/refresh-virtual.test.js) | 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项） | 需先 `claimScanTask`（否则 `waitWhilePaused` 误判取消） |
| [`dbConnCache.test.js`](../../../testjs/units/dbConnCache.test.js) | 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶 | 内存连接桩 |
| [`pathGuard.test.js`](../../../testjs/units/pathGuard.test.js) | 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建议文件名压平 | 纯函数 |
| [`updateIntegrity.test.js`](../../../testjs/units/updateIntegrity.test.js) | 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小 | 纯函数 |
| [`main-ipc-contract.test.js`](../../../testjs/units/main-ipc-contract.test.js) | 主进程 IPC 契约的**行为**断言：① `ok`/`fail`/`canceled` 三态互斥且带可读 message；② `safe()` 把异常转成失败**返回值**、`safeReject()` 保留 reject 语义；③ `save-file` 真写盘失败（指向不存在的目录触发 ENOENT）必须回 `fail` 而不是伪装成取消；④ 选区会话残留时「先还原再重新开始」、看门狗常量存在且被调用；⑤ `normalizeAssetFileName` 挡住 `'.'` / `'..'` / 含分隔符的名字，且归一化后仍落在缓存目录内；⑥ 导航等待在窗口销毁 / 超时两条路都会收尾；⑦ 鼠标穿透态挂在窗口实例上；⑧ 前端 `saveFile.js` 对「失败」抛错、对「取消」返回空串 | 用 `require.cache` 注入假 electron，**直接 require 真实模块**（不复现逻辑），前端部分走 ESM 动态 `import()` |
| [`disposables.test.js`](../../../testjs/units/disposables.test.js) | 「资源随作用域释放」底座语义：登记的定时器/周期器在 `dispose()` 后不再触发、`listen` 与 `removeEventListener` 严格配对（capture 选项原样传回）、`defer` 是可替换的防抖语义（连排三次只触发一次）、`dispose` 幂等且单个清理函数抛错不连累其它资源、作用域停止后定时器确实不再触发（用 Vue `effectScope` 模拟组件卸载） | 前端是 ESM，用 `pathToFileURL` + 动态 `import()` |
| [`db-master-key.test.js`](../../../testjs/units/db-master-key.test.js) | **数据库主密钥 safeStorage 异步化（Electron 46 适配）的行为回归**：①只用异步 API（替身故意不提供同步方法，退回同步必挂）；②并发取钥匙靠单飞 Promise 只解析一次 —— 异步化后若两处 fork 各生成一把新钥匙，后者写回文件会让旧加密库再也打不开；③旧密文二次加载必须复用同一把钥匙；④ `shouldReEncrypt` 时明文不变、先备份再用新密文写回；⑤解密失败时备份成功才重新生成，备份失败绝不覆盖原密文；⑥异步解密返回空结果当失败处理，不许拿空密钥去起后端；⑦静态对账 fork 两条分支都用预取的 `dbKey`、入口有 ready 后预热 | `require.cache` 注入假 electron + 真跑 `electron/main/main.config.js`（不复现逻辑）；每个用例独立 userData 临时目录并在 `after` 清理；变异验证（可用性检查改回同步 API）会让 6 条用例变红；8 条用例 |
| [`data-export-zip.test.js`](../../../testjs/units/data-export-zip.test.js) | **数据导出 `/api/data/zip` 的流式打包**（v6 · P2-01）：①收据按磁盘路径流式读，Spy 住 `readFileSync` 断言整文件没被读进内存；②响应不预置 `Content-Length`（预置就必须先拼出整包）；③出来的包能被标准解压器逐字节读回，缺文件只跳过该条目，密码确实置上加密位。变异反证：把收据改回 `readFileSync`、或让加密条目开数据描述符，都会让本文件变红 | 真 `DATA_DIR`（临时目录）+ 真 Express router + 真 HTTP + `yauzl` 读回；`process.env.DATA_DIR` 必须在 require 路由之前设置（dbManager 加载时就算好目录）；3 条用例 |
| [`db-size-probe.test.js`](../../../testjs/units/db-size-probe.test.js) | 库体积探针（v6 · 0-4）：明文库能读出 `page_count` / `freelist_count` / 文件与 WAL 体积；非法库必须标 `encrypted=true` 而不是静默 0 页；目录扫描只认 `.db`；`--selftest` 自证两类样本都能跑通 | 临时明文库 + 随机字节文件；4 条用例 |
| [`storage-size-probe.test.js`](../../../testjs/units/storage-size-probe.test.js) | 目录 / 日志体积探针（v6 · 0-5）：嵌套目录按文件字节累加、缺失目录标 `missing`、`dataDir` 与 `userData` 两处日志分别统计且合计一致 | 临时目录；4 条用例 |
| [`perf-mem.test.js`](../../../testjs/units/perf-mem.test.js) | 导出内存探针（v6 · 0-5）：默认关闭时 `memSnapshot()` 返回 `null` 且不产出日志；`PERF_EXPORT=1` 时才打 rss / heap / external 差值；没有 before 时不采样；导出路由必须在 `finally` 里记录，成功/失败都留痕 | 环境变量切换 + 源码接线判据；4 条用例 |
| [`perf-mark.test.js`](../../../testjs/units/perf-mark.test.js) | **首屏分段打点**（v6 · P1-01）：①`perfNow` 是 epoch 毫秒、能与后端/主进程日志直接相减；②一条汇总里同时有总耗时与各段（排队 / 凭据 / 加密 / 发送 / 解密），并带 `@epoch` 兼容启动探针；③没有 `__perf` 的普通请求完全空转、`console.log` 抛错也不影响请求；④关键接线段真的插上了（含 Dashboard 的 `nextTick` 渲染段）。**注意**：它验证的是「打点接好了」，不是「首屏变快」——95ms 归因仍要真机跑 `measure-startup.mjs` 取数 | 直接 `import()` 前端 ESM（`student-frontend` 是 `type: module`），无需浏览器；4 条用例 |
| [`crypto-stat.test.js`](../../../testjs/units/crypto-stat.test.js) | 安全通道加解密分段计时（v6 · 0-3）：无收集器时空转、只结算一次、收集器抛错静默；三段打点必须挂在 `encryptAuthProof` / `encryptBody` / `decryptBody` 原语上，前后端接线齐全 | 前端 ESM 动态 `import()`；5 条用例 |
| [`docs-counts.test.js`](../../../testjs/units/docs-counts.test.js) | **文档计数唯一来源**（v6 · 5-3）：①9 项计数都能从源码现算，且每份文档里确实存在可替换的数字位置；②`replaceCount` 只替换捕获到的数字、前后缀原样保留、同值幂等；③文档结构变了匹配不到时必须返回 null（让 `docs:sync` 报错，而不是静默跳过）。它锁的是「验数」与「改数」共用一张表，不锁具体数值（数值由 `docs:verify` 对账） | 直接 `import()` ESM 工具模块；3 条用例 |
| [`event-loop-stats.test.js`](../../../testjs/units/event-loop-stats.test.js) | 主进程事件循环延迟（v6 · 0-7）：`statsFromHistogram` 的 ns→ms 口径、空 histogram 返回 `null`、`start` 幂等、`stop` 后不再读数；接线判据锁 `perf-snapshot` 带 `eventLoop`、启动后 3s 有观测窗口、内存首采延后且计耗时 | 真 `perf_hooks` + 假 histogram；4 条用例 |
| [`architecture-guard.test.js`](../../../testjs/units/architecture-guard.test.js) | **架构守卫**（v6 · 6-2 / 6-3）：①`schema/*.js` 的 `CREATE TABLE` 与 `schema/tableRegistry.js` 双向一致（多一张、少一张、分组写错都红）；②`slotStore` 的逻辑表名与 `registry.LOGICAL` 完全一致且都指向真实物理表；③业务层没有表名字面量数组；④`electron` 里的通道名全部在 `ipc-channels.json` 里、`preload` 直接引用该文件。检查函数都接收源码文本，测试同时喂真实文件与注入的违规片段 —— 只跑真实文件的话，正则写错（永远匹配不到）也会一直绿 | 源码文本扫描；8 条用例 |
| [`ai-doc-transaction.test.js`](../../../testjs/units/ai-doc-transaction.test.js) | AI 单块写入（`POST /api/ai/doc`）的「校验 + 快照 + 写入」同事务：校验阶段建的临时学生不许在写入失败后留在名册（v6 · Q4-01） | 内存库 + 真 router；3 条用例 |
| [`album-merge-undo.test.js`](../../../testjs/units/album-merge-undo.test.js) | 合并相册的撤销（Q2-09）：建新虚拟相册 + 复制照片索引 + 删掉全部源相册作为**一条**撤销登记，撤回来不能只剩半套 | 内存库 + 真 router；4 条用例 |
| [`app-select-esc.test.js`](../../../testjs/units/app-select-esc.test.js) | Esc 让位协议（A5-05）：弹层在下拉展开时消费 Esc（`defaultPrevented`），父弹窗不再被连带关闭；判据锁「生产端统一走 `consumeEscape`」，不逐个弹层手写 | 前端 ESM 动态 `import()`；4 条用例 |
| [`arrange-datasource.test.js`](../../../testjs/units/arrange-datasource.test.js) | 智能排表「选择数据源」：只排当前表已有的人 / 从名册取人两种语义，切换数据源时清掉上一次的落位与 `allowNew` | 纯函数；4 条用例 |
| [`arrange-desk-mixed.test.js`](../../../testjs/units/arrange-desk-mixed.test.js) | 智能排表按「桌号表」工作：混合桌（两列之间是走廊）下同桌判定不能再用列号奇偶，判据换成按桌号成组 | 纯函数；4 条用例 |
| [`arrange-grid-boundary.test.js`](../../../testjs/units/arrange-grid-boundary.test.js) | 智能排表弹窗的「网格 ↔ dense」边界：库里 `seats` 是网格（走廊是真实列），算法按 dense 下标工作，出入两向都必须映射，不能把走廊当座位 | 纯函数；4 条用例 |
| [`auth-sync.test.js`](../../../testjs/units/auth-sync.test.js) | 跨窗口登录态同步（v6 · 2-3b）：按「账号 + 库 + 会话」判身份，滑动续期不算换人（否则每次续期都误清缓存）；换号/登出先换代次再广播；三个窗口入口都必须走 `installAuthSync` | 前端 ESM 动态 `import()`；8 条用例 |
| [`backup-archive.test.js`](../../../testjs/units/backup-archive.test.js) | 备份包 v3「带全了哪些东西」（N2-02）：库三件套（含 `-wal` / `-shm`）+ 长期记忆 + 五个目录 + 清单；缩略图不入包但必须写进 `omitted` | 临时目录 + 真 `writeBundle`；2 条用例 |
| [`backup-restore.test.js`](../../../testjs/units/backup-restore.test.js) | 还原侧的「允许动现有文件的时机」：解包与逐项校验先做完（缺项 / 内容被改 / 名字不安全都在这步失败），校验通过才换目录，旧目录改名 `.bak-<stamp>` 不删 | 临时目录 + 真 zip；4 条用例 |
| [`blob-error.test.js`](../../../testjs/units/blob-error.test.js) | 二进制下载失败体归一（A4-01）：`responseType:'blob'` 时 4xx 的 `data` 也是 Blob，必须还原成对象，既有 `err.response?.data?.error` 才能拿到后端原因 | 前端 ESM 动态 `import()`；4 条用例 |
| [`bundle-restore.test.js`](../../../testjs/units/bundle-restore.test.js) | v3 包落盘的四种坏情况：包里缺某目录 / 坏包 / 缺库文件时**都不许**把本机目录清空；替换与备份目录成对，失败不留一半 | 临时目录 + 真包；4 条用例 |
| [`context-menu-exclusive.test.js`](../../../testjs/units/context-menu-exclusive.test.js) | 右键菜单互斥：座位页行标签与列头是**两个组件实例**，只能靠模块级登记表让新菜单把旧菜单关掉 | 前端 ESM 动态 `import()`；4 条用例 |
| [`context-menu-transition.test.js`](../../../testjs/units/context-menu-transition.test.js) | 右键菜单过渡：先用 `visibility: hidden` 量尺寸再显示（避免贴边溢出），过渡结束态必须与量尺寸时的定位一致 | 前端 ESM 动态 `import()`；3 条用例 |
| [`crypto-stat.test.js`](../../../testjs/units/crypto-stat.test.js) | 安全通道加解密分段计时（v6 · 0-3）：无收集器时完全空转、只结算一次、收集器抛错静默；三段打点必须挂在 `encryptAuthProof` / `encryptBody` / `decryptBody` 原语上，前后端接线齐全 | 前端 ESM 动态 `import()`；5 条用例 |
| [`dialog-stack.test.js`](../../../testjs/units/dialog-stack.test.js) | 弹窗层级栈（V5-003）：`openStack` 原先写在 `<script setup>` 里、每个实例一份，抽成模块级后一次 Esc 只关最上层 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-config.test.js`](../../../testjs/units/duty-config.test.js) | 值日列名按模式分键（`daily` 星期 / `big` 分组名 + 全部）后的读写对称：读走 `readDays`、写走 `writeDays`，模式配置落 `settings`，不得退回单一全局列名 | 内存库；4 条用例 |
| [`duty-dedupe-whole-table.test.js`](../../../testjs/units/duty-dedupe-whole-table.test.js) | 「整表去重」开关必须真的生效（A3-01）：`ctx` 里状态都是 ref/computed，`ref(true) === true` 恒为 false，判据必须解包后再比较 | 纯函数；4 条用例 |
| [`duty-index.test.js`](../../../testjs/units/duty-index.test.js) | 值日指数累加单源化：展示值与排表账本共用 `accumulateDutyIndex`，只有结算区间不同；刷新必须同时刷两处 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-ordered-arrange.test.js`](../../../testjs/units/duty-ordered-arrange.test.js) | 独立条件「顺序选项」：行优先 / 列优先与反向只作用于行内、列内，不改变跨行列的填充顺序 | 纯函数；4 条用例 |
| [`duty-packed-arrange.test.js`](../../../testjs/units/duty-packed-arrange.test.js) | 「随机分组」接入流水线：与 `duty-packing` 分工不同，这里锁「整条 pipeline 真的调用了装箱内核」，而不是内核本身 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-packing.test.js`](../../../testjs/units/duty-packing.test.js) | 分组装箱 + 整天随机映射内核：`intactGroups` 必须能从 buckets 反推（不许「显示 100% 但组被拆」），已满足的组不再打乱 | 前端 ESM 动态 `import()`；4 条用例 |
| [`duty-save-transaction.test.js`](../../../testjs/units/duty-save-transaction.test.js) | 建档副作用与写入同事务（N2-06）：`PUT /api/duty/save` 的 `validateRow` 挪进事务，避免「值日表回滚了、临时学生已提交」；另锁「名册外姓名照常建档」不被修死 | 内存库 + 真 router；3 条用例 |
| [`duty-slot-warning.test.js`](../../../testjs/units/duty-slot-warning.test.js) | 「值日位置不足，有 X 人排不进」确认框：X 必须来自 `shortageCount` 单源；「重复值日」那一支方向相反，不能被新文案吞掉 | 前端 ESM 动态 `import()`；3 条用例 |
| [`duty-settings-hydrate.test.js`](../../../testjs/units/duty-settings-hydrate.test.js) | 值日设置弹窗「首次打开即初始化」：父组件 `v-if="settingsMounted"` 懒挂载，首次挂载时 `visible` 已为 true，`watch` 不带 `immediate` 就一次都不跑 → 重启后首次打开星期与劳动项目全空（真实故障）；权重算法弹窗同理 | 读真实源码（去注释）；3 条用例 |
| [`duty-weight-linkage.test.js`](../../../testjs/units/duty-weight-linkage.test.js) | 权重表多子行联动：底层一个项目只有一个权重值，编辑任一子行必须同步到该项目所有天，一维表按均值口径比对 | 前端 ESM 动态 `import()`；4 条用例 |
| [`group-dimension-delete.test.js`](../../../testjs/units/group-dimension-delete.test.js) | 分组维度删除的撤销（Q2-08）：维度 + 该维度全部小组 + 全部成员 + 剩余维度重排合成一条撤销，不许留下只能手工重建的状态 | 内存库 + 真 router；4 条用例 |
| [`kill-tree.test.js`](../../../testjs/units/kill-tree.test.js) | 「杀进程树」端到端（V5-010/011/013）：真实三层进程树（父 → 子 → 孙），Windows 与 POSIX 分支都不许留孤儿 | 真子进程；3 条用例 |
| [`leave-undo-wiring.test.js`](../../../testjs/units/leave-undo-wiring.test.js) | 请假记录全链路撤销（Q2-05）：新增（弹窗 / 行内）、编辑、删除、销假、撤销销假都要登记，不能只有单元格编辑可撤 | 内存库 + 真 router；4 条用例 |
| [`login-contrast.test.js`](../../../testjs/units/login-contrast.test.js) | 登录页文字对比度按 WCAG 现算：登录页直接压在背景图上、卡片是半透明玻璃，换背景图就可能从「能看清」变成「整片糊」 | 前端 ESM 动态 `import()`；4 条用例 |
| [`inp-longtask.test.js`](../../../testjs/units/inp-longtask.test.js) | 主线程长任务观察（v6 · 0-2）：16ms 起记录、不支持 `longtask` 时不装配、`observe` 抛错返回 `null`、单条 `onRecord` 抛错不影响后续；渲染层必须把 `longTasks` 汇总进 `dump` 并落 `inp.log`，`reset` 清空 | 前端 ESM 动态 `import()`；6 条用例 |
| [`login-file-picker.test.js`](../../../testjs/units/login-file-picker.test.js) | 「从数据库登录」是**唯一**的文件入口：渲染层一个 `<input type="file" accept=".db,.json,.zip">` 按扩展名分派，不再有第二个「从备份包恢复」按钮 | 前端 ESM 动态 `import()`；4 条用例 |
| [`media-credential.test.js`](../../../testjs/units/media-credential.test.js) | 静态资源凭据（V5-005）：打包版页面是 `file://`，取图属跨站，`SameSite=Lax` 的 httpOnly Cookie 不随 `<img>` 发送，两种模式都必须用 `scope=media` 受限凭据 | 纯函数；3 条用例 |
| [`orphan-check.test.js`](../../../testjs/units/orphan-check.test.js) | 只读孤儿检查器的可信度（v6 §0-4）：一个「永远返回 0」的检查器最容易是假的，所以把 `--selftest`（种 6 条已知孤儿）挂进 CI，改坏判定就变红 | 临时明文库；2 条用例 |
| [`receipt-kind.test.js`](../../../testjs/units/receipt-kind.test.js) | 收据 Office 文件打不开（4-1）：校验层按魔数分出 `ooxml` / `ole`，落库前必须归一成 `office`，前端 `viewMode` 同时兼容旧值 | 内存库 + 真 router；4 条用例 |
| [`restore-bundle.test.js`](../../../testjs/units/restore-bundle.test.js) | v2 恢复的完整性预检（V4-B05-13）：先写临时文件 → `integrity_check` 通过才覆盖，坏包不许毁掉本来能用的旧库 | 临时目录；2 条用例 |
| [`save-outcome.test.js`](../../../testjs/units/save-outcome.test.js) | `save-file` 三态判定（V5-002）：`ok` / `fail` / `canceled` 互斥，写盘失败不能被当成用户取消；前端对「失败」抛错、对「取消」返回空串 | 纯函数 + 前端 ESM；4 条用例 |
| [`schema-foreign-keys.test.js`](../../../testjs/units/schema-foreign-keys.test.js) | 外键声明（N2-03 第一步）：9 处 `ON DELETE CASCADE` 齐全、3 处（`cadres.parent_id` / 组员姓名 / 多态 `target_id`）故意不加；新建库立即受约束，老库不回填也不报错 | 内存库；4 条用例 |
| [`search-limits.test.js`](../../../testjs/units/search-limits.test.js) | 全局搜索分页（P3-08）：根因是没有分页而非上限太小 —— `LIMIT ? OFFSET ?` 真翻页、`hasMore` 由每源多取一条精确判定、页参数不接受请求放大 | 纯函数；4 条用例 |
| [`seat-ai-align.test.js`](../../../testjs/units/seat-ai-align.test.js) | 座位网格与「对外文案 / 快照 / AI 输出」对齐：走廊是 `seats` 里的真实列，一张 7 座位列的表网格宽 13，任何「第几列」都必须走 `columnLabels`，不能用网格下标 | 内存库 + 真 router；4 条用例 |
| [`seat-aisle-col.test.js`](../../../testjs/units/seat-aisle-col.test.js) | 整列走廊（列头右键「左/右插入」「删除这条走廊」）：插入不动左右两列、删除逐格还原、`cols` 跟着变 | 纯函数；4 条用例 |
| [`seat-aisle-row.test.js`](../../../testjs/units/seat-aisle-row.test.js) | 整行走廊（行标签右键「上方/下方插入」「删除这条走廊」）的几何语义：插入 / 删除后行数、`types`、`seats` 三者同步 | 纯函数；4 条用例 |
| [`seat-cell-write.test.js`](../../../testjs/units/seat-cell-write.test.js) | 座位单格写入（`PATCH /cell`、`PATCH /master/cell`）：收敛到 `services/seatWrite.js` 后，洞 / 走廊 / 不存在的学生 id / 一人占两座都拒绝；整表 PUT 与单格判据同源、业务校验失败都回 400 | 内存库 + 真 router + 真 HTTP；15 条用例 |
| [`seat-desk-pattern.test.js`](../../../testjs/units/seat-desk-pattern.test.js) | 混合桌：不另存桌型序列，桌型从「走廊在哪」派生 —— 拆桌 = 两列之间插一条走廊，合并 = 删掉中间那条 | 纯函数；4 条用例 |
| [`seat-draft-reset.test.js`](../../../testjs/units/seat-draft-reset.test.js) | 排表草稿的模块级单例跟着账号走（X2-07）：换号既要清值又要作废在途响应，否则 B 打开智能排表看到 A 的草稿 | 前端 ESM + 拦截器桩；4 条用例 |
| [`seat-fair-conservation.test.js`](../../../testjs/units/seat-fair-conservation.test.js) | 位置公平（`applyFair`）的人数守恒：按目标块位置数遍历落盘时不能多塞或漏人 | 纯函数；4 条用例 |
| [`seat-geometry.test.js`](../../../testjs/units/seat-geometry.test.js) | 座位网格几何的回归锚点：把改造前的旧公式**原样冻结**在测试里当参考实现，而不是拿新实现跟自己对 | 纯函数；4 条用例 |
| [`seat-grid-migration.test.js`](../../../testjs/units/seat-grid-migration.test.js) | 座位几何 dense → 网格的一次性迁移：这是唯一一处不可逆且静默的改动（迁错后界面看不出异常，座位指数却整体错位） | 内存库；4 条用例 |
| [`seat-hole-paint.test.js`](../../../testjs/units/seat-hole-paint.test.js) | 「设置空位」画笔：纯函数规则（`toggleHole` / `usableSeatCount` / `clearHoles`）+ 真实写入口（能存空位、拒绝「有人的格子挖洞」） | 纯函数 + 内存库 + 真 router；4 条用例 |
| [`seat-types.test.js`](../../../testjs/units/seat-types.test.js) | 格子类型矩阵（`types`）的存取契约：必须穿过 schema、`slotStore` 白名单、视图三层，漏一层就是「PUT 不报错、GET 读到旧值」 | 内存库；4 条用例 |
| [`seat-undo-geometry.test.js`](../../../testjs/units/seat-undo-geometry.test.js) | 撤销的几何契约（P0-3 / P0-2）：几何只从快照 `types` 形状推，前端四元组降级为漂移告警；漏 `cols` 会让座位图整体错列 | 内存库；4 条用例 |
| [`seat-undo-rows.test.js`](../../../testjs/units/seat-undo-rows.test.js) | 撤销「插入/删除行走廊」时行数必须与 `types` 一起回写：`grid_snapshot` 原先只回写 JSON 列，会留下「`types` 少一行、`rows` 还是多的」 | 内存库；4 条用例 |
| [`seat-weight-align.test.js`](../../../testjs/units/seat-weight-align.test.js) | 权重表跟随座位表几何：权重矩阵独立存储，划成走廊或挖洞后旧数字仍在，取消走廊时必须重新对齐 | 内存库；4 条用例 |
| [`secure-retry.test.js`](../../../testjs/units/secure-retry.test.js) | 安全信道 401 重试的分支判定（N1-02）：凭据降级 / `auth-required` / `session-expired` 三个分支抽成纯函数后可单测，不再只靠需要 Vite + Electron 的冒烟脚本 | 纯函数 + 前端 ESM；4 条用例 |
| [`sequenced-cache.test.js`](../../../testjs/units/sequenced-cache.test.js) | 带账号代次的进程内缓存（P0-6）：TTL 复用 + 写入前核对代次 + 失败不缓存；`invalidate()` 同时清值并作废在途，`clear()` 只清值 | 前端 ESM；4 条用例 |
| [`session-revocation.test.js`](../../../testjs/units/session-revocation.test.js) | 凭证变更 → 全账号会话失效（A1-16）：账号维度必须是 `(userId, dbSlug)` 双键（各库 `users.id` 都可能是 1）；改密后走响应头换发新凭据，图片不裂 | 真 `sessions` + 隔离 `dataDir`；4 条用例 |
| [`sessions-ttl.test.js`](../../../testjs/units/sessions-ttl.test.js) | 会话名单的活动时间与清理（V5-009）：`at` 改为最后一次活动时间（1 小时节流落盘），否则持续使用的会话会在下一次 prune 时被当成弃用踢掉 | 临时状态文件；4 条用例 |
| [`single-flight.test.js`](../../../testjs/units/single-flight.test.js) | 启动单飞守卫（P0-5）：并发调用只跑一次且拿到同一 Promise，同步副作用不延后微任务，失败后可重试 | 纯 Promise；4 条用例 |
| [`student-cascade-delete.test.js`](../../../testjs/units/student-cascade-delete.test.js) | 删除学生的级联撤销（Q2-03）：七处（学生 / 请假 / 加减分 / 小组 / 班干部 / 座位 / 值日）合成**一条**撤销，不许按七次撤、也不许留半个 | 内存库 + 真 router；4 条用例 |
| [`student-delete-guard.test.js`](../../../testjs/units/student-delete-guard.test.js) | 删学生不许留孤儿（N2-05）：通用删除入口先算关联，有就拒并列出明细，让调用方走「一并删除」（偷偷清会绕过撤销登记） | 内存库；4 条用例 |
| [`token-renewal.test.js`](../../../testjs/units/token-renewal.test.js) | 滑动续期「换代即作废」（X2-08）：响应合法，唯一线索是「发请求时是哪一代」；代次不符一律丢弃，缺参数抛 `TypeError` | 纯函数（依赖注入）；4 条用例 |
| [`undo-recorder.test.js`](../../../testjs/units/undo-recorder.test.js) | 撤销登记只能有一个入口（Q2-10）：失败必须弱提示、不许 `.catch(() => {})`；成功后刷新 Ctrl+Z 可用态，批次不逐条刷 | 前端 ESM；4 条用例 |
| [`user-scoped-race.test.js`](../../../testjs/units/user-scoped-race.test.js) | 换号后在途请求不得写回（V5-004）：请求发出时记登录代次，响应回来代次变了就丢弃并重拉 | 前端 ESM；4 条用例 |
| [`week-dates.test.js`](../../../testjs/units/week-dates.test.js) | 「星期列 → 具体日期」换算：按星期名取而不按列下标取（表头可拖拽），月和日不补零，非法日期返回空串 | 前端 ESM 动态 `import()`；4 条用例 |
| [`widget-data-changed.test.js`](../../../testjs/units/widget-data-changed.test.js) | 挂件不再只靠 5 分钟轮询（A5-02）：写请求成功后按域广播，基础设施写（聊天/相册/账户/导出/握手）排除，未知业务写保守全量失效 | 前端 ESM；4 条用例 |
| [`zip-bundle.test.js`](../../../testjs/units/zip-bundle.test.js) | 备份包两块地基（A1-03 / N3-03）：`sanitizeEntryName` 拦 Zip Slip（`../` 与盘符），`writeZip` 流式打包后能被标准解压器逐项读回（名字、内容、CRC / 尺寸都对得上） | `yauzl` 读回；4 条用例 |
| [`zip-peek.test.js`](../../../testjs/units/zip-peek.test.js) | 「这个备份包要不要口令」的判断必须与真包一致：误判「不用口令」会让用户卡在解不出钥匙，误判「要口令」只多问一句 | 前端 ESM + 真 zip；4 条用例 |
| [`undo-batch-coverage.test.js`](../../../testjs/units/undo-batch-coverage.test.js) | 一次动作改多行必须整批可撤（Q2-04 / Q2-05 / Q2-06）：`row_reorder` / `rows_batch_insert` / `rows_batch_delete` 真能回滚；导入端点与 `tableService.importRows` 都回传完整 `created`（否则几百行会被「每 key 50 条」上限截断） | 内存库 + 真 router；3 条用例 |
| [`log-rotator.test.js`](../../../testjs/units/log-rotator.test.js) | 日志体积收口（v6 · 1-1）：`rotateIfNeeded` 对不存在/未超限的文件不动，超限只留「提示行 + 最近尾部」且不整份读入内存；`appendWithRotation` 自动建目录、同一文件串行追加（20 行不乱序不丢行）、超限前先截断；接线判据锁 `backend.log` 建流与截断全程异步（不再有 `fs.appendFileSync`）、`inp.log` / `desktop-layer.log` 共用同一出口、运行期有 5 分钟低频巡检 | 临时目录；3 条用例 |
| [`secure-bridge.test.js`](../../../testjs/units/secure-bridge.test.js) | 安全通道握手报文桥（v6 · 2-19）：请求体只有 `{ pub }`、URL 固定指向后端握手端点；公钥形状非法时不发出任何请求；后端非 2xx、响应缺 `sessionId`、响应非 JSON 都必须报错；接线判据锁 `ipc-channels.json` 已登记、授权与 `get-master-key` **完全一致**、渲染层走 IPC 且保留纯浏览器下的 `fetch` 兜底、私钥从不导出 | 注入 fake `fetchImpl`；4 条用例 |
| [`photo-info-cache.test.js`](../../../testjs/units/photo-info-cache.test.js) | 相册「信息」缓存封顶（v6 · 1-4）：超过 200 条淘汰最久未使用、命中会刷新顺序；模块加载时已登记用户级清理（登出/换号后为空）；接线判据锁 `AlbumView` 不再自带无上限 `Map`、读写与卸载都走该模块 | 前端 ESM 动态 `import()`；3 条用例 |
| [`secure-channel-idle-sweep.test.js`](../../../testjs/units/secure-channel-idle-sweep.test.js) | 安全通道空闲清扫（v6 · 1-5）：`now` 可注入 → 推进到 TTL 之后会话必被清、未过期不动；清扫定时器幂等、`unref`（不拖住进程退出）、可停；接线判据锁「只有 `initMaster` 成功才启动」且握手/凭据路径上的兜底清扫仍在 | 真 `node:crypto` 生成公钥；3 条用例 |
| [`secure-response-serialize.test.js`](../../../testjs/units/secure-response-serialize.test.js) | 响应只序列化一次（v6 · 1-2）：加密分支信封与 `JSON.stringify({ d })` **逐字节一致**且不再经过 `res.json`；密文能被同一会话密钥解回原对象；非加密 / 豁免路径 / 会话失效仍走 `res.json` 原路；`no-store` 头保留 | 假 `req`/`res` + 真 seal/open；3 条用例 |
| [`keep-alive.test.js`](../../../testjs/units/keep-alive.test.js) | 后端 keep-alive 显式配置（v6 · 1-6）：`app.listen` 之后必须设 `keepAliveTimeout` / `headersTimeout`，且后者严格大于前者（否则先按请求头超时掐连接，保活等于没生效），两个值都要大于 Node 默认 5s | 源码接线判据；1 条用例 |
| [`lifecycle-resources.test.js`](../../../testjs/units/lifecycle-resources.test.js) | 定时器/监听器「创建处 = 销毁处」守卫（v6 · 1-11 + 1-13）：全量扫描 `src/**`，`setInterval` 必须有 `clearInterval` 或 `d.interval`；`window`/`document` 级 `addEventListener` 必须被移除、`.listen()`、`{ once: true }` 或 `{ signal }` 覆盖（元素级监听随元素销毁不计）；豁免表每项都必须仍需要豁免（防止过期白名单）；并用注入样本自证规则真的会判红 | 源码文本审计；4 条用例 |
| [`data-export-tables.test.js`](../../../testjs/units/data-export-tables.test.js) | `/api/data/tables` 只计数不物化（v6 · 1-3）：内存库 + 真 router，插入 3 名学生 / 2 个活动后计数正确；用 SQL spy 断言整个 GET 期间**没有任何** `SELECT * FROM students\\|activities`、且确实走了 `COUNT(*)`；没有物理表的「应用设置」仍走 `build` 兜底；再按源码判据锁「除派生表外每张表都配了 count」 | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；2 条用例 |
| [`pkg-size-probe.test.js`](../../../testjs/units/pkg-size-probe.test.js) | 打包体积探针（v6 · 1-12）：`fmtBytes` 的 B/KB/MB 边界与异常值；分桶把 asar / 根依赖 / 作用域依赖 / 后端依赖 / 语言包 / 根目录二进制分开（resources 下的 ffmpeg 不混进主程序）；汇总同桶累加并按体积降序；`package.json` 的每个生产依赖都必须能 `require.resolve` | 纯函数 + 真实 package.json；4 条用例 |
| [`get-share.test.js`](../../../testjs/units/get-share.test.js) | 通用 GET 在途共享（v6 · 1-7）：同 key 并发只调一次底层请求且两个调用方拿同一份响应；成功后 TTL 内复用、过期重发；换号后旧响应 reject 成 `ERR_CANCELED` 且不写缓存；写操作 `markDirty` 只清缓存、不取消在途，写后新调用重新发请求；`keyOf` 只认普通 GET（写 / blob / `signal` / `__noShare` 均不共享）；条目超上限淘汰最旧；接线判据锁 `httpClient` 装适配器 + 登记换号清理 + 写成功 `markDirty` | 前端 ESM 动态 `import()` + 注入时钟/代次；7 条用例 |
| [`seat-daily-aggregate.test.js`](../../../testjs/units/seat-daily-aggregate.test.js) | 座位账本 / 座位指数单遍结算（v6 · 1-9）：5 组确定性随机快照下，单遍合并结果与改造前「loadSeatLedger + seatIndexRows」两份遍历逐学生 `deepEqual`；账本不含今日、指数不含所选周之后（并集多拉的天数不能串口径）；`indexTo` 为空表示不设上限；`unionCutoff` 的 `''` 语义；接线判据锁 `SeatView` 只剩 1 处 `/seats/daily`、缓存命中 + 在途复用、旧的 `seatIndexDaily` 已移除 | 前端 ESM 动态 `import()`；5 条用例 |
| [`batch-delete.test.js`](../../../testjs/units/batch-delete.test.js) | 批量删除端点（v6 · 1-8）：内存库 + 真 router，一次 `POST /batch-delete` 删 2 条并去重、position 重排连续；夹一个不存在的 id → 400 且合法那条也没被删（真事务回滚）；`minCount=1` 时删空 → 400 一行不掉；单条 `DELETE /:id` 仍可用；缺 ids / 全非法 id 直接拒绝；源码判据锁前端两处删除各只发 1 个 `batch-delete`、不再逐条 DELETE | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；6 条用例 |
| [`startup-io.test.js`](../../../testjs/units/startup-io.test.js) | 启动期同步 IO 打点（v6 · 1-10）：`PERF_STARTUP` 未开时一个 fs 方法都不替换；开启后按方法计数且返回值/异常原样透传（计时不能改语义）；重复 `install` 不叠加；`summarize` 打印合计并把 mark 写进启动时间线；未安装时空转；接线判据锁 `main.js` 的安装早于首个同步 IO、`summarize` 早于 `report` | 注入假 fs；5 条用例 |
| [`dashboard-summary.test.js`](../../../testjs/units/dashboard-summary.test.js) | 首屏 dashboard 摘要化（v6 · 2-1）：内存库 + 真 router 造 45 人 / 1000 条加减分 / 7 条班费 —— 响应里不再有全量 `scores`/`fees`、`students` 只剩 `id+姓名`；`summary` 的 Top4（含扣分转负、小组名）与班费三口径与改造前 `DashboardView` 的 computed 逐项一致；同数据量下整包 < 30KB（改造前 358.8KB）；并锁前端不再读 `d.scores`/`d.fees`、造数工具改读 `summary` | 内存库 + `require.cache` 替换 `../db` + 真 HTTP；4 条用例 |
| [`main-env.test.js`](../../../testjs/units/main-env.test.js) | 开发/打包模式判定唯一口径（v6 · 2-20）：Electron 45 下 `app.isPackaged` 在源码模式误报 true，用 `process.defaultApp` 纠正；三种组合（打包 / Electron45 源码 / 常规源码）逐一断言；`electron/main/*.js`（除 `main.env.js`）不得再出现 `app.isPackaged`；`main.*.js` 都从 `main.env` 取值、更新入口用 `isPackaged` 挡住开发环境 | 注入假 electron + 改写 `process.defaultApp`；5 条用例 |

新增：在 `units/` 建 `*.test.js`，用 `node:test` 的 `test()` 编写，无需改配置。

---

## 注意事项

- **分层不要混写**：纯算法留在本层；组件行为语义放 [behavior.md](./behavior.md)，HTTP ↔ 前后端链路放 [smoke.md](./smoke.md)。
- **不碰真实数据**：本层只用内存库、连接桩与纯函数；需要启动真实后端或真实 `DATA_DIR`（数据目录）的用例不属于这一层。
- **`_vue-loader.cjs` 不是用例**：它是加载 `.vue` 单文件组件的辅助（编译模板后交给 ESM 动态 `import()`），供需要真跑组件脚本的用例复用；新增这类辅助仍沿用 `_` 前缀。

---
