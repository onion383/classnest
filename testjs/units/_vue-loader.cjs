// =========================================================================
// _vue-loader.cjs —— 按 package.json exports 解析 Vue 的 ESM 入口
//
// 为什么需要：前端源码是 ESM，`import { effectScope } from 'vue'` 由 Node 按 exports
// 解析（import.node → index.mjs）。测试里如果硬编码 `vue/index.mjs`：
//   · 升级到没有该文件的版本直接 ERR_MODULE_NOT_FOUND（审查 v5 · V5-014）；
//   · 用 require('vue') 拿到的是 CJS 入口，会与源码侧成为**两个不同实例** ——
//     effectScope 与 getCurrentScope 不共享，作用域测试会假通过/假失败。
//
// 这里读前端的 vue/package.json，取 exports['.'].import 的 node 条件，保证与源码
// 解析到同一个文件（同一模块实例）。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = path.resolve(__dirname, '../..', 'student-frontend')
const VUE_DIR = path.join(FRONTEND, 'node_modules', 'vue')

function vueEsmEntry() {
  const pkg = JSON.parse(fs.readFileSync(path.join(VUE_DIR, 'package.json'), 'utf8'))
  const cond = pkg.exports && pkg.exports['.']
  const imp = cond && cond.import
  const rel = typeof imp === 'string'
    ? imp
    : (imp && (imp.node || imp.default || imp.browser))
  if (!rel) throw new Error('vue/package.json 的 exports["."].import 解析不出入口')
  return pathToFileURL(path.join(VUE_DIR, rel)).href
}

function loadVue() {
  return import(vueEsmEntry())
}

module.exports = { loadVue, vueEsmEntry }
