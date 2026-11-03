# 单元测试（`testjs/units/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── units/
        ├── albumScan.test.js  # 相册扫描的「索引被误删/清空」防护
        ├── backend.test.js  # 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、domai…
        ├── changelog.test.js  # 更新历史解析：版本标题写法、条目清理、HTML 注释忽略、日期倒序
        ├── dbConnCache.test.js  # 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶
        ├── frontend.test.js  # 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼…
        ├── pathGuard.test.js  # 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建…
        ├── refresh-virtual.test.js  # 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项）
        └── updateIntegrity.test.js  # 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：单元测试层（`testjs/units/`），8 个 `node:test`（Node 内置测试框架）文件，覆盖纯函数与内存库上的数据层逻辑。
- **公共逻辑**：零第三方依赖（`node:test`（Node 内置测试框架）+ `node:assert`（Node 内置校验库）），不启动后端与前端；失败退出码非 0，可直接接 CI。运行：`npm run test:units`（支持 `--only=`（只跑指定文件）/ `--skip=`（跳过指定文件）/ `--bail`（首个失败即停）/ `--list`（只列用例不执行））。
- **局限**：不覆盖 HTTP 路由、UI、进程间链路与真实数据目录；分层说明见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 详细说明

| 文件 | 覆盖点 | 前置 / 写法 |
| --- | --- | --- |
| [`backend.test.js`](../../../testjs/units/backend.test.js) | 后端数据层与纯逻辑：建表最终形态（四张合并表、旧逻辑名退化为只读视图、播种行数）、`domain_history` payload → 三域历史视图的 JSON 映射、二次 `initSchema` 幂等、`slotStore` 逻辑名/可写列映射、`sanitize` 系列、恢复密钥归一化/哈希/常数时间比较、请假时间窗与 SQL 时间戳、`dutyMode` 解包（items 空值必须回数组） | 需 `student-backend` 依赖，用 `createRequire(path.join(ROOT,'student-backend/package.json'))` 解析 |
| [`frontend.test.js`](../../../testjs/units/frontend.test.js) | 前端纯函数：图表命中（分带/行/饼扇区/图例）、AI 图表数据解析（类型白名单、项数上限、饼图 Top N + 其他）、热力配色、`collectPdfText` 边界（循环引用/超深递归/空输入）、表格关键字过滤与「无结果」判定 | 前端是 ESM，用 `pathToFileURL` + 动态 `import()` |
| [`changelog.test.js`](../../../testjs/units/changelog.test.js) | 更新历史解析：版本标题写法（v 前缀 / `·` 分隔 / 括号日期）、条目清理、HTML 注释里的示例条目忽略、CRLF、日期倒序，并校验仓库真实 `CHANGELOG.md` | 前端是 ESM，用 `pathToFileURL` + 动态 `import()`；真实文件按相对路径读取 |
| [`albumScan.test.js`](../../../testjs/units/albumScan.test.js) | 相册扫描的「索引被误删/清空」防护 | 纯函数 + 内存库 |
| [`refresh-virtual.test.js`](../../../testjs/units/refresh-virtual.test.js) | 虚拟相册刷新：按索引更新、补 EXIF/缩略图、源文件缺失保留行、幂等（9 项） | 需先 `claimScanTask`（否则 `waitWhilePaused` 误判取消） |
| [`dbConnCache.test.js`](../../../testjs/units/dbConnCache.test.js) | 数据库连接 LRU：驱逐跳过在用连接、全部在用时的软超限/硬顶 | 内存连接桩 |
| [`pathGuard.test.js`](../../../testjs/units/pathGuard.test.js) | 路径防护：绝对路径校验、系统保护目录/符号链接/junction 拦截、可执行扩展名拒绝、建议文件名压平 | 纯函数 |
| [`updateIntegrity.test.js`](../../../testjs/units/updateIntegrity.test.js) | 更新下载校验：https 强制、大小与 sha256 核对、缺 digest 时降级为仅大小 | 纯函数 |

新增：在 `units/` 建 `*.test.js`，用 `node:test` 的 `test()` 编写，无需改配置。

---

## 注意事项

- **分层不要混写**：纯算法留在本层；组件行为语义放 [behavior.md](./behavior.md)，HTTP ↔ 前后端链路放 [smoke.md](./smoke.md)。
- **不碰真实数据**：本层只用内存库、连接桩与纯函数；需要启动真实后端或真实 `DATA_DIR`（数据目录）的用例不属于这一层。

---
