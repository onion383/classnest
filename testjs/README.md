# testjs

开发期辅助脚本集合。**都不参与打包**，也不被应用代码引用。

## 目录标准

| 目录 | 定位 | 是否入库 |
| --- | --- | --- |
| `units/` | 单元测试（`node:test`）：单个零件的纯逻辑标准。**按业务域分 13 个子目录**，见 §1 | ✅ 入库 |
| `behavior/` | 行为测试（`node:test`）：组件接口标准、失败语义、交互逻辑、架构标准校验 | ✅ 入库 |
| `smoke/` | 冒烟脚本：起真后端/真链路，一次跑完能给出「有没有坏」的结论 | ✅ 入库 |
| `probe/` | 过程探针：测量/诊断用，需要手动传参、耗时较长 | ✅ 入库 |
| `tools/` | 工具脚本：种子数据、审计、统计等长期复用的辅助 | ✅ 入库 |
| `tmp/` | 一次性验证脚本与中间产物，**默认不入库** | ❌ 忽略 |

> 新脚本的归类判断：**输入输出可判定、毫秒级** → `units/`（算法）或 `behavior/`（语义/标准）；
> **能重复执行 + 起真环境给「坏没坏」结论** → `smoke/`；**输出是数据/报告、不判对错** → `probe/` 或 `tools/`；
> **只服务某一次排查** → `tmp/`。

## 入口矩阵（一键命令）

| 命令 | 跑什么 | 用时 | 什么时候用 |
| --- | --- | --- | --- |
| `npm test` | 快测总闸（`run-all.js --fast`）：units + behavior | ~2.4s | 每次提交 |
| `npm run test:units` | 仅单元层（`run-units.js`） | ~1.5s | 单独调某层 |
| `npm run test:behavior` | 仅行为层（`run-behavior.js`） | ~0.9s | 单独调某层 |
| `npm run smoke` | 链路冒烟（`run-smoke.cjs`，起真后端/wasm） | ~1min | 升依赖、发版前 |
| `npm run test:all` | 全板块串跑（`run-all.js`）：快测 + 冒烟 | ~1min | 打包前全量检查 |
| `npm run check:guards` | 测试规则总闸（`tools/guard-ledger.cjs`，纯静态）：锚点存活 + 三个只降不升的基线 | ~0.7s | 已并入 `npm test`；单独查散点守卫 |

板块 runner 统一站 `testjs/` 下（`run-units.js` / `run-behavior.js` / `run-smoke.cjs` / `run-all.js`），
输出同款 per-file `PASS/FAIL` 明细 + 板块汇总。units/behavior 的共用核心是 `_suite-run.cjs`：
**递归**收集 `*.test.js`、并行逐文件跑 `node --test`、支持 `--only=` / `--skip=` / `--bail` / `--list`（与 run-smoke 同款旗标）。
并发默认封顶 8（`TEST_CONCURRENCY` 可覆盖）：16 核全开时每个文件还要 fork worker，进程数翻倍，机器上有别的活会随机超时。
**不要给 units/behavior 加 run-smoke 的环境机制**（端口/产物顺序/`SKIP`（跳过）规则）——那是冒烟的环境依赖逼出来的。

## 0. 一条测试的生命周期（准入 → 有效 → 退场）

测试不是越多越好：每条断言都是**永久的维护成本**，删的时候没人敢删。所以规矩不放在「加的时候小心」，
放在「加得进来、也退得出去」。

下面五节里，**0.2 / 0.3 / 0.5 全部由一条命令强制**：`npm run check:guards`
（已并入 `npm test` 第一步，纯静态、约 0.7s）。0.1 是写之前的自问，0.4 是一个必须知道的前提。

### 0.1 准入：什么才配进单测

三问，**全过**才写。任何一问答不上来，就先别加：

| 问 | 什么情况下答「是」 | 答「否」时怎么办 |
| --- | --- | --- |
| **错了会静默吗？** | 改坏了不报错、不崩溃、界面看着正常（漏挂载、字段不同源、入口悄悄消失） | 会直接报错/崩溃的，靠运行时炸就行，不用断言 |
| **能交给机器在写代码时拦吗？** | lint 规则、结构约束、只保留一份实现能做到 | 能就写 lint 并删掉测试断言（见 0.4 的例外） |
| **红了说明真坏了吗？** | 红了 = 功能确实坏了 | 红了只是「写法变了」→ 是噪音，别加 |

**值得写的三类**（都是「静默」的具体形态）：

1. **静默失效** —— 少一个 `immediate` 首次打开空白、`ctx` 少一条映射右键没反应、`types` 与 `rows` 不同源座位错位
2. **结构唯一** —— 防第二条入口 / 第二套实现（`openDbPicker` 不能留着当备用路径）
3. **数据一致性** —— 同源、级联、撤销快照必须带某字段

**明确不该写的**（2026-11-25 按此处理过 14 条：删 10 条、改造成「只留行为」4 条）：

```js
assert.match(src, /class="space-y-3 mb-5"/)      // 样式偏好：mb-5→mb-4 肉眼无差，必红
assert.match(src, /w-\[720px\] max-w-\[92vw\]/)  // 精确像素：换设计基准就红
assert.ok(z > 10013)                             // 纯数值：数字本身没有语义
assert.ok(!src.includes('HOME_SKELETON_ONLY'))   // 注释洁癖：注释不参与运行，永远防不住 bug
```

判据一句话：**能钉「语义 token」或「失效会导致功能坏掉的东西」，不能钉「某一串 utility / 某个具体数字」。**

### 0.2 有效性：每条源码断言必须能证明自己会死

「跑一次绿了」不构成有效。两条证明路径，至少满足一条：

| 证明 | 做法 | 谁能验 |
| --- | --- | --- |
| **锚点** | `// @pin 源码路径#符号名`，符号删了这条断言就再也红不了 → 机器要求删 | `npm run check:guards` 自动 |
| **变异反证** | 把源码故意改坏，断言必须红（`_mechanism.loadMutated` 可一键做） | 写的时候跑一次，或写进测试 |

两条都不满足 = 这条断言红了也说明不了什么，**不算守卫，算噪音**。

机器只验得动「锚点」这一条（符号还在不在）。变异反证没法自动验——它要求「改坏源码后断言变红」，
`check:guards` 不能为了让断言变红而去改产品代码。所以它靠人写的时候跑一次，或写进测试里（见 `loadMutated` 的用例）。

### 0.3 退场：四条自动 + 一条随手

1. **锚点死了就删** —— `check:guards` 报「符号已不存在」，这条断言已经无法失败。这是唯一不靠人判断的退场。
2. **断言基线只降不升** —— `units/_guard-baseline.json` 冻结每个文件的「无 `@pin` 源码断言数」。新加不带锚点的断言直接失败。
3. **度量基线只降不升** —— `units/_test-rules-baseline.json` 冻结 §0.5 的两个数。新建纯正则文件、新增孤立单断言用例都直接失败。
4. **升级成 lint 后，lint 覆盖全仓** —— 写代码时就拦住，比「有人想起跑测试」更早。
5. **改到哪个文件，顺手看它的守卫还要不要** —— 存量 1114 条没锚点，不专门做一轮，但碰到了就补或删。

第 2、3 条的 `--update` 都**拒绝变差**：只能随改进下调。想让基线涨，只能去改代码或手动改 JSON（会留在 diff 里被人看见）。

### 0.4 一个必须知道的前提

**lint 不是强制跑的**：项目没有 git 钩子，`eslint.config.mjs` 也明确不挂 build。

所以「升级成 lint 之后删测试断言」只在 lint 覆盖了**同一判据且范围更大**时才成立；
否则测试那条要留着兜底（当前 6 条 lint 规则对应的测试断言全部保留）。

### 0.5 度量：只看两个数，不看行数

这两个数不是「看看而已」——它们**冻结在 `units/_test-rules-baseline.json` 里，只降不升**，
由 `npm run check:guards` 判定：

| 指标 | 当前 | 闸门行为 |
| --- | --- | --- |
| **纯读 + 正则的文件**（只读源码、从不执行产品代码） | 66 / 339 | 记文件清单。**新增一个即失败**，要求「让它真跑」或并进已有同类文件 |
| **单条源码断言、且没有任何行为断言的用例** | 30 / 2383 | 记总数 + 按文件分布。**变多即失败**，并指出是哪个文件从几条变几条 |

口径（重要，否则数字对不上）：第 2 个数指「该 `test()` 内源码形态断言恰好 1 条，且
`equal` / `deepEqual` / `throws` 这类值断言为 0」。混合用例（1 条源码 + 2 条行为断言）**不算**——
那是行为测试附带的接线检查，不是「一个 bug 一条孤立守卫」。

为什么盯这两个：

- 第 1 个：这类文件红了，你判断不了是「写法变了」还是「真坏了」，是维护成本的集中地。
- 第 2 个：这是「一个 bug 加一条散点守卫」的标准形态，也是锚点机制主要要清掉的那批。

行数不是指标：删 14 条样式断言只省 14 行，但省掉的是「改样式就假红」的信任损耗。
覆盖率也不是指标：`units/` 现在 258 个文件会真跑代码（真库 / 真 HTTP / 动态 import），
盲目拉覆盖率只会增加第 1 个指标。

## 1. 单元测试 `units/`

```bash
npm run test:units        # node testjs/run-units.js（--only= / --skip= / --bail / --list 可用）
```

零第三方依赖（`node:test` + `node:assert`），失败时进程退出码非 0，可直接接 CI。

339 个文件按**业务域**分 13 个子目录（runner 递归收集，`--only=seat` 这类可直接按目录过滤）：

| 子目录 | 覆盖范围 | 文件数 |
| --- | --- | --- |
| `backend/` | 后端数据层、路由、SQL、事务边界、连接缓存、权限校验 | 67 |
| `student/` | 学生 / 班级 / 名册 / 班干部 / 成绩 / 课表 / 活动 / 值日安排以外的班级域 | 35 |
| `ai/` | AI 隐私与出网、工具执行器、提案队列、MCP 令牌 | 33 |
| `seat/` | 座位几何、桌型、走廊、格子、表格分页/缩放 | 30 |
| `duty/` | 值日格子、配置、轮换、请假时间窗 | 25 |
| `desktop/` | 主进程、IPC、窗口、更新、托盘、桌面组件 | 24 |
| `ui/` | 组件交互标准（a11y、对话框、拖拽、右键菜单、懒挂载、聚焦） | 21 |
| `meta/` | 测试自身的守卫（架构、覆盖矩阵、夹具纪律）、关于页/文档计数 | 21 |
| `account/` | 登录、会话、账号数据、隐私库、恢复词、令牌续期 | 20 |
| `album/` | 相册索引、缩略图、合并、ETag、刻度尺 | 19 |
| `storage/` | zip/unzip、压缩包恢复、磁盘占用、数据导出、虚拟相册 | 18 |
| `runtime/` | disposables、缓存守卫、启动耗时、slug 作用域、sweep 判据合集 | 16 |
| `security/` | 安全信道、凭据、路径守卫、密钥对预热、权限等级 | 10 |

公共件留在 `units/` 根：`_mechanism.cjs`（AST / 变异）、`_db-express-fixture.cjs`（内存库 + 真路由）、`_vue-loader.cjs`、`_guard-baseline.json`。

新增测试：放进最贴近被测对象的子目录；**引用公共件一律用包内别名**，不要写 `../`：

```js
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const { extractFunctionInner } = require('#testjs/units/_mechanism.cjs')
```

理由：写相对路径的话，文件在子目录间一搬就断；别名与层级无关，`package.json` 的 `imports` 里已经声明。
需要 `student-backend` 依赖（如 `better-sqlite3`）时，用
`createRequire(path.join(ROOT, 'student-backend/package.json'))` 解析，见 `backend/backend.test.js`。
前端是 ESM 的模块，用 `pathToFileURL` + 动态 `import()` 加载，见 `ui/frontend.test.js`。

**后端路由测试请用公共夹具 `units/_db-express-fixture.cjs`**，别再自己抄一遍
「env 兜底 → 内存库 → 换 `db.js` 的 Proxy → `express.listen(0)`」：

```js
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const fx = createBackendDb({ label: 'xxx' })      // extraDbExports / dataDir 可选
test.before(() => fx.mount('/api/xxx', 'student-backend/routes/xxx.js'))
test.after(() => fx.close())
// 每个用例要干净库：fx.reset()（db.js 的导出是转发到当前库的 Proxy，配合模块顶层
// require 到的引用才不失效）；发请求：fx.call('POST', '/path', body) → { status, text, json }
```

要测「多步写中途失败」时加故障注入（只包 `run()`，`reset()` 会清掉注入）：

```js
const fx = createBackendDb({ label: 'xxx', faults: true })
fx.inject({ failAt: 3 })                                  // 第 3 次写抛错
fx.inject({ failMatch: /duty_slots/i, failAtMatch: 1 })    // 匹配该 SQL 的第 1 次写抛错
```

`failAt` 是绝对写入序号，业务多一次写就整体偏移；关心「哪张表写失败」时用 `failMatch`。

`test-assets.test.js` 有一条守卫冻结了仍未迁移的旧样板文件数 —— 新写的测试必须走夹具。

### 源码断言要写 `@pin`（守卫的身份证与退场机制）

规则见 **§0.2 / §0.3**，这里只补两条实现细节。

格式（写在断言紧邻上一行或行尾）：

```js
// @pin student-frontend/src/composables/useSeatGrid.geometry.js#normalizeSeatTypes
assert.doesNotMatch(geo, /Math\.min\(/)
```

钉的是整个文件（模板 class、CSS 之类 AST 里没有的符号）才写 `路径#*` ——但要清楚它只保证「文件还在」，
而 `read('路径')` 在文件消失时本来就会抛错，所以 `#*` **没有退场价值**，只作最后手段。

为什么用「符号」而不是源码片段：符号改名/删除是**语义级**变化（守卫必须重审），
而格式化、换引号、加注释是**形态级**变化（守卫本来就该无所谓）。锚点用文本片段会把后者误判成失效。

存量补锚点：`node testjs/tools/pin-spread.cjs`（只报告不写盘）。实测 1276 条里 140 条能推出有意义的声明符号，
其余是模板属性 / 字面量 / 数值，硬补只能写 `#*`，不如不补。

## 2. 行为测试 `behavior/`

```bash
npm run test:behavior     # node testjs/run-behavior.js（--only= / --skip= / --bail / --list 可用）
```

补「零件对不对」与「链路通不通」之间的那层：**组件行为语义与架构标准**。
同样零依赖（静态扫描 + 桩件 + mock timers），毫秒级。六个模块分门别类：

| 文件 | 钉住什么 |
| --- | --- |
| `expose-contract.test.js` | 跨组件接口标准：每次 `xxx.value.method()` 调用必须有 `defineExpose` 支撑（script setup 下漏 expose 会被 `?.` 静默吞成空转）；模板 ref 的组件必须有暴露面 |
| `failure-semantics.test.js` | 失败语义：写操作（函数名含 save/delete/… 且体内真 I/O）的 catch 必须可感知（notify/报错/兜底/回滚）；带意图注释（不阻断/不阻塞/不叠加/回滚…）的设计性吞豁免，逃生口注释 `behavior-ok` |
| `sfc-conventions.test.js` | 架构标准校验（防清理成果回潮）：无 Options API、无 `getCurrentInstance`、token/currentUser 裸键只在 `authStorage.js`、模板静态 ref 不悬空 |
| `useRowFocus.test.js` | 跨页行定位行为：签名去重、parse 改写 id、时机未到的内部重试（stub host + mock timers） |
| `authStorage.test.js` | 登录态策略点标准：token 空值语义、坏 JSON 防御、setAuth/clearAuth 整套读写（mock localStorage） |
| `serialSaver.test.js` | 串行保存器：并发合并成一轮、失败即停不自动重试、每轮现取最新状态 |

新增测试按「行为面」归类进对应文件；纯算法类的进 `units/`，别混在这里。

## 3. 冒烟测试 `smoke/` —— 统一入口

```bash
npm run smoke                        # 一次跑完 smoke/ 下所有脚本
node testjs/run-smoke.cjs --list     # 只看会跑哪些
node testjs/run-smoke.cjs --only=pdf # 只跑文件名含 pdf 的（可重复传）
node testjs/run-smoke.cjs --skip=pdf # 跳过文件名含 pdf 的（可重复传）
node testjs/run-smoke.cjs --bail     # 第一个失败就停
```

**每个脚本也可以单独跑**：`node testjs/smoke/<文件名>`。

标准：
- 退出码 `0` = 通过，非 0 = 失败；**退出码 `3` = 脚本自己判定「环境不具备，跳过」**（如缺产物文件），不计失败。
- `auth-smoke.js` 默认自起隔离后端（临时目录 + 自动选空闲端口），不依赖本机是否已有服务；只有 `AUTH_SMOKE_EXTERNAL=1` 时才连 `PORT` / `38120` 上的外部后端。
- 有产物顺序依赖：`pdf-subset-verify.mjs` 先生成子集，`font-subset-verify.mjs` 再核对（`run-smoke.cjs` 的 ORDER_HINT 已排好）。

| 脚本 | 覆盖范围 |
| --- | --- |
| `api-smoke.cjs` | 后端基础接口连通 |
| `auth-smoke.js` | 认证链路：注册 → 确认 → 登录 → 改密 → 改名，以及隐私模式下的口令包裹/恢复词校验（**默认自起隔离后端**：随机端口 + 临时数据目录 + 不注入 SECURE_MASTER；要连外部后端得显式 `AUTH_SMOKE_EXTERNAL=1 PORT=xxxx`，只给 `PORT` 不算） |
| `collator-equiv-probe.js` | `Intl.Collator` 与前端等价排序一致性 |
| `unzip-safe-test.cjs` | 自研安全解压：符号链接/路径穿越/绝对路径/反斜杠全部拦截 |
| `pptx-guard-test.cjs` | PPTX 导入的守卫生效 |
| `thumbs-cache-test.cjs` | 缩略图缓存目录与命中逻辑 |
| `theme-setting-probe.mjs` | 主题设置项读写 |
| `secure-channel-retry.js` | 安全信道 401 重试：会话过期 / 凭据降级 / 绑定失效时是否正确重发（**需 Vite 开发服务器**，页面在 `student-frontend/dev-probes/`，经 `tools/electron-page-probe.cjs` 跑） |
| `pdf-subset-verify.mjs` | PDF 字体动态子集产出核对 |
| `font-subset-verify.mjs` | 子集 cmap 是否覆盖实际绘制的全部字符（纯 Node 解析 TTF，零依赖；原 py/fontTools 版已移除，不再需要 Python 环境） |

## 4. 过程探针 `probe/`

需要手动传参、耗时较长或会拉起完整应用的诊断脚本。**不是回归测试**，别放进冒烟。

| 脚本 | 用途 |
| --- | --- |
| `inp-probe.mjs` | 交互延迟（INP）。自动起 Vite 与带调试口的 Electron，用 CDP 派发真实输入事件 |
| `mode-probe.mjs` | 日/夜模式切换开销测量 |
| `ocr-probe.mjs` | OCR 可用性（Windows 有效） |
| `pdf-leak-probe.mjs` | PDF 导出内存泄漏核查（看 V8 external，不看 rss） |
| `widget-bottom-regression.ps1` | 桌面组件置底模式的回归检查：`-Drags N` 次合成拖动，逐项校验位移正确、尺寸不变、松手后仍压在 `Progman` 之上、无 `Application Error`（需应用在跑且置底模式已开） |
| `widget-shot.ps1` | 把组件窗口临时提到最前截图（`-Out` 指定路径），截完自动按「第一个可见窗口之下」压回去，用于核对圆角/透明/蓝色 |
| `toplevel-bottom-probe.cjs` | 「顶层置底」最小原型：顶层窗口 + 透明 CSS 圆角 + 真实鼠标拖动 + z 序自检，不含业务代码，可独立跑 |
| `inject-drag.ps1` | 用 `SetCursorPos` + `mouse_event` 合成一次真实左键拖动（虚拟化坐标），配合上面几个脚本做输入验证 |

> **关于已删除的 `pipe-*` 评估脚本**：它们曾用于「命名管道 + ACL 通信层方案」的评估与实测。
> 该方案已因引入 5 层间接而收益仅约 1ms、且 axios fetch adapter 对 204 响应误判导致页面闪跳，
> **最终全量回退**。评估结论与实测数据保留在 `doc/开发文档/通信层方案评估-命名管道与ACL.md`，
> 脚本本身不再随仓库维护（需要复跑时见 `git stash` 中的 `pipe-migration-wip`）。

## 5. 工具 `tools/`

| 脚本 | 用途 |
| --- | --- |
| `docs-verify.mjs` | 开发文档一致性校验（死链 / 源码覆盖 / 路由 / 依赖版本与许可 / 关键计数）；`npm run docs:verify`，只读、失败退出码 1 |
| `guard-ledger.cjs` | README §0 的唯一执行入口：① 校验 `@pin` 锚点是否还活着（死了 = 该删守卫）；② 冻结每个文件的「无 `@pin` 源码断言数」；③ 冻结 §0.5 的两个度量（纯正则文件清单、孤立单断言用例数）。后两者只降不升，`--update` 拒绝写更差的基线。`npm run check:guards`，`--report` 只出报告，`--top=20` 列断言最多的文件 |
| `pin-spread.cjs` | 给存量断言批量推断 `@pin` 候选：只认**声明符号**（函数 / 类 / 值为函数的 const / 方法键），`--json` 输出到 `testjs/tmp/pin-spread.json`。只报告不写盘，写回由调用方决定 |
| `seed-test-data.js` | 灌测试数据。`npm run seed`；`SEED_BASE` / `SEED_USER` / `SEED_PASSWORD` 可覆盖。**需后端在跑** |
| `comment-audit.js` | 注释保真审计：比对拆分前后的注释，只读不改。`AUDIT_BASE=<git ref>` 指定基准 |
| `album-sql-args.js` | 相册 SQL 参数构造的辅助核对 |
| `code_stats.ps1` | 代码与文档量统计（PowerShell；文档统计单独成板块） |
| `doc-trees.mjs` | 生成 / 刷新开发文档开头的「本篇涉及的文件」目录树；`node testjs/tools/doc-trees.mjs`（`--dry-run` 预览） |
| `measure-startup.mjs` | 启动耗时。`--backend-only` / `--dev` / `--json` / `--runs` / `--exe` 等参数见文件头注释。数据隔离在 `%LOCALAPPDATA%\ClassNestStartupMeasure`，不碰真实用户数据 |

`seed-test-data.js` 是幂等的：按业务键去重，重复运行不会堆重复数据。产出账号 `测试班主任` / `test1234`。

## 6. `tmp/`

只服务某一次排查的脚本与中间产物（如字体子集对比、缩略图基准、Excel 阻塞测量）。**默认不入库**，
确认不再复用就留在这里，需要时可整个目录删除。
