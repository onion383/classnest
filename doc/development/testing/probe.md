# 过程探针（`testjs/probe/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── probe/
        ├── pages/
        │   └── secure-channel-retry.html  # 断言页（不是独立探针）：用假的 axios 驱动 secureAxios 的 401 处理分…
        ├── _sample-big.cjs  # 大样张数据生成（供相册/表格探针复用）
        ├── bundle-diff.mjs  # 构建产物体积差异
        ├── card-height-anim-probe.cjs  # composables/useCardHeightAnimation.js 的时序（只测「高…
        ├── data-export-probe.cjs  # 设置页「数据管理」导出链路（自建临时明文库）：① 19 张表清单与行数；② 座位按网格导出（…
        ├── data-write-guards-probe.cjs  # 写入守卫：小组件设置补丁式更新、请假只改结束时间仍校验窗口、跨职务移动守 max_count…
        ├── db-size-probe.cjs  # 库体积 / freelist / WAL 只读探针（v6 · 0-4）：明文库读 page_count/freelist_count，加密库只报文件与 WAL 体积并标 encrypted
        ├── etag-revalidate-probe.cjs  # ETag 重新校验行为
        ├── export-format-probe.cjs  # 导出格式清单对账（批 13）：导出格式在四处独立维护（主进程 ALLOWED_SAVE_EX…
        ├── gdi-shot-bench.cjs  # GDI 截图性能基准
        ├── glyph-render-check.mjs  # 图标字形渲染核对
        ├── grid-row-drag-probe.cjs  # 网格行拖拽让位
        ├── inject-drag.ps1  # SetCursorPos + mouse_event 合成一次真实左键拖动（配合其它探针）
        ├── inp-compare.mjs  # 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor）
        ├── inp-probe.mjs  # 交互延迟（INP）：自动起 Vite + 带调试口的 Electron，CDP 派发真实输入…
        ├── ipc-guard-probe.cjs  # IPC 授权拦截层：授权内角色放行、越权时 handler 根本不被调用、表外通道拒绝、安装…
        ├── ipc-policy-gen.mjs  # IPC 授权表生成器：从渲染层静态 import 图推导「通道 → 允许的窗口角色」，输出 …
        ├── ipc-policy-probe.cjs  # IPC 授权表回归：ipc-channels.json 与 ipc-policy.json …
        ├── ipc-usage-probe.cjs  # 「通道有登记、但没人调用」的真实清单。审查 v4 · C01-08 报「6 条死通道」，实际…
        ├── keepalive-album-probe.cjs  # KeepAlive 下相册页状态恢复
        ├── keepalive-restore-probe.cjs  # KeepAlive 通用恢复
        ├── keepalive-table-restore-probe.cjs  # KeepAlive 表格页滚动/编辑态恢复
        ├── lifecycle-dispose-probe.cjs  # 「资源随作用域释放」回归（定时器/监听器/AbortController 与销毁处不相邻 →…
        ├── longframe-probe.mjs  # 长帧定位（主线程阻塞点）
        ├── main-ipc-contract-probe.cjs  # 主进程 IPC 结果契约（批 13 根因修复的静态护栏）：① 契约层三态互斥（ok/fail…
        ├── measure-startup.mjs  # 启动耗时；--backend-only / --dev / --json / --runs …
        ├── mode-probe.mjs  # 日/夜模式切换开销
        ├── night-btn-hover-probe.cjs  # 夜间主题按钮悬停配色
        ├── ocr-probe.mjs  # OCR 可用性（仅 Windows）
        ├── open-upload-probe.cjs  # open-upload-file 通道边界（这条通道能让渲染层用系统程序打开文件，重点在边界…
        ├── pattern-sweep-probe.cjs  # 模式扫描（全仓同类漏网）：把「同一个代码模式的所有出现点」一次性捞出来，而不是按条目编号逐条…
        ├── pdf-leak-probe.mjs  # PDF 导出内存泄漏（看 V8 external，不看 rss）
        ├── pkg-size-probe.cjs  # 打包体积构成 + 生产依赖可解析性（v6 · 1-12）：按 app.asar / 根依赖 / 后端依赖 / locales / 二进制分桶，列出 ffmpeg 与字体大文件
        ├── race-guard-probe.cjs  # 异步响应序号守卫回归（「只认最后一次」类 bug）：① 竞态调用点（历史快照/AI 模型识别…
        ├── receipt-trash-probe.cjs  # 收据回收站的路径边界（这是「能搬动磁盘文件」的入口，判据重点是删不到 uploads 之外）…
        ├── refresh-warm-check.cjs  # 刷新/预热后的缓存命中
        ├── rollback-probe.cjs  # 失败后 UI 必须回滚（「乐观更新」类 bug）：① 失败路径必须有回滚动作（写回旧值 / …
        ├── safe-json-probe.cjs  # 读库 JSON 列必须走统一兜底：① seats.js 的 snapshot/backfil…
        ├── save-zip-probe.cjs  # save-file 能不能落 .zip：替身 electron 跑真实 main.dialo…
        ├── screenshot-bench.cjs  # 应用内截图性能基准
        ├── search-bench.cjs  # 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照…
        ├── search-sources-probe.cjs  # 全局搜索（GET /api/search）各数据源能否命中、排序/多词/字段限定/focus…
        ├── select-db-file-probe.cjs  # 「从数据库登录」选文件通道（select-db-file）回归：① 用户取消必须走 canc…
        ├── slug-scope-probe.cjs  # 跨库状态分桶接线回归（「裸 id / 全局攒批」类 bug）：① scanWorker.js…
        ├── storage-size-probe.cjs  # 目录 / 日志体积只读探针（v6 · 0-5）：uploads、两个回收站、缩略图、快照、ai-memory/skills、ffmpeg 与四个日志出口
        ├── table-service-probe.cjs  # 动态表服务的三条数据契约：删字段后加回同名列能找回旧值、导入行显式写 position（否则…
        ├── toplevel-bottom-probe.cjs  # 「顶层置底」最小原型（顶层窗口 + 透明圆角 + 拖动 + z 序自检，无业务代码）
        ├── upload-signature-probe.cjs  # 收据上传的类型校验：① 11 种真文件（jpg/png/webp/pdf/docx/xlsx…
        ├── vapor-audit.mjs  # 组件 Vapor 迁移审计
        ├── vapor-bench.mjs  # Vapor 通道基准
        ├── vapor-verify.mjs  # 校验产物里 __vapor: true（拼错标记只会静默失效）
        ├── viewer-anim-probe.cjs  # 查看器切换动画
        ├── viewer-load-probe.cjs  # 查看器图片加载
        ├── viewer-open-probe.cjs  # 照片查看器打开耗时
        ├── widget-bottom-regression.ps1  # 置底回归：-Drags N 次合成拖动，校验位移正确、尺寸不变、松手仍在 Progman 之…
        ├── widget-shot.ps1  # 把组件窗口临时提到最前截图（-Out 指定路径，截完压回）
        └── write-only-ref-probe.cjs  # 「只写不读」的响应式变量：ESLint 的 no-unused-vars 只抓「从未被引用」…
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：过程探针层（`testjs/probe/`），55 个脚本（54 个探针 + 1 个样例），需要手动传参、耗时较长或拉起完整应用。
- **公共逻辑**：多数自行启动 `Vite`（前端开发服务器）/ 带调试口的 `Electron`，或复用 `_sample-big.cjs`（大样张生成脚本）生成样张；输出是数据/报告，结论写到本页或 `doc/开发文档/`。
- **局限**：**不是回归测试**，不能当判据、也不进冒烟；可信范围见 [testing/README.md](./README.md)。

---

## 详细说明

### 启动与性能

| 脚本 | 用途 / 参数 |
| --- | --- |
| [`pattern-sweep-probe.cjs`](../../../testjs/probe/pattern-sweep-probe.cjs) | **模式扫描（全仓同类漏网）**：把「同一个代码模式的所有出现点」一次性捞出来，而不是按条目编号逐条找。16 个模式：内联拼 `YYYY-MM-DD`（应走 `localDateStr`）、下载后同步 `revokeObjectURL`（→ 0 字节文件）、`await` 的 I/O 结果被丢弃、`promise` 链结果被丢弃且无 `catch`（→ unhandled rejection）、组件状态上的 `new Map()` 无 `delete`/`clear`（→ 无界增长）、`:key` 含动态表达式（→ 全量重挂载）、起子进程无 `timeout`（→ hang 拖死整体）、测试建临时目录未清。白名单式对账：**命中不在白名单 = 新漏网（失败）**、**白名单项已不存在 = 该清白名单了（失败）**；修完全部后白名单为空 → 自动升级为纯回归资产。⚠️ 判据只做静态形态检查（动态问题抓不到）；`--report` 只出报告不判成败，`--mode=xxx` 只看单个模式 |
| [`safe-json-probe.cjs`](../../../testjs/probe/safe-json-probe.cjs) | 读库 JSON 列必须走统一兜底：① `seats.js` 的 snapshot/backfill 与 history/week、`undo.records.js` 的 payload、`search.js` 的 cells/settings/seats/days 都走 `safeJson` / `readDocJson`；② **写路径反向豁免**：`seats.js` 的 `updateSingleCell` 必须保持裸 `JSON.parse`（解析失败要显式抛错 —— 降级成空座位会把整张表覆盖成只剩一格）；③ 全库扫描无「读库列的裸 JSON.parse 且无兜底」；④ `safeJson` 语义不被改歪。判据已做反向验证 |
| [`rollback-probe.cjs`](../../../testjs/probe/rollback-probe.cjs) | 失败后 UI 必须回滚（「乐观更新」类 bug）：① 失败路径必须有回滚动作（写回旧值 / 恢复可见性 / 条件化 `emit('saved')`）；② 回滚要覆盖**全部**被改动的本地状态（只回滚一半 → 界面半新半旧）；③ 回滚本身不引入新问题（旧值为 `undefined` 时删字段而非写 `undefined`）；④ 提示条失败路径必须成对（写文案 + 调 `showReject()` 启动清除定时器，否则提示条永驻）。判据已做反向验证：抽掉任一回滚后探针报警 |
| [`race-guard-probe.cjs`](../../../testjs/probe/race-guard-probe.cjs) | 异步响应序号守卫回归（「只认最后一次」类 bug）：① 竞态调用点（历史快照/AI 模型识别/分组维度/每日回填×2/AI 记录表/表格刷新）必须用 `createLatest()`；② **await 之后的状态写入之前必须有 `isCurrent` 判定**（按函数作用域判定，同步写入不算）；③ `createLatest` 语义不被改歪（`isCurrent` 必须严格相等，写成 `>=` 会让旧令牌重新生效）。判据已做反向验证：抽掉任一守卫后探针精确报出该行 |
| [`ipc-policy-probe.cjs`](../../../testjs/probe/ipc-policy-probe.cjs) | IPC 授权表回归：`ipc-channels.json` 与 `ipc-policy.json` 一一对应；授权必须覆盖静态 import 图算出的真实调用方（漏授权=功能被拦、多授权=权限过宽）；敏感通道（改数据目录/加密/拿密钥/装更新/退应用）仅主窗口；表外通道 fail-closed；裁剪后的 preload 白名单不含越权通道，且**每个窗口实际调用的通道都在其白名单内**（正向保证不误伤功能） |
| [`select-db-file-probe.cjs`](../../../testjs/probe/select-db-file-probe.cjs) | 「从数据库登录」选文件通道（`select-db-file`）回归：① 用户取消必须走 `canceled` 而非 `fail`（否则前端会误弹「选择失败」）；② `.db` 只回文件名、不读文件内容；③ `.json` 连文本一起返回且可解析；④ 超 64MB 的备份包必须 `fail` 并说明上限；⑤ 默认目录先落数据目录、之后记住上次选中目录。跑的是真实 `main.dialogs.js`（只把 electron 换成替身） |
| [`slug-scope-probe.cjs`](../../../testjs/probe/slug-scope-probe.cjs) | 跨库状态分桶接线回归（「裸 id / 全局攒批」类 bug）：① `scanWorker.js` 转发 thumbs 必须带 `msg.slug`（协议本来就有，根因就是这一行丢了）；② `album.js` 的 `pendingInChild`、`worker.scan.js` 的 `thumbReport` 必须走 `utils/slugScopes.js`；③ 回报只删该库、配额用各桶之和、flush 只发自己库；④ 异常/lock/shutdown 三处 `flushAll`、登出 `clearAllForSlug` + `forgetAlbum`；⑤ `safeSlug` 与 `albumThumbs.js` 同口径；⑥ 同类裸 id 状态清单防新增漏网。`--self-test` 把新写法逐条改回旧写法，11 条变异都被精确抓到 |
| [`lifecycle-dispose-probe.cjs`](../../../testjs/probe/lifecycle-dispose-probe.cjs) | 「资源随作用域释放」回归（定时器/监听器/AbortController 与销毁处不相邻 → 漏一处永久泄漏）：① 底座存在且导出 `createDisposables`/`useDisposables`，不得使用组件实例代理；② 搜索弹窗的防抖与在途请求随关闭/卸载撤掉；③ 便签窗口的拖拽监听器与截屏/保存异步链有卸载守卫；④ 迁移窗的完成定时器、桌面挂件的监听器都走底座且**不得有匿名监听器**（结构上无法移除）；⑤ 行定位宿主走 `createRowFocusHost`（11 个页面全覆盖）、重试链可取消；⑥ 用户作用域：信道会话与网格预览学生名映射都登记了用户级清理。判据已做反向验证：9 处变异（退回裸 setTimeout / 匿名监听器 / 取消登记 / 宿主退回字面量）全部被精确抓到 |
| [`ipc-guard-probe.cjs`](../../../testjs/probe/ipc-guard-probe.cjs) | IPC 授权拦截层：授权内角色放行、越权时 handler **根本不被调用**、表外通道拒绝、安装幂等（不套两层校验） |
| [`data-export-probe.cjs`](../../../testjs/probe/data-export-probe.cjs) | 设置页「数据管理」导出链路（自建临时明文库）：① 19 张表清单与行数；② **座位按网格导出**（行号 + 列/走廊交替 + 讲台行 `_isPodium`），不是「行/列/姓名」明细；③ 值日按天展开、多人顿号连接；④ **任何单元格都不得是裸 JSON**（逐格 `JSON.parse` 试探）；⑤ 结构化列展开后**不得残留英文键名**（`cells:` / `name:` 这类，正则按 `^|；、` 定位）—— 新增 JSON 列却没配 labels 时这条会直接抓到；⑥ `ai_settings.api_key` 必须打码；⑦ 收据列两种存量结构（纯路径 / `{path,name}`）都取文件名，不出 `[object Object]`；⑧ `includeReceipts: true` 时后端按库里的 `fee_records` 自己分组进包（老格式同样要进），不传就不带收据目录 |
| [`save-zip-probe.cjs`](../../../testjs/probe/save-zip-probe.cjs) | `save-file` 能不能落 `.zip`：替身 electron 跑真实 `main.dialogs.js` handler —— ① `.zip` 返回 `ok` 且内容按字节写入；② 对话框扩展名过滤器是 zip；③ 默认名 `.exe` 被拒；④ 用户在对话框里把路径改成 `.exe` 会被二次校验拦下且文件不落盘；⑤ 取消仍走 `canceled`（不是 `fail`）；⑥ **收据「另存」的类型（jpg / docx / mp4）必须能真的写盘** —— 白名单原本只有导出格式，收据传得上来却存不出去。变异（白名单删掉 `.jpg`）后 2 项精确 FAIL |
| [`upload-signature-probe.cjs`](../../../testjs/probe/upload-signature-probe.cjs) | 收据上传的类型校验：① 11 种真文件（jpg/png/webp/pdf/docx/xlsx/pptx/doc/mp4/webm/md）按标注类型通过；② exe 内容改名 `.pdf`、纯文本改名 `.docx`、RIFF 但不是 WEBP 的 `.webp`、**png 内容改名 `.md`（前 512 字节含 NUL）、空 `.md`** 全部被拒；③ `.exe` 不在白名单；④ 超过 30MB 被拒且提示带上限；⑤ **文件名解码**：latin1 乱码还原成中文、纯 ASCII 不受影响、正常中文不被二次转换打坏 |
| [`receipt-trash-probe.cjs`](../../../testjs/probe/receipt-trash-probe.cjs) | 收据回收站的路径边界（这是「能搬动磁盘文件」的入口，判据重点是删不到 uploads 之外）：① 正常移动 2 个文件并从 uploads 消失；② `../../secret.txt`、`/../secret.txt`、绝对路径、`..\..\` 四种穿越写法都移不动 uploads 外的诱饵文件；③ 不存在的文件跳过不报错；④ `null`/数字/对象等非法输入不抛错也不移动任何东西 |
| [`open-upload-probe.cjs`](../../../testjs/probe/open-upload-probe.cjs) | `open-upload-file` 通道边界（这条通道能让渲染层用系统程序打开文件，重点在边界而不是「能打开」）：① uploads 内的 pdf 能交给 `shell.openPath`；② `../../outside.pdf` 被拒（basename 压平后找不到）；③ `.exe` 被可执行黑名单拦下且**从未交给 shell.openPath**；④ 不存在的文件 fail；⑤ 缺参数 fail 而不抛异常；⑥ uploads 外的真实文件即使存在也打不开。变异（把 `.exe` 从黑名单删掉）后 2 项精确 FAIL |
| [`card-height-anim-probe.cjs`](../../../testjs/probe/card-height-anim-probe.cjs) | `composables/useCardHeightAnimation.js` 的**时序**（只测「高度变了」没意义，要测「中间有过渡帧」）：开真窗口跑最小 Vue 应用，切换内容后逐帧采样 `offsetHeight` —— ① 变高终点正确且**有 5 个以上不同中间高度**（瞬跳只会是 2 个）；② 过程不越过终点；③ 变矮同样平滑且回位；④ 不产生 `ResizeObserver loop` 告警。变异（让 `play()` 永不触发）后 2 项精确 FAIL。**必须 `show: true`**：隐藏窗口的合成器不跑，WAAPI 会瞬间跳到终点，第一版就是这么被假绿骗过的 |
| [`main-ipc-contract-probe.cjs`](../../../testjs/probe/main-ipc-contract-probe.cjs) | 主进程 IPC 结果契约（批 13 根因修复的静态护栏）：① 契约层三态互斥（`ok`/`fail`/`canceled` 不得同时成立）；② `save-file` / `screenshot-capture` / `note-save` 等 handler 必须走契约层，不得各写各的返回形态；③ **模块级可变状态必须有归属与必然终点**（穿透态挂窗口实例而非全局变量、选区会话带看门狗与窗口关闭兜底、导航等待带超时）；④ 前端 `saveFile.js` 必须把「失败」抛给调用方、「取消」安静吞掉。判据已做反向验证：抽掉任一守卫后探针精确报出该行 |
| [`export-format-probe.cjs`](../../../testjs/probe/export-format-probe.cjs) | 导出格式清单对账（批 13）：导出格式在**四处独立维护**（主进程 `ALLOWED_SAVE_EXTS` / 后端 `EXPORT_FORMATS` / 后端 schema enum / 前端 `FORMAT_OPTIONS` 与实际扩展名），任一处漏改就出现「前端能导出、主进程拒收」的静默失败。本探针四处互校：白名单 ⊇ 前端在用扩展名、白名单 ⊇ 后端枚举、后端枚举 ↔ schema 枚举双向一致、`FORMAT_OPTIONS` 每项都有实现分支，且白名单不得比已知能力更宽；⑦ **收据能上传的类型必须都在白名单里**（来源是后端 `uploadSignatures.js` 的 `KINDS`，收据另存的文件名是动态的、扫不出字面量） |
| [`ipc-policy-gen.mjs`](../../../testjs/probe/ipc-policy-gen.mjs) | IPC 授权表**生成器**：从渲染层静态 import 图推导「通道 → 允许的窗口角色」，输出 `electron/ipc-policy.json`。公共模块按「能 import 到它的入口集合」判角色；`OVERRIDE` 记人工覆盖（如 `set-db-encryption`：能力已备好、只差设置页入口） |
| [`measure-startup.mjs`](../../../testjs/probe/measure-startup.mjs) | 启动耗时；`--backend-only` / `--dev` / `--json` / `--runs` / `--exe`；数据隔离在 `%LOCALAPPDATA%\ClassNestStartupMeasure` |
| [`longframe-probe.mjs`](../../../testjs/probe/longframe-probe.mjs) | 长帧定位（主线程阻塞点） |
| [`inp-probe.mjs`](../../../testjs/probe/inp-probe.mjs) | 交互延迟（INP）：自动起 Vite + 带调试口的 Electron，CDP 派发真实输入（`npm run inp`） |
| [`inp-compare.mjs`](../../../testjs/probe/inp-compare.mjs) | 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor） |
| [`bundle-diff.mjs`](../../../testjs/probe/bundle-diff.mjs) | 构建产物体积差异 |
| [`refresh-warm-check.cjs`](../../../testjs/probe/refresh-warm-check.cjs) | 刷新/预热后的缓存命中 |
| [`etag-revalidate-probe.cjs`](../../../testjs/probe/etag-revalidate-probe.cjs) | ETag 重新校验行为 |

### 渲染与绘制

| 脚本 | 用途 |
| --- | --- |
| [`gdi-shot-bench.cjs`](../../../testjs/probe/gdi-shot-bench.cjs) | GDI 截图性能基准 |
| [`screenshot-bench.cjs`](../../../testjs/probe/screenshot-bench.cjs) | 应用内截图性能基准 |
| [`glyph-render-check.mjs`](../../../testjs/probe/glyph-render-check.mjs) | 图标字形渲染核对 |
| [`night-btn-hover-probe.cjs`](../../../testjs/probe/night-btn-hover-probe.cjs) | 夜间主题按钮悬停配色 |
| [`toplevel-bottom-probe.cjs`](../../../testjs/probe/toplevel-bottom-probe.cjs) | 「顶层置底」最小原型（顶层窗口 + 透明圆角 + 拖动 + z 序自检，无业务代码） |

### 相册与查看器

| 脚本                                                                                             | 用途                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------- |
| [`viewer-open-probe.cjs`](../../../testjs/probe/viewer-open-probe.cjs)                         | 照片查看器打开耗时                        |
| [`viewer-load-probe.cjs`](../../../testjs/probe/viewer-load-probe.cjs)                         | 查看器图片加载                          |
| [`viewer-anim-probe.cjs`](../../../testjs/probe/viewer-anim-probe.cjs)                         | 查看器切换动画                          |
| [`pdf-leak-probe.mjs`](../../../testjs/probe/pdf-leak-probe.mjs)                               | PDF 导出内存泄漏（看 V8 external，不看 rss） |
| [`keepalive-album-probe.cjs`](../../../testjs/probe/keepalive-album-probe.cjs)                 | KeepAlive 下相册页状态恢复               |
| [`keepalive-restore-probe.cjs`](../../../testjs/probe/keepalive-restore-probe.cjs)             | KeepAlive 通用恢复                   |
| [`keepalive-table-restore-probe.cjs`](../../../testjs/probe/keepalive-table-restore-probe.cjs) | KeepAlive 表格页滚动/编辑态恢复            |

### 表格与拖拽

| 脚本 | 用途 |
| --- | --- |
| [`grid-row-drag-probe.cjs`](../../../testjs/probe/grid-row-drag-probe.cjs) | 网格行拖拽让位 |
| [`inject-drag.ps1`](../../../testjs/probe/inject-drag.ps1) | `SetCursorPos` + `mouse_event` 合成一次真实左键拖动（配合其它探针） |

### 接口与数据源

| 脚本 | 用途 |
| --- | --- |
| [`search-sources-probe.cjs`](../../../testjs/probe/search-sources-probe.cjs) | 全局搜索（`GET /api/search`）各数据源能否命中、排序/多词/字段限定/`focus` 串是否正确；内存库 + `require.cache` 替换 `../db`，22 条断言，失败退出码 1。无需桌面、毫秒级 |
| [`search-bench.cjs`](../../../testjs/probe/search-bench.cjs) | 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照旧实现「拉 1000 行 + 逐格拼音」的成本；`--runs=N` 控制轮次，不做门限判定 |
| [`db-size-probe.cjs`](../../../testjs/probe/db-size-probe.cjs) | 库体积 / freelist / WAL 只读探针（v6 · 0-4）：明文库读 `page_size` / `page_count` / `freelist_count` 并算 `freelistRatio`；加密库只报文件与 `-wal` / `-shm` 体积并标 `encrypted`，不硬解密钥。`--json` 出机器可读结果，`--selftest` 造「删了大量行的明文库 + 随机字节库」自证两类判定 |
| [`storage-size-probe.cjs`](../../../testjs/probe/storage-size-probe.cjs) | 目录 / 日志体积只读探针（v6 · 0-5）：统计 `uploads` / `album-trash` / `receipt-trash` / `album-thumbs` / `snapshots` / `ai-memory` / `ai-skills` / `ffmpeg` 与四个日志出口的字节数与文件数，给回收站保留期与日志轮转提供基线；`--json` / `--selftest` |
| [`pkg-size-probe.cjs`](../../../testjs/probe/pkg-size-probe.cjs) | 打包体积构成 + 生产依赖存在性（v6 · 1-12）：把 `release*/win-unpacked` 按 `app.asar` / 根依赖 / 后端依赖 / `locales` / 根目录二进制分桶并按体积降序列出，单独列出 `ffmpeg.exe` 与字体等大文件；同时对 `package.json` 的每个 `dependencies` 做 `require.resolve` 核对（漏装会在打包后表现为启动即崩）。`--dir=` 指定产物、`--json` 出机器可读结果、`--selftest` 自证分桶与格式化 |
| [`table-service-probe.cjs`](../../../testjs/probe/table-service-probe.cjs) | 动态表服务的三条数据契约：删字段后加回同名列能找回旧值、导入行显式写 `position`（否则 NULL 排到表头）、导入的建列与插行同事务回滚；8 条断言，失败退出码 1 |
| [`data-write-guards-probe.cjs`](../../../testjs/probe/data-write-guards-probe.cjs) | 写入守卫：小组件设置补丁式更新、请假只改结束时间仍校验窗口、跨职务移动守 `max_count`、宿舍组数量不变不清空分配、值日 `items` 分键播种；15 条断言，失败退出码 1 |

### Vapor

| 脚本 | 用途 |
| --- | --- |
| [`vapor-verify.mjs`](../../../testjs/probe/vapor-verify.mjs) | 校验产物里 `__vapor: true`（拼错标记只会静默失效） |
| [`vapor-bench.mjs`](../../../testjs/probe/vapor-bench.mjs) | Vapor 通道基准 |
| [`vapor-audit.mjs`](../../../testjs/probe/vapor-audit.mjs) | 组件 Vapor 迁移审计 |

### 其他

| 脚本 | 用途 |
| --- | --- |
| [`mode-probe.mjs`](../../../testjs/probe/mode-probe.mjs) | 日/夜模式切换开销 |
| [`ocr-probe.mjs`](../../../testjs/probe/ocr-probe.mjs) | OCR 可用性（仅 Windows） |
| [`write-only-ref-probe.cjs`](../../../testjs/probe/write-only-ref-probe.cjs) | **「只写不读」的响应式变量**：ESLint 的 `no-unused-vars` 只抓「从未被引用」，而 `result.value = x` 这种赋值算引用 —— 于是「存了但永远没人读」的 ref 一路活下来（`RollCall.vue` 的 `result` 存了三次、一次没读）。判据分两层：`<script>` 内的出现（排除赋值左边）+ `<template>` 的**表达式**（只认 `{{ }}` 和 `:x=` / `v-x=` / `@x=` / `#x=` 的值）。⚠️ 两个坑都踩过：①把定义处那个名字当读取（`m.index === defIndex` 拿 `const` 的位置比名字的位置，永不相等 → 假阴性）；②`class="result-card"` 里的子串被当读取（→ 必须把 class/style 排除在模板判据外）。`--file=` 扫单文件，`--json` 出机器可读结果 | `node testjs/probe/write-only-ref-probe.cjs`；退出码 0 = 全仓没有只写不读 |
| [`widget-shot.ps1`](../../../testjs/probe/widget-shot.ps1) | 把组件窗口临时提到最前截图（`-Out` 指定路径，截完压回） |
| [`widget-bottom-regression.ps1`](../../../testjs/probe/widget-bottom-regression.ps1) | 置底回归：`-Drags N` 次合成拖动，校验位移正确、尺寸不变、松手仍在 `Progman` 之上、无 `Application Error` |
| [`ipc-usage-probe.cjs`](../../../testjs/probe/ipc-usage-probe.cjs) | **「通道有登记、但没人调用」的真实清单**。审查 v4 · C01-08 报「6 条死通道」，实际只有 1 条真没调用方，其余早删干净或是「能力已备好、入口未接」的有意保留。误判根源是判据太糙：**通道名在任意文件里出现过就算有人用**，而 `student-frontend/src/electronChannels.js` 本身就是从 `ipc-channels.json` 生成常量表的，于是「出现在常量表里」被当成了「有人在调用」。本探针按**调用点**判：`INVOKE.KEY` / `SEND.KEY` / `RECEIVE.KEY`（KEY 推导规则与 `electronChannels.js` 一致），或直接写字符串的调用，并排除常量表自身。⚠️ 还必须把 `electron/main/main.dev-loader.js` 算进渲染层范围 —— 它住在 `electron/` 下，但是**注入到页面**的脚本（`boot-status` 就是它调用的），漏了就会误报。有意保留的通道写在文件顶部的 `KEEP` 里并要求写明理由 | `node testjs/probe/ipc-usage-probe.cjs`；退出码 0 = 没有未登记的无人调用通道 |
| [`_sample-big.cjs`](../../../testjs/probe/_sample-big.cjs) | 大样张数据生成（供相册/表格探针复用） |
| [`pages/secure-channel-retry.html`](../../../testjs/probe/pages/secure-channel-retry.html) | **断言页**（不是独立探针）：用假的 axios 驱动 `secureAxios` 的 401 处理分支，逐条验证「会话过期 / 凭据降级 / 绑定失效会重建会话并重发」。这类页要跑 Vite 转译的 ESM、要用 `crypto.subtle`，纯 Node 跑不了 → 由 `smoke/secure-channel-retry.js` 起真实 Electron 渲染进程驱动（经 `tools/electron-page-probe.cjs`），页面在 Vite root 之外，靠 `server.fs.allow` 用 `/@fs/<绝对路径>` 访问。**别再放前端源码目录**：放那儿一旦被重构顺手删掉，冒烟只会报「探针页没跑起来？」，看着像环境问题 |

> 已删除的 `pipe-*` 评估脚本：命名管道 + ACL 方案实测收益约 1ms，且 axios fetch adapter 对 204 误判导致页面闪跳，已全量回退；结论见 `doc/开发文档/通信层方案评估-命名管道与ACL.md`（不入库）。

---

## 注意事项

- **参数以脚本头部为准**：本页用途摘要来自脚本名与 `testjs/README.md`，运行前先读各脚本文件头注释，别照抄本页猜参数。
- **不要进冒烟 / CI**：探针需要真实桌面、真实应用与较长耗时，只做一次性测量；判据类检查放 [smoke.md](./smoke.md)。
  - 例外说明：`search-sources-probe.cjs` 不依赖桌面、跑得也快，但它的验证对象是一次真实路由调用，按 [units.md](./units.md) 的分层规则（该层不覆盖 HTTP 路由）仍归在探针层手动运行。
- **桌面窗口类探针会动真实窗口**：`widget-bottom-regression.ps1`（置底回归探针）会合成真实拖动、`widget-shot.ps1`（组件截图探针）会把组件临时提到最前截图；运行前先收好正在使用的窗口，避免误操作。

---
