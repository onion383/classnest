import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { resourceUrl, ensureMediaToken } from '../utils/apiUrl'
import { loadThemeStyles, warmNightMode, isNightWarmEnabled } from '../styles/themeLoader'
import { performThemeSwap, isThemeSwapInFlight } from '../styles/themeTransition'
import { createLatest } from '../utils/latestOnly'
import { SEND } from '../electronChannels.js'

const THEME_KEY = 'app-theme'
// 全局日/夜模式：与「主题」正交，任何主题之上再叠一层夜间配色（见 styles/theme-night.css）。
// base / glass / glass2 实现了夜间配色，其余主题保持日间外观（切换按钮禁用）。
const MODE_KEY = 'app-mode'
// 跟随系统：开启后按操作系统「深色/浅色」偏好自动切换日/夜（base / glass / glass2 支持）
const FOLLOW_KEY = 'app-mode-follow-system'
// base 的夜间规则已合并进 theme-base-accent.css（随 index.css 常驻），
// 因此这里控制「按钮可用」，但 themeLoader 不需要再加载额外的夜间文件。
const NIGHT_THEMES = ['base', 'glass', 'glass2']
// 旧版「自定义主题 / 颜色调整」的存储键：对应 UI 入口已删除，仅用于启动时清掉遗留数据。
const LEGACY_CUSTOM_COLOR_KEY = 'app-theme-custom'
const LEGACY_CUSTOM_THEMES_KEY = 'app-custom-themes'
const BG_IMAGE_KEY = 'app-bg-image'

// CSS `url('...')` 用单引号包裹：URL 自身若含单引号/反斜杠必须转义，
// 否则整条声明从第一个引号处断开，背景图直接不生效（审查 v4 · B11-14）。
const cssUrlEscape = (u) => String(u).replace(/['\\]/g, '\\$&')
const BG_MASK_KEY = 'app-bg-mask-opacity'
const GLASS_KEY = 'app-glass-opacity'
const ICON_STYLE_KEY = 'app-icon-style'
const TOPBAR_COLOR_KEY = 'app-topbar-color'
const ANIMATIONS_KEY = 'app-animations'

// 毛玻璃主题的内置默认背景图：放于 public/ 下，随前端一起打包，属前端静态资源，
// 不经 resourceUrl/鉴权直接加载。用户选择本地图片后由 backgroundImage 覆盖它；清除则回此图。
// 生产环境下用 window.location.origin 构造绝对 URL（app:// 协议），避免相对路径解析问题。
const DEFAULT_GLASS_BG = import.meta.env.PROD
  ? window.location.origin + '/glass-bg-opt.webp'
  : `${import.meta.env.BASE_URL}glass-bg-opt.webp`
// glass 夜间模式的默认底图：本身已是深色风景图，故其上的黑色遮罩要更轻（见 theme-night.css
// 的 .bg-night-default 规则），否则会把图压死。仅夜间生效，日间仍用 DEFAULT_GLASS_BG。
const DEFAULT_GLASS_BG_NIGHT = import.meta.env.PROD
  ? window.location.origin + '/glass-bg-night.webp'
  : `${import.meta.env.BASE_URL}glass-bg-night.webp`

const PRESETS = [
  { id: 'base', name: '彩色色块主题' },
  { id: 'glass', name: '毛玻璃主题' },
  { id: 'glass2', name: '新毛玻璃主题' },
]
// 主题 id 白名单：启动读本地设置、setTheme（含 AI 改设置）都据此校验，
// 避免已移除主题（如旧的 win11 / minimal）在 data-theme 上留下一个无样式可匹配的 id。
export const PRESET_IDS = PRESETS.map(p => p.id)

// 清理旧版自定义主题遗留数据（入口已移除，见 doc/development/topics/design-and-interaction.md）。
// 这些键不再被读取/应用，留着只会让主题选择器列出点不开的无效卡片。
// 发现本地主题 id 已不在白名单时一并回落到默认毛玻璃，避免首帧套用已删除的样式。
try {
  localStorage.removeItem(LEGACY_CUSTOM_COLOR_KEY)
  localStorage.removeItem(LEGACY_CUSTOM_THEMES_KEY)
  const savedTheme = localStorage.getItem(THEME_KEY)
  if (savedTheme && !PRESET_IDS.includes(savedTheme)) {
    localStorage.setItem(THEME_KEY, 'glass')
  }
} catch (_) { /* 非浏览器环境（如静态审计脚本）没有 localStorage，忽略 */ }

// 数值型设置的读取：**不能用 `parseFloat(x) || 默认值`**。
// 不透明度滑块的 min 是 0，「完全透明」是合法取值，而 0 会被 `||` 当成"没读到"→ 重载后变回默认值。
const readNum = (key, fallback) => {
  const v = parseFloat(localStorage.getItem(key))
  return Number.isFinite(v) ? v : fallback
}

export const useThemeStore = defineStore('theme', () => {
  // 持久化设置的读取集中在这里：既用于初始状态，也用于「别的窗口改了设置」时重新同步
  // （工具箱浮窗跟随主窗口的主题/日夜间切换，见 src/subwindows/widget/main.js）。
  // 只接受白名单内的主题 id（旧的 win11 / minimal 已在重构中移除）
  const readTheme = () => {
    const saved = localStorage.getItem(THEME_KEY)
    return PRESET_IDS.includes(saved) ? saved : 'glass'
  }

  const readPersisted = () => ({
    theme: readTheme(),
    // 全局日/夜模式：'day' | 'night'（默认日间，保持现有观感）
    mode: localStorage.getItem(MODE_KEY) === 'night' ? 'night' : 'day',
    // 是否跟随系统配色（true 时 mode 由系统偏好决定，手动切换会自动关闭它）
    followSystem: localStorage.getItem(FOLLOW_KEY) === '1',
    backgroundImage: localStorage.getItem(BG_IMAGE_KEY) || '',
    // 背景遮罩层不透明度（0~1，有自定义背景图时生效）
    bgMaskOpacity: readNum(BG_MASK_KEY, 0.6),
    // 组件透明玻璃层不透明度（0~1，卡片基准值）
    glassOpacity: readNum(GLASS_KEY, 0.4),
    // 图标样式：'color'（彩色图标）| 'emoji'（Emoji）
    iconStyle: localStorage.getItem(ICON_STYLE_KEY) || 'color',
    // 标题栏/侧边栏毛玻璃配色：'blue'（深蓝，旧款）| 'light'（白色调，新款默认）
    topbarColor: localStorage.getItem(TOPBAR_COLOR_KEY) || 'light',
    // 动画效果总开关：关闭后全局禁用过渡与动画（含窗口淡入淡出、弹窗/列表动效等）
    animationsEnabled: localStorage.getItem(ANIMATIONS_KEY) !== '0',
  })
  const persisted = readPersisted()
  const currentTheme = ref(persisted.theme)
  // 已落地的日/夜模式：与根元素 data-mode 一致，只在真正上屏的那一刻才变
  const mode = ref(persisted.mode)
  // 用户点选后立刻变化的目标模式：按钮/开关绑它，与页面落地解耦。
  // 这样点下去按钮当帧就翻，页面配色仍等样式就位后再落（见 commitMode）。
  const pendingMode = ref(persisted.mode)
  const isNightPending = computed(() => pendingMode.value === 'night')
  const followSystem = ref(persisted.followSystem)
  // 当前主题是否已实现夜间配色（决定切换按钮是否可用）
  const nightSupported = computed(() => NIGHT_THEMES.includes(currentTheme.value))
  const backgroundImage = ref(persisted.backgroundImage)
  const bgMaskOpacity = ref(persisted.bgMaskOpacity)
  const glassOpacity = ref(persisted.glassOpacity)
  const iconStyle = ref(persisted.iconStyle)
  const topbarColor = ref(persisted.topbarColor)
  const animationsEnabled = ref(persisted.animationsEnabled)
  // 「不画主题背景图」开关（**不持久化**，每次启动由调用方设置）。
  // 桌面小组件用：它的磨砂背景来自主进程的系统亚克力（真实透出桌面被模糊），
  // 若再叠一层主题背景图就会盖住亚克力、退化成一张静态图片。
  // 组件启动时置 true → 只借主题的配色，背景图与遮罩一律不画。
  const suppressBackgroundImage = ref(false)

  // 可供选择的主题：三套预设。
  // 主题选择器弹窗（ThemePickerDialog）与引导页（Setup、设置页下拉）都用它。
  const allThemes = computed(() => PRESETS)

  // 空闲期预热夜间样式：把「首次切日/夜」的样式编译成本挪到空闲期（详见 styles/themeLoader.js）。
  // 用 requestIdleCallback 等真正空闲再跑，避免与启动/交互抢主线程；
  // 不设 timeout 兜底：宁可晚预热，也别把一段 50ms 的样式重算插进忙碌期。
  // 开关关闭（isNightWarmEnabled() === false）时整段不排：预热是「空闲时偷偷把整页日→夜→日
  // 跑一遍」，用户反馈切主题时有可见的闪动/底色跳变，视觉上不划算（2026-10-20 关）。
  let nightWarmScheduled = false
  const scheduleNightWarm = () => {
    if (!isNightWarmEnabled()) return
    if (nightWarmScheduled) return
    nightWarmScheduled = true
    const run = () => {
      nightWarmScheduled = false
      // 预热时若用户已切到夜间，则无需再预热（函数内部会自行判断）
      warmNightMode(currentTheme.value, mode.value)
    }
    window.requestIdleCallback(run, { timeout: 3000 })
  }

  // 关闭动画时延迟给根元素打 no-animations 的定时器（见 setAnimationsEnabled）
  let noAnimTimer = null

  const syncNoAnimations = () => {
    document.documentElement.classList.toggle('no-animations', !animationsEnabled.value)
  }

  const applyTheme = () => {
    document.documentElement.dataset.theme = currentTheme.value
    // 全局日/夜模式：写 data-mode，styles/theme-night.css 据此叠加夜间配色
    document.documentElement.dataset.mode = mode.value
    // 按需加载当前主题/模式的样式：首次进入加载一份，切换主题或日/夜时自动补载新的一份
    // （同一份只加载一次，命中缓存；未用到的主题样式不参与首屏）
    loadThemeStyles(currentTheme.value, mode.value)
    // 切到支持夜间配色的主题后，空闲期预热一次夜间样式：把「首次切日/夜」的那次性
    // 样式编译成本挪到空闲期，避免用户第一次点切换卡一下（详见 styles/themeLoader.js）。
    // 只在当前是日间时预热；已是夜间则夜间规则本来就在生效，无需预热。
    if (mode.value !== 'night') scheduleNightWarm()
    // 标题栏/侧边栏毛玻璃配色：写 data-topbar-color，CSS 据此切深蓝/白色调
    document.documentElement.dataset.topbarColor = topbarColor.value
    // 动画总开关：关闭时给根元素打 no-animations，配合全局 CSS 瞬时化所有动效
    syncNoAnimations()
    // 应用背景图（使用单引号避免 base64 data URL 中的双引号冲突）
    // resourceUrl 会补完整后端地址并追加 ?token=，保证 file:// 打包版下背景图能通过鉴权加载。
    // 毛玻璃主题无自定义图时使用内置默认背景（前端静态资源，无需鉴权，直接引用）；
    // 自定义图仍走 resourceUrl。其余主题保持无背景。
    const isCustomBg = Boolean(backgroundImage.value)
    // glass 内置默认底图：日/夜各一张（夜间图本身是深色风景图，遮罩随之变轻）
    const defaultGlassBg = mode.value === 'night' ? DEFAULT_GLASS_BG_NIGHT : DEFAULT_GLASS_BG
    // 「不画主题背景图」：桌面小组件用。组件的磨砂背景来自**主进程的系统亚克力**
    // （真实透出桌面被模糊），若这里再画一层主题背景图就会盖住它、变成一张静态图片。
    // 故组件只借用主题的配色（文字、卡片、圆角等），背景图与遮罩一律不画。
    const suppressBg = suppressBackgroundImage.value
    const bg = suppressBg
      ? ''
      : backgroundImage.value || (currentTheme.value === 'glass' ? defaultGlassBg : '')
    if (bg) {
      const bgUrl = isCustomBg ? resourceUrl(bg) : bg
      document.documentElement.style.setProperty('--bg-image', `url('${cssUrlEscape(bgUrl)}')`)
      document.documentElement.classList.add('has-bg-image')
      // 旧版本升级上来的账号可能还没有媒体凭据：补一份后把背景图重设一次，
      // 否则这张带鉴权的自定义背景会一直 401（图不会自行重试）。
      if (isCustomBg && !localStorage.getItem('mediaToken')) {
        ensureMediaToken().then((t) => {
          if (t) document.documentElement.style.setProperty('--bg-image', `url('${cssUrlEscape(resourceUrl(bg))}')`)
        }).catch((e) => {
          // 补发媒体凭据失败 → 背景图会一直 401。这里不抛：主题本身已经应用完了，
          // 抛出去只会变成 unhandled rejection（用户看不到任何提示）。
          console.warn('[theme] 补发媒体凭据失败，背景图可能加载失败', e)
        })
      }
    } else {
      document.documentElement.style.removeProperty('--bg-image')
      document.documentElement.classList.remove('has-bg-image')
    }
    // 夜间内置默认底图标记：仅「glass + 夜间 + 未用自定义图」时加。
    // 供 theme-night.css 给这张深色图配一层更轻的遮罩；自定义图仍走通用遮罩系数。
    document.documentElement.classList.toggle(
      'bg-night-default',
      !isCustomBg && currentTheme.value === 'glass' && mode.value === 'night'
    )
    // 应用透明度设置
    document.documentElement.style.setProperty('--bg-mask-opacity', bgMaskOpacity.value)
    document.documentElement.style.setProperty('--glass-opacity', glassOpacity.value)
    // 通知主进程：窗口统一为无边框亚克力（恒 frameless）。主进程传 frameless 会触发
    // recreateMainWindow 的「当前已相同」直接返回，故主题切换不会重建窗口（见 electron/main.js）。
    if (window.electron?.send) {
      window.electron.send(SEND.THEME_CHROME, { mode: 'frameless' })
    }
  }

  // ==================== 日/夜切换的提交路径 ====================
  // 顺序：先让目标模式的 CSS 与底图就位，再一次性改 data-mode。
  // 反过来（先改属性、再异步加载 CSS）第一次切换会付两次全量样式重算：一次按旧 CSS，
  // 等新 CSS 注入后再整篇重算一次 —— 这也是「首次切夜间明显更卡」的一部分原因。
  // 已解码过的底图 URL：切换时命中即同步放行（见 preloadModeBackground）
  const preloadedBackgrounds = new Set()
  // theme 可显式传入「即将切到的主题」：setTheme 备料时 currentTheme 已是目标值，
  // 但 webp 是否要解码取决于主题，显式传入比隐式读当前状态更不容易漏。
  const preloadModeBackground = (target, theme = currentTheme.value) => {
    // glass 主题日夜各一张内置底图（applyTheme 里 --bg-image 会换成另一张）。
    // 提前解码，避免快照淡入结束后底图才「啪」地跳出来。自选底图日夜同一张，无需处理。
    if (theme !== 'glass' || backgroundImage.value) return Promise.resolve()
    const url = target === 'night' ? DEFAULT_GLASS_BG_NIGHT : DEFAULT_GLASS_BG
    if (!url) return Promise.resolve()
    // 已解码过就直接同步返回：这条路径每次切换都要走一遍，
    // 重复 new Image() + 等 decode 会白白多压一个任务，切换因此晚起一帧。
    if (preloadedBackgrounds.has(url)) return Promise.resolve()
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const done = () => {
          preloadedBackgrounds.add(url)
          resolve()
        }
        if (typeof img.decode === 'function') img.decode().then(done, done)
        else done()
      }
      // 失败不进缓存：下次切换再试，最坏只是底图晚一拍出现
      img.onerror = () => resolve()
      img.src = url
    })
  }

  const commitMode = async (target) => {
    await loadThemeStyles(currentTheme.value, target)
    await preloadModeBackground(target)
    // 等待期间用户又点了一次：交给后来那次提交，避免两次快照互相打断
    if (pendingMode.value !== target) return
    // 目标与已落地一致、且没有过渡在途（快速点两下又回到原模式）：无需再跑一段过渡。
    // 有过渡在途时不能省：那次回调还没把 mode 落下去，省掉会和它打架（mode 与 pending 脱节）。
    if (mode.value === target && !isThemeSwapInFlight()) return
    // 切换本身交给快照交叉淡入，元素级过渡在事务窗口内瞬时完成（见 styles/themeTransition.js）。
    // mode 在快照回调里才落地：按钮早已靠 pendingMode 翻过去了，这里只负责页面配色。
    performThemeSwap(() => {
      mode.value = target
      applyTheme()
    })
  }

  // 按钮/开关立即响应（写 pendingMode），页面配色等样式就位后再落
  const switchModeTo = (target) => {
    if (pendingMode.value === target) return
    pendingMode.value = target
    localStorage.setItem(MODE_KEY, target)
    commitMode(target)
  }

  // 空闲期预解码「另一张」内置底图：首次切换日/夜时不必再等解码。
  // 否则快照淡入会被推迟，观感是「按钮先变、界面后变」。自选底图日夜同一张，无需处理。
  // 由 App.vue 的首屏后空闲预热调用一次（见 startIdlePrefetch）。
  const warmModeBackgrounds = () => {
    preloadModeBackground(mode.value === 'night' ? 'day' : 'night')
  }

  // 切主题的序号守卫：备料（等目标主题 CSS / 底图）期间用户可能又点了别的卡片，
  // 只让最后一次真正落地 DOM，避免先完成的那次把后点选的盖回去。
  const themeSwap = createLatest()

  const setTheme = async (themeId) => {
    // 挡住已移除/未知主题 id（旧 localStorage 数据、AI 改设置等旁路）：
    // 否则 data-theme 会落到一个没有任何主题 CSS 匹配的状态。
    if (!PRESET_IDS.includes(themeId)) {
      console.warn('[theme] 忽略未知主题 id:', themeId)
      return
    }
    // 点已选中的卡片：不付一次全量样式重算，也不发一次无谓的同步 IPC
    if (currentTheme.value === themeId) return

    // ① 状态先行：卡片高亮当帧就变（与 commitMode 的 pendingMode 同理）。
    //    此刻 data-theme 仍是旧值，页面配色等 ② 备齐后再落，避免「点下去没反应」。
    //    之所以能这样做，是因为 currentTheme 已不再有 watch 自动写 DOM（见文件末尾）。
    currentTheme.value = themeId
    localStorage.setItem(THEME_KEY, themeId)
    const token = themeSwap.begin()

    // ② 先把目标主题的 CSS 与底图备齐，再改 data-theme。
    //    反过来会「按旧 CSS 全量重算一次 + CSS 注入后再整篇重算一次」，首次切到
    //    尚未加载过的主题时尤其明显 —— 这正是 commitMode 里已经避开的顺序
    //    （themeLoader.js 的空闲预热会缓存全部主题 CSS，命中时这里只是一个微任务）。
    const targetMode = mode.value
    await loadThemeStyles(themeId, targetMode)
    await preloadModeBackground(targetMode, themeId)
    // 备料期间日/夜若变了：补等新组合的 CSS（命中缓存时只是一个微任务），
    // 免得落地后 applyTheme 再异步注入一份、又付一次全量重算。
    if (mode.value !== targetMode) await loadThemeStyles(themeId, mode.value)
    // 等待期间用户又选了别的主题：交给后来那次落地
    if (!themeSwap.isCurrent(token)) return

    // ③ 与日/夜切换共用同一段快照淡入：浏览器在改属性前后各拍一张整屏快照，
    //    两帧之间只动快照层 opacity（合成器单层动画，成本与 DOM 规模无关）。
    //    performThemeSwap 内部会用 withInstantStyles 把元素级过渡瞬时化 ——
    //    glass 给所有 button / tr 的颜色与阴影过渡若跟着重绘 0.2s、且每层
    //    backdrop-filter 每帧重采样，等于把上一轮优化掉的卡顿又付一遍。
    //    即：过渡观感由快照提供，逐元素渐变仍瞬时结束，两者不叠加。
    //    关掉「动画效果」时 snapshotTransitionAllowed() 自动退化为瞬时切换；
    //    连点则由 performThemeSwap 的 inflight 混合度接着往回走（日/夜与主题
    //    共用同一段过渡状态，因为浏览器同一时刻本就只有一个活跃过渡）。
    performThemeSwap(() => applyTheme())
  }

  // 从 localStorage 重新读取全部持久化设置并重新应用。
  // 用于「别的窗口改了主题」时同步本窗口（工具箱浮窗跟随主窗口的主题/日夜间切换）。
  const reloadFromStorage = () => {
    const p = readPersisted()
    currentTheme.value = p.theme
    mode.value = p.mode
    pendingMode.value = p.mode
    followSystem.value = p.followSystem
    backgroundImage.value = p.backgroundImage
    bgMaskOpacity.value = p.bgMaskOpacity
    glassOpacity.value = p.glassOpacity
    iconStyle.value = p.iconStyle
    topbarColor.value = p.topbarColor
    animationsEnabled.value = p.animationsEnabled
    applyTheme()
  }

  const setBackgroundImage = (url) => {
    backgroundImage.value = url
    localStorage.setItem(BG_IMAGE_KEY, url)
    applyTheme()
  }

  const setBgMaskOpacity = (value) => {
    bgMaskOpacity.value = value
    localStorage.setItem(BG_MASK_KEY, value)
    applyTheme()
  }

  const setGlassOpacity = (value) => {
    glassOpacity.value = value
    localStorage.setItem(GLASS_KEY, value)
    applyTheme()
  }

  const setIconStyle = (value) => {
    iconStyle.value = value
    localStorage.setItem(ICON_STYLE_KEY, value)
  }

  const setTopbarColor = (value) => {
    topbarColor.value = value
    localStorage.setItem(TOPBAR_COLOR_KEY, value)
    document.documentElement.dataset.topbarColor = value
  }

  // 动画总开关：写 localStorage 后切换全局 no-animations。
  // 关闭时必须等开关自己的过渡跑完再加类 —— 否则类在当前事件里同步生效，
  // 这一下会被 !important 的瞬时化规则当场掐断，表现为「开启有动画、关闭直接硬切」。
  // 三处入口（设置页 / 主题弹窗 / 引导页）现在都用 AppSwitch，留 180ms 覆盖 120ms 行程。
  const setAnimationsEnabled = (value) => {
    animationsEnabled.value = !!value
    localStorage.setItem(ANIMATIONS_KEY, value ? '1' : '0')
    clearTimeout(noAnimTimer)
    if (animationsEnabled.value) {
      // 开启：立即恢复动效，让滑块从当前位置滑过去
      syncNoAnimations()
    } else {
      // 关闭：留出滑块行程，再全局瞬时化（之后所有动效仍是立刻生效）
      noAnimTimer = setTimeout(() => {
        noAnimTimer = null
        syncNoAnimations()
      }, 180)
    }
  }

  // 系统深浅色偏好：跟随系统开启时据此决定日/夜
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')
  // 系统配色变化：跟随开启时按系统偏好切换（走带快照过渡的切换流程）
  const onSystemModeChange = () => {
    if (!followSystem.value) return
    switchModeTo(darkMedia.matches ? 'night' : 'day')
  }
  // 跟随系统开关：开启时立即按系统配色切换
  const setFollowSystem = (value) => {
    followSystem.value = !!value
    localStorage.setItem(FOLLOW_KEY, followSystem.value ? '1' : '0')
    if (followSystem.value) onSystemModeChange()
  }
  // 全局日/夜模式：手动切换视为用户显式指定，自动关闭「跟随系统」以免随后被系统偏好覆盖
  const setMode = (value) => {
    setFollowSystem(false)
    switchModeTo(value === 'night' ? 'night' : 'day')
  }

  const toggleMode = () => setMode(pendingMode.value === 'night' ? 'day' : 'night')

  // 启动即同步一次系统配色（若已开启跟随）：此时页面尚未上屏，
  // 直接从正确的配色起步即可，不做快照过渡（也不该在启动期插一段动画）。
  if (followSystem.value) {
    const initial = darkMedia.matches ? 'night' : 'day'
    if (mode.value !== initial) {
      mode.value = initial
      pendingMode.value = initial
      applyTheme()
    }
  }
  // 监听系统深浅色变化
  darkMedia.addEventListener('change', onSystemModeChange)

  // 不再监听 currentTheme 自动应用：currentTheme 的写入口只有 setTheme 与
  // reloadFromStorage 两处，二者都显式应用过（启动期各入口也显式调 applyTheme）。
  // 留着 watch 会让同一次切主题把 applyTheme 跑两遍（第二遍还带一次同步 IPC），
  // 也会破坏 setTheme 的「状态先行、DOM 后落」——状态一变就抢先把 data-theme 写了。
  // backgroundImage 的 watch 只负责持久化，应用仍由各 setter 显式触发，保持原样。
  watch(backgroundImage, (val) => {
    localStorage.setItem(BG_IMAGE_KEY, val)
  })

  return {
    currentTheme,
    mode,
    pendingMode,
    isNightPending,
    nightSupported,
    followSystem,
    backgroundImage,
    bgMaskOpacity,
    glassOpacity,
    iconStyle,
    topbarColor,
    animationsEnabled,
    suppressBackgroundImage,
    allThemes,
    setTheme,
    applyTheme,
    reloadFromStorage,
    setBackgroundImage,
    setBgMaskOpacity,
    setGlassOpacity,
    setIconStyle,
    setTopbarColor,
    setAnimationsEnabled,
    setMode,
    toggleMode,
    setFollowSystem,
    warmModeBackgrounds,
  }
})
