<template>
  <div class="leave-timeline bg-surface border border-border rounded-xl p-5" :class="{ 'tl-fill': fillHeight }">
    <!-- 标题（title 为空时不渲染，供页面把标题外置为子标题） -->
    <div v-if="title" class="flex items-center justify-between mb-4">
      <h3 class="text-base font-bold text-text">{{ title }}</h3>
    </div>

    <!-- 筛选区 -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <input
        v-model.trim="keyword"
        type="text"
        placeholder="按学生姓名筛选"
        class="px-3 py-1.5 text-sm rounded-lg bg-surface-hover border border-border focus:outline-none focus:border-primary w-48"
      />
      <div class="w-32"><AppSelect v-model="filterType" :options="filterTypeOptions" /></div>
      <div class="w-32"><AppSelect v-model="filterNode" :options="filterNodeOptions" /></div>
    </div>

    <!-- 时间轴 -->
    <div class="timeline" v-if="visibleNodes.length" :style="fillHeight ? null : { maxHeight: maxHeight + 'px' }">
      <div
        v-for="node in visibleNodes"
        :key="node.key"
        :data-row-id="node.key"
        class="timeline-row content-visibility-auto"
      >
        <div class="timeline-marker" :style="markerStyle(node)"></div>
        <!-- 右侧对齐模式（加分/扣分标签与操作按钮放右侧） -->
        <div v-if="alignRight" class="timeline-item flex" :style="itemStyle(node)">
          <div class="min-w-0 flex-1">
            <div class="text-xs text-text-muted mb-0.5">{{ node.time }}</div>
            <slot name="content" :node="node">
              <div class="text-sm text-text">{{ node.text }}</div>
            </slot>
          </div>
          <div class="flex items-center gap-2 shrink-0 self-center">
            <span class="px-2 py-0.5 rounded text-xs" :class="badgeClass(node)">
              {{ nodeTypeLabel(node.type) }}
            </span>
            <slot name="ops" :node="node" />
          </div>
        </div>
        <!-- 默认模式：内容上下堆叠，标签在下方 -->
        <template v-else>
          <div class="timeline-item" :style="itemStyle(node)">
            <div class="text-xs text-text-muted mb-0.5">{{ node.time }}</div>
            <div class="text-sm text-text">{{ node.text }}</div>
            <span class="inline-block mt-1 px-2 py-0.5 rounded text-xs" :class="badgeClass(node)">
              {{ nodeTypeLabel(node.type) }}
            </span>
            <slot name="ops" :node="node" />
          </div>
        </template>
      </div>
    </div>

    <!-- 空状态。两种「空」必须分开：
         · 一条记录都没有 → 显示页面传入的 emptyText；传了 emptyActionText 就配一个引导按钮
           （如加分页的「今天还没有人加分 / 去加分」）；
         · 有记录、只是被筛选挡住了 → 固定提示「暂无匹配」，此时引导去新增只会越搞越乱
           （数据本来就在，加一条新的并不能解决「为什么看不见」）。
         请假页两个 prop 都不传，走默认值：文案与改造前完全一致，且不出现按钮。
         加载中单独一档：数据还没回来时 nodes 也是空的，不挡一下会先闪出「还没有人加分 + 去加分」
         再变成列表 —— 那个按钮一闪而过，反而像故障。 -->
    <div v-else-if="loading" class="tl-empty">
      <p class="tl-empty-text">加载中…</p>
    </div>
    <div v-else class="tl-empty">
      <p class="tl-empty-text">{{ filteredOut ? '暂无匹配的时间轴记录' : emptyText }}</p>
      <!-- 空态两条出路：主操作（去加分）在上，「从 Excel 表格批量导入」在下。
           两者间距 18px（.empty-actions），避免两个按钮挤在一起。 -->
      <div
        v-if="!filteredOut && (emptyActionText || emptySecondaryActionText)"
        class="empty-actions"
      >
        <button
          v-if="emptyActionText"
          type="button"
          class="empty-action-btn"
          @click="emit('emptyAction')"
        >{{ emptyActionText }}</button>
        <button
          v-if="emptySecondaryActionText"
          type="button"
          class="empty-import-btn"
          @click="emit('emptySecondaryAction')"
        >{{ emptySecondaryActionText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup vapor>
import AppSelect from './AppSelect.vue'
import { zhCollator } from '../../utils/collator.js'
import { ref, computed } from 'vue'

defineOptions({ name: 'LeaveTimeline' })

const props = defineProps({
  // 节点结构：{ type, time, text, category, key }，type 对应 nodeTypes 里的 value
  nodes: { type: Array, default: () => [] },
  // 请假类型选项（用于筛选）
  typeOptions: { type: Array, default: () => [] },
  // 标题
  title: { type: String, default: '🗓️ 请假时间轴' },
  // 右侧对齐：把类型标签与操作按钮放到右侧（业务时间轴如加分/扣分使用）
  alignRight: { type: Boolean, default: false },
  // 时间轴列表最大高度（px），默认 420，业务方可按需调高
  maxHeight: { type: Number, default: 420 },
  // 撑满外层容器高度：外层给固定高度时，卡片与时间轴区域一起填满（用于和表格同高切换）
  fillHeight: { type: Boolean, default: false },
  // 「一条记录都没有」时的提示文案。默认值与改造前写死的那句一致，老调用方不受影响。
  // 注意它不会出现在「有记录但被筛选挡住」的场景 —— 那时固定提示「暂无匹配」。
  emptyText: { type: String, default: '暂无匹配的时间轴记录' },
  // 空态下的引导按钮文案；留空则不显示按钮（请假页、导入预览等不需要）
  emptyActionText: { type: String, default: '' },
  // 空态下的第二入口文案（目前用于「从 Excel 表格批量导入」）；留空则不显示
  emptySecondaryActionText: { type: String, default: '' },
  // 数据加载中：此时 nodes 也是空的，若不单独挡一下会先闪出空态（尤其是带按钮的空态）再变列表。
  // 不传则维持改造前行为（加载中直接显示空态文案）。
  loading: { type: Boolean, default: false },
  // 节点类型配置：{ value, label, colorKey: 'info'|'success'|'danger', color: hex }
  nodeTypes: {
    type: Array,
    default: () => [
      { value: 'apply', label: '已申请', colorKey: 'info', color: '#3b82f6' },
      { value: 'leave', label: '离开校园', colorKey: 'danger', color: '#dc2626' },
      { value: 'return', label: '返校', colorKey: 'success', color: '#16a34a' }
    ]
  }
})

const keyword = ref('');
const filterType = ref('');
const filterNode = ref('');

// 空态引导按钮的点击：由页面决定打开哪个弹窗（时间轴本身不知道业务该怎么新增）
const emit = defineEmits(['emptyAction', 'emptySecondaryAction'])

const filterTypeOptions = computed(() => {
  return [{ value: '', label: '全部类型' }, ...props.typeOptions];
});
const filterNodeOptions = computed(() => {
  return [{ value: '', label: '全部事件' }, ...props.nodeTypes];
});
const visibleNodes = computed(() => {
  const kw = keyword.value.toLowerCase();
  const type = filterType.value;
  const node = filterNode.value;
  return props.nodes
    .filter(n => {
      if (kw) {
        const haystack = Object.values(n).map(v => String(v || '')).join(' ').toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      if (type && n.category !== type) return false;
      if (node && n.type !== node) return false;
      return true;
    })
    .slice()
    .sort((a, b) => zhCollator.compare(String(b.time), String(a.time)));
});

// 时间轴里本来有记录、只是被筛选挡住了（区别于「一条记录都没有」）。
// visibleNodes 为空时，只要 nodes 非空就一定是筛掉的 —— 两者展示文案与按钮都不同。
const filteredOut = computed(() => props.nodes.length > 0);

function nodeTypeLabel(type) {
  const t = props.nodeTypes.find(n => n.value === type);
  return t ? t.label : type;
}
function nodeColor(node) {
  const t = props.nodeTypes.find(n => n.value === node.type);
  return t ? t.color : '#9ca3af';
}
function markerStyle(node) {
  const c = nodeColor(node);
  return { color: c, background: c };
}
function itemStyle(node) {
  return { borderLeftColor: nodeColor(node) };
}
function badgeClass(node) {
  const t = props.nodeTypes.find(n => n.value === node.type);
  const map = { info: 'bg-info/10 text-info', success: 'bg-success/10 text-success', danger: 'bg-danger/10 text-danger', muted: 'bg-surface-hover text-text-secondary border border-border' };
  return map[t && t.colorKey] || map.info;
}
</script>

<style scoped>
/* 空态：文案 +（可选）引导按钮垂直堆叠。
   尺寸沿用改造前那句 py-8 / text-sm / text-text-muted 的观感，不额外加高。 */
.tl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px 20px;
  text-align: center;
}
.tl-empty-text {
  margin: 0;
  font-size: 14px;
  color: var(--color-text-muted, #94a3b8);
}
.timeline {
  position: relative;
  padding-left: 16px;
  max-height: 420px;
  overflow-y: auto;
}
/* fillHeight：卡片撑满外层，时间轴区域吃掉剩余高度并内部滚动（与表格同高切换时不跳动） */
.tl-fill {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.tl-fill .timeline {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 28px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: var(--radius-xs);
}
.timeline-row {
  position: relative;
  display: flex;
  align-items: center;
  /* 行内留出左侧内边距：行带 content-visibility:auto（绘制裁剪），
     圆点外圈描边必须落在行盒子内，否则会被裁掉 */
  padding: 0 0 18px 6px;
  gap: 2px;
}
.timeline-row:last-child {
  padding-bottom: 4px;
}
.timeline-marker {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 3px solid var(--color-surface, #ffffff);
  box-shadow: 0 0 0 2px currentColor;
}
.timeline-item {
  flex: 1;
  min-width: 0;
  background: var(--color-surface-hover, rgba(255, 255, 255, 0.5));
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
  border-radius: var(--radius-control);
  padding: 8px 12px;
}
</style>