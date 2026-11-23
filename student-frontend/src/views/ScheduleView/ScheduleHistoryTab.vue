<template>
  <div class="relative">
    <h2 class="text-xl font-semibold text-text flex items-center gap-2 min-h-7 mb-3"><IconGlyph name="calendar" :size="20" /> 历史课程表记录</h2>
    <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
      <button @click="ctx.refreshHistory()" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
      <button @click="ctx.openHistoryExport()" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 导出 Excel</button>
    </div>
    <Transition :name="ctx.slideDir">
      <div :key="ctx.historyCurrentWeek" class="history-content">
        <!-- 表头先行：加载中也渲染 GridView（列头默认周一~周五，快照到了再校正），
             仅在「加载完且无快照」时才换 EmptySnapshot -->
        <EmptySnapshot v-if="!ctx.historyLoading && !ctx.historySnapshot" />
        <GridView
          v-else
          :colHeaders="ctx.historyColHeaders"
          :colDates="ctx.historyColDates"
          :title="ctx.activeTitle"
          :rows="ctx.historySnapshot ? ctx.historyDisplayRows : []"
          :showPeriodColumn="true"
          @update:cells="() => {}"
          @swapRows="() => {}"
          @swapColumns="() => {}"
          @update:row-meta="() => {}"
        />
      </div>
    </Transition>
    <ExportExcel
      v-if="ctx.historyExportMounted"
      :is-visible="ctx.historyExportVisible"
      :rows="ctx.historyExportRows"
      :fields="ctx.historyExportFields"
      defaultFilename="历史课表记录"
      @update:is-visible="ctx.historyExportVisible = $event"
    />
    <!-- 快照菜单栏：周切换 + 下拉框 + 保存/删除按钮，同处一条毛玻璃栏 -->
    <WeekSwitcher
      :currentWeek="ctx.historyCurrentWeek"
      :weeks="ctx.historyWeeks"
      @update:currentWeek="onWeekChange"
      @direction="ctx.onSwitchWeek"
    >
      <template #actions>
        <button
          @click="ctx.captureHistorySnapshot()"
          class="bg-primary text-text-inverse px-3 py-1.5 rounded whitespace-nowrap cursor-pointer inline-flex items-center gap-1"
        ><IconGlyph name="camera" :size="14" tint="current" /> 保存本周快照</button>
        <button
          @click="ctx.requestDeleteHistorySnapshot()"
          :disabled="!ctx.canDeleteHistorySnapshot"
          class="bg-danger text-text-inverse px-3 py-1.5 rounded whitespace-nowrap cursor-pointer inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        ><IconGlyph name="trash" :size="14" tint="current" /> 删除本周快照</button>
      </template>
    </WeekSwitcher>
  </div>
</template>

<script setup vapor>
import { defineAsyncComponent } from 'vue'
import EmptySnapshot from '../../components/base/EmptySnapshot.vue'
import GridView from '../../components/tables/GridView/GridView.vue'
import WeekSwitcher from '../../components/base/WeekSwitcher.vue'

defineOptions({ name: 'ScheduleHistoryTab' })

// ctx 是父组件传入的 reactive 视图：里面每个字段都是父级的 ref，
// reactive 会自动解包，模板读写 ctx.xxx 等价于父级 xxx.value。
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx

const ExportExcel = defineAsyncComponent(() => import('../../components/import-export/ExportExcel/ExportExcel.vue'))

// WeekSwitcher 的周变化：先写回选中周，再触发快照加载（对应原模板的 v-model + @update:currentWeek）
function onWeekChange(value) {
  ctx.historyCurrentWeek = value
  ctx.loadHistorySnapshot()
}
</script>

<style scoped>
/* 历史表格周切换滑动动画：新旧表同向并行滑动（推拉感），不影响 WeekSwitcher */
.history-content { width: 100%; }
.next-enter-active, .next-leave-active,
.prev-enter-active, .prev-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
/* 退场表绝对定位到容器顶部，与进场表重叠实现并行滑动 */
.next-leave-active, .prev-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}
/* 下一周：向右推进（新表从左侧跟进向右移动，旧表向右滑出，同方向） */
.next-enter-from { transform: translateX(-60px); opacity: 0; }
.next-leave-to   { transform: translateX(60px); opacity: 0; }
/* 上一周：向左推进（新表从右侧跟进向左移动，旧表向左滑出，同方向） */
.prev-enter-from { transform: translateX(60px); opacity: 0; }
.prev-leave-to   { transform: translateX(-60px); opacity: 0; }
</style>
