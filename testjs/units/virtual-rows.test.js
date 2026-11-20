// =========================================================================
// virtual-rows.test.js —— 已处理列表的行虚拟滚动纯计算
//
// 结构照 DynamicTable（垫片 + 二分 + 两屏 overscan），只是行高固定、步长可除。
// 钉住四条最容易错的性质：
//   1. 总高恒等于 count * step —— 滚动条长度不能随窗口变化，否则滚动时会「跳」
//   2. padTop / padBottom 与窗口首尾严格对齐（错一格就错位）
//   3. 滚到顶/底不越界、不返回空窗口（露白）
//   4. overscan 至少两屏（矮行高 + 高视口时不至于第一屏就露垫片）
// 变异反证：把 padBottom 改成 (n-end) * rowH（漏掉 gap）→ 第 1 条立刻红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = path.join(__dirname, '..', '..')
// 前端 utils 是 ESM，用 .mjs 动态 import 读
const MOD = path.join(ROOT, 'student-frontend/src/utils/virtualRows.js')

test('行虚拟滚动：垫片与总高', async (t) => {
  const { visibleFixedRows } = await import('file://' + MOD.replace(/\\/g, '/'))
  const ROW = 110
  const GAP = 8
  const STEP = ROW + GAP

  const at = (scrollTop, count = 500, viewH = 600) =>
    visibleFixedRows({ scrollTop, viewH, rowH: ROW, gap: GAP, count })

  await t.test('空列表：全零，不抛', () => {
    const v = visibleFixedRows({ scrollTop: 0, viewH: 600, rowH: ROW, gap: GAP, count: 0 })
    assert.deepEqual(
      { contentH: v.contentH, padTop: v.padTop, padBottom: v.padBottom, rows: v.rows },
      { contentH: 0, padTop: 0, padBottom: 0, rows: [] }
    )
    // 行高缺失（布局未就绪）同样安全
    const bad = visibleFixedRows({ scrollTop: 0, viewH: 600, rowH: 0, count: 10 })
    assert.equal(bad.rows.length, 0)
  })

  await t.test('首屏：从第 0 行开始，上方无垫片', () => {
    const v = at(0)
    assert.equal(v.start, 0)
    assert.equal(v.padTop, 0)
    assert.ok(v.end > 0)
  })

  await t.test('总高恒等于 count * step（滚动条长度不随窗口跳）', () => {
    for (const st of [0, 500, 3000, 99999]) {
      assert.equal(at(st).contentH, 500 * STEP, `scrollTop=${st} 时总高变了`)
    }
  })

  await t.test('三段严丝合缝：padTop + 窗口 + padBottom = 总高', () => {
    for (const st of [0, 1234, 8000]) {
      const v = at(st)
      const winH = (v.end - v.start) * STEP
      assert.equal(v.padTop + winH + v.padBottom, v.contentH, `scrollTop=${st} 时三段对不上`)
      assert.equal(v.padTop, v.start * STEP)
      assert.equal(v.padBottom, (500 - v.end) * STEP)
    }
  })

  await t.test('滚到中部：窗口覆盖视口，且有缓冲行', () => {
    const v = at(2000)
    assert.ok(v.start < Math.floor(2000 / STEP), '窗口起点要在视口上方留缓冲')
    assert.ok(v.end > Math.ceil((2000 + 600) / STEP), '窗口终点要在视口下方留缓冲')
  })

  await t.test('滚到底：下半垫片归零，窗口不漏', () => {
    const total = 500 * STEP
    const v = at(total)
    assert.equal(v.end, 500, '到底时窗口要到最后一行的后一位')
    assert.equal(v.padBottom, 0)
    assert.ok(v.rows.length > 0, '到底不能返回空窗口')
  })

  await t.test('小列表全部渲染（首次打开不会只给几行）', () => {
    const v = at(0, 3)
    assert.deepEqual(v.rows, [0, 1, 2])
    assert.equal(v.padTop, 0)
    assert.equal(v.padBottom, 0)
  })

  await t.test('overscan 至少两屏：高视口 + 矮行高不露垫片', () => {
    const v = visibleFixedRows({ scrollTop: 5000, viewH: 1200, rowH: 110, gap: 8, count: 500, overscan: 8 })
    const viewRows = Math.ceil(1200 / STEP)
    assert.ok(
      v.end - v.start >= viewRows * 3,
      `窗口只有 ${v.end - v.start} 行，视口就要 ${viewRows} 行，缓冲不足`
    )
  })
})
