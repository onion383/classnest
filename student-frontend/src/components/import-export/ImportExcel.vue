<template>
  <!-- Teleport 到 body：避免固定定位遮罩被 main 橡皮筋滚动的 transform 约束，保证全屏覆盖侧边栏 -->
  <Teleport to="body">
  <Transition name="dialog">
    <div v-if="visible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]">
      <div class="bg-surface p-5 rounded-lg w-[900px] max-h-[85vh] flex flex-col shadow-card dialog-card">
      <h3 class="text-lg font-bold mb-3">从文件导入数据</h3>
      <!-- 标准导入表下载：表头与导入要求一致，照着填识别成功率更高 -->
      <div v-if="templateHeaders.length" class="mb-3">
        <!-- opbar：让按钮命中工具栏同款毛玻璃样式（glass 主题的 .opbar button 规则） -->
        <div class="opbar flex flex-wrap items-center gap-3">
          <span class="text-sm text-text">下载标准导入表</span>
          <button
            type="button"
            @click="downloadTemplate"
            class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer"
            title="点击下载标准导入表"
          >点击下载</button>
        </div>
        <p class="text-xs text-text-muted mt-1.5">推荐使用标准导入表导入，识别成功率更高，使用其他格式表格也可以导入</p>
      </div>
      <!-- 文件选择：点击或拖入均可，选中后显示文件名 + 关闭按钮 -->
      <div class="mb-4">
        <div
          v-if="!fileName"
          @click="triggerFileSelect"
          @dragover.prevent
          @dragenter.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onFileDrop"
          class="dropzone flex items-center justify-center gap-2 h-36 cursor-pointer select-none border-2 border-dashed rounded-xl text-inverse"
          :class=" dragOver ? 'dropzone-active' : ''"
        >
          <span class="text-base">点击选择文件，或将文件拖到此处</span>
        </div>
        <div
          v-else
          class="dropzone flex items-center justify-between px-4 h-12 rounded-xl border"
        >
          <span class="text-sm text-text-secondary truncate flex-1 mr-2">{{ fileName }}</span>
          <button @click="resetFile" class="text-text-muted hover:text-danger cursor-pointer select-none" title="移除文件">✕</button>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" class="hidden" @change="handleFile" />
      </div>
      <div v-if="parseError" class="text-danger text-sm mb-2">{{ parseError }}</div>
      <div v-if="filteredCount > 0" class="text-text-secondary text-sm mb-2">由于缺少受保护字段，已过滤 {{ filteredCount }} 条数据。</div>
      <div v-if="previewRows.length > previewLimit" class="text-text-secondary text-sm mb-2">
        表格仅显示前 {{ previewLimit }} 行（共 {{ previewRows.length }} 行）；导入会写入全部行。
      </div>
      <!-- 预览表格：行状表用 DynamicTable；矩阵表（课程表/座位/值日）用 GridView 还原网状外观 -->
      <div class="flex-1 overflow-auto border border-border rounded" v-if="previewFields.length && previewRows.length">
        <GridView
          v-if="previewMode === 'grid'"
          :colHeaders="gridPreviewHeaders"
          :rows="gridPreviewRows"
          :showRowNumber="true"
          hideMetaColumns
          :rowHeaderLabel="gridPreviewRowHeaderLabel"
          :disableRowDrag="true"
          :minTableHeight="0"
          :emptyReady="true"
        />
        <DynamicTable
          v-else
          :fields="previewFields"
          :rows="visibleRows"
          emptyActionText=""
          hideEditButton
          :editingCell="editingCell"
          @startEdit="startEditCell"
          @saveCell="saveCell"
          @deleteRow="deletePreviewRow"
          @toggleSort="toggleSort"
          :sortField="sortField"
          :sortOrder="sortOrder"
        />
      </div>
      <!-- 底部按钮 -->
      <div class="flex justify-between items-center mt-4">
        <span class="text-sm text-text-secondary">共 {{ previewRows.length }} 行{{ previewRows.length > previewLimit ? '（预览前 ' + previewLimit + ' 行）' : '' }}</span>
        <div class="flex gap-2">
          <button @click="cancel" class="bg-surface-hover px-4 py-1.5 rounded text-text">取消</button>
          <button @click="confirmImport" :disabled="previewRows.length === 0" class="bg-primary text-text-inverse px-4 py-1.5 rounded">导入并合并保存</button>
        </div>
      </div>
    </div>
    </div>
  </Transition>
  </Teleport>
</template>

<script setup vapor>
import DynamicTable from '../tables/DynamicTable/DynamicTable.vue';
// 网格预览只在矩阵表（课程表/座位/值日）用，懒加载避免行状表也拖入整块 GridView
const GridView = defineAsyncComponent(() => import('../tables/GridView/GridView.vue'));
import { parseSheet } from '../../utils/importSheet.js';
import { saveBlobWithDialog } from '../../utils/saveFile.js';
import { createLatest } from '../../utils/latestOnly.js';
import '../../styles/dialog-transition.css';
import { ref, computed, watch, defineAsyncComponent } from 'vue';

defineOptions({ name: 'ImportExcel' });

const props = defineProps({
  visible: Boolean,
  existingFields: { type: Array, default: () => [] },
  requiredFields: { type: Array, default: () => ['收支编码'] },
  // 标准导入表：不传 templateColumns 时用 existingFields 的表头；templateName 为标题/下载文件名
  templateColumns: { type: Array, default: () => [] },
  templateName: { type: String, default: '' },
  // 预览形态：table=行状表（默认）；grid=矩阵表（课程表/座位/值日），用网格组件还原
  previewMode: { type: String, default: 'table' }
});

const emit = defineEmits(['import-data', 'cancel']);

// 请求序号挂实例上：Options API 没有 setup 作用域；序号不参与渲染，不必进 data
const seq = createLatest();

// 预览最多渲染多少行（进 data 是为了模板里也能读到，用于显示截断提示）
const previewLimit = ref(3000);
const fileData = ref(null);
const fileName = ref('');
const parseError = ref('');
const filteredCount = ref(0);
const previewFields = ref([]);
const previewRows = ref([]);
const editingCell = ref(null);
const sortField = ref('');
const sortOrder = ref('asc');
const rowKeyCounter = ref(0);
const dragOver = ref(false);

const fileInput = ref(null);

// 只把前 N 行交给表格渲染：10MB 表格可能有几万行，全量铺进 DOM（即使有虚拟滚动，
// 也要为每行建 vnode / 计算列宽）会明显卡顿。**数据本身仍保留全部**，
// confirmImport 用的还是完整 previewRows —— 截断只影响预览，不影响导入内容。
const visibleRows = computed(() => {
  return previewRows.value.length > previewLimit.value
    ? previewRows.value.slice(0, previewLimit.value)
    : previewRows.value
});

// ==================== 矩阵预览（课程表 / 座位 / 值日） ====================
// 文件是「行号/项目 + 各列」的矩阵：第一列作为行标题，其余列作为网格列；
// 用 GridView 渲染，讲台行、走廊列等特殊格式与主表保持一致。
const gridPreviewHeaders = computed(() => {
  const fields = previewFields.value.map(f => f.name)
  return fields.slice(1).map(h => (h.startsWith('d_') ? h.slice(2) : h))
})
const gridPreviewRowHeaderLabel = computed(() => {
  const first = previewFields.value[0]?.name || '行号'
  return first === '项目' ? '劳动项目' : first
})
const gridPreviewRows = computed(() => {
  const fields = previewFields.value.map(f => f.name)
  if (!fields.length) return []
  const rowKeyField = fields[0]
  const dataFields = fields.slice(1)
  const rowList = visibleRows.value
  // 走廊列：导出时每行都会写成「走廊」，命中任一即视为走廊列
  const aisleCols = new Set(
    dataFields.map((h, i) => i).filter(i => rowList.some(r => String(r[dataFields[i]] ?? '').trim() === '走廊'))
  )
  const bodyCount = rowList.filter(r => String(r[rowKeyField] ?? '').trim() !== '讲台').length
  let firstBodySeen = false
  return rowList.map((r) => {
    const label = String(r[rowKeyField] ?? '').trim()
    if (label === '讲台') {
      // 与座位主表一致：讲台行整行合并居中
      return { _rowKey: r._rowKey, label, _isPodium: true, _isReadonly: true, cells: [] }
    }
    const cells = dataFields.map((h, ci) => {
      if (aisleCols.has(ci)) {
        // 与主表一致：首行跨行显示竖排「走廊」，其余行隐藏该列
        if (!firstBodySeen) return { course: '', _isAisle: true, _aisleRowSpan: Math.max(1, bodyCount) }
        return { course: '', _isAisleHidden: true }
      }
      return { course: String(r[h] ?? '') }
    })
    firstBodySeen = true
    return { _rowKey: r._rowKey, label, _isReadonly: true, cells }
  })
})

// 标准导入表的列：优先用调用方显式给的 templateColumns，否则沿用 existingFields 的表头
const templateHeaders = computed(() => {
  const src = props.templateColumns.length ? props.templateColumns : props.existingFields
  return (src || []).map(c => (typeof c === 'string' ? c : (c && c.name))).filter(Boolean)
})
// 表头识别的期望字段：模板列 + 必填列（必填列可能是同义写法数组，拍平后一并参与命中）
const expectedHeaders = computed(() => {
  const required = (props.requiredFields || []).flatMap(f => (Array.isArray(f) ? f : [f]))
  return [...new Set([...templateHeaders.value, ...required].filter(Boolean))]
})

// 标准导入表：合并居中的标题 + 表头 + 20 行空白数据区，全部带细框线。
// 用 exceljs（与导出面板同一套库）而不是 xlsx：SheetJS 社区版写不出单元格样式/合并。
async function downloadTemplate() {
  const headers = templateHeaders.value
  if (!headers.length) return
  try {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('标准导入表')
    const colCount = headers.length
    const EMPTY_ROWS = 20

    // 标题：第 1 行合并居中
    sheet.getCell(1, 1).value = props.templateName || '标准导入表'
    sheet.getCell(1, 1).font = { bold: true, size: 14 }
    sheet.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' }

    // 表头：第 2 行加粗居中
    headers.forEach((name, i) => {
      const cell = sheet.getCell(2, i + 1)
      cell.value = name
      cell.font = { bold: true }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
    })

    // 全框线：标题行 + 表头 + 20 行空白（先铺边框再合并，保证合并区四边都有线）
    const thin = { style: 'thin' }
    const border = { top: thin, left: thin, bottom: thin, right: thin }
    for (let r = 1; r <= 2 + EMPTY_ROWS; r++) {
      for (let c = 1; c <= colCount; c++) sheet.getCell(r, c).border = border
    }
    sheet.mergeCells(1, 1, 1, colCount)

    sheet.getRow(1).height = 28
    sheet.getRow(2).height = 22
    headers.forEach((name, i) => {
      sheet.getColumn(i + 1).width = Math.max(12, String(name).length + 8)
    })

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    await saveBlobWithDialog(`${props.templateName || '标准导入表'}.xlsx`, blob)
  } catch (e) {
    parseError.value = '标准导入表生成失败：' + e.message
  }
}

function triggerFileSelect() { fileInput.value.click(); }
function onFileDrop(e) {
  dragOver.value = false;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  handleFile({ target: { files: [file] } });
}
function resetFile() {
  // 取消/关闭弹窗也要让在途读取与解析失效，避免关闭后仍写入预览状态
  seq.invalidate();
  fileName.value = '';
  fileData.value = null;
  parseError.value = '';
  filteredCount.value = 0;
  previewFields.value = [];
  previewRows.value = [];
  editingCell.value = null;
  sortField.value = '';
  sortOrder.value = 'asc';
  // 清空 file input，保证同一文件可再次选择
  if (fileInput.value) fileInput.value.value = '';
}
function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  // 每次选文件都让上一轮读取/解析失效，包括随后因体积被拒绝的分支
  const my = seq.begin();
  // 大小上限：超大文件会让 xlsx 解析长时间卡死甚至内存暴涨，超过 10MB 直接拒绝
  if (file.size > 10 * 1024 * 1024) {
    resetFile();
    fileName.value = file.name;
    parseError.value = '文件过大，请选择 10MB 以内的表格文件';
    return;
  }
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    if (!seq.isCurrent(my)) return;
    fileData.value = new Uint8Array(ev.target.result);
    // 选中文件后自动解析预览，无需再点击「解析预览」
    await parseFile();
  };
  // 读盘失败（文件被移动/权限不足/设备断开）时必须给出提示，
  // 否则界面停在「请选择一个文件进行解析」，用户以为是自己没选中文件
  reader.onerror = () => {
    if (!seq.isCurrent(my)) return;
    fileData.value = null;
    parseError.value = '文件读取失败，请重新选择文件';
  };
  reader.readAsArrayBuffer(file);
}
// CSV 编码兜底：Excel 另存的 CSV 常是 GBK，直接交给 SheetJS 按二进制读会把中文解成乱码，
// 表头/项目名全都匹配不上。这里先严格按 UTF-8 解码，失败再按 GBK（Electron/Chromium 均支持）。
function decodeCsv(bytes) {
  const tryDecode = (label) => {
    try { return new TextDecoder(label, { fatal: true }).decode(bytes) } catch (_) { return null }
  }
  const utf8 = tryDecode('utf-8')
  // 合法 UTF-8 且含中文（或纯 ASCII）就按 UTF-8；
  // 能解码成 UTF-8 但非 ASCII 且没有中文，多半是 GBK 被误读成拉丁字符，改用 GBK 重解。
  const pureAscii = utf8 != null && !/[^\x00-\x7F]/.test(utf8)
  const hasCjk = utf8 != null && /[\u4e00-\u9fa5]/.test(utf8)
  const text = (pureAscii || hasCjk) ? utf8 : (tryDecode('gbk') || utf8)
  return text ? text.replace(/^\uFEFF/, '') : null
}

// 多 Sheet 选择：逐个解析（最多 5 个），取「数据行最多 + 识别列最多」的 Sheet。
// 首个 Sheet 可能是说明页/目录页，无脑取 SheetNames[0] 会让整次导入识别失败。
function pickSheet(XLSX, workbook) {
  let best = null
  const names = (workbook && workbook.SheetNames ? workbook.SheetNames : []).slice(0, 5)
  for (const name of names) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
    if (!Array.isArray(data) || !data.length) continue
    // 表头识别与行映射抽到 utils/importSheet.js：
    // 表头保留原始列下标，空表头只跳过自己，不会让它右边的列整体左移（串列）
    const parsed = parseSheet(data, props.requiredFields, expectedHeaders.value)
    if (!parsed.fields.length) continue
    // 有数据行优先；缺必填列的 Sheet 降权，避免选中「说明页」
    const score = parsed.rows.length * 100 + parsed.fields.length
      - (parsed.missingRequired.length ? 50 : 0)
    if (!best || score > best.score) best = { score, parsed }
  }
  return best
}

async function parseFile() {
  if (!fileData.value) return;
  const my = seq.current();
  parseError.value = '';
  filteredCount.value = 0;
  // 大依赖 xlsx（SheetJS）延迟到真正导入文件时才加载，避免随表格页一打开就拖进几 MB 代码
  const XLSX = await import('xlsx');
  if (!seq.isCurrent(my)) return;
  try {
    let workbook = null
    // CSV 先按正确编码转成文本再解析：GBK 文件必须走这条，否则中文全是乱码
    if (/\.csv$/i.test(fileName.value || '')) {
      const text = decodeCsv(fileData.value)
      if (text) workbook = XLSX.read(text, { type: 'string' })
    }
    if (!workbook) workbook = XLSX.read(fileData.value, { type: 'array' })
    if (!seq.isCurrent(my)) return;
    const picked = pickSheet(XLSX, workbook)
    if (!picked) { parseError.value = '文件无有效数据'; return; }
    const parsed = picked.parsed
    if (!seq.isCurrent(my)) return;
    if (parsed.fields.length === 0) { parseError.value = '未识别到列标题'; return; }
    previewFields.value = parsed.fields.map(h => ({ name: h, type: '文字' }));
    filteredCount.value = parsed.skipped;
    // 必填列没识别到：给出具体缺哪一列，而不是只显示「已过滤 N 条」让用户猜
    if (parsed.missingRequired && parsed.missingRequired.length) {
      parseError.value = `未识别到必填列：${parsed.missingRequired.join('、')}（已识别列：${parsed.fields.join('、')}）`;
    }
    // 就地在 parseSheet 新建的对象上加内部字段，不再展开拷贝：
    // 大表（几万行）展开一份等于把所有单元格字符串再引用一遍、行对象翻倍。
    parsed.rows.forEach((row, idx) => {
      row._rowKey = `import_${rowKeyCounter.value++}`;
      row._isNew = false;
      row._displayIndex = idx + 1;
    });
    previewRows.value = parsed.rows;
  } catch (e) {
    if (!seq.isCurrent(my)) return;
    parseError.value = '文件解析失败：' + e.message;
  }
}
function startEditCell(row, field) { editingCell.value = { rowKey: row._rowKey, field: field.name }; }
function saveCell(row, field) { editingCell.value = null; }
// order 可显式指定方向（表头筛选面板的升序/降序按钮）；不传则沿用翻转语义
function toggleSort(fieldName, order) {
  if (order === 'asc' || order === 'desc') {
    if (sortField.value === fieldName && sortOrder.value === order) return;
    sortField.value = fieldName;
    sortOrder.value = order;
  } else if (sortField.value === fieldName) sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  else { sortField.value = fieldName; sortOrder.value = 'asc'; }
  previewRows.value.sort((a, b) => {
    let va = a[fieldName] || '', vb = b[fieldName] || '';
    if (va < vb) return sortOrder.value === 'asc' ? -1 : 1;
    if (va > vb) return sortOrder.value === 'asc' ? 1 : -1;
    return 0;
  });
}
function deletePreviewRow(rowKey) { previewRows.value = previewRows.value.filter(r => r._rowKey !== rowKey); }
function confirmImport() {
  const headers = previewFields.value.map(f => f.name);
  const rows = previewRows.value.map(row => headers.map(h => row[h] ?? ''));
  emit('import-data', { fields: headers, rows });
}
function cancel() { resetState(); emit('cancel'); }
function resetState() {
  fileData.value = null; fileName.value = '';
  parseError.value = ''; filteredCount.value = 0;
  previewFields.value = []; previewRows.value = [];
  sortField.value = '';
}

watch(() => props.visible, (val) => { if (!val) resetState(); });
</script>
