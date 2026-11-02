# 依赖专题：清单、用途与许可证

三个 `package.json`（根 / `student-frontend` / `student-backend`）+ 随包二进制资源。逐依赖明细见 [frontend.md](./frontend.md)、[backend.md](./backend.md)、[desktop.md](./desktop.md)、[licenses.md](./licenses.md)。

表里的许可证缩写：`MIT` / `ISC` / `BSD-2-Clause` / `BSD-3-Clause`（宽松开源，可商用、修改、再分发，保留版权声明）、`Apache-2.0`（含专利授权与声明要求）、`MPL-2.0`（修改文件需公开源码）、`LGPL-2.1`（动态链接可闭源，修改库本身需开源）、`OFL`（SIL 开源字体许可证）。`dependencies` / `devDependencies` 分别指运行时依赖 / 开发期依赖；`renderer bundle` 指渲染进程打包产物；`FFI` 指外部函数接口（JS 调 C/DLL）；`tarball` 指 npm 包压缩包。

## 1. 总表

### 前端运行时（`student-frontend/package.json`，15 个）

| 依赖 | 版本 | 许可证 | 用途（一句话） | 打包去向 |
| --- | --- | --- | --- | --- |
| `@lucide/vue` | 1.58.0 | ISC | 线性图标集（`IconGlyph`） | renderer bundle |
| `@vue/devtools-api` | 8.2.1 | MIT | 开发者工具集成（源码无直接引用） | 随依赖，不单独使用 |
| `axios` | 1.20.0 | MIT | HTTP 客户端（含安全通道拦截器） | renderer bundle |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | Markdown 渲染后 XSS 清洗 | renderer bundle |
| `exceljs` | 4.4.0 | MIT | Excel 导出（样式/列宽） | renderer bundle（按需分包） |
| `html2canvas` | 1.4.1 | MIT | 表格/页面转图片（PDF/PNG 导出） | renderer bundle（按需分包） |
| `jspdf` | 4.2.1 | MIT | PDF 生成 | renderer bundle（按需分包） |
| `jspdf-autotable` | 5.0.9 | MIT | PDF 表格排版 | renderer bundle（按需分包） |
| `marked` | 18.1.1 | MIT | Markdown → HTML（AI 消息） | renderer bundle |
| `pinia` | 4.1.0 | MIT | 状态管理（`theme.js`） | renderer bundle |
| `pinyin-match` | 1.2.10 | MIT | 中文拼音模糊匹配（搜索/候选） | renderer bundle |
| `sortablejs` | 1.15.7 | MIT | 相册管理等拖拽排序 | renderer bundle |
| `vue` | 3.5.44 | MIT | 框架（3.6 预览走 `vue36/`） | renderer bundle |
| `vue-router` | 5.4.0 | MIT | 路由 | renderer bundle |
| `xlsx` | 0.20.3 | Apache-2.0 | Excel/CSV 解析与导出 | renderer bundle（按需分包） |

前端开发期（4 个，不进产物）：`vite`、`@vitejs/plugin-vue`、`tailwindcss`、`@tailwindcss/vite`（均 MIT）。

### 后端运行时（`student-backend/package.json`，12 个）

见 [backend.md](./backend.md)。均为 MIT / BSD / Apache-2.0，无 GPL 类强传染许可（FFmpeg 为 LGPL，单独随包）。

### 根依赖（运行时 2 + 开发期 9）

| 依赖 | 版本 | 类型 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `koffi` | 3.3.3 | 运行时（原生 `FFI`（外部函数接口）） | MIT | 调 `pdh.dll`/`user32`（专用工作集、窗口置底） |
| `ui-ux-pro-max-cli` | 2.15.0 | 运行时（开发辅助） | MIT | 安装 UI/UX Pro Max 技能给 AI 编码助手（`uipro` 命令），应用源码不引用 |
| `electron` | 44.9.3 | 开发期 | MIT | 桌面运行时 |
| `electron-builder` | 26.17.0 | 开发期 | MIT | 打包（`--dir`） |
| `@electron/rebuild` | 4.2.1 | 开发期 | MIT | 原生模块按 Electron ABI 重编译 |
| `concurrently` | 10.0.6 | 开发期 | MIT | 并行跑 Vite + Electron |
| `wait-on` | 9.5.1 | 开发期 | MIT | 等待端口就绪 |
| `eslint` | 10.13.0 | 开发期 | MIT | 代码检查 |
| `@eslint/js` | 10.0.1 | 开发期 | MIT | ESLint 官方配置包 |
| `eslint-plugin-vue` | 10.11.1 | 开发期 | MIT | Vue 规则 |
| `globals` | 17.13.0 | 开发期 | MIT | 全局变量定义 |

## 2. 随包资源（不是 npm 依赖，但同样涉及许可）

| 资源 | 位置 | 许可证 | 说明 |
| --- | --- | --- | --- |
| FFmpeg（LGPL 版） | [`resources/ffmpeg/`](../../../resources/ffmpeg/) | LGPL-2.1 | 视频封面抓帧；`COPYING.LGPLv2.1` 随目录 |
| Noto Sans SC | [`student-frontend/public/NotoSansSC-6.ttf(.gz)`](../../../student-frontend/public/) | SIL OFL 1.1 | PDF 中文嵌入；仓库未单独收录 OFL 全文，见 [licenses.md](./licenses.md) |
| 安装器素材 | [`electron/installer-assets/`](../../../electron/installer-assets/) | 自有 | 图标、协议文本、背景图 |
| 第三方许可声明 | 安装包内 `third-party-licenses.zip` | Chromium 各组件的许可 | 由 `afterPack.js` 压缩原 `LICENSES.chromium.html` |

## 3. 打包去向速查

| 去向 | 含义 | 例子 |
| --- | --- | --- |
| renderer bundle | 打进 `student-frontend/dist` 的 JS/CSS | vue、axios、marked |
| asar 内 | 打进 `app.asar`（由主进程/后端读取） | koffi（`*.node` 走 asarUnpack） |
| asarUnpack | 落在 `app.asar.unpacked`（原生模块/子进程） | `student-backend/**`、`node_modules/**/*`、`*.node`、`resources/ffmpeg/**` |
| 仅开发期 | 不参与打包 | vite、eslint、electron-builder |
| 随安装包但不在 asar | 由 Inno 收集 | 安装器素材、FFmpeg |

## 4. 维护标准

- 增删依赖时同批更新本目录三份明细与 [licenses.md](./licenses.md)，并核对 `electron-builder.json` 的 `files` 排除规则。
- 新增原生模块必须确认 `asarUnpack` 与 ABI 重编译（`@electron/rebuild`）。
- 许可合规：不得删除随包的第三方许可文本；FFmpeg 只保留 LGPL 版。
