# 依赖许可证

## 1. 收录方式

- 全文：按许可证类型各收一份，放在 [`licenses/`](./licenses/)（原文从各包 `LICENSE` 文件复制，未改写）。
- 版权行：逐包列出（取自各包 `LICENSE` 首条 Copyright）。
- 同类型多包共用一份全文；每包只标注类型与版权行，避免 20 份重复的 MIT。
- 下表中的 `Copyright (c) ...` 是各包原始版权声明，按许可证要求保留英文原文；许可证类型（MIT / ISC / Apache-2.0 等）的中文说明见 [README.md](./README.md)。

| 许可证 | 全文文件 | 来源 |
| --- | --- | --- |
| MIT | [`licenses/MIT.txt`](./licenses/MIT.txt) | `node_modules/axios/LICENSE` |
| ISC | [`licenses/ISC.txt`](./licenses/ISC.txt) | `student-frontend/node_modules/@lucide/vue/LICENSE` |
| Apache-2.0 | [`licenses/Apache-2.0.txt`](./licenses/Apache-2.0.txt) | `student-backend/node_modules/sharp/LICENSE` |
| BSD-2-Clause | [`licenses/BSD-2-Clause.txt`](./licenses/BSD-2-Clause.txt) | `student-backend/node_modules/mammoth/LICENSE` |
| BSD-3-Clause | [`licenses/BSD-3-Clause.txt`](./licenses/BSD-3-Clause.txt) | `student-backend/node_modules/bcryptjs/LICENSE` |
| LGPL-2.1 | [`licenses/LGPL-2.1.txt`](./licenses/LGPL-2.1.txt) | `resources/ffmpeg/COPYING.LGPLv2.1` |
| SIL OFL 1.1 | 仓库未收录全文 | 见第 4 节 |

## 2. 前端依赖

| 包 | 版本 | 许可证 | 版权行 |
| --- | --- | --- | --- |
| `@lucide/vue` | 1.58.0 | ISC | Copyright (c) 2026 Lucide Icons and Contributors |
| `@vue/devtools-api` | 8.2.1 | MIT | Copyright (c) 2023 webfansplz |
| `axios` | 1.20.0 | MIT | Copyright (c) 2014-present Matt Zabriskie & Collaborators |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | 采用 Apache-2.0 分支；版权归 Cure53 / DOMPurify contributors |
| `exceljs` | 4.4.0 | MIT | Copyright (c) 2014-2019 Guyon Roche |
| `html2canvas` | 1.4.1 | MIT | Copyright (c) 2012 Niklas von Hertzen |
| `jspdf` | 4.2.1 | MIT | 版权归 James Hall 及贡献者（LICENSE 原文含 Copyright 声明） |
| `jspdf-autotable` | 5.0.9 | MIT | Copyright (c) 2014 Simon Bengtsson |
| `marked` | 18.1.1 | MIT | Copyright (c) 2018+, MarkedJS |
| `pinia` | 4.1.0 | MIT | Copyright (c) 2019-present Eduardo San Martin Morote |
| `pinyin-match` | 1.2.10 | MIT | Copyright (c) 2020 All contributors to pinyin-match |
| `sortablejs` | 1.15.7 | MIT | Copyright (c) 2019 All contributors to Sortable |
| `vue` | 3.5.44 | MIT | Copyright (c) 2018-present, Yuxi (Evan) You |
| `vue-router` | 5.4.0 | MIT | Copyright (c) 2019-present Eduardo San Martin Morote |
| `xlsx` | 0.20.3 | Apache-2.0 | SheetJS Community Edition；版权归 SheetJS LLC |
| `vite` | 8.3.4 | MIT | 版权归 Vite contributors |
| `@vitejs/plugin-vue` | 6.0.10 | MIT | 版权归 Vite contributors |
| `tailwindcss` | 4.3.3 | MIT | 版权归 Tailwind Labs, Inc. |
| `@tailwindcss/vite` | 4.3.3 | MIT | 版权归 Tailwind Labs, Inc. |

## 3. 后端依赖

| 包 | 版本 | 许可证 | 版权行 |
| --- | --- | --- | --- |
| `express` | 5.3.0 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk |
| `cors` | 2.8.6 | MIT | Copyright (c) 2013 Troy Goode |
| `jsonwebtoken` | 9.0.3 | MIT | Copyright (c) 2015 Auth0, Inc. |
| `bcryptjs` | 3.0.3 | BSD-3-Clause | Copyright (c) 2012 Nevins Bartolomeo |
| `better-sqlite3-multiple-ciphers` | 13.0.3 | MIT | Copyright (c) 2021 Mahesh Bandara Wijerathna |
| `multer` | 2.5.0 | MIT | Copyright (c) 2014 Hage Yaapa |
| `pdf-parse` | 2.4.5 | Apache-2.0 | 版权归 pdf-parse contributors |
| `mammoth` | 1.13.0 | BSD-2-Clause | Copyright (c) 2013, Michael Williamson |
| `xlsx` | 0.20.3 | Apache-2.0 | 同前端（SheetJS LLC） |
| `sharp` | 0.35.5 | Apache-2.0 | 版权归 Lovell Fuller 及贡献者 |
| `yauzl` | 3.4.0 | MIT | Copyright (c) 2014 Josh Wolfe |
| `pinyin-match` | 1.2.10 | MIT | 同前端 |

## 4. 根依赖与随包资源

| 包 / 资源 | 版本 | 许可证 | 版权行 / 说明 |
| --- | --- | --- | --- |
| `koffi` | 3.3.3 | MIT | Copyright (C) 2026 Niels Martignène |
| `ui-ux-pro-max-cli` | 2.15.0 | MIT（`package.json` 声明） | 包内未附 LICENSE 文件 |
| `electron` | 44.9.3 | MIT | Copyright (c) Electron contributors |
| `electron-builder` | 26.17.0 | MIT | Copyright (c) 2015 Loopline Systems |
| `@electron/rebuild` | 4.2.1 | MIT | Copyright (c) Contributors to the Electron project |
| `concurrently` | 10.0.6 | MIT | Copyright (c) 2015 Kimmo Brunfeldt |
| `wait-on` | 9.5.1 | MIT | Copyright (c) 2015 Jeff Barczewski |
| `eslint` | 10.13.0 | MIT | Copyright OpenJS Foundation and other contributors |
| `@eslint/js` | 10.0.1 | MIT | Copyright OpenJS Foundation and other contributors |
| `eslint-plugin-vue` | 10.11.1 | MIT | Copyright (c) 2017 Toru Nagashima |
| `globals` | 17.13.0 | MIT | Copyright (c) Sindre Sorhus |
| FFmpeg | LGPL 版 | LGPL-2.1 | 全文在 [`licenses/LGPL-2.1.txt`](./licenses/LGPL-2.1.txt)（源 `resources/ffmpeg/COPYING.LGPLv2.1`） |
| Noto Sans SC | — | SIL OFL 1.1 | 仓库未收录 OFL 全文；官方原文 <https://openfontlicense.org/open-font-license-official-text/>。分发字体时须随附该许可与版权声明，不得单独以字体名售卖 |
| Chromium / Electron 组件 | 随 Electron 版本 | 各自许可 | 安装包内 `third-party-licenses.zip`（由 `electron/afterPack.js` 在打包后压缩 `LICENSES.chromium.html` 生成） |

## 5. MPL-2.0 说明（DOMPurify）

`dompurify` 声明为 `MPL-2.0 OR Apache-2.0`，本项目按 **Apache-2.0** 分支使用：

- 不修改 DOMPurify 源码，只作为依赖引入；
- 若未来修改其源码，需按 MPL-2.0 公开修改部分，或继续遵循 Apache-2.0 分支。

## 6. 维护

- 升级依赖后重跑本文件的核对：`package.json` 的 `license` 字段 + 包内 `LICENSE` 首条 Copyright。
- 新增 Apache-2.0 / LGPL / OFL 类依赖时，确认随包分发许可文本，不允许删除 `third-party-licenses.zip`。
- 许可证全文只从包内文件复制，不手写、不删改。
