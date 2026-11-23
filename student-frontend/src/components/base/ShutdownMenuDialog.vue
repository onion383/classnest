<template>
  <Teleport to="body">
  <Transition name="dialog">
    <div v-if="visible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10006] pointer-events-auto" @click.self="cancel">
      <div class="shutdown-card dialog-card">
        <!-- 顶部条：左侧小标签 + 右侧 X 关闭 -->
        <div class="shutdown-header">
          <span class="shutdown-tag">退出行为</span>
          <button class="dlg-close" @click="cancel" title="关闭">×</button>
        </div>

        <!-- 标题区 -->
        <div class="shutdown-title-wrap">
          <h2 class="shutdown-title">关闭班集</h2>
          <p class="shutdown-subtitle">你可以保留后台进程与组件窗口，或者直接完全退出应用。</p>
        </div>

        <!-- 选项卡 -->
        <div class="shutdown-options">
          <button class="shutdown-opt" @click="choose('main')">
            <span class="opt-icon opt-icon-blue">
              <IconGlyph name="monitor" tint="current" glyph :size="22" :stroke-width="1.8" />
            </span>
            <span class="opt-text">
              <span class="opt-title">关闭主窗口</span>
              <span class="opt-desc">仅关闭主窗口，工具箱与桌面组件继续在后台运行。</span>
            </span>
          </button>

          <button class="shutdown-opt" :class="{ 'opt-disabled': !hasToolbox }" :disabled="!hasToolbox" @click="choose('toolbox')">
            <span class="opt-icon opt-icon-cyan">
              <IconGlyph name="panelsTopLeft" tint="current" glyph :size="22" :stroke-width="1.8" />
            </span>
            <span class="opt-text">
              <span class="opt-title">关闭主窗口和工具箱<span v-if="!hasToolbox" class="opt-muted-inline">（未开启）</span></span>
              <span class="opt-desc">关闭主窗口与浮窗工具箱，桌面组件继续运行。</span>
            </span>
          </button>

          <button class="shutdown-opt" :class="{ 'opt-disabled': !hasDesktop }" :disabled="!hasDesktop" @click="choose('desktop')">
            <span class="opt-icon opt-icon-green">
              <IconGlyph name="layoutGrid" tint="current" glyph :size="22" :stroke-width="1.8" />
            </span>
            <span class="opt-text">
              <span class="opt-title">关闭主窗口和桌面组件<span v-if="!hasDesktop" class="opt-muted-inline">（未开启）</span></span>
              <span class="opt-desc">关闭主窗口与桌面小组件，工具箱继续运行。</span>
            </span>
          </button>

          <button class="shutdown-opt opt-danger" @click="choose('all')">
            <span class="opt-icon opt-icon-red">
              <IconGlyph name="power" tint="current" glyph :size="22" :stroke-width="1.8" />
            </span>
            <span class="opt-text">
              <span class="opt-title">完全关闭</span>
              <span class="opt-desc">结束所有进程并停止后端服务，下次需要重新启动。</span>
            </span>
          </button>
        </div>

        <!-- 复选框：下次不再提示 -->
        <label class="shutdown-check">
          <input type="checkbox" v-model="remember" />
          <span class="check-box"></span>
          <span>下次不再提示，直接按本次选择处理</span>
        </label>

        <!-- 底部取消按钮 -->
        <div class="shutdown-footer">
          <button class="shutdown-cancel" @click="cancel">取消</button>
        </div>
      </div>
    </div>
  </Transition>
  </Teleport>
</template>

<script setup vapor>
// 主窗口关闭选择菜单：复用 dialog-transition.css 的弹窗动画
import { ref } from 'vue'
import '../../styles/dialog-transition.css'
import IconGlyph from '../../components/base/IconGlyph.vue'

defineOptions({ name: 'ShutdownMenuDialog' })
defineProps({
  visible: Boolean,
  hasToolbox: Boolean,
  hasDesktop: Boolean,
})
const emit = defineEmits(['choose', 'cancel'])

const remember = ref(false)

function choose(action) { emit('choose', { action, remember: remember.value }) }
function cancel() { emit('cancel') }
</script>

<style scoped>
/* ========== 卡片容器 ========== */
.shutdown-card {
  position: relative;
  width: 460px;
  max-width: calc(100vw - 32px);
  padding: 24px 28px 20px;
  /* 二层毛玻璃：遮罩已模糊背景（第一层），卡片再叠一层更白的玻璃（第二层）。
     日间沿用 AI 助手面板 / 引导页玻璃面板的现成配方：0.86 白 + 28px 强模糊 +
     白色描边 + 顶部内高光，比原来直接取 --color-surface（glass2 仅 0.55 白）更白净。 */
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(28px) saturate(1.5);
  -webkit-backdrop-filter: blur(28px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: var(--radius-surface);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), var(--shadow-lg);
  text-align: left;
  color: var(--color-text);
}
/* 夜间回到主题变量：深色底上硬编码白玻璃会冲淡底色、让浅色文字看不清。
   glass / glass2 / base 三套主题的夜间 --color-surface 都已定义，无需逐主题写规则。 */
:root[data-mode="night"] .shutdown-card {
  background: var(--color-surface);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border-color: var(--color-border);
  box-shadow: var(--shadow-lg);
}

/* ========== 顶部：标签 + 关闭按钮 ========== */
.shutdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.shutdown-tag {
  display: inline-block;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  border-radius: 999px;
  letter-spacing: 0.5px;
}
/* 关闭按钮：方形毛玻璃 × 统一走全局公共类 .dlg-close（见 styles/utilities.css） */

/* ========== 标题区 ========== */
.shutdown-title-wrap {
  margin-bottom: 18px;
}
.shutdown-title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.3;
}
.shutdown-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* ========== 选项卡 ========== */
.shutdown-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}
.shutdown-opt {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  /* 嵌套毛玻璃第三层：卡片自身已是第二层玻璃（0.86 白），每个选项再叠一层白玻璃。
     0.74 白叠在卡片上合成约 0.96 白，比卡片更白更通透；再补强模糊、白描边、顶部内高光，
     与 AI 面板 / 设置页 ai-glass-panel 的嵌套玻璃同一套观感。夜间在下方单独翻成深蓝玻璃。 */
  background: rgba(255, 255, 255, 0.74);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.68);
  /* !important 压过 glass 主题给所有 button 写的投影 + 荧光环（theme-glass.css:354）。 */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 2px 10px rgba(15, 23, 42, 0.05) !important;
  border-radius: var(--radius-control);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
}
/* 压掉 glass 主题给所有 button 加的 ::before 荧光描边环，玻璃选项只要自己的白描边 */
.shutdown-opt::before { display: none !important; content: none !important; }
/* 悬浮不改背景色：白玻璃叠在卡片上已接近饱和，再提亮几乎看不出（会变成「有的项变、有的不变」）。
   统一靠描边 + 投影抬升给反馈，四个选项行为一致，也没有颜色突变。 */
.shutdown-opt:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.95);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 4px 14px rgba(15, 23, 42, 0.14) !important;
}
.shutdown-opt:active:not(:disabled) {
  transform: scale(0.99);
}
.shutdown-opt.opt-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.shutdown-opt.opt-danger:hover:not(:disabled) {
  /* 危险项 hover 也不改背景色，只把描边/投影染成红色，与其他三项反馈方式一致。
     红色走 --color-danger 按主题混色，夜间自动适配（C3 的暗红 !important 仍会覆盖）。 */
  border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 4px 14px color-mix(in srgb, var(--color-danger) 18%, transparent) !important;
}
/* 夜间：白玻璃翻成深蓝玻璃（与 ai-glass-panel / class-info-card 同一口径），
   保留描边与顶部内高光的层次。C3 的 danger hover 特异性更高且带 !important，不受影响。 */
:root[data-mode="night"] .shutdown-opt {
  background: rgba(46, 64, 100, 0.55);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
}
:root[data-mode="night"] .shutdown-opt:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 4px 14px rgba(0, 0, 0, 0.3) !important;
}

/* 图标盒：底色/图标色沿用日间语义色，夜间在 theme-*-night.css C3 统一提亮 */
.opt-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-control);
}
.opt-icon-blue   { background: rgba(59, 130, 246, 0.12); color: #2563eb; }
.opt-icon-cyan   { background: rgba(6, 182, 212, 0.12);  color: #0891b2; }
.opt-icon-green  { background: rgba(34, 197, 94, 0.12);  color: #16a34a; }
.opt-icon-red    { background: rgba(239, 68, 68, 0.12);  color: #dc2626; }

/* 文本区 */
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.opt-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.4;
}
.opt-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.opt-muted-inline {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--color-text-muted);
}

/* ========== 复选框 ========== */
.shutdown-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin: 4px 0 12px;
  /* 与上方四个选项同一套嵌套白玻璃（0.74 白 + 模糊 + 白描边 + 内高光），保持层次一致。
     这是 label 不是 button，没有 glass 主题的 button 荧光环冲突，故无需 !important。 */
  background: rgba(255, 255, 255, 0.74);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.68);
  border-radius: var(--radius-control);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 2px 10px rgba(15, 23, 42, 0.05);
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
/* 与选项一致：悬浮只改描边/投影，不动背景色 */
.shutdown-check:hover {
  border-color: rgba(255, 255, 255, 0.95);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 4px 14px rgba(15, 23, 42, 0.14);
}
/* 夜间翻成与选项一致的深蓝玻璃 */
:root[data-mode="night"] .shutdown-check {
  background: rgba(46, 64, 100, 0.55);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
:root[data-mode="night"] .shutdown-check:hover {
  border-color: rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 4px 14px rgba(0, 0, 0, 0.3);
}
.shutdown-check input {
  display: none;
}
.shutdown-check .check-box {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--color-border-strong);
  border-radius: var(--radius-xs);
  background: var(--color-surface);
  position: relative;
  transition: background 0.15s, border-color 0.15s;
}
.shutdown-check input:checked + .check-box {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.shutdown-check input:checked + .check-box::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 0px;
  width: 5px;
  height: 10px;
  border: solid var(--color-text-inverse);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* ========== 底部：取消按钮 ========== */
.shutdown-footer {
  display: flex;
  justify-content: flex-end;
}
.shutdown-cancel {
  padding: 8px 22px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: 999px;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.shutdown-cancel:hover {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
</style>
