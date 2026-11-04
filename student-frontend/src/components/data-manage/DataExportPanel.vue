<template>
  <!-- 数据管理：列表常驻，导出动作走 ExportExcel 的「导出选项」弹窗 -->
  <div class="bg-surface rounded-lg border border-border p-6">
    <div class="flex items-center justify-between gap-3 mb-3">
      <div class="flex items-center gap-1.5">
        <h3 class="text-base font-semibold text-text">数据导出</h3>
        <AppHelp
          text="勾选要导出的表后点「选中导出」，或直接点「全部导出」。导出的是一张 zip 包，里面每张表一个文件。"
          aria-label="数据导出说明"
        />
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <!-- 搜索：外观与设置页顶部那个一致（左侧「搜索」+ 竖线 + 右侧放大镜）。
             这里的结果不是「跳转定位」而是**过滤列表**，所以没有悬浮弹窗。
             匹配口径也沿用同一套：表名片段 或 拼音首字母（xs → 学生名单）。 -->
        <div class="relative">
          <input
            v-model="keyword"
            type="text"
            aria-label="搜索数据表"
            class="block h-9 w-52 pl-[54px] pr-9 border border-border rounded-lg bg-bg text-sm text-text focus:outline-none focus:border-primary"
            @keydown.esc="keyword = ''"
          />
          <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-text-muted pointer-events-none">搜索</span>
          <span class="absolute left-[46px] top-1/2 -translate-y-1/2 w-px h-4 bg-border pointer-events-none"></span>
          <span class="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center text-text-muted pointer-events-none"><IconGlyph name="search" :size="16" tint="current" /></span>
        </div>
        <button
          class="bg-surface-hover text-text border border-border px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!filteredTables.length"
          @click="openZipDialog(keyword.trim() ? 'filtered' : 'all')"
        >{{ keyword.trim() ? `导出筛选的 ${filteredTables.length} 张` : '全部导出' }}</button>
        <button
          class="bg-info hover:bg-info-hover text-text-inverse border border-border px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!checked.length"
          @click="openZipDialog('checked')"
        >选中导出</button>
      </div>
    </div>

    <!-- 表列表：超过 8 条出现滚动条（8 × 37px），不撑高整个分区 -->
    <div v-if="loading" class="text-sm text-text-muted py-6 text-center">正在读取数据表…</div>
    <div v-else class="dm-list app-custom-scroll border border-border rounded-lg overflow-y-auto">
      <label
        v-for="t in filteredTables" :key="t.key"
        class="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-hover transition-theme cursor-pointer"
      >
        <input type="checkbox" :value="t.key" v-model="checked" />
        <span class="flex-1 min-w-0 text-sm text-text truncate">{{ t.label }}</span>
        <span class="text-xs text-text-muted shrink-0">{{ t.count }} 行</span>
        <button
          class="dm-row-btn shrink-0"
          :disabled="loadingSingle"
          @click.prevent.stop="exportSingle(t)"
        >导出</button>
      </label>
      <div v-if="!tables.length" class="text-sm text-text-muted py-6 text-center">没有可导出的数据表</div>
      <div v-else-if="!filteredTables.length" class="text-sm text-text-muted py-6 text-center">
        没有匹配「{{ keyword.trim() }}」的表
      </div>
    </div>

    <!-- 导出选项弹窗：完全复用 ExportExcel。
         zip 模式下由 extraOptions 插槽补「选择导出的表」和密码，导出动作经 customExport 接管；
         单表模式什么都不传，就是页面里原本的「选列 / 选格式 / 改文件名 → 存一个文件」。 -->
    <ExportExcel
      v-if="dlg.visible"
      :rows="dlg.rows"
      :fields="dlg.fields"
      :hide-field-picker="dlg.mode === 'zip'"
      :allow-empty="dlg.mode === 'single'"
      :exclude-formats="['image', 'pdf']"
      :default-filename="dlg.filename"
      :custom-export="dlg.mode === 'zip' ? runZip : null"
      :is-visible="dlg.visible"
      @update:is-visible="onDlgVisible"
    >
      <template v-if="dlg.mode === 'zip'" #extraOptions>
        <div class="mb-4">
          <p class="font-semibold mb-2">选择导出的表：</p>
          <div class="dm-pick-list app-custom-scroll border border-border rounded-lg overflow-y-auto">
            <label v-for="t in tables" :key="t.key" class="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer">
              <input type="checkbox" :value="t.key" v-model="dlg.keys" />
              <span class="truncate">{{ t.label }}</span>
            </label>
          </div>
          <p v-if="!dlg.keys.length" class="text-danger text-sm mt-1">请至少选择一张表</p>
        </div>
      </template>

      <template v-if="dlg.mode === 'zip'" #afterRowOptions>
        <!-- 收据文件只在导了班费记录时才有意义，没勾这张表就不显示 -->
        <div v-if="hasFeeSelected" class="mb-4">
          <AppSwitch v-model="dlg.includeReceipts">同时导出收据文件</AppSwitch>
          <p class="text-xs text-text-muted mt-1 max-w-[340px]">
            开启后 zip 里多一个「收据文件」目录，按收支编码分子目录，存放收据原件（图片 / PDF / 视频等）。
          </p>
        </div>

        <div class="mb-4">
          <p class="font-semibold mb-2">zip 密码：</p>
          <AppSwitch v-model="dlg.usePassword">设置密码（不勾选则双击即可打开）</AppSwitch>
          <!-- 上下排而不是左右并排：弹窗宽度固定，两个输入框横排各占一半，
               长密码看不全；竖排各占一行。宽度再收一道 —— 撑满整行既难看，
               也会把卡片的宽度推到 max-w-xl 附近。 -->
          <div v-if="dlg.usePassword" class="flex flex-col gap-2 mt-2">
            <input
              v-model="dlg.password"
              type="password"
              class="dm-input w-full max-w-[280px] border border-border bg-surface text-text p-2"
              placeholder="密码（建议字母数字）"
            />
            <input
              v-model="dlg.password2"
              type="password"
              class="dm-input w-full max-w-[280px] border border-border bg-surface text-text p-2"
              placeholder="再输一次"
            />
          </div>
          <p v-if="dlg.pwdError" class="text-xs text-danger mt-1 max-w-[340px]">{{ dlg.pwdError }}</p>
          <!-- 这行提示必须限宽：卡片是 flex item，宽度按「不换行时最宽」算，
               这段 44 个字的说明会把弹窗直接顶到 max-w-xl（576px），
               看起来就是「加了个密码就把窗口撑宽了」。限到 340px 后卡片回落到 ~400。 -->
          <p v-else-if="dlg.usePassword" class="text-xs text-text-muted mt-1 max-w-[340px]">
            Windows 资源管理器双击即可输入密码解压。这是传统加密，只能防随手打开，不能抵御针对性破解。
          </p>
        </div>
      </template>
    </ExportExcel>
  </div>
</template>

<script setup vapor>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import AppHelp from '../base/AppHelp.vue'
import AppSwitch from '../base/AppSwitch.vue'
import IconGlyph from '../base/IconGlyph.vue'
import ExportExcel from '../import-export/ExportExcel/ExportExcel.vue'
import { useExportFormats } from '../import-export/ExportExcel/ExportExcel.exporters.js'
import { saveBlobWithDialog } from '../../utils/saveFile.js'
import { blobToBase64 } from '../../utils/base64.js'
import { localDateStr } from '../../utils/dateTime.js'
import { useNotification } from '../../composables/useNotification'

defineOptions({ name: 'DataExportPanel' })

const { success: notifySuccess, error: notifyError, info: notifyInfo } = useNotification()

const tables = ref([])
const checked = ref([])
const keyword = ref('')
const loading = ref(false)
const loadingSingle = ref(false)

// 与设置页顶部搜索同一口径：命中「表名片段」或「拼音首字母」即算匹配（空关键字返回全部）。
// 这里的结果是**过滤列表**而不是跳转定位 —— 所以没有那套悬浮弹窗与键盘高亮。
const filteredTables = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return tables.value
  return tables.value.filter(
    (t) => String(t.label || '').toLowerCase().includes(q) || String(t.py || '').includes(q)
  )
})

// 弹窗状态。mode='zip' 打包多表；mode='single' 走 ExportExcel 原生的单文件导出
const dlg = ref(newDialog())

function newDialog() {
  return {
    visible: false,
    mode: 'zip',
    keys: [],
    rows: [],
    fields: [],
    filename: '班级数据导出',
    includeReceipts: false,
    usePassword: false,
    password: '',
    password2: '',
    pwdError: '',
  }
}

// 班费表的 key 是 fees。只有它被选中时，「同时导出收据文件」才有意义
const hasFeeSelected = computed(() => dlg.value.keys.includes('fees'))

const EXT = { xlsx: 'xlsx', csv: 'csv', json: 'json', md: 'md', txt: 'txt', html: 'html' }

onMounted(loadTables)

async function loadTables() {
  loading.value = true
  try {
    const { data } = await axios.get('/api/data/tables')
    tables.value = data.tables || []
    // 默认全选：主场景是「全部导出」，不想要的再取消
    checked.value = tables.value.map((t) => t.key)
  } catch (err) {
    tables.value = []
    notifyError(err.response?.data?.error || '读取数据表失败')
  } finally {
    loading.value = false
  }
}

async function fetchSources(keys) {
  const { data } = await axios.post('/api/data/sources', { keys })
  return data.tables || []
}

// ---------- 打开弹窗 ----------

function openZipDialog(scope) {
  // 'filtered'：搜索状态下「全部导出」只导当前筛选出来的表 ——
  // 否则搜出 1 张还得手动取消另外 18 张的勾选。
  const keys = scope === 'all'
    ? tables.value.map((t) => t.key)
    : scope === 'filtered'
      ? filteredTables.value.map((t) => t.key)
      : [...checked.value]
  if (!keys.length) { notifyInfo('请先勾选要导出的表'); return }
  dlg.value = { ...newDialog(), visible: true, mode: 'zip', keys }
}

// 单表导出：先把数据取回来，再交给导出弹窗（能选列、选格式、改文件名）
async function exportSingle(t) {
  if (loadingSingle.value) return
  loadingSingle.value = true
  try {
    const sources = await fetchSources([t.key])
    const one = sources[0]
    if (!one) { notifyError('没有取到数据'); return }
    // 空表也照样打开弹窗：导出一份只有表头的文件，用户能确认「这张表确实是空的」。
    // 拦在这里会让人以为「这张表不支持导出」（课程表 / 撤销记录 / AI 对话常常是 0 行）。
    dlg.value = {
      ...newDialog(),
      visible: true,
      mode: 'single',
      keys: [t.key],
      rows: one.rows,
      fields: one.fields,
      filename: t.label,
    }
  } catch (err) {
    notifyError(err.response?.data?.error || '读取数据失败')
  } finally {
    loadingSingle.value = false
  }
}

function onDlgVisible(v) {
  if (!v) dlg.value = { ...dlg.value, visible: false }
}

// ---------- zip 导出（由弹窗的 customExport 调用） ----------

// 复用 ExportExcel 的格式实现，只换写盘出口：注入 saveFile 后各格式函数把生成的
// blob 交回来，而不是弹系统保存框。列宽 / 边框 / CSV 转义全部沿用同一份代码。
function makeCollector() {
  const out = []
  const ctx = {
    reportProgress() {},
    notifySuccess() {},
    notifyError() {},
    notifyInfo() {},
    saveFile: async (name, blob) => {
      out.push({ name, blob })
      return name
    },
  }
  Object.assign(ctx, useExportFormats(ctx))
  return { ctx, out }
}

const BUILDERS = {
  xlsx: (c, rows, fields, name) => c.exportXLSX(rows, fields, name),
  csv: (c, rows, fields, name) => c.exportCSV(rows, fields, name),
  html: (c, rows, fields, name) => c.exportHTMLTable(rows, fields, name),
  md: (c, rows, fields, name) => c.exportMD(rows, fields, name),
  txt: (c, rows, fields, name) => c.exportTXT(rows, fields, name),
  json: (c, rows, fields, name) => c.exportJSON(rows, fields, name),
}


function validatePassword() {
  const d = dlg.value
  d.pwdError = ''
  if (!d.usePassword) return true
  if (!d.password) {
    d.pwdError = '请输入 zip 密码'
    return false
  }
  // 非 ASCII 密码在 Windows 自带解压里会因代码页不同而解不开，直接挡住
  if (!/^[\x20-\x7e]+$/.test(d.password)) {
    d.pwdError = '密码只能用英文、数字和符号（中文密码在 Windows 解压时可能解不开）'
    return false
  }
  if (d.password !== d.password2) {
    d.pwdError = '两次输入的密码不一致'
    return false
  }
  return true
}

async function runZip({ format, filename, reportProgress }) {
  const d = dlg.value
  if (!d.keys.length) throw new Error('请至少选择一张表')
  if (!validatePassword()) throw new Error(d.pwdError)

  const build = BUILDERS[format]
  if (!build) throw new Error('不支持的导出格式')

  const sources = await fetchSources(d.keys)
  if (!sources.length) throw new Error('没有取到数据')

  const { ctx, out } = makeCollector()
  const ext = EXT[format]
  for (let i = 0; i < sources.length; i++) {
    const t = sources[i]
    reportProgress(Math.round((i / sources.length) * 80) + 10)
    // 空表也出文件（只有表头）：让用户能确认「这张表确实是空的」，
    // 而不是在 zip 里找不到它、以为漏导了
    await build(ctx, t.rows, t.fields, t.label)
    const last = out[out.length - 1]
    if (last) last.name = `${t.label}.${ext}`
  }

  reportProgress(90)
  const entries = []
  for (const f of out) {
    entries.push({ name: f.name, data: await blobToBase64(f.blob) })
  }

  const res = await axios.post(
    '/api/data/zip',
    {
      entries,
      password: d.usePassword ? d.password : '',
      filename,
      // 这里只有表格化后的文本，没有收据原始路径 —— 交给后端按库里的 fee_records 自己分组。
      // 再挡一次「没勾班费表就别带收据」：开关可能是在勾了班费之后又取消的。
      includeReceipts: d.includeReceipts && d.keys.includes('fees'),
    },
    { responseType: 'blob' }
  )
  // 扩展名必须写在字面量里（export-format-probe 靠它扫「前端实际在用哪些扩展名」，
  // 与主进程 ALLOWED_SAVE_EXTS 对账；写成变量会让 .zip 变成白名单里的「没人用的口子」）
  const base = String(filename || '数据导出').trim()
  const saved = await saveBlobWithDialog(`${base}_${localDateStr()}.zip`, res.data)
  // 空串 = 用户在保存对话框点了取消，不是失败，不提示
  if (saved) notifySuccess(`已导出 ${out.length} 张表`)
}
</script>

<style scoped>
/* 8 条 × 37px：超过就滚动，避免二十张表把整个设置页顶得很长 */
.dm-list {
  max-height: 296px;
}
/* 弹窗里的选表区：再高会顶出屏幕，固定 160px 内部滚动 */
.dm-pick-list {
  max-height: 160px;
}
.dm-row-btn {
  font-size: 13px;
  line-height: 1;
  padding: 6px 12px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.dm-row-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.dm-row-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dm-input {
  border-radius: var(--radius-control);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.dm-input:focus {
  border-color: var(--color-info, #3b82f6);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22);
  outline: none;
}
</style>
