<template>
  <div class="widget-wrapper" :class="['panel-' + expandDir, { 'wrapper-fading': wrapperFading, 'no-pad': noteFullscreen }]">
    <!-- 图标始终显示（工具状态时隐藏）。左键切换菜单，右键呼出「本次退出」等菜单 -->
    <div v-if="state !== 'tool'" class="fab" :class="{ 'fab-hidden': !fabReady }" @mousedown="onFabMouseDown" @contextmenu.prevent="onFabContextMenu">
      <IconGlyph name="toolbox" :size="24" />
    </div>

    <!-- 功能菜单：面板先挂载（隐藏），窗口尺寸到位后再弹出；
         收起时等动画播完才卸载，避免反复创建/销毁造成的闪动 -->
    <div v-if="menuMounted" class="panel menu-panel" :class="{ 'confirm-mode': exitConfirm, 'menu-hidden': !menuVisible }">
        <div class="drag-bar" @mousedown="onDragMouseDown">
          <div class="drag-indicator"></div>
        </div>
        <div class="panel-header">
          <span class="title">工具箱</span>
          <button class="close-btn" type="button" aria-label="关闭工具箱" title="关闭工具箱" @click="closeToIcon"><IconGlyph name="close" :size="14" tint="current" /></button>
        </div>
        <template v-if="!exitConfirm">
          <div class="menu-grid">
            <div
              v-for="tool in tools"
              :key="tool.id"
              class="menu-item"
              @click="openTool(tool.id)"
            >
              <IconGlyph :name="tool.id" :size="24" class="menu-icon" />
              <span class="menu-name">{{ tool.name }}</span>
            </div>
          </div>
          <div class="menu-footer">
            <button class="menu-exit-btn" @click="requestExitToolbox">退出工具箱</button>
          </div>
        </template>

        <!-- 退出确认：面板内两块独立毛玻璃（文案 / 两个按钮），不改窗口尺寸 -->
        <div v-else class="exit-confirm">
          <div class="exit-confirm-text">确认退出工具箱吗？下次启动需要在设置里重新启用。</div>
          <div class="exit-confirm-actions">
            <button class="exit-btn" @click="cancelExitToolbox">取消</button>
            <button class="exit-btn exit-btn-danger" @click="confirmExitToolbox">退出</button>
          </div>
        </div>
      </div>

    <!-- 具体工具 -->
    <div v-if="state === 'tool'" class="panel tool-panel" :class="{ 'tool-hidden': !toolReady, 'no-radius': noteFullscreen }">
      <div v-if="activeTool !== 'note' || !noteFullscreen" class="drag-bar" @mousedown="onDragMouseDown">
        <div class="drag-indicator"></div>
      </div>
      <Timer v-if="activeTool === 'timer'" @close="closeToIcon" />
      <RollCall v-else-if="activeTool === 'rollcall'" @close="closeToIcon" />
      <Screenshot v-else-if="activeTool === 'screenshot'" @close="closeToIcon" />
      <Note v-else-if="activeTool === 'note'" @close="closeToIcon" @ready="onNoteReady" @shrink="onNoteShrink" />
      <div v-else class="placeholder-tool">
        <div class="placeholder-icon"><IconGlyph name="developing" :size="32" /></div>
        <div class="placeholder-text">功能开发中</div>
        <button class="btn-back" @click="closeToIcon">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup vapor>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import Timer from './Timer.vue'
import RollCall from './RollCall.vue'
import Screenshot from './Screenshot.vue'
import Note from './Note.vue'
import IconGlyph from '../../components/base/IconGlyph.vue'
import { SEND, INVOKE, RECEIVE } from '../../electronChannels.js'
import { useDisposables } from '../../utils/disposables.js'
import {
  LAYOUT, freeMargin, panelRect, pickDir, clampIcon, clampIconWithPanel, nearestFeasibleIcon,
} from './widgetLayout.js'

// 浮窗里的定时器/拖拽监听全部走统一登记表：窗口销毁即释放，动态排期自动撤上一次
const d = useDisposables()

const state = ref('icon') // 'icon' | 'menu' | 'tool'
const activeTool = ref('')
const toolReady = ref(false)
const noteFullscreen = ref(false)
// 图标是否可见：工具收起时先隐藏图标，等窗口收缩/归位到位后再淡入，避免图标出现在旧位置再跳位
const fabReady = ref(true)
// 整体容器是否整体淡出：点工具时先整体淡出，再切面板/改窗口尺寸，最后整体淡入，避免闪一下
const wrapperFading = ref(false)
// 面板展开方向：四向预留下图标恒在窗口中心，面板按方向显示在各预留区。
// 'right' | 'left' | 'up' | 'down'
const expandDir = ref('right')

// 四向预留方案：窗口恒定 520×784（内容区），图标固定在正中心，
// 面板按方向显示在图标左/右/上/下的预留区，开合菜单永不 resize、永不挪窗口。
// 图标屏幕坐标是唯一真源——方向判定、边界夹紧、窗口摆位（仅拖拽/初始化）基于它。
const { SHADOW } = LAYOUT
const { ICON_OFF_X, ICON_OFF_Y } = LAYOUT

// 图标左上角在屏幕上的坐标（DIP）。onMounted 首次采样，之后拖拽时维护。
const iconScreen = ref([SHADOW, SHADOW])

// 图标左上角在窗口内容区内的偏移：恒为中心，不随方向变（图标永远在同一位置）。
function iconOffsetInWindow() {
  return [ICON_OFF_X, ICON_OFF_Y]
}

// 工作区（DIP）。方向判定 / 限位与面板 CSS 共用 widgetLayout.js 的同一套几何。
function workArea() {
  return {
    x: window.screen.availLeft || 0,
    y: window.screen.availTop || 0,
    w: window.screen.availWidth,
    h: window.screen.availHeight,
  }
}

// 把窗口左上角移到「图标屏幕坐标落在正确窗口内偏移」的位置。
function placeWindowAtIcon() {
  const [ox, oy] = iconOffsetInWindow()
  window.electron.send(SEND.WIDGET_MOVE_TO, [
    Math.round(iconScreen.value[0] - ox),
    Math.round(iconScreen.value[1] - oy),
  ])
}

// 方向判定与限位共用 widgetLayout.js 的同一套几何（面板预留区 ↔ CSS 定位），
// 避免一处改了数字、另一处还在按旧尺寸判断导致面板被屏幕裁掉。

// 只夹图标：图标态拖拽允许贴边（面板还没展开，不用为它让位）。
function clampIconToWorkArea() {
  iconScreen.value = clampIcon(iconScreen.value[0], iconScreen.value[1], workArea())
}

// 展开前：图标 + 面板一起限位，方向锁死在展开那一刻。
// 先挑当前位置放得下的方向；四向都放不下时把图标挪到最近的可行位置，
// 宁可在展开前挪一次窗口，也不让面板展开后被屏幕裁掉。
function ensurePanelFits() {
  const wa = workArea()
  const [ix, iy] = iconScreen.value
  const dir = pickDir(ix, iy, wa)
  if (freeMargin(panelRect(dir, ix, iy), wa) >= 0) return dir
  iconScreen.value = nearestFeasibleIcon(ix, iy, wa)
  placeWindowAtIcon()
  return pickDir(iconScreen.value[0], iconScreen.value[1], wa)
}

// 展开态拖动：方向锁死在展开时选定的那一边，只做限位、不换方向、不翻转。
// - 上展开：面板占图标上方 368px，联合限位会把图标挡在距顶 368px 形成空气墙 →
//   只夹图标本身，允许面板顶部出屏（这是 up 方向的固有取舍）。
// - 其余方向：图标 + 面板联合限位，面板顶到工作区边界就停（稳定不翻转）。
function clampExpandedPanel() {
  if (expandDir.value === 'up') {
    clampIconToWorkArea()
    return
  }
  const wa = workArea()
  iconScreen.value = clampIconWithPanel(iconScreen.value[0], iconScreen.value[1], wa, expandDir.value)
}

// 菜单面板：先挂载（隐藏）再等窗口尺寸到位显示；收起时等动画播完才卸载，避免重建闪动。
// menuToken 用于作废「尚未执行/尚未回执」的展开流程，快速连点不会叠加两次窗口位移。
const menuMounted = ref(false)
const menuVisible = ref(false)
let menuToken = 0
let menuClosing = false

// 打开菜单：先挂载隐藏面板并挪窗口，尺寸到位后再播放弹出动画。
// 整个过程用 token 串行化；动画没结束时再次点击会被忽略（见 onFabMouseUp）。
function openMenu() {
  if (state.value !== 'icon' || menuClosing) return
  const token = ++menuToken
  fabReady.value = true
  // 四向预留：窗口恒定、图标恒在中心，开合菜单不 resize；
  // 按图标屏幕位置选放得下面板的方向，只有四向都放不下才在展开前挪一次窗口。
  clampIconToWorkArea()
  expandDir.value = ensurePanelFits()
  menuMounted.value = true
  menuVisible.value = false
  state.value = 'menu'
  // 展开时取消穿透（面板要能点）；等一帧布局完成再显示面板播动画。
  setIgnoreMouse(false)
  nextTick(() => requestAnimationFrame(() => {
    if (token === menuToken) menuVisible.value = true
  }))
}

// 收起菜单：先播收起动画，再按锚点缩回图标尺寸，最后卸载面板。
function closeMenu() {
  if (state.value !== 'menu' || menuClosing) return
  menuClosing = true
  cancelPendingToolOpen()
  const token = ++menuToken
  menuVisible.value = false
  // 固定尺寸：不缩窗口、不挪位置，只播完收起动画后卸载面板。
  // 方向不复位——图标 CSS 停在当前边，下次 openMenu 会用 iconScreen 重算。
  scheduleIconShrink(() => {
    if (token !== menuToken) { menuClosing = false; return }
    menuMounted.value = false
    state.value = 'icon'
    // 不在这里强制切穿透：鼠标此刻仍停在图标上，若整窗穿透则下一次点击会穿过去。
    // 透明区的穿透交给 onHoverMove —— 鼠标真正移出图标区域时才切。
    menuClosing = false
  }, 110)
}

// 鼠标穿透：图标态整窗穿透，只有鼠标落在图标/面板上时才切回可点。
// forward 让穿透态仍收到 mousemove；用 lastIgnore 去重，避免每次移动都发 IPC。
let lastIgnore = null
function setIgnoreMouse(ignore) {
  if (lastIgnore === ignore) return
  lastIgnore = ignore
  window.electron.send(SEND.WIDGET_SET_IGNORE_MOUSE, ignore)
}

// 拖拽期间冻结穿透切换：拖拽靠 mousemove 跟手、窗口摆位经 IPC 往返有几帧延迟，
// 若 onHoverMove 此刻按鼠标位置判定，会误判「落在透明区」→ 切穿透 →
// 穿透态不转发 mousedown/mouseup → mouseup 丢失、下一次 mousedown 穿过去 → 拖不动/点不动。
let draggingWidget = false

// 分区恒定穿透：所有「有内容的可见元素」（图标 + 菜单面板 + 工具面板）矩形内不穿透，
// 其余透明区恒定穿透。用屏幕坐标判定：e.screenX/Y 与 window.screenX/Y 同为 DIP、同坐标系；
// 穿透态 forward 出的 mousemove 其 clientX/Y 会被 DPI 放大、与 getBoundingClientRect 对不上，
// 所以一律换算到屏幕坐标再比。元素矩形 = 窗口屏幕位置 + 窗口内偏移。
// 隐藏态（opacity:0 / pointer-events:none）的元素不算「有东西」，不参与判定。
function isOverVisibleContent(sx, sy) {
  const wx = window.screenX
  const wy = window.screenY
  const els = document.querySelectorAll('.fab, .panel')
  for (const el of els) {
    if (el.classList.contains('fab-hidden') ||
        el.classList.contains('menu-hidden') ||
        el.classList.contains('tool-hidden')) continue
    const r = el.getBoundingClientRect()
    // 加 6px 容差：图标有 box-shadow / 圆形抗锯齿，视觉可点区略大于 DOM 矩形；
    // 实测像素质心可能比 DOM 底边低 1~2px，不留容差会把「点在图标上」误判成透明区。
    const pad = 6
    if (sx >= wx + r.left - pad && sx <= wx + r.right + pad &&
        sy >= wy + r.top - pad && sy <= wy + r.bottom + pad) return true
  }
  return false
}

function onHoverMove(e) {
  if (draggingWidget) return // 拖拽中保持不穿透，交给拖拽结束后的 hover 重新判定
  // 鼠标落在内容矩形内→不穿透（可点），透明区→穿透（不挡桌面）
  setIgnoreMouse(!isOverVisibleContent(e.screenX, e.screenY))
}

// 等主进程确认窗口尺寸已生效后再执行 cb（多用于「先改窗口尺寸、再显示内容」），
// 避免用固定延时带来的空窗；兜底 250ms 防止回执丢失时内容一直不显示。
function afterWidgetResized(cb, fallbackMs = 250) {
  let finished = false
  let handler = null
  const cancelFallback = d.timeout(() => finish(), fallbackMs)
  function finish() {
    if (finished) return
    finished = true
    if (handler) window.electron.off(RECEIVE.FROM_MAIN, handler)
    cancelFallback()
    // 等一帧，确保渲染层已按新尺寸完成布局后再显示
    requestAnimationFrame(cb)
  }
  handler = window.electron.on(RECEIVE.FROM_MAIN, (data) => {
    if (data && data.type === 'widget-resized') finish()
  })
}

// 四个工具：id 同时作为 IconGlyph 的图标 key（见 IconGlyph.vue 的 MAP）
const tools = [
  { id: 'timer', name: '计时器' },
  { id: 'rollcall', name: '点名器' },
  { id: 'screenshot', name: '截图' },
  { id: 'note', name: '注释' },
]

// 菜单面板「退出工具箱」的二次确认是否显示
const exitConfirm = ref(false)

// 「可替换」的定时器调度器：连点时自动撤掉上一次排期，不用手写 clearTimeout 配对
const scheduleToolClose = d.defer()
const scheduleToolOpen = d.defer()

// 取消尚未执行的「点工具切换」，并恢复整体透明度（用于用户在淡出过程中又操作了其它入口）
function cancelPendingToolOpen() {
  scheduleToolOpen.cancel()
  wrapperFading.value = false
}

// ===== 退出工具箱（菜单面板底部按钮，与右键「关闭工具箱」同一动作）=====
// 二次确认直接占用菜单面板的空间（不另开弹窗、也不改窗口大小）。
function requestExitToolbox() {
  exitConfirm.value = true
}

function cancelExitToolbox() {
  exitConfirm.value = false
}

function confirmExitToolbox() {
  // 窗口马上销毁，无需复位状态：主进程销毁浮窗并通知主窗口把持久化开关置 false
  // （设置页「是否启用工具箱」同步变关闭，下次启动不再出现）
  window.electron.send(SEND.WIDGET_EXIT)
}

function openTool(id) {
  scheduleToolClose.cancel()
  // 先让整个容器淡出（不改动任何面板的挂载与布局），淡出后再切面板、改窗口尺寸，最后整体淡入。
  // 这样「菜单瞬间消失 + 窗口立刻改尺寸」不会露出来，避免闪一下。
  wrapperFading.value = true
  scheduleToolOpen(() => {
    activeTool.value = id
    toolReady.value = true // 内容就位（此时整体仍处于淡出态，看不到旧尺寸渲染）
    noteFullscreen.value = false
    state.value = 'tool'
    // 等窗口改到工具尺寸并完成布局后，再整体淡入
    afterWidgetResized(() => {
      wrapperFading.value = false
    })
  }, 50)
}

function onNoteReady() {
  noteFullscreen.value = true
  window.electron.send(SEND.WIDGET_FULLSCREEN)
}

function onNoteShrink() {
  noteFullscreen.value = false
  window.electron.send(SEND.WIDGET_RESTORE)
  window.electron.send(SEND.WIDGET_RESIZE, [240, 220])
}

function closeToIcon() {
  if (state.value === 'menu') {
    closeMenu()
    return
  }
  cancelPendingToolOpen()
  if (state.value === 'tool') {
    // 图标先隐藏，等窗口收缩/归位到位后再淡入，避免图标出现在旧位置又跳位造成的闪。
    fabReady.value = false
    if (noteFullscreen.value) {
      // 全屏注释：直接切换，避免面板淡出时让桌面透过透明窗口闪现
      state.value = 'icon'
      activeTool.value = ''
      return
    }
    // 普通工具：面板先淡出（复用 tool-hidden 的透明度过渡），淡出结束再切回图标。
    // 注意：此处不清空 activeTool，否则退场中的工具面板会立刻变回「功能开发中」占位。
    toolReady.value = false
    scheduleToolClose(() => {
      state.value = 'icon'
      activeTool.value = ''
    }, 130)
    return
  }
  state.value = 'icon'
  activeTool.value = ''
}

function onDragMouseDown(e) {
  e.preventDefault()
  draggingWidget = true
  setIgnoreMouse(false) // 拖拽期间必须可点，否则 mousedown/mouseup 会被穿透
  const startScreenX = e.screenX
  const startScreenY = e.screenY
  const startIcon = iconScreen.value.slice()
  // 工具态：图标已隐藏，iconScreen 还是上次图标态的旧坐标，不能用它摆窗口。
  // 改为窗口左上角直接跟手；工具态窗口尺寸小（200×400 那类），按窗口矩形夹进工作区。
  const isTool = state.value === 'tool'
  const startWinX = window.screenX
  const startWinY = window.screenY

  const onMouseMove = (e) => {
    const dx = e.screenX - startScreenX
    const dy = e.screenY - startScreenY
    if (isTool) {
      const wa = workArea()
      const ww = window.outerWidth
      const wh = window.outerHeight
      const nx = Math.max(wa.x, Math.min(startWinX + dx, wa.x + wa.w - ww))
      const ny = Math.max(wa.y, Math.min(startWinY + dy, wa.y + wa.h - wh))
      window.electron.send(SEND.WIDGET_MOVE_TO, [Math.round(nx), Math.round(ny)])
      return
    }
    // 图标/菜单态：图标跟手，实时夹紧到工作区（保证整个圆形图标始终完整留在屏幕内），
    // 再由前端按图标屏幕坐标摆窗口。主进程 move 只改位置、保持窗口当前尺寸。
    iconScreen.value = [startIcon[0] + dx, startIcon[1] + dy]
    clampIconToWorkArea()
    // 方向已在展开时定好，拖动只做联合限位，不让面板跳到另一侧
    if (state.value === 'menu') clampExpandedPanel()
    placeWindowAtIcon()
  }

  const onMouseUp = () => {
    cancelMove()
    cancelUp()
    draggingWidget = false
    if (isTool) return // 工具态不碰 iconScreen，也不按图标偏移摆窗口
    clampIconToWorkArea()
    if (state.value === 'menu') clampExpandedPanel()
    placeWindowAtIcon()
  }

  // 松手即摘：拖拽期间的 document 监听不能等到窗口卸载才收尾
  const cancelMove = d.listen(document, 'mousemove', onMouseMove)
  const cancelUp = d.listen(document, 'mouseup', onMouseUp)
}

function onFabMouseDown(e) {
  e.preventDefault()
  // 仅左键触发拖拽/菜单切换；右键只走 contextmenu 的「本次退出」原生菜单，不进工具箱菜单
  if (e.button !== 0) return
  const startScreenX = e.screenX
  const startScreenY = e.screenY
  const startClientX = e.clientX
  const startClientY = e.clientY
  const startIcon = iconScreen.value.slice()
  // 拖拽只在真正移动超过阈值后才启动。此前 mousedown 就发 DRAG_START、
  // mousemove 每次都发 DRAG_MOVE，导致「点一下」也会按 dragStartWindowPos 搬窗口：
  // 快速连点时手抖几像素就与 openMenu/closeMenu 的 resize 抢窗口位置 → 图标闪一下/平移。
  let dragging = false

  const onMouseMove = (e) => {
    if (!dragging) {
      if (Math.abs(e.clientX - startClientX) <= 3 && Math.abs(e.clientY - startClientY) <= 3) return
      dragging = true
      draggingWidget = true
      setIgnoreMouse(false) // 一旦进入拖拽，保持可点，避免 mouseup 被穿透丢失
    }
    iconScreen.value = [startIcon[0] + e.screenX - startScreenX, startIcon[1] + e.screenY - startScreenY]
    clampIconToWorkArea()
    if (state.value === 'menu') clampExpandedPanel()
    placeWindowAtIcon()
  }

  const onMouseUp = () => {
    cancelMove()
    cancelUp()
    draggingWidget = false // 复位：否则拖过一次后穿透判定被永久冻结
    if (dragging) {
      clampIconToWorkArea()
      if (state.value === 'menu') clampExpandedPanel()
      placeWindowAtIcon()
      return // 拖动过就不算点击，不切换菜单
    }
    // 纯点击（含微抖）：完全不碰拖拽通道，只切换菜单
    if (state.value === 'menu') {
      // 展开动画还没结束时忽略点击，避免「展开/收起」两次窗口位移叠加
      if (menuVisible.value) closeMenu()
    } else {
      openMenu()
    }
  }

  const cancelMove = d.listen(document, 'mousemove', onMouseMove)
  const cancelUp = d.listen(document, 'mouseup', onMouseUp)
}

// 右键浮窗图标：呼出原生右键菜单（当前含「本次退出」）
function onFabContextMenu() {
  window.electron.send(SEND.WIDGET_CONTEXT_MENU)
}

// 点击菜单外部区域自动收起菜单
function onDocMouseDown(e) {
  if (state.value !== 'menu' || !menuVisible.value) return
  const menuPanel = document.querySelector('.menu-panel')
  const fab = document.querySelector('.fab')
  if (!menuPanel || !fab) return
  if (menuPanel.contains(e.target) || fab.contains(e.target)) return
  closeMenu()
}

let blurHandler = null

async function checkToolboxEnabled() {
  try {
    const res = await axios.get('/api/widget-settings')
    if (!res.data.success) return
    // 持久「是否启用工具箱」即本次会话的开关（设置页已去掉独立的「本次启用」）。
    // 每次 settings-changed 都按持久值同步一次，这样在设置里开关能立刻生效；
    // 首次（会话值还是 null）注入持久值。
    const persistent = res.data.data.toolboxEnabled
    const session = await window.electron.invoke(INVOKE.GET_SESSION_WIDGET_VISIBLE)
    if (session !== persistent) {
      window.electron.send(SEND.WIDGET_SET_SESSION_VISIBLE, persistent)
    }
    window.electron.send(SEND.WIDGET_SET_VISIBLE, persistent)
  } catch (_) { // best-effort: 读取失败则保持默认可见
  }
}

onMounted(() => {
  // 首次采样图标屏幕坐标：窗口左上角 + 图标在窗口内偏移（初始方向为右/下展开）。
  // 之后拖拽/方向翻转都由代码维护，不再依赖 window.screenX。
  iconScreen.value = [window.screenX + ICON_OFF_X, window.screenY + ICON_OFF_Y]
  // 初始不穿透：保证鼠标已在图标上、未移动时也能点中。之后 hover 检测接管。
  setIgnoreMouse(false)
  d.listen(document, 'mousemove', onHoverMove)
  d.listen(document, 'mousedown', onDocMouseDown)
  checkToolboxEnabled()
  blurHandler = window.electron.on(RECEIVE.FROM_MAIN, (data) => {
    if (data && data.type === 'blur' && state.value === 'menu') {
      // 失焦也要走完整的 closeMenu：直接改 state 会跳过窗口收缩和面板卸载，
      // 留下「state=icon 但窗口还是展开尺寸」的错位。此时 screenX 还是展开态值，
      // 下次点击的方向判定会据此把贴右误判成 left=false，图标跑到窗口左边。
      closeMenu()
    }
    if (data && data.type === 'settings-changed') {
      checkToolboxEnabled()
    }
  })
})

onUnmounted(() => {
  // mousedown 监听与三个排期定时器由 disposables 释放
  if (blurHandler) {
    window.electron.off(RECEIVE.FROM_MAIN, blurHandler)
  }
})

// 状态变化时自动调整窗口大小和位置
const scheduleIconShrink = d.defer()

watch(
  [state, activeTool],
  ([newState, newTool], [oldState, oldTool]) => {
    // 状态再次变化则取消尚未执行的窗口收缩，避免与新的展开动画抢时序
    scheduleIconShrink.cancel()

    // 回到图标态时复位「退出确认」，否则下次展开菜单会直接停在确认视图
    if (newState === 'icon') exitConfirm.value = false

    // 菜单的展开/收起由 openMenu / closeMenu 自己完成（带 token 串行化），这里不再重复改窗口
    if ((newState === 'menu' && oldState === 'icon') || (newState === 'icon' && oldState === 'menu')) return

    // 工具态面板要接收点击 → 关穿透；回图标态 → 开穿透。
    // 菜单↔icon 的穿透由 openMenu/closeMenu 各自处理，这里只管 tool。
    if (newState === 'tool') setIgnoreMouse(false)
    else if (newState === 'icon' && oldState === 'tool') setIgnoreMouse(true)

    let size
    if (newState === 'icon') {
      size = [48, 48]
      if (oldState === 'tool') {
        // 如果之前是全屏注释工具，先恢复窗口大小
        if (oldTool === 'note') {
          window.electron.send(SEND.WIDGET_RESTORE)
        }
        window.electron.send(SEND.WIDGET_RESTORE_POSITION)
      }
    } else if (newState === 'tool') {
      // 工具面板走居中显示，方向复位；菜单面板同时卸载
      menuToken++
      menuMounted.value = false
      menuVisible.value = false
      menuClosing = false
      expandDir.value = 'right'
      if (newTool === 'note') {
        // 注释工具：先居中显示小窗口加载，等 Note 准备好再全屏
        size = [250, 240]
        window.electron.send(SEND.WIDGET_CENTER)
        window.electron.send(SEND.WIDGET_RESIZE, size)
        return
      }
      const toolSizes = {
        timer: [200, 240],
        rollcall: [220, 240],
        screenshot: [250, 260],
      }
      size = toolSizes[newTool] || [200, 300]
      window.electron.send(SEND.WIDGET_CENTER)
    }

    // 菜单展开已在上面单独处理（先改窗口、后插面板）
    window.electron.send(SEND.WIDGET_RESIZE, size)
    // 收起工具：等窗口收缩并归位到位后再让图标淡入，并重新采样图标屏幕坐标
    // （工具态走居中/恢复位置，窗口位置变了，iconScreen 必须跟上）。
    if (newState === 'icon' && oldState === 'tool') {
      afterWidgetResized(() => {
        expandDir.value = 'right'
        iconScreen.value = [window.screenX + ICON_OFF_X, window.screenY + ICON_OFF_Y]
        fabReady.value = true
      })
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.widget-wrapper {
  position: relative;
  display: flex;
  align-items: flex-start;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  /* 与主进程 WIDGET_SHADOW_MARGIN 保持一致：四周留出阴影绘制空间，
     窗口位置已相应向左上偏移同值，所以图标/面板的屏幕位置不受影响 */
  padding: 16px;
  background: transparent;
  overflow: hidden;
  min-width: 0;
  transition: opacity 0.05s ease; /* 整体淡出/淡入：遮住切面板+改窗口尺寸的过程 */
}

/* 全屏注释：去掉阴影留边，让内容真正铺满整屏 */
.widget-wrapper.no-pad {
  padding: 0;
}

/* 点工具时整体淡出，切完面板、窗口尺寸到位后再整体淡入 */
.widget-wrapper.wrapper-fading {
  opacity: 0;
}

.fab {
  position: absolute;
  /* 图标恒在窗口内容区正中（520×784 → 中心 260,392；48 图标左上角 236,368）。
     四向预留下图标位置永不随展开方向变化。 */
  left: 236px;
  top: 368px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  /* 浮窗图标固定用淡黄色，不再跟随主题主色 */
  background: #ffe08a;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  /* 去掉 hover 的 transform scale：展开/收起那一瞬窗口尺寸剧变，图标边缘反复掠过
     鼠标指针，hover 在 1↔1.05 间抖动 → 图标一闪一闪。只保留 opacity 过渡。 */
  transition: opacity 0.1s ease;
  user-select: none;
  flex-shrink: 0;
}

.fab.fab-hidden {
  opacity: 0;
  pointer-events: none;
}

.panel {
  /* 工具箱是独立的透明窗口，没有主窗口的页面底做衬底。
     玻璃主题的 --color-surface 本身带透明度，直接铺在这里会透出桌面/后面的窗口，
     看起来就是“背景没了”。这里把页面底色 --color-bg 垫在玻璃面下面：
     既保留玻璃质感，又保证面板始终是不透明的实体。 */
  background-color: var(--color-bg, #ffffff);
  background-image: linear-gradient(var(--color-surface, #ffffff), var(--color-surface, #ffffff));
  border-radius: var(--radius-surface);
  padding: 16px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18);
  border: 1px solid var(--color-border, #e5e7eb);
}

.menu-panel {
  position: absolute;
  /* 默认往右：面板左缘贴图标右缘+间隙 (236+48+8=292)，
     顶边与图标顶边对齐 (368) —— 图标在面板左上角旁，不是垂直居中。 */
  left: 292px;
  top: 368px;
  width: 228px;
  /* 面板保持内容自然高度，约 310；几何限位用的 PANEL_H 也是 310（同源），
     所以「面板底贴工作区底」的判断与真实底边一致，不需要把面板撑高。 */
  min-height: 310px;
  box-sizing: border-box;
  overflow: hidden;
  transform-origin: left top; /* 从靠图标的角浮现 */
  transition:
    transform 0.1s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.1s ease;
}

/* 面板常驻 DOM，只切状态：不会出现卸载重建的闪动 */
.menu-panel.menu-hidden {
  opacity: 0;
  transform: scale(0.86);
  pointer-events: none;
}

/* 面板始终贴着图标的左/右侧，垂直方向贴顶或贴底（图标落在该侧端部，不居中）。 */
/* 往左展开（图标靠右缘）：面板在图标左侧，顶边对齐图标顶边。 */
.widget-wrapper.panel-left .menu-panel {
  left: 0;
  top: 368px;
  transform-origin: right top;
}
/* 往下展开：面板在图标右下方，顶边接图标底边+间隙 (416+8=424)。 */
.widget-wrapper.panel-down .menu-panel {
  left: 292px;
  top: 424px;
  transform-origin: left top;
}
/* 往上展开：面板在图标右上方，底边贴「图标底边-间隙 8」，和图标一起贴任务栏。
   bottom 相对窗口内容区底部算，窗口内容区 = 内容 784 + 阴影留边 32 = 816；
   图标底 = 368+48 = 416，面板底要在 416-8 = 408 → bottom = 816-408=408。
   旧值 456 让面板底贴图标顶（360），比图标底高 56px → 面板悬在图标上方、离任务栏差一截。
   面板高度由内容撑开（约 310），用 bottom 定位才能让底边恒定贴图标底。 */
.widget-wrapper.panel-up .menu-panel {
  left: 292px;
  top: auto;
  bottom: 408px;
  transform-origin: left bottom;
}

/* 说明：菜单的展开/收起动画现在由 .menu-panel 的 transition 直接完成（见上），
   不再走 Vue Transition 的挂载/卸载，避免重建闪动。 */

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text, #111827);
}

.close-btn {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background: var(--color-bg, #f9fafb);
  color: var(--color-text-secondary, #6b7280);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.close-btn:hover {
  background: var(--color-border, #e5e7eb);
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

/* 菜单底部「退出工具箱」：整行居中按钮。
   颜色全部走主题变量（--color-danger 在 glass/glass2 的夜间会被换成更亮的红），
   背景/描边用 color-mix 半透明叠加，毛玻璃面板上能透出磨砂，日夜模式都不会突兀。 */
.menu-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border, #e5e7eb);
}

.menu-exit-btn {
  display: block;
  width: 100%;
  padding: 8px 0;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.4;
  text-align: center;
  color: var(--color-danger, #ef4444);
  background: color-mix(in srgb, var(--color-danger, #ef4444) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 22%, transparent);
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.menu-exit-btn:hover {
  color: var(--color-danger-hover, var(--color-danger, #ef4444));
  background: color-mix(in srgb, var(--color-danger, #ef4444) 16%, transparent);
  border-color: color-mix(in srgb, var(--color-danger, #ef4444) 34%, transparent);
}

/* 确认态：整块面板也降成玻璃底。否则面板 92% 白会把背景图挡死，
   里面再叠多透的玻璃都只能"看到白色"，出不来玻璃质感。 */
.menu-panel.confirm-mode {
  background: color-mix(in srgb, var(--color-surface, #ffffff) 45%, transparent);
  backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  -webkit-backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  transition: background 0.15s ease;
  /* 确认态内容更矮，min-height 与 .menu-panel 一致（= 几何限位 PANEL_H），
     flex 让确认内容垂直居中，面板高度与菜单视图一致。 */
  display: flex;
  flex-direction: column;
  min-height: 310px;
}

.menu-panel.confirm-mode .exit-confirm {
  flex: 1;
  justify-content: center;
}

/* 退出确认：文案块与两个按钮各是一块独立毛玻璃，比面板玻璃更实一点形成层次。
   模糊与内高光沿用主题同一组变量，日夜自动跟随。 */
.exit-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 标题块：图标 + 「工具箱」上下居中，独立一块毛玻璃 */

.exit-confirm-text {
  padding: 13px 15px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--color-text, #111827);
  background: color-mix(in srgb, var(--color-surface, #ffffff) 72%, transparent);
  backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  -webkit-backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-control);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.exit-confirm-actions {
  display: flex;
  gap: 10px;
}

.exit-btn {
  flex: 1;
  padding: 10px 0;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  text-align: center;
  cursor: pointer;
  color: var(--color-text-secondary, #6b7280);
  background: color-mix(in srgb, var(--color-surface, #ffffff) 62%, transparent);
  backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  -webkit-backdrop-filter: var(--sidebar-glass-blur, blur(24px) saturate(1.4));
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-control);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.exit-btn:hover {
  background: color-mix(in srgb, var(--color-surface, #ffffff) 80%, transparent);
}

.exit-btn-danger {
  color: var(--color-danger, #ef4444);
  border-color: color-mix(in srgb, var(--color-danger, #ef4444) 30%, transparent);
}

.exit-btn-danger:hover {
  color: var(--color-danger-hover, var(--color-danger, #ef4444));
  background: color-mix(in srgb, var(--color-danger, #ef4444) 16%, transparent);
  border-color: color-mix(in srgb, var(--color-danger, #ef4444) 40%, transparent);
}

.menu-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px 8px;
  border-radius: var(--radius-card);
  border: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg, #f9fafb);
  cursor: pointer;
  transition: all 0.2s ease;
}

.menu-item:hover {
  background: var(--color-primary, #22c55e);
  color: white;
  border-color: var(--color-primary, #22c55e);
}

.menu-icon {
  font-size: 24px;
}

.menu-name {
  font-size: 13px;
  font-weight: 500;
}

.drag-bar {
  width: 100%;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  margin-bottom: 4px;
}

.drag-bar:active {
  cursor: grabbing;
}

.drag-indicator {
  width: 36px;
  height: 4px;
  border-radius: var(--radius-xs);
  background: var(--color-text-muted, #d1d5db);
}

.tool-panel {
  width: 100%;
  height: 100%;
  position: relative;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
  min-width: 0;
  /* 竖排弹性布局：顶部拖动条占固定高度，工具内容自动收缩占满剩余空间。
     否则工具根元素 height:100% 会连拖动条一起算进去，向下溢出约 20px，
     被面板 overflow 裁掉后底部毛玻璃内边距变成 0（上下内边距不一致）。 */
  display: flex;
  flex-direction: column;
  transition: opacity 0.12s ease;
}

.tool-hidden {
  opacity: 0;
}

.no-radius {
  border-radius: 0;
  padding: 0;
}

.placeholder-tool {
  text-align: center;
  padding: 24px 0;
}

.placeholder-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.placeholder-text {
  font-size: 14px;
  color: var(--color-text-secondary, #6b7280);
  margin-bottom: 16px;
}

.btn-back {
  padding: 6px 16px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg, #f9fafb);
  color: var(--color-text, #111827);
  cursor: pointer;
  font-size: 13px;
}

.btn-back:hover {
  background: var(--color-border, #e5e7eb);
}
</style>

<!-- 主题玻璃观感：底色/文字/边框等已由主题变量（--color-surface / --color-text / --color-border）
     自动跟随（含夜间），这里只补三件事：
     1) 毛玻璃特有的一层——背景模糊与亮边。模糊只加在菜单面板上：工具面板内可能有
        position:fixed 的全屏层（如注释工具），backdrop-filter 会为其建立包含块，
        导致那些固定层不再铺满窗口。
     2) 与主窗口一致的图片背景（自选图，或 glass 的内置日/夜底图），铺在工具面板上。
     3) 菜单项与其选中/悬停态：改成透亮的毛玻璃，而不是不透明色块 / 纯主色填充。
     4) 二级页面（四个小工具内部）的色块：同样换成透亮玻璃块，别把面板背景图盖死。 -->
<style>
/* ---- 1. 亮边与背景模糊 ---- */
/* 毛玻璃主题（glass）：与主界面卡片同一套配方 */
:root:is([data-theme="glass"]) .panel {
  border-color: rgba(255, 255, 255, 0.35);
}
:root:is([data-theme="glass"]) .menu-panel {
  backdrop-filter: blur(20px) saturate(1.1);
}
/* 夜间不出现亮边（与 theme-*-night.css 的约定一致），改回主题边框色 */
:root[data-mode="night"]:is([data-theme="glass"]) .panel {
  border-color: var(--color-border, rgba(255, 255, 255, 0.08));
}
/* 新毛玻璃主题（glass2）：亮边与模糊强度都走它自己的玻璃配方变量，夜间自动变暗 */
:root[data-theme="glass2"] .panel {
  border-color: var(--g2-line, rgba(255, 255, 255, 0.7));
}
:root[data-theme="glass2"] .menu-panel {
  backdrop-filter: blur(var(--g2-blur, 18px)) saturate(var(--g2-saturate, 175%));
}

/* ---- 2. 图片背景 ---- */
/* 面板上的遮罩色与各主题 body 上那层保持一致（glass 走 --bg-mask-color 变量，随日/夜与
   「夜间内置底图」自动变化；glass2 没有这个变量，日/夜各给一档） */
:root:is([data-theme="glass"]) {
  --panel-bg-mask: var(--bg-mask-color, rgba(240, 244, 248, var(--bg-mask-opacity, 0.6)));
}
:root[data-theme="glass2"] {
  --panel-bg-mask: rgba(238, 241, 248, var(--bg-mask-opacity, 0.6));
}
:root[data-mode="night"][data-theme="glass2"] {
  --panel-bg-mask: rgba(15, 21, 38, var(--bg-mask-opacity, 0.6));
}
/* 白色薄纱的不透明度：日间更亮更“奶”。深色模式直接去掉——主窗口的玻璃底图配方
   本身只有「遮罩 + 底图」两层（见 theme-glass.css 的 body::before），工具箱面板额外
   叠的这层白纱在夜间会把内置深色底图（glass-bg-night.webp）洗成灰白，看着像「没有
   图片背景」，也与「深色模式禁止额外白色提亮」的约定冲突。 */
:root {
  --panel-white-opacity: 0.5;
}
:root[data-mode="night"] {
  --panel-white-opacity: 0;
}
/* 有背景图时：图放到面板内单独一层（::before）再整体模糊，观感对齐引导页的磨砂玻璃卡片。
   模糊半径加大到 28px（引导页是 14px，这里更“全局模糊”）；图向外多留 2 倍半径，
   避免模糊后边缘露白，面板自身的 overflow:hidden 会把它裁成圆角。
   三层由下到上：背景图 → 主题遮罩色 → 白色薄纱（提亮）。
   isolation 只让这一层落在「面板背景」与「面板内容」之间（不会糊到菜单文字），
   也不会为工具面板内 position:fixed 的全屏层（如注释工具）建立包含块。 */
:root.has-bg-image .panel {
  position: relative;
  isolation: isolate;
  background-image: none;
}
:root.has-bg-image .panel::before {
  content: '';
  position: absolute;
  inset: -56px;
  z-index: -1;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, var(--panel-white-opacity, 0.34)), rgba(255, 255, 255, var(--panel-white-opacity, 0.34))),
    linear-gradient(var(--panel-bg-mask, rgba(255, 255, 255, 0.6)), var(--panel-bg-mask, rgba(255, 255, 255, 0.6))),
    var(--bg-image);
  background-size: cover, cover, cover;
  background-position: center, center, center;
  background-repeat: no-repeat, no-repeat, no-repeat;
  filter: blur(28px) saturate(1.15);
}

/* ---- 3. 菜单项：玻璃块 + 亮一档的选中态 ---- */
/* 基础态：由不透明色块改为半透明玻璃，让面板底色/背景图透出来 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .menu-item {
  background: color-mix(in srgb, var(--color-surface, #ffffff) 70%, transparent);
  border-color: rgba(255, 255, 255, 0.45);
}
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .menu-item {
  border-color: var(--color-border, rgba(255, 255, 255, 0.12));
}
/* 选中/悬停：在玻璃块上再提亮一档（日间白霜更实，夜间只提亮不刺眼），不再用纯主色填充 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .menu-item:hover {
  background: color-mix(in srgb, var(--color-surface, #ffffff) 34%, rgba(255, 255, 255, 0.7));
  border-color: rgba(255, 255, 255, 0.75);
  color: var(--color-primary, #3b82f6);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    0 2px 10px rgba(0, 0, 0, 0.12);
}
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .menu-item:hover {
  background: color-mix(in srgb, var(--color-surface, #ffffff) 44%, rgba(255, 255, 255, 0.34));
  border-color: rgba(255, 255, 255, 0.26);
  color: var(--color-text, #e6ecf5);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    0 2px 10px rgba(0, 0, 0, 0.3);
}

/* ---- 4. 二级页面（四个小工具内部）---- */
/* 工具页里的色块原本是不透明底色（--color-bg / --color-surface），会把面板的
   背景图整个盖住。这里统一换成「透亮玻璃块」：半透明的主题表面色 + 一层白霜 +
   柔和亮边，让面板那层模糊背景图透出来（同菜单项的配方）。
   注：面板背景本身已整体模糊过，这里的 backdrop-filter 只是补齐毛玻璃质感；
   这些元素内部都没有 position:fixed 的后代，不会破坏注释工具的全屏层。 */
:root {
  --tool-glass-white: rgba(255, 255, 255, 0.36);
  --tool-glass-hover: rgba(255, 255, 255, 0.42);
}
:root[data-mode="night"] {
  --tool-glass-white: rgba(255, 255, 255, 0.1);
  --tool-glass-hover: rgba(255, 255, 255, 0.16);
}
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel :is(.timer-tabs, .result-card, .file-path, .btn-secondary, .note-toolbar, .tb-sub-float, .screenshot) {
  background-color: color-mix(in srgb, var(--color-surface, #ffffff) 42%, transparent);
  background-image: linear-gradient(var(--tool-glass-white, rgba(255, 255, 255, 0.36)), var(--tool-glass-white, rgba(255, 255, 255, 0.36)));
  backdrop-filter: blur(16px) saturate(1.15);
  border-color: rgba(255, 255, 255, 0.5);
}
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel :is(.timer-tabs, .result-card, .file-path, .btn-secondary, .note-toolbar, .tb-sub-float, .screenshot) {
  border-color: var(--color-border, rgba(255, 255, 255, 0.12));
}
/* 一键截屏 / 注释加载保存页的内层玻璃块是整块铺满的方形，自身没有圆角，
   与面板的圆角不匹配（看着像直角块被裁在里面）。这里补上圆角。 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel .screenshot {
  border-radius: var(--radius-card);
}
/* 悬停：改为半透明白，替代原来的不透明底色 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel :is(.arrow, .tb-btn, .tb-btn-sub):hover {
  background: var(--tool-glass-hover, rgba(255, 255, 255, 0.42));
}
/* 选中态：提亮一档的亮玻璃，替代原来的纯主色填充 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel :is(.tab, .tb-btn, .tb-btn-sub).active {
  background-color: color-mix(in srgb, var(--color-surface, #ffffff) 26%, transparent);
  background-image: linear-gradient(var(--tool-glass-hover, rgba(255, 255, 255, 0.42)), var(--tool-glass-hover, rgba(255, 255, 255, 0.42)));
  border-color: rgba(255, 255, 255, 0.75);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
}
/* 选中态的图标/文字：亮玻璃底上白色看不见，改用主色 */
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel .tab.active {
  color: var(--color-primary, #3b82f6);
}
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel .tb-btn.active :is(.tb-icon, .tb-label),
:root:is([data-theme="glass"], [data-theme="glass2"]) .tool-panel .tb-btn-sub.active :is(.tb-icon-sm, .tb-label) {
  color: var(--color-primary, #3b82f6);
}
</style>

