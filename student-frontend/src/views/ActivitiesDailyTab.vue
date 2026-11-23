<template>
  <div>
    <!-- 工具栏 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @mouseenter="ctx.prefetch(ctx.loadAddActivityDialog)" @click="ctx.openAddActivity()" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">＋ 新增活动</button>
      <button @click="ctx.refreshActivities()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1 btn-refresh transition-theme"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
      <button @click="ctx.importDialogVisible = true" @mouseenter="ctx.prefetch(ctx.loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从表格批量导入
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openActivityExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1 transition-theme"><IconGlyph name="download" :size="14" tint="current" /> 导出活动</button>
    </div>

    <!-- 活动时间轴（带状态标签） -->
    <LeaveTimeline
      :nodes="ctx.activityTimelineNodes"
      :node-types="ctx.activityNodeTypes"
      :title="'活动时间轴'"
      :max-height="640"
      align-right
    >
      <template #content="{ node }">
        <div class="text-sm text-text">
          <span class="font-medium">{{ node.subject }}</span>
          <span v-if="node.location" class="text-text-secondary"> · {{ node.location }}</span>
          <span v-if="node.participants" class="text-text-secondary text-xs ml-1 inline-flex items-center">· <IconGlyph name="users" :size="13" tint="current" /> {{ node.participants }}</span>
        </div>
      </template>
      <template #ops="{ node }">
        <div class="flex items-center gap-1.5">
          <button @click="ctx.openEditActivity(ctx.activityByKey(node.key))" class="bg-info hover:bg-blue-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">编辑</button>
          <button @click="ctx.goAlbum()" class="bg-surface-hover hover:bg-border text-text-secondary px-2.5 py-0.5 rounded text-xs border border-border transition-theme">查看相册</button>
          <button @click="ctx.askDeleteActivity(ctx.activityByKey(node.key))" class="bg-danger hover:bg-red-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">删除</button>
        </div>
      </template>
    </LeaveTimeline>
  </div>
</template>

<script setup vapor>
import LeaveTimeline from '../components/base/LeaveTimeline.vue'

defineOptions({ name: 'ActivitiesDailyTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref / 函数，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
