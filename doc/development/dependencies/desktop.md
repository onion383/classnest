# 桌面端依赖与随包资源

## 1. 根 `package.json`

### 运行时

#### [`koffi`](../../../node_modules/koffi) 3.3.3 · MIT · FFI 库
- 用途：纯 N-API 的 FFI 绑定（免 node-gyp / electron-rebuild），调 Windows 原生 API。
- 使用位置：
  - [`electron/main/main.privateWorkingSet.js`](../../../electron/main/main.privateWorkingSet.js)：`pdh.dll` 读「专用工作集」。
  - [`electron/main/main.desktop-layer.js`](../../../electron/main/main.desktop-layer.js)：`user32` 的 `SetWindowPos` 做桌面置底。
- 打包：`*.node` 走 `asarUnpack`；`electron-builder.json` 剔除 `koffi/vendor` 与 `cnoke.cjs`。
- **备注**：`decode(ptr, type, length)` 第三参是长度；Win32 BOOL 非 0 为成功（`Set/GetSecurityInfo` 例外）。

#### [`ui-ux-pro-max-cli`](../../../node_modules/ui-ux-pro-max-cli) 2.15.0 · MIT（包内未附 LICENSE 文件，按 `package.json` 声明） · UI/UX 技能安装器
- 用途：给 AI 编码助手安装 UI/UX Pro Max 技能的 CLI（bin `uipro`）。
- 使用位置：仅根 `package.json` 声明，应用源码与构建脚本未引用。
- **备注**：属于开发辅助；不影响打包产物。

### 开发期（10 个，均 MIT，不进产物）

| 依赖 | 版本 | 用途 | 使用位置 |
| --- | --- | --- | --- |
| [`electron`](../../../node_modules/electron) | 45.2.3 | 桌面运行时 | `main: electron/main/main.js` |
| [`electron-builder`](../../../node_modules/electron-builder) | 26.17.0（声明 `^26.15.3`） | 打包（`--dir`） | `npm run electron:build` |
| [`esbuild`](../../../node_modules/esbuild) | 0.28.2 | 把后端合成单文件 `app.bundle.js`（v6 · 2-17 启动优化） | `npm run build:backend` |
| [`@electron/rebuild`](../../../node_modules/@electron/rebuild) | 4.2.1 | 原生模块按 Electron ABI 重编译 | `postinstall` / 手动 |
| [`concurrently`](../../../node_modules/concurrently) | 10.0.6 | 并行跑 Vite + Electron | `electron:dev` / `electron:dev36` |
| [`wait-on`](../../../node_modules/wait-on) | 9.5.1 | 等待端口就绪 | 开发脚本 |
| [`eslint`](../../../node_modules/eslint) | 10.13.0 | 代码检查 | `npm run lint` |
| [`@eslint/js`](../../../node_modules/@eslint/js) | 10.0.1 | ESLint 官方配置 | [`eslint.config.mjs`](../../../eslint.config.mjs) |
| [`eslint-plugin-vue`](../../../node_modules/eslint-plugin-vue) | 10.11.1 | Vue 规则 | 同上 |
| [`globals`](../../../node_modules/globals) | 17.13.0 | 全局变量定义 | 同上 |

---

## 2. 随包二进制与资源

| 资源 | 位置 | 许可证 | 用途 / 打包方式 |
| --- | --- | --- | --- |
| FFmpeg（LGPL 版） | [`resources/ffmpeg/`](../../../resources/ffmpeg/) | LGPL-2.1（`COPYING.LGPLv2.1` 随目录） | 视频封面抓帧；`asarUnpack`，随安装包 |
| Noto Sans SC | [`student-frontend/public/NotoSansSC-6.ttf(.gz)`](../../../student-frontend/public/) | SIL OFL 1.1 | PDF 中文字体；`.ttf` 不进包，`.gz` 随包（8.0MB） |
| 安装器图标/素材 | [`electron/installer-assets/`](../../../electron/installer-assets/) | 自有 | 安装/卸载图标、协议文本、输入框背景 |
| 向导图片 | [`electron/inno/wizard-large.bmp`](../../../electron/inno/)、`wizard-small.bmp` | 自有 | Inno 安装向导 |
| 应用图标 | [`electron/app-icon.png`](../../../electron/app-icon.png)、`student-frontend/public/logo-icon.png` | 自有 | 窗口/任务栏/安装器 |
| 托盘图标 | [`electron/tray-icon.png`](../../../electron/tray-icon.png) | 自有 | 系统托盘 |
| 第三方许可 | 安装包内 `third-party-licenses.zip` | Chromium 各组件 | `afterPack.js` 由 `LICENSES.chromium.html` 压缩生成 |

---

## 3. FFmpeg 注意事项（红线）

- 只保留 LGPL 版；`resources/ffmpeg/`、`electron/inno/compile.mjs`、`electron-builder.json` 不要随意改动；改前核 `sha256`。
- 构建必须保留 x86asm（nasm 汇编路径）；`--disable-x86asm` 会让 scale 滤镜落回被 GCC 8.1 编坏的 C 实现，封面花屏。
- 临时封面文件必须保持 `.jpg` 后缀（ffmpeg 按扩展名推断封装格式）。

---

## 4. 打包去向

- Electron 本体由 electron-builder 下载并按 `electronLanguages` 裁剪语言包。
- Chromium 组件在 `afterPack` 里再剔一轮（约 -32MB），保留清单见 [performance.md](../topics/performance.md) §5。
- 随包资源：FFmpeg、字体 `.gz`、安装器素材；许可文本必须保留。

---
