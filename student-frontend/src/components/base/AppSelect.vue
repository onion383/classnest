<template>
  <div class="av-select" :class="{ 'av-select--open': open, 'av-select--disabled': disabled, 'av-select--compact': compact }" ref="rootRef">
    <!-- 触发区：圆角 + 毛玻璃底 + 点击按下反馈 -->
    <button
      type="button"
      class="av-select__trigger"
      :disabled="disabled"
      @click="toggle"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="open ? commit(hoverIdx) : openMenu()"
    >
      <!-- title：触发器宽度不够时文案仍会被省略号截断，悬停可看全文 -->
      <span class="av-select__value" :class="{ 'av-select__value--placeholder': !resolved || resolved.value == null }" :title="display">
        {{ display }}
      </span>
      <span class="av-select__arrow" aria-hidden="true"><IconGlyph name="chevronDown" tint="current" glyph :size="14" :stroke-width="1.8" /></span>
    </button>

    <!-- 下拉菜单（Teleport 到 body 避免被父容器 overflow/transform/backdrop-filter 裁剪） -->
    <Teleport to="body">
      <ul v-if="open" ref="menuRef" class="av-select__menu" :style="menuStyle" role="listbox">
        <li
          v-for="(opt, i) in list"
          :key="opt.value == null ? i : opt.value"
          class="av-select__option"
          :class="{ 'av-select__option--active': i === hoverIdx, 'av-select__option--selected': opt.value === resolved?.value, 'av-select__option--disabled': opt.disabled }"
          @mouseenter="hoverIdx = i"
          @click="commit(i)"
        >
          <span class="av-select__option-label">{{ opt.label }}</span>
          <IconGlyph name="check" tint="current" glyph v-if="opt.value === resolved?.value" class="av-select__check" :size="14" :stroke-width="1.8" />
        </li>
        <li v-if="!list.length" class="av-select__option av-select__option--empty">无选项</li>
      </ul>
      <!-- 下拉候选：细滑块 + 无箭头 + 悬停淡入。菜单是 fixed + Teleport，滚动条用 fixed 模式跟随 -->
      <CustomScrollbar
        v-if="open"
        :target="menuRef"
        compact
        :arrows="false"
        auto-hide
        fixed
        :min-thumb="18"
        :z-index="menuZ + 1"
      />
    </Teleport>
  </div>
</template>

<script setup vapor>
// 自定义下拉框：替代原生 <select>，适配圆角 + 毛玻璃 + 点击过渡动画。
// 用法：
//   <AppSelect v-model="xxx" :options="[{value:'a', label:'A'}, 'B']" placeholder="请选择" />
import '../../styles/select.css'
import { ref, computed, watch, onMounted, onBeforeUnmount, onDeactivated } from 'vue'
import IconGlyph from '../../components/base/IconGlyph.vue'
import CustomScrollbar from './CustomScrollbar.vue'
import { pushEscLayer, removeEscLayer, consumeEscape } from '../../utils/dialogStack.js'

defineOptions({ name: 'AppSelect' })

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  // 支持字符串数组：['A','B']；或对象数组：[{value, label, disabled}]，省略 value 时取 label 本身。
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  // 紧凑模式：缩小 trigger 高度，用于标题条等高度受限场景
  compact: { type: Boolean, default: false },
  // 不限高、不出内部滚动条：选项不多且需要一眼全部看到时用（如导出格式的 8 项，
  // 默认 220px 上限会把最后的「图片 / PDF」藏到折叠区外）
  noScroll: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

const open = ref(false)
const hoverIdx = ref(-1)
// 下拉菜单也是一层「Esc 层」：打开期间压进与弹窗共用的栈。
// 监听放在 document 而不是触发器上 —— 菜单展开后焦点可能已经不在按钮上，
// 只绑按钮会漏掉 Esc，弹窗反而因为「不是栈顶」死在原地。
const escLayer = {}
function onDocKeydown(e) {
  // Esc 走统一协议（见 utils/dialogStack.js · consumeEscape）：
  //   菜单展开 → 收菜单并消费事件，父弹窗不动；
  //   菜单收起 → 完全不消费，父弹窗的 Esc 照常生效。
  if (!consumeEscape(e, { open: open.value, self: escLayer })) return
  open.value = false
  hoverIdx.value = -1
}
watch(open, (v) => {
  if (v) {
    pushEscLayer(escLayer)
    document.addEventListener('keydown', onDocKeydown)
  } else {
    removeEscLayer(escLayer)
    document.removeEventListener('keydown', onDocKeydown)
  }
}, { flush: 'sync' })
const menuPos = ref({ left: 0, top: 0, width: 0, up: false, max: 220 })
// menuZ：下拉菜单的层级。菜单 Teleport 到 body 后自成一层，必须压过"包住触发器的浮层"，
// 否则会被弹窗遮罩/AI 悬浮窗盖住（点开看不到或只看到一角）。
const menuZ = ref(10010)

const rootRef = ref(null)
// 下拉菜单滚动容器（自定义滚动条的 fixed 目标）
const menuRef = ref(null)

const list = computed(() => {
  return props.options.map(o => {
    if (o && typeof o === 'object') return { value: o.value ?? o.label, label: o.label, disabled: !!o.disabled }
    return { value: o, label: String(o), disabled: false }
  })
})

const resolved = computed(() => {
  return list.value.find(o => o.value === props.modelValue) || null
})

const display = computed(() => {
  if (resolved.value) return resolved.value.label
  if (props.modelValue !== '' && props.modelValue != null) return String(props.modelValue)
  return props.placeholder
})

const menuStyle = computed(() => {
  if (!open.value) return {}
  // Teleport 到 body 后无法继承父级字号，主动读取组件自身字号同步给菜单
  const fs = rootRef.value && getComputedStyle(rootRef.value).fontSize
  const style = {
    position: 'fixed',
    left: menuPos.value.left + 'px',
    top: menuPos.value.top + 'px',
    width: menuPos.value.width + 'px',
    minWidth: '120px',
    zIndex: menuZ.value,
  }
  if (fs) style.fontSize = fs
  // 向上展开时把菜单底边贴到触发器上沿（top 记的是触发器上沿）
  if (menuPos.value.up) style.transform = 'translateY(-100%)'
  // 覆盖 select.css 里的 max-height: 220px；高度按视口可用空间给足，短列表（如导出格式 8 项）不再出滚动条
  if (props.noScroll) style.maxHeight = menuPos.value.max + 'px'
  return style
})

// 菜单每项高度（select.css：14px 字号 + 上下 7px padding ≈ 34px），用于判断向下还是向上展开
const MENU_ITEM_H = 34
const MENU_PAD = 12

function placeMenu() {
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  const need = Math.min(list.value.length * MENU_ITEM_H + MENU_PAD, props.noScroll ? Infinity : 220)
  const below = window.innerHeight - rect.bottom - 8
  const above = rect.top - 8
  // 下方放不下而上方更宽裕时向上展开，避免菜单被窗口底边裁掉（PDF 这一项曾因此看不见）
  const up = need > below && above > below
  menuPos.value = {
    left: rect.left,
    top: up ? rect.top - 4 : rect.bottom + 4,
    width: rect.width,
    up,
    max: Math.max(120, up ? above : below),
  }
}

// 打开菜单并把 hover 落到一个**可用项**上。
//
// 为什么必须初始化 hoverIdx：键盘路径是「第一次 Enter 打开 → 第二次 Enter 选中」，
//   若打开时 hoverIdx 还是 -1，第二次 Enter 就成了 commit(-1) → list[-1] 是 undefined
//   → commit 里静默 return → **按回车没反应**（用户看不出是哪里坏了）。
//   点击路径原来是对的（toggle 里做了初始化），键盘路径漏了 —— 现在两条路共用本函数。
//
// 落点规则：优先当前选中项；没有选中项、或选中项已禁用 → 落到第一个可用项。
function openMenu() {
  open.value = true
  let i = list.value.findIndex(o => o.value === props.modelValue)
  if (i < 0 || (list.value[i] && list.value[i].disabled)) {
    i = list.value.findIndex(o => !o.disabled)
  }
  hoverIdx.value = i
  placeMenu()
  menuZ.value = _layerZ()
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    open.value = false
    hoverIdx.value = -1
    return
  }
  openMenu()
}

// Esc 的处理在 document 监听里（见上面的 onDocKeydown）：
// 它随菜单展开注册、收起注销，不依赖按钮是否还持有焦点。

// 菜单层级：从触发器往上取祖先里最大的 z-index 再叠一层，保证压过包住它的浮层。
// 这样同一个下拉放在普通页面（无浮层，用 10010 兜底）、z-[10070] 的「添加模型」弹窗、
// z-[20001] 的 AI 悬浮窗里都能正常显示，不用每处浮层各写一个魔法数字。
function _layerZ() {
  let max = 0
  let el = rootRef.value
  while (el && el !== document.body && el !== document.documentElement) {
    const z = parseInt(window.getComputedStyle(el).zIndex, 10)
    if (!Number.isNaN(z) && z > max) max = z
    el = el.parentElement
  }
  return Math.max(10010, max + 10)
}

function move(step) {
  // 关闭态按方向键：走 openMenu()（要初始化 hoverIdx 并设置菜单 z-index），
  // 原来只置 open=true → hoverIdx 停在 -1 且 menuZ 没设（菜单可能被压住、也选不中）。
  if (!open.value) { openMenu(); return }
  const n = list.value.length
  if (!n) return
  let i = hoverIdx.value
  do { i = (i + step + n) % n } while (list.value[i].disabled && i !== hoverIdx.value)
  hoverIdx.value = i
}

function commit(i) {
  const opt = list.value[i]
  if (!opt || opt.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
  open.value = false
}

function onDocClick(e) {
  if (open.value && rootRef.value && !rootRef.value.contains(e.target)) open.value = false
}

// 滚动/resize 后按触发器新位置重排菜单；触发器滚出视口则直接收起
function onViewportChange() {
  if (!open.value) return
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
    open.value = false
    return
  }
  placeMenu()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  removeEscLayer(escLayer)
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

// 页面被 <KeepAlive> 缓存时不会 unmount，带着展开的菜单切走会把它留在全局 Esc 栈里，
// 导致之后所有弹窗的 Esc 都失效。切走即收起（收起的同时会从栈里移除）。
onDeactivated(() => {
  open.value = false
  hoverIdx.value = -1
})
</script>