// =========================================================================
// settings-view-ctx-binding.test.js —— 设置页「模板绑定必须真的可见」
// 运行：npm run test:units
//
// 背景：SettingsView.vue 把状态与方法拆在三个逻辑模块（appearance/data/search）里，
// 经一个 ctx 袋互调，模板只认 <script setup> 的**顶层绑定**。
// 于是出现一类只在运行时暴露的坑：方法在模块里写好了、模板里也写了 @change="onXxx"，
// 但忘了把 onXxx 放进 `const { ... } = ctx` 的解构列表 ——
// 模板拿到的就是 undefined，点击**完全静默**（无报错、无提示、界面毫无反应）。
//
// 实例：性能面板「快速启动」开关就这样哑了一整天。
// 只断言「模板里写了 @change=\"onFastStartupChange\"」是假绿 —— 那一行本来就是对的。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VIEW_DIR = path.join(ROOT, 'student-frontend/src/views/SettingsView')
const VIEW = path.join(VIEW_DIR, 'SettingsView.vue')
const MODULES = ['SettingsView.appearance.js', 'SettingsView.data.js', 'SettingsView.search.js']

const viewSrc = () => fs.readFileSync(VIEW, 'utf8')

/** 模板区（第一个 <template> 到最后一个 </template> 之间） */
function templateOf(src) {
  const start = src.indexOf('<template>')
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, 'SettingsView.vue 里找不到 template 区')
  return src.slice(start, end)
}

/** 三个逻辑模块 return 出去的方法名（约定：对象顶层方法，缩进 4 空格）
 *  必须允许 `async` 前缀 —— 「回收微缩图」的 sweepThumbs 就是 async 方法，
 *  旧正则只认 `    name(` 导致它没被纳入检查，漏掉了「没解构进模板」的真实故障。 */
function ctxMethodNames() {
  const names = new Set()
  for (const f of MODULES) {
    const s = fs.readFileSync(path.join(VIEW_DIR, f), 'utf8')
    for (const m of s.matchAll(/^ {4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1])
  }
  return names
}

/** `const { ... } = ctx` 的解构集合（模板可见的方法只能来自这里或 setup 自己的定义） */
function destructuredNames(src) {
  const hit = src.indexOf('} = ctx')
  assert.ok(hit > 0, '找不到 `} = ctx` 解构块')
  const open = src.lastIndexOf('const {', hit)
  assert.ok(open > 0, '找不到 `const {` 解构开头')
  return new Set(src.slice(open, hit).match(/[A-Za-z_$][\w$]*/g) || [])
}

/** 模板里被引用的「纯标识符」：事件/属性绑定的值、插值里的单个名字 */
function templateRefs(tmpl) {
  const refs = new Set()
  // @event="name" / :prop="name" / v-bind:prop="name"
  for (const m of tmpl.matchAll(/(?:@|v-on:|:|v-bind:)[\w.:-]+="\s*([A-Za-z_$][\w$]*)\s*"/g)) refs.add(m[1])
  // {{ name }}
  for (const m of tmpl.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g)) refs.add(m[1])
  return refs
}

test('模板里引用的 ctx 方法必须都在 `const { ... } = ctx` 解构里（否则静默失效）', () => {
  const src = viewSrc()
  const methods = ctxMethodNames()
  const visible = destructuredNames(src)
  // setup 自己定义的（const / function / 简写函数声明）也算可见，避免误报
  for (const m of src.matchAll(/\b(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)) visible.add(m[1])

  assert.ok(methods.size > 20, `解析出的 ctx 方法太少（${methods.size}），提取规则可能已失效`)

  const broken = [...templateRefs(templateOf(src))]
    .filter((name) => methods.has(name) && !visible.has(name))
    .sort()

  assert.deepEqual(
    broken,
    [],
    `这些方法在逻辑模块里有、模板里也在用，但没解构进 setup 顶层 → 模板拿到 undefined，点了没反应：\n  ${broken.join('\n  ')}`,
  )
})

test('快速启动开关的处理器在解构列表里（本次回归的钉子）', () => {
  const src = viewSrc()
  assert.ok(
    /@change="onFastStartupChange"/.test(src),
    '开关上应当有 @change="onFastStartupChange"',
  )
  assert.ok(
    destructuredNames(src).has('onFastStartupChange'),
    'onFastStartupChange 没有解构进 setup 顶层 —— 开关会哑掉（Vapor 下不报错）',
  )
})

test('开关用 :model-value + @change 显式绑定（避免 v-model 与 change 双写）', () => {
  const src = viewSrc()
  assert.ok(
    /:model-value="fastStartup"[\s\S]{0,120}@change="onFastStartupChange"/.test(src),
    '开关绑定形式被改动：现在应当是受控开关（:model-value + @change）',
  )
})
