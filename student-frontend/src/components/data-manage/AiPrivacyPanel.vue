<template>
  <div class="ai-privacy-panel space-y-5">
    <!-- 总开关：作用说明与两条能力边界收进 ⓘ，界面上只留一行标题，不占版面 -->
    <div class="flex items-center justify-between gap-4">
      <h4 class="text-sm font-medium text-text flex items-center gap-1.5">
        <span>数据保护总开关</span>
        <AppHelp aria-label="数据保护的作用与边界" :z-index="10007" :text="switchHelp" />
      </h4>
      <AppSwitch :model-value="cfg.enabled" @update:model-value="(v) => update('enabled', v)" />
    </div>

    <!-- 总开关关掉时下面照常显示，不整块收起来（收起后每次都要重新开开关才看得到自己的设置）。
         表权限与总开关无关（aiReadScope 的判据：用户显式关掉的表，无论混淆开没开都不许 AI 读），
         所以那一块始终可改；只有三个混淆项在总开关关闭时暂不生效，就地标一句。 -->
    <div class="border-t border-border pt-4 space-y-5">
      <PrivacyToggles :values="cfg" :master-off="!cfg.enabled" @change="update" />
      <TableScopeList :tables="cfg.tables" @level="setLevel" />
    </div>

    <!-- 访问记录：权限决定「允许读什么」，这里回答「到底读了什么」。
         只放 AI 一侧（MCP 的记录在「MCP 服务管理」第 4 行），写操作在「设置 → 更改审查」。
         行尾必须带摘要：被拒次数是这一块的重点，逼用户点进去才知道等于没做。 -->
    <div class="border-t border-border pt-4 flex items-center justify-between gap-4">
      <div class="min-w-0">
        <span class="block text-sm font-medium text-text">AI 访问记录</span>
        <span v-if="logSummaryText" class="block text-xs mt-0.5 truncate" :class="logSummary.denied ? 'text-warning' : 'text-text-muted'">{{ logSummaryText }}</span>
      </div>
      <button
        type="button"
        class="flex items-center gap-1 flex-shrink-0 bg-bg hover:bg-surface-hover text-text border border-border px-3 py-1.5 rounded text-sm transition-theme whitespace-nowrap"
        @click="logOpen = true"
      >查看<span class="text-text-muted">›</span></button>
    </div>

    <p v-if="error" class="text-sm text-danger">{{ error }}</p>

    <AccessLogDialog :visible="logOpen" source="ai" @close="logOpen = false" @changed="loadLogSummary" />
  </div>
</template>

<script setup vapor>
// 本文件只负责「AI 助手页那份面板」的排版与总开关：
//   读写 / 回滚 / 序号守卫 → composables/usePrivacyConfig.js
//   三个混淆勾选           → components/data-manage/PrivacyToggles.vue
//   按表三档权限           → components/data-manage/TableScopeList.vue
// 设置页的 MCP 面板用的是同样这三个，避免两份判定各改一半。
import { computed, onMounted, ref } from 'vue'
import AppSwitch from '../base/AppSwitch.vue'
import AppHelp from '../base/AppHelp.vue'
import PrivacyToggles from './PrivacyToggles.vue'
import TableScopeList from './TableScopeList.vue'
import AccessLogDialog from './AccessLogDialog.vue'
import { usePrivacyConfig } from '../../composables/usePrivacyConfig.js'
import { useAccessLog } from '../../composables/useAccessLog.js'

const { cfg, error, load, update, setLevel } = usePrivacyConfig()

// 只有摘要：面板刚渲染时拉一次（limit=1，不把记录列表拖回来），打开弹窗才全量拉
const { summary: logSummary, loadSummary: loadLogSummary } = useAccessLog('ai')
const logOpen = ref(false)

const logSummaryText = computed(() => {
  const s = logSummary.value
  // 只报事实，不加「近 7 天」这类前缀（统计窗口写在 ⓘ 里）；
  // 一条都没有时整句不出现 —— 「最近七天暂无记录」占一行却什么都没说。
  const parts = []
  if (s.total) parts.push(`${s.total} 次读取`)
  if (s.writes) parts.push(`${s.writes} 次写入`)
  if (s.denied) parts.push(`${s.denied} 次被拒`)
  if (s.failed) parts.push(`${s.failed} 次失败`)
  return parts.join(' · ')
})

// ⓘ 里的长说明：这些是「看一次就够」的边界，常驻会把面板撑得很长
const switchHelp = [
  '发给第三方模型时，学生姓名与电话换成代号；模型写回时自动还原成真名 —— 你看到的、导出的、库里存的仍然是真名。',
  '默认关闭，开启会改变发给模型的内容，需你显式选择。',
  '• 只保护已入库的值：本轮新贴进来的截图 / 文档里的新名字、新号码原样透传。',
  '• 图片和自由文本管不住：识别后的文字里若含隐私，建议把对应表设为「完全禁止」。',
].join('\n')

onMounted(() => {
  load().catch(() => {})
  loadLogSummary()
})
</script>
