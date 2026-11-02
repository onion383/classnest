# 行为测试（`testjs/behavior/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。

```text
project-name/
└── testjs/
    └── behavior/
        ├── authStorage.test.js  # 登录态策略点契约：token 空值语义、坏 JSON 防御、setAuth/clearAut…
        ├── expose-contract.test.js  # 跨组件契约：每次 xxx.value.method() 调用必须有 defineExpose…
        ├── failure-semantics.test.js  # 失败语义：写操作（函数名含 save/delete/… 且体内有真 I/O）的 catch …
        ├── serialSaver.test.js  # 串行保存器：并发合并成一轮、失败即停不自动重试、每轮现取最新状态
        ├── sfc-conventions.test.js  # 架构标准校验（防清理成果回潮）：无 Options API、无 getCurrentInst…
        └── useRowFocus.test.js  # 跨页行定位：签名去重、parse 改写 id、时机未到的内部重试
```
<!-- doc-tree:end -->

本层能证明什么、不能证明什么，见 [testing/README.md](./README.md) 的「各层能证明什么、不能证明什么」。

## 综合概述

- **定位**：行为测试层（`testjs/behavior/`），补「零件对不对」与「链路通不通」之间的一层：**组件行为语义与架构契约**。
- **公共逻辑**：零依赖（静态扫描 SFC + 桩件 + mock timers），毫秒级；运行 `npm run test:behavior`。
- **局限**：不跑真实浏览器与真实后端，只校验静态可判定的契约和局部行为；分层能力见 [testing/README.md](./README.md)。

## 详细说明

| 文件 | 钉住什么 | 判据 |
| --- | --- | --- |
| [`expose-contract.test.js`](../../../testjs/behavior/expose-contract.test.js) | 跨组件契约：每次 `xxx.value.method()` 调用必须有 `defineExpose` 支撑（`script setup` 下漏 expose 会被 `?.` 静默吞成空转）；模板 ref 的组件必须有暴露面 | 静态扫描 SFC |
| [`failure-semantics.test.js`](../../../testjs/behavior/failure-semantics.test.js) | 失败语义：写操作（函数名含 save/delete/… 且体内有真 I/O）的 catch 必须可感知（notify/报错/兜底/回滚）；带意图注释的设计性吞声明可用 `behavior-ok` 豁免 | 静态扫描 + 注释白名单 |
| [`sfc-conventions.test.js`](../../../testjs/behavior/sfc-conventions.test.js) | 架构标准校验（防清理成果回潮）：无 Options API、无 `getCurrentInstance`、token/currentUser 裸键只在 `authStorage.js`、模板静态 ref 不悬空 | 扫描全部 SFC |
| [`useRowFocus.test.js`](../../../testjs/behavior/useRowFocus.test.js) | 跨页行定位：签名去重、parse 改写 id、时机未到的内部重试 | stub host + mock timers |
| [`authStorage.test.js`](../../../testjs/behavior/authStorage.test.js) | 登录态策略点契约：token 空值语义、坏 JSON 防御、setAuth/clearAuth 整套读写 | mock localStorage |
| [`serialSaver.test.js`](../../../testjs/behavior/serialSaver.test.js) | 串行保存器：并发合并成一轮、失败即停不自动重试、每轮现取最新状态 | mock timers |

新增按「行为面」归类进对应文件；纯算法类进 [units.md](./units.md)，不要混写。

## 注意事项

- **豁免要写意图**：`behavior-ok` 注释等于局部关掉检查，必须写清「为什么这里可以吞」，不能用来消红。
- **三条架构红线**：对外方法必须 `defineExpose`（否则 `?.` 静默变空转）；写操作 `catch` 必须可感知；`token` / `currentUser` 裸键只允许出现在 `authStorage.js`。
- **只钉契约不测实现**：新增用例针对行为面（契约、失败语义、重试时机），不要复刻实现细节，否则重构必然误报。
