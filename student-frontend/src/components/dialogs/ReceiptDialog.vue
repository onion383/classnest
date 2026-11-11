<template>
  <!-- 收据管理：上传 + 列表 + 预览 + 下载 + 删除 -->
  <Teleport to="body">
    <Transition name="dialog" appear>
      <div
        v-if="visible"
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]"
        @click.self="close"
      >
        <div class="receipt-card bg-surface rounded-lg border border-border shadow-card dialog-card flex flex-col p-5">
          <div class="flex items-center justify-between mb-3 flex-shrink-0">
            <h3 class="text-lg font-bold">管理收据</h3>
            <button class="rc-close" title="关闭" @click="close">✕</button>
          </div>

          <!-- 增加收据：与「从文件导入数据」同一个虚线框（样式在 styles/utilities.css 的 .dropzone） -->
          <h4 class="text-sm font-semibold text-text mb-1.5 flex-shrink-0">增加收据</h4>
          <p class="text-xs text-text-muted mb-2 flex-shrink-0">支持 图片 / PDF / Word / Excel / PPT / 视频，可多选，也可直接拖入</p>
          <div
            class="dropzone flex items-center justify-center h-36 cursor-pointer select-none border-2 border-dashed rounded-xl flex-shrink-0"
            :class="{ 'dropzone-active': dragOver }"
            @click="pickFiles"
            @dragover.prevent
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
          >
            <span class="text-base text-inverse">
              {{ uploading ? `正在上传 ${uploadDone}/${uploadTotal}…` : '点击选择文件，或将文件拖到此处' }}
            </span>
          </div>
          <input ref="fileInput" type="file" multiple :accept="ACCEPT" class="hidden" @change="onPick" />

          <!-- 查看收据：没有文件时标题和列表整块不渲染，不摆空态占位 -->
          <template v-if="localItems.length">
            <h4 class="text-sm font-semibold text-text mt-4 mb-2 flex-shrink-0">查看收据</h4>
            <div class="rc-list app-custom-scroll flex-1 min-h-0 overflow-y-auto border border-border rounded-lg">
              <div
                v-for="(f, i) in localItems"
                :key="f.path"
                class="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-hover transition-theme"
              >
                <span class="text-xs text-text-muted w-5 shrink-0 text-right">{{ i + 1 }}</span>
                <span class="flex-1 min-w-0 text-sm text-text truncate" :title="f.name">{{ f.name }}</span>
                <span class="text-xs text-text-muted shrink-0 w-14 text-right">{{ sizeText(f.size) }}</span>
                <button class="rc-btn shrink-0" @click="view(f)">{{ viewLabel(f) }}</button>
                <button class="rc-btn shrink-0" :disabled="downloading" @click="download(f)">下载</button>
                <button class="rc-btn rc-btn--danger shrink-0" @click="remove(i)">删除</button>
              </div>
            </div>
          </template>

          <div class="flex items-center justify-between mt-3 flex-shrink-0">
            <span class="text-xs text-text-muted">{{ localItems.length ? `共 ${localItems.length} 个文件` : '' }}</span>
            <button class="bg-info hover:bg-info-hover text-text-inverse border border-transparent px-4 py-1.5 rounded" @click="close">
              完成
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 图片 / 视频：直接用相册那套查看器（同一份样式，见 styles/media-viewer.css） -->
  <MediaViewer
    v-if="mediaOpen"
    :visible="mediaOpen"
    :items="mediaItems"
    :index="mediaIndex"
    @update:index="mediaIndex = $event"
    @update:visible="mediaOpen = false"
  >
    <template #toolbar="{ current }">
      <button class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme" @click="current && download(current.raw)">另存</button>
    </template>
  </MediaViewer>

  <!-- 文档预览（PDF / Markdown）：同一个灯箱外壳 —— 与图片/视频那套共用 .album-viewer，
       配色随主题走，关闭键在右上角。只有内容区按类型切换：
       · PDF 交给 Chromium 原生阅读器（不引 pdf.js，省几十 MB），并靠 #toolbar=0
         关掉原生那套深色工具栏（它是浏览器自己的皮肤，不跟主题，按钮还会盖住关闭键）；
       · Markdown 用 AI 助手那套 marked + DOMPurify 渲染（懒加载，已 sanitize）。 -->
  <Teleport to="body">
    <Transition name="preview">
      <div v-if="docItem" class="fixed inset-0 z-[10002] flex flex-col album-viewer" @click.self="closeDoc">
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
        <div class="flex items-center justify-center gap-3 p-4 flex-wrap viewer-bar">
          <span class="viewer-fg text-xs truncate max-w-[360px]">{{ docItem.name }}</span>
          <button class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme" @click="download(docItem)">另存</button>
          <button class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme" @click="openExternal(docItem)">用系统应用打开</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import axios from 'axios'
import MediaViewer from '../base/MediaViewer.vue'
import { resourceUrl } from '../../utils/apiUrl'
import { saveBlobWithDialog } from '../../utils/saveFile'
import { useNotification } from '../../composables/useNotification'
import { renderMarkdown } from '../../composables/ai/aiMarkdown.js'
import { INVOKE } from '../../electronChannels.js'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'ReceiptDialog' })

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 已归一化的收据数组：[{ path, name, size, kind }]
  receipts: { type: Array, default: () => [] },
  apiBase: { type: String, default: '/api' },
})
const emit = defineEmits(['update:visible', 'change'])

const { success: notifySuccess, error: notifyError, info: notifyInfo } = useNotification()

// 与后端 services/uploadSignatures.js 的 KINDS 保持一致
const ACCEPT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp4', '.webm', '.md',
].join(',')

const fileInput = ref(null)
const localItems = ref([])
// 本次被删掉的路径：只在点「确定」时才交给后端移进回收站，
// 取消就当作没删过（否则用户点开看一眼、随手点删、再取消，磁盘上的文件就没了）
const removedPaths = ref([])
const dragOver = ref(false)
const uploading = ref(false)
const uploadDone = ref(0)
const uploadTotal = ref(0)
const downloading = ref(false)
// 图片/视频走 MediaViewer（相册同款）；PDF / Markdown 共用下面那个文档灯箱
const mediaOpen = ref(false)
const mediaIndex = ref(0)
const docItem = ref(null)         // { kind: 'pdf' | 'text', name, path }
const docHtml = ref('')
const docLoading = ref(false)

// 关掉 Chromium 内置阅读器的工具栏与侧栏：
// · 那套 UI 是深色固定皮肤，跟应用主题无关（毛玻璃/浅色主题下尤其突兀）；
// · 它的按钮浮在内容上方，会和我们的关闭键叠在一起，看起来像「关闭键跑到左上角」。
// 代价是没有原生缩放/翻页按钮 —— 收据基本是单页扫描件，滚轮够用，
// 真要完整功能走底栏的「用系统应用打开」。
const PDF_VIEW_PARAMS = '#toolbar=0&navpanes=0&scrollbar=0&view=FitH'
const pdfSrc = computed(() => {
  if (!docItem.value || docItem.value.kind !== 'pdf') return ''
  const u = resourceUrl(docItem.value.path)
  return u.includes('#') ? u : u + PDF_VIEW_PARAMS
})

// 可进媒体查看器的项。Office 文档不在内（不支持内嵌预览）
const mediaItems = computed(() => localItems.value
  .filter((f) => f.kind === 'image' || f.kind === 'video')
  .map((f) => ({ src: resourceUrl(f.path), name: f.name, isVideo: f.kind === 'video', raw: f })))

// 每次打开都从父组件拉一份新副本，避免上次的编辑态残留
watch(() => props.visible, (v) => {
  if (!v) { mediaOpen.value = false; closeDoc(); return }
  localItems.value = (props.receipts || []).map((r) => ({ ...r, kind: r.kind || kindOfPath(r.path) }))
  removedPaths.value = []
  dragOver.value = false
})

function close() { emit('update:visible', false) }

function kindOfPath(path) {
  const ext = String(path || '').split('.').pop().toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['mp4', 'webm'].includes(ext)) return 'video'
  if (ext === 'md') return 'text'
  return 'office'
}

// 「查看」按钮的文案要说清点击后会发生什么，三档：
// · 直接预览 —— 在应用内就能看（图片 / 视频 / PDF / Markdown）
// · 本地查看 —— 应用内看不了，交给系统默认程序（Office 系）
// · 无法预览 —— 上两者都不行（未知类型），点了只给「下载后本地查看」的建议
function viewMode(f) {
  if (['image', 'video', 'pdf', 'text'].includes(f.kind)) return 'inline'
  // 第二道防线：后端写入时已把 ooxml / ole 归成 office，
  // 但旧记录或未归一的来源仍可能带细分类型，这里一并认。
  if (f.kind === 'office' || f.kind === 'ooxml' || f.kind === 'ole') return 'external'
  return 'none'
}
function viewLabel(f) {
  const m = viewMode(f)
  return m === 'inline' ? '直接预览' : m === 'external' ? '本地查看' : '无法预览'
}

function sizeText(size) {
  const n = Number(size) || 0
  if (!n) return ''
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  return Math.round(n / 1024) + 'KB'
}

function pickFiles() {
  const el = fileInput.value
  if (el) el.click()
}

function onPick(e) {
  uploadFiles(Array.from(e.target.files || []))
  e.target.value = ''
}

function onDrop(e) {
  dragOver.value = false
  uploadFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || []))
}

async function uploadFiles(files) {
  if (!files.length || uploading.value) return
  uploading.value = true
  uploadDone.value = 0
  uploadTotal.value = files.length
  let added = 0
  try {
    // 一次一个：后端整批全成功或全失败，逐个传能让用户看到进度，
    // 也避免一个大视频卡住其它小文件
    for (const f of files) {
      const form = new FormData()
      form.append('receipts', f)
      const { data } = await axios.post(`${props.apiBase}/fee-records/upload-receipt`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      for (const item of data.files || []) {
        localItems.value.push({ ...item, kind: item.kind || kindOfPath(item.path) })
        added += 1
      }
      uploadDone.value += 1
    }
  } catch (err) {
    notifyError(err.response?.data?.error || '上传失败')
  } finally {
    uploading.value = false
    // 文件已经在 uploads 里了，关联关系也要立刻落库 ——
    // 不然「拖进来」和「数据库有记录」是两件事，用户以为存上了其实没有
    if (added > 0) commit()
  }
}

function view(f) {
  const mode = viewMode(f)
  if (mode === 'none') {
    notifyError('无法查看，建议下载后本地查看')
    return
  }
  // Office 文档不内嵌预览，交给系统默认程序（WPS / Office）打开 —— 那里渲染最准，
  // 也不再引一个几十 MB 的转换库
  if (mode === 'external') { void openExternal(f); return }
  if (f.kind === 'pdf') {
    docItem.value = f
    return
  }
  if (f.kind === 'text') {
    void openMarkdown(f)
    return
  }
  // 图片/视频：定位到媒体查看器里的这一项（前后可翻）
  const idx = mediaItems.value.findIndex((it) => it.raw.path === f.path)
  mediaIndex.value = idx >= 0 ? idx : 0
  mediaOpen.value = true
}

function closeDoc() {
  docItem.value = null
  docHtml.value = ''
}

// Markdown 收据：拉原文 → 复用 AI 助手那套 marked + DOMPurify（懒加载，已 sanitize）
async function openMarkdown(f) {
  docItem.value = f
  docHtml.value = ''
  docLoading.value = true
  try {
    const res = await fetch(resourceUrl(f.path))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    docHtml.value = await renderMarkdown(await res.text())
  } catch (err) {
    closeDoc()
    notifyError(`无法读取该文件：${err.message || '未知错误'}`)
  } finally {
    docLoading.value = false
  }
}

/** 用系统默认程序打开 uploads 里的文件（走受限通道，只认 uploads 内且非可执行扩展名） */
async function openExternal(f) {
  if (!f) return
  // 先给反馈：拉起系统程序有几百毫秒到一两秒的延迟，不给提示用户会以为点了没反应，
  // 然后连点几下开出好几个窗口
  notifyInfo('正在启动本地应用查看…')
  try {
    const res = await window.electron.invoke(INVOKE.OPEN_UPLOAD_FILE, { relPath: f.path })
    if (res && res.outcome === 'fail') notifyError(res.error || '无法打开该文件')
  } catch (err) {
    notifyError(err.message || '无法打开该文件')
  }
}

async function download(f) {
  if (downloading.value) return
  downloading.value = true
  try {
    const res = await fetch(resourceUrl(f.path))
    if (!res.ok) throw new Error('读取文件失败')
    const blob = await res.blob()
    const saved = await saveBlobWithDialog(f.name || '收据', blob)
    // 空串 = 用户在保存对话框点了取消，不打扰
    if (saved) notifySuccess('已保存')
  } catch (err) {
    notifyError(err.message || '下载失败')
  } finally {
    downloading.value = false
  }
}

function remove(index) {
  const [item] = localItems.value.splice(index, 1)
  if (item && item.path) removedPaths.value.push(item.path)
  commit()
}

// 每次增删都立刻交给父组件落库（不再是「点确定才保存」）。
// removed 传完就清空：父组件用它把文件移进回收站，重复提交会重复移动。
function commit() {
  emit('change', {
    items: localItems.value.map((f) => ({ ...f })),
    removed: [...removedPaths.value],
  })
  removedPaths.value = []
}

</script>

<style scoped>
.receipt-card {
  width: 720px;
  max-width: 92vw;
  max-height: 86vh;
}
/* 8 条 × 37px：超过就滚动，别把弹窗顶到屏幕外 */
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
.rc-btn--danger {
  color: var(--color-danger, #dc2626);
  border-color: color-mix(in srgb, var(--color-danger, #dc2626) 35%, transparent);
}
.rc-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger, #dc2626) 12%, transparent);
}
.rc-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text);
  cursor: pointer;
  line-height: 1;
}
/* 文档纸张（PDF / Markdown 共用底色与阴影，只是排版不同）：
   白底 + 圆角 + 深阴影，让它像「一张纸」浮在灯箱上，而不是贴边的白色矩形 */
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
/* v-html 进来的内容没有 scoped 属性，必须 :deep() 才命中 */
.rc-md-body {
  font-size: 14px;
  line-height: 1.75;
}
.rc-md-body :deep(h1) { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
.rc-md-body :deep(h2) { font-size: 18px; font-weight: 700; margin: 20px 0 10px; }
.rc-md-body :deep(h3) { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
.rc-md-body :deep(p) { margin: 0 0 10px; }
/* tailwind preflight 把 ul/ol 的 list-style 清掉了，这里要显式恢复 */
.rc-md-body :deep(ul),
.rc-md-body :deep(ol) { margin: 0 0 10px; padding-left: 22px; list-style: revert; }
.rc-md-body :deep(li) { margin: 2px 0; }
.rc-md-body :deep(a) { color: #2563eb; text-decoration: underline; }
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
