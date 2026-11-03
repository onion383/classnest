# 过程探针（`testjs/probe/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── testjs/
    └── probe/
        ├── _sample-big.cjs  # 大样张数据生成（供相册/表格探针复用）
        ├── bundle-diff.mjs  # 构建产物体积差异
        ├── etag-revalidate-probe.cjs  # ETag 重新校验行为
        ├── gdi-shot-bench.cjs  # GDI 截图性能基准
        ├── glyph-render-check.mjs  # 图标字形渲染核对
        ├── grid-row-drag-probe.cjs  # 网格行拖拽让位
        ├── inject-drag.ps1  # SetCursorPos + mouse_event 合成一次真实左键拖动（配合其它探针）
        ├── inp-compare.mjs  # 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor）
        ├── inp-probe.mjs  # 交互延迟（INP）：自动起 Vite + 带调试口的 Electron，CDP 派发真实输入…
        ├── keepalive-album-probe.cjs  # KeepAlive 下相册页状态恢复
        ├── keepalive-restore-probe.cjs  # KeepAlive 通用恢复
        ├── keepalive-table-restore-probe.cjs  # KeepAlive 表格页滚动/编辑态恢复
        ├── longframe-probe.mjs  # 长帧定位（主线程阻塞点）
        ├── measure-startup.mjs  # 启动耗时；--backend-only / --dev / --json / --runs …
        ├── mode-probe.mjs  # 日/夜模式切换开销
        ├── night-btn-hover-probe.cjs  # 夜间主题按钮悬停配色
        ├── ocr-probe.mjs  # OCR 可用性（仅 Windows）
        ├── pdf-leak-probe.mjs  # PDF 导出内存泄漏（看 V8 external，不看 rss）
        ├── refresh-warm-check.cjs  # 刷新/预热后的缓存命中
        ├── screenshot-bench.cjs  # 应用内截图性能基准
        ├── search-bench.cjs  # 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照…
        ├── search-sources-probe.cjs  # 全局搜索（GET /api/search）各数据源能否命中、排序/多词/focus 串是否正…
        ├── toplevel-bottom-probe.cjs  # 「顶层置底」最小原型（顶层窗口 + 透明圆角 + 拖动 + z 序自检，无业务代码）
        ├── vapor-audit.mjs  # 组件 Vapor 迁移审计
        ├── vapor-bench.mjs  # Vapor 通道基准
        ├── vapor-verify.mjs  # 校验产物里 __vapor: true（拼错标记只会静默失效）
        ├── viewer-anim-probe.cjs  # 查看器切换动画
        ├── viewer-load-probe.cjs  # 查看器图片加载
        ├── viewer-open-probe.cjs  # 照片查看器打开耗时
        ├── widget-bottom-regression.ps1  # 置底回归：-Drags N 次合成拖动，校验位移正确、尺寸不变、松手仍在 Progman 之…
        └── widget-shot.ps1  # 把组件窗口临时提到最前截图（-Out 指定路径，截完压回）
```
<!-- doc-tree:end -->

本层的可信范围与局限，见 [testing/README.md](./README.md) 的「各层的可信范围与局限」。

---

## 综合概述

- **定位**：过程探针层（`testjs/probe/`），30 个脚本（29 个探针 + 1 个样例），需要手动传参、耗时较长或拉起完整应用。
- **公共逻辑**：多数自行启动 `Vite`（前端开发服务器）/ 带调试口的 `Electron`，或复用 `_sample-big.cjs`（大样张生成脚本）生成样张；输出是数据/报告，结论写到本页或 `doc/开发文档/`。
- **局限**：**不是回归测试**，不能当判据、也不进冒烟；可信范围见 [testing/README.md](./README.md)。

---

## 详细说明

### 启动与性能

| 脚本 | 用途 / 参数 |
| --- | --- |
| [`measure-startup.mjs`](../../../testjs/probe/measure-startup.mjs) | 启动耗时；`--backend-only` / `--dev` / `--json` / `--runs` / `--exe`；数据隔离在 `%LOCALAPPDATA%\ClassNestStartupMeasure` |
| [`longframe-probe.mjs`](../../../testjs/probe/longframe-probe.mjs) | 长帧定位（主线程阻塞点） |
| [`inp-probe.mjs`](../../../testjs/probe/inp-probe.mjs) | 交互延迟（INP）：自动起 Vite + 带调试口的 Electron，CDP 派发真实输入（`npm run inp`） |
| [`inp-compare.mjs`](../../../testjs/probe/inp-compare.mjs) | 两组配置的 INP 对比（如 3.5 / 3.6、VDOM / Vapor） |
| [`bundle-diff.mjs`](../../../testjs/probe/bundle-diff.mjs) | 构建产物体积差异 |
| [`refresh-warm-check.cjs`](../../../testjs/probe/refresh-warm-check.cjs) | 刷新/预热后的缓存命中 |
| [`etag-revalidate-probe.cjs`](../../../testjs/probe/etag-revalidate-probe.cjs) | ETag 重新校验行为 |

### 渲染与绘制

| 脚本 | 用途 |
| --- | --- |
| [`gdi-shot-bench.cjs`](../../../testjs/probe/gdi-shot-bench.cjs) | GDI 截图性能基准 |
| [`screenshot-bench.cjs`](../../../testjs/probe/screenshot-bench.cjs) | 应用内截图性能基准 |
| [`glyph-render-check.mjs`](../../../testjs/probe/glyph-render-check.mjs) | 图标字形渲染核对 |
| [`night-btn-hover-probe.cjs`](../../../testjs/probe/night-btn-hover-probe.cjs) | 夜间主题按钮悬停配色 |
| [`toplevel-bottom-probe.cjs`](../../../testjs/probe/toplevel-bottom-probe.cjs) | 「顶层置底」最小原型（顶层窗口 + 透明圆角 + 拖动 + z 序自检，无业务代码） |

### 相册与查看器

| 脚本                                                                                             | 用途                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------- |
| [`viewer-open-probe.cjs`](../../../testjs/probe/viewer-open-probe.cjs)                         | 照片查看器打开耗时                        |
| [`viewer-load-probe.cjs`](../../../testjs/probe/viewer-load-probe.cjs)                         | 查看器图片加载                          |
| [`viewer-anim-probe.cjs`](../../../testjs/probe/viewer-anim-probe.cjs)                         | 查看器切换动画                          |
| [`pdf-leak-probe.mjs`](../../../testjs/probe/pdf-leak-probe.mjs)                               | PDF 导出内存泄漏（看 V8 external，不看 rss） |
| [`keepalive-album-probe.cjs`](../../../testjs/probe/keepalive-album-probe.cjs)                 | KeepAlive 下相册页状态恢复               |
| [`keepalive-restore-probe.cjs`](../../../testjs/probe/keepalive-restore-probe.cjs)             | KeepAlive 通用恢复                   |
| [`keepalive-table-restore-probe.cjs`](../../../testjs/probe/keepalive-table-restore-probe.cjs) | KeepAlive 表格页滚动/编辑态恢复            |

### 表格与拖拽

| 脚本 | 用途 |
| --- | --- |
| [`grid-row-drag-probe.cjs`](../../../testjs/probe/grid-row-drag-probe.cjs) | 网格行拖拽让位 |
| [`inject-drag.ps1`](../../../testjs/probe/inject-drag.ps1) | `SetCursorPos` + `mouse_event` 合成一次真实左键拖动（配合其它探针） |

### 接口与数据源

| 脚本 | 用途 |
| --- | --- |
| [`search-sources-probe.cjs`](../../../testjs/probe/search-sources-probe.cjs) | 全局搜索（`GET /api/search`）各数据源能否命中、排序/多词/字段限定/`focus` 串是否正确；内存库 + `require.cache` 替换 `../db`，22 条断言，失败退出码 1。无需桌面、毫秒级 |
| [`search-bench.cjs`](../../../testjs/probe/search-bench.cjs) | 全局搜索接口耗时：灌 2 万条加扣分、3 万张照片的内存库，测端到端 p50/p90，并对照旧实现「拉 1000 行 + 逐格拼音」的成本；`--runs=N` 控制轮次，不做门限判定 |

### Vapor

| 脚本 | 用途 |
| --- | --- |
| [`vapor-verify.mjs`](../../../testjs/probe/vapor-verify.mjs) | 校验产物里 `__vapor: true`（拼错标记只会静默失效） |
| [`vapor-bench.mjs`](../../../testjs/probe/vapor-bench.mjs) | Vapor 通道基准 |
| [`vapor-audit.mjs`](../../../testjs/probe/vapor-audit.mjs) | 组件 Vapor 迁移审计 |

### 其他

| 脚本 | 用途 |
| --- | --- |
| [`mode-probe.mjs`](../../../testjs/probe/mode-probe.mjs) | 日/夜模式切换开销 |
| [`ocr-probe.mjs`](../../../testjs/probe/ocr-probe.mjs) | OCR 可用性（仅 Windows） |
| [`widget-shot.ps1`](../../../testjs/probe/widget-shot.ps1) | 把组件窗口临时提到最前截图（`-Out` 指定路径，截完压回） |
| [`widget-bottom-regression.ps1`](../../../testjs/probe/widget-bottom-regression.ps1) | 置底回归：`-Drags N` 次合成拖动，校验位移正确、尺寸不变、松手仍在 `Progman` 之上、无 `Application Error` |
| [`_sample-big.cjs`](../../../testjs/probe/_sample-big.cjs) | 大样张数据生成（供相册/表格探针复用） |

> 已删除的 `pipe-*` 评估脚本：命名管道 + ACL 方案实测收益约 1ms，且 axios fetch adapter 对 204 误判导致页面闪跳，已全量回退；结论见 `doc/开发文档/通信层方案评估-命名管道与ACL.md`（不入库）。

---

## 注意事项

- **参数以脚本头部为准**：本页用途摘要来自脚本名与 `testjs/README.md`，运行前先读各脚本文件头注释，别照抄本页猜参数。
- **不要进冒烟 / CI**：探针需要真实桌面、真实应用与较长耗时，只做一次性测量；判据类检查放 [smoke.md](./smoke.md)。
  - 例外说明：`search-sources-probe.cjs` 不依赖桌面、跑得也快，但它的验证对象是一次真实路由调用，按 [units.md](./units.md) 的分层规则（该层不覆盖 HTTP 路由）仍归在探针层手动运行。
- **桌面窗口类探针会动真实窗口**：`widget-bottom-regression.ps1`（置底回归探针）会合成真实拖动、`widget-shot.ps1`（组件截图探针）会把组件临时提到最前截图；运行前先收好正在使用的窗口，避免误操作。

---
