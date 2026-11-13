// =========================================================================
// useViewerPan.js —— 图片查看器放大后的拖动平移（两份查看器共用）
//
// 现象：查看器只有 rotate + scale，放大后超出舞台的部分被 overflow-hidden 裁掉，
// 鼠标拖不动，边角永远看不到。这里补一条 translate，并把它夹在可视余量内。
//
// 三个容易踩的点：
//  1. transform 顺序必须是 `translate(...) rotate(...) scale(...)`。CSS 从右往左
//     应用，translate 写在最左（最外层）才落在屏幕坐标系里 —— 拖 1px 就走 1px；
//     若写在 scale 后面，位移会被缩放倍率再乘一遍，放大 5 倍时手感直接失控。
//  2. 平移量必须夹边界，否则能把整张图拖出舞台、留下空白再也找不回来。
//     缩小 / 转回 0 度 / 改窗口大小之后旧的平移量也可能已经越界，所以 zoom、
//     rotation、resize 三处都要重新 clamp。
//  3. 用 setPointerCapture 而不是 window 上的全局 pointermove：指针甩出舞台仍能
//     继续拖，且捕获挂在元素上，元素随 v-if 移除时浏览器自己回收，不留全局监听。
//     拖动起始时把 bounds 缓存下来，pointermove 每帧就零 DOM 读取。
//
// 调用方要把返回值**解构到 <script setup> 顶层**再给模板用：Vapor 模板只认顶层
// 绑定，写成 `pan.onPointerDown` 这种嵌套属性访问在 Vapor 下不会自动解包 ref。
// =========================================================================
import { ref, computed, watch } from 'vue'
import { useDisposables } from '../utils/disposables.js'
import { PAN_MIN_ZOOM, panBounds, clampPanValue } from '../utils/viewerPan.js'

/**
 * @param {object} o
 * @param {import('vue').Ref<number>} o.zoom      缩放倍率（ref）
 * @param {import('vue').Ref<number>} o.rotation  旋转角度（ref，度）
 * @param {import('vue').Ref<HTMLElement|null>} o.stageRef 图片外层容器（overflow-hidden 那层）
 * @param {import('vue').Ref<HTMLElement|null>} o.mediaRef <img> 本体
 */
export function useViewerPan({ zoom, rotation, stageRef, mediaRef }) {
  const panX = ref(0)
  const panY = ref(0)
  const panning = ref(false)

  // 旋转 90/270 时宽高互换，zoom=1 也可能被裁，所以旋转态同样允许拖动
  const canPan = computed(() => zoom.value > PAN_MIN_ZOOM || rotation.value % 180 !== 0)

  const style = computed(() => ({
    transform: `translate(${panX.value}px, ${panY.value}px) rotate(${rotation.value}deg) scale(${zoom.value})`,
  }))
  // 给舞台：未放大不给 grab，否则「明明拖不动却显示手型」
  const stageClass = computed(() => panning.value ? 'viewer-panning' : (canPan.value ? 'viewer-can-pan' : ''))
  // 给 <img>：拖动期间必须掐掉 transition-transform，否则每帧都慢 100ms
  const mediaClass = computed(() => panning.value ? 'viewer-panning' : '')

  let drag = null

  function measureBounds() {
    const stage = stageRef.value
    const media = mediaRef.value
    if (!stage || !media) return { maxX: 0, maxY: 0 }
    return panBounds({
      mediaW: media.offsetWidth || 0,
      mediaH: media.offsetHeight || 0,
      stageW: stage.clientWidth || 0,
      stageH: stage.clientHeight || 0,
      zoom: zoom.value,
      rotation: rotation.value,
    })
  }

  function clamp() {
    const bounds = measureBounds()
    const p = clampPanValue(panX.value, panY.value, bounds)
    panX.value = p.x
    panY.value = p.y
    return bounds
  }

  /** 换图 / 翻页 / 关闭 / 复位：平移量归零，并把可能仍在进行的拖动彻底收掉 */
  function reset() {
    if (drag) {
      try { drag.el.releasePointerCapture(drag.id) } catch (_) { /* 元素已移除 */ }
    }
    drag = null
    panning.value = false
    panX.value = 0
    panY.value = 0
  }

  function onPointerDown(e) {
    if (!canPan.value || drag) return
    if (e.button != null && e.button !== 0) return
    const bounds = clamp()
    drag = {
      id: e.pointerId,
      el: e.currentTarget,
      x: e.clientX,
      y: e.clientY,
      ox: panX.value,
      oy: panY.value,
      bounds,
    }
    panning.value = true
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* 不支持捕获时仍可拖 */ }
    try { e.preventDefault() } catch (_) { /* 保留 click 语义，只挡原生图片拖拽/选字 */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return
    const p = clampPanValue(
      drag.ox + (e.clientX - drag.x),
      drag.oy + (e.clientY - drag.y),
      drag.bounds,
    )
    panX.value = p.x
    panY.value = p.y
  }

  function onPointerUp(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) { /* 已自动释放 */ }
    drag = null
    panning.value = false
  }
  // pointercancel（触屏被系统接管、元素被移除）与 pointerup 同一套收尾
  const onPointerCancel = onPointerUp

  // zoom / rotation 变了，旧的平移量可能已经越界（尤其是缩回 1 倍时要自动回正）
  watch([zoom, rotation], () => { clamp() })

  // 窗口大小改变同样改变可视余量。监听器登记在**组件作用域**：组件卸载时由
  // disposables 撤掉；查看器用 v-if 关掉时舞台 ref 为 null，clamp 是空操作。
  const d = useDisposables()
  if (typeof window !== 'undefined') d.listen(window, 'resize', () => { clamp() })

  return {
    panX, panY, panning, canPan,
    style, stageClass, mediaClass,
    clamp, reset,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  }
}
