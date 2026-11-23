<template>
  <div>
    <!-- 请假统计 -->
    <h3 class="text-xl font-semibold text-text mb-4 flex items-center gap-2 min-h-7"><IconGlyph name="chart" :size="20" /> 请假统计</h3>
    <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
      <button @click="ctx.refreshStats()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openStatsExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 导出 Excel
      </button>
    </div>
    <div class="bg-surface border border-border rounded-xl p-5">
      <StatBarList :rows="ctx.leaveStatRows" name-key="姓名" value-key="合计" :bar-width="ctx.statBarWidth" empty-text="暂无请假统计" />
    </div>

    <!-- 请假记录子标题 -->
    <h3 class="text-xl font-semibold text-text mt-8 mb-4 flex items-center gap-2 min-h-7"><IconGlyph name="clipboard" :size="20" /> 请假记录</h3>

    <!-- 工具栏：视图切换右对齐 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @mouseenter="ctx.prefetch(ctx.loadAddLeaveDialog)" @click="ctx.openAddLeave()" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">
        ＋ 添加请假
      </button>
      <button @click="ctx.refresh()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button @click="ctx.importDialogVisible = true" @mouseenter="ctx.prefetch(ctx.loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从表格批量导入
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openRecordsExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 导出 Excel
      </button>
      <ViewSwitch v-model="ctx.recordsView" :options="ctx.recordsViewOptions" class="ml-auto" />
    </div>

    <!-- 同一固定高度容器：v-show 切换，两个视图都保持挂载，切换不闪动、不改变页面高度 -->
    <div class="records-panel h-[400px] min-h-0">
      <div v-show="ctx.recordsView === 'table'" class="h-full">
        <DynamicTable
          :fields="ctx.leaveFields"
          :rows="ctx.displayLeaves"
          :newRow="ctx.newRow"
          :editingCell="ctx.editingCell"
          :hideMoveButtons="true"
          :hideSelectAll="true"
          :maxRows="10"
          :opColumnWidth="190"
          @startEdit="ctx.startEdit"
          @saveCell="ctx.saveCell"
          @swapColumns="(from, to) => ctx.saveColumnOrder('records', from, to)"
          @deleteRow="ctx.deleteLeave"
          @addNewRowAtBottom="ctx.addNewRowAtBottom"
          @updateNewRow="ctx.onUpdateNewRow"
          @saveNewRow="ctx.saveNewRow"
          @cancelNewRow="ctx.cancelNewRow"
          @contextmenu.prevent="() => {}"
          @selectionChange="() => {}"
          empty-import-text="从表格批量导入"
          @empty-import="ctx.openImportDialog()"
        >
          <template #row-actions-extra="{ row }">
            <button v-if="!row._isNew" @click="ctx.openEditLeave(row)" class="bg-info hover:bg-blue-700 text-text-inverse px-1.5 py-0.5 rounded mr-1 transition-theme">编辑</button>
          </template>
        </DynamicTable>
      </div>
      <div v-show="ctx.recordsView === 'timeline'" class="h-full">
        <LeaveTimeline fill-height :nodes="ctx.timelineNodes" :type-options="ctx.leaveTypeOptions" title="" />
      </div>
    </div>
  </div>
</template>

<script setup vapor>
import ViewSwitch from '../components/base/ViewSwitch.vue'
import StatBarList from '../components/base/StatBarList.vue'
import DynamicTable from '../components/tables/DynamicTable/DynamicTable.vue'
import LeaveTimeline from '../components/base/LeaveTimeline.vue'

defineOptions({ name: 'LeaveRecordsTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref / 函数，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
