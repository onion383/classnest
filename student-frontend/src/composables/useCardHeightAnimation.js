import { watch } from 'vue'
import { useDisposables } from '../utils/disposables'

/**
 * 卡片高度过渡：内容增减时播一段 height 动画，而不是瞬跳。
 *
 * 为什么用 WAAPI 而不是 CSS transition（这段结论来自登录页 Login.vue 的实测）：
 * transition 要靠「先钉成 from、强制回流、再改成 to」起跳，变矮那个方向两次赋值
 * 会被合并成一次、动画根本不播；WAAPI 直接给首尾关键帧，两个方向都稳。
 *
 * 为什么用 ResizeObserver 而不是让调用方 watch 状态：
 * 弹窗的高度变化往往来自**插槽内容**（勾选开关多出两个输入框、错误行出现），
 * 组件内部看不到那些状态。观察元素自身的高度，任何来源的变化都能跟。
 * ResizeObserver 回调在 layout 之后、paint 之前执行，所以在回调里起动画不会
 * 出现「先闪成新高度再回弹」。
 *
 * 动画期间才设 overflow: hidden —— 变矮的那一段旧内容会溢出卡片；
 * 常驻则会把输入框聚焦光圈这类溢出特效一起剪掉。
 *
 * @param {import('vue').Ref<HTMLElement|null>} elRef 卡片元素
 * @param {{ duration?: number, easing?: string }} [options]
 */
export function useCardHeightAnimation(elRef, options = {}) {
  const { duration = 260, easing = 'cubic-bezier(0.4, 0, 0.2, 1)' } = options
  const d = useDisposables()

  let anim = null
  let seq = 0
  let lastHeight = 0      // 上一次的稳定高度 —— RO 回调里元素已经是新高度了，取不到旧值
  let ignore = false      // 动画自己改高度会再次触发 RO，必须挡住
  let ro = null

  /** 交还 auto 高度，并把当前高度记为下一次的起点 */
  function settle(el) {
    el.style.height = ''
    el.style.overflow = ''
    lastHeight = el.offsetHeight
  }

  function play(el, from, to) {
    const mySeq = ++seq
    ignore = true
    // 动画期间停止观察：WAAPI 每帧都在改 height，不停会让 RO 每帧回调一次
    if (ro) ro.unobserve(el)
    // 先把高度钉回旧值。RO 回调虽然跑在 paint 之前，但 WAAPI 的起始帧要到下一次
    // 渲染步骤才生效 —— 不钉这一下，用户会看到「先跳到新高度、再缩回去重播」。
    el.style.height = from + 'px'
    el.style.overflow = 'hidden'
    const a = el.animate(
      [{ height: from + 'px' }, { height: to + 'px' }],
      { duration, easing }
    )
    anim = a
    const done = () => {
      if (mySeq !== seq) return       // 已被下一次变化接管
      anim = null
      settle(el)
      // 恢复观察要在 settle 之后：此时基准高度已是终态，observe 的首次通知会因为
      // 「高度没变」被自己跳过，不会多播一段
      if (ro) ro.observe(el)
      ignore = false
    }
    a.onfinish = done
    d.timeout(done, duration + 80)    // onfinish 没派发（被打断 / 环境异常）时兜底
  }

  function connect(el) {
    if (!el || typeof ResizeObserver === 'undefined') return
    lastHeight = el.offsetHeight
    ro = new ResizeObserver(() => {
      if (ignore) return
      const to = el.offsetHeight
      if (!to) return
      const from = lastHeight || to
      // 高度没实质变化（宽度变了、只是重新换行到同一高度）：只更新基准，不播动画
      if (Math.abs(to - from) < 1) { lastHeight = to; return }
      // 关闭动画效果时直接就位（WAAPI 不受 html.no-animations 的 CSS 兜底约束，得自己判）
      if (document.documentElement.classList.contains('no-animations')) { settle(el); return }
      play(el, from, to)
    })
    ro.observe(el)
    d.add(() => ro.disconnect())
  }

  // 卡片通常是 v-if 出来的，ref 从 null 变成元素时才开始观察
  watch(elRef, (el, oldEl) => {
    if (ro) { ro.disconnect(); ro = null }
    if (anim) { try { anim.cancel() } catch (_) { /* 已经结束 */ } anim = null }
    seq += 1
    ignore = false
    if (oldEl) { oldEl.style.height = ''; oldEl.style.overflow = '' }
    if (el) connect(el)
  }, { immediate: true, flush: 'post' })
}
