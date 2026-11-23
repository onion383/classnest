<template>
  <!-- 标题栏胶囊点开后的通知中心：常驻的只是一个胶囊，详情按需弹出。
       Teleport 挂在 body 上，避免被标题栏的 overflow / app-region 裁掉。 -->
  <Teleport to="body">
    <Transition name="dialog" appear>
      <div v-if="visible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]" @click.self="close">
        <div class="bg-surface rounded-lg border border-border shadow-card dialog-card flex flex-col p-5 relative todo-card">
          <div class="flex items-center justify-between mb-3 flex-shrink-0">
            <h3 class="text-lg font-bold">通知事项</h3>
            <button class="dlg-close" title="关闭" @click="close">✕</button>
          </div>

          <div v-if="!items.length" class="text-sm text-text-muted py-8 text-center">暂时没有待处理事项</div>

          <!-- 每条一张玻璃卡：bg-surface/55 + backdrop-blur-md 走 --color-surface，
               夜间模式自动变深色（AI 面板那套白色玻璃在夜间会变成一块白板）。
               原来是靠下边框分隔，套了卡片后改由卡片间隙分隔。 -->
          <div v-else class="flex-1 min-h-0 overflow-y-auto app-custom-scroll">
            <div
              v-for="it in items"
              :key="it.key"
              class="rounded-lg border border-border bg-surface/55 backdrop-blur-md px-3 py-2.5 mb-2 last:mb-0"
            >
              <div class="flex items-center justify-between gap-3">
                <h4 class="text-sm font-medium text-text">{{ it.title }}</h4>
                <button class="btn-plain todo-action" @click="go(it.key)">去处理</button>
              </div>
              <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
                有 {{ it.count }} 位同学需要{{ it.key === 'overdue' ? '销假' : '处理' }}，分别是 {{ it.names.join('、') }}
              </p>
              <p v-if="it.key === 'provisional'" class="text-xs text-text-muted mt-1">
                这些名字是在座位 / 值日 / 分组 / 加减分里直接填写、名册中没有的人，系统自动建的档。
              </p>
            </div>
          </div>

          <div class="flex justify-end mt-4 flex-shrink-0">
            <button class="btn-plain todo-action" @click="close">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
defineProps({
  visible: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'go'])
function close() { emit('close') }
function go(key) { emit('go', key) }
</script>

<style scoped>
.todo-card { width: min(520px, 92vw); max-height: min(70vh, 520px); }
.todo-action { padding: 5px 12px; font-size: 12px; color: var(--color-text); cursor: pointer; }
</style>
