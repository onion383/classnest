import { packGroupsIntoDays } from './DutyArrangementDialog.packing.js'

// ===== 值日智能排表：槽位模型 + 座位分组 + 一级条件流水线 =====
// 条件按列表顺序逐条执行，越靠后越重要；同类型条件可重复添加。
// 值日表没有空间几何，所谓「一列 / 同桌 / 相邻六位」都是先从座位表抽取学生分组，
// 再把整组学生作为不可拆的操作单元放进不同的「天」里。
// ctx 契约：状态为 ref（模块内 .value 访问），跨模块方法运行时解析。

// Fisher-Yates 洗牌
export function shuffle(arr, random = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function useDutyArrangementPipeline(ctx, REGISTRY) {
  return {
    // ==================== 槽位模型 ====================
    // 槽位：{ item, day, k }，按「天」外层排列，使同一天连续
    buildSlots() {
      const slots = []
      ctx.daysArr.value.forEach(day => {
        ctx.itemsArr.value.forEach(it => {
          const n = Math.max(1, Number(it.count) || 1)
          for (let k = 0; k < n; k++) slots.push({ item: it.name, day, k })
        })
      })
      return slots
    },
    slotWeight(slot) {
      const w = ctx.weights.value?.[slot.item]?.[slot.day]
      return typeof w === 'number' ? w : 0.5
    },
    dayAvgWeight(day) {
      let sum = 0, n = 0
      ctx.itemsArr.value.forEach(it => {
        const c = Math.max(1, Number(it.count) || 1)
        sum += this.slotWeight({ item: it.name, day }) * c
        n += c
      })
      return n ? sum / n : 0
    },
    ledgerOf(name) {
      const v = ctx.ledger.value?.[name]
      return typeof v === 'number' ? v : 0
    },

    // ==================== 基准：从当前值日表开始 ====================
    buildBaseAssignment(slots) {
      const assigned = new Array(slots.length).fill('')
      const cells = ctx.baseCells.value || {}
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]
        const name = cells[s.item]?.[s.day]?.[s.k]
        if (typeof name === 'string' && name.trim()) assigned[i] = name.trim()
      }
      // 当前表里有空槽时，用还没上表的学生补齐；不够再轮转学生池
      // 学生池随数据源切换：全部同学 = 学生表名册；现有排表表格 = 表里的人
      const used = new Set(assigned.filter(Boolean))
      const rest = ctx.poolNames.value.filter(n => !used.has(n))
      this.fillEmptySlots(slots, assigned, rest)
      return assigned
    },
    // 补空槽：优先未上表的学生，其次轮转学生池；尽量不重复同一人。
    // 去重范围（dedupeKey）：
    //   日常值日 → 按「星期」去重（同一天不重复同一人）
    //   大扫除   → 整张表就是「一次活动」，一个人只能出现一次（不能同时扫第1大组和第2大组）
    fillEmptySlots(slots, assigned, extraPool) {
      const all = ctx.poolNames.value
      if (!all.length) return
      // 大扫除时列是「组」而不是「星期」→ 去重范围是整张表
      const wholeTable = ctx.dedupeWholeTable === true
      const keyOf = (day) => (wholeTable ? '__all__' : day)
      const daySets = {}
      assigned.forEach((n, i) => {
        if (!n) return
        const k = keyOf(slots[i].day)
        ;(daySets[k] = daySets[k] || new Set()).add(n)
      })
      const pool = [...(extraPool || []).filter(n => all.includes(n)), ...all]
      if (!pool.length) return
      let cursor = 0
      for (let i = 0; i < assigned.length; i++) {
        if (assigned[i]) continue
        const set = daySets[keyOf(slots[i].day)] = daySets[keyOf(slots[i].day)] || new Set()
        let pick = null
        for (let t = 0; t < pool.length; t++) {
          const n = pool[(cursor + t) % pool.length]
          if (!set.has(n)) { pick = n; cursor = (cursor + t + 1) % pool.length; break }
        }
        if (pick == null) { pick = pool[cursor % pool.length]; cursor = (cursor + 1) % pool.length }
        assigned[i] = pick
        set.add(pick)
      }
    },

    // ==================== 座位表抽取学生分组 ====================
    // 返回 [{ r, c, name }]，只保留有人的格子
    seatCellNames() {
      const seats = ctx.seat.value?.seats || []
      const idToName = new Map((ctx.students.value || []).map(s => [s.id, String(s.姓名 || '').trim()]))
      const cells = []
      seats.forEach((row, r) => {
        (row || []).forEach((val, c) => {
          let name = ''
          if (typeof val === 'number') name = idToName.get(val) || ''
          else if (typeof val === 'string') name = val.trim()
          else if (val && typeof val === 'object') name = String(val.姓名 || '').trim()
          if (name) cells.push({ r, c, name })
        })
      })
      return cells
    },
    // 座位几何分组：同学 / 同桌 / 相邻四位 / 相邻六位 / 一列 / 一大组（整块座位）
    seatGroups(shape) {
      const cells = this.seatCellNames()
      if (!cells.length) return []
      if (shape === 'student') return cells.map(c => [c.name])
      if (shape === 'bigroup') return [cells.map(c => c.name)]
      if (shape === 'column') {
        const map = new Map()
        cells.forEach(c => {
          if (!map.has(c.c)) map.set(c.c, [])
          map.get(c.c).push(c.name)
        })
        return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, names]) => names)
      }
      if (shape === 'deskmate') {
        const map = new Map()
        cells.forEach(c => {
          const key = c.r + ',' + Math.floor(c.c / 2)
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(c.name)
        })
        return [...map.values()]
      }
      // four = 2×2；six = 3×2
      const rSpan = shape === 'six' ? 3 : 2
      const map = new Map()
      cells.forEach(c => {
        const key = Math.floor(c.r / rSpan) + ',' + Math.floor(c.c / 2)
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(c.name)
      })
      return [...map.values()]
    },
    // 宿舍组：取分组管理当前维度的组
    dormGroups() {
      const buckets = typeof ctx.groupBuckets === 'function' ? ctx.groupBuckets() : []
      return buckets
        .map(g => g.filter(n => ctx.poolNames.value.includes(n)))
        .filter(g => g.length)
    },

    // 按操作单元切块：单元组之间不重叠，落在作用域外的人被剔除（整组不切半只在全员作用域成立）
    unitGroups(unit, context, slots, assigned) {
      const participants = context.participants
      if (unit === 'student') return [...participants].map(n => [n])
      if (unit === 'day') {
        const byDay = new Map(context.days.map(d => [d, new Set()]))
        slots.forEach((s, i) => {
          if (assigned[i] && byDay.has(s.day)) byDay.get(s.day).add(assigned[i])
        })
        return context.days
          .map(d => [...byDay.get(d)].filter(n => participants.has(n)))
          .filter(g => g.length)
      }
      const groups = unit === 'dorm' ? this.dormGroups() : this.seatGroups(unit)
      const out = []
      const claimed = new Set()
      for (const g of groups) {
        const names = g.filter(n => participants.has(n) && !claimed.has(n))
        if (!names.length) continue
        names.forEach(n => claimed.add(n))
        out.push(names)
      }
      for (const n of participants) if (!claimed.has(n)) out.push([n])
      return out
    },

    // ==================== 作用域：切成若干块，每块单独执行 ====================
    scopeContexts(scope, slots, assigned) {
      const allDays = ctx.daysArr.value
      const daySets = new Map(allDays.map(d => [d, new Set()]))
      slots.forEach((s, i) => {
        if (assigned[i] && daySets.has(s.day)) daySets.get(s.day).add(assigned[i])
      })
      const allNames = new Set(ctx.poolNames.value)
      if (scope === 'all') return [{ days: allDays, participants: allNames, key: 'all' }]
      if (scope === 'bigroup') {
        const seated = new Set(this.seatCellNames().map(c => c.name).filter(n => allNames.has(n)))
        return [{ days: allDays, participants: seated.size ? seated : allNames, key: 'bigroup' }]
      }
      if (scope === 'day') {
        return allDays.map(day => ({
          days: [day],
          participants: new Set(daySets.get(day)),
          key: 'day:' + day,
        }))
      }
      // 单个学生没有可整组挪动的空间，按无操作处理，避免把同一人的多天名额弄丢
      if (scope === 'student') {
        return [{ days: allDays, participants: new Set(), key: 'student', noop: true }]
      }
      const groups = scope === 'dorm' ? this.dormGroups() : this.seatGroups(scope)
      const contexts = []
      groups.forEach((g, idx) => {
        const participants = new Set(g.filter(n => allNames.has(n)))
        if (!participants.size) return
        const usedDays = allDays.filter(d => [...participants].some(n => daySets.get(d).has(n)))
        contexts.push({
          days: usedDays.length ? usedDays : allDays,
          participants,
          key: scope + ':' + idx,
        })
      })
      return contexts
    },
    // 把作用域内参与者的当前槽位空出来；返回每天可用的槽位下标
    vacateContext(slots, assigned, context) {
      const freeByDay = new Map(context.days.map(d => [d, []]))
      const participants = context.participants
      for (let i = 0; i < slots.length; i++) {
        const day = slots[i].day
        if (!freeByDay.has(day)) continue
        const name = assigned[i]
        if (name && participants.has(name)) {
          assigned[i] = ''
          freeByDay.get(day).push(i)
        } else if (!name) {
          freeByDay.get(day).push(i)
        }
      }
      return freeByDay
    },
    writeToDay(slots, assigned, freeByDay, day, names, writes) {
      const idxs = freeByDay.get(day) || []
      let n = 0
      for (const name of names) {
        const i = idxs.shift()
        if (i == null) break
        assigned[i] = name
        writes.push({ i, name, day })
        n++
      }
      return n
    },
    // 把单元组塞进每天的空槽：容量优先；装不下才拆尾数
    placeUnits(slots, assigned, freeByDay, units, opts = {}) {
      let list = units.filter(u => u.length)
      if (opts.order === 'ledger') {
        const avg = u => u.reduce((t, n) => t + this.ledgerOf(n), 0) / u.length
        list = [...list].sort((a, b) => avg(b) - avg(a))
      } else {
        list = shuffle(list)
      }
      const writes = []
      let placed = 0
      const tail = []
      const freeDays = () => [...freeByDay.entries()].filter(([, idxs]) => idxs.length)
      const maxFreeDay = () => freeDays().sort((a, b) => b[1].length - a[1].length)[0]?.[0]
      const pickDay = (size, hint) => {
        if (hint != null && (freeByDay.get(hint)?.length || 0) >= size) return hint
        const fits = freeDays().filter(([, idxs]) => idxs.length >= size)
        if (fits.length) {
          if (opts.dayPick === 'minWeight') {
            let best = null, bw = Infinity
            for (const [day] of fits) {
              const w = this.dayAvgWeight(day)
              if (w < bw) { bw = w; best = day }
            }
            return best
          }
          return fits.sort((a, b) => b[1].length - a[1].length)[0][0]
        }
        const best = freeDays().sort((a, b) => b[1].length - a[1].length)[0]
        if (!best) return null
        if (opts.dayPick === 'minWeight') {
          let day = best[0], bw = this.dayAvgWeight(day)
          for (const [d, idxs] of freeDays()) {
            if (idxs.length === best[1].length && this.dayAvgWeight(d) < bw) { bw = this.dayAvgWeight(d); day = d }
          }
          return day
        }
        return best[0]
      }
      for (const unit of list) {
        const names = shuffle(unit)
        const day = pickDay(names.length)
        if (!day) { tail.push({ names, hint: null }); continue }
        const room = freeByDay.get(day).length
        const take = Math.min(room, names.length)
        const chosen = names.slice(0, take)
        const rest = names.slice(take)
        placed += this.writeToDay(slots, assigned, freeByDay, day, chosen, writes)
        if (rest.length) tail.push({ names: rest, hint: day })
      }
      // 尾数：优先补到同组已经落座的天，其次任意还有空位的天；最后拆成单人
      for (const t of tail) {
        let names = shuffle(t.names)
        const day = pickDay(names.length, t.hint)
        if (day) {
          const room = freeByDay.get(day).length
          const take = Math.min(room, names.length)
          const chosen = names.slice(0, take)
          names = names.slice(take)
          placed += this.writeToDay(slots, assigned, freeByDay, day, chosen, writes)
        }
        for (const n of names) {
          const d = maxFreeDay()
          if (!d) break
          placed += this.writeToDay(slots, assigned, freeByDay, d, [n], writes)
        }
      }
      return { placed, writes }
    },

    // ==================== 条件执行 ====================
    buildAssignment() {
      const slots = this.buildSlots()
      ctx.satisfaction.value = {}
      if (!slots.length) return { slots, assigned: [] }
      const assigned = this.buildBaseAssignment(slots)
      for (const node of ctx.conditions.value) {
        const reg = REGISTRY[node.key]
        const fn = reg && reg.apply
        if (fn && typeof this[fn] === 'function') this[fn](slots, assigned, node)
      }
      return { slots, assigned }
    },
    // 按 axis 把槽位切成「桶」：column=同一列（日常的天 / 大扫除的工作区域）、
    // row=同一行（同一个劳动项目）、cell=同一格（同区域且同项目）。
    // 容量直接取分组后的槽位数，天然支持各项目 count 不同，不用从 itemsArr 反推。
    bucketIdxs(slots, axis) {
      const map = new Map()
      slots.forEach((s, i) => {
        const key = axis === 'row' ? 'item:' + s.item
          : axis === 'cell' ? 'cell:' + s.item + '\u0000' + s.day
            : 'col:' + s.day
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(i)
      })
      return [...map.values()]
    },
    // 随机分组：先离线装箱（尽量让整组落在同一个桶），桶标签等价时再把整桶随机映射一次。
    // 不再逐组「挑一天」：挑天不决定拆不拆，只决定去哪一天。
    applyPackedRandom(slots, assigned, node) {
      if (!slots.length) return
      const days = ctx.daysArr.value
      const participants = new Set(ctx.poolNames.value)
      const units = this.unitGroups(node.unit, { days, participants }, slots, assigned)
      const bucketIdxs = this.bucketIdxs(slots, node.axis)
      const caps = bucketIdxs.map(idxs => idxs.length)
      // 随机源可注入：单测要固定装箱与天内顺序；组件不提供时用 Math.random
      const rng = typeof ctx.packRandom === 'function' ? ctx.packRandom : Math.random
      // 大扫除以项目行/格子分桶时标签不等价（扫地 ≠ 拖地），整桶随机映射会把约束打乱；
      // 区域列也不等价（含内置「全部」列）且会抹掉手工分配，故大扫除一律关闭。
      const mapBuckets = !ctx.bigCleanup.value && node.axis !== 'row' && node.axis !== 'cell'
      const res = packGroupsIntoDays(units, caps.length, caps, rng, { mapBuckets })
      this.writeBuckets(slots, assigned, bucketIdxs, res.buckets, node.innerArrange, rng)
      // 满足率换成「整组同桶」口径：分子是完整落位的组数，不再是排进去的人数
      this.trackSatisfaction(node.uid, res.intactGroups, res.totalGroups)
    },
    // 把装箱结果写回槽位：每个桶按自己的槽位下标依次填，剩余空槽沿用现有轮转口径补齐。
    // innerArrange='random' 只打乱桶内的人名顺序，不改变谁在哪个桶（装箱结果）。
    writeBuckets(slots, assigned, bucketIdxs, buckets, innerArrange, rng) {
      assigned.fill('')
      bucketIdxs.forEach((idxs, bi) => {
        const names = buckets[bi] || []
        const ordered = innerArrange === 'random' ? shuffle(names, rng) : names
        for (let k = 0; k < ordered.length && k < idxs.length; k++) assigned[idxs[k]] = ordered[k]
      })
      this.fillEmptySlots(slots, assigned, [])
    },
    // 顺序排布：按方向生成槽位遍历路径。lr/rl 行优先（先走完一行再下一行），
    // tb/bt 列优先（先走完一列再下一列）。反向只反转「行内 / 列内」，
    // 主轴（行优先的项目序 / 列优先的星期序）保持正序。
    orderedPath(slots, direction) {
      const cells = new Map()
      slots.forEach((s, i) => {
        const k = s.item + '\u0000' + s.day
        if (!cells.has(k)) cells.set(k, [])
        cells.get(k).push(i)
      })
      const days = ctx.daysArr.value
      const items = ctx.itemsArr.value.map(it => it.name)
      const rowFirst = direction === 'lr' || direction === 'rl'
      const revInner = direction === 'rl' || direction === 'bt'
      const inner = rowFirst ? days : items
      const innerList = revInner ? [...inner].reverse() : inner
      const path = []
      for (const o of (rowFirst ? items : days)) {
        for (const i of innerList) {
          const key = rowFirst ? o + '\u0000' + i : i + '\u0000' + o
          path.push(...(cells.get(key) || []))
        }
      }
      return path
    },
    // 独立条件「顺序选项」：按数据源顺序、以 unit 切组，沿路径连续铺。
    // 不调装箱、不做随机映射、不记录满足率（确定性规则没有「尽量」目标）。
    // 一组占路径上连续 N 个槽；只有总人数超过总槽位时末尾才会被截断，如实报 dropped。
    applyOrdered(slots, assigned, node) {
      if (!slots.length) return { placed: 0, dropped: 0 }
      const days = ctx.daysArr.value
      const participants = new Set(ctx.poolNames.value)
      const units = this.unitGroups(node.unit, { days, participants }, slots, assigned)
      const path = this.orderedPath(slots, node.direction)
      assigned.fill('')
      let cursor = 0
      for (const unit of units) {
        if (cursor >= path.length) break
        for (const name of unit) {
          if (cursor >= path.length) break
          assigned[path[cursor++]] = name
        }
      }
      const totalPeople = units.reduce((n, g) => n + g.length, 0)
      const dropped = totalPeople - cursor
      // 人数少于槽位时沿用既有轮转口径补满（会重复值日，排表前已有确认提示）
      this.fillEmptySlots(slots, assigned, [])
      return { placed: cursor, dropped }
    },
    // 基础公平分配：学生按账本降序、槽位按权重升序配对；学生不够时循环使用。
    // 保留为独立工具（历史单测与后续跨模式公平可复用）。
    fairFill(slots) {
      const w = ctx.weights.value || {}
      const led = ctx.ledger.value || {}
      const students = ctx.poolNames.value.map(name => ({ name, led: led[name] || 0 }))
      students.sort((a, b) => b.led - a.led)
      const order = slots.map((s, i) => ({ i, w: w[s.item]?.[s.day] ?? 0.5 }))
      order.sort((a, b) => a.w - b.w)
      const assigned = new Array(slots.length).fill('')
      if (!students.length) return assigned
      for (let i = 0; i < order.length; i++) assigned[order[i].i] = students[i % students.length].name
      return assigned
    },
    // 辛苦度公平：按账本降序对学生、权重升序对槽位；允许时可再调整组内顺序
    applyFair(slots, assigned, node) {
      const contexts = this.scopeContexts(node.scope, slots, assigned)
      let done = 0, total = 0
      for (const c of contexts) {
        if (c.noop) continue
        const units = this.unitGroups(node.unit, c, slots, assigned)
        total += c.participants.size
        const free = this.vacateContext(slots, assigned, c)
        if (node.unit === 'student') {
          const names = [...c.participants].sort((a, b) => this.ledgerOf(b) - this.ledgerOf(a))
          const idxs = [...free.values()].flat().sort((a, b) => {
            const wa = this.slotWeight(slots[a]), wb = this.slotWeight(slots[b])
            return wa - wb
          })
          const n = Math.min(names.length, idxs.length)
          for (let i = 0; i < n; i++) assigned[idxs[i]] = names[i]
          done += n
        } else {
          const r = this.placeUnits(slots, assigned, free, units, {
            order: 'ledger',
            dayPick: 'minWeight',
          })
          done += r.placed
          if (node.innerOrder === 'yes' && r.writes.length) {
            this.reorderWithinDays(slots, assigned, r.writes)
          }
        }
      }
      this.trackSatisfaction(node.uid, done, total)
    },
    // 组内排序：同一天内，账本高的人坐权重低的槽
    reorderWithinDays(slots, assigned, writes) {
      const byDay = new Map()
      writes.forEach(w => {
        if (!byDay.has(w.day)) byDay.set(w.day, [])
        byDay.get(w.day).push(w)
      })
      byDay.forEach((list) => {
        const names = list.map(w => w.name).sort((a, b) => this.ledgerOf(b) - this.ledgerOf(a))
        const idxs = list.map(w => w.i).sort((a, b) => {
          const wa = this.slotWeight(slots[a]), wb = this.slotWeight(slots[b])
          return wa - wb
        })
        idxs.forEach((i, k) => { assigned[i] = names[k] })
      })
    },

    findByName(slots, assigned, name) {
      const out = []
      for (let i = 0; i < slots.length; i++) if (assigned[i] === name) out.push(i)
      return out
    },
    // 特殊关系：在同一天 / 不在同一天（按「天」判定，允许跨天调整）
    applyRelation(slots, assigned, node) {
      const a = node.a, b = node.b
      if (!a || !b || a === b) return
      const ia = this.findByName(slots, assigned, a)
      const ib = this.findByName(slots, assigned, b)
      const daysA = new Set(ia.map(i => slots[i].day))
      if (node.relationType === 'same') {
        let ok = ib.some(i => daysA.has(slots[i].day))
        if (!ok) {
          const targetDay = [...daysA][0]
          if (targetDay != null) {
            const empty = slots.findIndex((s, i) => s.day === targetDay && !assigned[i])
            if (empty >= 0) {
              const moveIdx = ib.find(i => !daysA.has(slots[i].day))
              if (moveIdx != null) {
                assigned[empty] = b
                assigned[moveIdx] = ''
                ok = true
              } else if (!ib.length) {
                assigned[empty] = b
                ok = true
              }
            } else {
              const swapIdx = slots.findIndex((s, i) =>
                s.day === targetDay && assigned[i] && assigned[i] !== a && assigned[i] !== b)
              if (swapIdx >= 0 && ib.length) {
                const tmp = assigned[swapIdx]
                assigned[swapIdx] = b
                assigned[ib[0]] = tmp
                ok = true
              }
            }
          }
        }
        this.trackSatisfaction(node.uid, ok ? 1 : 0, 1)
        return
      }
      // 不在同一天
      let ok = true
      for (const i of ib) {
        if (!daysA.has(slots[i].day)) continue
        const target = slots.findIndex((s, j) => !daysA.has(s.day) && !assigned[j])
        if (target >= 0) {
          assigned[target] = b
          assigned[i] = ''
          continue
        }
        const swap = slots.findIndex((s, j) =>
          !daysA.has(s.day) && assigned[j] && assigned[j] !== a && assigned[j] !== b)
        if (swap >= 0) {
          const tmp = assigned[swap]
          assigned[swap] = b
          assigned[i] = tmp
        } else {
          ok = false
        }
      }
      this.trackSatisfaction(node.uid, ok ? 1 : 0, 1)
    },
    // 特殊劳动：一定做 / 不做某项目
    applyLabor(slots, assigned, node) {
      const name = node.student
      const item = node.item
      if (!name || !item) return
      const want = node.action === 'do'
      const aSlots = this.findByName(slots, assigned, name)
      const inItem = aSlots.filter(i => slots[i].item === item)
      let ok
      if (want) {
        ok = inItem.length > 0
        if (!ok) {
          const empty = slots.findIndex((s, i) => s.item === item && !assigned[i])
          if (empty >= 0) {
            if (aSlots.length) { assigned[empty] = name; assigned[aSlots[0]] = '' }
            else assigned[empty] = name
            ok = true
          } else {
            const otherItem = aSlots.find(i => slots[i].item !== item)
            const target = slots.findIndex((s, i) => s.item === item && i !== aSlots[0])
            if (otherItem != null && target >= 0) {
              const tmp = assigned[target]
              assigned[target] = name
              assigned[otherItem] = tmp
              ok = true
            }
          }
        }
      } else {
        ok = inItem.length === 0
        if (!ok) {
          for (const idx of inItem) {
            const empty = slots.findIndex((s, i) => s.item !== item && !assigned[i])
            if (empty >= 0) { assigned[empty] = name; assigned[idx] = '' }
            else assigned[idx] = ''
          }
          if (!this.findByName(slots, assigned, name).length) ok = true
        }
      }
      this.trackSatisfaction(node.uid, ok ? 1 : 0, 1)
    },

    // ==================== 满足率 ====================
    trackSatisfaction(uid, done, total) {
      const st = ctx.satisfaction.value[uid] || { done: 0, total: 0 }
      st.done += done
      st.total += total
      ctx.satisfaction.value[uid] = st
    },
    satisfactionOf(node) {
      const st = ctx.satisfaction.value[node.uid]
      if (!st) return null
      return st.total ? Math.round((st.done / st.total) * 100) : 0
    },

    // ==================== 预览 ====================
    generatePreview() {
      const { slots, assigned } = this.buildAssignment()
      ctx.previewCells.value = this.buildCells(slots, assigned)
      ctx.previewVersion.value++
    },
    resetPreview() {
      ctx.previewCells.value = JSON.parse(JSON.stringify(ctx.baseCells.value || {}))
      ctx.previewVersion.value++
    },
    buildCells(slots, assigned) {
      const cells = {}
      ctx.itemsArr.value.forEach(it => {
        cells[it.name] = {}
        ctx.daysArr.value.forEach(d => { cells[it.name][d] = [] })
      })
      slots.forEach((s, i) => {
        const name = assigned[i]
        if (name) cells[s.item][s.day].push(name)
      })
      ctx.itemsArr.value.forEach(it => {
        const n = Math.max(1, Number(it.count) || 1)
        ctx.daysArr.value.forEach(d => {
          const arr = cells[it.name][d]
          while (arr.length < n) arr.push('')
        })
      })
      return cells
    },
    buildPreviewRows(cells) {
      const rows = []
      const days = ctx.daysArr.value
      ctx.itemsArr.value.forEach(it => {
        const n = Math.max(1, Number(it.count) || 1)
        for (let k = 0; k < n; k++) {
          rows.push({
            _rowKey: `it_${it.name}_${k}`,
            label: it.name,
            _isReadonly: true,
            _rowHeaderRowSpan: k === 0 ? n : 0,
            cells: days.map(day => ({ course: cells[it.name]?.[day]?.[k] || '' }))
          })
        }
      })
      return rows
    },
  }
}
