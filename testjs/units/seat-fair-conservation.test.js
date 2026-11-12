// =========================================================================
// seat-fair-conservation.test.js —— 位置公平算法（applyFair）的人数守恒
// 运行：npm run test:units
//
// 为什么单独建这个文件：
//   applyFair 把「学生组 i」放到「位置块 j」时，落盘按**目标块的位置数**遍历
//   （block.pos.forEach((p, k) => ... studs[k])），一旦块大小不等（'six' 按
//   3 行 × 2 列切，最后一块常常只有 2、4 格），"人多的小组"被分配到"位置少的块"
//   时，多出来的学生就成了 undefined，**既不落盘也不报错，直接从座位表里消失**。
//   界面看不出来 —— 少掉的人就是没出现在任何格子里。
//
// 判据：不管块大小怎么不均，排完后座位上的学生必须与排前**一模一样**（不丢、不重、不造）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIR = '../../student-frontend/src/components/dialogs/SmartArrangementDialog'
const loadPipeline = () => import(pathToFileURL(path.join(__dirname, DIR, 'SmartArrangementDialog.pipeline.js')).href)
const loadBlocks = () => import(pathToFileURL(path.join(__dirname, DIR, 'SmartArrangementDialog.blocks.js')).href)

// 造一个最小可用的 ctx（组件里是 ref，这里用 { value } 形状模拟）
function makeCtx({ rows, cols, weights, ledger, satisfaction = {} }) {
  return {
    rows: { value: rows },
    cols: { value: cols },
    mode: { value: 'double' },
    weights: { value: weights },
    ledger: { value: ledger },
    satisfaction: { value: satisfaction },
    shapeSpans(shape) {
      if (shape === 'whole') return { rSpan: rows, cSpan: cols }
      if (shape === 'six') return { rSpan: 3, cSpan: 2 }
      if (shape === 'student') return { rSpan: 1, cSpan: 1 }
      return { rSpan: 2, cSpan: 2 }
    },
    trackSatisfaction(key, done, total) {
      this.satisfaction.value[key] = { done, total }
    },
  }
}

const stu = (id, led) => ({ id, 姓名: id, 性别: '男', __led: led })

// 拍平网格里的学生，用来判「不丢 / 不重 / 不造」
function snapshot(grid) {
  const out = []
  for (const row of grid) for (const cell of row) if (cell) out.push(cell)
  return out
}
function idsOf(list) { return list.map(s => s.id).sort() }

// 让空间排法：region 全给，splitRegion('six') 按 3 行 × 2 列切
// 4 行 → 块 A（行 0-2，6 格）+ 块 B（行 3，2 格）：**块大小 6 vs 2**
async function runFair({ rows, cols, fill, weights, innerOrder }) {
  const { useSmartArrangementPipeline } = await loadPipeline()
  const { useSmartArrangementBlocks } = await loadBlocks()

  const grid = Array.from({ length: rows }, () => Array(cols).fill(null))
  const ledger = {}
  fill(grid, ledger)

  const region = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) region.push({ r, c })

  const ctx = makeCtx({ rows, cols, weights, ledger })
  ctx.splitRegion = useSmartArrangementPipeline(ctx, {}).splitRegion
  const blocks = useSmartArrangementBlocks(ctx)

  const before = idsOf(snapshot(grid))
  blocks.applyFair(grid, [region], { uid: 'n1', unit: 'six', innerOrder })
  const after = idsOf(snapshot(grid))

  return { grid, before, after, satisfaction: ctx.satisfaction.value.n1 }
}

// =========================================================================
// 守恒：块大小不等时也不能丢人
// 下面这个排法里，A 块 6 人（账本高）、B 块 2 人（账本低），权重是 A 高 B 低，
// 于是「A 组 → B 块」代价更低 —— 旧实现把 6 个人往 2 个格子里塞，丢掉 4 个。
// =========================================================================
function skewed({ rows = 4, cols = 2 } = {}) {
  const weights = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, () => (r < 3 ? 10 : 0)))
  const fill = (grid, ledger) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inA = r < 3
        const id = `s${r}${c}`
        const led = inA ? 10 : 0
        grid[r][c] = stu(id, led)
        ledger[id] = led
      }
    }
  }
  return { rows, cols, fill, weights }
}

test('块大小 6 vs 2：账本高的 6 人组被分配到 2 格块，不能丢人', async () => {
  const { rows, cols, fill, weights } = skewed()
  const { after, satisfaction, grid } = await runFair({ rows, cols, fill, weights, innerOrder: 'no' })
  assert.equal(after.length, rows * cols, '排完后座位上的学生数必须等于排前（一格一人）')
  assert.deepEqual(after, ['s00', 's01', 's10', 's11', 's20', 's21', 's30', 's31'])
  assert.deepEqual(satisfaction, { done: 8, total: 8 }, '满足率口径按实际人数统计')
  // 罚分生效的判据：装不下的配对（6 人 → 2 格）被排除，整块保持原样，
  // 而不是靠「溢出补空位」把 6 人拆散塞进两个块（那会打乱同桌关系）
  const idsOfRow = r => grid[r].map(cell => cell && cell.id)
  assert.deepEqual(idsOfRow(0), ['s00', 's01'])
  assert.deepEqual(idsOfRow(1), ['s10', 's11'])
  assert.deepEqual(idsOfRow(2), ['s20', 's21'])
  assert.deepEqual(idsOfRow(3), ['s30', 's31'])
})

test('块大小相等时组内排序照旧：账本高的人坐权重低的格', async () => {
  // 6 行 × 4 列，'six' 切成 4 个 6 格块（全等）。左半区权重低、右半区权重高；
  // 左块学生的账本高，右块低 → 理想解是两块不换，只在块内把账本高的排到权重低的格。
  const rows = 6, cols = 4
  const weights = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => (c < 2 ? r * 2 + c : 10 + r * 2 + (c - 2))))
  const fill = (grid, ledger) => {
    const left = [10, 8, 6, 4, 2, 0]
    let k = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // 左块按「账本降序」摆成与权重同序（最差排法），右块账本全 0
        const led = c < 2 ? left[k % 6] : 0
        if (c < 2) k++
        grid[r][c] = stu(`s${r}${c}`, led)
        ledger[`s${r}${c}`] = led
      }
    }
  }
  const { grid } = await runFair({ rows, cols, fill, weights, innerOrder: 'yes' })
  // 判据：每个 6 格块内，按权重升序取格子，学生账本必须是降序
  for (const r0 of [0, 3]) {
    for (const c0 of [0, 2]) {
      const cells = []
      for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 2; c++) cells.push({ r, c, w: weights[r][c], led: grid[r][c].__led })
      cells.sort((a, b) => a.w - b.w)
      const leds = cells.map(x => x.led)
      assert.deepEqual(leds, [...leds].sort((a, b) => b - a),
        `块(${r0},${c0}) 内账本应随权重升高而递减，实际 ${leds.join(',')}`)
    }
  }
})

test('块大小 6 vs 2 + 组内排序：同样不能丢人', async () => {
  const { rows, cols, fill, weights } = skewed()
  const { after } = await runFair({ rows, cols, fill, weights, innerOrder: 'yes' })
  assert.equal(after.length, rows * cols)
  assert.deepEqual(after, ['s00', 's01', 's10', 's11', 's20', 's21', 's30', 's31'])
})

// 块数 > 7 时走贪心（不是全排列），可能出现「大组只剩小块」的必然溢出。
// 这个场景专门覆盖「溢出兜底」那条分支：前 3 个 2 格块的学生账本最高，贪心先把它们
// 塞进前 3 个 6 格块（装得下、不罚分），剩下 3 个 6 人组只能进 3 个 2 格块 → 溢出 12 人。
// 旧实现按目标块长度截断，这 12 个人直接消失；修好后必须全部补进空位。
test('9 个块（贪心）+ 必然溢出：12 个溢出学生也要一个不少', async () => {
  const rows = 7, cols = 6 // 'six' = 3 行 × 2 列 → 6 个 6 格块 + 3 个 2 格块
  const weights = Array.from({ length: rows }, () => Array(cols).fill(0))
  const fill = (grid, ledger) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const led = r < 6 ? 0 : 100
        grid[r][c] = stu(`s${r}${c}`, led)
        ledger[`s${r}${c}`] = led
      }
    }
  }
  const { after } = await runFair({ rows, cols, fill, weights, innerOrder: 'no' })
  assert.equal(after.length, rows * cols, `应有 ${rows * cols} 人，实际只排了 ${after.length} 人`)
  const expected = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expected.push(`s${r}${c}`)
  assert.deepEqual(after, expected)
})

test('块大小 6 vs 4：不丢人', async () => {
  const { rows, cols, fill, weights } = skewed({ rows: 5, cols: 2 })
  const { after } = await runFair({ rows, cols, fill, weights, innerOrder: 'no' })
  assert.equal(after.length, 10)
  assert.deepEqual(after, ['s00', 's01', 's10', 's11', 's20', 's21', 's30', 's31', 's40', 's41'])
})

// 有空格子（座位没坐满）时：仍要守恒，且空出来的格数不变
test('块内本来有空位：不丢人、不凭空造人', async () => {
  const rows = 4, cols = 2
  const weights = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, () => (r < 3 ? 10 : 0)))
  const fill = (grid, ledger) => {
    // A 块 6 格只坐 4 人（留 2 空），B 块 2 格坐满
    const names = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2']
    let k = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r < 3 && k >= 4) continue
        grid[r][c] = stu(names[k], r < 3 ? 10 : 0)
        ledger[names[k]] = r < 3 ? 10 : 0
        k++
      }
    }
  }
  const { after } = await runFair({ rows, cols, fill, weights, innerOrder: 'no' })
  assert.equal(after.length, 6, '排前 6 人，排后必须还是 6 人')
  assert.deepEqual(after, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2'])
})

// =========================================================================
// 2-2：组→块代价的「记忆化」不能改变最优对应
//
// applyFair 求组→块最优一一对应时，组数 ≤ 7 走全排列枚举。原来的 costOf 是纯函数，
// 却在每次排列里对同一 (组, 块) 重复计算，7 块场景一次点击要算 5040 × 7 次；
// 改为按 (i, j) 记忆化后只算 n² 次。判据：选出的对应与落盘结果必须与
// 「逐对重算」的参考实现逐格一致（下面这份参考实现就是改造前的口径，故意不复用缓存）。
// =========================================================================
// 参考实现：逐对重算 + 同序全排列枚举（与改造前逐行等价，供对拍用）
function referenceOrder(studLeds, blockWeights, allowInner) {
  const n = studLeds.length
  const costOf = (i, j) => {
    let ls = studLeds[i]
    let ws = blockWeights[j]
    if (allowInner) {
      ls = [...ls].sort((a, b) => b - a)
      ws = [...ws].sort((a, b) => a - b)
    }
    let sum = 0
    for (let k = 0; k < Math.min(ls.length, ws.length); k++) sum += ls[k] * ws[k]
    return sum
  }
  const a = Array.from({ length: n }, (_, i) => i)
  let best = null, bestCost = Infinity
  const permute = (arr, k) => {
    if (k === arr.length) {
      let c = 0
      for (let i = 0; i < n; i++) c += costOf(i, arr[i])
      if (c < bestCost - 1e-9) { bestCost = c; best = [...arr] }
      return
    }
    for (let i = k; i < arr.length; i++) {
      ;[arr[k], arr[i]] = [arr[i], arr[k]]
      permute(arr, k + 1)
      ;[arr[k], arr[i]] = [arr[i], arr[k]]
    }
  }
  permute(a, 0)
  return best
}

// 6 行 × 6 列 + unit='six' → 2×3 = 6 个等大块（每块 6 格），正好落在全排列分支
function makeSixBySix(weightOf, ledOf) {
  const rows = 6, cols = 6
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null))
  const weights = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => weightOf(r, c)))
  const ledger = {}
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `s${r}${c}`
      const led = ledOf(r, c)
      grid[r][c] = { id, 姓名: id, 性别: '男', __led: led }
      ledger[id] = led
    }
  }
  const region = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) region.push({ r, c })
  return { rows, cols, grid, weights, ledger, region }
}

async function runFairOn(regions, fixture, innerOrder) {
  const { useSmartArrangementPipeline } = await loadPipeline()
  const { useSmartArrangementBlocks } = await loadBlocks()
  const { grid, weights, ledger } = fixture
  const ctx = makeCtx({ rows: grid.length, cols: grid[0].length, weights, ledger })
  const pipeline = useSmartArrangementPipeline(ctx, {})
  ctx.splitRegion = pipeline.splitRegion
  const blocks = useSmartArrangementBlocks(ctx)
  blocks.applyFair(grid, regions, { uid: 'n1', unit: 'six', innerOrder })
  return { grid, splitRegion: pipeline.splitRegion }
}

// 参考实现给出的「目标块 j ← 来源组 i」落盘后，每块里的 id 序列
// before = 排表前的 id 网格（applyFair 会就地改写 grid，不能拿它当输入）
function expectedIdsByBlock(sixBlocks, reference, before, weights, innerOrder) {
  const wOf = (p) => weights[p.r][p.c]
  return sixBlocks.map((b, j) => {
    const src = reference.indexOf(j)
    const studs = sixBlocks[src].pos.map(p => before[p.r][p.c])
    const ordered = [...studs]
    if (innerOrder === 'yes') ordered.sort((x, y) => y.__led - x.__led)
    const target = innerOrder === 'yes' ? [...b.pos].sort((x, y) => wOf(x) - wOf(y)) : b.pos
    return target.map((p, k) => ordered[k]?.id ?? null)
  })
}

for (const innerOrder of ['no', 'yes']) {
  test(`2-2 记忆化等价 · 6 块全排列（innerOrder=${innerOrder}）选出的对应与逐对重算一致`, async () => {
    // 账本与权重同向递增：按重排不等式，最优解必然是「反向配对」，不是恒等置换
    const fixture = makeSixBySix((r, c) => r * 6 + c, (r, c) => r * 6 + c)
    const before = fixture.grid.map(row => row.map(s => s && { ...s }))
    const { grid, splitRegion } = await runFairOn([fixture.region], fixture, innerOrder)
    const sixBlocks = splitRegion(fixture.region, 'six')
    assert.equal(sixBlocks.length, 6, '6×6 + six 必须切成 6 块（否则测的不是全排列分支）')
    const studLeds = sixBlocks.map(b => b.pos.map(p => before[p.r][p.c].__led))
    const blockWeights = sixBlocks.map(b => b.pos.map(p => fixture.weights[p.r][p.c]))
    const ref = referenceOrder(studLeds, blockWeights, innerOrder === 'yes')
    assert.notDeepEqual(ref, [0, 1, 2, 3, 4, 5], '这个夹具的最优解不该是恒等置换，否则对拍无效')
    assert.deepEqual(
      sixBlocks.map(b => b.pos.map(p => grid[p.r][p.c].id)),
      expectedIdsByBlock(sixBlocks, ref, before, fixture.weights, innerOrder),
      '记忆化后的落盘必须与「逐对重算」参考实现逐格一致',
    )
  })
}

test('2-2 记忆化等价 · 两个作用域各自独立：后一块不能复用前一块的代价', async () => {
  // A 区（行 0-2）权重逐块递增、B 区（行 3-5）逐块递减，账本单调递增。
  // 若代价缓存跨作用域复用，B 区会沿用 A 区的位置代价，选出与「单独排 B」不同的对应。
  const weightOf = (r, c) => {
    const local = c % 2 + Math.floor(c / 2) // 0,1,1,2,2,3 → 逐块递增
    return r < 3 ? local : 2 - local
  }
  const fixture = makeSixBySix(weightOf, (r, c) => r * 6 + c)
  const regionA = fixture.region.filter(p => p.r < 3)
  const regionB = fixture.region.filter(p => p.r >= 3)
  const both = await runFairOn([regionA, regionB], fixture, 'no')
  const gridAfter = both.grid.map(row => row.map(s => s && s.id))

  // 单独排 B 区（同样从原始座位开始）
  const alone = makeSixBySix(weightOf, (r, c) => r * 6 + c)
  const only = await runFairOn([alone.region.filter(p => p.r >= 3)], alone, 'no')
  assert.deepEqual(gridAfter.slice(3), only.grid.slice(3).map(row => row.map(s => s && s.id)),
    'B 区结果必须与「单独排 B 区」一致（缓存不许跨作用域泄漏）')
})

