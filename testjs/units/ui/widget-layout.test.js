// =========================================================================
// widget-layout.test.js —— 工具箱「图标 + 面板」联合限位
//
// 背景（2026-11-27）：四向预留方案里，窗口恒 520×784、图标恒在中心；
// 旧代码只在拖拽时夹图标 48×48，展开态拖面板不重算方向，方向判定又与 CSS
// 预留区各写各的数字 —— 图标贴边时面板可能被屏幕裁掉。
// 判据钉三件事：
//   1. 面板预留区矩形与 CSS 定位、主进程窗口尺寸同源（改一边数字就红）
//   2. 四角贴边时选得出放得下面板的方向；放不下时把图标挪到最近可行位置
//   3. 组件真的走共享几何模块；方向只在展开时选，拖动只限位不换边；上展开底边贴合图标
// 变异反证：把 right 的面板偏移改成「垂直居中」（旧视觉方案）→ 贴右用例立刻红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { abs } = require('#testjs/paths')

const MOD = abs('student-frontend/src/subwindows/widget/widgetLayout.js')
const MAIN_MOD = abs('electron/main/widgetLayout.cjs')
const VUE = abs('student-frontend/src/subwindows/widget/WidgetApp.vue')
const MAIN = abs('electron/main/main.widget.js')

const workArea = (x = 0, y = 0, w = 1920, h = 1040) => ({ x, y, w, h })
const cssBlock = (src, marker) => src.slice(src.indexOf(marker), src.indexOf('\n}', src.indexOf(marker)) + 2)

test('工具箱四向限位', async (t) => {
  const L = await import(pathToFileURL(MOD).href)
  const { LAYOUT, PANEL_OFFSET, DIRS, panelRect, freeMargin, clampIcon, clampIconWithPanel, pickDir, nearestFeasibleIcon } = L

  await t.test('面板几何与 CSS 定位、主进程窗口尺寸一一对应', () => {
    const vue = fs.readFileSync(VUE, 'utf8')
    const main = fs.readFileSync(MAIN, 'utf8')
    assert.equal(LAYOUT.WIN_W, 520)
    assert.equal(LAYOUT.WIN_H, 784)
    assert.equal(LAYOUT.PANEL_H, 310, '面板实际高度 310，与窗口高 784 无关（窗口大只为图标居中）')
    // @pin electron/main/main.widget.js#WIDGET_CONTENT_W
    assert.match(main, /const WIDGET_CONTENT_W = 520/)
    // @pin electron/main/main.widget.js#WIDGET_CONTENT_H
    assert.match(main, /const WIDGET_CONTENT_H = 784/)

    const fab = cssBlock(vue, '.fab {')
    assert.match(fab, /left: 236px/, '图标 X 偏移必须是 236')
    assert.match(fab, /top: 368px/, '图标 Y 偏移必须是 368')
    const panel = cssBlock(vue, '.menu-panel {')
    assert.match(panel, /left: 292px/, '右展开面板左缘 = 236 + 48 + 8')
    assert.match(panel, /top: 368px/, '右展开面板顶边与图标顶边端部对齐')
    assert.match(panel, /width: 228px/, '面板宽必须与 PANEL_W 一致')
    // 面板实际高度必须 = 几何限位用的 PANEL_H，否则限位算的「面板底贴边」与真实底边差一截
    assert.match(panel, /min-height: 310px/, '面板实际高度必须与 PANEL_H=310 一致（不撑高，保持原视觉）')

    // 其余三向用「图标左上角 + 偏移」换算，钉死 PANEL_OFFSET 不是拍脑袋写的
    assert.match(cssBlock(vue, '.widget-wrapper.panel-left .menu-panel {'), /left: 0/,
      '左展开面板右缘贴图标：236 - 236 = 0')
    assert.match(cssBlock(vue, '.widget-wrapper.panel-down .menu-panel {'), /top: 424px/,
      '下展开面板顶边 = 368 + 48 + 8')
    const upBlock = cssBlock(vue, '.widget-wrapper.panel-up .menu-panel {')
    const upBottom = Number(/bottom:\s*(\d+)px/.exec(upBlock)[1])
    // bottom 相对窗口内容区底部（内容 784 + 阴影 32 = 816）算：
    // 面板底边 = 816 - bottom，必须等于图标底 (368+48=416) - 间隙 8 = 408。
    // 这样上展开时面板底边和图标底边齐平，能一起贴住任务栏。
    assert.equal(816 - upBottom, LAYOUT.ICON_OFF_Y + LAYOUT.ICON - 8,
      '上展开面板底边必须贴图标底边-8（与图标一起贴任务栏）')
    assert.deepEqual(PANEL_OFFSET, { right: [56, 0], down: [56, 56], left: [-236, 0], up: [56, -270] },
      '上展开偏移 = ICON - GAP - PANEL_H = 48-8-310 = -270')
    assert.deepEqual([...DIRS], ['right', 'down', 'left', 'up'])
  })

  await t.test('四角贴边：方向放得下面板，且联合限位不把图标推离边缘', () => {
    const wa = workArea()
    const corners = [
      [0, 0, 'right'],            // 左上：右边和下面都够，优先用户要的「图标 面板」
      [wa.w - 48, 0, 'left'],     // 右上：右侧不够，左侧够
      [0, wa.h - 48, 'up'],       // 左下：上下都不够时上面够
    ]
    for (const [ix, iy, expected] of corners) {
      const dir = pickDir(ix, iy, wa)
      assert.equal(dir, expected, `图标 (${ix},${iy}) 应选 ${expected}`)
      assert.ok(freeMargin(panelRect(dir, ix, iy), wa) >= 0, `${dir} 面板必须在工作区内`)
      // 方向可行时联合限位必须幂等：图标还能贴边，不被面板限位推走
      assert.deepEqual(clampIconWithPanel(ix, iy, wa, dir), [ix, iy])
    }

    // 锚点固定：right/left 的面板不随图标位置上下翻转（用户要稳定，宁可顶到边就停）
    assert.deepEqual(L.PANEL_OFFSET.right, [56, 0])
    assert.deepEqual(L.PANEL_OFFSET.left, [-236, 0])
    assert.equal(L.ANCHORS, undefined, '锚点翻转已移除')
  })

  await t.test('展开态拖动：面板顶到工作区边界就停，方向/锚点都不翻', () => {
    const wa = workArea()
    // 右展开，图标往下拖：联合限位把图标挡在面板底边贴工作区底的位置，不翻转
    const ix = 900
    const dir = 'right'
    const overBottom = wa.h + 200 // 鼠标已拖到工作区外
    const clamped = clampIconWithPanel(ix, overBottom, wa, dir)
    // 面板顶 = iy + 0，底 = iy + PANEL_H；底贴工作区底 → iy = wa.h - PANEL_H
    assert.equal(clamped[1], wa.h - LAYOUT.PANEL_H,
      '图标被挡在距底 PANEL_H 处，面板底边正好贴住工作区底（任务栏）——稳定不翻转')
    const r = panelRect(dir, clamped[0], clamped[1])
    assert.equal(r.y + r.h, wa.y + wa.h, '面板底边贴工作区底')
    assert.equal(r.y, wa.h - LAYOUT.PANEL_H, '面板顶仍在图标顶，方向没翻')

    // 左展开同样稳定：底边贴工作区底就停
    const lclamped = clampIconWithPanel(900, overBottom, wa, 'left')
    assert.equal(lclamped[1], wa.h - LAYOUT.PANEL_H)

    // 幂等：夹过的坐标再夹不变（拖拽每帧多发不会继续漂移）
    assert.deepEqual(clampIconWithPanel(clamped[0], clamped[1], wa, dir), clamped)

    // 小工作区放不下时 nearestFeasibleIcon 仍能选出可行位
    const small = workArea(0, 0, 600, 500)
    const at = nearestFeasibleIcon(500, 460, small)
    const d2 = pickDir(at[0], at[1], small)
    assert.ok(freeMargin(panelRect(d2, at[0], at[1]), small) >= 0)
  })

  await t.test('小工作区 / 图标态：限位只保图标完整，不凭空把图标挪走', () => {
    const small = workArea(0, 0, 600, 600)
    assert.deepEqual(clampIcon(700, 700, small), [552, 552])
    const at = nearestFeasibleIcon(450, 300, small)
    // 面板高 310（非旧 360），left 展开的可行 y 上界抬高，最近可行点只需上移 10px
    assert.deepEqual(at, [450, 290])
    const dir = pickDir(at[0], at[1], small)
    assert.equal(dir, 'left')
    assert.ok(freeMargin(panelRect(dir, at[0], at[1]), small) >= 0)

    // 工作区连「图标 + 面板」都放不下时退化为只夹图标（150 本来就在屏内）
    const tiny = workArea(0, 0, 300, 300)
    assert.deepEqual(nearestFeasibleIcon(150, 150, tiny), [150, 150])
  })

  await t.test('变异反证：面板若改成垂直居中，贴右展开会被裁', () => {
    // 旧视觉方案把面板垂直居中于图标：dy=(48-360)/2=-156。
    // 图标贴右时 right 面板右缘不变，但 dy 一错，下面这条「顶边与图标端部对齐」就不再成立：
    // 面板中心落到图标中心，面板顶缘比图标顶缘高 156px，上方空间不足就会被裁。
    const ix = 1872
    const iy = 0
    const wa = workArea()
    const wrong = { x: ix + 56, y: iy - 156, w: LAYOUT.PANEL_W, h: LAYOUT.PANEL_H }
    assert.ok(wrong.y < 0, '居中偏移在贴顶时把面板顶缘推到工作区外（正确偏移 dy=0 不会）')
    assert.equal(PANEL_OFFSET.right[1], 0, '生产代码必须是端部对齐 dy=0')
  })

  await t.test('主进程初始位置：图标完整贴左缘、垂直居中', async () => {
    const M = require(MAIN_MOD)
    assert.equal(M.WIDGET_ICON_OFF_X, LAYOUT.ICON_OFF_X, '主进程与渲染层图标 X 偏移必须同源')
    assert.equal(M.WIDGET_ICON_OFF_Y, LAYOUT.ICON_OFF_Y, '主进程与渲染层图标 Y 偏移必须同源')
    assert.equal(M.WIDGET_ICON_SIZE, LAYOUT.ICON)

    // 125% 缩放屏：工作区 1536×864 DIP
    const init = M.initialWidgetPosition({ width: 1536, height: 864 })
    assert.deepEqual(init, [-236, 40])
    // 图标左上角屏幕坐标 = 窗口位置 + 窗口内偏移 = (0, 408)，完整贴左缘、垂直居中
    assert.equal(init[0] + M.WIDGET_ICON_OFF_X, 0)
    assert.equal(init[1] + M.WIDGET_ICON_OFF_Y + M.WIDGET_ICON_SIZE / 2, 432)
    assert.ok(init[0] + M.WIDGET_ICON_OFF_X + M.WIDGET_ICON_SIZE > 0,
      '初始图标右缘必须 > 0，不能一大半在屏幕外')

    // 不同缩放 / 分辨率：垂直始终按工作区高度居中，X 恒贴左缘
    for (const [w, h] of [[1280, 720], [1920, 1040], [1024, 600]]) {
      const at = M.initialWidgetPosition({ width: w, height: h })
      assert.equal(at[0], -LAYOUT.ICON_OFF_X)
      assert.equal(at[1] + LAYOUT.ICON_OFF_Y + LAYOUT.ICON / 2, Math.round(h / 2))
    }
  })

  await t.test('主进程接线：没有 moved 拉回、没有二次夹位，位置只有渲染层一个真源', () => {
    const main = fs.readFileSync(MAIN, 'utf8')
    assert.doesNotMatch(main, /widgetWindow\.on\('moved'/,
      '不许监听 moved 做拉回：贴边拖时窗口大半在屏外是正常形态，拉回=图标瞬移到中央')
    assert.doesNotMatch(main, /currentWidgetSize/, '死变量已删')
    assert.match(main, /setPosition\(\.\.\.initialWidgetPosition\(/, '初始位置走共享函数')
    const moveToAt = main.indexOf('IPC.on(CH.WIDGET_MOVE_TO')
    const moveTo = main.slice(moveToAt, main.indexOf('\n  })', moveToAt))
    // @pin electron/main/main.widget.js#WIDGET_MOVE_TO
    assert.match(moveTo, /setContentBounds\(\{/, '拖拽必须 setContentBounds 连宽高一起搬（防「越拖越大」历史坑）')
    // @pin electron/main/main.widget.js#WIDGET_MOVE_TO
    assert.match(moveTo, /const b = widgetWindow\.getContentBounds\(\)/, '宽高必须读当前实际尺寸')
    // @pin electron/main/main.widget.js#WIDGET_MOVE_TO
    assert.match(moveTo, /width: b\.width/, '宽度保持当前值，不写死 552')
    // @pin electron/main/main.widget.js#WIDGET_MOVE_TO
    assert.match(moveTo, /height: b\.height/, '高度保持当前值，不写死 816')
    // @pin electron/main/main.widget.js#WIDGET_CONTENT_W
    assert.doesNotMatch(moveTo, /WIDGET_CONTENT_W \+ M \* 2|WIDGET_CONTENT_H \+ M \* 2/,
      '不许写死图标态尺寸：工具态（200×400 那类小窗）一拖就会被撑成大窗')
    assert.doesNotMatch(moveTo, /getDisplayNearestPoint|clampWidgetPosition/,
      '主进程不许再夹位：与渲染层 workArea 不一致会让 iconScreen 与窗口脱钩、越拖越远')

    // 工具态 resize：按「新尺寸」算工作区中心，每次打开工具都真正居中，不沿用大窗左上角
    const resizeAt = main.indexOf('IPC.on(CH.WIDGET_RESIZE')
    const resize = main.slice(resizeAt, main.indexOf('\n  })', resizeAt))
    // @pin electron/main/main.widget.js#WIDGET_RESIZE
    assert.match(resize, /wa\.x \+ \(wa\.width - newW\) \/ 2/, '工具态 X 按新尺寸居中')
    // @pin electron/main/main.widget.js#WIDGET_RESIZE
    assert.match(resize, /wa\.y \+ \(wa\.height - newH\) \/ 2/, '工具态 Y 按新尺寸居中')
    assert.doesNotMatch(resize, /wa\.width - newW \+ M/, '不许再沿用 before 左上角（会记住上次位置）')
  })

  await t.test('桌面组件置底：z 序遍历靠链表到头终止，计数只作防环熔断', () => {
    const layer = fs.readFileSync(abs('electron/main/main.desktop-layer.js'), 'utf8')
    const guard = /const Z_WALK_GUARD = (\d+)/.exec(layer)
    assert.ok(guard, '必须把防环熔断抽成常量')
    assert.ok(Number(guard[1]) >= 65536,
      '熔断值要足够大：窗口数没有上限，任何小数字都只是把天花板后移；它只防链成环卡死主进程')
    // 两处循环都必须：① 靠 above/h 为 0（链表到头）终止 ② 熔断只是兜底
    assert.match(layer, /i < Z_WALK_GUARD && above && !a\.IsWindowVisible\(above\)/,
      'placeAboveDesktop 靠 above 为 0 或遇到可见窗口终止')
    assert.match(layer, /i < Z_WALK_GUARD && h;/,
      'isJustAboveDesktop 靠 h 为 0 终止')
    assert.doesNotMatch(layer, /Z_WALK_LIMIT|i < 64\b|i < 256\b/, '不许再用业务上限当终止条件')
  })

  await t.test('组件接线：方向判定与限位都走共享几何，没有第二套数字', () => {
    const vue = fs.readFileSync(VUE, 'utf8')
    assert.match(vue, /from '\.\/widgetLayout\.js'/, '必须 import 共享几何模块')
    assert.match(vue, /pickDir\(iconScreen\.value\[0\], iconScreen\.value\[1\], wa\)/,
      '方向判定必须走共享几何模块')
    assert.equal((vue.match(/expandDir\.value = ensurePanelFits\(\)/g) || []).length, 1,
      '只在展开时选方向；拖动过程不许换边')
    assert.ok((vue.match(/if \(state\.value === 'menu'\) clampExpandedPanel\(\)/g) || []).length >= 2,
      '两条拖拽路径（面板 drag-bar / 图标）都只限位、不换方向')
    const clampFn = vue.slice(vue.indexOf('function clampExpandedPanel()'), vue.indexOf('function clampExpandedPanel()') + 520)
    assert.match(clampFn, /expandDir\.value === 'up'/, '上展开单独走只夹图标的分支')
    assert.match(clampFn, /if \(expandDir\.value === 'up'\)[\s\S]*clampIconToWorkArea\(\)/,
      '上展开只夹图标：按预留区联合限位会形成距顶 368px 的空气墙')
    assert.match(clampFn, /clampIconWithPanel\(iconScreen\.value\[0\], iconScreen\.value\[1\], wa, expandDir\.value\)/,
      '其余方向固定方向联合限位，面板顶到边界就停')
    assert.doesNotMatch(clampFn, /pickAnchor|panelAnchor/, '不许随位置翻转锚点：用户要稳定不翻转')
    assert.doesNotMatch(vue, /const needH = /, '不许在组件里再写一套方向尺寸计算')
    assert.doesNotMatch(vue, /anchor-bottom/, '锚点翻转 CSS 已移除')

    // 工具态拖拽：按窗口左上角跟手，不能用过时的 iconScreen 摆窗口
    const dragFn = vue.slice(vue.indexOf('function onDragMouseDown('), vue.indexOf('function onFabMouseDown('))
    assert.match(dragFn, /const isTool = state\.value === 'tool'/, '拖拽要区分工具态')
    assert.match(dragFn, /const startWinX = window\.screenX/, '工具态起点取窗口左上角')
    assert.match(dragFn, /window\.outerWidth/, '工具态按窗口矩形夹进工作区')
    assert.match(dragFn, /if \(isTool\) return/, '工具态松手不按图标偏移摆窗口')
  })
})
