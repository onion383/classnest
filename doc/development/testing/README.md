# testjs 测试资产

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── testjs/
    ├── _suite-run.cjs  # units/behavior 共用核心：并行逐文件跑 node --test，支持同款旗标
    ├── run-all.js  # 总入口：--fast 只跑 units + behavior
    ├── run-behavior.js  # behavior 板块 runner
    ├── run-smoke.cjs  # smoke runner（冒烟运行器，支持 --only=（只跑）/ --skip=（跳过）…
    └── run-units.js  # units 板块 runner
```
<!-- doc-tree:end -->

`testjs/` 下的脚本**不参与打包、不被应用代码引用**。本目录说明每个脚本测什么、怎么跑、判据是什么；写法与新增标准以 [`testjs/README.md`](../../../testjs/README.md) 为准。

## 1. 目录分工

| 目录 | 定位 | 入库 |
| --- | --- | --- |
| [`units/`](../../../testjs/units/) | 纯逻辑单元测试（`node:test`，Node 内置测试框架） | ✅ |
| [`behavior/`](../../../testjs/behavior/) | 组件契约与架构标准（静态扫描 + 桩件 + `mock timers`（模拟定时器）） | ✅ |
| [`smoke/`](../../../testjs/smoke/) | 起真后端/真链路的冒烟 | ✅ |
| [`probe/`](../../../testjs/probe/) | 测量/诊断探针（`probe`，手动传参、耗时较长、**不是回归测试**） | ✅ |
| [`tools/`](../../../testjs/tools/) | 种子数据、审计、统计等长期工具 | ✅ |
| `tmp/` | 一次性排查脚本与中间产物 | ❌ 忽略 |

### 1.1 各层能证明什么、不能证明什么

| 层 | 能证明 | 不能证明 |
| --- | --- | --- |
| `units/` | 纯函数与纯逻辑的输入/输出、边界与幂等性 | 真实 HTTP、数据库落盘、组件渲染、Electron 环境 |
| `behavior/` | 组件契约、静态扫描、架构标准、桩件行为 | 真实用户交互、视觉与布局、后端链路 |
| `smoke/` | 起得来、连得上、关键链路不崩、落盘结构正确 | 完整业务语义、全部 UI 状态、性能与并发 |
| `probe/` | 指定环境下的测量/诊断结果 | 回归判定（不是回归测试，结果随环境变化） |
| `tools/` | 工具脚本自身的产出 | 任何产品功能正确性 |

判据统一看进程退出码：`0` 通过、非 `0` 失败、`3` 环境不具备跳过（不计失败）。跳过不等于通过，发布前要看实际跑了多少、跳过了哪些。

## 2. 入口命令

| 命令 | 跑什么 | 用时 | 何时用 |
| --- | --- | --- | --- |
| `npm test` | `run-all.js --fast`：units + behavior | ~2.4s | 每次提交 |
| `npm run test:units` | 仅单元层 | ~1.5s | 单独调算法 |
| `npm run test:behavior` | 仅行为层 | ~0.9s | 单独调契约 |
| `npm run smoke` | 链路冒烟（起真后端/wasm） | ~1min | 升依赖、发版前 |
| `npm run test:all` | 快测 + 冒烟 | ~1min | 打包前全量 |
| `npm run docs:verify` | 文档一致性校验（死链 / 源码覆盖 / 路由 / 依赖 / 计数） | 秒级 | 改文档、加路由或依赖后 |

## 3. runner

| 文件 | 作用 |
| --- | --- |
| [`run-all.js`](../../../testjs/run-all.js) | 总入口：`--fast` 只跑 units + behavior |
| [`run-units.js`](../../../testjs/run-units.js) | units 板块 runner |
| [`run-behavior.js`](../../../testjs/run-behavior.js) | behavior 板块 runner |
| [`run-smoke.cjs`](../../../testjs/run-smoke.cjs) | smoke `runner`（冒烟运行器，支持 `--only=`（只跑）/ `--skip=`（跳过）/ `--bail`（失败即停）/ `--list`（只列出）；有产物顺序 `ORDER_HINT`（顺序提示）） |
| [`_suite-run.cjs`](../../../testjs/_suite-run.cjs) | units/behavior 共用核心：并行逐文件跑 `node --test`，支持同款旗标 |

## 4. 判据

- `exit code`（进程退出码）：`0` = 通过；非 0 = 失败；**`3` = 环境不具备，跳过**（如缺产物文件、后端未监听 3000）。
- units / behavior 输出 per-file（逐文件）`PASS/FAIL`（通过/失败）明细与板块汇总；smoke 每个脚本也可单独 `node testjs/smoke/<文件>`。
- 探针与工具**不判定对错**，输出数据/报告；结论写进本文档对应条目或 `doc/开发文档/`。

## 5. 结论台账

| 类型 | 例子 | 结论落点 |
| --- | --- | --- |
| 回归资产 | `units/*`、`behavior/*`、`smoke/*` | 留在仓库，改代码即跑 |
| 结论型脚手架 | 一次性探针（如命名管道评估脚本，已删除） | 结论写文档后删除，历史见 `doc/开发文档/` |
| 长期工具 | `tools/code_stats.ps1`、`seed-test-data.js`、审计脚本 | 保留并在此登记 |

## 6. 新增脚本流程

1. 输入输出可判定、毫秒级 → `units/`（算法）或 `behavior/`（语义/契约）。
2. 能重复执行、起真环境给「坏没坏」结论 → `smoke/`。
3. 输出是数据/报告、不判对错 → `probe/` 或 `tools/`。
4. 只服务一次排查 → `tmp/`（不入库）。
5. 新增后同步本文档对应子页；命令有变同时改 [`testjs/README.md`](../../../testjs/README.md)。

## 7. 子页

- 单元测试：[units.md](./units.md)
- 行为测试：[behavior.md](./behavior.md)
- 冒烟：[smoke.md](./smoke.md)
- 探针：[probe.md](./probe.md)
- 工具：[tools.md](./tools.md)
