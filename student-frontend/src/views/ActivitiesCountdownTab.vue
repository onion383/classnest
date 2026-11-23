<template>
  <div>
    <!-- 数据看板（最近 3 个） -->
    <div v-if="ctx.topCountdowns.length" class="grid grid-cols-3 gap-4 mb-6">
      <div v-for="cd in ctx.topCountdowns" :key="cd.id" class="bg-surface shadow-md rounded-xl border border-border p-4 text-center" :class="{ 'opacity-70': cd.days < 0 }">
        <div class="text-sm text-text-secondary truncate">距离 {{ cd.名称 }}</div>
        <div class="text-4xl font-bold mt-1" :class="cd.days >= 0 ? 'text-info' : 'text-text-muted'">{{ Math.abs(cd.days) }}</div>
        <div class="text-sm text-text-secondary">{{ cd.days >= 0 ? '还有 ' + cd.days + ' 天' : '天（已过去）' }}</div>
        <div class="text-xs text-text-muted mt-1">截止 {{ cd.截止日 }}</div>
      </div>
    </div>
    <EmptySnapshot
      v-else
      class="mb-6"
      icon="timer"
      icon-size="32"
      text="还没有倒计时"
      min-height="160px"
      action-text="创建一个倒计时"
      action-icon="plus"
      @action="ctx.openAddCountdown()"
    />

    <!-- 工具栏 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @mouseenter="ctx.prefetch(ctx.loadAddCountdownDialog)" @click="ctx.openAddCountdown()" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">＋ 添加倒计时</button>
      <button @click="ctx.refreshCountdowns()" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1 btn-refresh transition-theme"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
      <button @click="ctx.importDialogVisible = true" @mouseenter="ctx.prefetch(ctx.loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从表格批量导入
      </button>
      <button @mouseenter="ctx.prefetch(ctx.loadExportExcel)" @click="ctx.openCountdownExport()" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1 transition-theme"><IconGlyph name="download" :size="14" tint="current" /> 导出 EXCEL 表格</button>
    </div>

    <!-- 倒计时时间轴 -->
    <LeaveTimeline
      :nodes="ctx.countdownTimelineNodes"
      :node-types="ctx.countdownNodeTypes"
      :title="'倒计时列表'"
      :max-height="640"
      :search-extras="ctx.countdownSearchText"
      align-right
    >
      <template #content="{ node }">
        <div class="text-sm text-text">
          <span class="font-medium">{{ node.name }}</span>
          <span class="text-text-muted text-xs ml-2">截止日 {{ node.deadline }}</span>
          <span class="ml-1" :class="node.days >= 0 ? 'text-info' : 'text-danger'">
            {{ node.days >= 0 ? `距离该事件还有 ${node.days} 天` : `已经过去了 ${Math.abs(node.days)} 天` }}
          </span>
        </div>
      </template>
      <template #ops="{ node }">
        <div class="flex items-center gap-1.5">
          <button @click="ctx.openEditCountdown(ctx.countdownByKey(node.key))" class="bg-info hover:bg-blue-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">编辑</button>
          <button @click="ctx.askDeleteCountdown(ctx.countdownByKey(node.key))" class="bg-danger hover:bg-red-700 text-text-inverse px-2.5 py-0.5 rounded text-xs transition-theme">删除</button>
        </div>
      </template>
    </LeaveTimeline>
  </div>
</template>

<script setup vapor>
import LeaveTimeline from '../components/base/LeaveTimeline.vue'
import EmptySnapshot from '../components/base/EmptySnapshot.vue'

defineOptions({ name: 'ActivitiesCountdownTab' })

// 父组件传入的 reactive ctx：字段都是父级 ref / 函数，模板读写 ctx.xxx 回落到原 ref
const props = defineProps({ ctx: { type: Object, required: true } })
const ctx = props.ctx
</script>
