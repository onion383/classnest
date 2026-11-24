<template>
  <!-- 每张表一档权限：中文名在上、解释在下，右侧下拉。
       纯展示：档位判定与保存都在 usePrivacyConfig（levelOf 兜底也放那边，两个入口同一套规则）。 -->
  <div>
    <h4 class="text-sm font-medium text-text mb-2 flex items-center gap-1.5">
      <span>{{ title }}</span>
      <AppHelp :aria-label="title + '的说明'" :z-index="10007" :text="help" />
    </h4>
    <!-- 表清单外面套一层毛玻璃（ai-glass-panel 是夜间模式统一改深色玻璃的标记类）。
         滚动条用项目自带的细滑块：容器加 .app-custom-scroll 把原生的收成 0 宽，
         父级必须是 position: relative，覆盖层按 target.offsetTop/clientHeight 定位。 -->
    <div class="relative ai-glass-panel bg-white/55 backdrop-blur-md border border-border rounded overflow-hidden">
      <div ref="listRef" class="max-h-72 overflow-y-auto overflow-x-hidden p-1.5 pr-3 app-custom-scroll">
        <div
          v-for="t in tables"
          :key="t.key"
          class="flex items-center gap-3 min-w-0 px-1.5 py-1 rounded hover:bg-surface-hover"
        >
          <span class="min-w-0 flex-1 leading-tight">
            <span class="block text-xs text-text truncate">{{ t.label }}</span>
            <span class="block text-[11px] text-text-muted truncate" :title="t.hint">{{ t.hint }}</span>
          </span>
          <AppSelect
            class="flex-none !w-32"
            compact
            :aria-label="`${t.label}的读取权限`"
            :model-value="levelOf(t)"
            :options="optionsFor(t)"
            @update:model-value="(v) => $emit('level', t, v)"
          />
        </div>
      </div>
      <CustomScrollbar :target="listRef" compact :arrows="false" auto-hide :min-thumb="20" />
    </div>
  </div>
</template>

<script setup vapor>
import { ref } from 'vue'
import AppHelp from '../base/AppHelp.vue'
import AppSelect from '../base/AppSelect.vue'
import CustomScrollbar from '../base/CustomScrollbar.vue'
import { levelOf, writableOf } from '../../composables/usePrivacyConfig.js'

defineProps({
  // [{ key, label, hint, level, writable }]，由后端 GET /api/ai/privacy 下发
  tables: { type: Array, default: () => [] },
  title: { type: String, default: 'AI 读取权限' },
  // 三档说明收进 ⓘ：常驻会把面板撑得很长
  help: {
    type: String,
    default: [
      '完全禁止：AI 完全读不到这张表（查询会被明确拒绝，不是返回空结果）。',
      '只读：可以查询，但不能提交任何修改。',
      '读写：允许 AI 提交修改提案，仍需你在界面上确认后才真正写入。',
      '不支持写入的表只有「完全禁止 / 只读」两档。',
    ].join('\n'),
  },
})
defineEmits(['level'])

// 表清单滚动容器（自带滚动条的定位目标）
const listRef = ref(null)

const LEVEL_OPTIONS = [
  { value: 'none', label: '完全禁止' },
  { value: 'read', label: '只读' },
  { value: 'write', label: '读写' },
]
// 后端已按表能力给出 writable：不能写的表不显示「读写」，否则是个点了必然失败的选项
function optionsFor(t) {
  return writableOf(t) ? LEVEL_OPTIONS : LEVEL_OPTIONS.slice(0, 2)
}
</script>
