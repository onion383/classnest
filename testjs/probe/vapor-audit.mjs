// Vapor 迁移可行性审计：对每个 .vue 判断能否加 <script setup vapor>，并给出阻断原因。
//
// 为什么要有这个脚本：早期判定照抄过文档黑名单，把 Transition / Teleport / 模板 ref /
// $emit / defineAsyncComponent 全列为硬阻断，后来逐个实测推翻（详见项目记忆全量版）。
// 所以判定必须「以实测结论为准的规则表」，而不是某份名单。
//
// 规则约定（与实测结论一致）：
//   真阻断：render()/h() 写的渲染函数、写 DOM、lucide 直连、sortablejs、自定义指令、
//           $slots/$refs/$el/getCurrentInstance
//   非阻断：Transition / TransitionGroup / Teleport / KeepAlive / Suspense（vapor 有原生映射）、
//           defineAsyncComponent（走 mountDynamicVNode interop）、模板 ref、$emit、<component :is>
//
// 用法：node testjs/probe/vapor-audit.mjs [--pending]   # --pending 只看未迁移的
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'student-frontend', 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

// 注释与 <style> 必须先剥掉：否则 :deep() 被当成 v-deep 指令、注释里的 <KeepAlive>、
// CSS 里的 v-else-if 全部假阳性（第一版扫描因此误判 48 个）。
function strip(raw) {
  const noStyle = raw.replace(/<style[\s\S]*?<\/style>/gi, '')
  const tpl = noStyle.match(/<template>([\s\S]*)<\/template>/i)
  const script = noStyle.match(/<script[^>]*>([\s\S]*?)<\/script>/i)
  const noComment = (s) =>
    (s || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
  return { tpl: noComment(tpl && tpl[1]), script: noComment(script && script[1]), raw }
}

// 只认自定义指令：vue 内置指令不算
const BUILTIN_DIRECTIVES = new Set([
  'if', 'else', 'else-if', 'for', 'show', 'model', 'bind', 'on', 'html', 'text',
  'slot', 'pre', 'cloak', 'once', 'memo', 'is',
])

const RULES = [
  { key: 'render', hard: true, test: ({ script }) => /\bexport\s+default\s+defineComponent|\bh\s*\(|\brender\s*\(/.test(script) },
  { key: '写DOM', hard: true, test: ({ tpl, script }) => /appendChild|insertBefore|cloneNode|removeChild|replaceChild|\.style\.[A-Za-z]+\s*=|\.animate\s*\(/.test(tpl + script) },
  { key: 'lucide', hard: true, test: ({ script }) => /from\s+['"]lucide-vue-next['"]|from\s+['"]@lucide\/vue['"]/.test(script) },
  { key: 'sortable', hard: true, test: ({ script }) => /sortablejs|new\s+Sortable/.test(script) },
  { key: '实例代理', hard: true, test: ({ script }) => /getCurrentInstance|\$el\b|\$refs\b|\.proxy\b/.test(script) },
  { key: '$slots', hard: true, test: ({ script }) => /\$slots\b/.test(script) },
  {
    key: '自定义指令', hard: true,
    test: ({ tpl }) => {
      const m = [...tpl.matchAll(/\sv-([a-zA-Z][\w-]*)/g)].map((x) => x[1])
      return m.some((d) => !BUILTIN_DIRECTIVES.has(d))
    },
  },
  // 非阻断，只做信息标注
  { key: 'Transition', hard: false, test: ({ tpl }) => /<Transition|<TransitionGroup/.test(tpl) },
  { key: 'Teleport', hard: false, test: ({ tpl }) => /<Teleport/.test(tpl) },
  { key: 'KeepAlive', hard: false, test: ({ tpl }) => /<KeepAlive/.test(tpl) },
  { key: 'Suspense', hard: false, test: ({ tpl }) => /<Suspense/.test(tpl) },
  { key: 'async组件', hard: false, test: ({ script }) => /defineAsyncComponent/.test(script) },
  { key: '动态组件', hard: false, test: ({ tpl }) => /<component[\s:>]/.test(tpl) },
]

const files = walk(SRC)
const pendingOnly = process.argv.includes('--pending')

const rows = []
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8')
  const marked = /<script setup vapor>/.test(raw)
  if (pendingOnly && marked) continue
  const s = strip(raw)
  const hits = RULES.filter((r) => {
    try { return r.test(s) } catch { return false }
  })
  const hard = hits.filter((h) => h.hard).map((h) => h.key)
  rows.push({
    文件: path.relative(SRC, f).replace(/\\/g, '/'),
    行数: raw.split('\n').length,
    标记: marked ? '已迁' : '',
    硬阻断: hard.join(' ') || '—',
    非阻断项: hits.filter((h) => !h.hard).map((h) => h.key).join(' ') || '—',
    可迁: hard.length === 0 ? '是' : '否',
  })
}

const show = pendingOnly ? rows : rows.filter((r) => !r.标记)
show.sort((a, b) => b.行数 - a.行数)
console.table(show)

const can = show.filter((r) => r.可迁 === '是')
console.log(`\n未迁移 ${show.length} 个，其中判定可直接迁移 ${can.length} 个：`)
console.log(can.map((r) => `  ${r.文件}（${r.行数} 行）`).join('\n') || '  （无）')
