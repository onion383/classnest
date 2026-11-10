<template>
  <div>
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="seat" /> 座位管理</h1>
    </div>

    <Tabs :tabs="tabItems" v-model="activeTab">
      <template #default="{ activeTab }">
        <div v-if="activeTab === 'seat'">
          <section class="mb-4">
            <!-- 子标题 + 视图切换：临时表（当前座位）/ 模板表（座位模板） -->
            <div class="mb-4 flex items-center gap-3">
              <h2 class="text-xl font-semibold text-text flex items-center gap-2 min-h-7"><IconGlyph name="seat" :size="20" /> 座位表</h2>
              <ViewSwitch v-model="seatView" :options="seatViewOptions" />
            </div>

            <!-- 工具栏外壳：两种状态的高度一致，切换时靠它定住高度，下方表格不跟着跳。
                 两个工具栏用 out-in 过渡（同一时刻只占一份位置），见 <style> 里的 .opbar-swap。

                 配色跟隔壁（值日/小组/活动/成绩/请假）保持一致，只用绿与暖橙两个族，不用 bg-info：
                   绿 primary = 执行操作（设置 / 智能排表 / 从模板导入 / 确认空位）
                   橙 warning = 进/出画笔模式（设置空位 / 退出），也是 Excel 导入导出与刷新所在族
                   红 danger  = 批量清除（全清空位），画笔模式里靠它与「退出」区分
                 不用 bg-info 的原因：它在 glass 下是蓝（与全站暖色工具栏打架），在 base 下又与
                 bg-text-muted 完全同值（#e9eeec），两头都不对。也不用 bg-text-muted 实心灰：
                 全站只有座位表这么用过，一排浅玻璃里显得又实又脏。 -->
            <div class="mb-4 min-h-[2.5rem]">
              <Transition name="opbar-swap" mode="out-in">
                <!-- 画笔模式工具栏：进入后顶掉常规工具栏（这期间设置/排表/导入都没意义，
                     留着就是让用户误点 —— 一改几何，刚画的洞就和数据错位了）。 -->
                <div v-if="painting" key="paint" class="flex flex-wrap items-center gap-3 opbar">
                  <button @click="confirmHoleMode" :disabled="paintShortage > 0" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed" style="min-width: 7rem;"><IconGlyph name="check" :size="14" tint="current" /> 确认空位</button>
                  <button @click="clearAllHoles" class="bg-danger text-text-inverse px-4 py-2 rounded flex items-center gap-1.5" style="min-width: 7rem;"><IconGlyph name="refresh" :size="14" tint="current" /> 全清空位</button>
                  <button @click="cancelHoleMode" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5" style="min-width: 7rem;"><IconGlyph name="close" :size="14" tint="current" /> 退出（ESC）</button>
                  <span class="text-sm text-text-muted">点一格设为空位，再点一下取消；走廊格不能设。</span>
                  <span v-if="paintShortage > 0" class="text-sm text-danger">还差 {{ paintShortage }} 个座位（可用 {{ paintUsable }} / 学生 {{ allStudents.length }}）</span>
                </div>

                <!-- 工具栏：随切换段变化。两段均可「智能排表」「导入」，顺序与当前座位一致 -->
                <div v-else key="normal" class="flex flex-wrap items-center gap-3 opbar">
                  <button @click="openSettings(seatView)" @mouseenter="prefetch(loadSettingsDialog)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="settings" :size="14" tint="current" /> 设置</button>
                  <button @click="openArrangement(seatView)" @mouseenter="prefetch(loadArrangementDialog)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="brain" :size="14" tint="current" /> 智能排表</button>
                  <button @click="enterHoleModeFor(seatView)" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="layoutGrid" :size="14" tint="current" /> 设置空位</button>
                  <button @click="seatView === 'active' ? refreshActive() : refreshMaster()" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
                  <button @click="openImport(seatView)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="upload" :size="14" tint="current" /> {{ seatView === 'active' ? '从模板导入' : '从实行导入' }}</button>
                  <button @click="openExcelImport(seatView)" @mouseenter="prefetch(loadImportExcel)" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入</button>
                  <button @click="seatView === 'active' ? openActiveExport() : openMasterExport()" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 导出 Excel</button>
                </div>
              </Transition>
            </div>

            <!-- 临时表（当前座位）：表头先渲染（列头来自 useSeatGrid 默认几何，数据到位后自动校正），
                 行数据 activeLoaded 后再填——未就绪时不给行，避免空格子被误编辑后覆盖真实座位 -->
            <template v-if="seatView === 'active'">
              <GridView
                :anchorPrefix="'seat'"
                :colHeaders="activeColHeaders"
                :rows="activeLoaded ? activeDisplayRows : []"
                :hideMetaColumns="true"
                :showRowNumber="true"
                :enableCandidate="true"
                :candidateItems="allStudents"
                :candidateExcludeIds="currentEditExcludeIds"
                candidateLabelField="姓名"
                candidateIdField="id"
                candidatePlaceholder="输入姓名"
                :minTableHeight="200"
                :emptyReady="activeLoaded"
                :loadError="activeError"
                errorText="座位表加载失败"
                :paintMode="activeGrid.holeMode.value"
                :rowLabelMenu="true"
                :colLabelMenu="true"
                @paint-cell="onActivePaintCell"
                @row-label-menu="onActiveRowLabelMenu"
                @col-label-menu="onActiveColLabelMenu"
                @cell-dblclick="onActiveCellDblClick"
                @update:cells="onActiveCellsUpdate"
                @swapRows="onActiveSwapRows"
                @swapColumns="onActiveSwapColumns"
                @retry="refreshActive"
              />
              <ExportExcel v-if="activeExportMounted" :is-visible="activeExportVisible" :rows="activeExportRows" :fields="activeExportFields" defaultFilename="当前座位表" @update:is-visible="activeExportVisible = $event" />
            </template>

            <!-- 模板表（座位模板）：同临时表，表头先行、行后填 -->
            <template v-else>
              <GridView
                :anchorPrefix="'seatt'"
                :colHeaders="masterColHeaders"
                :rows="masterLoaded ? masterDisplayRows : []"
                :hideMetaColumns="true"
                :showRowNumber="true"
                :enableCandidate="true"
                :candidateItems="allStudents"
                :candidateExcludeIds="currentMasterEditExcludeIds"
                candidateLabelField="姓名"
                candidateIdField="id"
                candidatePlaceholder="输入姓名"
                :minTableHeight="200"
                :emptyReady="masterLoaded"
                :loadError="masterError"
                errorText="座位模板加载失败"
                :paintMode="masterGrid.holeMode.value"
                :rowLabelMenu="true"
                :colLabelMenu="true"
                @paint-cell="onMasterPaintCell"
                @row-label-menu="onMasterRowLabelMenu"
                @col-label-menu="onMasterColLabelMenu"
                @cell-dblclick="onMasterCellDblClick"
                @update:cells="onMasterCellsUpdate"
                @swapRows="onMasterSwapRows"
                @swapColumns="onMasterSwapColumns"
                @retry="refreshMaster"
              />
              <ExportExcel v-if="masterExportMounted" :is-visible="masterExportVisible" :rows="masterExportRows" :fields="masterExportFields" defaultFilename="座位模板" @update:is-visible="masterExportVisible = $event" />
            </template>

            <!-- 从 Excel 导入（按「行号 + 列名」匹配当前显示的座位矩阵） -->
            <ImportExcel
              v-if="importMounted"
              :visible="importVisible"
              :existingFields="importFields"
              :requiredFields="['行号']"
              :templateName="importTarget === 'master' ? '座位模板标准导入表' : '当前座位表标准导入表'"
              previewMode="grid"
              @import-data="onImportData"
              @cancel="importVisible = false"
            />

            <!-- 座位位置权重表：与座位表同构，格内填数字权重（切换之外，只一张） -->
            <div class="mt-8 mb-4 flex items-center gap-3">
              <h2 class="text-xl font-semibold text-text flex items-center gap-2 min-h-7"><IconGlyph name="chart" :size="20" /> 座位位置权重表</h2>
            </div>

            <!-- 工具栏：权重表设置 / 刷新 / 导出 -->
            <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
              <button @click="openWeightSettings()" @mouseenter="prefetch(loadWeightAlgorithmDialog)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="settings" :size="14" tint="current" /> 设置</button>
              <button @click="refreshWeight()" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
              <button @click="openWeightExport()" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 导出 Excel</button>
            </div>

            <!-- 权重表：同上，表头先行、行后填 -->
            <GridView
              :anchorPrefix="'seatw'"
              :colHeaders="weightColHeaders"
              :rows="weightLoaded ? weightDisplayRows : []"
              :hideMetaColumns="true"
              :showRowNumber="true"
              :minTableHeight="200"
              candidatePlaceholder="输入权重"
              :emptyReady="weightLoaded"
              :loadError="weightError"
              errorText="权重表加载失败"
              @update:cells="onWeightCellsUpdate"
              @swapRows="onWeightSwapRows"
              @swapColumns="onWeightSwapColumns"
              @retry="refreshWeight"
            />
            <ExportExcel v-if="weightExportMounted" :is-visible="weightExportVisible" :rows="weightExportRows" :fields="weightExportFields" defaultFilename="座位位置权重表" @update:is-visible="weightExportVisible = $event" />
          </section>
        </div>

        <div v-else-if="activeTab === 'history'" class="relative">
          <!-- 座位指数（公平账本）：每人一根长条，按所坐位置权重逐天累加，截至所选周 -->
          <div class="mb-8">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 class="text-xl font-semibold text-text flex items-center gap-2"><IconGlyph name="chart" :size="20" /> 座位指数</h2>
              <span v-if="historySnapshot" class="text-xs text-text-muted">按每人所坐位置的权重逐天累加 · 截至 {{ historySnapDate || '—' }}</span>
            </div>
            <!-- 工具栏：刷新 / 导出（与上方座位表、权重表保持同一套 opbar 写法）。
                 常驻渲染：没有快照时也保留按钮，否则用户只能从下方「座位记录」那排去操作 -->
            <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
              <button @click="refreshSeatIndex()" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
              <button @click="openSeatIndexExport()" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 导出 Excel</button>
            </div>
            <!-- 空态与座位记录区同一处理：加载中不判空（避免闪），加载完且无快照才用房统一空态。
                 高度取 188px ≈ StatBarList 5 行(140) + 卡片内边距(48)，切换时不跳高 -->
            <EmptySnapshot
              v-if="!historyLoading && !historySnapshot"
              text="暂未有历史快照，无法结算座位指数"
              icon="chart"
              min-height="188px"
            />
            <div v-else class="bg-surface rounded-lg border border-border p-6">
              <StatBarList :rows="seatIndexRows" :bar-width="seatIndexBarWidth" :value-text="(row) => row.value.toFixed(2)" empty-text="暂无座位指数数据" />
            </div>
            <ExportExcel v-if="seatIndexExportMounted" :is-visible="seatIndexExportVisible" :rows="seatIndexExportRows" :fields="seatIndexExportFields" defaultFilename="座位指数" @update:is-visible="seatIndexExportVisible = $event" />
          </div>

          <!-- 座位记录：标题 + 菜单栏（设置 / 刷新 / 导出 Excel / 补录记录） -->
          <h2 class="text-xl font-semibold text-text flex items-center gap-2 min-h-7 mb-3"><IconGlyph name="calendar" :size="20" /> 座位记录</h2>
          <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
            <button @click="openHistorySettings()" @mouseenter="prefetch(loadSeatRecordSettingsDialog)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="settings" :size="14" tint="current" /> 设置</button>
            <button @click="refreshHistory()" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
            <button @click="openHistoryExport()" class="bg-warning text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="download" :size="14" tint="current" /> 导出 Excel</button>
            <button @click="openBackfill()" @mouseenter="prefetch(loadSeatBackfillDialog)" class="bg-primary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"><IconGlyph name="clock" :size="14" tint="current" /> 补录记录</button>
          </div>

          <div class="history-swap">
            <Transition :name="slideDir">
              <div :key="historyCurrentWeek" class="history-content">
                <!-- 表头先行：加载中也渲染 GridView（列头未到位时兜底为当前座位表列头），
                     仅在「加载完且无快照」时才换 EmptySnapshot，避免表格区高度撑高再回弹 -->
                <EmptySnapshot v-if="!historyLoading && !historySnapshot" />
                <template v-else>
                  <GridView :colHeaders="historyColHeaders" :rows="historyDisplayRows" :hideMetaColumns="true" :showRowNumber="true" />
                  <p v-if="historySnapshot" class="text-xs text-text-muted mt-2">代表日期：{{ historySnapDate || '—' }}</p>
                </template>
              </div>
            </Transition>
          </div>
          <ExportExcel v-if="historyExportMounted" :is-visible="historyExportVisible" :rows="historyExportRows" :fields="historyExportFields" defaultFilename="座位记录" @update:is-visible="historyExportVisible = $event" />
          <!-- 快照菜单栏：周切换 + 下拉框 + 补存/删除按钮，同处一条毛玻璃栏 -->
          <WeekSwitcher
            v-model:currentWeek="historyCurrentWeek"
            :weeks="historyWeeks"
            @update:currentWeek="onWeekChange"
            @direction="onSwitchWeek"
          >
            <template #actions>
              <button
                @click="captureHistorySnapshot"
                class="bg-primary text-text-inverse px-3 py-1.5 rounded whitespace-nowrap cursor-pointer flex items-center gap-1.5"
              ><IconGlyph name="camera" :size="14" tint="current" /> 补存已过日期</button>
              <button
                @click="requestDeleteHistorySnapshot"
                :disabled="!canDeleteHistorySnapshot"
                class="bg-danger text-text-inverse px-3 py-1.5 rounded whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              ><IconGlyph name="trash" :size="14" tint="current" /> 删除本周快照</button>
            </template>
          </WeekSwitcher>
        </div>
      </template>
    </Tabs>

    <!-- 当前座位设置弹窗 -->
    <SeatSettingsDialog
      v-if="activeSettingsMounted"
      :visible="activeSettingsVisible"
      :rows="activeRows"
      :cols="activeCols"
      :mode="activeMode"
      @save="saveActiveSettings"
      @cancel="activeSettingsVisible = false"
    />

    <!-- 座位模板设置弹窗 -->
    <SeatSettingsDialog
      v-if="masterSettingsMounted"
      :visible="masterSettingsVisible"
      :rows="masterRows"
      :cols="masterCols"
      :mode="masterMode"
      @save="saveMasterSettings"
      @cancel="masterSettingsVisible = false"
    />

    <!-- 座位范围缩小确认弹窗 -->
    <ConfirmDialog
      v-if="shrinkConfirmMounted"
      :visible="shrinkConfirmVisible"
      message="你设置了较小的座位范围，但是外部还有座位数据，需要舍弃吗"
      type="confirm"
      :showCancel="true"
      @confirm="confirmShrink"
      @cancel="shrinkConfirmVisible = false"
    />

    <!-- 删除历史快照确认弹窗 -->
    <ConfirmDialog
      v-if="deleteSnapshotMounted"
      :visible="deleteSnapshotVisible"
      title="删除历史快照"
      :message="deleteSnapshotMessage"
      type="confirm"
      :showCancel="true"
      confirmText="删除"
      @confirm="confirmDeleteHistorySnapshot"
      @cancel="deleteSnapshotVisible = false"
    />

    <!-- 导入确认弹窗（从模板导入 / 从实行导入，内置样式） -->
    <ConfirmDialog
      v-if="importConfirmMounted"
      :visible="importConfirmVisible"
      :title="importConfirmTitle"
      :message="importConfirmMessage"
      type="confirm"
      :showCancel="true"
      confirmText="确定导入"
      @confirm="confirmImport"
      @cancel="importConfirmVisible = false"
    />

    <!-- 行标签右键菜单：插入 / 删除行走廊（座位表专有，其它表格不接管右键） -->
    <ContextMenu
      :visible="rowMenuVisible"
      :x="rowMenuX"
      :y="rowMenuY"
      :items="rowMenuItems"
      @close="rowMenuVisible = false"
    />

    <!-- 列头右键菜单：整列走廊（与行版对称，共用同一个确认框） -->
    <ContextMenu
      :visible="colMenuVisible"
      :x="colMenuX"
      :y="colMenuY"
      :items="colMenuItems"
      @close="colMenuVisible = false"
    />

    <!-- 删除行走廊确认：行里仍有学生时才弹（正常走廊行没人，可用撤销恢复） -->
    <ConfirmDialog
      v-if="aisleConfirmMounted"
      :visible="aisleConfirmVisible"
      title="删除这条走廊"
      :message="aisleConfirmMessage"
      type="confirm"
      :showCancel="true"
      confirmText="删除"
      @confirm="confirmAisleRemove"
      @cancel="aisleConfirmVisible = false"
    />

    <!-- 智能排表弹窗（按 arrangeTarget 决定作用于当前座位或座位模板） -->
    <SmartArrangementDialog
      v-if="smartArrangementMounted"
      :visible="smartArrangementVisible"
      :rows="arrangeRows"
      :cols="arrangeCols"
      :mode="arrangeMode"
      :types="arrangeTypes"
      :students="allStudents"
      :initial-seats="arrangeSeats"
      :weights="weightWeights"
      :ledger="seatLedger"
      @cancel="smartArrangementVisible = false"
      @confirm="applySmartArrangement"
    />

    <!-- 中心权重算法设置弹窗：生成权重矩阵并写回当前权重表 -->
    <WeightAlgorithmDialog
      v-if="weightAlgoMounted"
      :visible="weightAlgoVisible"
      :rows="weightRows"
      :cols="weightCols"
      @apply="onApplyWeightAlgorithm"
      @close="weightAlgoVisible = false"
    />

    <!-- 管理周座位记录弹窗：选择学期 + 周列表 + 删除 -->
    <SeatRecordSettingsDialog
      v-if="historySettingsMounted"
      :visible="historySettingsVisible"
      @close="historySettingsVisible = false"
    />

    <!-- 补录记录弹窗：周切换 + 增加周记录（周数与日期双向联动） -->
    <SeatBackfillDialog
      v-if="historyBackfillMounted"
      :visible="historyBackfillVisible"
      @close="historyBackfillVisible = false"
      @changed="onBackfillChanged"
    />
  </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { ref, computed, watch, onMounted, onActivated, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import { shiftDateStr, localDateStr } from '../utils/dateTime.js'
import { getSemesterStart } from '../utils/semesterStart.js'
import GridView from '../components/tables/GridView/GridView.vue'
import ContextMenu from '../components/base/ContextMenu.vue'
import EmptySnapshot from '../components/base/EmptySnapshot.vue'
import Tabs from '../components/base/Tabs.vue'
import ViewSwitch from '../components/base/ViewSwitch.vue'
import WeekSwitcher from '../components/base/WeekSwitcher.vue'
import StatBarList from '../components/base/StatBarList.vue'
import {
  useSeatGrid, buildSeatLikeRows, generateColHeaders,
  CELL, seatColumnIndices, gridColsToSeat, remapSeatsToGeometry, rowIsAisle,
  clearNonSeatWeights, usableSeatCount, insertAisleRow, SEAT_MAX_ROWS,
  insertAisleColumn, columnKinds, SEAT_MAX_GRID_COLS, deskActionsOfCol,
} from '../composables/useSeatGrid.js'
import { createSerialSaver } from '../utils/serialSaver.js'
import { createRowReuseCache } from '../utils/rowReuse.js'
import { useUndoShortcut, recordGridSnapshotUndo, newUndoBatchId, flushUndoStatus } from '../composables/useUndo.js'
import { useDisposables } from '../utils/disposables.js'
import { useNotification } from '../composables/useNotification.js'
import { syncStudentNamesFromRows } from '../composables/useSyncStudentNames.js'
import { applyRouteRowFocus, createRowFocusHost } from '../composables/useRowFocus.js'
import { weightHeatRgb, weightHeatFg } from '../utils/heatColor.js'

// 弹窗类组件懒加载：打开时才加载对应 chunk。loader 抽出为命名函数，
// 可用 @mouseenter="prefetch(loadXxx)" 在悬停按钮时预取，点击时即时弹出。
const ExportExcel = defineAsyncComponent(() => import('../components/import-export/ExportExcel/ExportExcel.vue'))
const loadImportExcel = () => import('../components/import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)
const loadSettingsDialog = () => import('../components/dialogs/SeatSettingsDialog.vue')
const SeatSettingsDialog = defineAsyncComponent(loadSettingsDialog)
const ConfirmDialog = defineAsyncComponent(() => import('../components/base/ConfirmDialog.vue'))
const loadArrangementDialog = () => import('../components/dialogs/SmartArrangementDialog/SmartArrangementDialog.vue')
const SmartArrangementDialog = defineAsyncComponent(loadArrangementDialog)
const loadWeightAlgorithmDialog = () => import('../components/dialogs/WeightAlgorithmDialog.vue')
const WeightAlgorithmDialog = defineAsyncComponent(loadWeightAlgorithmDialog)
const loadSeatRecordSettingsDialog = () => import('../components/dialogs/SeatRecordSettingsDialog.vue')
const SeatRecordSettingsDialog = defineAsyncComponent(loadSeatRecordSettingsDialog)
const loadSeatBackfillDialog = () => import('../components/dialogs/SeatBackfillDialog.vue')
const SeatBackfillDialog = defineAsyncComponent(loadSeatBackfillDialog)

const API_BASE = '/api'

const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = createRowFocusHost(route, router)

const activeTab = ref('seat')
const tabItems = [
  { label: '座位管理', value: 'seat' },
  { label: '历史记录', value: 'history' }
]

// 座位管理内部的视图切换：临时表（当前座位） / 模板表（座位模板）
const seatView = ref('active')
const seatViewOptions = [
  { value: 'active', label: '临时表' },
  { value: 'master', label: '模板表' }
]

// 跨页定位：标题栏全局搜索 / AI 改动明细点「座位」结果跳转 /seats?focus=seat:<行>:<列>
// （seat=当前座位 / seatt=座位模板 / seatw=权重表）→ 先切到座位页签并选中对应视图，
// 再滚动到该格子并闪动高亮。
// 列号现在是**网格列下标**（与单元格 data-row-id 同源）：走廊是真实列，
// 不再需要「真实列 → 显示列」换算。
function _applyRowFocus() {
  applyRouteRowFocus(rowFocusHost, {
    parse: (key) => {
      const m = /^(seat|seatt|seatw):(\d+):(\d+)$/.exec(key)
      if (!m) return null
      activeTab.value = 'seat'
      if (m[1] === 'seatt') seatView.value = 'master'
      else if (m[1] === 'seat') seatView.value = 'active'
      // 数据/视图尚未就绪时返回空值，交由 useRowFocus 内部重试
      if (m[1] === 'seat' && !activeLoaded.value) return null
      if (m[1] === 'seatt' && !masterLoaded.value) return null
      if (m[1] === 'seatw' && !weightLoaded.value) return null
      return key
    }
  })
}
watch(() => route.query.focus, _applyRowFocus)
onActivated(_applyRowFocus)

// ==================== 学生数据 ====================
const allStudents = ref([])
const studentMap = ref({})

function getStudentName(id) {
  return studentMap.value[id]?.姓名 || ''
}

function getStudentId(name) {
  if (!name) return null
  const student = allStudents.value.find(s => s.姓名 === name)
  return student ? student.id : null
}

async function fetchAllStudents() {
  try {
    const res = await axios.get(`${API_BASE}/students`)
    // 兼容两种正常形状（数组 / {data:数组}）；其余形状一律不覆盖现有名册，
    // 避免把 {d:密文} 之类的异常响应当成数组用，把整张座位表带崩。
    const list = Array.isArray(res.data) ? res.data : (res.data && Array.isArray(res.data.data) ? res.data.data : null)
    if (!list) { console.error('[students] 响应形状异常', res.data); return }
    allStudents.value = list
    studentMap.value = {}
    allStudents.value.forEach(s => { studentMap.value[s.id] = s })
  } catch (e) { console.error(e) }
}

// ==================== 座位网格 ====================
const activeGrid = useSeatGrid(`${API_BASE}/seats`, {
  getStudentName, getStudentId,
  undo: { key: '座位表', table: 'seat_layout' },
  cellBase: `${API_BASE}/seats/cell`
})
const masterGrid = useSeatGrid(`${API_BASE}/seats/master`, {
  getStudentName, getStudentId,
  // 与当前座位共用同一撤销栈（页面只注册了 '座位表' 快捷键），使模板操作也可 Ctrl+Z 撤销
  undo: { key: '座位表', table: 'seat_template' },
  cellBase: `${API_BASE}/seats/master/cell`
})

// 保持模板兼容的别名
const activeLoaded = activeGrid.loaded
const activeError = activeGrid.loadError
const activeRows = activeGrid.rows
const activeCols = activeGrid.cols
const activeSeats = activeGrid.seats
const activeTypes = activeGrid.types
const activeMode = activeGrid.mode
const activeSettingsVisible = activeGrid.settingsVisible
const currentEditExcludeIds = activeGrid.currentEditExcludeIds
const activeColHeaders = activeGrid.colHeaders
const activeDisplayRows = activeGrid.displayRows
const activeExportFields = activeGrid.exportFields
const activeExportRows = activeGrid.exportRows

const masterLoaded = masterGrid.loaded
const masterError = masterGrid.loadError
const masterRows = masterGrid.rows
const masterCols = masterGrid.cols
const masterSeats = masterGrid.seats
const masterTypes = masterGrid.types
const masterMode = masterGrid.mode
const masterSettingsVisible = masterGrid.settingsVisible
const currentMasterEditExcludeIds = masterGrid.currentEditExcludeIds
const masterColHeaders = masterGrid.colHeaders
const masterDisplayRows = masterGrid.displayRows
const masterExportFields = masterGrid.exportFields
const masterExportRows = masterGrid.exportRows

// ==================== 方法别名 ====================
const loadActive = activeGrid.load
const { success: notifySuccess, error: notifyError, warning: notifyWarning } = useNotification()

async function refreshActive() {
  try {
    await loadActive()
    notifySuccess('已刷新座位表')
  } catch (e) { /* 错误已在 load 内部处理 */ }
}

async function refreshMaster() {
  try {
    await loadMaster()
    notifySuccess('已刷新座位表模板')
  } catch (e) { /* 错误已在 load 内部处理 */ }
}
// ==================== 座位范围缩小确认 ====================
// 三张表（当前座位 / 座位模板 / 权重表）共用同一套「设置」（行列/模式/走廊）：
// 改任一处即同步套用到另一张座位表，并让权重表按新尺寸重整，保证权重对两表都可用。
// 当新的行数/座位列数比现状小，且被裁剪掉的区域里仍有座位数据（任一张表）时，弹确认框决定是否舍弃
// settings.cols 是「座位列数」（设置弹窗口径），与 seats 里的网格列不同口径：
// 裁掉的座位列从第 newSeatCols 个（座位序号）开始，按座位列下标去查数据。
const shrinkConfirmVisible = ref(false)
const shrinkPending = ref(null)
function hasTrimmedData(grid, { rows: nr, cols: newSeatCols }) {
  const cur = grid.seats.value
  const curRows = cur.length
  if (!curRows) return false
  const curSeatCols = seatColumnIndices(grid.cols.value, grid.types.value)
  if (nr < curRows) {
    for (let r = nr; r < curRows; r++)
      for (const c of curSeatCols)
        if (cur[r]?.[c] != null && cur[r][c] !== '') return true
  }
  for (let r = 0; r < curRows; r++) {
    for (let k = newSeatCols; k < curSeatCols.length; k++) {
      const v = cur[r]?.[curSeatCols[k]]
      if (v != null && v !== '') return true
    }
  }
  return false
}
// 把同一套设置套用到两张座位表，并让权重表按新尺寸重整后落库
async function applySharedSettings(settings) {
  // 旧几何与旧权重先快照：saveSettings 会同步改 cols/types，watch 会立刻按新尺寸
  // 把 weightWeights 裁一遍（按网格下标，几何一变就错位），所以重映射必须基于快照。
  const prevCols = weightCols.value
  const prevTypes = weightTypes.value
  const prevWeights = weightWeights.value.map(r => [...r])
  // 两张表一起改：设置是共享的，只改「当前显示」那张会让两张表几何分叉，
  // 而权重表只能跟其中一套几何 —— 分叉之后切视图权重就整体错位。
  await Promise.all([activeGrid.saveSettings(settings), masterGrid.saveSettings(settings)])
  if (!weightLoaded.value) return
  // 权重与座位数据同一套搬法：按座位列序号对齐（见 remapSeatsToGeometry）
  weightWeights.value = remapSeatsToGeometry(
    prevWeights, prevCols, prevTypes, weightRows.value, weightCols.value, weightTypes.value)
  await saveWeight()
}
async function requestSaveSettings(settings) {
  if (hasTrimmedData(activeGrid, settings) || hasTrimmedData(masterGrid, settings)) {
    shrinkPending.value = settings
    shrinkConfirmVisible.value = true
  } else {
    await applySharedSettings(settings)
  }
}
function confirmShrink() {
  const s = shrinkPending.value
  shrinkConfirmVisible.value = false
  shrinkPending.value = null
  if (s) applySharedSettings(s)
}

const saveActiveSettings = (s) => requestSaveSettings(s)

const loadMaster = masterGrid.load
// 表格输入的人名同步到学生管理：包装 onCellsUpdate，先同步再转发给网格逻辑。
// 必须 await：新名字还没进 allStudents 时，syncCellsToSeats 会把座位先落成姓名字符串；
// 等后端解析/建档完成并刷新后再转换，才能直接落成学生 id。
const wrapCellsSync = (fn) => async (newRows) => {
  await syncStudentNamesFromRows(newRows, {
    getKnown: () => allStudents.value,
    refresh: fetchAllStudents,
    notify: notifySuccess
  })
  return fn(newRows)
}
const onMasterCellsUpdate = wrapCellsSync(masterGrid.onCellsUpdate)
const onMasterSwapRows = masterGrid.onSwapRows
const onMasterSwapColumns = masterGrid.onSwapColumns
const onMasterCellDblClick = masterGrid.onCellDblClick
const onActiveCellsUpdate = wrapCellsSync(activeGrid.onCellsUpdate)
const onActiveSwapRows = activeGrid.onSwapRows
const onActiveSwapColumns = activeGrid.onSwapColumns
const onActiveCellDblClick = activeGrid.onCellDblClick
const saveMasterSettings = (s) => requestSaveSettings(s)

// ==================== 设置空位（画笔）====================
// 画笔状态挂在各自的 useSeatGrid 实例上（两张表各自独立），这里只按当前视图选择一张。
const paintGrid = computed(() => (seatView.value === 'active' ? activeGrid : masterGrid))
const painting = computed(() => paintGrid.value.holeMode.value)
const paintUsable = computed(() => paintGrid.value.usableSeats.value)
// 只有「当前座位表」受容量约束：模板是布局样板，没必要凑够本班人数
const paintShortage = computed(() => (seatView.value === 'active'
  ? Math.max(0, allStudents.value.length - paintUsable.value)
  : 0))

function enterHoleModeFor(view) {
  const target = view === 'active' ? activeGrid : masterGrid
  const other = view === 'active' ? masterGrid : activeGrid
  // 另一张表若还停在画笔模式：先丢弃它的未提交改动。
  // 两张表共用同一套几何（设置是共享的），一张没提交、另一张又进去改，会互相覆盖。
  if (other.holeMode.value) other.exitHoleMode(true)
  target.enterHoleMode()
}
// 注意：这里都先取到局部变量再调方法，不写 `paintGrid.value.xxx()` ——
// 那个形状会被 expose-contract 判据当成「组件实例代理调用」，要求方法被 defineExpose。
// paintGrid 是 composable 对象（不是组件 ref），不存在这个问题，但没必要让扫描器误报。
function cancelHoleMode() {
  const g = paintGrid.value
  g.exitHoleMode(true)
}
function clearAllHoles() {
  const g = paintGrid.value
  g.clearAllHoles()
}
async function confirmHoleMode() {
  if (paintShortage.value > 0) {
    notifyError(`还差 ${paintShortage.value} 个座位（可用 ${paintUsable.value} 个 / 学生 ${allStudents.value.length} 人）`)
    return
  }
  const g = paintGrid.value
  const ok = await g.confirmHoleMode()
  if (!ok) return
  notifySuccess('空位已保存')
  await syncWeightGeometry()
}
function paintCell(grid, { rowIdx, dataRowIdx, colIdx }) {
  // 必须用 dataRowIdx：表格显示的第 0 行是「讲台」，直接用显示行号会把洞画到下面一格。
  // 老调用方（没有 dataRowIdx）回退显示行号，行为与之前一致。
  const res = grid.toggleHoleAt(dataRowIdx ?? rowIdx, colIdx)
  if (res.ok) return
  if (res.reason === 'occupied') {
    const name = typeof res.value === 'number' ? getStudentName(res.value) : String(res.value || '')
    notifyError(`这一格有学生${name ? `（${name}）` : ''}，请先把他移走再设为空位`)
  } else if (res.reason === 'aisle') {
    notifyWarning('走廊格不能设为空位')
  }
}
const onActivePaintCell = (payload) => paintCell(activeGrid, payload)
const onMasterPaintCell = (payload) => paintCell(masterGrid, payload)

// ESC 退出画笔（等同「退出」按钮：丢弃未确认的改动）
const paintDisposables = useDisposables()
paintDisposables.listen(window, 'keydown', (e) => {
  if (e.key !== 'Escape' || !painting.value) return
  e.preventDefault()
  cancelHoleMode()
})
// 切视图/切页签时退出画笔：不退出的话那张表会一直停在画笔模式，
// 下次回来点格子会直接挖洞（而用户以为自己只是看了看）
function abortPainting() {
  if (activeGrid.holeMode.value) activeGrid.exitHoleMode(true)
  if (masterGrid.holeMode.value) masterGrid.exitHoleMode(true)
  rowMenuVisible.value = false
}
watch(seatView, abortPainting)
watch(activeTab, abortPainting)

/* ==================== 行走廊（行标签右键） ====================
 * 两个动作都是**插入 / 删除整行**，不改动被右键那一行：
 *   · 在上方 / 下方插入走廊 —— 新走廊占一行，下面各排整体后移，原来的学生位置不变
 *   · 删除这条走廊 —— 行数 -1（旧版本「把某行覆盖成走廊」留下的行也能这样删掉）
 * 早先的做法是「把这一行变成走廊」，会把那一排学生直接移出座位表；而用户多数
 * 只是想「在这儿加一条过道」，不该顺手动他排好的学生。
 * 走廊由 types 表达，保存走整块提交（seats + types + rows）。
 * 只在当前座位 / 座位模板两张表上开放 —— 权重表没有「走廊」语义。 */
const rowMenuVisible = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rowMenuRowIdx = ref(-1)
const rowMenuTarget = ref('active')

const rowMenuGrid = computed(() => (rowMenuTarget.value === 'master' ? masterGrid : activeGrid))
const rowMenuIsAisle = computed(() => rowIsAisle(rowMenuGrid.value.types.value, rowMenuRowIdx.value))

// 走廊行多一项「删除这条走廊」：删除是「撤销一次插入」，不提供「变回座位行」——
// 那会让行数变多，几何反而比插入前更复杂（用户想加座位应该去设置里改行数）。
const rowMenuItems = computed(() => {
  const items = [
    { label: '在上方插入走廊', action: () => applyAisleInsert('above') },
    { label: '在下方插入走廊', action: () => applyAisleInsert('below') },
  ]
  if (rowMenuIsAisle.value) items.push({ label: '删除这条走廊', action: () => askAisleRemove() })
  return items
})

function openRowMenu(payload, target) {
  rowMenuTarget.value = target
  // 同 paintCell：改 types 用数据行号（讲台行不算），否则操作会落到下一行
  rowMenuRowIdx.value = payload.dataRowIdx ?? payload.rowIdx
  rowMenuX.value = payload.x
  rowMenuY.value = payload.y
  rowMenuVisible.value = true
}

const onActiveRowLabelMenu = (payload) => openRowMenu(payload, 'active')
const onMasterRowLabelMenu = (payload) => openRowMenu(payload, 'master')

// 删除走廊前的确认框（走廊格本来没人，只有历史脏数据才会走到这里）
const aisleConfirmMounted = ref(false)
const aisleConfirmVisible = ref(false)
const aisleConfirmMessage = ref('')
watch(() => aisleConfirmVisible.value, (v) => { if (v) aisleConfirmMounted.value = true })

// 权重矩阵同步插 / 删一行。
// weightRows 是「当前显示段 rows」的派生，rows 一变，watch(weightRows) 里的 resizeWeights
// 就按网格下标裁补 —— 它不认识「中间插了一行」，直接改 rows 会把下面各行的权重整体上移一格。
// 所以必须**先**把矩阵对齐，再让座位表改 rows（对齐之后 resizeWeights 就是无损重建）。
// 返回被移走的那一行，便于失败时原样插回。
function shiftWeightRows(at, delta) {
  if (!weightLoaded.value) return null
  const width = weightCols.value
  const blank = () => new Array(width).fill(null)
  const src = weightWeights.value
  const out = []
  let removed = null
  for (let r = 0; r < src.length; r++) {
    if (delta < 0 && r === at) { removed = Array.isArray(src[r]) ? [...src[r]] : blank(); continue }
    if (delta > 0 && r === at) out.push(blank())
    out.push(Array.isArray(src[r]) ? [...src[r]] : blank())
  }
  if (delta > 0 && at >= src.length) out.push(blank())
  weightWeights.value = out
  return removed
}

function restoreWeightRow(at, line) {
  if (!weightLoaded.value) return
  const width = weightCols.value
  const out = weightWeights.value.map((r) => (Array.isArray(r) ? [...r] : new Array(width).fill(null)))
  out.splice(at, 0, line ? [...line] : new Array(width).fill(null))
  weightWeights.value = out
}

async function applyAisleInsert(where) {
  rowMenuVisible.value = false
  if (rowMenuRowIdx.value < 0) return
  const at = where === 'above' ? rowMenuRowIdx.value : rowMenuRowIdx.value + 1
  // 容量预判：插入一条走廊 = 这一排座位消失。坐不下就别让用户白点一次
  // （后端 assertSeatCapacity 也会拦，但那句「座位保存失败」看不出是座位不够）。
  // 用**当前座位表**算：容量守卫只约束 seat_layout，模板是布局样板，不绑本班人数。
  const preview = insertAisleRow(
    activeGrid.types.value, activeGrid.seats.value, activeGrid.rows.value, activeGrid.cols.value, at)
  const usable = usableSeatCount(preview.types)
  const need = allStudents.value.length
  if (need - usable > 0) {
    notifyError(`插入走廊后可用座位只有 ${usable} 个，还差 ${need - usable} 个（学生 ${need} 人）`)
    return
  }
  shiftWeightRows(at, +1)
  // 两张座位表一起插：几何是共享的（设置改一处两张表都跟着走），只插当前这张会让 rows 分叉，
  // 下次进页面「统一设置」会按当前表把另一张 reshape 回去 —— 那条刚插的走廊就静默消失了。
  // 两笔共用一个撤销批次：不然按一次 Ctrl+Z 只撤掉其中一张（还往往是没在显示的那张），
  // 用户看到界面毫无变化，会以为撤销坏了。
  const origin = newUndoBatchId()
  const results = await Promise.all([
    activeGrid.insertAisleRowAt(at, { origin }),
    masterGrid.insertAisleRowAt(at, { origin }),
  ])
  if (results.some((r) => !r.ok)) {
    shiftWeightRows(at, -1)
    // 成功那张表可能已经落库：三张表全部按库里真实状态拉一遍，别让界面留着一半新一半旧
    await Promise.all([loadActive(), loadMaster(), loadWeight()])
    notifyError(results.some((r) => r.reason === 'limit')
      ? `座位行数已达上限（${SEAT_MAX_ROWS} 行）`
      : '插入走廊失败')
    return
  }
  flushUndoStatus()
  await syncWeightGeometry()
  notifySuccess(where === 'above' ? '已在上方插入走廊' : '已在下方插入走廊')
}

// 确认框弹着的时候用户可能又去右键别的行（rowMenuRowIdx 会被覆盖），
// 所以把「要删哪一行」在弹框前存下来，确认时用它，别再读 rowMenuRowIdx。
const aisleRemoveAt = ref(-1)
// 同一个确认框服务「删行走廊」与「删列走廊」：点确认时按 kind 分流，
// 不要各开一个 ref 各配一个弹窗（两份状态会让「点了确认没反应」这种问题多一倍）
const aisleConfirmKind = ref('row')
const aisleRemoveCol = ref(-1)

function askAisleRemove() {
  rowMenuVisible.value = false
  const at = rowMenuRowIdx.value
  const g = rowMenuGrid.value
  if (at < 0) return
  if (g.rows.value <= 1) {
    notifyWarning('至少要保留一行，无法再删')
    return
  }
  const n = g.rowStudentCount(at)
  if (!n) { applyAisleRemove(at); return }
  aisleRemoveAt.value = at
  aisleConfirmKind.value = 'row'
  // 行标签对走廊行已经显示「走廊」，这里跟着用同一个说法，别再冒出「第 N 行」
  //（那行标签上根本没有数字，用户对不上是哪一个）
  aisleConfirmMessage.value = `这条走廊里有 ${n} 名学生，删除它会让他们离开座位表（可用撤销恢复）。确定吗？`
  aisleConfirmVisible.value = true
}

function confirmAisleRemove() {
  aisleConfirmVisible.value = false
  if (aisleConfirmKind.value === 'col') {
    applyAisleColRemove(aisleRemoveCol.value)
    return
  }
  applyAisleRemove(aisleRemoveAt.value)
}

async function applyAisleRemove(at) {
  rowMenuVisible.value = false
  if (!Number.isInteger(at) || at < 0) return
  const g = rowMenuGrid.value
  if (g.rows.value <= 1) { notifyWarning('至少要保留一行，无法再删'); return }
  const removed = shiftWeightRows(at, -1)
  const origin = newUndoBatchId()
  const results = await Promise.all([
    activeGrid.removeRowAt(at, { origin }),
    masterGrid.removeRowAt(at, { origin }),
  ])
  if (results.some((r) => !r.ok)) {
    restoreWeightRow(at, removed)
    await Promise.all([loadActive(), loadMaster(), loadWeight()])
    notifyError('删除走廊失败')
    return
  }
  flushUndoStatus()
  await syncWeightGeometry()
  notifySuccess('已删除这条走廊')
}

/* ==================== 整列走廊（列头右键） ====================
 * 与行版对称：插入一条走廊列，**不动左右两列的学生**（他们只是网格下标后移一格，
 * 座位列序号不变，所以权重矩阵也不需要重映射）。删除走廊列时整列一起消失。
 * 走廊由 types 表达，保存走整块提交（seats + types + cols）。
 * 只在当前座位 / 座位模板两张表上开放 —— 权重表没有「走廊」语义。 */
const colMenuVisible = ref(false)
const colMenuX = ref(0)
const colMenuY = ref(0)
const colMenuColIdx = ref(-1)
const colMenuTarget = ref('active')

const colMenuGrid = computed(() => (colMenuTarget.value === 'master' ? masterGrid : activeGrid))
// colIdx 是网格列下标（含走廊列），与 types 同下标，直接拿去查 columnKinds 即可
const colMenuIsAisle = computed(() => {
  const g = colMenuGrid.value
  return columnKinds(g.cols.value, g.types.value)[colMenuColIdx.value] === 'aisle'
})

// 桌型动作全部由「走廊在哪」派生（几何纯函数），菜单不再自己拼判据：
// 拆桌 = 在两列之间插一条走廊，合并 = 删掉中间那条走廊。
// **两侧都要给**：拆完之后，被拆出来的左半张桌与右半张桌都该能右键「合并同桌」；
// 只判右侧的话，右键右半张桌会删掉再右边那条走廊，把隔壁那列并过来。
const colMenuDeskActions = computed(() => {
  const g = colMenuGrid.value
  return deskActionsOfCol(g.cols.value, g.types.value, g.mode.value, colMenuColIdx.value)
})

const colMenuItems = computed(() => {
  const items = [
    { label: '在左侧插入走廊', action: () => applyAisleColInsert('left') },
    { label: '在右侧插入走廊', action: () => applyAisleColInsert('right') },
  ]
  if (colMenuIsAisle.value) {
    items.push({ label: '删除这条走廊', action: () => askAisleColRemove() })
  } else {
    const { splitAt, mergeLeftAt, mergeRightAt } = colMenuDeskActions.value
    // 这两项本质上就是「插/删一条走廊」，但会顺带把模式切成 mixed ——
    // 用户要求「只要动了合并按钮，设置里就显示混合桌」。
    if (splitAt >= 0) {
      items.push({
        label: '拆成两张单人桌（插入走廊）',
        action: () => applyAisleColInsert('right', { at: splitAt, mode: 'mixed', success: '已拆成两张单人桌' }),
      })
    }
    // 方向写进文案：混排里左右两边可能都能合，不写方向用户不知道会并哪一列
    if (mergeRightAt >= 0) {
      items.push({ label: '与右侧一列合并同桌', action: () => applyDeskMerge(mergeRightAt) })
    }
    if (mergeLeftAt >= 0) {
      items.push({ label: '与左侧一列合并同桌', action: () => applyDeskMerge(mergeLeftAt) })
    }
  }
  return items
})
function openColMenu(payload, target) {
  colMenuTarget.value = target
  colMenuColIdx.value = payload.colIdx
  colMenuX.value = payload.x
  colMenuY.value = payload.y
  colMenuVisible.value = true
}

const onActiveColLabelMenu = (payload) => openColMenu(payload, 'active')
const onMasterColLabelMenu = (payload) => openColMenu(payload, 'master')

// 权重矩阵插 / 删一列。与 shiftWeightRows 同一个理由：weightCols 是 cols 的派生，
// cols 一变 watch 里的 resizeWeights 就按网格下标裁补 —— 它不认识「中间插了一列」，
// 直接改 cols 会把右边各列权重整体左移一格。所以**先**对齐矩阵，再让座位表改 cols。
// 返回被删掉的那一列（每行一个值），失败时原样插回。
function shiftWeightCols(at, delta) {
  if (!weightLoaded.value) return null
  const width = weightCols.value
  const height = Math.max(weightRows.value, (weightWeights.value || []).length)
  const blank = () => new Array(width).fill(null)
  const out = []
  let removed = null
  for (let r = 0; r < height; r++) {
    const line = Array.isArray(weightWeights.value[r]) ? [...weightWeights.value[r]] : blank()
    while (line.length < width) line.push(null)
    if (delta < 0) {
      const [v] = line.splice(at, 1)
      if (!removed) removed = []
      removed.push(v ?? null)
    } else {
      line.splice(at, 0, null)
    }
    out.push(line)
  }
  weightWeights.value = out
  return removed
}

function restoreWeightCol(at, removed) {
  if (!weightLoaded.value) return
  const width = weightCols.value
  weightWeights.value = weightWeights.value.map((r, i) => {
    const line = Array.isArray(r) ? [...r] : new Array(width).fill(null)
    while (line.length < width) line.push(null)
    line.splice(at, 0, removed?.[i] ?? null)
    return line
  })
}

async function applyAisleColInsert(where, opts = {}) {
  colMenuVisible.value = false
  if (colMenuColIdx.value < 0) return
  // 拆桌动作会带 at（几何纯函数算出的那条走廊位置），普通左/右插入仍按右键列推
  const at = Number.isInteger(opts.at)
    ? opts.at
    : (where === 'left' ? colMenuColIdx.value : colMenuColIdx.value + 1)
  // 容量预判：多一条走廊列 = 每排少一个座位。用当前座位表算（容量守卫只约束 seat_layout）
  const preview = insertAisleColumn(
    activeGrid.types.value, activeGrid.seats.value, activeGrid.rows.value, activeGrid.cols.value, at)
  const usable = usableSeatCount(preview.types)
  const need = allStudents.value.length
  if (need - usable > 0) {
    notifyError(`插入走廊后可用座位只有 ${usable} 个，还差 ${need - usable} 个（学生 ${need} 人）`)
    return
  }
  shiftWeightCols(at, +1)
  // 两张座位表一起插（几何共享，只插一张下次进页面会被「统一设置」reshape 回去），
  // 两笔共用一个撤销批次（一次 Ctrl+Z 整批退回）
  const origin = newUndoBatchId()
  const results = await Promise.all([
    activeGrid.insertAisleColAt(at, { origin, ...opts }),
    masterGrid.insertAisleColAt(at, { origin, ...opts }),
  ])
  if (results.some((r) => !r.ok)) {
    shiftWeightCols(at, -1)
    await Promise.all([loadActive(), loadMaster(), loadWeight()])
    notifyError(results.some((r) => r.reason === 'limit')
      ? `座位列数已达上限（${SEAT_MAX_GRID_COLS} 列）`
      : '插入走廊失败')
    return
  }
  flushUndoStatus()
  await syncWeightGeometry()
  notifySuccess(opts.success || (where === 'left' ? '已在左侧插入走廊' : '已在右侧插入走廊'))
}

function applyDeskMerge(at) {
  const g = colMenuGrid.value
  if (g.colStudentCount(at) > 0) {
    notifyWarning('这条走廊里有学生，请先清空再合并')
    return
  }
  applyAisleColRemove(at, { mode: 'mixed', success: '已合并同桌' })
}

function askAisleColRemove() {
  colMenuVisible.value = false
  const at = colMenuColIdx.value
  const g = colMenuGrid.value
  if (at < 0) return
  if (g.cols.value <= 1) {
    notifyWarning('至少要保留一列，无法再删')
    return
  }
  const n = g.colStudentCount(at)
  if (!n) { applyAisleColRemove(at); return }
  aisleRemoveCol.value = at
  aisleConfirmKind.value = 'col'
  aisleConfirmMessage.value = `这条走廊里有 ${n} 名学生，删除它会让他们离开座位表（可用撤销恢复）。确定吗？`
  aisleConfirmVisible.value = true
}

async function applyAisleColRemove(at, opts = {}) {
  colMenuVisible.value = false
  if (!Number.isInteger(at) || at < 0) return
  const g = colMenuGrid.value
  if (g.cols.value <= 1) { notifyWarning('至少要保留一列，无法再删'); return }
  const removed = shiftWeightCols(at, -1)
  const origin = newUndoBatchId()
  const results = await Promise.all([
    activeGrid.removeColAt(at, { origin, ...opts }),
    masterGrid.removeColAt(at, { origin, ...opts }),
  ])
  if (results.some((r) => !r.ok)) {
    restoreWeightCol(at, removed)
    await Promise.all([loadActive(), loadMaster(), loadWeight()])
    notifyError('删除走廊失败')
    return
  }
  flushUndoStatus()
  await syncWeightGeometry()
  notifySuccess(opts.success || '已删除这条走廊')
}

// 点页面任意处收起右键菜单（Menu 自己只监听滚动/缩放）。
// 用 click 而不是 mousedown：右键本身不触发 click，菜单刚弹出不会被自己关掉。
paintDisposables.listen(document, 'click', () => {
  rowMenuVisible.value = false
  colMenuVisible.value = false
})

function openSettings(target) {
  if (target === 'active') {
    activeSettingsVisible.value = true
  } else {
    masterSettingsVisible.value = true
  }
}

const smartArrangementVisible = ref(false)
// 智能排表目标：'active' 临时表（当前座位） / 'master' 模板表（座位模板）
const arrangeTarget = ref('active')
// 排表弹窗与座位表同口径（网格坐标 + types）：走廊是真实列，弹窗自己负责压/展开。
const arrangeRows = computed(() => (arrangeTarget.value === 'active' ? activeRows.value : masterRows.value))
const arrangeMode = computed(() => (arrangeTarget.value === 'active' ? activeMode.value : masterMode.value))
const arrangeCols = computed(() => (arrangeTarget.value === 'active' ? activeCols.value : masterCols.value))
const arrangeTypes = computed(() => (arrangeTarget.value === 'active' ? activeTypes.value : masterTypes.value))
const arrangeSeats = computed(() => (arrangeTarget.value === 'active' ? activeSeats.value : masterSeats.value))
function openArrangement(target) {
  arrangeTarget.value = target
  loadSeatLedger()
  smartArrangementVisible.value = true
}

// 导出弹窗可见状态（受控模式配合 v-if 实现懒加载）
const activeExportVisible = ref(false)
const masterExportVisible = ref(false)

// 懒加载弹窗保活：首次打开后保持挂载，关闭只降 visible，保留退出动画
const activeSettingsMounted = ref(false)
const masterSettingsMounted = ref(false)
const shrinkConfirmMounted = ref(false)
const smartArrangementMounted = ref(false)
const activeExportMounted = ref(false)
const masterExportMounted = ref(false)
watch(() => activeSettingsVisible.value, v => { if (v) activeSettingsMounted.value = true })
watch(() => masterSettingsVisible.value, v => { if (v) masterSettingsMounted.value = true })
watch(() => shrinkConfirmVisible.value, v => { if (v) shrinkConfirmMounted.value = true })
watch(() => smartArrangementVisible.value, v => { if (v) smartArrangementMounted.value = true })
watch(() => activeExportVisible.value, v => { if (v) activeExportMounted.value = true })
watch(() => masterExportVisible.value, v => { if (v) masterExportMounted.value = true })

// 导出座位表：无座位数据时直接提示，不弹导出选项弹窗
function hasSeatData(seatRows) {
  return (seatRows || []).some(r => Array.isArray(r) && r.some(v => v !== null && v !== undefined && v !== ''))
}
function openActiveExport() {
  if (!hasSeatData(activeSeats.value)) return useNotification().info('暂无座位数据可导出')
  activeExportVisible.value = true
}
function openMasterExport() {
  if (!hasSeatData(masterSeats.value)) return useNotification().info('座位模板为空，无法导出')
  masterExportVisible.value = true
}

// ==================== 从 Excel 导入（按「行号 + 列名」匹配当前显示的矩阵） ====================
// 导入是在现有座位表上覆盖文件里出现的格子：文件里的空单元格会清空对应座位，
// 文件未包含的行保持原样。行号/列名必须与当前页面一致，避免把数据写到错误的座位。
const importVisible = ref(false)
const importMounted = ref(false)
const importTarget = ref('active')
watch(importVisible, (n) => { if (n) importMounted.value = true })
const importFields = computed(() => {
  const grid = importTarget.value === 'master' ? masterGrid : activeGrid
  return [{ name: '行号' }, ...grid.colHeaders.value.filter(h => h !== '走廊').map(h => ({ name: h }))]
})
function openExcelImport(target) {
  importTarget.value = target
  importVisible.value = true
}
async function onImportData({ fields, rows }) {
  importVisible.value = false
  const grid = importTarget.value === 'master' ? masterGrid : activeGrid
  if (!grid.loaded.value) return notifyError('座位表尚未加载完成，请稍后再试')

  const headers = grid.colHeaders.value
  const rowsCount = Number(grid.rows.value) || 0
  const colsCount = Number(grid.cols.value) || 0

  // 以当前座位为底稿，只覆盖文件里出现的格子。
  // 表头下标就是网格列下标（走廊是真实列），不需要任何换算。
  const next = []
  for (let r = 0; r < rowsCount; r++) {
    const src = grid.seats.value[r] || []
    const row = []
    for (let c = 0; c < colsCount; c++) row.push(src[c] === undefined ? null : src[c])
    next.push(row)
  }

  const objects = rows.map(row => {
    const obj = {}
    fields.forEach((name, i) => { obj[name] = String(row[i] ?? '').trim() })
    return obj
  })

  const errors = []
  let touched = 0
  objects.forEach((obj, idx) => {
    const label = obj['行号']
    if (!label) return
    const row = grid.displayRows.value.find(r => r.label === label)
    if (!row || row._isPodium) {
      errors.push(`第 ${idx + 1} 行：找不到座位行「${label}」`)
      return
    }
    const r = row._lessonIdx
    if (r == null || r < 0 || r >= rowsCount) {
      errors.push(`第 ${idx + 1} 行「${label}」超出当前座位表范围`)
      return
    }
    headers.forEach((h, d) => {
      if (h === '走廊') return
      const val = obj[h]
      if (val === undefined) return
      next[r][d] = (val === '' || val === '走廊') ? null : val
      touched += 1
    })
  })

  if (errors.length) {
    notifyError(errors[0] + (errors.length > 1 ? `（共 ${errors.length} 处不匹配）` : ''))
    return
  }
  if (touched === 0) {
    notifyError('没有匹配到可导入的座位，请检查行号与列名是否与页面一致')
    return
  }

  const before = (grid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
  const ok = await grid.saveSeats(next)
  if (!ok) return
  recordGridSnapshotUndo('座位表', importTarget.value === 'master' ? 'seat_template' : 'seat_layout', before, next, '从 Excel 导入')
  notifySuccess(`已从 Excel 导入${importTarget.value === 'master' ? '座位模板' : '当前座位表'}`)
}

async function applySmartArrangement(result) {
  smartArrangementVisible.value = false
  const toMaster = arrangeTarget.value === 'master'
  const grid = toMaster ? masterGrid : activeGrid
  const undoTable = toMaster ? 'seat_template' : 'seat_layout'
  try {
    // 弹窗产出的已是网格（走廊/空位格恒 null），与库里 seats 同构，直接落库
    const nextSeats = result.seats
    // 记录整块快照，撤销可一键恢复智能排表前的布局
    const before = (grid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
    await grid.saveSeats(nextSeats)
    recordGridSnapshotUndo('座位表', undoTable, before, nextSeats, '智能排表')
    notifySuccess('已应用智能排表')
  } catch (e) {
    // 原实现在 catch 里仍调 notifySuccess('应用失败')：明明是失败却弹绿色成功条，
    // 用户会以为座位已生效（实际没写库）。改为错误提示并保留控制台细节。
    notifyError('应用智能排表失败，座位未保存')
    console.error(e)
  }
}

// 导入确认弹窗（从模板导入 / 从实行导入 共用内置样式）
const importConfirmVisible = ref(false)
const importConfirmMounted = ref(false)
const importConfirmAction = ref('active')
watch(() => importConfirmVisible.value, v => { if (v) importConfirmMounted.value = true })
const importConfirmTitle = computed(() => (importConfirmAction.value === 'master' ? '从实行导入' : '从模板导入'))
const importConfirmMessage = computed(() => (importConfirmAction.value === 'master'
  ? '确定用当前座位覆盖座位模板吗？覆盖后可用 Ctrl+Z 撤销。'
  : '确定用座位模板覆盖当前座位吗？覆盖后可用 Ctrl+Z 撤销。'))
function openImport(target) {
  importConfirmAction.value = target
  importConfirmVisible.value = true
}
function confirmImport() {
  importConfirmVisible.value = false
  if (importConfirmAction.value === 'master') doApplyActiveToMaster()
  else doApplyMasterToActive()
}

async function doApplyMasterToActive() {
  try {
    const before = (activeGrid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
    await axios.post(`${API_BASE}/seats/apply-master`)
    await loadActive()
    const after = (activeGrid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
    recordGridSnapshotUndo('座位表', 'seat_layout', before, after, '从模板导入')
    notifySuccess('已应用模板')
  } catch (e) { notifyError('应用失败'); console.error(e) }
}

// 反向：把当前座位（临时表）整块导入到座位模板（纯前端复制，无后端接口）
async function doApplyActiveToMaster() {
  try {
    const before = (masterGrid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
    const src = (activeGrid.seats.value || []).map(r => Array.isArray(r) ? [...r] : r)
    // 同步尺寸、模式与格子类型，使模板与当前座位完全一致
    // （types 必须一起搬：只搬 seats 会让走廊列/空位对不上，写入直接被形状守卫拒掉）
    masterGrid.rows.value = activeGrid.rows.value
    masterGrid.cols.value = activeGrid.cols.value
    masterGrid.mode.value = activeGrid.mode.value
    masterGrid.types.value = activeGrid.types.value.map(r => [...r])
    const ok = await masterGrid.saveSeats(src)
    // saveSeats 内部已提示失败并重新 load 回滚界面：
    // 这里不能再报成功，也不该登记一条根本没生效的撤销
    if (!ok) return
    recordGridSnapshotUndo('座位表', 'seat_template', before, src, '从实行导入')
    notifySuccess('已从当前座位导入')
  } catch (e) { notifyError('导入失败'); console.error(e) }
}

// ==================== 座位位置权重表 ====================
// 外观与座位表同构（讲台行 + 走廊列），格内填数字权重，可编辑并持久化。
// 尺寸（行列/走廊）跟随当前显示段（临时表 / 模板表），权重单独存储为数字矩阵。
// 取值范围 0–1（小数），不可自定义。
const WEIGHT_MIN = 0
const WEIGHT_MAX = 1
const weightLoaded = ref(false)
const weightError = ref(false)
const weightWeights = ref([]) // rows×cols 数字矩阵（网格下标，与座位表同一套），null 表示空
// 行对象复用缓存：编辑一格权重时只重建真正变化的那一行，避免整表重画
const reuseWeightRows = createRowReuseCache()
// 座位指数账本：学生 id → 截至「今日之前」累计的座位权重（供「位置公平」排表使用）
const seatLedger = ref({})
const weightRows = computed(() => (seatView.value === 'active' ? activeRows.value : masterRows.value))
const weightCols = computed(() => (seatView.value === 'active' ? activeCols.value : masterCols.value))
const weightMode = computed(() => (seatView.value === 'active' ? activeMode.value : masterMode.value))
// 权重表的几何（走廊/空位在哪）始终跟随当前显示段的座位表：几何只有**一个**真相源，
// 权重表单独存一份只用于落库，读回来也不采信（见 loadWeight 注释）。
const weightTypes = computed(() => (seatView.value === 'active' ? activeTypes.value : masterTypes.value))
const weightColHeaders = computed(() => (seatView.value === 'active' ? activeColHeaders.value : masterColHeaders.value))
// 表内最大值：热力图按「当前表内最大值」做相对映射（表内最高值最深蓝）
const weightMax = computed(() => {
  let m = 0
  for (const row of weightWeights.value) {
    if (!Array.isArray(row)) continue
    for (const v of row) if (typeof v === 'number' && v > m) m = v
  }
  return m
})


const weightDisplayRows = computed(() => reuseWeightRows(buildSeatLikeRows(
  weightRows.value, weightCols.value, weightTypes.value,
  (r, c) => {
    const w = weightWeights.value[r]?.[c]
    // 数字须以字符串传入，避免 0 被 GridView 的 `course || ''` 当空
    if (w == null || w === '') return { course: '' }
    const t = weightMax.value > 0 ? w / weightMax.value : 0
    return { course: String(w), extra: { _bg: `rgb(${weightHeatRgb(t).join(', ')})`, _fg: weightHeatFg(t) } }
  }
)))

// 尺寸（当前显示段的行列）变化时，把权重矩阵规整到 rows×cols：保留重叠、超出截断、不足补 null
function resizeWeights() {
  const next = []
  for (let r = 0; r < weightRows.value; r++) {
    const row = []
    for (let c = 0; c < weightCols.value; c++) {
      const v = weightWeights.value[r]?.[c]
      row.push(v == null ? null : v)
    }
    next.push(row)
  }
  weightWeights.value = next
}
watch([weightRows, weightCols], resizeWeights)

async function loadWeight() {
  try {
    const res = await axios.get(`${API_BASE}/seats/weight`)
    // 只取数字矩阵；几何（types）不采信后端的副本 —— 回到「座位表是几何唯一真相源」，
    // 两份 types 一旦分叉就会出现「改了座位设置、权重表还按老走廊摆」的错位。
    weightWeights.value = res.data.weights || []
    weightLoaded.value = true
    weightError.value = false
  } catch (e) { console.error(e); weightError.value = true }
}

// 刷新权重表：重新从后端拉取权重矩阵（与其他两张表的「刷新」一致）
async function refreshWeight() {
  try {
    await loadWeight()
    notifySuccess('已刷新座位位置权重表')
  } catch (e) { /* 错误已在 load 内部处理 */ }
}

// 权重表保存：与 DutyView.saveWeight 同口径——串行保存防并发乱序；
// 失败必须提示并重拉回滚：界面已就地改过、库里没改，只 console 的话用户以为保存成功，
// 刷新后权重改动「凭空消失」。
// types 一起提交：后端在「已有 types」时拒绝单独改 cols 的写入。
const weightSaver = createSerialSaver(() => axios.put(`${API_BASE}/seats/weight`, {
  mode: weightMode.value,
  rows: weightRows.value,
  cols: weightCols.value,
  weights: weightWeights.value,
  types: weightTypes.value,
}))
async function saveWeight() {
  const ok = await weightSaver.request()
  if (ok) return true
  console.error('[seat] 权重保存失败', weightSaver.error)
  notifyError('权重保存失败，改动未保存')
  try { await loadWeight() } catch (_) { /* 回滚也失败时保持提示，不叠加错误 */ }
  return false
}

// 座位几何变了（整行走廊 / 空位画笔）之后同步权重表，做两件事：
//  1. 按新 types 洗一遍权重矩阵：走廊格、空位格恒 null。界面上这些格子不显示权重
//     （course 被替换成「走廊」/空位标记），所以残留的数字平时看不见 —— 一旦取消走廊
//     它们就会"冒回来"，看着像新填的权重。
//  2. 把新的 types 一起写回 seat_weight：库里那份几何副本平时不采信（读回时用座位表的），
//     但它是后端形状守卫的依据，只在用户编辑权重时才更新会一直落后于座位表。
// 权重还没加载成功时直接返回：拿空矩阵写回去等于把整张权重表清空。
async function syncWeightGeometry() {
  if (!weightLoaded.value) return
  weightWeights.value = clearNonSeatWeights(
    weightWeights.value, weightRows.value, weightCols.value, weightTypes.value)
  await saveWeight()
}

// 编辑单元格：按网格下标写入，走廊/空位格恒为 null（几何由 types 表达，不放权重）。
// 空或非数字 → null，其余限定 0–1。
function onWeightCellsUpdate(newRows) {
  const prev = weightWeights.value.map(r => [...r])
  const next = weightWeights.value.map(r => (Array.isArray(r) ? [...r] : []))
  for (const row of newRows) {
    const r = row._lessonIdx
    if (r == null || r < 0) continue
    if (!Array.isArray(next[r])) next[r] = new Array(weightCols.value).fill(null)
    for (let c = 0; c < row.cells.length; c++) {
      const t = weightTypes.value[r]?.[c]
      if (t === CELL.AISLE || t === CELL.BLANK) { next[r][c] = null; continue }
      const raw = row.cells[c]?.course
      const text = (raw == null ? '' : String(raw)).trim()
      const num = text === '' ? null : Number(text)
      next[r][c] = Number.isFinite(num) ? Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, num)) : null
    }
  }
  weightWeights.value = next
  recordGridSnapshotUndo('座位表', 'seat_weight', prev, next, '编辑权重')
  saveWeight()
}

function onWeightSwapRows(fromIdx, toIdx) {
  if (fromIdx === 0 || toIdx === 0) return
  if (fromIdx === toIdx) return
  const from = fromIdx - 1, to = toIdx - 1
  if (from < 0 || to < 0 || from >= weightWeights.value.length || to >= weightWeights.value.length) return
  // 行走廊行不参与交换（与座位表同规则：只搬数据不搬走廊会错位）
  const aisleRow = (r) => (weightTypes.value[r] || []).every(v => v === CELL.AISLE)
  if (aisleRow(from) || aisleRow(to)) return
  const prev = weightWeights.value.map(r => [...r])
  const next = weightWeights.value.map(r => [...r])
  // 移动语义：取出源行插入目标位置
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  weightWeights.value = next
  recordGridSnapshotUndo('座位表', 'seat_weight', prev, next, '移动行')
  saveWeight()
}

function onWeightSwapColumns(fromCol, toCol) {
  if (fromCol === toCol) return
  // 走廊列与「含走廊格的列」都不参与（列下标即网格下标，无需换算）
  const colHasAisle = (c) => (weightTypes.value || []).some(line => Array.isArray(line) && line[c] === CELL.AISLE)
  if (colHasAisle(fromCol) || colHasAisle(toCol)) return
  const prev = weightWeights.value.map(r => [...r])
  // 移动语义：取出源列插入目标位置（表头固定不动）
  const next = weightWeights.value.map(r => {
    const nr = [...r]
    const [moved] = nr.splice(fromCol, 1)
    nr.splice(toCol, 0, moved)
    return nr
  })
  weightWeights.value = next
  recordGridSnapshotUndo('座位表', 'seat_weight', prev, next, '移动列')
  saveWeight()
}

// ---------- 权重表导出 ----------
const weightExportVisible = ref(false)
const weightExportMounted = ref(false)
watch(() => weightExportVisible.value, v => { if (v) weightExportMounted.value = true })
const weightExportFields = computed(() => {
  const fields = [{ name: '行号' }]
  weightColHeaders.value.forEach(h => fields.push({ name: h }))
  return fields
})
const weightExportRows = computed(() => {
  const headers = weightColHeaders.value
  return weightDisplayRows.value.map(row => {
    if (row._isPodium) return { '行号': '讲台', _isPodium: true, label: '讲  台' }
    const obj = { '行号': row.label }
    row.cells.forEach((cell, idx) => {
      const headerName = headers[idx] || `列${idx + 1}`
      if (cell._isAisle || cell._isAisleHidden) { obj[headerName] = '走廊'; obj._aisleCell = true }
      else obj[headerName] = cell.course || ''
    })
    return obj
  })
})
function openWeightExport() {
  const hasData = weightWeights.value.some(r => Array.isArray(r) && r.some(v => v != null && v !== ''))
  if (!hasData) return useNotification().info('暂无权重数据可导出')
  weightExportVisible.value = true
}

// ---------- 中心权重算法设置弹窗 ----------
const weightAlgoVisible = ref(false)
const weightAlgoMounted = ref(false)
watch(() => weightAlgoVisible.value, v => { if (v) weightAlgoMounted.value = true })
function openWeightSettings() { weightAlgoVisible.value = true }

// 算法产出的权重矩阵写回权重表（并记录撤销）。
// 走廊列/空位格一律清成 null：算法只按 rows×cols 算几何均值，它不知道哪列是走廊，
// 留着这些数会被后续「按权重回看」当成合法权重读走（座位指数里靠 seats 为 null 兜住了，
// 但存着一堆走廊权重本身没有意义，且改几何后还会被搬到座位列上）。
function onApplyWeightAlgorithm(matrix) {
  const prev = weightWeights.value.map(r => [...r])
  const cleaned = (Array.isArray(matrix) ? matrix : []).map((row, r) =>
    (Array.isArray(row) ? row : []).map((v, c) => (weightTypes.value[r]?.[c] === CELL.SEAT ? v : null)))
  weightWeights.value = cleaned
  recordGridSnapshotUndo('座位表', 'seat_weight', prev, cleaned, '生成中心权重')
  saveWeight()
  weightAlgoVisible.value = false
  notifySuccess('已生成并应用中心权重')
}

// ==================== 历史记录 ====================
const historyWeeks = ref([])
const historyCurrentWeek = ref('')
const historySnapshot = ref(null)
const historyData = ref({ mode: 'single', rows: 0, cols: 0, seats: [], types: [] })
const historyLoading = ref(false)
// 当前回看快照的代表日期（该周最后一天），以及座位指数所需的按天快照序列
const historySnapDate = ref('')
const seatIndexDaily = ref([])
// 周切换滑动方向：上一周="prev" 从右滑入，下一周="next" 从左滑入（应用于历史表格）
const slideDir = ref('next')
function onSwitchWeek(dir) { slideDir.value = dir }

const historyColHeaders = computed(() => {
  const { cols: c, types: t } = historyData.value
  // 快照未到位（cols=0）时兜底用当前座位表列头，让表头先行渲染；快照到了再按其几何校正
  if (!c) return activeColHeaders.value
  return generateColHeaders(c, t)
})

// 历史快照与座位表同一套几何（types 由迁移与快照写入一起持久化），直接复用构造器；
// 整表只读（历史不能就地编辑）。
const historyDisplayRows = computed(() => {
  const { seats: hSeats, rows: r, cols: c, types: t } = historyData.value
  return buildSeatLikeRows(r, c, t, (row, col) => {
    const seatVal = hSeats?.[row]?.[col]
    let displayName = ''
    if (seatVal === null || seatVal === undefined) {
      displayName = ''
    } else if (typeof seatVal === 'number') {
      displayName = getStudentName(seatVal) || ''
    } else {
      displayName = seatVal
    }
    return { course: displayName, extra: { _studentId: seatVal } }
  }).map(row => ({ ...row, _isReadonly: true }))
})

async function fetchHistoryWeeks(options) {
  try {
    const res = await axios.get(`${API_BASE}/seats/history`)
    historyWeeks.value = res.data || []
    if (historyCurrentWeek.value && !historyWeeks.value.some(w => w.week_start === historyCurrentWeek.value)) {
      historyCurrentWeek.value = ''
    }
    if (!historyCurrentWeek.value && historyWeeks.value.length > 0) {
      historyCurrentWeek.value = historyWeeks.value[0].week_start
    }
    if (historyCurrentWeek.value) await loadHistorySnapshot(options)
  } catch (e) { console.error(e) }
}

// 历史快照请求序号：连续切换周时先发的请求可能后到，旧周的快照不能覆盖新周（B06-06）
let historySeq = 0

async function loadHistorySnapshot(options) {
  if (!historyCurrentWeek.value) return
  const my = ++historySeq
  // 静默模式：不动 historyLoading（它现在只决定「空态是否敢下结论」），
  // 加载期间沿用旧表/表头原地替换数据，避免表格区高度撑高再回弹导致下方操作栏“闪一下”
  const silent = !!(options && options.silent)
  if (!silent) historyLoading.value = true
  try {
    const res = await axios.get(`${API_BASE}/seats/history/${historyCurrentWeek.value}`)
    // 期间又切了周（或有更新的请求发出）：这次响应已过期，丢弃，避免旧周覆盖新周
    if (my !== historySeq) return
    historySnapshot.value = res.data
    if (res.data) {
      historySnapDate.value = res.data.snap_date || ''
      historyData.value = {
        mode: res.data.mode || 'single',
        rows: res.data.rows,
        cols: res.data.cols,
        seats: res.data.seats,
        // 快照里的几何随 payload 一起存（迁移与 /snapshot 写入都会带），
        // 缺失时 normalizeTypes 降级成全座位 —— 不至于把整张历史表画崩
        types: res.data.types || [],
      }
    } else {
      historySnapDate.value = ''
      historyData.value = { mode: 'single', rows: 0, cols: 0, seats: [], types: [] }
    }
  } catch (e) {
    if (my === historySeq) console.error(e)
  } finally {
    // 只由最新请求关闭 loading：旧请求的 finally 不能把新请求的加载态提前抹掉
    if (!silent && my === historySeq) historyLoading.value = false
  }
  await loadSeatIndex()
}

// 周切换：静默加载（不动 historyLoading），避免表格区高度先被撑高再回弹；
// 滑动过渡动画照常由 key 变化触发
function onWeekChange(week) {
  if (week) historyCurrentWeek.value = week
  loadHistorySnapshot({ silent: true })
}

// ==================== 座位指数（公平账本） ====================
// 结算口径：一天一个座位权重，把「截至所选周」之间每人坐过的位置权重逐天相加。
// 不做乘法：临时调换座位只需按当天快照结算，累加即可。
async function loadSeatIndex() {
  try {
    // 结算区间：从学期开始日到所选周代表日期（尊重「从开学日算起」的口径）
    let from = ''
    try {
      from = await getSemesterStart()
    } catch (_) { /* 后端未就绪时忽略 */ }
    const params = {}
    if (from) params.from = from
    if (historySnapDate.value) params.to = historySnapDate.value
    const res = await axios.get(`${API_BASE}/seats/daily`, { params })
    seatIndexDaily.value = res.data || []
  } catch (e) { console.error(e) }
}

// 载入「位置公平」所需账本：统计学期范围内、截至昨日每人累计的座位权重
async function loadSeatLedger() {
  try {
    const y = new Date(); y.setDate(y.getDate() - 1)
    const to = localDateStr(y)
    let from = ''
    try {
      from = await getSemesterStart()
    } catch (_) { /* 后端未就绪时忽略 */ }
    const params = { to }
    if (from) params.from = from
    const res = await axios.get(`${API_BASE}/seats/daily`, { params })
    const led = {}
    for (const day of res.data || []) {
      const seats = day.seats || []
      for (let r = 0; r < seats.length; r++) {
        const wRow = weightWeights.value[r]
        if (!Array.isArray(wRow)) continue
        const sRow = seats[r] || []
        for (let c = 0; c < sRow.length; c++) {
          const val = sRow[c]
          if (typeof val !== 'number') continue
          const w = wRow[c]
          if (typeof w !== 'number') continue
          led[val] = (led[val] || 0) + w
        }
      }
    }
    seatLedger.value = led
  } catch (e) { console.error(e) }
}

// 逐天累加：对每一天的每个座位，取 weightWeights[r][c] 累加到该学生名下
const seatIndexRows = computed(() => {
  const weights = weightWeights.value
  if (!Array.isArray(weights) || !seatIndexDaily.value.length) return []
  const acc = {}
  for (const day of seatIndexDaily.value) {
    const seats = day.seats || []
    for (let r = 0; r < seats.length; r++) {
      const wRow = weights[r]
      const sRow = seats[r]
      if (!Array.isArray(wRow) || !Array.isArray(sRow)) continue
      for (let c = 0; c < sRow.length; c++) {
        const val = sRow[c]
        if (val === null || val === undefined || val === '') continue
        const w = wRow[c]
        if (typeof w !== 'number') continue
        const name = typeof val === 'number' ? getStudentName(val) : val
        if (!name) continue
        acc[name] = (acc[name] || 0) + w
      }
    }
  }
  const rows = Object.keys(acc).map(name => ({ name, value: acc[name] })).filter(r => r.value !== 0)
  rows.sort((a, b) => b.value - a.value)
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0)
  rows.forEach(r => { r._max = max || 1 })
  return rows
})

function seatIndexBarWidth(row) {
  return Math.round((Math.abs(row.value) / row._max) * 100)
}

// ---------- 座位指数：刷新 / 导出 ----------
// 指数本身是 computed（seatIndexDaily × weightWeights 逐天累加），所以「刷新」只需重拉
// 每日快照序列，数字会自动重算——不需要另外保存一份结果。
async function refreshSeatIndex() {
  await loadSeatIndex()
  notifySuccess('已刷新座位指数')
}

const seatIndexExportVisible = ref(false)
const seatIndexExportMounted = ref(false)
watch(() => seatIndexExportVisible.value, v => { if (v) seatIndexExportMounted.value = true })
const seatIndexExportFields = computed(() => [{ name: '姓名' }, { name: '座位指数' }])
// 与界面同序（已按累计权重降序），数值保留两位小数，避免导出后出现 3.3333333333 这类尾巴
const seatIndexExportRows = computed(() =>
  seatIndexRows.value.map(r => ({ '姓名': r.name, '座位指数': r.value.toFixed(2) }))
)
function openSeatIndexExport() {
  if (!seatIndexRows.value.length) return useNotification().info('暂无座位指数数据可导出')
  seatIndexExportVisible.value = true
}

// 补存已过日期：仅补齐「今天之前」缺失的历史快照（今天由启动时的静默补存负责）
async function captureHistorySnapshot() {
  try {
    const res = await axios.post(`${API_BASE}/seats/snapshot/backfill`, { includeToday: false })
    const n = res.data && res.data.inserted
    if (n > 0) notifySuccess(`已补存 ${n} 天的历史快照`)
    else useNotification().info((res.data && res.data.message) || '暂无需要补存的日期')
    await fetchHistoryWeeks()
  } catch (e) { notifyError('补存失败'); console.error(e) }
}

// ==================== 删除历史快照 ====================
// 删除的是当前下拉框选中的那一周（也就是正在看的那份快照）
const deleteSnapshotVisible = ref(false)
const deleteSnapshotMounted = ref(false)
// 首次打开才挂载弹窗（保持与其它懒加载弹窗一致的保活方式）
watch(() => deleteSnapshotVisible.value, v => { if (v) deleteSnapshotMounted.value = true })
const canDeleteHistorySnapshot = computed(() =>
  !!historyCurrentWeek.value && historyWeeks.value.some(w => w.week_start === historyCurrentWeek.value)
)
const deleteSnapshotMessage = computed(() => {
  const w = historyCurrentWeek.value
  if (!w) return ''
  // 日期区间用字符串级偏移：week_start 本身已是 YYYY-MM-DD。
  // 不要绕 new Date + toISOString —— 那是 UTC 口径，UTC 以西的时区会差一天。
  return `确定删除 ${String(w).slice(0, 10)} ~ ${shiftDateStr(w, 6)} 的历史快照吗？删除后不可恢复。`
})
function requestDeleteHistorySnapshot() {
  if (!canDeleteHistorySnapshot.value) return
  deleteSnapshotVisible.value = true
}
async function confirmDeleteHistorySnapshot() {
  deleteSnapshotVisible.value = false
  const week = historyCurrentWeek.value
  if (!week) return
  try {
    await axios.delete(`${API_BASE}/seats/history/${week}`)
    notifySuccess('该周快照已删除')
    if (historyCurrentWeek.value === week) historySnapshot.value = null
    await fetchHistoryWeeks()
  } catch (e) {
    notifyError('删除快照失败，请重试')
  }
}

// ==================== 座位记录：设置 / 补录 / 导出 / 刷新 ====================
const historySettingsVisible = ref(false)
const historySettingsMounted = ref(false)
watch(() => historySettingsVisible.value, v => { if (v) historySettingsMounted.value = true })
const historyBackfillVisible = ref(false)
const historyBackfillMounted = ref(false)
watch(() => historyBackfillVisible.value, v => { if (v) historyBackfillMounted.value = true })

function openHistorySettings() { historySettingsVisible.value = true }
function openBackfill() { historyBackfillVisible.value = true }
async function refreshHistory() {
  try {
    await fetchHistoryWeeks({ silent: true })
    notifySuccess('已刷新座位记录')
  } catch (e) { /* 错误已在 load 内部处理 */ }
}
// 补录完成后重新拉取周列表（保持当前选中周不变）
function onBackfillChanged() { fetchHistoryWeeks() }

// ---------- 座位记录导出 ----------
const historyExportVisible = ref(false)
const historyExportMounted = ref(false)
watch(() => historyExportVisible.value, v => { if (v) historyExportMounted.value = true })
const historyExportFields = computed(() => {
  const fields = [{ name: '行号' }]
  historyColHeaders.value.forEach(h => fields.push({ name: h }))
  return fields
})
const historyExportRows = computed(() => {
  const headers = historyColHeaders.value
  return historyDisplayRows.value.map(row => {
    const obj = { '行号': row.label }
    row.cells.forEach((cell, idx) => {
      const headerName = headers[idx] || `列${idx + 1}`
      if (cell._isAisle || cell._isAisleHidden) { obj[headerName] = '走廊'; obj._aisleCell = true }
      else obj[headerName] = cell.course || ''
    })
    return obj
  })
})
function openHistoryExport() {
  if (!historySnapshot.value || !historyDisplayRows.value.length) return useNotification().info('暂无座位记录可导出')
  historyExportVisible.value = true
}

watch(activeTab, (newTab) => { if (newTab === 'history') fetchHistoryWeeks() })

// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销/重做座位（当前页）
useUndoShortcut('座位表', {
  onAfterUndo: async (label) => { await Promise.all([loadActive(), loadMaster(), loadWeight()]); notifySuccess(label ? `已撤销：${label}` : '已撤销') },
  onAfterRedo: async (label) => { await Promise.all([loadActive(), loadMaster(), loadWeight()]); notifySuccess(label ? `已重做：${label}` : '已重做') }
})

onMounted(async () => {
  await Promise.all([loadActive(), loadMaster(), loadWeight()])
  // 统一三张表设置：以当前座位（临时表）为准。若座位模板存在超出该范围的座位数据，
  // 暂不同步，交由用户通过「设置」确认后再统一（避免静默丢弃模板数据）。
  // 注意口径：设置是「座位列数」，storage 里是网格列数，比较前先反算。
  const s = {
    rows: activeRows.value,
    cols: gridColsToSeat(activeCols.value, activeTypes.value),
    mode: activeMode.value,
  }
  const masterSeatCols = gridColsToSeat(masterCols.value, masterTypes.value)
  const differ = masterRows.value !== s.rows || masterSeatCols !== s.cols || masterMode.value !== s.mode
  if (differ && !hasTrimmedData(masterGrid, s)) await applySharedSettings(s)
  fetchAllStudents()
  // 启动时静默补全历史快照（今天及之前），失败不打扰用户
  axios.post(`${API_BASE}/seats/snapshot/backfill`, { includeToday: true }).catch(() => {})
  // 跨页定位：带 ?focus= 进入本页时定位到目标格子
  _applyRowFocus()
})
</script>

<style scoped>
/* 工具栏切换（常规 ↔ 画笔）：淡出淡入 + 轻微上下位移。
   mode="out-in" 让两个工具栏不同时占位，高度由外层容器 min-h 兜住，下方表格不跟着跳。
   0.14s 是折中：再长会像「点了没反应」，再短看不出过渡。
   全局「动画总开关」（html.no-animations 把 transition-duration 压到 0.001ms）会自动接管，
   所以这里不用再写 prefers-reduced-motion。 */
.opbar-swap-enter-active,
.opbar-swap-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.opbar-swap-enter-from { opacity: 0; transform: translateY(-6px); }
.opbar-swap-leave-to   { opacity: 0; transform: translateY(6px); }

/* 历史表格周切换滑动动画：新旧表同向并行滑动（推拉感），不影响 WeekSwitcher */
.history-content { width: 100%; }
/* 过渡容器：grid 叠放新旧表（同一格），容器高度取两者较大值，切换时高度不塌陷、下方操作栏不跳动；
   横向 clip 掉 translateX(±60px) 的溢出，避免出现横向滚动条；overflow-y 保持 visible 不误伤浮层 */
.history-swap { display: grid; grid-template-columns: minmax(0, 1fr); overflow-x: clip; overflow-y: visible; }
.history-swap > * { grid-area: 1 / 1; min-width: 0; }
.next-enter-active, .next-leave-active,
.prev-enter-active, .prev-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
/* 进场表置于上层：滑动时新表压在前，退场表在其下层 */
.next-enter-active, .prev-enter-active {
  position: relative;
  z-index: 1;
}
/* 下一周：向右推进（新表从左侧跟进向右移动，旧表向右滑出，同方向） */
.next-enter-from { transform: translateX(-60px); opacity: 0; }
.next-leave-to   { transform: translateX(60px); opacity: 0; }
/* 上一周：向左推进（新表从右侧跟进向左移动，旧表向左滑出，同方向） */
.prev-enter-from { transform: translateX(60px); opacity: 0; }
.prev-leave-to   { transform: translateX(-60px); opacity: 0; }
</style>
