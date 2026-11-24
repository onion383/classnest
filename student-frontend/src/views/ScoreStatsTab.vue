<template>
  <div>
    <!-- 子标题 + 工具栏（统计范围切换右对齐） -->
    <h3 class="text-xl font-semibold text-text mb-4 flex items-center gap-2 min-h-7"><IconGlyph name="chart" :size="20" /> 加分统计</h3>
    <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
      <button @click="ctx.refreshStats()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button @click="ctx.importDialogVisible = true" @mouseenter="ctx.prefetch(ctx.loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从表格批量导入
      </button>
      <button @click="ctx.openStatsExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 导出 Excel
      </button>
      <AppSelect v-model="ctx.statMode" aria-label="统计方式" :options="ctx.statModeOptions" class="w-32 ml-auto" />
    </div>

    <div class="bg-surface border border-border rounded-xl p-5 mb-6">
      <StatBarList
        :rows="ctx.statRows"
        :bar-width="ctx.barWidth"
        :bar-class="ctx.barColor"
        :value-text="ctx.valueText"
        :value-class="ctx.valueColor"
        :row-key="(row) => ctx.statMode + '-' + (row.key || row.name)"
        :empty-text="'暂无' + (ctx.isGroup ? '小组' : '个人') + '加分记录'"
      />
    </div>

    <!-- 加分记录 -->
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-xl font-semibold text-text flex items-center gap-2 min-h-7"><IconGlyph name="clipboard" :size="20" /> {{ ctx.isGroup ? '小组' : '个人' }}加分记录</h3>
    </div>
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <DynamicTable
        :fields="ctx.scoreFields"
        :rows="ctx.scoreRows"
        :editing-cell="ctx.editingCell"
        hide-select-all
        hide-move-buttons
        hide-add-row
        :empty-label="ctx.isGroup ? '小组加分' : '个人加分'"
        :empty-action-text="ctx.isGroup ? '＋ 添加小组加分' : '＋ 添加个人加分'"
        empty-import-text="从表格批量导入"
        @add-new-row-at-bottom="ctx.openAdd()"
        @empty-import="ctx.openImportDialog()"
        @start-edit="ctx.startEdit"
        @save-cell="ctx.saveCell"
        @delete-row="ctx.onDeleteRow"
        @swap-rows="ctx.onSwapRows"
        @scroll-end="ctx.loadMore"
        @swap-columns="ctx.onSwapColumns"
        @edit-row="ctx.openEditRow"
      />
    </div>
  </div>
</template>

<script setup vapor>
import AppSelect from '../components/base/AppSelect.vue'
import StatBarList from '../components/base/StatBarList.vue'
import DynamicTable from '../components/tables/DynamicTable/DynamicTable.vue'

defineOptions({ name: 'ScoreStatsTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
