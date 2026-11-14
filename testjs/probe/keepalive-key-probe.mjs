// =========================================================================
// keepalive-key-probe.mjs —— 验证「给 KeepAlive 加 key，key 一变就作废全部缓存实例」
//
// 为什么要单独验证（而不是靠推断）：
//   「切班不重启」整个方案压在一个假设上 —— <KeepAlive :key> 的 key 变化会让它
//   连同内部缓存的组件实例一起卸载重建。如果这个假设不成立（比如某些 Vue 版本
//   把 KeepAlive 当成抽象组件、忽略 key），那修完以后表现会是「页面闪一下但数据
//   还是旧班的」，而且比 reload 更难排查。
//
//   项目里没有 vitest/jsdom，也不该为此加依赖，所以用 Vue 官方的 createRenderer
//   配一个极简自定义渲染器在 Node 里跑真实组件树 —— 不需要 DOM，跑的是真 Vue。
//
// 验证三条：
//   1. 正常切页（key 不变）：组件被 KeepAlive 缓存，切回来不重新 mount。
//   2. key 变化：全部缓存实例被卸载，当前页重新 mount。
//   3. 切换后其他页也被作废（切过去是新实例），不是只重建当前页。
// =========================================================================
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const vueCore = require(
  path.resolve(process.cwd(), 'student-frontend/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js')
)
const { createRenderer, h, KeepAlive, ref, defineComponent, onMounted, onUnmounted, nextTick } = vueCore

// ---- 极简 node ops（Vue 只要求这些方法存在，节点本身用普通对象即可）----
const createNode = (type) => ({ type, children: [], parent: null, text: '' })
const nodeOps = {
  insert(child, parent, anchor) {
    child.parent = parent
    const i = anchor ? parent.children.indexOf(anchor) : -1
    if (i >= 0) parent.children.splice(i, 0, child)
    else parent.children.push(child)
  },
  remove(child) {
    const p = child.parent
    if (!p) return
    const i = p.children.indexOf(child)
    if (i >= 0) p.children.splice(i, 1)
    child.parent = null
  },
  createElement: (type) => createNode(type),
  createText: (text) => Object.assign(createNode('#text'), { text }),
  createComment: (text) => Object.assign(createNode('#comment'), { text }),
  setText(node, text) { node.text = text },
  setElementText(node) { node.children = [] },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const p = node.parent
    if (!p) return null
    return p.children[p.children.indexOf(node) + 1] || null
  },
  querySelector: () => null,
  setScopeId() {},
  cloneNode: (n) => ({ ...n, children: [...n.children] }),
  insertStaticContent() { return [createNode('#static'), createNode('#static')] },
}
const { createApp } = createRenderer({ patchProp() {}, ...nodeOps })

// ---- 被测组件：每次 mount/unmount 都记账 ----
const log = { mounted: {}, unmounted: {} }
function page(name, tag) {
  return defineComponent({
    name,
    setup() {
      // tag 用来区分「同一组件名的不同代次」：切班后 mount 的应该是新的一代
      onMounted(() => { log.mounted[name] = (log.mounted[name] || 0) + 1 })
      onUnmounted(() => { log.unmounted[name] = (log.unmounted[name] || 0) + 1 })
      return () => h('div', `${name}#${tag()}`)
    },
  })
}

let gen = 1
const A = page('A', () => gen)
const B = page('B', () => gen)

const current = ref('A')
const scopeKey = ref(0)

const Root = defineComponent({
  setup() {
    return () => h('div', [
      h(KeepAlive, { key: scopeKey.value, max: 16 }, [
        h(current.value === 'A' ? A : B),
      ]),
    ])
  },
})

const root = createNode('#root')
createApp(Root).mount(root)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`)
}
const snap = () => JSON.stringify(log)

async function run() {
  await nextTick()
  const m0 = snap()
  check('初次挂载：A 挂载 1 次', log.mounted.A === 1, m0)

  // 1. 正常切页，key 不变
  current.value = 'B'
  await nextTick()
  check('切到 B：B 挂载 1 次', log.mounted.B === 1, snap())
  check('切到 B：A 未被卸载（被缓存）', !log.unmounted.A, snap())

  current.value = 'A'
  await nextTick()
  check('切回 A：A 未重新挂载（缓存命中）', log.mounted.A === 1, snap())

  // 2. key 变化 = 切班
  const beforeA = log.mounted.A
  const beforeB = log.mounted.B
  gen += 1              // 模拟「新一班的数据」
  scopeKey.value += 1   // 模拟 bumpClassScope()
  await nextTick()

  check('key 变化：A 被卸载', log.unmounted.A >= 1, snap())
  check('key 变化：当前页 A 重新挂载', log.mounted.A === beforeA + 1, snap())

  // 3. 切到 B：B 也必须重新挂载（说明缓存被清空，而非只重建当前页）
  current.value = 'B'
  await nextTick()
  check('key 变化后切到 B：B 重新挂载（不是旧实例）', log.mounted.B === beforeB + 1, snap())

  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (failed.length) {
    console.log(`FAIL —— ${failed.length} 条不成立：${failed.map((f) => f.name).join('、')}`)
    process.exitCode = 1
  } else {
    console.log('PASS —— KeepAlive :key 变化确实作废全部缓存实例，当前页重新挂载')
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
