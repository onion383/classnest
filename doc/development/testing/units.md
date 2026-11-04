# 单元测试（`testjs/units/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── units/
        ├── albumScan.test.js  # 相册扫描的「索引被误删/清空」防护
        ├── api-paths.test.js  # 认证端点路径单一来源：前端常量与后端真实路由对账
        ├── client-cache.test.js  # 用户作用域缓存：登出必失效、清理函数抛错不拖垮登出、缓存模块确实登记
        ├── backend.test.js  # 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、domai…
        ├── backend-multiwrite.test.js  # 多步写的一致性：补存/排序中途失败不留半截（真路由 + 真 SQLite + 注入写入故障）
        ├── backend-boundary.test.js  # 写入边界与实际结构脱节：单格坐标越界、姓名匹配口径不一致（真路由 + 真 SQLite）
        ├── backend-consistency.test.js  # 跨库写补偿与信号透传：改用户名补偿、album 删除原子性、改名跳过提示
        ├── backend-limits.test.js  # 写入边界的上限与配额：座位/值日写入上限、快照配额、恢复词版本标识
        ├── backend-sideeffect.test.js  # 校验阶段的副作用不能留在库里：断言写库失败不留孤儿行
        ├── ai-limits.test.js  # AI 链路边界与预算：tool_call 收口、快照标识唯一、会话存在性、取消信号、预算闸门
        ├── sweep-fixes-b19.test.js  # 批 19 基础组件与前端工具回归：写请求重发守卫、字体 hash、JWT 不进 URL、静默期防抖、缓存失效、覆盖索引
        ├── backend-date.test.js  # 后端日期工具：本地时区口径、周一归属、跨月跨年偏移、Date 入参不被就地改写、路由不许再复制一份
        ├── leave-state.test.js  # 「今天在不在校」的请假口径：跨天假、提前登记、过期未销假、Date/带时间串、首页与挂件共用同一实现
        ├── widget-capture.test.js  # 浮窗截屏必须「自己先藏好」：两个调用方都走 captureHide，且传 hideWidget:false
        ├── smart-group.test.js  # 智能分组算法：single 模式人数守恒（不丢学生）、无混性别组、同性别池内人数差 ≤ 1、穷举组合
        ├── test-assets.test.js  # 测试资产自身回归：假覆盖、临时目录泄漏、死等、空 catch 漏报、注释路径漂移、子进程不杀树
        ├── sweep-fixes.test.js  # 模式扫描批的行为回归：日期收口、revoke 延迟、附件 catch、EXIF 月日、主题覆盖、busy 复位、ffmpeg 超时
        ├── changelog.test.js  # 更新历史解析：版本标题写法、条目清理、HTML 注释忽略、日期倒序
        ├── dbConnCache.test.js  # 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶
        ├── disposables.test.js  # 资源登记表：登记即释放、dispose 幂等、清理抛错不连累、listen 严格配对、作用域停止后定时器不再触发
        ├── frontend.test.js  # 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼…
        ├── main-ipc-contract.test.js  # 主进程 IPC 契约行为：直接 require 真实模块，验三态、异常出口、状态归属与路径归一化
        ├── pathGuard.test.js  # 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建…
        ├── note-curve.test.js  # 荧光笔笔锋：Catmull-Rom 分组描边后线宽确有变化（旧实现必挂）
        ├── refresh-virtual.test.js  # 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项）
        ├── slug-scopes.test.js  # 按库隔离状态底座：同号 id 不互覆、flush 不串库、登出清桶不占配额
        ├── thumb-batch.test.js  # 缩略图批量：失败与「服务端没有」语义分离、网络恢复后自动重取
        └── updateIntegrity.test.js  # 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小、安装前复核能识别被替换的文件
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：单元测试层（`testjs/units/`），28 个 `node:test`（Node 内置测试框架）文件，覆盖纯函数与内存库上的数据层逻辑。
- **公共逻辑**：零第三方依赖（`node:test`（Node 内置测试框架）+ `node:assert`（Node 内置校验库）），不启动后端与前端；失败退出码非 0，可直接接 CI。运行：`npm run test:units`（支持 `--only=`（只跑指定文件）/ `--skip=`（跳过指定文件）/ `--bail`（首个失败即停）/ `--list`（只列用例不执行））。
- **局限**：不覆盖 HTTP 路由、UI、进程间链路与真实数据目录；分层说明见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

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

新增：在 `units/` 建 `*.test.js`，用 `node:test` 的 `test()` 编写，无需改配置。

---

## 注意事项

- **分层不要混写**：纯算法留在本层；组件行为语义放 [behavior.md](./behavior.md)，HTTP ↔ 前后端链路放 [smoke.md](./smoke.md)。
- **不碰真实数据**：本层只用内存库、连接桩与纯函数；需要启动真实后端或真实 `DATA_DIR`（数据目录）的用例不属于这一层。

---
