<template>
  <!-- MCP 数据权限弹窗：总开关 + 三个混淆项 + 每张表的权限档。
       读写走 usePrivacyConfig('mcp')——与 AI 助手那份（privacy_json）是两份独立配置，
       乐观更新 / 回滚 / 序号守卫仍是同一套实现，这里只负责排版，不自己发请求。 -->
  <DialogShell :visible="visible" :z-index="10070" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg border border-border shadow-lg p-5 flex flex-col mcp-dialog">
      <div class="flex items-center justify-between gap-3 mb-1 flex-shrink-0">
        <div class="flex items-center gap-1.5">
          <h3 class="text-lg font-bold text-text">MCP 数据权限</h3>
          <AppHelp aria-label="数据权限说明" :z-index="10075" :text="permHelp" />
        </div>
        <button class="dlg-close" title="关闭" @click="close">✕</button>
      </div>
      <p class="text-xs text-text-muted leading-relaxed mb-4 flex-shrink-0">
        只作用于外部客户端。AI 助手那边的「数据保护」是另一份，两处互不影响。
      </p>

      <div class="flex-1 min-h-0 overflow-y-auto app-custom-scroll space-y-5 pr-1">
        <!-- 总开关：只作用于 MCP 这一侧。放在这里而不是让它跟着 AI 助手走，
             是因为「给外部客户端关掉脱敏」和「给老师自己的助手关掉」是两件事。 -->
        <div class="flex items-center justify-between gap-4">
          <h4 class="text-sm font-medium text-text flex items-center gap-1.5">
            <span>数据保护总开关</span>
            <AppHelp aria-label="MCP 数据保护的作用" :z-index="10075" :text="switchHelp" />
          </h4>
          <AppSwitch :model-value="cfg.enabled" @update:model-value="onToggle('enabled', $event)" />
        </div>
        <PrivacyToggles :values="cfg" :master-off="!cfg.enabled" @change="onToggle" />
        <TableScopeList :tables="cfg.tables" title="按表权限" @level="onLevel" />
        <p v-if="error" class="text-sm text-danger">{{ error }}</p>
      </div>

      <p class="text-xs text-text-muted mt-3 leading-relaxed flex-shrink-0">
        改动即时保存。「关闭」的表外部客户端完全看不到；「只读」可查不可改；「读写」的写入仍会先生成提案，等你确认后才落库。
      </p>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { watch } from 'vue'
import { usePrivacyConfig } from '../../composables/usePrivacyConfig.js'
import DialogShell from '../base/DialogShell.vue'
import AppHelp from '../base/AppHelp.vue'
import AppSwitch from '../base/AppSwitch.vue'
import PrivacyToggles from './PrivacyToggles.vue'
import TableScopeList from './TableScopeList.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'changed'])

const { cfg, error, load, update, setLevel } = usePrivacyConfig('mcp')

const permHelp = [
  '外部客户端能读、能写哪些表，逐表一档。',
  '「读写」不是直接写：外部 AI 的每次修改都会先落成提案，等你在这里确认后才执行。',
  '这份配置只作用于外部客户端；AI 助手那边的「数据保护」是另一份，互不影响。',
].join('\n')

const switchHelp = [
  '开启后，发给外部 AI 的学生姓名与电话换成代号，它写回时自动还原成真名。',
  '只保护已入库的值：外部 AI 自己带进来的新名字、新号码原样透传。',
  '与 AI 助手的「数据保护」互不影响：那边关着，这边也可以单独开。',
].join('\n')

// 每次打开重拉：可能在 AI 助手那边改过，别拿旧配置糊弄。
watch(() => props.visible, (v) => {
  if (v) load().catch(() => {})
}, { immediate: true })

function close() { emit('close') }

// 先写后通知面板刷新摘要（摘要里的「混淆 x/3 · 可写 n 张」跟着变）
function onToggle(key, value) { update(key, value); emit('changed') }
function onLevel(table, level) { setLevel(table, level); emit('changed') }
</script>

<style scoped>
.mcp-dialog { width: min(38rem, 92vw); max-height: min(80vh, 680px); }
</style>
