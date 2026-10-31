/**
 * bench/main.js —— Vapor vs VDOM 同步循环基准（不经 rAF，不受帧调度影响）
 * ---------------------------------------------------------------------------
 * 为什么不用 INP：event-timing 的 duration 被量化到 8ms 台阶，而本应用交互的 JS 处理成本
 * 只有 0.2~0.4ms，且总耗时被 ~40ms 帧调度地板主导 —— 实测三轮结论完全相等，
 * 同通道复测的波动还大于跨通道差异（详见 testjs/probe/inp-compare.mjs 的结论）。
 *
 * 这里换成「同步循环 + performance.now 直接夹」，把框架成本从帧调度里摘出来：
 *   · mount     —— 反复 createApp + mount + unmount 一个 200 行 × 8 列的表
 *   · mountEmpty—— 挂一个空组件，用来扣掉 createApp/mount 的固定开销
 *   · patchOne  —— 改**一个单元格的文本**，等 nextTick（Vapor 只更新那个文本节点，
 *                  VDOM 要重建 1600 个 vnode 再 diff）
 *   · patchRow  —— 同时改一行的 分数/class/条件文本 三种绑定
 *   · rebuild   —— 整体替换 list（200 行全换）
 *   · tick      —— 空 await nextTick 循环，作为异步等待的基线
 *
 * 两个通道跑的是**同一份源码**：BenchTable.vue 上的 `vapor` 标记在 3.5 下被逐字忽略。
 *
 * 用法：由 testjs/probe/vapor-bench.mjs 驱动；也可手工开 dev server 后访问 /bench.html。
 */
import * as VueNS from 'vue'
import vaporInterop from 'virtual:vapor-interop'
import BenchTable from './BenchTable.vue'

const { createApp, reactive, nextTick } = VueNS

const ROWS = 200
const ROUNDS = 7
const ITERS = { mount: 12, mountBare: 12, mountEmpty: 40, patchOne: 500, patchRow: 500, rebuild: 40, tick: 200 }

// 通道判定：只有 3.6 的 with-vapor 双运行时才导出 createVaporApp。
// 不能只看 vaporInterop 是否为空 —— 那只能说明通道，不能说明组件真的按 vapor 编译了。
// 3.6 的纯 VDOM 对照组没有 createVaporApp，光靠这一条会被误标成 3.5，所以再叠一层版本号。
const isVaporRuntime = typeof VueNS.createVaporApp === 'function'
const VUE_VERSION = VueNS.version || '?'
const CHANNEL = isVaporRuntime
  ? '3.6-vapor'
  : VUE_VERSION.startsWith('3.6')
    ? '3.6-vdom'
    : '3.5-vdom'

const data = reactive({
  list: Array.from({ length: ROWS }, (_, i) => ({
    id: i + 1,
    name: '学生' + (i + 1),
    no: String(9000 + i),
    cls: ['一班', '二班', '三班'][i % 3],
    score: (i * 7) % 100,
    active: i % 2 === 0,
    note: '备注文本 ' + i,
  })),
})

const host = document.createElement('div')
host.id = 'bench-host'
document.body.appendChild(host)

const Empty = { template: '<div class="bench-empty"></div>' }
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const stats = (samples) => ({
  median: Number(median(samples).toFixed(4)),
  min: Number(Math.min(...samples).toFixed(4)),
  max: Number(Math.max(...samples).toFixed(4)),
  samples: samples.map((v) => Number(v.toFixed(4))),
})

function makeApp(comp) {
  const app = createApp(comp, { data })
  if (vaporInterop) app.use(vaporInterop)
  return app
}

/** 强制布局：把样式计算 + 布局搬进测量区间（两通道同样成本，用来观察它稀释多少差异） */
const forceLayout = () => host.getBoundingClientRect().height

/**
 * 自证：测量完必须确认 DOM **真的更新了**。
 * 没有这一步，Vapor 那 0.02ms 完全可能是「只排了队、还没落到 DOM」的假快 ——
 * 尤其 patch 只等一次 nextTick 时，一个没被 flush 的 effect 会让数字漂亮得离谱。
 */
function assertCell(rowNo, colNo, expect, label) {
  const tr = host.querySelector(`tbody tr:nth-child(${rowNo})`)
  const td = tr && tr.children[colNo]
  const got = td ? td.textContent.trim() : '<无单元格>'
  if (got !== String(expect)) throw new Error(`自证失败[${label}]：第 ${rowNo} 行第 ${colNo} 列期望「${expect}」，实际「${got}」`)
  return true
}

// ---------------- 各项基准 ----------------
async function benchMount(iters, comp, withLayout = true) {
  const samples = []
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) {
      host.innerHTML = ''
      const app = makeApp(comp)
      app.mount(host)
      if (withLayout) forceLayout()
      app.unmount()
    }
    samples.push((performance.now() - t0) / iters)
  }
  return stats(samples)
}

async function benchPatch(iters, mutate, assertFn) {
  host.innerHTML = ''
  const app = makeApp(BenchTable)
  app.mount(host)
  await nextTick()
  const samples = []
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) {
      mutate(i)
      await nextTick()
    }
    samples.push((performance.now() - t0) / iters)
  }
  // 自证必须在 unmount **之前**做 —— 卸载后 DOM 已被移除，断言只会看到空容器。
  if (assertFn) assertFn()
  app.unmount()
  return stats(samples)
}

async function benchTick(iters) {
  const samples = []
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) await nextTick()
    samples.push((performance.now() - t0) / iters)
  }
  return stats(samples)
}

async function run() {
  const out = {
    channel: CHANNEL,
    vue: VUE_VERSION,
    vaporInterop: !!vaporInterop,
    rows: ROWS,
    rounds: ROUNDS,
    iters: ITERS,
    cells: ROWS * 8,
    results: {},
  }

  // 先跑一次「空 nextTick」，让微任务队列/JIT 热起来，避免第一项吃到冷启动
  await benchTick(30)

  out.results.tick = await benchTick(ITERS.tick)
  out.results.mountEmpty = await benchMount(ITERS.mountEmpty, Empty)
  // 两种 mount 口径：mount 含强制布局（更接近「用户看到」），mountBare 只有 JS。
  // 布局成本两通道完全相同，混在一起会把框架差异稀释掉，所以分开报。
  out.results.mount = await benchMount(ITERS.mount, BenchTable, true)
  out.results.mountBare = await benchMount(ITERS.mountBare, BenchTable, false)

  out.results.patchOne = await benchPatch(ITERS.patchOne, (i) => {
    data.list[0].name = 'X' + i
  }, () => {
    // 自证：改的是第 1 行姓名，且第 2 行不能被误伤
    assertCell(1, 1, 'X' + (ITERS.patchOne - 1), 'patchOne')
    assertCell(2, 1, '学生2', 'patchOne-未波及邻行')
  })

  const lastScore = (ITERS.patchRow - 1) % 100
  out.results.patchRow = await benchPatch(ITERS.patchRow, (i) => {
    const row = data.list[1]
    row.score = i % 100
    row.active = i % 2 === 0
  }, () => {
    // 自证：分数、条件文本、class 三种绑定都要真的落到 DOM
    assertCell(2, 4, lastScore, 'patchRow-分数')
    assertCell(2, 5, lastScore >= 60 ? '合格' : '不合格', 'patchRow-条件文本')
    const tr = host.querySelector('tbody tr:nth-child(2)')
    const wantCls = (ITERS.patchRow - 1) % 2 === 0 ? 'row-on' : 'row-off'
    if (!tr || !tr.className.includes(wantCls)) {
      throw new Error(`自证失败[patchRow-class]：期望含 ${wantCls}，实际「${tr ? tr.className : '<无行>'}」`)
    }
  })

  out.results.rebuild = await benchPatch(ITERS.rebuild, () => {
    data.list = data.list.map((row, i) => ({ ...row, score: (i * 11) % 100, active: i % 3 === 0 }))
  }, () => {
    assertCell(1, 4, 0, 'rebuild-首行分数')
  })
  out.selfCheck = true

  // 收尾自检：mount/unmount 之后 host 不该残留节点（残留会让后续项越跑越慢）
  out.residualNodes = host.children.length
  out.done = true
  window.__bench = out
  console.log('[bench] ' + JSON.stringify(out))
  return out
}

run().catch((err) => {
  window.__bench = { error: String(err && err.stack || err) }
  console.error('[bench] 失败', err)
})
