// 校验年份刻度尺的「手柄位置 ↔ 刻度位置 ↔ 滚动位置」三套映射是否自洽。
//
// 为什么单独验：这块最容易出的错不是写崩，而是**差量**——手掌大小没算进去（少减一个 thumbH）、
// 分母用错（total 而不是 maxScroll）、吸附没带终点。这些都不会报错，只在拖动时表现为
// 「拖到底差一截」「拖到某年手柄和刻度线错开」。旧实现里三种都踩过。
//
// 关键约束（N1-01）：公式不再在本文件复刻，而是和组件 import **同一份**
// `AlbumYearRuler.math.js`。组件公式改坏时，这里跑的就是坏掉的那份，测试必然红；
// 同时额外断言组件确实 import 了该模块，防止有人把公式又抄回组件里形成循环论证。
//
// 边界：本脚本验证的是数学关系，不是组件 DOM。真实像素仍需实机目视确认。
// 跑法：node testjs/smoke/album-ruler-mapping-test.cjs（已纳入 npm run smoke）

const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..', '..')
const MATH_SRC = path.join(ROOT, 'student-frontend/src/components/album/AlbumYearRuler.math.js')
const COMPONENT_SRC = path.join(ROOT, 'student-frontend/src/components/album/AlbumYearRuler.vue')

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

;(async () => {
  const {
    clamp, THUMB_H, maxScrollOf, thumbHeightOf, thumbRangeOf, thumbTopOf, markTopOf, seekOf,
  } = await import(pathToFileURL(MATH_SRC).href)

  // ---- 防循环论证：组件必须用同一份公式 ----
  const compSrc = fs.readFileSync(COMPONENT_SRC, 'utf8')
  check('组件 import 共享公式模块', /from '\.\/AlbumYearRuler\.math\.js'/.test(compSrc))
  check('组件不再本地定义 THUMB_H = 44', !/^\s*const THUMB_H = 44\s*$/m.test(compSrc))
  check('共享常量 THUMB_H = 44', THUMB_H === 44, `${THUMB_H}`)

  function makeModel({ trackH, total, clientH }) {
    const maxScroll = maxScrollOf(total, clientH)
    const thumbH = thumbHeightOf(trackH)
    const thumbRange = thumbRangeOf(trackH)
    // manualTop 只在「内容不足一屏」时生效；默认 0 与组件初始值一致
    const thumbTop = (scrollTop, manualTop = 0) =>
      thumbTopOf({ trackH, maxScroll, scrollTop, manualTop })
    const markTop = (offset) => markTopOf({ trackH, maxScroll, total, offset })
    const seek = (top) => seekOf({ top, trackH, maxScroll })
    return { maxScroll, thumbH, thumbRange, thumbTop, markTop, seek }
  }

  // ---- 场景一：内容远超一屏（常规场景）----
  {
    const m = makeModel({ trackH: 600, total: 12000, clientH: 800 })
    console.log('场景一：轨道 600 / 内容 12000 / 视口 800')
    check('手柄高度固定为 44', m.thumbH === 44, `${m.thumbH}`)
    check('行程 = 600 - 44 = 556', m.thumbRange === 556, `${m.thumbRange}`)
    check('滚到顶：手柄顶贴轨道顶', m.thumbTop(0) === 0, `${m.thumbTop(0)}`)
    check('滚到底：手柄底边贴轨道底边', m.thumbTop(m.maxScroll) + m.thumbH === 600, `${m.thumbTop(m.maxScroll) + m.thumbH}`)
    check('顶部的年份刻度落在手柄中心（22）', m.markTop(0) === 22, `${m.markTop(0)}`)

    // 关键一致性：把滚动位置设成某分组的 offset，手柄中心和该分组的刻度线必须重合
    for (const offset of [0, 1500, 5600, 9000, m.maxScroll]) {
      const center = m.thumbTop(offset) + m.thumbH / 2
      const tick = m.markTop(offset)
      check(`offset=${offset} 手柄中心 ${center} 与刻度 ${tick.toFixed(1)} 重合`, Math.abs(center - tick) < 0.001)
    }
  }

  // ---- 场景二：内容不足一屏（maxScroll = 0）----
  {
    const m = makeModel({ trackH: 500, total: 400, clientH: 800 })
    console.log('\n场景二：内容不足一屏（400 < 800）')
    check('手柄仍是 44（大小不随内容变）', m.thumbH === 44, `${m.thumbH}`)
    check('没有可滚动量，maxScroll = 0', m.maxScroll === 0)
    check('刻度按内容比例铺满（不挤在一点）', m.markTop(400) === 500, `${m.markTop(400)}`)

    // 没有可滚动内容时，手柄位置改由「自由位移」驱动：拖动跟手，**松手复位到 0**
    check('拖到 200 → 手柄跟到 200', m.thumbTop(0, 200) === 200, `${m.thumbTop(0, 200)}`)
    check('拖过头 → 夹在行程末端', m.thumbTop(0, 9999) === m.thumbRange, `${m.thumbTop(0, 9999)}`)
    check('拖到负值 → 夹在 0', m.thumbTop(0, -50) === 0, `${m.thumbTop(0, -50)}`)
    check('松手复位 → 回到 0', m.thumbTop(0, 0) === 0)
  }

  // ---- 场景三：轨道很矮（比手柄还短，极端窗口）----
  {
    const m = makeModel({ trackH: 30, total: 12000, clientH: 800 })
    console.log('\n场景三：轨道只有 30px（比手柄矮）')
    check('手柄退让到轨道高度，不溢出', m.thumbH === 30, `${m.thumbH}`)
    check('行程为 0 且不产生负值', m.thumbRange === 0, `${m.thumbRange}`)
    check('手柄位置恒为 0', m.thumbTop(0) === 0 && m.thumbTop(m.maxScroll) === 0)
  }

  // ---- 场景四：松手不吸附（拖到哪儿停哪儿）----
  {
    const m = makeModel({ trackH: 600, total: 12000, clientH: 800 })
    console.log('\n场景四：松手不吸附')
    // 组件的拖动是严格映射：seek = (top / thumbRange) * maxScroll。
    // 松手时 onPointerUp 不再 emit 任何修正值，所以最终滚动位置恒等于拖动落点。
    const restingScroll = (top) => m.seek(top)

    // 旧实现会吸到「最近的分组起点」。分组偏移 [0, 3000, 7000, 11000] 里，
    // 3000~7000 这段正是「未知时间」那种一大片区间：落在中段时会被拽回 3000。
    const mid = restingScroll(300)
    check('落在分组区间中段，松手不吸到分组起点 3000', mid !== 3000 && mid > 3000, `${mid.toFixed(1)}`)
    check('拖到底松手 = maxScroll（不弹回最后一组 11000）', restingScroll(m.thumbRange) === m.maxScroll, `${restingScroll(m.thumbRange)}`)
    check('拖到顶松手 = 0（不跳到别的分组）', restingScroll(0) === 0)

    // 核心保证：松手后手柄像素位置与拖动时**完全一致**（不会再动一下）
    for (const top of [0, 100, 300, 555, m.thumbRange]) {
      const after = m.thumbTop(restingScroll(top))
      check(`top=${top}：松手后手柄停在原处（${after.toFixed(3)}）`, Math.abs(after - top) < 0.001)
    }
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e)
  process.exit(1)
})
