/**
 * inp-compare.mjs —— 两轮 INP 测量的对比报告（Vue 3.5/VDOM 基线 vs 3.6/Vapor 实验组）
 * ---------------------------------------------------------------------------
 * 输入：inp-probe.mjs 落盘的两份 JSON（testjs/tmp/inp-35.json、inp-36.json）
 *
 * 口径提醒（读结论前必须知道）：
 *   · event-timing 的 duration 被 Chromium 量化到 **8ms 台阶**，单次读数只能分辨 ≥8ms 的差异；
 *   · 「呈现」段含帧调度，最易受后台负载/遮挡影响，所以只看**中位数**，不看单次；
 *   · 场景按「页面|类别|场景名」聚合，取中位，避免某一步被跳过导致整体错位。
 *
 * 用法：
 *   node testjs/probe/inp-compare.mjs
 *   node testjs/probe/inp-compare.mjs --a=testjs/tmp/inp-35.json --b=testjs/tmp/inp-36.json
 *   node testjs/probe/inp-compare.mjs --top=30
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/)
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]
  }),
)
const PA = path.resolve(ROOT, args.a || 'testjs/tmp/inp-35.json')
const PB = path.resolve(ROOT, args.b || 'testjs/tmp/inp-36.json')
const TOP = Number(args.top || 20)

for (const p of [PA, PB]) {
  if (!existsSync(p)) {
    console.error(`缺少 ${p}\n先分别跑：INP_VUE=35 INP_ONESHOT=1 node testjs/probe/inp-probe.mjs`)
    process.exit(1)
  }
}

const A = JSON.parse(readFileSync(PA, 'utf8'))
const B = JSON.parse(readFileSync(PB, 'utf8'))

const median = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
const p75 = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.75))]
}
const ms = (v) => (v === null || v === undefined ? '—' : String(Math.round(v)))
const signed = (v) => (v === null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)))

/** 场景 → 各项耗时数组（同场景可能被跑多次） */
function groupset(rows) {
  const map = new Map()
  for (const r of rows) {
    if (r.类别 === '未匹配') continue
    const key = `${r.页面}|${r.类别}|${r.场景}`
    if (!map.has(key)) map.set(key, { 页面: r.页面, 类别: r.类别, 场景: r.场景, all: [], 输入延迟: [], 处理: [], 呈现: [] })
    const g = map.get(key)
    g.all.push(r.总耗时)
    g.输入延迟.push(r.输入延迟)
    g.处理.push(r.处理)
    g.呈现.push(r.呈现)
  }
  return map
}

const GA = groupset(A.rows)
const GB = groupset(B.rows)

const flatA = A.rows.filter((r) => r.类别 !== '未匹配').map((r) => r.总耗时)
const flatB = B.rows.filter((r) => r.类别 !== '未匹配').map((r) => r.总耗时)

console.log(`================ INP 对比：${A.label || A.vue} vs ${B.label || B.vue} ================`)

console.log(`A  ${A.label}   ${A.generatedAt}`)
console.log(`B  ${B.label}   ${B.generatedAt}`)
console.log(`环境 A: theme=${A.env?.theme} dpr=${A.env?.dpr} vw=${A.env?.vw} gl=${String(A.env?.gl || '').slice(0, 40)}`)
console.log(`环境 B: theme=${B.env?.theme} dpr=${B.env?.dpr} vw=${B.env?.vw} gl=${String(B.env?.gl || '').slice(0, 40)}`)
if (A.env?.vw !== B.env?.vw || A.env?.theme !== B.env?.theme) {
  console.log('⚠ 两轮运行环境不一致（窗口尺寸/主题不同会让「呈现」不可比）')
}
console.log('')

// ---------- ① 总体 ----------
console.log('---- ① 总体（交互总耗时，已排除未匹配）----')
console.table([
  {
    通道: `A ${A.label || A.vue}`,
    交互数: flatA.length,
    中位: ms(median(flatA)),
    P75: ms(p75(flatA)),
    均值: ms(flatA.length ? flatA.reduce((a, b) => a + b, 0) / flatA.length : null),
    '≥100ms': flatA.filter((v) => v >= 100).length,
    '≥200ms': flatA.filter((v) => v >= 200).length,
  },
  {
    通道: `B ${B.label || B.vue}`,
    交互数: flatB.length,
    中位: ms(median(flatB)),
    P75: ms(p75(flatB)),
    均值: ms(flatB.length ? flatB.reduce((a, b) => a + b, 0) / flatB.length : null),
    '≥100ms': flatB.filter((v) => v >= 100).length,
    '≥200ms': flatB.filter((v) => v >= 200).length,
  },
])
console.log('')

// ---------- ② 按交互类别 ----------
const cats = [...new Set([...GA.values(), ...GB.values()].map((g) => g.类别))]
const catRows = cats.map((c) => {
  const a = [...GA.values()].filter((g) => g.类别 === c)
  const b = [...GB.values()].filter((g) => g.类别 === c)
  const ma = median(a.flatMap((g) => g.all))
  const mb = median(b.flatMap((g) => g.all))
  return {
    类别: c,
    'A 中位': ms(ma),
    'B 中位': ms(mb),
    'Δ中位': signed(mb === null || ma === null ? null : mb - ma),
    'A 最差': ms(a.length ? Math.max(...a.flatMap((g) => g.all)) : null),
    'B 最差': ms(b.length ? Math.max(...b.flatMap((g) => g.all)) : null),
    样本: `${a.length} → ${b.length}`,
  }
}).sort((x, y) => Number(String(y['A 中位'])) - Number(String(x['A 中位'])))
console.log('---- ② 按交互类别（中位；「最差」是该类别里最慢的一次）----')
console.table(catRows)
console.log('')

// ---------- ③ 逐场景 ----------
const keys = [...new Set([...GA.keys(), ...GB.keys()])]
const sceneRows = keys.map((k) => {
  const a = GA.get(k)
  const b = GB.get(k)
  const ma = a ? median(a.all) : null
  const mb = b ? median(b.all) : null
  return {
    页面: (a || b).页面,
    场景: (a || b).场景,
    'A 总': ms(ma),
    'B 总': ms(mb),
    'Δ总': signed(ma === null || mb === null ? null : mb - ma),
    'A 呈现': ms(a ? median(a.呈现) : null),
    'B 呈现': ms(b ? median(b.呈现) : null),
    _d: ma === null || mb === null ? -1 : Math.abs(mb - ma),
  }
}).sort((x, y) => y._d - x._d)

console.log(`---- ③ 逐场景（按 |Δ中位| 降序，前 ${TOP} / 共 ${keys.length} 个）----`)
console.table(sceneRows.slice(0, TOP).map(({ _d, ...r }) => r))
console.log('')

// ---------- ④ 覆盖度自检 ----------
const missA = sceneRows.filter((r) => r['A 总'] === '—').length
const missB = sceneRows.filter((r) => r['B 总'] === '—').length
console.log('---- ④ 覆盖度自检 ----')
console.log(`A 独有/缺失场景：A 缺 ${missA} 个，B 缺 ${missB} 个（脚本跳过步骤会导致；缺得多的那轮结论要打折）`)
const skipA = A.skipped || []
const skipB = B.skipped || []
if (skipA.length || skipB.length) {
  console.log(`跳过步骤：A ${skipA.length} 条 / B ${skipB.length} 条`)
  const onlyA = skipA.filter((s) => !skipB.some((t) => t.slice(0, 40) === s.slice(0, 40)))
  const onlyB = skipB.filter((s) => !skipA.some((t) => t.slice(0, 40) === s.slice(0, 40)))
  if (onlyA.length) console.log('  仅 A 跳过：\n    ' + onlyA.slice(0, 6).join('\n    '))
  if (onlyB.length) console.log('  仅 B 跳过：\n    ' + onlyB.slice(0, 6).join('\n    '))
}
console.log('\n说明：event-timing 的 duration 被量化到 8ms 台阶，|Δ| < 16ms 视为噪声；')
console.log('     中位优先于单次，「呈现」段受帧调度影响最大，需结合多轮复测看。')
