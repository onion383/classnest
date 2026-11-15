// =========================================================================
// leave-timeline-search.test.js —— 时间轴「任意关键词」搜索的索引边界
//
// B 轮：状态 label（未到/已过）和页面 slot 里的固定文案（截止日 / 距离该事件还有 N 天）
// 原本都不在节点字段里，搜不到。现由 LeaveTimeline 自动注入「该节点自己」的 label，
// 并允许调用方通过 searchExtras(node) 补 slot 文案（这轮只有倒计时页接线）。
//
// 判据两条腿：
//   ① 从真实 .vue 源码抽出 haystackOf / countdownSearchText 进 vm 沙箱真跑（不是复制实现）；
//   ② 源码判据确认「入口真的有人用」+ 缓存快照把 label/extras 一起比。
// 每个关键改动都配内存变异反证，并断言变异锚点确实命中（否则是假绿）。
// 运行：node testjs/run-units.js --only=leave-timeline-search
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../..')
const TIMELINE = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/base/LeaveTimeline.vue'), 'utf8')
const ACTIVITIES = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/ActivitiesView.vue'), 'utf8')

// 从真实源码里按花括号配平抽出一个完整函数声明（源码改了，测试跟着变）
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `源码里必须能找到 function ${name}(`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`function ${name}( 的花括号没配平`)
}

const HAYSTACK_SRC = extractFn(TIMELINE, 'haystackOf')
const EXTRAS_SRC = extractFn(ACTIVITIES, 'countdownSearchText')

// 故意放一个两个节点都不属于的 label，用来反证「不是把所有 label 拼给每个节点」
const NODE_TYPES = [
  { value: 'future', label: '未到' },
  { value: 'past', label: '已过' },
  { value: 'ongoing', label: '进行中' }
]

const FUTURE = { key: 1, type: 'future', time: '2027-02-06', text: '春节', name: '春节', deadline: '2027-02-06', days: 84 }
const PAST = { key: 2, type: 'past', time: '2026-10-01', text: '国庆节', name: '国庆节', deadline: '2026-10-01', days: -45 }

function build(haystackSrc = HAYSTACK_SRC, extrasSrc = EXTRAS_SRC) {
  const ctx = {
    haystackCache: new WeakMap(),
    nodeTypeIndex: { value: new Map(NODE_TYPES.map(t => [t.value, t])) },
    props: { searchExtras: null }
  }
  vm.createContext(ctx)
  vm.runInContext(`${haystackSrc}\n${extrasSrc}\nglobalThis.__hay = haystackOf; globalThis.__extras = countdownSearchText;`, ctx)
  ctx.props.searchExtras = ctx.__extras
  return { fn: ctx.__hay, ctx }
}

const match = (fn, node, kw) => fn(node).includes(kw.toLowerCase())

// 变异必须真的改到源码，锚点丢了要当场报红（否则「反证」是假的）
function mutate(src, from, to) {
  assert.ok(src.includes(from), `变异锚点必须还在源码里：${from}`)
  const out = src.replace(from, to)
  assert.notEqual(out, src, '变异必须真的改变源码')
  return out
}

// ===== 行为 =====

test('原有能力不回归：节点字段值仍是索引的一部分（含大小写不敏感）', () => {
  const { fn } = build()
  assert.equal(match(fn, FUTURE, '春节'), true)
  assert.equal(match(fn, FUTURE, '2027-02-06'), true)
  assert.equal(match(fn, FUTURE, '84'), true)
  assert.equal(match(fn, PAST, '国庆节'), true)
  assert.equal(match(fn, FUTURE, 'FUTURE'), true, 'type 等英文值也不区分大小写')
  assert.equal(match(fn, FUTURE, '放寒假'), false)
})

test('状态 label 按节点取：搜「未到」只捞 future，不会把 past 一起带出来', () => {
  const { fn } = build()
  assert.equal(match(fn, FUTURE, '未到'), true)
  assert.equal(match(fn, PAST, '未到'), false)
  assert.equal(match(fn, PAST, '已过'), true)
  assert.equal(match(fn, FUTURE, '已过'), false)
  assert.equal(match(fn, FUTURE, '进行中'), false, 'nodeTypes 里别的 label 不能拼给每个节点')
  assert.equal(match(fn, PAST, '进行中'), false)
})

test('slot 固定文案按 days 正负补进索引，两种状态不串味', () => {
  const { fn } = build()
  assert.equal(match(fn, FUTURE, '截止日'), true)
  assert.equal(match(fn, PAST, '截止日'), true)
  assert.equal(match(fn, FUTURE, '距离该事件还有'), true)
  assert.equal(match(fn, PAST, '距离该事件还有'), false, '已过的节点显示的是「已经过去了」')
  assert.equal(match(fn, PAST, '已经过去了'), true)
  assert.equal(match(fn, FUTURE, '已经过去了'), false)
  assert.equal(match(fn, PAST, '45 天'), true, '补词里的数值也参与匹配')
})

test('没传 searchExtras 的页面只是少了补词，原有能力与 label 都还在', () => {
  const { fn, ctx } = build()
  ctx.props.searchExtras = null
  assert.equal(match(fn, FUTURE, '春节'), true)
  assert.equal(match(fn, FUTURE, '未到'), true)
  assert.equal(match(fn, FUTURE, '截止日'), false, '页面没补词就不该凭空出现')
  assert.equal(match(fn, PAST, '已经过去了'), false)
})

test('缓存快照含 label / extras：nodeTypes 或补词变了必须重算，不能吃旧串', () => {
  const { fn, ctx } = build()
  assert.equal(match(fn, FUTURE, '未到'), true)

  ctx.nodeTypeIndex.value.set('future', { value: 'future', label: '待开始' })
  assert.equal(match(fn, FUTURE, '未到'), false, 'label 变了要失效')
  assert.equal(match(fn, FUTURE, '待开始'), true)

  ctx.props.searchExtras = () => '临时补词'
  assert.equal(match(fn, PAST, '已经过去了'), false, '补词函数换了要失效')
  assert.equal(match(fn, PAST, '临时补词'), true)

  // 节点内容被就地改：旧的 values 快照也要失效
  const mutable = { ...FUTURE }
  assert.equal(match(fn, mutable, '春节'), true)
  mutable.text = '元宵节'
  mutable.name = '元宵节' // 两个字段都带名称，只改一个会误判成缓存没失效
  assert.equal(match(fn, mutable, '春节'), false)
  assert.equal(match(fn, mutable, '元宵节'), true)
})

// ===== 源码判据：入口存在 ≠ 有人用 =====

test('源码判据：组件真的按节点取 label、缓存真的比 label/extras，倒计时页真的接线', () => {
  assert.match(TIMELINE, /searchExtras: \{ type: Function, default: null \}/, 'prop 必须是可选函数')
  assert.match(HAYSTACK_SRC, /nodeTypeIndex\.value\.get\(n\.type\)/, '只能取该节点自己的 label')
  assert.match(HAYSTACK_SRC, /hit\.label === label && hit\.extras === extras/, '缓存快照要比 label/extras')
  assert.match(HAYSTACK_SRC, /haystackCache\.set\(n, \{ values: values\.slice\(\), label, extras, text \}\)/)

  const from = ACTIVITIES.indexOf('<!-- 倒计时时间轴 -->')
  assert.ok(from >= 0, '倒计时时间轴块必须存在')
  const cdBlock = ACTIVITIES.slice(from, ACTIVITIES.indexOf('</LeaveTimeline>', from))
  assert.match(cdBlock, /:search-extras="countdownSearchText"/, '统一入口必须真的被倒计时页用上')

  assert.match(EXTRAS_SRC, /node\.days >= 0/, '补词必须按状态分叉')
  assert.match(EXTRAS_SRC, /距离该事件还有/)
  assert.match(EXTRAS_SRC, /已经过去了/)
  assert.match(EXTRAS_SRC, /截止日/)
})

// ===== 变异反证：三处关键改动各让对应断言变红 =====

test('变异反证：去掉 label / 去掉 extras / 缓存不比对，三处都会让判据变红', () => {
  const noLabel = mutate(HAYSTACK_SRC, "const label = nodeTypeIndex.value.get(n.type)?.label || '';", "const label = '';")
  const noExtras = mutate(HAYSTACK_SRC, "String(props.searchExtras(n) || '')", "''")
  const noCacheCheck = mutate(HAYSTACK_SRC, '\n    && hit.label === label && hit.extras === extras', '')

  assert.throws(() => {
    const { fn } = build(noLabel)
    assert.equal(match(fn, FUTURE, '未到'), true, '去掉 label 后「未到」应搜不到')
  }, /去掉 label/)

  assert.throws(() => {
    const { fn } = build(noExtras)
    assert.equal(match(fn, FUTURE, '距离该事件还有'), true, '去掉 extras 后固定文案应搜不到')
  }, /去掉 extras/)

  assert.throws(() => {
    const { fn, ctx } = build(noCacheCheck)
    assert.equal(match(fn, FUTURE, '未到'), true)
    ctx.nodeTypeIndex.value.set('future', { value: 'future', label: '待开始' })
    assert.equal(match(fn, FUTURE, '未到'), false, '缓存不比对 label 就会一直吃旧串')
  }, /缓存不比对/)
})
