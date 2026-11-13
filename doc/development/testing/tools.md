# 工具脚本（`testjs/tools/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── tools/
        ├── album-sql-args.js  # 相册 SQL 参数构造核对
        ├── closeServer.cjs  # 关闭 HTTP server 并等它真正收尾：server.close() 只是「不再接受新…
        ├── code_stats.ps1  # 代码与文档量统计（生成 ；文档统计 doc/ + 仓库根目录 Markdown，根目录不含 …
        ├── comment-audit.js  # 注释保真审计：比对拆分前后注释，只读不改
        ├── component-vapor-audit.mjs  # 组件 Vapor 标记审计
        ├── doc-trees.mjs  # 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树
        ├── docs-counts.mjs  # 数量类计数的唯一来源：组件 / 组合式函数 / utils / 主进程文件 / 依赖 / 页…
        ├── docs-sync.mjs  # 按源码现算值改写文档里的数量类计数：只替换捕获到的数字、不动叙述；找不到计数位置时退出码 1…
        ├── docs-verify.mjs  # 文档一致性校验：死链、源码覆盖（含构建配置与安装器素材）、路由、依赖版本/许可、关键计数、M…
        ├── electron-page-probe.cjs  # 用 Electron 打开指定页面并跑探针（供 secure-channel-retry 等…
        ├── error-boundary-check.cjs  # 错误边界检查
        ├── gen-icon-shapes.mjs  # 生成图标形状数据（IconGlyph.shapes.js）
        ├── killTree.cjs  # 结束子进程及其后代（跨平台）：child.kill() 只杀直接子进程，而 Electron…
        ├── mutate-sweep-b19.cjs  # 批 19 的反向验证（变异测试）：17 处变异逐个改坏被守行为，验证 的判据真能抓到回归。⚠…
        ├── mutate-sweep.cjs  # 反向验证（变异测试）：逐个把源码里的「被守行为」改坏，跑单测，确认单测变红。用来证明判据真的…
        ├── orphan-check.cjs  # 只读孤儿检查：score_records / leave_records / cadre_m…
        ├── radius-audit.js  # 圆角使用审计（主题一致性）
        ├── seed-test-data.js  # 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」）
        ├── template-binding-audit.mjs  # 模板绑定审计（未定义变量/悬空 ref）
        └── verify-batch.mjs  # 一把跑批验证：把 6 项验证（单元测试 / 模式扫描探针 / ESLint / 文档一致性 …
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
| [`verify-batch.mjs`](../../../testjs/tools/verify-batch.mjs) | **一把跑批验证**：把 6 项验证（单元测试 / 模式扫描探针 / ESLint / 文档一致性 / 冒烟 / 前端构建）串成一次调用。任一环节失败**继续跑完其余环节**（一次看全问题），末尾出汇总表。⚠️ 冒烟里 `secure-channel-retry` 需要 Vite 在 5173 端口（没起会自动跳过那一项，不算失败） | `node testjs/tools/verify-batch.mjs`；`--fast` 跳过冒烟与构建；`--only=units,lint` 只跑指定项；`--skip=docs` 跳过指定项 |
| [`mutate-sweep-b19.cjs`](../../../testjs/tools/mutate-sweep-b19.cjs) | **批 19 的反向验证（变异测试）**：17 处变异逐个改坏被守行为，验证 [`sweep-fixes-b19.test.js`](./units.md) 的判据真能抓到回归。⚠️ 锚点自动适配 CRLF 行尾；`M7` 的锚点必须把 `waitQuiet` **之后**那句 `dirty = false` 一起纳入替换范围 —— 只往前加一行会让两个 `dirty = false` 互相抵消，成为**等价变异**（行为没变 → 误报「判据太松」） | `node testjs/tools/mutate-sweep-b19.cjs`；退出码 0 = 17 处全抓到 |
| [`mutate-sweep.cjs`](../../../testjs/tools/mutate-sweep.cjs) | **反向验证（变异测试）**：逐个把源码里的「被守行为」改坏，跑单测，确认单测变红。用来证明判据**真的能抓到回归**，而不是假绿。⚠️ 还原挂在 `process.on('exit')` 上（只靠循环末尾还原，中途异常退出就把坏代码留在工作区）；锚点自动适配 CRLF 行尾 | `node testjs/tools/mutate-sweep.cjs`；退出码 0 = 全部变异都被抓到 |
| [`seed-test-data.js`](../../../testjs/tools/seed-test-data.js) | 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」） | `npm run seed`；`SEED_BASE` / `SEED_USER` / `SEED_PASSWORD` 可覆盖；**需后端在跑** |
| [`killTree.cjs`](../../../testjs/tools/killTree.cjs) | **结束子进程及其后代**（跨平台）：`child.kill()` 只杀直接子进程，而 Electron / dev-vite 都会再起孙进程（渲染进程 / vite 子进程）→ 只 kill 直接子进程会**残留**它们 → 端口被占（下次跑报 EADDRINUSE）+ 进程泄漏。Windows 走 `taskkill /T /F`，POSIX 走进程组 kill | `const { killTree } = require('./killTree.cjs'); killTree(child)`；**永不抛异常**（清理路径上抛异常会掩盖真正的错误） |
| [`closeServer.cjs`](../../../testjs/tools/closeServer.cjs) | **关闭 HTTP server 并等它真正收尾**：`server.close()` 只是「不再接受新连接」，已有的 keep-alive 连接还挂着 → Node 事件循环仍有活 handle → 脚本**永不退出**（在那里空等，不产出任何输出）。做法=先 `closeAllConnections()`（Node 18.2+）再 `close(cb)`，带超时兜底 | `await closeServer(server)`；与 `testjs/smoke/api-routes-test.cjs` 里已验证的实现一致，抽成共用工具 |
| [`docs-verify.mjs`](../../../testjs/tools/docs-verify.mjs) | 文档一致性校验：死链、源码覆盖（含构建配置与安装器素材）、路由、依赖版本/许可、关键计数、Mermaid、用户手册索引与结构、工具/测试脚本覆盖、doc-tree 结构、禁用词、英文标识配中文、字段标签加粗、模块与文末分隔线（只读，失败退出码 1） | `npm run docs:verify`（`--json` 输出机器可读结果） |
| [`docs-counts.mjs`](../../../testjs/tools/docs-counts.mjs) | **数量类计数的唯一来源**：组件 / 组合式函数 / utils / 主进程文件 / 依赖 / 页面 / 导出表 / 单元测试文件 / 后端路由，共 9 项，全部从源码现算。`docs-verify` 只负责「比」，`docs-sync` 只负责「写」，两边共用这一张表 —— 避免「校验通过、文档还是旧数」的假绿 | `countExpectations(routeCount)`、`replaceCount(text, re, actual)` |
| [`docs-sync.mjs`](../../../testjs/tools/docs-sync.mjs) | 按源码现算值改写文档里的数量类计数：只替换捕获到的数字、不动叙述；找不到计数位置时退出码 1（说明文档结构变了，要人工处理）。改完仍要跑 `docs:verify` 做全量对账（死链 / 覆盖 / 路由 / 格式） | `npm run docs:sync`；`--dry` 只预览 |
| [`gen-channels.mjs`](../../../testjs/tools/gen-channels.mjs) | 由 `electron/ipc-channels.json` 生成 `electron/main/channels.js`：通道常量只有 JSON 一份来源，主进程与 preload 各写一份字符串迟早漂移；生成物入库，改了 JSON 必须重新生成 | `npm run channels:gen`；`--check` 只校验与 JSON 同源（漂移退出码 1） |
| [`orphan-check.cjs`](../../../testjs/tools/orphan-check.cjs) | **只读孤儿检查**：`score_records` / `leave_records` / `cadre_members` 的 `student_id`、`group_members` 的姓名、`duty_slots.cells` 与 `seat_slots.seats` 的整块 JSON 是否存在悬空引用；带 `--selftest`（内存库种 6 条已知孤儿并断言全部报出）。⚠️ 刻意关闭 `foreign_keys`，模拟的是「加外键约束之前的老库」 | `node testjs/tools/orphan-check.cjs [库路径]`；`--selftest` |
| [`code_stats.ps1`](../../../testjs/tools/code_stats.ps1) | 代码与文档量统计（生成 [code-stats.md](../code-stats.md)；文档统计 `doc/` + 仓库根目录 Markdown，根目录不含 `LICENSE.md`） | PowerShell 执行 |
| [`doc-trees.mjs`](../../../testjs/tools/doc-trees.mjs) | 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树 | `node testjs/tools/doc-trees.mjs`（`--dry-run` 只预览） |
| [`error-boundary-check.cjs`](../../../testjs/tools/error-boundary-check.cjs) | 错误边界检查 | `npm run check:boundaries`（`--strict` 更严格） |
| [`comment-audit.js`](../../../testjs/tools/comment-audit.js) | 注释保真审计：比对拆分前后注释，只读不改 | `AUDIT_BASE=<git ref>` |
| [`radius-audit.js`](../../../testjs/tools/radius-audit.js) | 圆角使用审计（主题一致性） | 直接运行 |
| [`component-vapor-audit.mjs`](../../../testjs/tools/component-vapor-audit.mjs) | 组件 Vapor 标记审计 | 直接运行 |
| [`template-binding-audit.mjs`](../../../testjs/tools/template-binding-audit.mjs) | 模板绑定审计（未定义变量/悬空 ref） | 直接运行 |
| [`gen-icon-shapes.mjs`](../../../testjs/tools/gen-icon-shapes.mjs) | 生成图标形状数据（`IconGlyph.shapes.js`） | 直接运行 |
| [`album-sql-args.js`](../../../testjs/tools/album-sql-args.js) | 相册 SQL 参数构造核对 | 直接运行 |
| [`electron-page-probe.cjs`](../../../testjs/tools/electron-page-probe.cjs) | 用 Electron 打开指定页面并跑探针（供 secure-channel-retry 等复用） | 需 Vite 开发服务器 |

---

## 注意事项

- **会写真数据的只有 `seed-test-data.js`（灌测试数据的脚本）**：它按业务键幂等去重，但确实写入 `DATA_DIR`（数据目录），必须后端在跑；`SEED_BASE`（目标后端地址）/ `SEED_USER`（账号）/ `SEED_PASSWORD`（密码）可改目标。
- **`docs-verify`（文档一致性校验脚本）只证文档一致**：只读、失败退出码 1，检查死链 / 源码覆盖 / 路由校验 / 依赖 / 计数，不代表代码行为正确。
- **`code-stats.md`（代码与文档统计报告）是生成物**：数字与汇总表由 `code_stats.ps1`（统计脚本）产出，不要手改；需要更新就重跑脚本（报告自身按两遍法计入文档统计）。

---
