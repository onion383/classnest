# 后端依赖明细（`student-backend/package.json`）

12 个运行时依赖，无开发期依赖（测试用根目录的 `node:test`（Node 内置测试框架））。原生模块与 `asarUnpack`（不打进 asar 包）/ `ABI`（二进制接口）重编译见 [build-and-branches.md](../topics/build-and-branches.md)。每节标题是「包名 + 版本 + 许可证」，中文用途写在标题下的「用途」行。

## 运行时依赖

### [`express`](../../../student-backend/node_modules/express) 5.3.0 · MIT · Web 服务框架
- 用途：HTTP 服务与路由。
- 使用位置：[`app.js`](../../../student-backend/app.js) 及全部 `routes/*.js`。
- 打包：`student-backend/**` 整体进 `app.asar.unpacked`（后端要 fork）。

### [`cors`](../../../student-backend/node_modules/cors) 2.8.6 · MIT · 跨域中间件
- 用途：跨源白名单。
- 使用位置：[`app.js`](../../../student-backend/app.js)（只放行本机来源）。

### [`jsonwebtoken`](../../../student-backend/node_modules/jsonwebtoken) 9.0.3 · MIT · JWT 令牌库
- 用途：JWT 签发与校验。
- 使用位置：[`middleware/auth.js`](../../../student-backend/middleware/auth.js)、[`routes/auth.js`](../../../student-backend/routes/auth.js)、[`routes/account.js`](../../../student-backend/routes/account.js)。

### [`bcryptjs`](../../../student-backend/node_modules/bcryptjs) 3.0.3 · BSD-3-Clause · 密码哈希库
- 用途：密码哈希/比对（纯 JS）。
- 使用位置：[`services/bcryptAsync.js`](../../../student-backend/services/bcryptAsync.js)（唯一入口）、`routes/auth.js`、`routes/account.js`。
- **备注**：必须走异步封装，同步版会阻塞事件循环 56~65ms。

### [`better-sqlite3-multiple-ciphers`](../../../student-backend/node_modules/better-sqlite3-multiple-ciphers) 13.0.3 · MIT · 加密 SQLite 驱动
- 用途：加密 SQLite（SQLCipher 兼容，支持 `PRAGMA key`）。
- 使用位置：[`dbManager/dbManager.conn.js`](../../../student-backend/dbManager/dbManager.conn.js)（懒加载）。
- 打包：原生 `.node` 走 `asarUnpack`；`electron-builder.json` 剔除源码目录与其它平台预编译产物。
- **备注**：改 Electron 版本后必须 `@electron/rebuild`。

### [`multer`](../../../student-backend/node_modules/multer) 2.5.0（声明 `^2.4.0`） · MIT · 文件上传中间件
- 用途：multipart 上传。
- 使用位置：[`app.js`](../../../student-backend/app.js)（班费收据）、[`routes/ai/ai.upload.js`](../../../student-backend/routes/ai/ai.upload.js)（AI 附件，临时目录）。
- **备注**：收据限制 10MB + 扩展名/MIME/魔数三重校验。

### [`pdf-parse`](../../../student-backend/node_modules/pdf-parse) 2.4.5 · Apache-2.0 · PDF 解析库
- 用途：PDF 文本提取。
- 使用位置：[`routes/ai/ai.upload.js`](../../../student-backend/routes/ai/ai.upload.js)（配合 [`services/pdfDomShim.js`](../../../student-backend/services/pdfDomShim.js)）。
- 打包：剔除 web/esm/worker/node/bin 等无用产物。
- **备注**：用 `PDFParse` 类，用完 `destroy()`。

### [`mammoth`](../../../student-backend/node_modules/mammoth) 1.13.0 · BSD-2-Clause · Word 解析库
- 用途：Word（.docx/.doc）文本提取。
- 使用位置：[`routes/ai/ai.upload.js`](../../../student-backend/routes/ai/ai.upload.js)。
- 打包：剔除浏览器版与测试目录。

### [`xlsx`](../../../student-backend/node_modules/xlsx) 0.20.3 · Apache-2.0 · 表格解析/导出库
- 用途：Excel/CSV 文本提取（AI 附件）。
- 使用位置：[`routes/ai/ai.upload.js`](../../../student-backend/routes/ai/ai.upload.js)。
- **备注**：与前端同一来源 tarball（`cdn.sheetjs.com`）。

### [`sharp`](../../../student-backend/node_modules/sharp) 0.35.5 · Apache-2.0 · 图像处理库
- 用途：图片解码/缩放/旋转（缩略图、EXIF 方向）。
- 使用位置：[`albumThumbs.js`](../../../student-backend/albumThumbs.js)、[`albumScan.js`](../../../student-backend/albumScan.js)、[`albumExif.js`](../../../student-backend/albumExif.js)、[`routes/album.js`](../../../student-backend/routes/album.js)。
- **备注**：libuv 线程池是进程级，扫描因此放独立子进程；缩略图并发上限 4。

### [`yauzl`](../../../student-backend/node_modules/yauzl) 3.4.0 · MIT · ZIP 解压库
- 用途：zip 解压（安全解压实现的基础）。
- 使用位置：[`services/unzipSafe.js`](../../../student-backend/services/unzipSafe.js)、[`services/ffmpeg.js`](../../../student-backend/services/ffmpeg.js)。

### [`pinyin-match`](../../../student-frontend/node_modules/pinyin-match) 1.2.10 · MIT · 拼音模糊匹配
- 用途：拼音模糊匹配（AI 姓名查找）。
- 使用位置：AI 工具执行器（`executors.common.js` 懒加载）、`routes/search.js`。
- **备注**：与前端共用同一版本。

## 打包去向

- 全部运行时依赖随 `student-backend/**` 进入 `app.asar.unpacked`（`asarUnpack` 规则），保证子进程与 `.node` 可加载。
- `electron-builder.json` 对 `better-sqlite3-multiple-ciphers`、`pdf-parse`、`mammoth`、`xlsx`、`koffi` 等做了体积裁剪，规则见 [build-and-branches.md](../topics/build-and-branches.md)。
