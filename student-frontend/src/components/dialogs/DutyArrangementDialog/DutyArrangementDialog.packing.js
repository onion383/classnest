// ===== 值日智能排表：分组装箱 + 桶随机映射 =====
// 语义：把切好的学生组尽量完整地放进同一个「桶」里，确实放不下才拆。
// 桶由调用方按 axis 切分：日常值日 = 一天（列），大扫除 = 工作区域（列）/
// 劳动项目（行）/ 具体格子（项目 × 列）。内核只认「桶」和它的容量，不认行或列。
// 与 pipeline.js 的 placeUnits 不同，这里不逐组「挑一天」，而是：
//   1. 先离线装箱（小规模精确搜索，超预算退化为 best-fit decreasing）
//   2. 桶标签彼此等价时，再把整桶随机映射一次
// 随机只作用于第 2 步与精确搜索中的等价候选，不参与「能否不拆」的判断。
// 桶标签不等价时（大扫除的项目行/格子）调用方必须关掉第 2 步，见 options.mapBuckets。
// 纯函数：不依赖 Vue / DOM / 组件状态；random 可注入，便于单测确定性。

const NODE_BUDGET = 20000
const EXACT_MAX_GROUPS = 22

function shuffle(arr, random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 只过滤空值与非字符串，不改姓名：写回值日表时用原始姓名，避免引入口径变化
function cleanGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map(g => (Array.isArray(g) ? g : []).filter(n => typeof n === 'string' && n.length))
    .filter(g => g.length)
}

// 各桶容量可以不同（大扫除按项目行分桶时，各项目 count 不同）。
// 搜索只跟踪 remain，所以「剩余相同」的两个桶仍然同构，与初始容量无关；
// 但只有在桶标签等价（调用方会整体随机映射）时才允许据此剪枝，否则会让某些
// 具体的项目行永远拿不到组。
function normCapacities(dayCount, capacity) {
  const D = Math.max(0, Math.floor(Number(dayCount) || 0))
  const list = Array.isArray(capacity) ? capacity : new Array(D).fill(capacity)
  return Array.from({ length: D }, (_, i) => Math.max(0, Math.floor(Number(list[i]) || 0)))
}

// 精确搜索：主目标 = 完整组数，次目标 = 完整组覆盖的人数。
function exactPack(units, caps, random, symmetric) {
  const n = units.length
  const order = units.map((u, i) => i).sort((a, b) => units[b].length - units[a].length)
  const choice = new Array(n).fill(-1)
  const remain = caps.slice()
  let best = null
  let nodes = 0
  let overflow = false

  const record = (intact, people) => {
    if (!best || intact > best.intact || (intact === best.intact && people > best.people)) {
      best = { intact, people, choice: choice.slice() }
    }
  }

  const dfs = (k, intact, people) => {
    if (overflow) return
    if (++nodes > NODE_BUDGET) { overflow = true; return }
    if (best && intact + (n - k) < best.intact) return
    if (k === n) { record(intact, people); return }
    const original = order[k]
    const size = units[original].length
    const seen = new Set()
    const candidates = []
    for (let d = 0; d < caps.length; d++) {
      if (remain[d] < size) continue
      if (symmetric) {
        if (seen.has(remain[d])) continue
        seen.add(remain[d])
      }
      candidates.push(d)
    }
    for (const d of shuffle(candidates, random)) {
      remain[d] -= size
      choice[original] = d
      dfs(k + 1, intact + 1, people + size)
      remain[d] += size
      if (overflow) return
    }
    // 拆组只作为兜底分支，放在所有「完整落位」尝试之后
    choice[original] = -1
    dfs(k + 1, intact, people)
  }

  dfs(0, 0, 0)
  return overflow || !best ? null : best
}

// 超预算 / 超规模时的近似解：大组优先 + best-fit（挑能装下且剩余最少的桶）
function greedyPack(units, caps) {
  const order = units.map((u, i) => i).sort((a, b) => units[b].length - units[a].length)
  const remain = caps.slice()
  const choice = new Array(units.length).fill(-1)
  for (const i of order) {
    const size = units[i].length
    let bestDay = -1
    for (let d = 0; d < caps.length; d++) {
      if (remain[d] < size) continue
      if (bestDay < 0 || remain[d] < remain[bestDay]) bestDay = d
    }
    if (bestDay >= 0) { remain[bestDay] -= size; choice[i] = bestDay }
  }
  return choice
}

/**
 * 把若干学生组装进若干「桶」，桶标签等价时可再把整桶随机映射一次。
 * @param {Array<Array<string>>} groups 已切好的组，每组为姓名数组
 * @param {number} dayCount 桶数
 * @param {number|number[]} capacity 每桶槽位数；数组时为逐桶容量（大扫除按项目行/格子分桶）
 * @param {() => number} [random] 返回 [0,1) 的随机源
 * @param {{ mapBuckets?: boolean }} [options] mapBuckets=false 时不做整桶随机映射（桶标签不等价时必须关）
 * @returns {{ buckets: Array<Array<string>>, intactGroups: number, totalGroups: number,
 *   splitGroups: number, intactPeople: number, totalPeople: number, placed: number,
 *   dropped: number, satisfaction: number, peopleSatisfaction: number, exact: boolean }}
 */
export function packGroupsIntoDays(groups, dayCount, capacity, random = Math.random, options = {}) {
  const units = cleanGroups(groups)
  const caps = normCapacities(dayCount, capacity)
  const D = caps.length
  // 桶容量不等 ⇔ 桶标签不等价：整体随机映射会把内容换到容量不同的下标而撑爆桶，
  // 所以这里强制关闭，不依赖调用方记得传开关。
  const equalCaps = caps.every(c => c === caps[0])
  const mapBuckets = options.mapBuckets !== false && equalCaps
  const totalPeople = units.reduce((n, g) => n + g.length, 0)
  const buckets = Array.from({ length: D }, () => [])

  let choice = null
  let exact = false
  if (units.length && caps.some(c => c > 0) && units.length <= EXACT_MAX_GROUPS) {
    const found = exactPack(units, caps, random, mapBuckets)
    if (found) { choice = found.choice; exact = true }
  }
  if (!choice) choice = greedyPack(units, caps)

  const splitNames = []
  const intactFlags = new Array(units.length).fill(false)
  units.forEach((names, i) => {
    const d = choice[i]
    if (d >= 0 && d < D && buckets[d].length + names.length <= caps[d]) {
      buckets[d].push(...names)
      intactFlags[i] = true
    } else {
      splitNames.push(...names)
    }
  })

  // 被拆组的成员按单人填进剩余空槽；优先填「剩余空位最少」的桶，把碎片集中起来。
  // 等容量时等价于原来的「填最满的桶」，不等容量时不能比已装人数（会偏向大桶）。
  // 只有总人数真的超过总槽位才会放不下，此时如实计入 dropped，绝不静默丢弃。
  let dropped = 0
  for (const name of splitNames) {
    let target = -1
    for (let d = 0; d < D; d++) {
      if (buckets[d].length >= caps[d]) continue
      if (target < 0 || caps[d] - buckets[d].length < caps[target] - buckets[target].length) target = d
    }
    if (target < 0) { dropped++; continue }
    buckets[target].push(name)
  }

  const intactGroups = intactFlags.filter(Boolean).length
  const intactPeople = units.reduce((n, g, i) => n + (intactFlags[i] ? g.length : 0), 0)
  const placed = totalPeople - dropped
  return {
    buckets: mapBuckets ? shuffle(buckets, random) : buckets,
    intactGroups,
    totalGroups: units.length,
    splitGroups: units.length - intactGroups,
    intactPeople,
    totalPeople,
    placed,
    dropped,
    satisfaction: units.length ? Math.round((intactGroups / units.length) * 100) : 0,
    peopleSatisfaction: totalPeople ? Math.round((intactPeople / totalPeople) * 100) : 0,
    exact,
  }
}
