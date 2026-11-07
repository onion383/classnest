// =========================================================================
// duty-packing.test.js —— 值日排表「分组装箱 + 整天随机映射」内核
// 运行：npm run test:units
//
// 判据分三类，全部跑真实源码（动态 import，不复现逻辑）：
//   1. 诚实：intactGroups 必须能从 buckets 反推出来，不许「显示 100% 但组被拆」
//   2. 最优：小规模下完整组数必须等于暴力枚举的最优值（区分精确搜索与顺序贪心）
//   3. 守恒：人数不丢、不重复、不超容量；放不下时如实报 dropped
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadPacking = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.packing.js',
)).href)

// 姓名全唯一，便于用 Set / includes 做守恒与「同组同天」判据
function makeGroups(sizes) {
  let k = 0
  return sizes.map(n => Array.from({ length: n }, () => 'S' + (k++)))
}

// 独立 oracle：穷举每个组「完整落某天 / 被拆」的所有组合，求最大完整组数。
// 只用于小规模判据，不复用被测实现的任何逻辑。
function bruteBestIntact(sizes, D, C) {
  let best = 0
  const remain = new Array(D).fill(C)
  const dfs = (k, intact) => {
    if (k === sizes.length) { best = Math.max(best, intact); return }
    dfs(k + 1, intact)
    for (let d = 0; d < D; d++) {
      if (remain[d] < sizes[k]) continue
      remain[d] -= sizes[k]
      dfs(k + 1, intact + 1)
      remain[d] += sizes[k]
    }
  }
  dfs(0, 0)
  return best
}

// 从结果反推「真正完整落在同一天的组数」，用来校验统计值有没有虚报
function countIntactFromBuckets(groups, buckets) {
  return groups.filter(g => buckets.some(b => g.every(n => b.includes(n)))).length
}

const CASES = [
  { sizes: [4, 4, 2, 2], D: 2, C: 6, why: '可完美装箱' },
  { sizes: [3, 3, 2, 2, 2], D: 2, C: 6, why: '小组填空' },
  { sizes: [5, 4, 3, 2, 1], D: 3, C: 5, why: '组大小参差' },
  { sizes: [6, 6, 4, 4, 4], D: 3, C: 8, why: '大组优先才有解' },
  { sizes: [2, 2, 2, 2, 2, 2], D: 3, C: 4, why: '同桌式等长小组' },
  // 回归资产：顺序贪心（best-fit decreasing）只能拿到 5/6，精确搜索必须拿到 6/6。
  // 谁把精确搜索退化成贪心，这条会先红。
  { sizes: [3, 3, 2, 2, 2, 2], D: 2, C: 7, why: '顺序贪心会输的反例' },
  { sizes: [7, 3, 3, 3, 2, 2], D: 4, C: 5, why: '有一个大组' },
  { sizes: [9, 3, 3, 3, 2], D: 4, C: 5, why: '组大于单天容量，必拆' },
  { sizes: [5, 5, 5, 5], D: 2, C: 10, why: '刚好两两成对' },
]

test('装箱 · 小规模求得最优完整组数，且统计值不虚报', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  for (const c of CASES) {
    const groups = makeGroups(c.sizes)
    const res = packGroupsIntoDays(groups, c.D, c.C, () => 0)
    const best = bruteBestIntact(c.sizes, c.D, c.C)
    assert.equal(res.exact, true, `${c.why}：组数少，应走精确搜索`)
    assert.equal(res.intactGroups, best, `${c.why}：完整组数应等于暴力最优 ${best}`)
    assert.equal(countIntactFromBuckets(groups, res.buckets), res.intactGroups,
      `${c.why}：buckets 里真正同天的组数必须等于上报的 intactGroups`)
    assert.equal(res.satisfaction, Math.round((res.intactGroups / c.sizes.length) * 100),
      `${c.why}：满足率必须由完整组数算出`)
    assert.equal(res.splitGroups, c.sizes.length - res.intactGroups)
  }
})

test('装箱 · 人数守恒：不丢人、不重复、不超每天容量', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  for (const c of CASES) {
    const groups = makeGroups(c.sizes)
    const total = c.sizes.reduce((a, b) => a + b, 0)
    const res = packGroupsIntoDays(groups, c.D, c.C, () => 0.42)
    assert.equal(res.buckets.length, c.D, `${c.why}：桶数应等于天数`)
    assert.ok(res.buckets.every(b => b.length <= c.C), `${c.why}：任何一天都不能超容量`)
    const flat = res.buckets.flat()
    assert.equal(new Set(flat).size, flat.length, `${c.why}：同一个人不能占两个槽`)
    assert.equal(res.placed + res.dropped, total, `${c.why}：placed + dropped 必须等于总人数`)
    assert.equal(res.dropped, 0, `${c.why}：总人数没超总槽位时不许丢人`)
    assert.equal(res.placed, total)
  }
})

test('装箱 · 组大于单天容量时如实降级，不假装满足', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  const groups = makeGroups([9, 3, 3, 3, 2])
  const res = packGroupsIntoDays(groups, 4, 5, () => 0)
  assert.ok(res.intactGroups < groups.length, '大组放不下，完整组数不能是满的')
  assert.ok(res.splitGroups >= 1)
  assert.ok(res.satisfaction < 100, '满足率必须如实低于 100%')
  assert.equal(countIntactFromBuckets(groups, res.buckets), res.intactGroups)
  assert.equal(res.dropped, 0, '拆组只是不保持同天，人仍要有槽')
})

test('装箱 · 总人数超过总槽位时如实报 dropped，不静默吞掉', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  const res = packGroupsIntoDays(makeGroups([12]), 2, 5, () => 0)
  assert.equal(res.totalPeople, 12)
  assert.equal(res.placed, 10)
  assert.equal(res.dropped, 2)
  assert.equal(res.intactGroups, 0)
  assert.equal(res.satisfaction, 0)
  assert.equal(res.buckets.flat().length, 10)
})

test('随机映射 · 注入随机源可复现，不同随机源给出不同整天顺序', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  const groups = makeGroups([3, 3, 3, 2, 2, 2])
  const a = packGroupsIntoDays(groups, 3, 5, () => 0)
  const b = packGroupsIntoDays(groups, 3, 5, () => 0)
  assert.deepEqual(a.buckets, b.buckets, '同一随机源必须得到同一结果')
  const c = packGroupsIntoDays(groups, 3, 5, () => 0.999999)
  assert.notDeepEqual(a.buckets, c.buckets, '随机源不同，整天映射应能产生不同排列')
  assert.deepEqual(a.buckets.flat().sort(), c.buckets.flat().sort(), '随机只换天，不改变人名集合')
})

test('装箱 · 顺序贪心会输的实例，精确搜索必须拿到 100%', async () => {
  // [3,3,2,2,2,2] / 2 天 × 7 槽：完美划分为 3+2+2 与 3+2+2。
  // best-fit decreasing 会先把两个 3 塞进同一天，最后一个 2 无处可放而拆组（5/6）。
  const { packGroupsIntoDays } = await loadPacking()
  const groups = makeGroups([3, 3, 2, 2, 2, 2])
  const res = packGroupsIntoDays(groups, 2, 7, () => 0)
  assert.equal(res.exact, true)
  assert.equal(res.intactGroups, 6)
  assert.equal(res.splitGroups, 0)
  assert.equal(res.satisfaction, 100)
  assert.equal(countIntactFromBuckets(groups, res.buckets), 6, '6 个组必须真的各自同天')
})

test('装箱 · 空输入与零容量不崩溃，且人数如实计入 dropped', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  assert.deepEqual(packGroupsIntoDays([], 5, 4), {
    buckets: [[], [], [], [], []], intactGroups: 0, totalGroups: 0, splitGroups: 0,
    intactPeople: 0, totalPeople: 0, placed: 0, dropped: 0,
    satisfaction: 0, peopleSatisfaction: 0, exact: false,
  })
  const noSlots = packGroupsIntoDays(makeGroups([2, 2]), 3, 0, () => 0)
  assert.equal(noSlots.placed, 0)
  assert.equal(noSlots.dropped, 4)
  assert.equal(noSlots.satisfaction, 0)
})

// ===== 大扫除：桶容量不等 + 桶标签不等价 =====
// 独立 oracle，支持逐桶容量（不复用被测实现）
function bruteBestIntactCaps(sizes, caps) {
  let best = 0
  const remain = caps.slice()
  const dfs = (k, intact) => {
    if (k === sizes.length) { best = Math.max(best, intact); return }
    dfs(k + 1, intact)
    for (let d = 0; d < caps.length; d++) {
      if (remain[d] < sizes[k]) continue
      remain[d] -= sizes[k]
      dfs(k + 1, intact + 1)
      remain[d] += sizes[k]
    }
  }
  dfs(0, 0)
  return best
}

const CAP_CASES = [
  { sizes: [3, 3, 2, 2], caps: [4, 6], why: '两桶容量不同' },
  { sizes: [4, 3, 2, 2, 1], caps: [2, 5, 5], why: '小桶只能放小组' },
  { sizes: [5, 4, 3, 2], caps: [6, 6, 2], why: '大组必须进大桶' },
]

test('不等容量 · 精确搜索仍求得最优，且各桶不超自己的容量', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  for (const c of CAP_CASES) {
    const groups = makeGroups(c.sizes)
    const total = c.sizes.reduce((a, b) => a + b, 0)
    const res = packGroupsIntoDays(groups, c.caps.length, c.caps, () => 0)
    assert.equal(res.exact, true, `${c.why}：应走精确搜索`)
    assert.equal(res.intactGroups, bruteBestIntactCaps(c.sizes, c.caps),
      `${c.why}：完整组数必须等于不等容量下的暴力最优`)
    assert.equal(countIntactFromBuckets(groups, res.buckets), res.intactGroups,
      `${c.why}：不许「显示 100% 但组被拆」`)
    res.buckets.forEach((b, i) => assert.ok(b.length <= c.caps[i],
      `${c.why}：桶 ${i} 超容量 ${b.length} > ${c.caps[i]}`))
    const flat = res.buckets.flat()
    assert.equal(new Set(flat).size, flat.length, `${c.why}：人不许重复占槽`)
    assert.equal(res.placed, total, `${c.why}：不许丢人`)
  }
})

test('不等容量 · 组大于所有桶时按剩余空位最少的桶先填', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  const groups = makeGroups([5])
  const res = packGroupsIntoDays(groups, [4, 1].length, [4, 1], () => 0)
  assert.equal(res.intactGroups, 0, '任何单桶都装不下 5 人组')
  assert.equal(res.satisfaction, 0)
  assert.equal(res.dropped, 0, '拆组不许丢人')
  assert.deepEqual(res.buckets.map(b => b.length), [4, 1])
  // 按「剩余最少」应先填容量为 1 的小桶；若退回按「已装人数最多」比较，第一人会落进大桶
  assert.equal(res.buckets[1][0], groups[0][0])
})

test('整桶随机映射开关 · 关掉后桶位置固定，默认开启会整体打乱', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  // 23 组 > EXACT_MAX_GROUPS，强制走确定性的 greedyPack，把「最后的整桶映射」单独隔离出来，
  // 否则精确搜索里的候选随机会让「关掉开关」也产生不同 choice，判据会假绿。
  const groups = makeGroups(Array.from({ length: 23 }, () => 1))
  const caps = [2, 2, 2]
  // 两边用同一个随机源；贪心路径不受 random 影响，唯一差异只能来自最后的整桶映射
  const off = packGroupsIntoDays(groups, caps.length, caps, () => 0, { mapBuckets: false })
  const on = packGroupsIntoDays(groups, caps.length, caps, () => 0)
  assert.equal(off.exact, false, '应走贪心路径')
  assert.deepEqual(off.buckets.map(b => b.length), [2, 2, 2])
  assert.deepEqual(off.buckets, [['S0', 'S1'], ['S2', 'S3'], ['S4', 'S5']],
    '关掉映射时，每桶内容必须固定在装箱算出的下标上')
  assert.notDeepEqual(on.buckets, off.buckets, '默认开启映射时整桶应被打乱')
  assert.deepEqual(on.buckets.flat().sort(), off.buckets.flat().sort(), '随机只换桶，不改变人名集合')
})

test('不等容量 · 即使不传开关也不会把内容换到容量不同的桶', async () => {
  const { packGroupsIntoDays } = await loadPacking()
  const caps = [1, 5]
  for (const v of [0, 0.3, 0.6, 0.999999]) {
    const res = packGroupsIntoDays(makeGroups([2, 2, 1]), caps.length, caps, () => v)
    assert.ok(res.buckets[0].length <= caps[0], '小桶不能被换进大桶的内容')
    assert.ok(res.buckets[1].length <= caps[1], '大桶也不能被换进小桶的内容')
  }
})
