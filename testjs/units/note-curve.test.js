// =========================================================================
// note-curve.test.js —— 便签画笔的笔锋（变宽）与曲线几何
//
// 起因（审查 v4 · V4-B12-02）：drawCurveSegment 把一段曲线一次性 stroke()，
// 循环里逐点设的 ctx.lineWidth 会被最后一点覆盖 —— lineWidth 是 stroke() 那一刻
// 才读的状态，所以「起笔细、压笔粗」的笔锋整段塌成末端宽度。
//
// 这个模块无任何依赖，直接 import 即可（不需要 Vite）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = () => import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/subwindows/widget/Note.curve.js')).href)

// 记录每次 stroke 的宽度与它的点序列
function fakeCtx() {
  let cur = []
  const strokes = []
  return {
    lineWidth: 1,
    strokes,
    beginPath() { cur = [] },
    moveTo(x, y) { cur.push({ x, y }) },
    lineTo(x, y) { cur.push({ x, y }) },
    stroke() { strokes.push({ width: this.lineWidth, points: cur.slice() }) },
  }
}

const pt = (x, y, w) => ({ x, y, w })

test('笔锋：一段曲线内按宽度分段描边，不是整段一个宽度', async () => {
  const { drawCurveSegment } = await load()
  const ctx = fakeCtx()
  // 起笔 1px、收笔 9px（模拟压感/速度变化）
  drawCurveSegment(ctx, pt(0, 0, 1), pt(10, 0, 1), pt(20, 0, 9), pt(30, 0, 9))

  assert.ok(ctx.strokes.length >= 2, `至少两次 stroke，实际 ${ctx.strokes.length}`)
  const widths = ctx.strokes.map((s) => s.width)
  assert.ok(Math.max(...widths) - Math.min(...widths) > 1,
    `宽度必须有变化（这条断言在「整段一次 stroke」的旧实现上必挂）：${widths.join(', ')}`)
  assert.ok(widths[0] < widths[widths.length - 1], `应从小变到大：${widths.join(', ')}`)
  assert.ok(widths[0] >= 0.9 && widths[0] <= 1.6, `起笔宽度应接近 1：${widths[0]}`)
  assert.ok(widths[widths.length - 1] >= 7 && widths[widths.length - 1] <= 9.5, `收笔宽度应接近 9：${widths[widths.length - 1]}`)
})

test('性能上限：长线段不会按插值点数放大 stroke 次数', async () => {
  const { drawCurveSegment } = await load()
  const ctx = fakeCtx()
  // 600px → 插值步数 200；分组后应远少于这个数
  drawCurveSegment(ctx, pt(0, 0, 3), pt(0, 0, 3), pt(600, 0, 3), pt(600, 0, 3))
  assert.ok(ctx.strokes.length <= 13, `stroke 次数应受 MAX_SUB_STROKES 约束，实际 ${ctx.strokes.length}`)
  assert.ok(ctx.strokes.length >= 8, `也不能为了省事把一段画成两条，实际 ${ctx.strokes.length}`)
})

test('等宽笔（圆珠笔）保持单一宽度', async () => {
  const { drawCurveSegment } = await load()
  const ctx = fakeCtx()
  drawCurveSegment(ctx, pt(0, 0, 4), pt(10, 0, 4), pt(20, 0, 4), pt(30, 0, 4))
  const widths = ctx.strokes.map((s) => s.width)
  assert.ok(widths.every((w) => Math.abs(w - 4) < 1e-6), `等宽笔不该有宽度抖动：${widths.join(', ')}`)
})

test('起笔点与第二点重合时不产生 NaN（否则整段路径失效、笔画断线）', async () => {
  const { drawCurveSegment } = await load()
  const ctx = fakeCtx()
  // pointBuffer 初始就是两个相同点，这是真实调用路径
  drawCurveSegment(ctx, pt(50, 50, 3), pt(50, 50, 3), pt(60, 60, 3), pt(70, 70, 3))
  for (const s of ctx.strokes) {
    assert.ok(Number.isFinite(s.width) && s.width > 0, `宽度非法：${s.width}`)
    for (const p of s.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `坐标非法：${JSON.stringify(p)}`)
    }
  }
})

test('几何：曲线点落在 p1→p2 附近（不会飞出去）', async () => {
  const { drawCurveSegment } = await load()
  const ctx = fakeCtx()
  drawCurveSegment(ctx, pt(0, 0, 2), pt(10, 20, 2), pt(40, 30, 2), pt(60, 10, 2))
  const xs = ctx.strokes.flatMap((s) => s.points.map((p) => p.x))
  const ys = ctx.strokes.flatMap((s) => s.points.map((p) => p.y))
  // Catmull-Rom 会略微越过控制点（这是样条的本性，不是 bug），留 1.5px 余量
  assert.ok(Math.min(...xs) >= 8.5 && Math.max(...xs) <= 41.5, `x 越界：${Math.min(...xs)}~${Math.max(...xs)}`)
  assert.ok(Math.min(...ys) >= 18.5 && Math.max(...ys) <= 31.5, `y 越界：${Math.min(...ys)}~${Math.max(...ys)}`)
})
