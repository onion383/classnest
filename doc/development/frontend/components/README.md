# 前端组件（`student-frontend/src/components/`）

共 76 个 `.vue`，按目录分节。所有组件都是 `SFC`（单文件组件）+ `<script setup>`（组合式 API 简洁脚本），多数带 `vapor`（Vue 3.6 Vapor 渲染模式）标记，见第 5 节。


## 1. 通用标准

| 标准 | 说明 |
| --- | --- |
| 受控优先 | 表格/网格/弹窗都只维护交互细节，数据与接口调用交给宿主页或 `composable`（组合式函数，如 `useTableCRUD`、`useSeatGrid`） |
| 浮层 | 下拉、候选、右键菜单统一 `Teleport`（挂载到 body 的传送组件）+ `position: fixed`（固定定位），避免被父级 `overflow`（溢出裁剪）/`transform`（变换）/`backdrop-filter`（背景模糊）裁剪 |
| 层级 | 浮层 `z-index`（层叠层级）从祖先链动态取（如 `AppSelect` 的 `_layerZ()`），不写死魔法数字 |
| 弹窗 | 统一 `<Transition name="dialog">`（进出过渡组件）+ `.dialog-card`（弹窗卡片动画类）；遮罩点击由 `utils/dialogOverlayPulse.js` 接管（提示「请关闭弹窗」，不关闭） |
| 空态 | 列表型 `DynamicTable`（动态列表格）用 `EmptySnapshot`（空态组件），操作按钮走 `action-text` / `action-icon` / `@action`；`GridView`（网格表）不做空态 |
| 图标 | 统一 `IconGlyph`（图标组件，全局注册），按主题 `iconStyle`（图标样式）在 `lucide`（线性图标）/ `emoji`（表情）间切换 |
| 样式 | 只用主题 CSS 变量与工具类，不改主题全局皮肤；按钮悬浮态同带 `transition-theme`（主题过渡工具类） |

### 1.1 通用对外接口标准

各组件条目里的 `props` / `emits` 按下面的通用含义解释；组件特有接口在各自条目中补充说明。

| 名称 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `visible` | `Boolean` / `false` | 弹窗或浮层是否显示；`false` 时不渲染或不可交互。 |
| `show` | `Boolean` / `false` | 同 `visible`，用于少数弹窗的命名习惯。 |
| `modelValue` | 任意 / — | `v-model` 绑定的值；更新时抛 `update:modelValue`。 |
| `disabled` | `Boolean` / `false` | 是否禁用交互（按钮、输入、整块区域）。 |
| `busy` / `loading` | `Boolean` / `false` | 请求或异步处理中，禁用重复提交并显示等待态。 |
| `title` | `String` / — | 弹窗、卡片或区块标题。 |
| `options` | `Array` / `[]` | 下拉、单选、多选的候选列表。 |
| `rows` / `cols` | `Number` / — | 网格行数 / 列数。 |
| `students` | `Array` / `[]` | 学生名单，元素至少含 `id` / `name`。 |
| `fields` | `Array` / `[]` | 动态列定义（列名、类型、必填等）。 |
| `editingRecord` | `Object` / `null` | 正在编辑的记录；`null` 表示新增。 |
| `initialValues` | `Object` / `{}` | 新增/编辑时的初始字段值。 |
| `mode` | `String` / 视组件而定 | 模式标识（如 `daily` / `big`、`single` / `desk`、`personal` / `group`）。 |
| `items` | `Array` / `[]` | 列表数据项（如相册照片、值日项目、统计数据）。 |
| `weights` | `Object` / `{}` | 权重矩阵或权重表。 |
| `ledger` | `Object` / `{}` | 指数账本（座位/值日累计）。 |
| `draft` | `Object` / `{}` | 草稿对象；`exists` 表示是否已有草稿。 |
| `close` | emit | 关闭弹窗/浮层/抽屉。 |
| `cancel` | emit | 取消本次操作，不保存。 |
| `confirm` | emit | 确认并提交本次操作。 |
| `save` | emit | 保存当前编辑内容。 |
| `update:modelValue` | emit | `v-model` 值变更，payload 为新值。 |
| `update:<prop>` | emit | 某个 prop 的受控更新，payload 为新值（如 `update:modelId`）。 |
| `select` | emit | 选中某项，payload 通常为 id 或选项值。 |
| `delete` | emit | 删除某项，payload 通常为 id。 |
| `change` / `changed` | emit | 数据已变更，通知宿主刷新。 |
| `saved` | emit | 保存完成，payload 为保存后的记录或 id。 |
| `apply` | emit | 应用当前配置/权重/排表结果。 |

---

## 2. 目录索引

目录名含义：`layout`（布局）、`base`（基础件）、`tables`（表格与网格）、`dialogs`（业务弹窗）、`import-export`（导入导出）、`ai`（AI 界面）、`album`（相册）、`data-manage`（数据管理）；根级组件直接在 `components/*.vue`。

| 子文档 | 目录 | 数量 |
| --- | --- | --- |
| [layout.md（布局）](./layout.md) | `layout/` | 1 |
| [base.md（基础件）](./base.md) | `base/` | 21 |
| [tables.md（表格与网格）](./tables.md) | `tables/` | 6 |
| [dialogs.md（业务弹窗）](./dialogs.md) | `dialogs/` | 28 |
| [import-export.md（导入导出）](./import-export.md) | `import-export/` | 4 |
| [ai.md（AI 界面）](./ai.md) | `ai/` | 6 |
| [album.md（相册）](./album.md) | `album/` | 1 |
| [data-manage.md（数据管理）](./data-manage.md) | `data-manage/` | 4 |
| [root.md（根级组件）](./root.md) | `components/*.vue` | 5 |

---

## 3. 全局注册与跨页复用

- `IconGlyph`（图标组件）在 [`src/main.js`](../../../../student-frontend/src/main.js) 全局注册，模板中直接 `<IconGlyph name="..." />`。
- `ConfirmDialog`（确认框）、`DialogShell`（弹窗外壳）、`EmptySnapshot`（空态）、`CustomScrollbar`（自定义滚动条）被几乎所有业务弹窗复用，改动影响面大。
- `ExportExcel`（导出面板）被 10 个页面复用，导出格式扩展集中在 [`ExportExcel.exporters.js`](../../../../student-frontend/src/components/import-export/ExportExcel/ExportExcel.exporters.js)（格式实现）与 [`src/composables/exportFormats.js`](../../../../student-frontend/src/composables/exportFormats.js)（格式注册）。

---

## 4. 组件写法标准

- `defineOptions({ name })`（声明组件选项，含组件名）与组件文件名一致；`props`（组件属性）给默认值，数组 / 对象用工厂函数（避免共享引用）。
- `v-model`（双向绑定）一律 `modelValue`（当前值）+ `update:modelValue`（值更新事件）；双向绑定的事件统一叫 `update:*`。
- 暴露给宿主的方法必须 `defineExpose`（组件对外暴露接口）（`testjs/behavior/expose-contract.test.js`（标准校验用例）会检查）。
- 禁止 `getCurrentInstance`（取组件实例的函数）/ `$refs`（模板引用集合）/ 实例代理（`testjs/behavior/sfc-conventions.test.js`（架构标准用例）会检查）。

---

## 5. Vapor 标记

- 组件可写 `<script setup vapor>`（Vapor 编译标记）；Vue 3.5 会逐字忽略该属性，因此同一份源码在 3.5 / 3.6 两条通道都能编译。
- 拼错标记**不报错、只静默失效**，验证必须跑 `node testjs/probe/vapor-verify.mjs`（Vapor 产物校验脚本）（判据只看 `__vapor: true`（产物里的 Vapor 标记字段））。

---
