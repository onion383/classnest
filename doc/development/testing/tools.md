# 工具脚本（`testjs/tools/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── tools/
        ├── album-sql-args.js  # 相册 SQL 参数构造核对
        ├── audit-coverage.mjs  # 覆盖矩阵生成器：按「入口 × 不变量」扫描守卫证据，输出 PASS / GAP / UNKN…
        ├── bundle-diff.mjs  # 构建产物体积差异
        ├── closeServer.cjs  # 关闭 HTTP server 并等它真正收尾：server.close() 只是「不再接受新…
        ├── code_stats.ps1  # 代码与文档量统计（生成 ；文档统计 doc/ + 仓库根目录 Markdown，根目录不含 …
        ├── comment-audit.js  # 注释保真审计：比对拆分前后注释，只读不改
        ├── component-vapor-audit.mjs  # 组件 Vapor 标记审计
        ├── dev-update-mock.cjs  # 本地 mock Release + 开发版班集，一条命令触发更新流程
        ├── doc-trees.mjs  # 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树
        ├── docs-counts.mjs  # 数量类计数的唯一来源：组件 / 组合式函数 / utils / 主进程文件 / 依赖 / 页…
        ├── docs-sync.mjs  # 按源码现算值改写文档里的数量类计数：只替换捕获到的数字、不动叙述；找不到计数位置时退出码 1…
        ├── docs-verify.mjs  # 文档一致性校验：死链、源码覆盖（含构建配置与安装器素材）、路由、依赖版本/许可、关键计数、M…
        ├── electron-page-probe.cjs  # 用 Electron 打开指定页面并跑探针（供 secure-channel-retry 等…
        ├── error-boundary-check.cjs  # 错误边界检查
        ├── gdi-shot-bench.cjs  # GDI 截图性能基准
        ├── gen-channels.mjs  # 由 electron/ipc-channels.json 生成 electron/main/…
        ├── gen-icon-shapes.mjs  # 生成图标形状数据（IconGlyph.shapes.js）
        ├── inp-compare.mjs  # 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor）
        ├── killTree.cjs  # 结束子进程及其后代（跨平台）：child.kill() 只杀直接子进程，而 Electron…
        ├── measure-startup.mjs  # 启动耗时；--backend-only / --dev / --json / --runs …
        ├── mock-update-server.cjs  # 本地模拟 GitHub Releases 与假安装包（仅回环，dev 专用）
        ├── mutate-sweep-b19.cjs  # 批 19 的反向验证（变异测试）：17 处变异逐个改坏被守行为，验证 的判据真能抓到回归。⚠…
        ├── mutate-sweep.cjs  # 反向验证（变异测试）：逐个把源码里的「被守行为」改坏，跑单测，确认单测变红。用来证明判据真的…
        ├── orphan-check.cjs  # 只读孤儿检查：score_records / leave_records / cadre_m…
        ├── ownedChild.cjs  # 自有子进程登记：探针启动的 Electron / Vite 在成功、异常、Ctrl+C 各路…
        ├── radius-audit.js  # 圆角使用审计（主题一致性）
        ├── schema-drift-check.cjs  # 结构清单与建库结果对账，有差异退出码 1。迁移体系的体检，不在 CI 里（清单过期时应当重生…
        ├── schema-snapshot-gen.cjs  # 从空库跑一遍真实建表，重新生成 student-backend/migrations/sna…
        ├── screenshot-bench.cjs  # 应用内截图性能基准
        ├── search-bench.cjs  # 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照…
        ├── seed-test-data.js  # 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」）
        ├── template-binding-audit.mjs  # 模板绑定审计（未定义变量/悬空 ref）
        ├── vapor-audit.mjs  # 组件 Vapor 迁移审计
        ├── vapor-bench.mjs  # Vapor 通道基准
        ├── vapor-verify.mjs  # 校验产物里 __vapor: true（拼错标记只会静默失效）
        ├── verify-batch.mjs  # 一把跑批验证：把 6 项验证（单元测试 / 模式扫描探针 / ESLint / 文档一致性 …
        └── waitFor.cjs  # 轮询等待，替代「死等 N 秒」：await new Promise((r) => setTi…
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：辅助脚本层（`testjs/tools/`），22 个长期复用的脚本，负责数据准备、审计、文档一致性校验与统计生成；**不属于测试判定**。
- **公共逻辑**：多数只读或幂等（重复执行结果不变），可反复执行；统计与校验类产出报告（如 [code-stats.md](../code-stats.md)（代码与文档统计报告）），由脚本生成、不手工维护。
- **局限**：没有通过 / 失败判定，可信范围见 [testing/README.md](./README.md)；具体参数以各脚本文件头注释为准。

---

## 详细说明

| 脚本 | 用途 | 用法 / 前置 |
| --- | --- | --- |
| [`verify-batch.mjs`](../../../testjs/tools/verify-batch.mjs) | **一把跑批验证**：把 6 项验证（单元测试 / 模式扫描探针 / ESLint / 文档一致性 / 冒烟 / 前端构建）串成一次调用。任一环节失败**继续跑完其余环节**（一次看全问题），末尾出汇总表。⚠️ 冒烟里 `secure-channel-retry` 需要 Vite 在 `38140` 端口（没起会自动跳过那一项，不算失败） | `node testjs/tools/verify-batch.mjs`；`--fast` 跳过冒烟与构建；`--only=units,lint` 只跑指定项；`--skip=docs` 跳过指定项 |
| [`mutate-sweep-b19.cjs`](../../../testjs/tools/mutate-sweep-b19.cjs) | **批 19 的反向验证（变异测试）**：17 处变异逐个改坏被守行为，验证 [`sweep-fixes-b19.test.js`](./units.md) 的判据真能抓到回归。⚠️ 锚点自动适配 CRLF 行尾；`M7` 的锚点必须把 `waitQuiet` **之后**那句 `dirty = false` 一起纳入替换范围 —— 只往前加一行会让两个 `dirty = false` 互相抵消，成为**等价变异**（行为没变 → 误报「判据太松」） | `node testjs/tools/mutate-sweep-b19.cjs`；退出码 0 = 17 处全抓到 |
| [`mutate-sweep.cjs`](../../../testjs/tools/mutate-sweep.cjs) | **反向验证（变异测试）**：逐个把源码里的「被守行为」改坏，跑单测，确认单测变红。用来证明判据**真的能抓到回归**，而不是假绿。⚠️ 还原挂在 `process.on('exit')` 上（只靠循环末尾还原，中途异常退出就把坏代码留在工作区）；锚点自动适配 CRLF 行尾 | `node testjs/tools/mutate-sweep.cjs`；退出码 0 = 全部变异都被抓到 |
| [`seed-test-data.js`](../../../testjs/tools/seed-test-data.js) | 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」） | `npm run seed`；`SEED_BASE` / `SEED_USER` / `SEED_PASSWORD` 可覆盖；**需后端在跑** |
| [`killTree.cjs`](../../../testjs/tools/killTree.cjs) | **结束子进程及其后代**（跨平台）：`child.kill()` 只杀直接子进程，而 Electron / dev-vite 都会再起孙进程（渲染进程 / vite 子进程）→ 只 kill 直接子进程会**残留**它们 → 端口被占（下次跑报 EADDRINUSE）+ 进程泄漏。Windows 走 `taskkill /T /F`，POSIX 走进程组 kill | `const { killTree } = require('./killTree.cjs'); killTree(child)`；**永不抛异常**（清理路径上抛异常会掩盖真正的错误） |
| [`closeServer.cjs`](../../../testjs/tools/closeServer.cjs) | **关闭 HTTP server 并等它真正收尾**：`server.close()` 只是「不再接受新连接」，已有的 keep-alive 连接还挂着 → Node 事件循环仍有活 handle → 脚本**永不退出**（在那里空等，不产出任何输出）。做法=先 `closeAllConnections()`（Node 18.2+）再 `close(cb)`，带超时兜底 | `await closeServer(server)`；与 `testjs/smoke/api-routes-test.cjs` 里已验证的实现一致，抽成共用工具 |
| [`waitFor.cjs`](../../../testjs/tools/waitFor.cjs) | **轮询等待，替代「死等 N 秒」**：`await new Promise((r) => setTimeout(r, 3000))` 在快机器上白等、慢机器上还没就绪就往下走（flaky）。`waitFor(pred)` 等到条件成立；`waitForStable(fn)` 等到取值连续多次不变，用于「等动画结束 / 等任务收尾」这类没有结束信号的场景。探针与冒烟里由模式扫描 `fixed-wait` 守着 | `const { waitFor, waitForStable } = require('../tools/waitFor.cjs')`；两个函数**都不抛异常**（探测条件本身抛错=还没就绪），超时返回 `false` 由调用方决定 |
| [`docs-verify.mjs`](../../../testjs/tools/docs-verify.mjs) | 文档一致性校验：死链、源码覆盖（含构建配置与安装器素材）、路由、依赖版本/许可、关键计数、Mermaid、用户手册索引与结构、工具/测试脚本覆盖、doc-tree 结构、禁用词、英文标识配中文、字段标签加粗、模块与文末分隔线（只读，失败退出码 1） | `npm run docs:verify`（`--json` 输出机器可读结果） |
| [`docs-counts.mjs`](../../../testjs/tools/docs-counts.mjs) | **数量类计数的唯一来源**：组件 / 组合式函数 / utils / 主进程文件 / 依赖 / 页面 / 导出表 / 单元测试文件 / 后端路由，共 9 项，全部从源码现算。`docs-verify` 只负责「比」，`docs-sync` 只负责「写」，两边共用这一张表 —— 避免「校验通过、文档还是旧数」的假绿 | `countExpectations(routeCount)`、`replaceCount(text, re, actual)` |
| [`docs-sync.mjs`](../../../testjs/tools/docs-sync.mjs) | 按源码现算值改写文档里的数量类计数：只替换捕获到的数字、不动叙述；找不到计数位置时退出码 1（说明文档结构变了，要人工处理）。改完仍要跑 `docs:verify` 做全量对账（死链 / 覆盖 / 路由 / 格式） | `npm run docs:sync`；`--dry` 只预览 |
| [`gen-channels.mjs`](../../../testjs/tools/gen-channels.mjs) | 由 `electron/ipc-channels.json` 生成 `electron/main/channels.js`：通道常量只有 JSON 一份来源，主进程与 preload 各写一份字符串迟早漂移；生成物入库，改了 JSON 必须重新生成 | `npm run channels:gen`；`--check` 只校验与 JSON 同源（漂移退出码 1） |
| [`orphan-check.cjs`](../../../testjs/tools/orphan-check.cjs) | **只读孤儿检查**：`score_records` / `leave_records` / `cadre_members` 的 `student_id`、`group_members` 的姓名、`duty_slots.cells` 与 `seat_slots.seats` 的整块 JSON 是否存在悬空引用；带 `--selftest`（内存库种 6 条已知孤儿并断言全部报出）。⚠️ 刻意关闭 `foreign_keys`，模拟的是「加外键约束之前的老库」 | `node testjs/tools/orphan-check.cjs [库路径]`；`--selftest` |
| [`test-impact.cjs`](../../../testjs/tools/test-impact.cjs) | **按改动选单测**：读 `git diff`（含未跟踪文件）+ 测试里的源码路径字面量 / 头部 `WATCH:` 声明，只跑命中的 units 文件。零命中时提示跑全量，不把「选择器漏了」当成「改动安全」。用来替代「改一行跑 337 文件」 | `node testjs/tools/test-impact.cjs [--since=REF] [--path=a.js,b.js] [--run] [--json] [--all]` |
| [`_source-scan.cjs`](../../../testjs/_source-scan.cjs) | 测试用 AST 解析（`@babel/parser`，从前端 node_modules 解析）：`analyze()` 出注释/字符串屏蔽视图、`functionEntries()` / `findFunction()` 取函数节点、`scriptBlocks()` 取 SFC 脚本。替代「正则 + 固定字符窗口」，不受空格/缩进/换行影响 | `require('../_source-scan.cjs')` |
| [`_mechanism.cjs`](../../../testjs/units/_mechanism.cjs) | **「固定机制」测试底座**：用 `_source-scan` 从产品代码抽声明式配置（正则 / 判定函数 / cors 选项对象），喂给产品自己的依赖跑真请求，断言行为而非源码文本。`extractAppCors()` / `startCorsProbe()`；新增机制测试优先复用它 | `require('./_mechanism.cjs')` |
| [`code_stats.ps1`](../../../testjs/tools/code_stats.ps1) | 代码与文档量统计（生成 [code-stats.md](../code-stats.md)；文档统计 `doc/` + 仓库根目录 Markdown，根目录不含 `LICENSE.md`） | PowerShell 执行 |
| [`doc-trees.mjs`](../../../testjs/tools/doc-trees.mjs) | 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树 | `node testjs/tools/doc-trees.mjs`（`--dry-run` 只预览） |
| [`error-boundary-check.cjs`](../../../testjs/tools/error-boundary-check.cjs) | 错误边界检查 | `npm run check:boundaries`（`--strict` 更严格） |
| [`mock-update-server.cjs`](../../../testjs/tools/mock-update-server.cjs) | 本地 mock GitHub Releases：返回假 release JSON（正式包 + 预览包干扰项）与文本占位假包；只监听回环，打包环境不读 mock 配置 | `npm run dev:update-mock`；`--no-digest` / `--no-update` 切场景 |
| [`dev-update-mock.cjs`](../../../testjs/tools/dev-update-mock.cjs) | 一条命令启动 mock + 开发版班集；`--electron-only` 供 Vite 已在跑的场景 | `npm run dev:update-mock`；进「关于软件 → 版本更新」触发 |
| [`comment-audit.js`](../../../testjs/tools/comment-audit.js) | 注释保真审计：比对拆分前后注释，只读不改 | `AUDIT_BASE=<git ref>` |
| [`radius-audit.js`](../../../testjs/tools/radius-audit.js) | 圆角使用审计（主题一致性） | 直接运行 |
| [`component-vapor-audit.mjs`](../../../testjs/tools/component-vapor-audit.mjs) | 组件 Vapor 标记审计 | 直接运行 |
| [`template-binding-audit.mjs`](../../../testjs/tools/template-binding-audit.mjs) | 模板绑定审计（未定义变量/悬空 ref） | 直接运行 |
| [`gen-icon-shapes.mjs`](../../../testjs/tools/gen-icon-shapes.mjs) | 生成图标形状数据（`IconGlyph.shapes.js`） | 直接运行 |
| [`album-sql-args.js`](../../../testjs/tools/album-sql-args.js) | 相册 SQL 参数构造核对 | 直接运行 |
| [`electron-page-probe.cjs`](../../../testjs/tools/electron-page-probe.cjs) | 用 Electron 打开指定页面并跑探针（供 secure-channel-retry 等复用） | 需 Vite 开发服务器 |
| [`schema-snapshot-gen.cjs`](../../../testjs/tools/schema-snapshot-gen.cjs) | 从空库跑一遍真实建表，重新生成 `student-backend/migrations/snapshot.js`（结构清单）；改了 `schema/` 之后必跑 | 直接运行 |
| [`schema-drift-check.cjs`](../../../testjs/tools/schema-drift-check.cjs) | 结构清单与建库结果对账，有差异退出码 1。迁移体系的体检，**不在 CI 里**（清单过期时应当重生成，而不是为了变绿改断言） | 直接运行 |
| [`audit-coverage.mjs`](../../../testjs/tools/audit-coverage.mjs) | **覆盖矩阵生成器**：按「入口 × 不变量」扫描守卫证据，输出 PASS / GAP / UNKNOWN；GAP 与 UNKNOWN 都返回非零，避免「报告写完就算覆盖」 | `node testjs/tools/audit-coverage.mjs`；`--report-only` 只出报告；`--out-dir=` / `--date=` 指定产物位置与日期 |
| [`ownedChild.cjs`](../../../testjs/tools/ownedChild.cjs) | **自有子进程登记**：探针启动的 Electron / Vite 在成功、异常、Ctrl+C 各路径都能幂等清理；复用的外部实例不登记、不误杀 | `const owned = createOwnedChild({ killTree, label })`；`owned.adopt(child)` |
| [`gdi-shot-bench.cjs`](../../../testjs/tools/gdi-shot-bench.cjs) | GDI 截图性能基准 | 直接运行 |
| [`measure-startup.mjs`](../../../testjs/tools/measure-startup.mjs) | 启动耗时；`--backend-only` / `--dev` / `--json` / `--runs` / `--exe`；数据隔离在 `%LOCALAPPDATA%\ClassNestStartupMeasure` | 直接运行 |
| [`vapor-bench.mjs`](../../../testjs/tools/vapor-bench.mjs) | Vapor 通道基准 | 直接运行 |
| [`bundle-diff.mjs`](../../../testjs/tools/bundle-diff.mjs) | 构建产物体积差异 | 直接运行 |
| [`inp-compare.mjs`](../../../testjs/tools/inp-compare.mjs) | 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor） | 直接运行 |
| [`search-bench.cjs`](../../../testjs/tools/search-bench.cjs) | 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照旧实现「拉 1000 行 + 逐格拼音」的成本；`--runs=N` 控制轮次，不做门限判定 | 直接运行 |
| [`screenshot-bench.cjs`](../../../testjs/tools/screenshot-bench.cjs) | 应用内截图性能基准 | 直接运行 |
| [`vapor-audit.mjs`](../../../testjs/tools/vapor-audit.mjs) | 组件 Vapor 迁移审计 | 直接运行 |
| [`vapor-verify.mjs`](../../../testjs/tools/vapor-verify.mjs) | 校验产物里 `__vapor: true`（拼错标记只会静默失效） | 直接运行 |

---

## 注意事项

- **会写真数据的只有 `seed-test-data.js`（灌测试数据的脚本）**：它按业务键幂等去重，但确实写入 `DATA_DIR`（数据目录），必须后端在跑；`SEED_BASE`（目标后端地址）/ `SEED_USER`（账号）/ `SEED_PASSWORD`（密码）可改目标。
- **`docs-verify`（文档一致性校验脚本）只证文档一致**：只读、失败退出码 1，检查死链 / 源码覆盖 / 路由校验 / 依赖 / 计数，不代表代码行为正确。
- **`code-stats.md`（代码与文档统计报告）是生成物**：数字与汇总表由 `code_stats.ps1`（统计脚本）产出，不要手改；需要更新就重跑脚本（报告自身按两遍法计入文档统计）。

---
