# 行为测试（`testjs/behavior/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── behavior/
        ├── authStorage.test.js  # 登录态策略点标准：token 空值语义、坏 JSON 防御、setAuth/clearAut…
        ├── duty-big-mode.test.js  # 大扫除「组列 + 周期设置」的前后端接线：列名按模式分键后，界面显示组名、库里也必须是组名；…
        ├── expose-contract.test.js  # 跨组件接口标准：每次 xxx.value.method() 调用必须有 defineExpo…
        ├── failure-semantics.test.js  # 失败语义：写操作（函数名含 save/delete/… 且体内有真 I/O）的 catch …
        ├── gridview-cell-style.test.js  # GridView 单元格配色的结构标准：配色变量挂在 td 上而不是内层元素（内层元素拿不到…
        ├── gridview-week-dates.test.js  # 「星期列表头带日期副行」的接线：日期按星期名取（表头可拖拽），列头副行与 weekDates…
        ├── pattern-sweep.test.js  # 模式扫描接进 CI：把 testjs/probe/pattern-sweep-probe.c…
        ├── serialSaver.test.js  # 串行保存器：并发合并成一轮、失败即停不自动重试、每轮现取最新状态
        ├── sfc-conventions.test.js  # 架构标准校验（防清理成果回潮）：无 Options API、无 getCurrentInst…
        └── useRowFocus.test.js  # 跨页行定位：签名去重、parse 改写 id、时机未到的内部重试
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：行为测试层（`testjs/behavior/`），补「零件对不对」与「链路通不通」之间的一层：**组件行为语义与架构标准**。
- **公共逻辑**：零依赖（静态扫描 `SFC`（单文件组件）+ 桩件（替代真实依赖的假实现）+ `mock timers`（模拟定时器）），毫秒级；运行 `npm run test:behavior`。
- **局限**：不跑真实浏览器与真实后端，只校验静态可判定的标准和局部行为；分层能力见 [testing/README.md](./README.md)。

---

## 详细说明

| 文件 | 约束内容 | 判据 |
| --- | --- | --- |
| [`pattern-sweep.test.js`](../../../testjs/behavior/pattern-sweep.test.js) | **模式扫描接进 CI**：把 `testjs/probe/pattern-sweep-probe.cjs` 的判据包成自动测试 —— ①全仓无未登记的新漏网；②白名单已清空（修完后探针是纯回归资产）；③探针自身有 ≥8 个模式且每个模式的 `detect`/`known`/`exempt` 都非空（**探针写空了会永远绿灯**，必须守住）。⚠️ 判据**只写在探针里**（单一来源），本文件只 require 它并断言结果，不复现逻辑 | 静态扫描全仓 296 个源文件；毫秒级、无环境依赖 |
| [`expose-contract.test.js`](../../../testjs/behavior/expose-contract.test.js) | 跨组件接口标准：每次 `xxx.value.method()` 调用必须有 `defineExpose` 支撑（`script setup` 下漏 expose 会被 `?.` 静默吞成空转）；模板 ref 的组件必须有暴露面 | 静态扫描 SFC |
| [`failure-semantics.test.js`](../../../testjs/behavior/failure-semantics.test.js) | 失败语义：写操作（函数名含 save/delete/… 且体内有真 I/O）的 catch 必须可感知（notify/报错/兜底/回滚）；带意图注释的设计性吞声明可用 `behavior-ok` 豁免 | 静态扫描 + 注释白名单 |
| [`sfc-conventions.test.js`](../../../testjs/behavior/sfc-conventions.test.js) | 架构标准校验（防清理成果回潮）：无 Options API、无 `getCurrentInstance`、token/currentUser 裸键只在 `authStorage.js`、模板静态 ref 不悬空 | 扫描全部 SFC |
| [`useRowFocus.test.js`](../../../testjs/behavior/useRowFocus.test.js) | 跨页行定位：签名去重、parse 改写 id、时机未到的内部重试 | stub host + mock timers |
| [`authStorage.test.js`](../../../testjs/behavior/authStorage.test.js) | 登录态策略点标准：token 空值语义、坏 JSON 防御、setAuth/clearAuth 整套读写 | mock localStorage |
| [`serialSaver.test.js`](../../../testjs/behavior/serialSaver.test.js) | 串行保存器：并发合并成一轮、失败即停不自动重试、每轮现取最新状态 | mock timers |
| [`duty-big-mode.test.js`](../../../testjs/behavior/duty-big-mode.test.js) | 大扫除「组列 + 周期设置」的前后端接线：列名按模式分键后，界面显示组名、库里也必须是组名；补存快照只对命中日做，不能把「天天有」的快照写进大扫除 | 源码接线断言 + 内存库 |
| [`gridview-cell-style.test.js`](../../../testjs/behavior/gridview-cell-style.test.js) | GridView 单元格配色的结构标准：配色变量挂在 `td` 上而不是内层元素（内层元素拿不到列/行上下文），主题切换时不需要重排 DOM | 静态扫描 SFC |
| [`gridview-week-dates.test.js`](../../../testjs/behavior/gridview-week-dates.test.js) | 「星期列表头带日期副行」的接线：日期按星期名取（表头可拖拽），列头副行与 `weekDates` 同一口径，缺 baseMonday 时不显示空白副行 | 静态扫描 + 纯函数 |

新增按「行为面」归类进对应文件；纯算法类进 [units.md](./units.md)，不要混写。

---

## 注意事项

- **豁免要写意图**：`behavior-ok`（豁免注释标记）等于局部关掉检查，必须写明吞掉异常的理由，不能用来消红。
- **三条架构红线**：对外方法必须 `defineExpose`（组件对外暴露接口）（否则 `?.`（可选链，取不到会静默为空）变空转）；写操作 `catch`（异常捕获分支）必须可感知；`token`（登录令牌）/ `currentUser`（当前用户）裸键只允许出现在 `authStorage.js`（登录态唯一读写模块）。
- **只约束接口，不复刻实现**：新增用例针对接口标准、失败语义与重试时机，不要复刻实现细节，否则重构必然误报。

---
