/**
 * ESLint 配置（最小规则集，覆盖前端 / 后端 / Electron 主进程）
 *
 * 定位：**只做「低级错误护栏」，不做风格管理**。
 * 不启用 eslint:recommended，也不启用 vue 的规则集——后者大量是审美类
 * （如 multi-word-component-names），对本项目没有价值，只会淹没真正的问题。
 *
 * 三块代码的运行环境不同，规则相同、languageOptions 不同：
 *   student-frontend/src  ESM + 浏览器全局（+ Vue 编译器宏）
 *   student-backend       CJS + Node 全局
 *   electron              CJS + Node 全局；其中 preload.js 跑在渲染进程，还要浏览器全局
 *
 * 用法：npm run lint（根目录一次跑全部）
 *
 * 刻意不做的事：
 *   1. **不挂进 build**：lint 失败不该挡住打包，尤其是历史告警没清完时。
 *   2. **不纳入 testjs/**：探针脚本故意有内联调试代码、临时 node -e 风格，纳入只会产生噪音。
 *   3. **不加格式化类规则**：现有写法是自洽的，强加风格只会制造 diff 噪音。
 *
 * 文件名用 .mjs：根 package.json 是 CJS，.js 会被按 CJS 解析而无法 import 这些 ESM 插件。
 */
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tableRegistry from './student-backend/schema/tableRegistry.js'

// ---------- 共用规则：两档 ----------
const SHARED_RULES = {
  // error：命中即 bug
  'no-undef': 'error', // 用了没定义的变量（运行时会 ReferenceError）
  'no-dupe-keys': 'error', // 对象里重复的键（静默覆盖）
  'no-dupe-args': 'error',
  'no-unreachable': 'error', // return/throw 之后的死代码
  'no-cond-assign': 'error', // if (x = y) 这类赋值笔误
  'no-self-assign': 'error',
  'no-fallthrough': 'error', // switch 漏写 break
  'no-async-promise-executor': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],

  // warn：提示，不阻塞
  // 空 catch 在项目里大量用于探测性代码（localStorage 配额、可选 API 是否存在）
  'no-empty': ['warn', { allowEmptyCatch: true }],
  eqeqeq: ['warn', 'smart'],
  'no-unused-vars': [
    'warn',
    {
      args: 'none', // 事件回调常写多余参数（@click="fn($event)"）
      caughtErrors: 'none', // catch (err) 不处理错误对象是常见意图
      varsIgnorePattern: '^_', // _foo / _ 视为有意占位
      ignoreRestSiblings: true,
    },
  ],
  'no-prototype-builtins': 'warn',
  // 给未声明的变量赋值会静默创建全局变量（CJS 非严格模式不报错）——
  // ai.conversations.js 的 `ask` 就是这么串到并发请求之间的。
  'no-implicit-globals': 'error',
}

// ---------- 架构守卫规则（v6 · 6-1） ----------
// 表名清单散在业务层时，新增一张可撤销表必然漏改一处 —— 漏了不报错，只是静默少记录。
// 名单从 registry 现算，不在配置里再抄一遍（否则规则自己就是第五份清单）。
// 少数表名同时是业务词汇（`schedule` 也是「导出图片 / 图表的数据域」取值），
// 单个出现时无法静态判定为表名清单，强行报错只会制造噪音；这类名字的清单由
// architecture-guard 测试按「命中 2 个以上表名」兜住。
const AMBIGUOUS_TABLE_NAMES = new Set(['schedule'])

const TABLE_NAME_SELECTORS = tableRegistry.ALL_PHYSICAL.concat(tableRegistry.ALL_LOGICAL)
  .filter((name) => !AMBIGUOUS_TABLE_NAMES.has(name))
  .map((name) => `ArrayExpression > Literal[value="${name}"]`)

const ARCH_RULES = {
  'no-restricted-syntax': [
    'error',
    ...TABLE_NAME_SELECTORS.map((selector) => ({
      selector,
      message: '表名清单必须从 schema/tableRegistry.js 引用，不许在业务层手写数组',
    })),
    {
      // 格子类型写魔法数字时，「走廊」和「空位」写反不会报错，只会让那个人从界面上消失。
      // 只认直接比较字面量：右边是 SEAT_CELL.XXX 的正确写法不受影响。
      selector: "BinaryExpression[operator=/^[!=]=$|^[!=]==$/][right.type='Literal'][left.object.object.name='types']",
      message: '格子类型比较必须用 services/sanitize.js 的 SEAT_CELL 常量（0/1/2 是魔法数字）',
    },
  ],
}

// ---------- 源码约定：从测试断言升级而来（写代码时就报，不用等跑测试） ----------
//
// 为什么会有这一块：这类约定的共同点是「错误写法可能在任意文件出现，但测试只覆盖了
// 其中一个文件」。放在 lint 里覆盖面更大，且不必等到有人想起跑测试。
//
// ⚠️ 测试里的同名断言**不删**。项目没有 git 钩子、lint 也不挂 build，
// 所以 lint 是提前量而不是兜底；兜底仍然是 units 里那条断言。
//
// 每条的 selector 都要求「命中即真错」，不做风格判断：
const R_NO_RELOAD = {
  // 桌面应用整页 reload 会丢滚动位置与当前路由；切班/恢复应走 classScope 的收尾。
  // 对应测试：class-scope.test.js「切班不得整页重载」
  selector: "CallExpression[callee.property.name='reload'][callee.object.property.name='location']",
  message: '不要整页 reload：会丢滚动位置与当前路由，改用 classScope 的切换收尾',
}

const R_NO_AXIOS_IN_CLASS_DIALOG = {
  // 这个弹窗是「改完点保存」，读写归调用方；在这里直连接口会绕过保存语义。
  // 对应测试：class-scope.test.js「重命名不应直接调接口」
  selector: "Identifier[name='axios']",
  message: 'ClassInfoDialog 不直连接口：改名走 emit(rename-class)，由调用方统一保存',
}

const R_NO_MANUAL_UNBIND = {
  // 这三个监听已登记进 utils/disposables，再手写一遍解绑是双份维护 ——
  // capture 选项一旦不一致，就是「看起来清了其实没清」。
  // 只列这三个事件名：App.vue 里 mousemove/mouseup 是 stopUnitDrag 的临时监听，必须手写解绑。
  // 对应测试：lifecycle-migration.test.js §5-17
  selector:
    "CallExpression[callee.property.name='removeEventListener'][arguments.0.value=/^(resize|ai-config-changed|mousedown)$/]",
  message: '这个监听已登记进 utils/disposables，不要手写解绑（capture 选项会两处不一致）',
}

const R_NO_TIMER_ID_FIELD = {
  // defer 自带撤销；把 setTimeout 的 id 写回字段会让「取消」变成两套（cancel() 与 clearTimeout）。
  // 对应测试：lifecycle-migration.test.js「不该再把 timer id 写回字段」
  selector: "AssignmentExpression[left.property.name='_measureTimer']",
  message: '测量防抖用 ctx._measureTimer = d.defer()，不要存 setTimeout 的 id',
}

const R_NO_CLEAR_DEFER = {
  // 与上一条配套：既然 id 不再存在，手写 clearTimeout 就是第二套取消路径。
  // 对应测试：lifecycle-migration.test.js「defer 自带撤销，不该再手写 clearTimeout」
  selector:
    "CallExpression[callee.name='clearTimeout'][arguments.0.property.name='_measureTimer']",
  message: 'defer 自带撤销：用 ctx._measureTimer.cancel()，不要 clearTimeout',
}

const R_NO_HARDCODED_PORT = [
  {
    // 端口只有一个来源：config/ports.cjs（读 config/ports.json）。
    // 写死 3000/5173 的后果是「改了端口，某一处仍在连旧端口」——不报错，只是连不上。
    // 对应测试：ports-config.test.js「不得残留写死的端口地址」——那条只查 10 个文件，这里查全仓。
    selector: "Literal[value=/127\\.0\\.0\\.1:(3000|5173)|localhost:(3000|5173)/]",
    message: '不要写死端口：从 config/ports.cjs 取（backendOrigin / frontendOrigin）',
  },
  {
    // 模板串里的端口走 TemplateElement（不是 Literal）。注意 esquery 只支持 =/!=/</>/<=/>=，
    // 不支持 CSS 的 `*=`（踩过：写了 *= 规则静默失效，一条都不报）。
    // 只认具体端口号，不能只匹配 `127.0.0.1:` —— 那样会误伤 `${port}` 这类合法插值。
    selector: 'TemplateElement[value.raw=/127\\.0\\.0\\.1:(3000|5173)/]',
    message: '不要写死端口：从 config/ports.cjs 取（backendOrigin / frontendOrigin）',
  },
  {
    selector: 'TemplateElement[value.raw=/localhost:(3000|5173)/]',
    message: '不要写死端口：从 config/ports.cjs 取（backendOrigin / frontendOrigin）',
  },
]

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-verify-*/**',
      'student-frontend/public/**',
      'student-frontend/origin/**',
      'student-frontend/splash/**',
      'testjs/**',
      'electron/inno/**',
      'resources/**',
      // 后端单文件 bundle（student-backend/build.bundle.mjs 生成的构建产物，不是源码）
      'student-backend/app.bundle.js',
    ],
  },

  // flat/base 只提供 .vue 的 parser 与插件注册，不带任何规则（规则在下面手动开）
  ...pluginVue.configs['flat/base'],

  // ---------- 前端：ESM + 浏览器 ----------
  {
    files: ['student-frontend/src/**/*.{js,vue}'],
    languageOptions: {
      // 2025：backendOrigin.js 用 import attributes 读 config/ports.json（ES2025 语法）
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Vue 编译器宏：<script setup> 里可直接使用，无需 import，ESLint 不认识它们
        defineProps: 'readonly',
        defineEmits: 'readonly',
        defineExpose: 'readonly',
        defineOptions: 'readonly',
        defineSlots: 'readonly',
        defineModel: 'readonly',
        withDefaults: 'readonly',
      },
    },
    rules: { ...SHARED_RULES, 'no-restricted-syntax': ['error', R_NO_RELOAD, ...R_NO_HARDCODED_PORT] },
  },

  // ---------- 后端 + 主进程：CJS + Node ----------
  {
    files: ['student-backend/**/*.js', 'electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...SHARED_RULES, 'no-restricted-syntax': ['error', ...R_NO_HARDCODED_PORT] },
  },

  // ---------- 业务层：架构守卫 ----------
  // 只覆盖 services / routes / utils：schema 是建表事实来源（DDL 必须写表名），
  // registry 自身就是名单，二者都不能套这条规则。
  {
    files: ['student-backend/services/**/*.js', 'student-backend/routes/**/*.js', 'student-backend/utils/**/*.js'],
    rules: ARCH_RULES,
  },

  // ---------- 单文件约定 ----------
  // ⚠️ flat config 里 `no-restricted-syntax` 同 key 会整组覆盖（不是追加），
  // 所以每块都要把前端通用那条（R_NO_RELOAD）一起带上，否则这个文件里 reload 就没人管了。
  {
    files: ['student-frontend/src/components/dialogs/ClassInfoDialog.vue'],
    rules: {
      'no-restricted-syntax': ['error', R_NO_RELOAD, ...R_NO_HARDCODED_PORT, R_NO_AXIOS_IN_CLASS_DIALOG],
    },
  },
  {
    files: ['student-frontend/src/App.vue'],
    rules: {
      'no-restricted-syntax': ['error', R_NO_RELOAD, ...R_NO_HARDCODED_PORT, R_NO_MANUAL_UNBIND],
    },
  },
  {
    files: ['student-frontend/src/components/tables/GridView/GridView.vue'],
    rules: {
      'no-restricted-syntax': ['error', R_NO_RELOAD, ...R_NO_HARDCODED_PORT, R_NO_TIMER_ID_FIELD, R_NO_CLEAR_DEFER],
    },
  },

  // ---------- preload 特例：跑在渲染进程里 ----------
  {
    // preload 由渲染进程加载，既有 window/document，也能用 node 的 require
    files: ['electron/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.browser, ...globals.node },
    },
  },
]
