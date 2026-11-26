<template>
  <div>
    <!-- 数据看板 -->
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-success/10 rounded-xl border border-border p-4">
        <div class="flex items-center gap-1.5 text-sm text-text-secondary">
          <span class="w-2 h-2 rounded-full bg-success inline-block"></span> {{ ctx.addPeopleLabel }}
        </div>
        <div class="text-2xl font-bold text-success">{{ ctx.todayAddPeople }} 人</div>
      </div>
      <div class="bg-info/10 rounded-xl border border-border p-4">
        <div class="flex items-center gap-1.5 text-sm text-text-secondary">
          <span class="w-2 h-2 rounded-full bg-info inline-block"></span> 加分项目
        </div>
        <div class="text-2xl font-bold text-info">{{ ctx.todayAddItems }} 项</div>
      </div>
      <div class="bg-warning/10 rounded-xl border border-border p-4">
        <div class="flex items-center gap-1.5 text-sm text-text-secondary">
          <span class="w-2 h-2 rounded-full bg-warning inline-block"></span> {{ ctx.subPeopleLabel }}
        </div>
        <div class="text-2xl font-bold text-warning">{{ ctx.todaySubPeople }} 人</div>
      </div>
      <div class="bg-danger/10 rounded-xl border border-border p-4">
        <div class="flex items-center gap-1.5 text-sm text-text-secondary">
          <span class="w-2 h-2 rounded-full bg-danger inline-block"></span> 扣分项目
        </div>
        <div class="text-2xl font-bold text-danger">{{ ctx.todaySubItems }} 项</div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @mouseenter="ctx.prefetch(ctx.loadAddScoreDialog)" @click="ctx.openAdd()" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">＋ 添加{{ ctx.isGroup ? '小组' : '个人' }}加分</button>
      <button @click="ctx.refresh()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1 btn-refresh transition-theme"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
      <button @click="ctx.importDialogVisible = true" @mouseenter="ctx.prefetch(ctx.loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从表格批量导入
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1 transition-theme"><IconGlyph name="download" :size="14" tint="current" /> 导出{{ ctx.isGroup ? '小组' : '个人' }}加分</button>
    </div>

    <!-- 今日时间轴 -->
    <LeaveTimeline
      :nodes="ctx.timelineNodes"
      :node-types="ctx.timelineNodeTypes"
      :type-options="['加分', '扣分']"
      :title="ctx.isGroup ? '今日小组加减分时间轴' : '今日个人加减分时间轴'"
      :empty-text="ctx.isGroup ? '今天还没有小组加分' : '今天还没有人加分'"
      empty-action-text="去加分"
      empty-secondary-action-text="从表格批量导入"
      :loading="ctx.loading"
      align-right
      @empty-action="ctx.openAdd()"
      @empty-secondary-action="ctx.openImportDialog()"
    >
      <template #content="{ node }">
        <div class="text-sm text-text">
          <span class="font-medium">{{ node.person }}</span>
          <span class="text-text-secondary"> 因为 </span>
          <span>{{ node.reason }}</span>
          <span class="font-bold ml-1" :class="node.isSub ? 'text-danger' : 'text-success'">{{ node.sign }}</span>
        </div>
      </template>
      <template #ops="{ node }">
        <div class="flex items-center gap-1.5">
          <button @click="ctx.openEdit(ctx.recordByKey(node.key))" class="bg-info hover:bg-blue-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">编辑</button>
          <button @click="ctx.askDelete(ctx.recordByKey(node.key))" class="bg-danger hover:bg-red-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">删除</button>
        </div>
      </template>
    </LeaveTimeline>
  </div>
</template>

<script setup vapor>
import LeaveTimeline from '../components/base/LeaveTimeline.vue'

defineOptions({ name: 'ScoreTodayTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
