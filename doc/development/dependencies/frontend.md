# 前端依赖明细（`student-frontend/package.json`）


## 运行时依赖（15）

### [`@lucide/vue`](../../../student-frontend/node_modules/@lucide/vue) 1.58.0 · ISC · 线性图标库
- 用途：线性图标源。
- 使用位置：[`components/base/IconGlyph.vue`](../../../student-frontend/src/components/base/IconGlyph.vue)（统一图标组件）+ [`IconGlyph.shapes.js`](../../../student-frontend/src/components/base/IconGlyph.shapes.js)（图标形状数据）、[`views/AboutView.vue`](../../../student-frontend/src/views/AboutView.vue)（关于页）。
- 打包：renderer bundle（按图标名静态引用，利于 tree-shaking）。
- **备注**：新增图标要同时补 emoji（主题 `iconStyle` 可切换）。

### [`@vue/devtools-api`](../../../student-frontend/node_modules/@vue/devtools-api) 8.2.1 · MIT · Vue 开发者工具接口
- 用途：Vue Devtools 集成 API。
- 使用位置：源码无直接 import（由 Pinia 等间接使用）。
- 打包：依赖链进入 bundle；无直接调用。
- **备注**：属传递性依赖，删除前先确认 `pinia` 是否需要。

### [`axios`](../../../student-frontend/node_modules/axios) 1.20.0 · MIT · HTTP 客户端
- 用途：HTTP 客户端。
- 使用位置：[`src/main.js`](../../../student-frontend/src/main.js)（应用入口，全局配置 + 拦截器）、[`composables/secureAxios.js`](../../../student-frontend/src/composables/secureAxios.js)（安全通道装配）、[`utils/httpClient.js`](../../../student-frontend/src/utils/httpClient.js)（axios 装配）、各页面。
- 打包：renderer bundle。
- **备注**：网络错误重试逻辑在 `main.js` 响应拦截器；写请求不自动重发。

### [`dompurify`](../../../student-frontend/node_modules/dompurify) 3.4.17 · MPL-2.0 OR Apache-2.0 · HTML 清洗库
- 用途：HTML 清洗，防 XSS。
- 使用位置：[`composables/ai/aiMarkdown.js`](../../../student-frontend/src/composables/ai/aiMarkdown.js)（异步懒加载，`afterSanitizeAttributes` 钩子）。
- 打包：renderer bundle（按需动态导入）。
- **备注**：AI 输出经 `marked` → `dompurify` 再渲染；两者都在 `aiMarkdown.js` 内统一管理。

### [`exceljs`](../../../student-frontend/node_modules/exceljs) 4.4.0 · MIT · Excel 导出库
- 用途：带样式/列宽的 Excel 导出。
- 使用位置：[`components/import-export/ExportExcel/ExportExcel.exporters.js`](../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.exporters.js)。
- 打包：renderer bundle（按需动态导入，导出时才加载）。

### [`html2canvas`](../../../student-frontend/node_modules/html2canvas) 1.4.1 · MIT · 网页转图片库
- 用途：把 DOM 表格渲染成图片。
- 使用位置：同上（PDF / PNG 导出路径）。
- 打包：renderer bundle（按需）。
- **备注**：超长表会崩，相册索引导出因此屏蔽图片格式。

### [`jspdf`](../../../student-frontend/node_modules/jspdf) 4.2.1 · MIT · PDF 生成库
- 用途：PDF 生成。
- 使用位置：同上 + [`composables/exportFormats.js`](../../../student-frontend/src/composables/exportFormats.js)。
- 打包：renderer bundle（按需）。
- **备注**：中文字体走动态子集（[`utils/pdfFont.js`](../../../student-frontend/src/utils/pdfFont.js)）。

### [`jspdf-autotable`](../../../student-frontend/node_modules/jspdf-autotable) 5.0.9 · MIT · PDF 表格排版
- 用途：PDF 表格排版。
- 使用位置：[`ExportExcel.exporters.js`](../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.exporters.js)（导出格式实现）、[`exportFormats.js`](../../../student-frontend/src/composables/exportFormats.js)（导出格式注册表）。

### [`marked`](../../../student-frontend/node_modules/marked) 18.1.1 · MIT · Markdown 解析库
- 用途：Markdown → HTML。
- 使用位置：[`composables/ai/aiMarkdown.js`](../../../student-frontend/src/composables/ai/aiMarkdown.js)（`import('marked')` 懒加载，供 AI 消息渲染）。

### [`pinia`](../../../student-frontend/node_modules/pinia) 4.1.0 · MIT · 状态管理库
- 用途：状态管理。
- 使用位置：[`src/main.js`](../../../student-frontend/src/main.js)（应用入口）、[`stores/theme.js`](../../../student-frontend/src/stores/theme.js)（主题 store）、`IconGlyph`（图标组件）、`Sidebar`（侧边栏）。
- **备注**：全应用只有一个 store（主题）。

### [`pinyin-match`](../../../student-frontend/node_modules/pinyin-match) 1.2.10 · MIT · 拼音模糊匹配
- 用途：拼音模糊匹配。
- 使用位置：[`components/base/SearchDialog.vue`](../../../student-frontend/src/components/base/SearchDialog.vue)（全局搜索弹窗）、[`views/SettingsView/searchData.js`](../../../student-frontend/src/config/searchData.js)（搜索数据源）。
- **备注**：后端也依赖同版本（AI 工具里的姓名匹配）。

### [`sortablejs`](../../../student-frontend/node_modules/sortablejs) 1.15.7 · MIT · 拖拽排序库
- 用途：拖拽排序。
- 使用位置：[`components/dialogs/AlbumManageDialog.vue`](../../../student-frontend/src/components/dialogs/AlbumManageDialog.vue)（`import('sortablejs')` 懒加载，用于相册拖拽排序）。
- **备注**：`AboutView` 只在「第三方库致谢」里提到它，不是运行使用。

### [`vue`](../../../student-frontend/node_modules/vue) 3.5.44 · MIT · 前端框架
- 用途：框架主运行时。
- 使用位置：全部 SFC 与应用入口。
- 打包：renderer bundle。
- **备注**：3.6 预览版单独装在 [`vue36/`](../../../student-frontend/vue36/package.json)，不影响主线；见 [build-and-branches.md](../topics/build-and-branches.md)。

### [`vue-router`](../../../student-frontend/node_modules/vue-router) 5.4.0 · MIT · 路由库
- 用途：路由。
- 使用位置：[`router/index.js`](../../../student-frontend/src/router/index.js)（路由表）、`App.vue`（根组件）、`Sidebar.vue`（侧边栏）。

### [`xlsx`](../../../student-frontend/node_modules/xlsx) 0.20.3 · Apache-2.0 · 表格解析/导出库
- 用途：Excel/CSV 解析与简单导出。
- 使用位置：[`AiComposer.vue`](../../../student-frontend/src/components/ai/AiComposer/AiComposer.vue)（AI 输入器，附件预览）、[`ExportExcel.exporters.js`](../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.exporters.js)（导出格式实现）。
- 打包：renderer bundle（按需）。
- **备注**：来源是 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（非 npm registry），升级时核对来源与许可。

---

## 开发期依赖（4，不进产物）

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [`vite`](../../../student-frontend/node_modules/vite) | 8.3.4 | MIT | 开发服务器与构建 |
| [`@vitejs/plugin-vue`](../../../student-frontend/node_modules/@vitejs/plugin-vue) | 6.0.10 | MIT | SFC 编译 |
| [`tailwindcss`](../../../student-frontend/node_modules/tailwindcss) | 4.3.3 | MIT | 原子化 CSS |
| [`@tailwindcss/vite`](../../../student-frontend/node_modules/@tailwindcss/vite) | 4.3.3 | MIT | Tailwind 的 Vite 插件 |

许可证原文见 [licenses.md](./licenses.md)。

---
