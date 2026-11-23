<template>
  <div>
    <!-- 页面标题 -->
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="activity" /> 班级活动</h1>
    </div>

    <!-- 双 tab -->
    <Tabs :tabs="tabs" v-model="activeTab" @hover="onTabHover" />

    <!-- 日常活动 / 倒计时：异步分块，hover 预取 -->
    <ActivitiesDailyTab v-if="activeTab === 'daily'" :ctx="tabCtx" />
    <ActivitiesCountdownTab v-else-if="activeTab === 'countdown'" :ctx="tabCtx" />

    <!-- 新增/编辑活动弹窗 -->
    <AddActivityDialog
      v-if="actDialogMounted"
      :visible="actDialogVisible"
      :editing-record="editingActivity"
      @confirm="submitActivity"
      @update="updateActivity"
      @delete="rec => deleteActivity(rec?.id)"
      @import="openImportFromActivityAdd"
      @cancel="actDialogVisible = false"
    />

    <!-- 新增/编辑倒计时弹窗 -->
    <AddCountdownDialog
      v-if="cntDialogMounted"
      :visible="cntDialogVisible"
      :editing-record="editingCountdown"
      @confirm="submitCountdown"
      @update="updateCountdown"
      @delete="rec => deleteCountdown(rec?.id)"
      @import="openImportFromCountdownAdd"
      @cancel="cntDialogVisible = false"
    />

    <!-- 确认删除弹窗 -->
    <ConfirmDialog
      v-if="confirmMounted"
      :visible="confirm.visible"
      :message="confirm.message"
      type="confirm"
      :showCancel="true"
      @confirm="confirm.ok"
      @cancel="confirm.visible = false"
    />

    <!-- 导出活动 -->
    <ExportExcel
      v-if="actExportMounted"
      :is-visible="actExportVisible"
      :rows="activityExportRows"
      :fields="activityExportFields"
      :selectedRowKeys="[]"
      :default-filename="'班级活动'"
      @export-finish="() => {}"
      @update:is-visible="actExportVisible = $event"
    />

    <!-- 导出倒计时 -->
    <ExportExcel
      v-if="cntExportMounted"
      :is-visible="cntExportVisible"
      :rows="countdownExportRows"
      :fields="countdownExportFields"
      :selectedRowKeys="[]"
      :default-filename="'倒计时'"
      @export-finish="() => {}"
      @update:is-visible="cntExportVisible = $event"
    />

    <!-- 从表格导入（按当前页签切换活动 / 倒计时的表头） -->
    <ImportExcel
      v-if="importMounted"
      :visible="importDialogVisible"
      :existingFields="importFields"
      :requiredFields="importRequiredFields"
      :templateName="activeTab === 'countdown' ? '倒计时标准导入表' : '班级活动标准导入表'"
      @import-data="onImportData"
      @cancel="importDialogVisible = false"
    />
  </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { isAddActionForRoute } from '../utils/addActionRoute.js'
import axios from 'axios'
import { ref, reactive, computed, watch, onMounted, onActivated, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tabs from '../components/base/Tabs.vue'
import { useNotification } from '../composables/useNotification.js'
import { reportError } from '../utils/reportError.js'
import { recordRowInsert, recordRowUpdate, recordRowDelete, recordRowsBatchInsert, useUndoShortcut } from '../composables/useUndo.js'
import { applyRouteRowFocus, createRowFocusHost } from '../composables/useRowFocus.js'

defineOptions({ name: 'ActivitiesView' })

const loadAddActivityDialog = () => import('../components/dialogs/AddActivityDialog.vue')
const AddActivityDialog = defineAsyncComponent(loadAddActivityDialog)
const loadAddCountdownDialog = () => import('../components/dialogs/AddCountdownDialog.vue')
const AddCountdownDialog = defineAsyncComponent(loadAddCountdownDialog)
const ConfirmDialog = defineAsyncComponent(() => import('../components/base/ConfirmDialog.vue'))
const loadExportExcel = () => import('../components/import-export/ExportExcel/ExportExcel.vue')
const ExportExcel = defineAsyncComponent(loadExportExcel)
const loadImportExcel = () => import('../components/import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)

// 两个 tab 整块异步化：首次切过去才下载对应 chunk，悬停标签即预取
const loadDailyTab = () => import('./ActivitiesDailyTab.vue')
const ActivitiesDailyTab = defineAsyncComponent(loadDailyTab)
const loadCountdownTab = () => import('./ActivitiesCountdownTab.vue')
const ActivitiesCountdownTab = defineAsyncComponent(loadCountdownTab)
function onTabHover(value) {
  if (value === 'daily') prefetch(loadDailyTab)
  else if (value === 'countdown') prefetch(loadCountdownTab)
}

const API = '/api'

// 把 YYYY-MM-DD 字符串解析为本地时区日期（避免时区偏移造成天数差 1）
function parseDate(str) {
  if (!str) return null
  const parts = String(str).slice(0, 10).split('-').map(Number)
  if (parts.length !== 3 || parts.some(n => isNaN(n))) return null
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function todayDate() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// 活动状态：按「日期」对比今天（当天=进行中，未来=未开始，过去=已结束）
function activityStatus(time) {
  const d = parseDate(time)
  if (!d) return 'ended'
  const t = todayDate()
  if (d.getTime() > t.getTime()) return 'upcoming'
  if (d.getTime() === t.getTime()) return 'ongoing'
  return 'ended'
}

// 倒计时：返回与今天的自然日差（含符号，正=未来/还有, 负=已过去）
function countdownDays(deadline, includeDay) {
  const d = parseDate(deadline)
  if (!d) return 0
  let diff = Math.round((d.getTime() - todayDate().getTime()) / 86400000)
  if (includeDay) diff += 1
  return diff
}

const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = createRowFocusHost(route, router)

const activeTab = ref('daily')
// 活动
const activities = ref([])
const editingActivity = ref(null)
const actDialogVisible = ref(false)
const actDialogMounted = ref(false)
const actExportVisible = ref(false)
const actExportMounted = ref(false)
// 倒计时
const countdowns = ref([])
const editingCountdown = ref(null)
const cntDialogVisible = ref(false)
const cntDialogMounted = ref(false)
const cntExportVisible = ref(false)
const cntExportMounted = ref(false)
// Excel 导入（活动 / 倒计时共用同一个弹窗，表头随当前页签切换）
const importDialogVisible = ref(false)
const importMounted = ref(false)
// 通用确认
const confirm = ref({ visible: false, message: '', ok: null })
const confirmMounted = ref(false)

const tabs = computed(() => [
  { label: '日常活动', value: 'daily' },
  { label: '倒计时', value: 'countdown' }
])
// ---------- 活动 ----------
const activityMap = computed(() => {
  const m = {}
  activities.value.forEach(a => { m[a.id] = a })
  return m
})
const activityNodeTypes = computed(() => [
  { value: 'upcoming', label: '未开始', colorKey: 'info', color: '#3b82f6' },
  { value: 'ongoing', label: '进行中', colorKey: 'success', color: '#16a34a' },
  { value: 'ended', label: '已结束', colorKey: 'muted', color: '#9ca3af' }
])
const activityTimelineNodes = computed(() => activities.value.slice()
  .filter(a => a.时间)
  .map(a => ({
    key: a.id,
    type: activityStatus(a.时间),
    time: displayTime(a.时间),
    text: a.主题 || '',
    subject: a.主题 || '',
    location: a.地点,
    participants: a.参与人员
  })))
const activityExportRows = computed(() => activities.value.map(a => ({
  时间: displayTime(a.时间),
  主题: a.主题 || '',
  地点: a.地点 || '',
  参与人员: a.参与人员 || '',
  简介: a.简介 || '',
  状态: statusLabel(activityStatus(a.时间))
})))
const activityExportFields = computed(() => ['时间', '主题', '地点', '参与人员', '简介', '状态'].map(name => ({ name })))
// ---------- 倒计时 ----------
const daysMap = computed(() => {
  const m = {}
  countdowns.value.forEach(c => { m[c.id] = countdownDays(c.截止日, !!c.包含这一天) })
  return m
})
const sortedCountdowns = computed(() => countdowns.value.slice().sort((a, b) => asTs(a.截止日) - asTs(b.截止日)))
const topCountdowns = computed(() => sortedCountdowns.value.slice(0, 3).map(c => ({ ...c, days: daysMap.value[c.id] })))
const countdownMap = computed(() => {
  const m = {}
  countdowns.value.forEach(c => { m[c.id] = c })
  return m
})
const countdownNodeTypes = computed(() => [
  { value: 'future', label: '未到', colorKey: 'info', color: '#3b82f6' },
  { value: 'past', label: '已过', colorKey: 'muted', color: '#9ca3af' }
])
const countdownTimelineNodes = computed(() => sortedCountdowns.value.map(c => ({
  key: c.id,
  type: (daysMap.value[c.id] ?? 0) >= 0 ? 'future' : 'past',
  time: c.截止日,
  text: c.名称 || '',
  name: c.名称 || '',
  deadline: c.截止日,
  days: daysMap.value[c.id]
})))
// 时间轴搜索补词：slot 里「截止日 / 距离该事件还有 N 天 / 已经过去了 N 天」
// 都不在节点字段里，组件自己搜不到。按 days 正负拼，与下方模板 :83-85 的显示保持一致，
// 别把两种状态的文案都塞给所有节点（否则搜「已经过去了」会把未到的也捞出来）。
// 必须是稳定函数引用：LeaveTimeline 会把它纳入 haystack 缓存的有效性判据。
function countdownSearchText(node) {
  const tail = node.days >= 0
    ? `距离该事件还有 ${node.days} 天`
    : `已经过去了 ${Math.abs(node.days)} 天`
  return `截止日 ${node.deadline} ${tail}`
}
const countdownExportRows = computed(() => countdowns.value.map(c => {
  const days = daysMap.value[c.id]
  return {
    名称: c.名称 || '',
    截止日: c.截止日 || '',
    剩余天数: days >= 0 ? days : -Math.abs(days),
    状态: days >= 0 ? `还有 ${days} 天` : `已经过去 ${Math.abs(days)} 天`,
    包含截止日当天: c.包含这一天 ? '是' : '否'
  }
}))
const countdownExportFields = computed(() => ['名称', '截止日', '剩余天数', '状态', '包含截止日当天'].map(name => ({ name })))

// 导入列：活动要「主题」，倒计时要「名称 + 截止日」；其余列都可选
const importFields = computed(() => (activeTab.value === 'countdown'
  ? [{ name: '名称' }, { name: '截止日' }, { name: '包含这一天' }]
  : [{ name: '时间' }, { name: '主题' }, { name: '地点' }, { name: '参与人员' }, { name: '简介' }]))
const importRequiredFields = computed(() => (activeTab.value === 'countdown'
  ? ['名称', '截止日']
  : ['主题']))

// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销、重做：活动与倒计时各自独立，按当前 tab 切换对应历史栈
const { success } = useNotification()
const resolveKey = () => (activeTab.value === 'countdown' ? 'countdowns' : 'activities')
useUndoShortcut(resolveKey, {
  onAfterUndo: (label) => { loadAll(); success(label ? `已撤销：${label}` : '已撤销') },
  onAfterRedo: (label) => { loadAll(); success(label ? `已重做：${label}` : '已重做') }
})

watch(actDialogVisible, (n) => { if (n) actDialogMounted.value = true })
watch(cntDialogVisible, (n) => { if (n) cntDialogMounted.value = true })
watch(actExportVisible, (n) => { if (n) actExportMounted.value = true })
watch(cntExportVisible, (n) => { if (n) cntExportMounted.value = true })
watch(importDialogVisible, (n) => { if (n) importMounted.value = true })
watch(() => confirm.value.visible, (n) => { if (n) confirmMounted.value = true })
// 跨页定位：标题栏全局搜索点「班级活动 / 倒计时」结果跳转 /activities?focus=<id>
watch(() => route.query.focus, () => { _applyRowFocus() })
// 桌面小组件点倒计时：/activities?tab=countdown 直达倒计时页签
watch(() => route.query.tab, () => { _applyTabQuery() })
// 首页空态「去添加活动 / 去添加倒计时」：?action=add 直接打开对应新增弹窗。
// 倒计时入口另带 ?tab=countdown，据此区分开哪个弹窗；页签本身交给 _applyTabQuery，这里不碰，
// 免得与下方 activeTab→URL 的反向同步互相打架。清 action 时保留 tab：用户仍停在倒计时页签。
watch(() => route.query.action, () => {
  if (!isAddActionForRoute(route, 'activities')) return
  const countdown = route.query.tab === 'countdown'
  router.replace({ path: route.path, query: { ...route.query, action: undefined } })
  if (countdown) openAddCountdown()
  else openAddActivity()
}, { immediate: true })
// 异步 tab 子组件共享的 reactive 上下文：字段都是本组件的 ref / 函数，
// reactive 解包后子组件模板读写 ctx.xxx 等价于本组件 xxx.value。
// 数据加载 / focus / undo / 共享 ImportExcel 全留父组件，这里只做透传。
const tabCtx = reactive({
  prefetch, loadAddActivityDialog, loadAddCountdownDialog, loadImportExcel, loadExportExcel,
  openAddActivity, refreshActivities, openActivityExport, openEditActivity, activityByKey,
  askDeleteActivity, goAlbum,
  openAddCountdown, refreshCountdowns, openCountdownExport, openEditCountdown, countdownByKey,
  askDeleteCountdown,
  importDialogVisible,
  activityTimelineNodes, activityNodeTypes,
  topCountdowns, countdownTimelineNodes, countdownNodeTypes, countdownSearchText,
})

// 页签反向同步到 URL：用户手动切回「日常活动」后，组件再点倒计时仍能重新跳转
// （否则 URL 一直停在 ?tab=countdown，主窗口收到同路径导航时就无法区分当前页签）
watch(activeTab, (val) => {
  if (route.path !== '/activities') return
  const next = { ...route.query }
  if (val === 'countdown') next.tab = 'countdown'
  else delete next.tab
  if ((next.tab || '') === (route.query.tab || '')) return
  router.replace({ path: route.path, query: next }).catch(() => {})
})

// 与原 created() 等价：发起加载但不阻塞渲染（Vue 本就不等待 async created）
loadAll()

onMounted(() => { _applyRowFocus(); _applyTabQuery() })
onActivated(() => { _applyRowFocus(); _applyTabQuery() })

function _applyTabQuery() {
  const tab = route.query.tab
  if (tab === 'daily' || tab === 'countdown') activeTab.value = tab
}
// 跨页定位：活动/倒计时共用本页。倒计时结果带 countdown: 前缀，先切到倒计时页签再定位。
function _applyRowFocus() {
  applyRouteRowFocus(rowFocusHost, {
    parse: (key) => {
      if (key.startsWith('countdown:')) {
        activeTab.value = 'countdown'
        return key.slice('countdown:'.length)
      }
      activeTab.value = 'daily'
      return key
    }
  })
}
async function loadAll() {
  // 两个接口互不依赖：用 allSettled，避免「倒计时失败」把已经拿到的
  // 「活动列表」一起丢掉（原来 Promise.all 一处 reject 整批作废）。
  const [actRes, cntRes] = await Promise.allSettled([
    axios.get(`${API}/activities`),
    axios.get(`${API}/countdowns`)
  ])
  if (actRes.status === 'fulfilled') activities.value = actRes.value.data.data || []
  if (cntRes.status === 'fulfilled') countdowns.value = cntRes.value.data.data || []

  const failed = []
  if (actRes.status === 'rejected') failed.push('活动')
  if (cntRes.status === 'rejected') failed.push('倒计时')
  if (!failed.length) return true
  // 两处都失败只弹一条，文案带上失败范围，避免刷两条提示
  const reason = (actRes.status === 'rejected' ? actRes : cntRes).reason
  reportError(reason, { action: `加载${failed.join('与')}` })
  return false
}
async function refreshActivities() {
  // 按返回值判断：loadAll 内部吞错时无条件提示成功，会让用户以为数据已是最新
  if (await loadAll()) useNotification().success('已刷新 班级活动 数据')
}
async function refreshCountdowns() {
  if (await loadAll()) useNotification().success('已刷新 倒计时 数据')
}
// ---------- 活动 CRUD ----------
function openAddActivity() { editingActivity.value = null; actDialogVisible.value = true }
// 新增活动弹窗右上角（标题行右端）的「从表格批量导入」：先关掉单条新增，再打开同一个导入弹窗
function openImportFromActivityAdd() {
  actDialogVisible.value = false
  importMounted.value = true
  importDialogVisible.value = true
}
function openEditActivity(a) { editingActivity.value = a; actDialogVisible.value = true }
function activityByKey(key) { return activityMap.value[key] }
async function submitActivity(payload) {
  try {
    const res = await axios.post(`${API}/activities`, payload)
    recordRowInsert('activities', { id: res.data.id, ...payload })
    actDialogVisible.value = false
    useNotification().success('已新增活动')
    await loadAll()
  } catch (err) { reportError(err, { action: '保存' }) }
}
async function updateActivity(payload) {
  const { id, ...fields } = payload
  const oldRow = activityMap.value[id]
  try {
    await axios.put(`${API}/activities/${id}`, fields)
    recordRowUpdate('activities', oldRow, { ...oldRow, ...fields, id })
    actDialogVisible.value = false
    useNotification().success('已保存')
    await loadAll()
  } catch (err) { reportError(err, { action: '保存' }) }
}
function askDeleteActivity(a) {
  confirm.value = {
    visible: true,
    message: `确定删除活动「${a.主题 || '未命名活动'}」吗？`,
    ok: () => deleteActivity(a.id)
  }
}
async function deleteActivity(id) {
  const row = activityMap.value[id]
  try {
    await axios.delete(`${API}/activities/${id}`)
    recordRowDelete('activities', row)
    confirm.value.visible = false
    useNotification().success('已删除')
    await loadAll()
  } catch (err) { reportError(err, { action: '删除' }) }
}
// ---------- 倒计时 CRUD ----------
function openAddCountdown() { editingCountdown.value = null; cntDialogVisible.value = true }
// 添加倒计时弹窗右上角（标题行右端）的「从表格批量导入」：先关掉单条新增，再打开同一个导入弹窗
function openImportFromCountdownAdd() {
  cntDialogVisible.value = false
  importMounted.value = true
  importDialogVisible.value = true
}
function openEditCountdown(c) { editingCountdown.value = c; cntDialogVisible.value = true }
function countdownByKey(key) { return countdownMap.value[key] }
async function submitCountdown(payload) {
  try {
    const res = await axios.post(`${API}/countdowns`, payload)
    recordRowInsert('countdowns', { id: res.data.id, ...payload })
    cntDialogVisible.value = false
    useNotification().success('已添加倒计时')
    await loadAll()
  } catch (err) { reportError(err, { action: '保存' }) }
}
async function updateCountdown(payload) {
  const { id, ...fields } = payload
  const oldRow = countdownMap.value[id]
  try {
    await axios.put(`${API}/countdowns/${id}`, fields)
    recordRowUpdate('countdowns', oldRow, { ...oldRow, ...fields, id })
    cntDialogVisible.value = false
    useNotification().success('已保存')
    await loadAll()
  } catch (err) { reportError(err, { action: '保存' }) }
}
function askDeleteCountdown(c) {
  confirm.value = {
    visible: true,
    message: `确定删除倒计时「${c.名称 || '未命名'}」吗？`,
    ok: () => deleteCountdown(c.id)
  }
}
async function deleteCountdown(id) {
  const row = countdownMap.value[id]
  try {
    await axios.delete(`${API}/countdowns/${id}`)
    recordRowDelete('countdowns', row)
    confirm.value.visible = false
    useNotification().success('已删除')
    await loadAll()
  } catch (err) { reportError(err, { action: '删除' }) }
}
// ---------- 导出 ----------
// 导出活动/倒计时：无数据时直接提示，不弹导出选项弹窗
function openActivityExport() {
  if (activityExportRows.value.length === 0) return useNotification().info('暂无活动可导出')
  actExportVisible.value = true
}
function openCountdownExport() {
  if (countdownExportRows.value.length === 0) return useNotification().info('暂无倒计时可导出')
  cntExportVisible.value = true
}
// ---------- 导入 ----------
async function onImportData({ fields, rows }) {
  importDialogVisible.value = false
  const isCountdown = activeTab.value === 'countdown'
  // 撤销 key 必须在异步前固定：导入 + loadAll 期间用户可能切了标签，
  // 用动态 resolveKey() 会把这次导入的撤销记到另一类数据的历史栈里（#49）。
  const undoKey = resolveKey()
  try {
    const res = await axios.post(`${API}/${isCountdown ? 'countdowns' : 'activities'}/import`, { fields, rows })
    useNotification().success(res.data.message || '导入成功')
    await loadAll()
    // 后端回传本次真正新建的行：一次导入只记一条撤销（活动与倒计时各自独立的历史栈）
    recordRowsBatchInsert(undoKey, res.data?.created)
  } catch (err) {
    reportError(err, { action: isCountdown ? '导入倒计时' : '导入活动' })
  }
}
// ---------- 跳转 ----------
function goAlbum() {
  // 活动相册未独立设计前，跳转到班级相册页
  router.push('/album')
}
// ---------- 工具 ----------
function asTs(str) {
  const parts = String(str || '').split(/[-T :]/).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some(n => isNaN(n))) return Infinity
  return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, parts[3] || 0, parts[4] || 0).getTime()
}
function displayTime(time) {
  if (!time) return ''
  return String(time).replace('T', ' ')
}
function statusLabel(st) {
  return { upcoming: '未开始', ongoing: '进行中', ended: '已结束' }[st] || st
}
</script>
