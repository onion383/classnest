// ===== 智能分组：核心分组算法 =====
// 纯代码搬运自 SmartGroupDialog.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
// ctx 契约：{ roster, groups, stages, satisfaction, trackSatisfaction }（状态为 ref，模块内用 .value）。
// Fisher-Yates 洗牌
export function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ===== 数据源：本次分组用哪些人 =====
// dataSource:
//   'table' = 只把当前分组表里已有的人重新分组（名册能对上 id 的取名册对象，对不上的算临时同学）
//   'all'   = 学生表里的全班同学；includeNew 为真时再带上分组表里的陌生同学
// includeNew: 用户在「发现有新同学」弹窗里选了「参与」才为真（只影响 'all'）
export function buildRoster({ dataSource, students = [], groups = [], includeNew = false }) {
  const named = s => String((s && s.姓名) || '').trim()
  const rosterStudents = (students || []).filter(s => named(s))
  // 分组表里的成员名（按出现顺序去重）
  const memberNames = []
  const seen = new Set()
  for (const g of groups || []) {
    for (const m of (g.members || [])) {
      const n = String((m && m.member_name) || '').trim()
      if (n && !seen.has(n)) { seen.add(n); memberNames.push(n) }
    }
  }
  const known = new Set(rosterStudents.map(named))
  if (dataSource === 'table') {
    // 只重排已经在表里的人：能对上名册的取名册对象（带 id / 性别），对不上的用临时对象
    // 表里的人一律带上（含名册外的新同学）——「现有分组表格」就是以表里的内容为准
    return memberNames.map(n => rosterStudents.find(s => named(s) === n) || { 姓名: n })
  }
  // 全部同学：名册全员（带 id / 性别）
  if (!includeNew) return rosterStudents
  // 名册外的新同学按用户选择附在后面
  const extras = memberNames.filter(n => !known.has(n)).map(n => ({ 姓名: n }))
  return extras.length ? rosterStudents.concat(extras) : rosterStudents
}

export function useSmartGroupPipeline(ctx) {
  return {
    // ==================== 流水线分组算法（核心） ====================
    // 把班级学生分配到 G 个小组；按 stages 顺序依次应用，后一条件可覆盖前一条件。
    // 返回 { members: Set[si] 每个组的学生下标, leaders: leaders[g]=学生下标|null,
    //         forcedLeaders: Set, notLeaders: Set }
    buildAssignment() {
      const roster = ctx.roster.value
      const G = ctx.groups.value.length
      ctx.satisfaction.value = {}
      const members = Array.from({ length: G }, () => new Set()) // 组 -> 学生下标集合
      const leaders = Array(G).fill(null)                          // 组 -> 组长学生下标
      const forcedLeaders = new Set()
      const notLeaders = new Set()

      // 初始：洗牌 + 均匀分配 (round-robin)
      const total = roster.length
      const target = Math.max(1, Math.ceil(total / G))
      const idxs = shuffle(roster.map((_, i) => i))
      idxs.forEach((si, i) => members[i % G].add(si))

      // 依次应用流水线条件
      for (const st of ctx.stages.value) {
        if (st.type === 'relation') applyRelation(ctx, st, roster, members, leaders, target, G)
        else if (st.type === 'identity') applyIdentity(ctx, st, roster, members, leaders, forcedLeaders, notLeaders)
        else if (st.type === 'gender') applyGender(ctx, st, roster, members, target, G)
      }

      // 收尾：保证指定组长的成立；补充每组一个组长
      for (const si of forcedLeaders) {
        const g = groupOf(members, si)
        if (g >= 0) leaders[g] = si
      }
      for (const si of notLeaders) {
        const g = groupOf(members, si)
        if (g >= 0 && leaders[g] === si) leaders[g] = null
      }
      for (let g = 0; g < G; g++) {
        if (members[g].size === 0 || leaders[g] !== null) continue
        for (const si of members[g]) {
          if (notLeaders.has(si)) continue
          leaders[g] = si
          break
        }
      }
      return { members, leaders, total, target }
    },
  }
}

// —— 以下为纯逻辑辅助（不碰组件状态）——
function groupOf(members, si) {
  for (let g = 0; g < members.length; g++) if (members[g].has(si)) return g
  return -1
}
function moveBody(members, leaders, si, from, to) {
  members[from].delete(si)
  members[to].add(si)
  if (leaders[from] === si) leaders[from] = null
}

// 特殊关系：XXX 和 YYY 在一组 / 不在一组
function applyRelation(ctx, st, roster, members, leaders, target, G) {
  const a = st.a, b = st.b
  if (!a || !b) return
  const ia = roster.findIndex(s => String(s.id) === String(a))
  const ib = roster.findIndex(s => String(s.id) === String(b))
  if (ia < 0 || ib < 0 || ia === ib) return
  const ga = groupOf(members, ia)
  const gb = groupOf(members, ib)
  let ok = false
  if (st.kind === 'apart') {
    if (ga !== gb) {
      ok = true
    } else {
      // 把 b 移到另一个人数还够的小组
      for (let h = 0; h < G; h++) {
        if (h === ga || members[h].size >= target) continue
        moveBody(members, leaders, ib, gb, h)
        ok = true
        break
      }
    }
  } else { // together
    if (ga === gb) {
      ok = true
    } else {
      if (members[ga].size < target) { moveBody(members, leaders, ib, gb, ga); ok = true }
      else if (members[gb].size < target) { moveBody(members, leaders, ia, ga, gb); ok = true }
    }
  }
  ctx.trackSatisfaction(st.key, ok ? 1 : 0, 1)
}

// 指定身份：XXX 担任/不担任 组长
function applyIdentity(ctx, st, roster, members, leaders, forcedLeaders, notLeaders) {
  const id = st.studentId
  if (!id) return
  const si = roster.findIndex(s => String(s.id) === String(id))
  if (si < 0) return
  const g = groupOf(members, si)
  let ok = false
  if (st.kind === 'leader') {
    forcedLeaders.add(si)
    notLeaders.delete(si)
    if (g >= 0) {
      leaders[g] = si
      ok = true
    }
  } else { // not-leader
    notLeaders.add(si)
    forcedLeaders.delete(si)
    if (g >= 0 && leaders[g] === si) leaders[g] = null
    ok = true
  }
  ctx.trackSatisfaction(st.key, ok ? 1 : 0, 1)
}

// 性别比例：男女尽量均匀 / 全为男生或女生
function applyGender(ctx, st, roster, members, target, G) {
  const total = roster.length
  if (total === 0) return
  const isBoy = s => s.性别 === '男'
  const isGirl = s => s.性别 === '女'
  const boyIdx = [], girlIdx = [], otherIdx = []
  roster.forEach((s, i) => { if (isBoy(s)) boyIdx.push(i); else if (isGirl(s)) girlIdx.push(i); else otherIdx.push(i) })
  const totalBoy = boyIdx.length

  if (st.mode === 'single') {
    // 每组都放同一性别：男生组 + 女生组 按人数比例拆分。
    //
    // 容量必须按「本池人数 / 本池组数」单独算，不能沿用全局 target=ceil(total/G)：
    // 学生被拆成两个独立子池后，每组容量之和必须分别覆盖各自的池。
    // 旧实现用全局 target，子池组数少的那一侧装不下就静默丢弃——
    // 例如 4 男 4 女分 3 组：女生只有 1 个组、容量 3 < 4，凭空少 1 人；
    // 10 男 1 女分 3 组：男生 2 个组、容量 8 < 10，凭空少 2 人。
    const girls = girlIdx.concat(otherIdx)

    // 只有 1 个组时根本分不开（或压根没建组）：全部放进唯一那组，绝不能因为「没组可去」丢人。
    // 满足率按「是否只有一种性别」记 —— 混性别时这条条件本身就是不可满足的。
    if (G < 2) {
      for (let g = 0; g < G; g++) members[g] = new Set()
      if (G === 1) for (let si = 0; si < total; si++) members[0].add(si)
      const mixed = totalBoy > 0 && girls.length > 0
      ctx.trackSatisfaction(st.key, mixed || G === 0 ? 0 : total, total)
      return
    }

    let boyGroups = 0
    if (totalBoy > 0) {
      // 有女生时至少留 1 个组给女生（G≥2 已保证留得下）
      boyGroups = girls.length > 0
        ? Math.max(1, Math.min(G - 1, Math.round(G * totalBoy / total)))
        : G
    }
    const boyGroupIdxs = Array.from({ length: boyGroups }, (_, i) => i)
    const girlGroupIdxs = Array.from({ length: G - boyGroups }, (_, i) => boyGroups + i)
    // 清空现有分配
    for (let g = 0; g < G; g++) members[g] = new Set()
    distributeInto(members, boyIdx, boyGroupIdxs, poolCapacity(boyIdx.length, boyGroupIdxs.length))
    distributeInto(members, girls, girlGroupIdxs, poolCapacity(girls.length, girlGroupIdxs.length))
    // 满足率：男生进男生组、女生/其他进女生组
    let done = 0
    const inBoyGroups = new Set(boyGroupIdxs)
    for (const si of boyIdx) { const g = groupOf(members, si); if (inBoyGroups.has(g)) done++ }
    for (const si of girlIdx.concat(otherIdx)) { const g = groupOf(members, si); if (!inBoyGroups.has(g)) done++ }
    ctx.trackSatisfaction(st.key, done, total)
    return
  }

  // balanced：男女尽量均匀 —— 把多余的男生调到男生少、且人数不满的小组
  const desiredBoy = Math.round(totalBoy / G)
  const boysNow = Array(G).fill(0)
  boyIdx.forEach(si => boysNow[groupOf(members, si)]++)
  let guard = 0
  while (guard < 40) {
    guard++
    let moved = false
    for (let g = 0; g < G; g++) {
      if (boysNow[g] <= desiredBoy + 1) continue
      // 找一个男生少且未满的小组
      for (let h = 0; h < G; h++) {
        if (h === g || boysNow[h] >= desiredBoy || members[h].size >= target) continue
        const victim = [...members[g]].find(si => roster[si].性别 === '男')
        if (victim === undefined) break
        const fromG = groupOf(members, victim)
        moveBody(members, [], victim, fromG, h)
        boysNow[g]--; boysNow[h]++
        moved = true
        break
      }
      if (moved) break
    }
    if (!moved) break
  }
  // 满足率：落在 目标人数±1 小组里的男生数占比
  let done = 0
  for (const si of boyIdx) { const g = groupOf(members, si); if (Math.abs(boysNow[g] - desiredBoy) <= 1) done++ }
  ctx.trackSatisfaction(st.key, done, totalBoy || 1)
}

// 本池每组的容量：让池内学生均匀落到池内各组，且容量之和必然覆盖整池。
// 空组列表（该池无组可去）返回 0，由 distributeInto 的兜底处理。
function poolCapacity(poolSize, groupCount) {
  if (!groupCount) return 0
  return Math.max(1, Math.ceil(poolSize / groupCount))
}

// 把一组学生均匀填入某些小组。
//
// 不变量：**pool 里每个学生都必须落进某个组，绝不静默丢弃**。
// 这里刻意不写 break —— 旧实现「所有组都到容量就 break」正是学生凭空消失的原因。
// cap 由 poolCapacity 按池算出来，正常一定有位置；万一没有（将来加了新条件往池里塞人），
// 就退回轮转起点直接放入，宁可某一组多一个人，也不能让名册上的人不出现在任何组里。
function distributeInto(members, studentIdxList, groupIdxs, cap) {
  if (groupIdxs.length === 0) return
  let gi = 0
  for (const si of studentIdxList) {
    let target = groupIdxs[gi % groupIdxs.length]
    for (let k = 0; k < groupIdxs.length; k++) {
      const cand = groupIdxs[(gi + k) % groupIdxs.length]
      if (members[cand].size < cap) { target = cand; gi += k + 1; break }
    }
    members[target].add(si)
  }
}
