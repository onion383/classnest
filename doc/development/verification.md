# 文档核对台账与维护流程

本页回答两个问题：**怎么知道文档是对的**、**以后怎么维护**。

## 1. 可信度分层

| 层 | 内容 | 谁能证明 | 现状 |
| --- | --- | --- | --- |
| A. 事实层 | 文件是否存在、组件/页面/composable 清单、HTTP 路由、依赖版本与许可、关键计数、IPC 通道、npm 脚本、环境变量 | `npm run docs:verify`（机器，可复现） | 全绿 |
| B. 契约层 | Props / Emits / 导出函数名 / 返回字段 / 默认值 / 调用方 | 源码抽取 + 人工比对（`defineProps`、`module.exports`、`return {...}`） | 已逐个核对，脚本未覆盖 |
| C. 叙述层 | “为什么这样实现”“这个问题怎么来的”“时序/边界” | 只能人工阅读源码与历史记录 | 按模块逐步核对，仍有软点（见 §4） |

**结论**：A 层可被机器证明；B 层是“抽取值 + 抽查”；C 层是“人工判断”，不能承诺 100%。

## 2. 自动化校验（A 层）

```powershell
npm run docs:verify            # 20 类断言；失败退出码 1
node testjs/tools/docs-verify.mjs --json   # 机器可读
```

| 断言 | 覆盖对象 |
| --- | --- |
| 文档内部链接 | 41 份（`doc/` 下 40 份 + 根 README） |
| 源码覆盖 | 组件 76、页面 22（含拆分模块）、composable 26、utils 25、后端 98、主进程 26 |
| 路由断言 | `routes/**` 实际注册的 214 条 `METHOD path`（含 `historyRoutes` 工厂） |
| 依赖断言 | 40 个直接依赖的名称 / 声明版本或安装版本 / 许可证标识 |
| 关键计数 | 76 / 26 / 25 / 21 / 12 / 15 |
| npm 脚本 | 23 个脚本全部在 README 出现 |
| `.env` 变量 | 每个键在 README 有说明 |
| 运行时环境变量 | 文档声明的 7 个变量在源码里确实被 `process.env` 读取 |
| IPC 通道 | `ipc-channels.json` 的 86 个通道全部写入文档 |
| Mermaid 图结构 | 每份文档的代码块围栏成对闭合；` ```mermaid ` 块首行必须是 GitHub 支持的图表类型（`flowchart`（流程图）、`sequenceDiagram`（时序图）等） |

脚本读源码/读配置，**不修改任何文件**。

## 3. 改动 → 文档映射（维护时照这张表改）

| 你改了什么 | 必须更新 |
| --- | --- |
| 新增/删除/改名 `.vue` 组件 | `frontend/components/<对应子页>.md` + `components/README.md` 索引 |
| 新增/删除页面或页面拆分模块 | `frontend/views.md`、`frontend/README.md` 路由表与目录树 |
| 新增/删除 composable 或改返回字段 | `frontend/composables.md` |
| 新增/删除 util、指令、样式 | `frontend/misc.md` |
| 新增/删除后端路由或改方法/路径 | `backend/routes.md`（接口表）+ `frontend/views.md` 接口列 |
| 新增/删除 service、改导出 | `backend/services.md` |
| 改表结构、连接/密钥策略 | `backend/data-layer.md`、`topics/security.md` |
| 新增/删除主进程模块、改 IPC 通道 | `main-process/README.md`（模块表 + 4.6 通道）+ `topics/security.md` |
| 改打包/裁剪/双通道 | `topics/build-and-branches.md`、`dependencies/desktop.md` |
| 改主题、令牌、夜间配色、图标、排版、弹窗或动效 | `topics/design-and-interaction.md`；主题文件清单同步 `frontend/misc.md`，组件契约同步 `frontend/components/` |
| 改启动流程/内存口径/优化 | `topics/performance.md` |
| 新增/升级/删除依赖 | `dependencies/`（含 `licenses.md` 与 `licenses/*.txt`） |
| 新增测试/探针/工具 | `testing/` 对应子页 |
| 改 AI 工具、读写表白名单、子代理 | `topics/ai.md`、`backend/routes.md` |
| 改启动顺序、打包步骤、握手流程、主题切换时序 | 对应文档里的 Mermaid 图（`flowchart`（流程图）/ `sequenceDiagram`（时序图））+ 图下文字说明 |
| 改环境变量、端口、启动脚本 | 根 `README.md` |
| 搬迁文档目录（如把开发文档移入 `doc/development/`、新增 `doc/user/`） | `doc/README.md` 索引、根 README 文档入口、`docs-verify.mjs` 里 `DOC_DIR` 的子路径前缀；移动后必须重算相对链接并跑一次校验 |

## 4. 当前已知软点（不要当成“已证明”）

| 位置 | 情况 | 后续动作 |
| --- | --- | --- |
| `backend/routes.md` 处理要点 | 路径/方法已对齐源码；**每个 handler 的校验顺序**是归纳描述 | 需要时按单接口深读 |
| `frontend/components/*` 内部函数 | Props/Emits 为源码抽取；内部行为部分是人工总结 | 改动这些组件时顺手补 |
| `testing/probe.md` | 用途按脚本名与 README 归纳，未逐个读文件头 | 需要复跑某探针时以文件头为准 |
| `topics/performance.md` | 数值是**历史实测**，本次未复测 | 改性能相关代码后跑 `testjs/probe` 更新 |
| `topics/design-and-interaction.md` | 设计取舍来自 CSS 注释与源码，动效时长按源码抄录；**没有截图视觉回归** | 改主题/动效后人工看一遍目标主题，或补截图基准 |
| `widgets.md` | 主体沿用既有文档，本次只做链接化与失效文件标注 | 改小组件时逐段复核 |
| Mermaid 图 | 只校验围栏闭合与首行图表类型，**不校验图内语法与语义**（节点连线写错、渲染报错脚本看不出来） | 改图后在 GitHub 或支持 Mermaid 的编辑器里预览一次 |

## 5. 维护流程（建议按这个顺序）

1. **改代码前**：在 `doc/README.md` 目录里找到对应文档，先读现状。
2. **改代码后**：按 §3 表格更新文档的清单/契约。
3. **跑校验**：`npm run docs:verify`；失败项会直接指出“哪个文件未覆盖 / 哪个路由缺 / 哪个依赖版本不符”。
4. **补叙述**：行为、时序、注意事项这类内容人工补（脚本不管）。
5. **记账**：在本页 §6 追加一行日期 + commit + 改了什么。
6. **提交前**：`npm run docs:verify` 必须为 0；建议接入 CI 或 pre-push。

## 6. 核对记录

| 日期 | 基线 commit | 动作 | 结果 |
| --- | --- | --- | --- |
| 2026-11-02 | `d3ec28d`（工作区未提交） | 全量重写 + 三轮源码复核；新增 `docs-verify` 脚本 | 19 类断言全 PASS；修正路由/导出/计数/依赖版本等数十处 |
| 2026-11-02 | 同上 | 新增 `topics/design-and-interaction.md`（主题/夜间/图标/排版/弹窗/动效），同步目录与前端主题说明 | 40 份文档、0 死链；19 类断言全 PASS |
| 2026-11-02 | 同上 | 流程图改 Mermaid（三层架构、启动链路、打包流程、请求处理链、数据层链路、主题切换时序）并新增握手 / AI 对话时序图；`docs-verify` 增加 Mermaid 结构断言 | 8 张图全部通过；20 类断言全 PASS |
| 2026-11-02 | 同上 | 文档目录拆分：开发文档迁入 `doc/development/`（39 份），新建 `doc/user/` 占位；重算跨目录相对链接（文档内 822 条 + 根 README 25 条），`docs-verify` 子路径加 `development/` 前缀 | 41 份文档、0 死链；20 类断言全 PASS |
