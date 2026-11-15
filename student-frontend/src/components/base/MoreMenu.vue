<template>
  <div ref="rootRef" class="inline-flex relative">
    <button
      ref="triggerRef"
      type="button"
      class="btn-search px-4 py-2 rounded flex items-center gap-1.5 transition-theme"
      :aria-expanded="open"
      :aria-controls="menuId"
      aria-haspopup="menu"
      title="更多操作"
      @click="toggle"
    >
      <span>{{ label }}</span>
      <IconGlyph
        name="chevronDown"
        :size="14"
        tint="current"
        class="more-menu-chevron"
        :class="{ 'is-open': open }"
      />
    </button>

    <!-- Teleport 到 body：工具栏的祖先是 overflow-auto 的滚动容器，绝对定位会被裁掉，
         毛玻璃主题的 backdrop-filter 也会另建包含块。fixed + 量一次坐标最稳。 -->
    <Teleport to="body">
      <Transition name="more-menu">
        <div
          v-if="open"
          :id="menuId"
          ref="menuRef"
          class="more-menu-popup fixed bg-surface border border-border shadow-md rounded-lg py-1 z-[10010] min-w-[180px]"
          :style="menuStyle"
          role="menu"
        >
          <button
            v-for="item in items"
            :key="item.key"
            type="button"
            class="more-menu-item w-full flex items-center gap-2 px-4 py-2 text-sm text-left text-text hover:bg-surface-hover transition-theme disabled:opacity-50 disabled:cursor-not-allowed"
            :class="{ 'text-danger': item.danger }"
            :disabled="item.disabled"
            :title="item.hint || ''"
            role="menuitem"
            @click="pick(item)"
            @mouseenter="onItemHover(item)"
          >
            <IconGlyph v-if="item.icon" :name="item.icon" :size="14" tint="current" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup vapor>
// 工具栏「更多」下拉：把低频/危险操作收进一层菜单，避免一排按钮越排越长。
// 与 AppSelect / ContextMenu 同协议：Esc 走 dialogStack 统一层级，滚动/resize 直接收起，
// 点击外部收起。菜单 Teleport 到 body，坐标按触发器实测，贴近视口边缘时回收/上翻。
import { ref, watch, nextTick, useId, onDeactivated } from 'vue'
import IconGlyph from './IconGlyph.vue'
import { createDisposables, useDisposables } from '../../utils/disposables.js'
import { pushEscLayer, removeEscLayer, consumeEscape } from '../../utils/dialogStack.js'

defineOptions({ name: 'MoreMenu' })

const props = defineProps({
  // [{ key, label, icon?, danger?, disabled?, hint? }]
  items: { type: Array, default: () => [] },
  label: { type: String, default: '更多操作' },
})
// select：菜单项被点中（传 key）；hover：菜单项悬停（给调用方做 chunk 预取，别丢原有的 prefetch）
const emit = defineEmits(['select', 'hover'])

const menuId = useId()
const rootRef = ref(null)
const triggerRef = ref(null)
const menuRef = ref(null)
const open = ref(false)
// 初值 hidden 只为「首帧前不画」；打开时 place() 一定会写回 visible（见下方）。
// position 必须留在内联样式里：毛玻璃主题有
//   :root:is([data-theme="glass"]) .bg-surface { position: relative }
// 特异性 (0,3,0) 高于 Tailwind .fixed 的 (0,1,0)，菜单又恰好带 .bg-surface，
// position 会被顶成 relative —— 整块掉进 body 正常流，top 坐标把它推到页面最底部，
// 同时撑出滚动条、挤动布局。主题 CSS 在 Tailwind 之后加载，类名层面赢不了，
// 只能靠内联样式压住（与 SettingsView 的磁盘悬浮详情同一做法）。
// 后续赋值一律用展开保留，别写成整对象覆盖。
const menuStyle = ref({ position: 'fixed', left: '0px', top: '0px', visibility: 'hidden' })

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}
function pick(item) {
  if (item.disabled) return
  // 先收起再派发：收起会同步把自己的 Esc 层出栈，调用方紧接着开的确认框才是栈顶。
  close()
  emit('select', item.key)
}
function onItemHover(item) {
  emit('hover', item.key)
}

// 菜单最小宽度（与模板里的 min-w-[180px] 同源）：量不到真实宽高时用它估一个不越界的位置。
const MIN_WIDTH = 180

function place(attempt = 0) {
  const trigger = triggerRef.value
  const box = menuRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const margin = 8

  if (box) {
    const w = box.offsetWidth
    const h = box.offsetHeight
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - w - margin))
    let top = rect.bottom + 6
    if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 6)
    menuStyle.value = {
      ...menuStyle.value,
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      visibility: 'visible',
    }
    return
  }

  // 量不到菜单（Vapor 下 v-if 分支里的 template ref 要到**下一个 tick** 才赋值，
  // 实测 sync / 第一个 nextTick 都还是 null）：按触发器坐标 + 最小宽度先给一个
  // 不会越界的位置并直接显示，再在后续 tick 里量到真实宽高做精确修正。
  // 绝不能像原来那样量不到就 return —— 那会让 visibility 永远停在 hidden，
  // 菜单明明在 DOM 里、位置也对，却一帧都没画出来（真实踩到的 bug）。
  menuStyle.value = {
    ...menuStyle.value,
    left: `${Math.round(Math.max(margin, Math.min(rect.left, window.innerWidth - MIN_WIDTH - margin)))}px`,
    top: `${Math.round(rect.bottom + 6)}px`,
    visibility: 'visible',
  }
  if (attempt < 3) {
    nextTick(() => { if (open.value) place(attempt + 1) })
  }
}

const escLayer = {}
function onDocPointerDown(e) {
  if (!open.value) return
  const target = e.target
  if (rootRef.value?.contains(target)) return
  if (menuRef.value?.contains(target)) return
  close()
}
function onDocKeydown(e) {
  if (!consumeEscape(e, { open: open.value, self: escLayer })) return
  close()
}

// 打开期间才注册监听，收起即全部撤掉 —— 「关闭 ≠ 卸载」，v-if 掉菜单内容也必须撤资源。
// 组件级 d 只做卸载兜底，防止带着展开状态被卸载时留下孤儿监听与 Esc 层。
const d = useDisposables()
let opened = null
d.add(() => {
  if (opened) { opened.dispose(); opened = null }
  removeEscLayer(escLayer)
})

watch(open, (v) => {
  if (v) {
    if (!opened) {
      const sub = createDisposables()
      sub.listen(document, 'pointerdown', onDocPointerDown, true)
      sub.listen(document, 'keydown', onDocKeydown)
      sub.listen(window, 'scroll', close, true)
      sub.listen(window, 'resize', close)
      opened = sub
    }
    pushEscLayer(escLayer)
    // 不再「先隐藏再量」：量取本身要等下一个 tick，藏一帧反而闪。
    // place() 自己会在量不到时先用触发器坐标显示，再在后续 tick 修正。
    place()
  } else {
    if (opened) { opened.dispose(); opened = null }
    removeEscLayer(escLayer)
  }
}, { flush: 'sync' })

// 页面被 <KeepAlive> 缓存时不会 unmount，带着展开的菜单切走会把它留在全局 Esc 栈里。
onDeactivated(close)
</script>

<style scoped>
.more-menu-chevron {
  transition: transform 0.14s ease;
}
.more-menu-chevron.is-open {
  transform: rotate(180deg);
}

/* 菜单项在 opbar 外，但玻璃主题仍有全局 button 皮肤；这里剥掉边框/底色，
   只留 hover 反馈，避免每项看起来像一颗独立按钮。 */
.more-menu-item {
  background: transparent;
  border: none;
  box-shadow: none;
  cursor: pointer;
}
.more-menu-item:disabled {
  cursor: not-allowed;
}

/* 展开比收起更急：菜单是"点完马上就要看"的浮层，130ms 会明显觉得慢半拍；
   收起略快一档，避免淡出中的菜单继续接管指针。 */
.more-menu-enter-active {
  transition: opacity 90ms ease-out, transform 90ms ease-out;
  transform-origin: top left;
}
.more-menu-leave-active {
  transition: opacity 70ms ease-in, transform 70ms ease-in;
  transform-origin: top left;
  /* 点菜单项后常会立刻弹确认框，淡出期间不再接管指针 */
  pointer-events: none;
}
.more-menu-enter-from,
.more-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .more-menu-enter-active,
  .more-menu-leave-active,
  .more-menu-chevron {
    transition: none;
  }
}
</style>
