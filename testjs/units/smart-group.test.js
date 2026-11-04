// =========================================================================
// smart-group.test.js —— 智能分组核心算法（SmartGroupDialog.pipeline.js）
// 运行：npm run test:units
//
// 为什么单独建这个文件：
//   这套算法是「性别比例」条件的核心，此前**一条单测都没有**，导致
//   single 模式在男女比例悬殊时会静默丢学生（4 男 4 女分 3 组少 1 人、
//   10 男 1 女分 3 组少 2 人），界面上看不出来 —— 少掉的人就是没出现在任何组里。
//
// 判据分两类：
//   1. 守恒：不管什么条件组合，分配后的人数必须恰好等于名册人数（缺一不可）
//   2. 语义：single 模式下不能出现混性别组（G ≥ 2 时）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadPipeline = () => import(pathToFileURL(path.join(
  __dirname, '../../student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.pipeline.js',
)).href)

// 造一个最小可用的 ctx（组件里是 ref，这里用 { value } 形状模拟）
function makeCtx(roster, groupCount, stages) {
  const ctx = {
    roster: { value: roster },
    groups: { value: Array.from({ length: groupCount }, (_, i) => ({ name: '组' + (i + 1) })) },
    stages: { value: stages },
    satisfaction: { value: {} },
    // 与组件里的 trackSatisfaction 同签名：记「达成数 / 总数」
    trackSatisfaction(key, done, total) {
      this.satisfaction.value[key] = { done, total }
    },
  }
  return ctx
}

// 生成名册：男生、女生、性别未知各若干
function makeRoster(boys, girls, others = 0) {
  const roster = []
  for (let i = 0; i < boys; i++) roster.push({ id: 'b' + i, 姓名: '男' + i, 性别: '男' })
  for (let i = 0; i < girls; i++) roster.push({ id: 'g' + i, 姓名: '女' + i, 性别: '女' })
  for (let i = 0; i < others; i++) roster.push({ id: 'o' + i, 姓名: '未' + i, 性别: '' })
  return roster
}

const GENDER_STAGE = (mode = 'single') => [{ type: 'gender', mode, key: 'gender' }]

async function assign(roster, G, stages) {
  const { useSmartGroupPipeline } = await loadPipeline()
  const ctx = makeCtx(roster, G, stages)
  const { buildAssignment } = useSmartGroupPipeline(ctx)
  const res = buildAssignment()
  const placed = res.members.reduce((n, s) => n + s.size, 0)
  // 每组里出现过的性别（跳过空字符串/未知），用来判有没有混性别组
  const mixedGroups = []
  res.members.forEach((set, gi) => {
    const kinds = new Set([...set].map(si => roster[si].性别).filter(Boolean))
    if (kinds.size > 1) mixedGroups.push(gi)
  })
  return { res, placed, mixedGroups, satisfaction: ctx.satisfaction.value }
}

// =========================================================================
// 守恒：single 模式绝不能丢学生
// 这几个用例都是旧实现的失手点（性别比例悬殊时子池容量不足 → break 丢弃）
// =========================================================================
const SHAKY_CASES = [
  { boys: 4, girls: 4, G: 3, why: '女生只有 1 个组、容量 3 < 4' },
  { boys: 10, girls: 1, G: 3, why: '男生 2 个组、容量 8 < 10' },
  { boys: 9, girls: 2, G: 3, why: '男生 2 个组、容量 7+ < 9' },
  { boys: 1, girls: 10, G: 3, why: '镜像场景：女生一侧溢出' },
  { boys: 15, girls: 2, G: 4, why: '大班 + 个别女生' },
]

for (const { boys, girls, G, why } of SHAKY_CASES) {
  test(`single 模式不丢学生：${boys} 男 ${girls} 女 → ${G} 组（${why}）`, async () => {
    const roster = makeRoster(boys, girls)
    const { placed, res } = await assign(roster, G, GENDER_STAGE())
    assert.equal(placed, roster.length, `应有 ${roster.length} 人，实际只分配了 ${placed} 人`)
    assert.deepEqual(res.members.map(s => s.size).reduce((a, b) => a + b, 0), roster.length)
  })
}

// =========================================================================
// 语义：single 模式不要混性别组
// =========================================================================
test('single 模式不产生混性别组（男女都有、G ≥ 2）', async () => {
  for (const [boys, girls, G] of [[4, 4, 3], [10, 1, 3], [6, 6, 4], [3, 9, 2]]) {
    const roster = makeRoster(boys, girls)
    const { mixedGroups } = await assign(roster, G, GENDER_STAGE())
    assert.deepEqual(mixedGroups, [], `${boys} 男 ${girls} 女 ${G} 组出现混性别组：${JSON.stringify(mixedGroups)}`)
  }
})

test('single 模式全员同性别时正常分组且不丢人', async () => {
  const roster = makeRoster(0, 9)
  const { placed, res, mixedGroups } = await assign(roster, 3, GENDER_STAGE())
  assert.equal(placed, 9)
  assert.deepEqual(mixedGroups, [])
  // 均匀：3 组 9 人 → 每组正好 3 人
  assert.deepEqual(res.members.map(s => s.size), [3, 3, 3])
})

// 每个组属于哪个「性别池」：全男 / 全女 / 空组
function kindsOf(members, roster) {
  return members.map(set => {
    const kinds = new Set([...set].map(si => roster[si].性别).filter(Boolean))
    if (kinds.size === 0) return 'empty'
    if (kinds.size > 1) return 'mixed'
    return [...kinds][0]
  })
}

// 均匀性：**同一个性别池内**各组人数差不超过 1。
// 跨池不能比 —— 5 男 1 女分 3 组时，男生组必然 5 人、女生组 1 人，这不是不均匀。
// 这条判据守的是「池容量被算成全局平均」那类退化：容量给错时人数会往同一组堆。
test('single 模式：同一性别池内各组人数差不超过 1', async () => {
  const cases = [[4, 4, 3], [10, 1, 3], [9, 2, 3], [15, 2, 4], [1, 10, 3], [8, 3, 3], [6, 6, 4], [7, 5, 5]]
  for (const [boys, girls, G] of cases) {
    const roster = makeRoster(boys, girls)
    const { res } = await assign(roster, G, GENDER_STAGE())
    const kinds = kindsOf(res.members, roster)
    const byPool = {}
    kinds.forEach((kind, gi) => {
      if (kind === 'empty' || kind === 'mixed') return
      ;(byPool[kind] ||= []).push(res.members[gi].size)
    })
    for (const [pool, sizes] of Object.entries(byPool)) {
      const gap = Math.max(...sizes) - Math.min(...sizes)
      assert.ok(gap <= 1, `${boys} 男 ${girls} 女 → ${G} 组：${pool}生组人数 ${JSON.stringify(sizes)} 相差 ${gap}`)
    }
  }
})

// =========================================================================
// 边界：只有 1 个组时「男女分开」物理上不可能
//   → 正确行为是全部塞进唯一那组（绝不丢人），满足率记 0 而不是谎报 100%
// =========================================================================
test('G=1 且男女混合：不丢人，满足率如实记 0', async () => {
  const roster = makeRoster(5, 3)
  const { placed, satisfaction } = await assign(roster, 1, GENDER_STAGE())
  assert.equal(placed, 8, '1 个组也必须装下全部 8 人')
  assert.equal(satisfaction.gender.done, 0, '男女混合分进同一组，这条条件一条也没达成')
  assert.equal(satisfaction.gender.total, 8)
})

test('G=1 且只有一种性别：满足率记满', async () => {
  const roster = makeRoster(0, 6)
  const { placed, satisfaction } = await assign(roster, 1, GENDER_STAGE())
  assert.equal(placed, 6)
  assert.equal(satisfaction.gender.done, 6)
})

// =========================================================================
// 守恒：balanced 模式与「性别条件叠在其他条件之后」也要守恒
// =========================================================================
test('balanced 模式不丢学生', async () => {
  for (const [boys, girls, G] of [[10, 2, 3], [4, 4, 3], [7, 7, 2]]) {
    const roster = makeRoster(boys, girls)
    const { placed } = await assign(roster, G, GENDER_STAGE('balanced'))
    assert.equal(placed, roster.length, `${boys} 男 ${girls} 女 ${G} 组 balanced 丢了人`)
  }
})

test('性别条件排在关系条件之后：先塞后分也不丢人', async () => {
  const roster = makeRoster(8, 4, 1)
  // 指定两个学生必须在同一组（关系条件会先往组里塞人，再跑性别条件）
  const stages = [
    { type: 'relation', kind: 'same', a: roster[0].id, b: roster[5].id, key: 'rel' },
    { type: 'gender', mode: 'single', key: 'gender' },
  ]
  const { placed } = await assign(roster, 3, stages)
  assert.equal(placed, roster.length)
})

// =========================================================================
// 属性扫描：一组笛卡尔积穷举，保证任何人数 / 组数组合都守恒
// =========================================================================
test('穷举 1~12 人 / 1~5 组：single 模式下人数始终守恒', async () => {
  const bad = []
  for (let G = 1; G <= 5; G++) {
    for (let boys = 0; boys <= 12; boys++) {
      for (let girls = 0; girls <= 12 - boys; girls++) {
        if (boys + girls === 0) continue
        const roster = makeRoster(boys, girls)
        const { placed } = await assign(roster, G, GENDER_STAGE())
        if (placed !== roster.length) bad.push(`${boys}男${girls}女/${G}组→${placed}/${roster.length}`)
      }
    }
  }
  assert.deepEqual(bad, [], '这些组合丢了学生：' + bad.slice(0, 10).join('，'))
})
