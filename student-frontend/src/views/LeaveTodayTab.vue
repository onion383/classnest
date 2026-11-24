<template>
  <div>
    <!-- 数据看板 -->
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="bg-surface rounded-xl border border-border p-4">
        <div class="text-sm text-text-secondary">全班人数</div>
        <div class="text-2xl font-bold text-text">{{ ctx.totalStudents }} 人</div>
      </div>
      <div class="bg-success/10 rounded-xl border border-border p-4">
        <div class="text-sm text-text-secondary">在校人数</div>
        <div class="text-2xl font-bold text-success">{{ ctx.inSchool }} 人</div>
      </div>
      <div class="bg-danger/10 rounded-xl border border-border p-4">
        <div class="text-sm text-text-secondary">当前请假</div>
        <div class="text-2xl font-bold text-danger">{{ ctx.activeLeaves.length }} 人</div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @mouseenter="ctx.prefetch(ctx.loadAddLeaveDialog)" @click="ctx.openAddLeave()" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">
        ＋ 添加请假
      </button>
      <button @click="ctx.refresh()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openExportToday()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 导出今日表
      </button>
    </div>

    <!-- 两张「今日」小表通常只有几行，却默认跟着 virtualFrom=1 跑窗口化渲染：
         挂载后 recalcWindow 才把窗口算出来、行是后补的；叠加 sticky 操作列的独立绘制层
         与玻璃主题按钮描边，会出现「数据先出、按钮逐行补齐」和滚动重绘。传 0 走整表 DOM。 -->
    <!-- 当前请假中 -->
    <div class="bg-surface border border-border rounded-xl mb-4 overflow-hidden">
      <div class="px-5 py-3 border-b border-border font-bold text-text flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-danger inline-block"></span> 当前请假中（{{ ctx.activeLeaves.length }}人）
      </div>
      <DynamicTable
        fit-content
        no-select
        hide-add-row
        :virtualFrom="0"
        class="leave-today-table leave-empty-sm"
        :fields="ctx.activeLeaveFields"
        :rows="ctx.activeLeaveRows"
        :editing-cell="ctx.editingCell"
        actionsHeader="操作"
        emptyText="当前无请假学生"
        emptyActionText="添加请假"
        @addNewRowAtBottom="ctx.openAddLeave()"
        @startEdit="ctx.startEdit"
        @saveCell="ctx.saveCell"
        @swapRows="(from, to) => ctx.saveRowOrder('active', from, to)"
        @swapColumns="(from, to) => ctx.saveColumnOrder('active', from, to)"
      >
        <template #cell-type="{ row, field, editing }">
          <AppSelect v-if="editing" v-model="row.类型" :aria-label="`${row.姓名 || '学生'}的类型`" :options="ctx.leaveTypeOptions" @change="ctx.saveCell(row, field)" class="w-full" />
          <span v-else @dblclick="ctx.startEdit(row, field)" class="px-2 py-0.5 rounded text-xs bg-danger/10 text-danger cursor-text">{{ row.类型 }}</span>
        </template>
        <template #cell-range="{ row }">
          <span class="whitespace-nowrap">{{ row._range }}</span>
        </template>
        <template #cell-dash="{ row, field, value, editing }">
          <input
            v-if="editing"
            v-model="row[field.name]"
            :aria-label="field.name"
            @blur="ctx.saveCell(row, field)"
            @keyup.enter="ctx.saveCell(row, field)"
            class="w-full h-6 leading-6 px-1 py-0 border border-transparent bg-warning/10 focus:outline-none focus:border-primary box-border"
          />
          <span v-else @dblclick="ctx.startEdit(row, field)" class="cursor-text">{{ value || '—' }}</span>
        </template>
        <template #row-actions="{ row }">
          <button @click="ctx.openEditLeave(row)" class="bg-info hover:bg-blue-700 text-text-inverse px-3 py-1 rounded text-xs mr-1 transition-theme">编辑</button>
          <button @click="ctx.returnLeave(row)" class="bg-success hover:bg-green-700 text-text-inverse px-3 py-1 rounded text-xs transition-theme">销假</button>
        </template>
      </DynamicTable>
    </div>

    <!-- 今日已返校 -->
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border font-bold text-text flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-success inline-block"></span> 今日已返校（{{ ctx.todayReturned.length }}人）
      </div>
      <DynamicTable
        fit-content
        no-select
        hide-add-row
        :virtualFrom="0"
        class="leave-today-table leave-empty-sm"
        :fields="ctx.returnedLeaveFields"
        :rows="ctx.returnedLeaveRows"
        :editing-cell="ctx.editingCell"
        actionsHeader="操作"
        emptyText="今日暂无返校记录"
        emptyActionText=""
        @startEdit="ctx.startEdit"
        @saveCell="ctx.saveCell"
        @swapRows="(from, to) => ctx.saveRowOrder('returned', from, to)"
        @swapColumns="(from, to) => ctx.saveColumnOrder('returned', from, to)"
      >
        <template #cell-range="{ row }">
          <span class="whitespace-nowrap">{{ row._range }}</span>
        </template>
        <template #cell-type-info="{ row, field, editing }">
          <AppSelect v-if="editing" v-model="row.类型" :aria-label="`${row.姓名 || '学生'}的类型`" :options="ctx.leaveTypeOptions" @change="ctx.saveCell(row, field)" class="w-full" />
          <span v-else @dblclick="ctx.startEdit(row, field)" class="px-2 py-0.5 rounded text-xs bg-info/10 text-info cursor-text">{{ row.类型 }}</span>
        </template>
        <template #cell-dash="{ row, field, value, editing }">
          <input
            v-if="editing"
            v-model="row[field.name]"
            :aria-label="field.name"
            @blur="ctx.saveCell(row, field)"
            @keyup.enter="ctx.saveCell(row, field)"
            class="w-full h-6 leading-6 px-1 py-0 border border-transparent bg-warning/10 focus:outline-none focus:border-primary box-border"
          />
          <span v-else @dblclick="ctx.startEdit(row, field)" class="cursor-text">{{ value || '—' }}</span>
        </template>
        <template #row-actions="{ row }">
          <button @click="ctx.openEditLeave(row)" class="bg-info hover:bg-blue-700 text-text-inverse px-3 py-1 rounded text-xs mr-1 transition-theme">编辑</button>
          <button @click="ctx.unreturnLeave(row)" class="bg-warning hover:bg-yellow-600 text-text-inverse px-3 py-1 rounded text-xs transition-theme">撤销销假</button>
        </template>
      </DynamicTable>
    </div>
  </div>
</template>

<script setup vapor>
import AppSelect from '../components/base/AppSelect.vue'
import DynamicTable from '../components/tables/DynamicTable/DynamicTable.vue'

defineOptions({ name: 'LeaveTodayTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref / 函数，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
