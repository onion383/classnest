# 冒烟脚本（`testjs/smoke/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── smoke/
        ├── _isolated-backend.cjs  # 共用脚手架
        ├── album-file-etag-test.cjs  # 无
        ├── album-photo-info-test.cjs  # 无
        ├── album-ruler-mapping-test.cjs  # 无
        ├── api-routes-test.cjs  # 临时 DATA_DIR + 真实路由挂最小 Express，不需要完整后端
        ├── api-smoke.cjs  # 内置最小 Express，不需要真实后端
        ├── auth-smoke.js  # 默认自起隔离后端；AUTH_SMOKE_EXTERNAL=1 时连接 PORT / 3000…
        ├── cadre-undo-test.cjs  # 临时 DATA_DIR + 真实路由挂最小 Express，不需要完整后端
        ├── collator-equiv-probe.js  # 无
        ├── font-subset-verify.mjs  # 需 pdf-subset-verify 产物
        ├── pdf-subset-verify.mjs  # 先生成子集
        ├── pptx-guard-test.cjs  # 无
        ├── secure-channel-retry.js  # 需 Vite 开发服务器（dev-probes/ 页面，经 tools/electron-p…
        ├── theme-setting-probe.mjs  # 无
        ├── thumbs-cache-test.cjs  # 无
        ├── undo-batch-test.cjs  # 临时 DATA_DIR + 真实撤销路由，不需要完整后端
        └── unzip-safe-test.cjs  # 无
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：链路冒烟测试（`testjs/smoke/`），一次跑完给出「有没有坏」的结论。
- **公共逻辑**：`run-smoke.cjs`（冒烟入口脚本）串行执行脚本；需要后端的脚本用 `_isolated-backend.cjs`（隔离后端脚本）自起隔离后端；退出码 `0` 通过、非 `0` 失败、`3` 环境不具备跳过；有产物顺序依赖（先出 `pdf`（PDF 导出产物）再出字体）。
- **局限**：只证明「起得来、连得上、关键路径不崩、落盘结构正确」，不证明完整业务语义、全部 UI 状态、性能与并发；`probe/` 不是回归测试。

---

## 详细说明

### 运行与判据

运行：`npm run smoke`，等价于 `node testjs/run-smoke.cjs`。

- `--only=<关键词>`（可重复）：只跑文件名包含该关键词的脚本，例如 `--only=auth`。
- `--skip=<关键词>`（可重复）：跳过文件名包含该关键词的脚本。
- `--bail`：第一个失败立即停止，不再继续后面的脚本。
- `--list`：只列出将要运行的脚本，不执行。
- `--help` / `-h`：打印用法。

每个脚本也可单独运行：`node testjs/smoke/<文件名>`。脚本是**串行**执行的：会占用端口与临时目录，并行跑会互相干扰。

环境变量（仅认证类脚本使用）：

- `AUTH_SMOKE_EXTERNAL=1`：不自己起隔离后端，改为连接既有后端；该后端必须是明文模式，否则纯 HTTP 的 Bearer 会被判 `401`。
- `PORT`：外部后端的端口，仅在 `AUTH_SMOKE_EXTERNAL=1` 时生效，缺省 `3000`。默认（不设该变量）由隔离后端自动选择空闲端口。

判据：退出码 `0` 通过、非 0 失败、`3` 环境不具备跳过（不计失败）。有产物顺序依赖（`pdf-subset-verify` 先生成子集，`font-subset-verify` 再核对，`run-smoke.cjs` 的 `ORDER_HINT` 已排好）。

| 脚本 | 前置 | 覆盖 |
| --- | --- | --- |
| [`api-smoke.cjs`](../../../testjs/smoke/api-smoke.cjs) | 内置最小 Express，不需要真实后端 | 请求体解析：JSON / 表单 / gzip / 尾部垃圾字节 / 超限拦截 |
| [`api-routes-test.cjs`](../../../testjs/smoke/api-routes-test.cjs) | 临时 `DATA_DIR` + 真实路由挂最小 Express，不需要完整后端 | 畸形 Range、值日落盘结构、AI 密钥复用、快照后列缓存失效、SSE 尾帧、虚拟相册撤销 |
| [`auth-smoke.js`](../../../testjs/smoke/auth-smoke.js) | 默认自起隔离后端；`AUTH_SMOKE_EXTERNAL=1` 时连接 `PORT` / `3000` 的明文后端 | 注册 → 确认 → 登录 → 改密 → 改名；隐私模式口令包裹/恢复词校验 |
| [`undo-batch-test.cjs`](../../../testjs/smoke/undo-batch-test.cjs) | 临时 `DATA_DIR` + 真实撤销路由，不需要完整后端 | 批次撤销：同 `origin` 一次退完/一次回完、跨表批次、无 `origin` 仍是单条、新动作清空全部 redo、按 `origin` 整批（设置页路径） |
| [`collator-equiv-probe.js`](../../../testjs/smoke/collator-equiv-probe.js) | 无 | 后端 `Intl.Collator` 与前端排序一致性 |
| [`unzip-safe-test.cjs`](../../../testjs/smoke/unzip-safe-test.cjs) | 无 | 安全解压：符号链接/路径穿越/绝对路径/反斜杠全部拦截 |
| [`pptx-guard-test.cjs`](../../../testjs/smoke/pptx-guard-test.cjs) | 无 | PPTX 导入守卫 |
| [`thumbs-cache-test.cjs`](../../../testjs/smoke/thumbs-cache-test.cjs) | 无 | 缩略图缓存目录与命中逻辑 |
| [`album-file-etag-test.cjs`](../../../testjs/smoke/album-file-etag-test.cjs) | 无 | 相册原文件 ETag/缓存语义 |
| [`album-photo-info-test.cjs`](../../../testjs/smoke/album-photo-info-test.cjs) | 无 | 照片信息（EXIF 日期字段等） |
| [`album-ruler-mapping-test.cjs`](../../../testjs/smoke/album-ruler-mapping-test.cjs) | 无 | 年份尺映射（宽 42、轴心 x=34） |
| [`theme-setting-probe.mjs`](../../../testjs/smoke/theme-setting-probe.mjs) | 无 | 主题设置项读写 |
| [`secure-channel-retry.js`](../../../testjs/smoke/secure-channel-retry.js) | 需 Vite 开发服务器（`dev-probes/` 页面，经 `tools/electron-page-probe.cjs`） | 安全信道 401 重试：会话过期/凭据降级/绑定失效时正确重发 |
| [`pdf-subset-verify.mjs`](../../../testjs/smoke/pdf-subset-verify.mjs) | 先生成子集 | PDF 字体动态子集产出核对 |
| [`font-subset-verify.mjs`](../../../testjs/smoke/font-subset-verify.mjs) | 需 `pdf-subset-verify` 产物 | 子集 cmap 覆盖实际绘制的全部字符（纯 Node 解析 TTF） |
| [`_isolated-backend.cjs`](../../../testjs/smoke/_isolated-backend.cjs) | 共用脚手架 | 起隔离后端（独立端口/数据目录），供需要后端的脚本复用 |

### 示范：`auth-smoke.js` 的原理与局限

以下以认证链路为例；其余重点脚本按同样四段写。

- **目的**：守住认证链路的几个不变量——bcrypt 异步哈希确实落库（不是 Promise 对象）、改密后旧密码失效、改名同步 `registry` 后旧名可重新注册且新名可登录、隐私模式改名后密码包裹与恢复词仍可用。
- **原理**：用 [`_isolated-backend.cjs`](../../../testjs/smoke/_isolated-backend.cjs) 自起一个独立 `PORT` / `DATA_DIR` 的后端，且**不注入 `SECURE_MASTER`**；然后依次走这些接口：
  - `/api/register`（注册：普通等级直接建库；隐私等级只返回恢复词草稿）。
  - `/api/register/confirm`（隐私模式确认：用草稿 + 12 词恢复词真正建库）。
  - `/api/login`（登录：用密码或恢复词换取 token）。
  - `/api/account/password`（修改登录密码）。
  - `/api/account/username`（修改用户名，并同步 `registry`）。
  
  必须自起后端：安全模式后端只认 `X-Auth-Proof` 信道凭据、不读 `Authorization: Bearer`，纯 HTTP 客户端会从改密一步开始连续 `401`，造成连锁假失败。
- **判据**：逐个校验 HTTP 状态码与响应字段；全部通过退出 `0`，任一失败退出 `1`；脚本自己起的后端在结束时清理，不污染真实数据。
- **局限**：只覆盖 API 层，不覆盖登录页 UI、Electron 安全信道、并发登录/会话吊销、速率限制与审计日志；`AUTH_SMOKE_EXTERNAL=1` 连接外部后端时，结果取决于对方是否明文模式；不验证除认证表以外的业务数据与撤销逻辑。

---

## 注意事项

- 需要后端的脚本必须自起隔离后端，不污染真实用户数据。
- 安全模式后端不能直接给纯 HTTP 冒烟脚本用（只认 `X-Auth-Proof`（安全通道的请求凭据头）），否则会连锁 `401`（未授权）。
- 看到 `SKIP`（跳过标记，退出码 `3`）不等于通过；发布前要确认实际跑了多少、跳过了哪些。
- 脚本串行执行，会占用端口与临时目录，不能并行跑。

---
