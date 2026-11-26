<template>
  <!-- 收据回收站：复刻「管理收据」的列表形态，只去掉上传区；删除动作换成恢复 -->
  <DialogShell :visible="visible && !docItem" :z-index="zIndex" @overlay="close">
    <div class="receipt-card bg-surface rounded-lg border border-border shadow-card dialog-card flex flex-col p-5">
      <div class="flex items-center justify-between mb-3 flex-shrink-0">
        <div class="flex items-center gap-1.5">
          <h3 class="text-lg font-bold text-text">{{ label }}</h3>
          <AppHelp
            :text="helpText"
            aria-label="回收站预览说明"
            :size="13"
          />
        </div>
        <button class="dlg-close" title="关闭" @click="close">✕</button>
      </div>

      <h4 class="text-sm font-semibold text-text mb-1.5 flex-shrink-0">{{ viewTitle }}</h4>
      <div class="rc-list app-custom-scroll flex-1 min-h-0 overflow-y-auto border border-border rounded-lg">
        <div v-if="loading" class="text-xs text-text-muted p-3">加载中…</div>
        <div v-else-if="error" class="text-xs text-danger p-3">{{ error }}</div>
        <div v-else-if="!items.length" class="text-xs text-text-muted p-3">暂无</div>
        <div
          v-for="(it, i) in items"
          v-else
          :key="it.key"
          class="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-hover transition-theme"
        >
          <span class="text-xs text-text-muted w-5 shrink-0 text-right">{{ i + 1 }}</span>
          <span class="flex-1 min-w-0 text-sm text-text truncate" :title="displayName(it.name)">{{ displayName(it.name) }}</span>
          <span class="text-xs text-text-muted shrink-0 w-14 text-right">{{ sizeText(it.bytes) }}</span>
          <button class="rc-btn shrink-0" @click="view(asFile(it))">{{ viewLabel(it) }}</button>
          <button class="rc-btn shrink-0" :disabled="downloading" @click="download(asFile(it))">下载</button>
          <button
            v-if="kind === 'receiptTrash'"
            class="rc-btn shrink-0"
            :disabled="busyRestore"
            @click="restore(it)"
          >{{ busyRestore ? '恢复中…' : '恢复' }}</button>
        </div>
      </div>

      <div class="flex items-center justify-between mt-3 flex-shrink-0">
        <span class="text-xs text-text-muted">{{ items.length ? `共 ${items.length} 个文件` : '暂无' }}</span>
        <button class="bg-info hover:bg-info-hover text-text-inverse border border-transparent px-4 py-1.5 rounded" @click="close">完成</button>
      </div>
    </div>
  </DialogShell>

  <!-- 图片/视频：与管理收据同一个 MediaViewer -->
  <MediaViewer
    v-if="mediaOpen"
    :visible="mediaOpen"
    :items="mediaItems"
    :index="mediaIndex"
    @update:index="mediaIndex = $event"
    @update:visible="onMediaVisible"
  >
    <template #toolbar="{ current }">
      <button class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme" @click="current && download(current.raw)">另存</button>
    </template>
  </MediaViewer>

  <!-- PDF / Markdown：同一个文档灯箱；回收站文件不在 uploads，只能走带鉴权的 blob URL -->
  <Teleport to="body">
    <Transition name="preview">
      <div v-if="docItem" ref="docViewerEl" class="fixed inset-0 z-[10002] flex flex-col album-viewer" role="dialog" aria-modal="true" aria-label="文档预览" tabindex="-1" @click.self="closeDoc">
        <div class="viewer-main flex-1 flex min-h-0">
          <div class="viewer-stage flex-1 min-w-0 relative">
            <button
              class="z-20 w-10 h-10 rounded-full viewer-btn viewer-close text-lg flex items-center justify-center transition-theme"
              title="关闭"
              @click="closeDoc"
            >✕</button>
            <div class="absolute inset-0 flex items-center justify-center p-6 overflow-hidden preview-media media-in">
              <div v-if="docItem.kind === 'pdf'" class="rc-pdf-sheet">
                <iframe :src="pdfSrc" :title="`PDF 预览：${docItem.name || ''}`"></iframe>
              </div>
              <div v-else class="rc-md-sheet app-custom-scroll">
                <p v-if="docLoading" class="text-sm text-text-muted m-0">正在读取…</p>
                <div v-else class="rc-md-body" v-html="docHtml"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup vapor>
// 收据回收站预览：列表形态与管理收据一致（无上传区），预览/下载仍走安全接口。
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import axios from 'axios'
import DialogShell from '../base/DialogShell.vue'
import AppHelp from '../base/AppHelp.vue'
import MediaViewer from '../base/MediaViewer.vue'
import { apiFetch } from '../../utils/apiUrl.js'
import { saveBlobWithDialog } from '../../utils/saveFile.js'
import { useNotification } from '../../composables/useNotification.js'
import { renderMarkdown } from '../../composables/ai/aiMarkdown.js'
import { createLatest } from '../../utils/latestOnly.js'
import { useModalFocus } from '../../composables/useModalFocus.js'
import { INVOKE } from '../../electronChannels.js'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'TrashPreviewDialog' })
const props = defineProps({
  visible: { type: Boolean, default: false },
  kind: { type: String, default: 'albumTrash' }, // albumTrash | receiptTrash
  zIndex: { type: Number, default: 10014 },
})
const emit = defineEmits(['close', 'changed'])
const { success: notifySuccess, error: notifyError, info: notifyInfo } = useNotification()

const items = ref([])
const loading = ref(false)
const error = ref('')
const downloading = ref(false)
const busyRestore = ref(false)
const mediaOpen = ref(false)
const mediaItems = ref([])
const mediaIndex = ref(0)
const docItem = ref(null)
const docHtml = ref('')
const docLoading = ref(false)
const docViewerEl = ref(null)
// 连点不同文件/关闭灯箱时，慢的旧响应不能盖掉新状态
const viewSeq = createLatest()
useModalFocus(() => !!docItem.value, docViewerEl, closeDoc)

const label = computed(() => props.kind === 'receiptTrash' ? '收据回收站' : '相册回收站')
const viewTitle = computed(() => props.kind === 'receiptTrash' ? '查看收据' : '查看照片')
const helpText = computed(() => props.kind === 'receiptTrash'
  ? '收据可点「恢复」搬回 uploads 目录并还原原名；若原位置已有同名文件会拒绝，避免覆盖。'
  : '相册回收站的图片可预览、可下载。归档名未保存原目录，这里不做恢复；要放回原位请用原有的 Ctrl+Z 撤销。')

// 关掉 Chromium 内置阅读器工具栏（与收据弹窗同款）
const PDF_VIEW_PARAMS = '#toolbar=0&navpanes=0&scrollbar=0&view=FitH'
const pdfSrc = computed(() => {
  if (!docItem.value || docItem.value.kind !== 'pdf') return ''
  const u = docItem.value.src || ''
  return u.includes('#') ? u : u + PDF_VIEW_PARAMS
})

// 归档名带 {timestamp}-{random}- 前缀，列表里显示原名；接口定位仍用 key。
const displayName = (n) => props.kind === 'receiptTrash'
  ? String(n || '').replace(/^\d+-\d+-/, '')
  : String(n || '')
function kindOfName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video'
  if (ext === 'md' || ext === 'txt') return 'text'
  return 'office'
}
function asFile(it) {
  const name = displayName(it.name)
  return { ...it, name, kind: kindOfName(name) }
}
// 与管理收据同款三档：能内嵌的就内嵌；Office 交给系统程序；未知类型才提示下载。
// 相册回收站没有本地打开通道，仍只给内嵌/下载两档。
function viewMode(f) {
  if (['image', 'video', 'pdf', 'text'].includes(f.kind)) return 'inline'
  if (props.kind === 'receiptTrash' && ['office', 'ooxml', 'ole'].includes(f.kind)) return 'external'
  return 'none'
}
function viewLabel(it) {
  const m = viewMode(asFile(it))
  return m === 'inline' ? '直接预览' : m === 'external' ? '本地查看' : '无法预览'
}
function sizeText(size) {
  const n = Number(size) || 0
  if (!n) return ''
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  return Math.round(n / 1024) + 'KB'
}

// 回收站文件不在 uploads：<img>/<iframe> 不能拼静态地址，统一取带鉴权的 blob URL。
function fileUrl(item) {
  const qs = new URLSearchParams({ kind: props.kind, key: item.key })
  return '/api/retention/trash-file?' + qs.toString()
}
async function fetchFile(item) {
  const res = await apiFetch(fileUrl(item))
  if (!res.ok) throw new Error('读取失败：' + res.status)
  return res
}

let viewerUrl = ''
let docUrl = ''
function revokeViewer() {
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = '' }
}
function revokeDoc() {
  if (docUrl) { URL.revokeObjectURL(docUrl); docUrl = '' }
}
function revoke() { revokeViewer(); revokeDoc() }
function closeDoc() {
  viewSeq.invalidate()
  revokeDoc()
  docItem.value = null
  docHtml.value = ''
  docLoading.value = false
}
function onMediaVisible(v) {
  if (!v) { mediaOpen.value = false; revokeViewer() }
}

async function load() {
  loading.value = true
  error.value = ''
  revoke()
  mediaOpen.value = false
  mediaItems.value = []
  closeDoc()
  try {
    const { data } = await axios.get('/api/retention/list', { params: { kind: props.kind, limit: 200 } })
    items.value = (data && data.items) || []
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function view(f) {
  const mode = viewMode(f)
  if (mode === 'none') {
    notifyError('无法查看，建议下载后本地查看')
    return
  }
  if (mode === 'external') { void openExternal(f); return }
  const my = viewSeq.begin()
  try {
    if (f.kind === 'text') {
      await openMarkdown(f, my)
      return
    }
    const res = await fetchFile(f)
    const blob = await res.blob()
    if (!viewSeq.isCurrent(my)) return
    if (f.kind === 'pdf') {
      revokeDoc()
      docUrl = URL.createObjectURL(blob)
      docItem.value = { kind: 'pdf', name: f.name, src: docUrl }
      return
    }
    revokeViewer()
    viewerUrl = URL.createObjectURL(blob)
    mediaItems.value = [{ src: viewerUrl, name: f.name, isVideo: f.kind === 'video', raw: f }]
    mediaIndex.value = 0
    mediaOpen.value = true
  } catch (e) {
    if (viewSeq.isCurrent(my)) notifyError('无法预览：' + (e.message || '未知错误'))
  }
}

async function openMarkdown(f, my) {
  docLoading.value = true
  docItem.value = { kind: 'text', name: f.name }
  docHtml.value = ''
  try {
    const res = await fetchFile(f)
    const html = await renderMarkdown(await res.text())
    if (!viewSeq.isCurrent(my)) return
    docHtml.value = html
  } catch (e) {
    if (!viewSeq.isCurrent(my)) return
    closeDoc()
    notifyError('无法读取该文件：' + (e.message || '未知错误'))
  } finally {
    if (viewSeq.isCurrent(my)) docLoading.value = false
  }
}

/** 收据里的 Office 走系统默认程序：复用上传文件那条受限通道，area 指定回收站根目录 */
async function openExternal(f) {
  notifyInfo('正在启动本地应用查看…')
  try {
    const res = await window.electron.invoke(INVOKE.OPEN_UPLOAD_FILE, {
      relPath: f.key,
      area: props.kind,
    })
    if (res && res.outcome === 'fail') notifyError(res.error || '无法打开该文件')
  } catch (e) {
    notifyError(e.message || '无法打开该文件')
  }
}

async function download(f) {
  if (downloading.value) return
  downloading.value = true
  try {
    const res = await fetchFile(f)
    const saved = await saveBlobWithDialog(f.name || '文件', await res.blob())
    // 空串 = 用户在保存对话框点了取消，不打扰
    if (saved) notifySuccess('已保存')
  } catch (e) {
    notifyError('下载失败：' + (e.message || '未知错误'))
  } finally {
    downloading.value = false
  }
}

async function restore(it) {
  if (busyRestore.value) return
  busyRestore.value = true
  try {
    const { data } = await axios.post('/api/retention/restore-receipt', { key: it.key })
    if (!data || !data.ok) throw new Error((data && data.error) || '恢复失败')
    notifySuccess(`已恢复：${data.name}`)
    await load()
    emit('changed')
  } catch (e) {
    notifyError('恢复失败：' + (e.response?.data?.error || e.message))
  } finally {
    busyRestore.value = false
  }
}

function close() { emit('close') }

// 宿主用 v-if + :visible="true" 控制显隐：首次挂载 visible 已是 true，
// 普通 watch 不触发 → 明明有文件却显示空列表。
watch(() => props.visible, v => { if (v) load(); else { revoke(); mediaOpen.value = false; closeDoc() } }, { immediate: true })
onBeforeUnmount(revoke)
</script>

<style scoped>
/* 与 ReceiptDialog 同款尺寸/按钮/列表，差异只在少了上传区 */
.receipt-card {
  width: 720px;
  max-width: 92vw;
  max-height: 86vh;
}
.rc-list {
  max-height: 296px;
}
.rc-btn {
  font-size: 13px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.rc-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.rc-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rc-pdf-sheet,
.rc-md-sheet {
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.rc-pdf-sheet {
  width: min(900px, 100%);
  height: 100%;
  overflow: hidden;
}
.rc-pdf-sheet iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.rc-md-sheet {
  width: min(760px, 100%);
  max-height: 100%;
  padding: 32px 36px;
  overflow-y: auto;
  color: #1f2937;
}
.rc-md-body {
  font-size: 14px;
  line-height: 1.75;
}
.rc-md-body :deep(h1) { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
.rc-md-body :deep(h2) { font-size: 18px; font-weight: 700; margin: 20px 0 10px; }
.rc-md-body :deep(h3) { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
.rc-md-body :deep(p) { margin: 0 0 10px; }
.rc-md-body :deep(ul),
.rc-md-body :deep(ol) { margin: 0 0 10px; padding-left: 22px; list-style: revert; }
.rc-md-body :deep(li) { margin: 2px 0; }
.rc-md-body :deep(a) { color: var(--color-primary); text-decoration: underline; }
.rc-md-body :deep(code) { background: rgba(0, 0, 0, 0.06); padding: 1px 4px; border-radius: 4px; font-size: 13px; }
.rc-md-body :deep(pre) { background: rgba(0, 0, 0, 0.05); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.rc-md-body :deep(blockquote) { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid #d1d5db; color: #4b5563; }
.rc-md-body :deep(th),
.rc-md-body :deep(td) { border: 1px solid #d1d5db; padding: 6px 10px; }
.rc-md-body :deep(table) { border-collapse: collapse; margin: 0 0 10px; }
.rc-md-body :deep(img) { max-width: 100%; }
.rc-md-body :deep(p:last-child),
.rc-md-body :deep(ul:last-child),
.rc-md-body :deep(ol:last-child) { margin-bottom: 0; }
</style>
