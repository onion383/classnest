# 工具脚本（`testjs/tools/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── tools/
        ├── album-sql-args.js  # 相册 SQL 参数构造核对
        ├── code_stats.ps1  # 代码与文档量统计（生成 ；文档统计单独成板块）
        ├── comment-audit.js  # 注释保真审计：比对拆分前后注释，只读不改
        ├── component-vapor-audit.mjs  # 组件 Vapor 标记审计
        ├── doc-trees.mjs  # 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树
        ├── docs-verify.mjs  # 文档一致性校验：死链、源码覆盖、路由、依赖版本/许可、关键计数、Mermaid、用户手册索引…
        ├── electron-page-probe.cjs  # 用 Electron 打开指定页面并跑探针（供 secure-channel-retry 等…
        ├── error-boundary-check.cjs  # 错误边界检查
        ├── gen-icon-shapes.mjs  # 生成图标形状数据（IconGlyph.shapes.js）
        ├── radius-audit.js  # 圆角使用审计（主题一致性）
        ├── seed-test-data.js  # 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」）
        └── template-binding-audit.mjs  # 模板绑定审计（未定义变量/悬空 ref）
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：辅助脚本层（`testjs/tools/`），12 个长期复用的脚本，负责数据准备、审计、文档一致性校验与统计生成；**不属于测试判定**。
- **公共逻辑**：多数只读或幂等（重复执行结果不变），可反复执行；统计与校验类产出报告（如 [code-stats.md](../code-stats.md)（代码与文档统计报告）），由脚本生成、不手工维护。
- **局限**：没有通过 / 失败判定，可信范围见 [testing/README.md](./README.md)；具体参数以各脚本文件头注释为准。

---

## 详细说明

| 脚本 | 用途 | 用法 / 前置 |
| --- | --- | --- |
| [`seed-test-data.js`](../../../testjs/tools/seed-test-data.js) | 灌测试数据（幂等，按业务键去重；产出账号「测试班主任 / test1234」） | `npm run seed`；`SEED_BASE` / `SEED_USER` / `SEED_PASSWORD` 可覆盖；**需后端在跑** |
| [`docs-verify.mjs`](../../../testjs/tools/docs-verify.mjs) | 文档一致性校验：死链、源码覆盖（含构建配置与安装器素材）、路由、依赖版本/许可、关键计数、Mermaid、用户手册索引与结构、工具/测试脚本覆盖、doc-tree 结构、禁用词、英文标识配中文、字段标签加粗、模块与文末分隔线（只读，失败退出码 1） | `npm run docs:verify`（`--json` 输出机器可读结果） |
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
