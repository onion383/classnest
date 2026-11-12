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
      ecmaVersion: 2024,
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
    rules: SHARED_RULES,
  },

  // ---------- 后端 + 主进程：CJS + Node ----------
  {
    files: ['student-backend/**/*.js', 'electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },

  // ---------- 业务层：架构守卫 ----------
  // 只覆盖 services / routes / utils：schema 是建表事实来源（DDL 必须写表名），
  // registry 自身就是名单，二者都不能套这条规则。
  {
    files: ['student-backend/services/**/*.js', 'student-backend/routes/**/*.js', 'student-backend/utils/**/*.js'],
    rules: ARCH_RULES,
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
