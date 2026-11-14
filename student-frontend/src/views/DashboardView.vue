<template>
  <div class="dashboard-page">
    <!-- 首屏不用整页骨架屏：组件直接挂载，卡片外壳、标题、时钟常驻，
         只有依赖 /api/dashboard 的数据区在 `initialLoading` 期间显示加载条。
         「数据在路上」时占位页是否还挡着，由「性能 → 快速启动」开关决定（utils/fastStartup.js）。 -->

    <!-- 顶部信息行：左班级大字，右关键数据 -->
    <div class="welcome-card bg-surface shadow-md rounded-xl mb-6 px-6 py-5 border border-border">
      <div class="flex items-center justify-between gap-6">
        <div class="flex items-center gap-3 min-w-0">
          <IconGlyph name="home" :size="30" />
          <!-- 班名来自独立的 /api/widget-settings/class-info，与首页聚合接口并行：
               它先到就先显示，不必陪着 dashboard 一起等（单独用 classInfoLoading）。 -->
          <h1 v-if="classInfoLoading" class="flex-1 min-w-0"><span class="skeleton-block sk-title"></span></h1>
          <h1 v-else class="flex-1 min-w-0 text-2xl font-bold text-text truncate">
            <ClippedText v-if="classInfo.name" :text="classInfo.name" :max="18" title="班级名称" />
            <span v-else class="text-text-muted font-normal">请设置班级名称</span>
          </h1>
          <button class="class-gear" title="设置班名/口号/班风/学风" @click="openClassModal">
            <IconGlyph name="settings" :size="18" tint="current" />
            <span class="gear-text">设置</span>
          </button>
        </div>
        <!-- 右三个数字随聚合接口更新：未就绪时给等宽灰条，不显示 0（0 会被读成"班里没人"） -->
        <div class="flex items-center gap-4 shrink-0">
          <div class="stat-link flex items-baseline gap-1.5" @click="goTo('/students')" title="跳转：学生管理">
            <span v-if="initialLoading" class="skeleton-block sk-num"></span>
            <span v-else class="text-lg font-bold text-success leading-none">{{ attendance.present }}</span>
            <span class="text-xs text-text-muted">在校</span>
          </div>
          <div class="w-px h-6 bg-border"></div>
          <div class="stat-link flex items-baseline gap-1.5" @click="goTo('/leaves')" title="跳转：请假管理">
            <span v-if="initialLoading" class="skeleton-block sk-num"></span>
            <span v-else class="text-lg font-bold text-warning leading-none">{{ attendance.onLeave }}</span>
            <span class="text-xs text-text-muted">请假</span>
          </div>
          <div class="w-px h-6 bg-border"></div>
          <div class="stat-link flex items-baseline gap-1.5" @click="goTo('/schedule')" title="跳转：课程表">
            <span v-if="initialLoading" class="skeleton-block sk-num"></span>
            <span v-else class="text-lg font-bold text-primary leading-none">{{ todayCourseCount }}</span>
            <span class="text-xs text-text-muted">课程</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 班级信息大框：时间 / 班级班风 / 倒计时 三部分。
         整块常驻——时钟是纯本地的，挂上就在走，没必要等任何接口。 -->
    <div class="class-info-card">
      <!-- 第一部分：时钟（汇总小组件逐字符动画） -->
      <div class="info-part clock-part">
        <AnimatedClock
          style="--ac-time-size:40px; --ac-date-size:14px;"
          date-format="星期{W}  {Y}-{M}-{D}"
        />
      </div>
      <div class="info-divider"></div>

      <!-- 第二部分：班级信息（超长文本可点击查看完整） -->
      <div class="info-part class-part">
        <div v-if="classInfoLoading" class="sk-lines">
          <div class="skeleton-block sk-text sk-text-wide"></div>
          <div class="skeleton-block sk-text"></div>
          <div class="skeleton-block sk-text"></div>
          <div class="skeleton-block sk-text"></div>
        </div>
        <template v-else>
          <div class="class-name"><ClippedText :text="classInfo.name" :max="12" title="班级名称" /></div>
          <div class="class-lines">
            <div class="class-line"><span class="line-label">班级口号：</span><ClippedText v-if="classInfo.motto" :text="classInfo.motto" title="班级口号" /><span v-else class="class-placeholder">请设置班级口号</span></div>
            <div class="class-line"><span class="line-label">班风：</span><ClippedText v-if="classInfo.mottoStyle" :text="classInfo.mottoStyle" title="班风" /><span v-else class="class-placeholder">请设置班风</span></div>
            <div class="class-line"><span class="line-label">学风：</span><ClippedText v-if="classInfo.xuefeng" :text="classInfo.xuefeng" title="学风" /><span v-else class="class-placeholder">请设置学风</span></div>
          </div>
        </template>
      </div>
      <div class="info-divider"></div>

      <!-- 第三部分：倒计时（大字排版，数字放大） -->
      <div class="info-part countdown-part">
        <template v-if="initialLoading">
          <div class="sk-lines">
            <div class="skeleton-block sk-text"></div>
            <div class="skeleton-block sk-text"></div>
          </div>
          <div class="skeleton-block sk-btn"></div>
        </template>
        <template v-else>
          <template v-if="nearestCountdown">
            <div class="cd-top">距离 <span class="cd-item-name">{{ nearestCountdown.名称 }}</span></div>
            <div class="cd-bottom">还有 <span class="cd-num tabular-nums">{{ nearestCountdown.days }}</span> 天</div>
          </template>
          <div v-else class="countdown-empty">暂无倒计时</div>
          <!-- 与下方 7 张卡片同一套入口：空态「去XX」、有数据「转到XX页面」。
               倒计时没有独立路由，管理入口在活动页的倒计时页签（?tab=countdown）。 -->
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/activities?tab=countdown')">
            {{ nearestCountdown ? '转到倒计时页面' : '去添加倒计时' }}
          </button>
        </template>
      </div>
    </div>

    <!-- 数据看板：卡片按容器宽度自适应排列（auto-fit），不固定栏数。
         7 张卡的外壳与标题始终常驻，只有内容区在数据未就绪时换成加载条。 -->
    <div class="card-grid">
      <!-- 今日值日 -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/duty')" title="跳转：今日值日">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="duty" :size="20" /> 今日值日
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div v-for="i in 3" :key="'duty-sk' + i" class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div class="space-y-1.5">
            <div v-for="d in todayDuties" :key="d.task" class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-bg-secondary/60">
              <span class="text-text text-sm shrink-0">{{ d.task }}</span>
              <span class="text-text-muted text-sm truncate">
                {{ d.people && d.people.length ? d.people.map(p => getStudentName(p) || p).join('、') : '（未安排）' }}
              </span>
            </div>
            <div v-if="todayDuties.length === 0" class="text-center py-5 text-text-muted text-sm">今日暂无值日安排</div>
          </div>
          <!-- 卡片底部入口：空态时是「去XX」的引导，有数据时是「转到XX页面」的跳转，同一个按钮同一个位置，
               两种状态切换时高度不跳。卡片整体已可点击（.card-link），这里必须 @click.stop，否则会 push 两次。 -->
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/duty')">
            {{ todayDuties.length ? '转到值日页面' : '去设置值日' }}
          </button>
          </template>
        </div>

        <!-- 班费剩余 -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/fee')" title="跳转：班费">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center justify-between">
            <span class="flex items-center gap-2"><IconGlyph name="fee" :size="20" /> 班费剩余</span>
            <button class="text-text-muted hover:text-text transition-colors flex items-center" title="显示/隐藏金额" @click.stop="toggleFee">
              <IconGlyph :name="showFee ? 'eyeOff' : 'eye'" :size="18" tint="current" />
            </button>
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div class="skeleton-block sk-hero"></div>
            <div class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div class="text-3xl font-bold text-text tabular-nums flex items-baseline">
            <span :key="'fee-bal-' + showFee" class="fee-blur-in fee-amount">{{ showFee ? formatMoney(feeBalance) : '••••' }}</span>
            <span class="fee-unit">元</span>
          </div>
          <div class="flex gap-5 mt-3 text-sm">
            <span class="text-text-muted">本月收入 <b :key="'fee-in-' + showFee" class="text-success fee-blur-in fee-amount-sm">{{ showFee ? formatMoney(monthIncome) : '••' }}</b></span>
            <span class="text-text-muted">本月支出 <b :key="'fee-out-' + showFee" class="text-warning fee-blur-in fee-amount-sm">{{ showFee ? formatMoney(monthExpense) : '••' }}</b></span>
          </div>
          <!-- 班费没有「列表空态」：余额恒显示数字，无记录时是 0.00，所以只能按记录条数决定按钮文案 -->
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/fee')">
            {{ summary.feeCount ? '转到班费页面' : '去记一笔班费' }}
          </button>
          </template>
        </div>

        <!-- 今日课程 -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/schedule')" title="跳转：课程表">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="schedule" :size="20" /> 今日课程
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div v-for="i in 4" :key="'course-sk' + i" class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div v-if="todayCourseList.length" class="space-y-1.5">
            <div v-for="c in todayCourseList" :key="c.no" class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-secondary/60 transition-theme">
              <span class="w-6 text-center text-text-muted text-xs font-medium shrink-0">{{ c.no }}</span>
              <span class="text-text text-sm flex-1 truncate">{{ c.course }}</span>
              <span class="text-text-muted text-xs shrink-0">{{ c.time }}</span>
            </div>
          </div>
          <div v-else class="text-center py-5 text-text-muted text-sm">今日无课程</div>
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/schedule')">
            {{ todayCourseList.length ? '转到课程表页面' : '去设置课程表' }}
          </button>
          </template>
        </div>
      <!-- 今日加分 Top4 -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/scores')" title="跳转：加分管理">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="score" :size="20" /> 今日加分
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div v-for="i in 4" :key="'score-sk' + i" class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div v-if="topScores.length" class="space-y-1.5">
            <div v-for="(s, i) in topScores" :key="i" class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-bg-secondary/60">
              <span class="text-text text-sm flex-1 truncate">{{ i + 1 }}. {{ s.name }}</span>
              <span class="text-success font-semibold text-sm shrink-0">{{ s.score }} 分</span>
            </div>
          </div>
          <div v-else class="text-center py-5 text-text-muted text-sm">今日暂无加分</div>
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/scores')">
            {{ topScores.length ? '转到加分页面' : '去登记加分' }}
          </button>
          </template>
        </div>

        <!-- 今日活动（时间轴） -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/activities')" title="跳转：活动中心">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="activity" :size="20" /> 今日活动
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div v-for="i in 3" :key="'act-sk' + i" class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div v-if="todayActivities.length" class="relative pl-5">
            <div v-for="(a, i) in todayActivities" :key="i" class="relative pb-4 last:pb-0">
              <span class="absolute -left-5 top-1.5 w-2 h-2 rounded-full bg-primary"></span>
              <div class="text-text text-sm">{{ a.主题 }}</div>
              <div class="text-text-muted text-xs mt-0.5">{{ a.开始时间 || a.created_at }}</div>
            </div>
          </div>
          <div v-else class="text-center py-5 text-text-muted text-sm">今日暂无活动</div>
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/activities')">
            {{ todayActivities.length ? '转到活动中心' : '去添加活动' }}
          </button>
          </template>
        </div>

        <!-- 今日请假 -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goTo('/leaves')" title="跳转：请假管理">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="leave" :size="20" /> 今日请假
            <span v-if="!initialLoading" class="ml-auto text-sm text-text-muted font-normal">{{ currentLeaveList.length }} 人</span>
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div v-for="i in 2" :key="'leave-sk' + i" class="skeleton-block sk-row"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <div v-if="currentLeaveList.length" class="space-y-1.5">
            <div v-for="l in currentLeaveList" :key="l.id" class="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-secondary/60">
              <span class="text-text text-sm flex-1 truncate">{{ l.姓名 }}</span>
              <span class="text-text-muted text-xs shrink-0">{{ formatLeaveTime(l) }}</span>
            </div>
          </div>
          <div v-else class="text-center py-5 text-text-muted text-sm">今日无请假</div>
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goTo('/leaves')">
            {{ currentLeaveList.length ? '转到请假页面' : '去登记请假' }}
          </button>
          </template>
        </div>

        <!-- 班级相册（随机一张） -->
        <div class="bg-surface shadow rounded-xl p-5 border border-border card-link" @click="goToAlbumPhoto()" :title="albumPhotoId ? '点击查看这张照片' : '跳转：班级相册'">
          <h2 class="text-base font-semibold text-text mb-3 flex items-center gap-2">
            <IconGlyph name="album" :size="20" /> 班级相册
            <button
              type="button"
              class="photo-cycle-btn bg-bg-secondary/70 text-text-muted hover:text-text rounded-full"
              :class="{ 'is-spinning': photoSwitching }"
              :disabled="photoSwitching || initialLoading"
              :title="photoSwitching ? '正在换一张…' : '换一张'"
              aria-label="换一张"
              @click.stop="cycleAlbumPhoto()"
            >
              <IconGlyph name="refresh" :size="15" tint="current" />
            </button>
          </h2>
          <div v-if="initialLoading" class="sk-lines">
            <div class="skeleton-block sk-photo"></div>
            <div class="skeleton-block sk-btn"></div>
          </div>
          <template v-else>
          <!-- 磁贴式换图：后层是正在退场的旧图，前层是浮入的新图。
               两层叠在同一舞台里，各自跑一段关键帧，动画结束才撤掉后层并释放它的 blob URL。
               :key 只为「连着换图」时重建舞台、让动画从头播；静态时两层都不带动画类。 -->
          <div v-if="albumPhoto || photoOutUrl" :key="photoStageKey" class="photo-stage">
            <img v-if="photoOutUrl" :src="photoOutUrl" alt="" aria-hidden="true" class="photo-layer photo-out">
            <img
              v-if="albumPhoto"
              :src="albumPhoto"
              alt="随机班级照片"
              class="photo-layer"
              :class="photoAnimating ? 'photo-in' : ''"
              @animationend="onPhotoAnimEnd"
            >
          </div>
          <div v-else class="text-center py-8 text-text-muted text-sm">暂无照片</div>
          <button type="button" class="card-go-btn bg-info text-text-inverse rounded" @click.stop="goToAlbumPhoto()">
            {{ albumPhotoId ? '查看这张照片' : (albumPhoto ? '转到相册页面' : '去上传照片') }}
          </button>
          </template>
        </div>
    </div>

    <!-- 班级信息设置弹窗 -->
    <ClassInfoDialog
      :visible="showClassModal"
      :class-data="classInfo"
      :classes="classList"
      :current-slug="currentSlug"
      :switching="switchingClass"
      @confirm="saveClassInfo"
      @switch-class="switchClass"
      @create-class="createClass"
      @cancel="showClassModal = false"
    />
  </div>
</template>

<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'
// 切班要作废两类状态：模块级缓存（这里）与 KeepAlive 里缓存的组件实例（classScope）。
// 两者缺一都会串班：只清模块缓存，已挂载的视图仍显示旧班的 ref；
// 只作废实例，模块缓存会让重新挂载的页面立刻读回上一批数据。
import { resetUserScopedCaches } from '../utils/userScopedCache.js'
import { bumpClassScope, classDialogOpen } from '../utils/classScope.js'
import { ensureDashboardData } from '../composables/useDashboardData'
import { mark, perfNow, perfSince } from '../utils/perfMark.js'
import { reportError } from '../utils/reportError.js'
import { createLatest } from '../utils/latestOnly.js'
import { useDisposables } from '../utils/disposables.js'
import IconGlyph from '../components/base/IconGlyph.vue'
import AnimatedClock from '../components/AnimatedClock.vue'
import ClippedText from '../components/ClippedText.vue'
import ClassInfoDialog from '../components/dialogs/ClassInfoDialog.vue'
import { useNotification } from '../composables/useNotification.js'
import { pad2, formatDate } from '../utils/dateTime.js'
import { leavesOn } from '../utils/leaveState.js'

// 2-18 归因：Vue 挂载完成 → 首页数据发起 之间约 57ms 一直没人拆开过。这条标记
// 「本组件模块已求值、setup 开始」，与下面 onMounted 那条一起把这段切成三截：
//   挂载完成 → DashboardView 加载  = 路由 chunk 加载 + V8 编译
//   DashboardView 加载 → 挂载      = 本组件 setup 执行
//   挂载 → 首页数据发起            = onMounted 到 fetchAll 之间
mark('DashboardView 加载')

const router = useRouter()
const { success: notifySuccess, error: notifyError } = useNotification()

// 返回当天的课表列索引（周一=0…周五=4），周末返回 -1；兼容传入 Date 或星期数字(0-6，周日=0)
function getWeekDayIndex(d) {
  const day = typeof d === 'number' ? d : d.getDay()
  if (day === 0 || day === 6) return -1
  return day - 1
}

// ========== 数据 ==========
const now = ref(new Date())
const today = computed(() => {
  return formatDate(now.value)
})
const todayWeekIndex = computed(() => getWeekDayIndex(now.value))

const schedule = ref({ cells: [], settings: { periods: [], days: ['周一', '周二', '周三', '周四', '周五'] } })
const duty = ref({ cells: {}, settings: { days: [], items: [] } })
const countdowns = ref([])
const leaves = ref([])
const students = ref([])
// 首页聚合值（v6 · 2-1）：人数 / 今日加分 Top4 / 班费三个口径都由后端算好，
// 不再把全量加分与班费记录下发到首页（真实班级 1000 条加分会占整包 91%）。
const summary = ref({
  studentCount: 0, scoreCount: 0, feeCount: 0,
  topScores: [], feeBalance: 0, monthIncome: 0, monthExpense: 0,
})
const activities = ref([])
const albumPhoto = ref('')
// 首页配图抽中的照片 id（后端随缩略图一起放在 X-Photo-Id 响应头里）。
// 有它才能从首页直接「跳到这张图片」；拿不到头（旧后端 / 被代理剥掉）就退化成只跳相册页。
const albumPhotoId = ref(0)
// 换一张按钮：请求期间置真，图标旋转 + 禁用，避免连点堆一串随机图请求
const photoSwitching = ref(false)
// 首页聚合数据里的相册列表，只用来判断「有没有相册」；换图时不必重新拉一次 dashboard
const dashboardAlbums = ref([])
const showFee = ref(localStorage.getItem('dashboard-fee-visible') === '1')

// 首屏数据未就绪：为真时各卡片的数据区显示加载条（卡片外壳与标题常驻）。
// 首次数据到位后置 false 并保持；切回首页的后台刷新只在后台进行，不再闪加载条。
const initialLoading = ref(true)
// 班级信息（班名/口号/班风/学风）走的是另一个接口，单独一个未就绪标记：
// 它通常比 /api/dashboard 先回来，早到就该早显示，不该被首页数据拖着一起等。
// 同样只在首次为真，切回首页的重拉不闪。
const classInfoLoading = ref(true)

// ========== 计算属性 ==========

// 首页班级信息（班名/口号/班风/学风）：持久化于后端 widget_settings，缺省用占位
const classInfo = ref({
  name: '初三七班',
  motto: '插上理想的翅膀，扬起青春的风帆',
  mottoStyle: '自尊 自信 自强 自立',
  xuefeng: '勤学 好问 善思 笃行',
})

// 班级设置弹窗
const showClassModal = ref(false)
// 弹窗显隐同步到模块级状态：切班/建班会重建整个视图（见 applyClassSwitch），
// 新实例靠这个标记判断「重建前弹窗是开着的」，从而原地恢复，而不是把用户踢出来。
watch(showClassModal, (v) => { classDialogOpen.value = v })
// 多班级：该账号名下的班级列表与当前班。只在打开弹窗时拉一次 ——
// 这是低频操作，没必要塞进首屏。
const classList = ref([])
const currentSlug = ref('')
const switchingClass = ref(false)

// 拉班级列表。抽出成独立函数是为了「重建后恢复弹窗」那条路径也能复用 ——
// 恢复时不能走 openClassModal（它会把 visible 再设一次，导致弹窗先空一帧再填）。
async function loadClasses() {
  try {
    const res = await axios.get('/api/account/classes')
    classList.value = res.data?.classes || []
    currentSlug.value = res.data?.current || ''
  } catch (e) {
    // 拉不到就只显示当前班信息表单（切换区按「只有一个班」隐藏），不影响改班名
    classList.value = []
    reportError(e, { action: '加载班级列表', level: 'log' })
  }
}

function openClassModal() {
  showClassModal.value = true
  loadClasses()
}

// 切班成功后的统一收尾：把整个前端切到新班的数据上，不重载页面。
// 新 token 已经由响应拦截器随 X-Renewed-Token 落盘（后端 switch-class 下发），
// 所以这里只剩两步，且顺序不能反：
//   1. 清模块级缓存 + 代次 +1：在途请求的响应回来时会发现代次已变而丢弃，
//      不会把上一个班的数据写回缓存（photoInfoCache / 仪表盘 dataCache 都是这类）。
//   2. 作废 KeepAlive 里的全部视图实例：当前路由重新 mount，各页 onMounted 重新拉数据。
// 反过来的话，重新挂载的页面会先读到还没清掉的旧缓存，把上个班的数据又渲染一遍。
function applyClassSwitch(className) {
  resetUserScopedCaches()
  bumpClassScope()
  // 防御：正常情况下这个组件马上会被 KeepAlive 重建销毁，这行没机会跑；
  // 但万一 classScopeKey 没接上（比如 App.vue 的 key 被改掉），按钮不能永久停在 disabled。
  switchingClass.value = false
  // 提示放在清理之后：resetUserScopedCaches 会清空通知列表（通知属于上一个班），
  // 先弹再清就看不到了。
  if (className) notifySuccess(`已切换到「${className}」`)
}

// 新建班级：建的是空库，不复制当前班的东西（复制会把同一批学生塞进两个班）。
// 建完直接进新班 —— 用户点「新建」的意图基本就是「开始用这个班」。
async function createClass(className) {
  if (!className || switchingClass.value) return
  switchingClass.value = true
  try {
    const res = await axios.post('/api/account/class', { className })
    const slug = res.data?.slug
    if (!slug) throw new Error('后端未返回班级标识')
    await axios.post('/api/account/switch-class', { slug })
    applyClassSwitch(className)
  } catch (e) {
    switchingClass.value = false
    notifyError(e?.response?.data?.error || '新建班级失败，请重试')
  }
}

// 切班 = 换一个库，学生/座位/班费/相册全都是另一套。
// 不整页重载：token 换掉之后靠 applyClassSwitch 作废缓存的视图实例，
// 当前页重新挂载就能读到新班，滚动位置与路由都保留。
async function switchClass(slug) {
  if (!slug || slug === currentSlug.value || switchingClass.value) return
  switchingClass.value = true
  try {
    const res = await axios.post('/api/account/switch-class', { slug })
    const target = (res.data?.classes || []).find((c) => c.slug === slug)
    applyClassSwitch(target?.className)
  } catch (e) {
    switchingClass.value = false
    notifyError(e?.response?.data?.error || '切换班级失败，请重试')
  }
}
async function loadClassInfo() {
  try {
    const res = await axios.get('/api/widget-settings/class-info')
    const d = res.data?.data
    if (d) {
      // 直接赋值，不再用 `|| 默认值` 回退：删除后的空值应保留为空，配合占位提示展示
      classInfo.value = { name: d.name ?? '', motto: d.motto ?? '', mottoStyle: d.mottoStyle ?? '', xuefeng: d.xuefeng ?? '' }
    }
  } catch (e) {
    // 原来完全静默：班名/班训会显示成空白占位，用户以为是自己没填过。
    // 走 log 档而不是弹提示：这是首页的次要信息，且 /api/dashboard 失败时已有统一提示，
    // 两个都弹只会变成噪音。
    reportError(e, { action: '加载班级信息', level: 'log' })
  } finally {
    // 失败也要收掉加载条：宁可显示"请设置"的空态（用户可点设置补），
    // 也不能让班名区永远停在灰条上。
    classInfoLoading.value = false
  }
}
async function saveClassInfo(data) {
  try {
    const res = await axios.put('/api/widget-settings/class-info', data || {})
    const d = res.data?.data
    if (d) classInfo.value = { ...d }
    showClassModal.value = false
    notifySuccess('班级信息保存成功')
  } catch (e) {
    // 优先用后端的文案：重名会被回 409 并带上具体班名，吞成通用提示用户不知道要改什么
    notifyError(e?.response?.data?.error || '班级信息保存失败，请重试')
  }
}

// 出勤统计
// 口径必须与下面的「今日请假」卡片一致：**今天在请假中**（跨天假今天仍在假内）。
// 原来这里数的是「所有状态=请假中」的记录（不看日期），于是右上角「请假 3」
// 而今日请假卡片空着 —— 同一屏两个数字互相矛盾。
const attendance = computed(() => {
  const total = students.value.length
  const onLeave = leavesOn(leaves.value, today.value).length
  return { total, onLeave, present: total - onLeave }
})

// 今日课程
const todayCourses = computed(() => {
  if (todayWeekIndex.value < 0) return []
  const cells = schedule.value.cells
  if (!Array.isArray(cells) || cells.length === 0) return []
  return cells.map(row => {
    const cell = Array.isArray(row) ? row[todayWeekIndex.value] : null
    return cell && cell.course ? cell.course : ''
  })
})
const todayCourseCount = computed(() => todayCourses.value.filter(Boolean).length)

// 今日值日
const todayDuties = computed(() => {
  const cells = duty.value.cells
  const items = duty.value.settings.items || []
  if (!Array.isArray(items) || items.length === 0) return []
  const dayOfWeek = getWeekDayIndex(now.value)
  // 值日 cells 的键是中文星期名（如 '周二'），优先用 settings.days 取星期名，缺失时回退数字索引
  const days = duty.value.settings.days || ['周一', '周二', '周三', '周四', '周五']
  const todayDayName = days[dayOfWeek]
  const result = []
  for (const item of items) {
    const task = typeof item === 'string' ? item : (item.名称 || item.name || item)
    let people = []
    if (cells && cells[task]) {
      const dayCell = todayDayName ? cells[task][todayDayName] : null
      people = (dayCell !== undefined && dayCell !== null) ? dayCell : (cells[task][dayOfWeek] || [])
    }
    result.push({ task, people })
  }
  return result.filter(r => (typeof r.task === 'string' && r.task) || r.people.length > 0)
})

// 最近倒计时
const nearestCountdown = computed(() => {
  if (countdowns.value.length === 0) return null
  const todayDate = new Date(today.value)
  todayDate.setHours(0, 0, 0, 0)
  let nearest = null
  let nearestDays = Infinity
  for (const c of countdowns.value) {
    if (!c.截止日) continue
    const deadline = new Date(c.截止日)
    deadline.setHours(0, 0, 0, 0)
    const diff = Math.ceil((deadline - todayDate) / (1000 * 60 * 60 * 24))
    if (diff >= 0 && diff < nearestDays) {
      nearestDays = diff
      nearest = { ...c, days: c.包含这一天 ? diff + 1 : diff }
    }
  }
  return nearest
})

// 今日活动（时间轴）
const todayActivities = computed(() => {
  return activities.value.filter(a => {
    const dateStr = a.开始时间 || a.created_at
    return String(dateStr).startsWith(today.value)
  })
})

// 当前请假列表（今日请假中）
// 与上面的 attendance.onLeave 共用 leavesOn —— 两处各写一份筛选条件，
// 就是「数字和卡片对不上」的根源。
const currentLeaveList = computed(() => leavesOn(leaves.value, today.value))

// 今日课程列表（带时间段）
const todayCourseList = computed(() => {
  if (todayWeekIndex.value < 0) return []
  const cells = schedule.value.cells
  const periods = schedule.value.settings.periods || []
  if (!Array.isArray(cells) || cells.length === 0) return []
  const result = []
  for (let i = 0; i < cells.length; i++) {
    const cell = Array.isArray(cells[i]) ? cells[i][todayWeekIndex.value] : null
    const course = cell && cell.course ? cell.course : ''
    if (!course) continue
    const p = periods[i] || {}
    const time = `${p.start || '00:00'}${p.end ? `~${p.end}` : ''}`
    result.push({ no: i + 1, course, time })
  }
  return result
})

// 加分排行榜：后端已按「今日 + 分值降序 + 前 4」算好（口径见 routes/dashboard.js buildSummary）
const topScores = computed(() => summary.value.topScores || [])

// 班费聚合：余额 + 本月收入/支出都由后端算（全量记录不下发首页）
const feeBalance = computed(() => summary.value.feeBalance || 0)
const monthIncome = computed(() => summary.value.monthIncome || 0)
const monthExpense = computed(() => summary.value.monthExpense || 0)

// ========== 方法 ==========
function goTo(to) {
  router.push(to)
}
// 点「班级相册」卡片/配图：带上当前这张图的 id，相册页会滚到它所在的那一天并打开大图。
// 没有 id（后端没给头、图还没加载出来）时行为与以前完全一致：只跳到相册页。
function goToAlbumPhoto() {
  const id = albumPhotoId.value
  router.push(id ? { path: '/album', query: { photo: String(id) } } : '/album')
}
function toggleFee() {
  showFee.value = !showFee.value
  localStorage.setItem('dashboard-fee-visible', showFee.value ? '1' : '0')
}
function formatMoney(n) {
  return Number(n).toFixed(2)
}
// ===== 首页配图：blob URL 生命周期 + 磁贴式换图动画 =====
// 旧图在退场动画播放期间仍是 <img> 的 src，**不能立刻 revoke**，否则动画里会裂图。
// 分三层管理：albumPhoto（前层，当前）、photoOutUrl（后层，正在退场）、
// retiredPhotoUrls（被换掉、等动画结束统一释放）。首页被 KeepAlive 缓存，漏一个就累积一个 blob。
const d = useDisposables()
const photoAnimFallback = d.defer()
const photoOutUrl = ref('')
const photoAnimating = ref(false)
const photoStageKey = ref(0)
const retiredPhotoUrls = new Set()
// 「按钮转圈要等这一轮换图动画收尾」的登记标志。只有按钮触发、且确实播了动画的那一轮
// 才置真：首屏/切回自动换图的动画收尾，不该把用户刚点下的旋转提前掐掉。
let spinPending = false

function revokeBlobUrl(url) {
  if (!url || !String(url).startsWith('blob:')) return
  try { URL.revokeObjectURL(url) } catch (_) { /* 忽略 */ }
}

// 系统的「减少动效」或设置里的「关闭动画」都可能掐掉关键帧，animationend 就不一定来。
// 这类情况直接静态换图；真进了动画分支也留一条兜底，别让后层永远挂在 DOM 上。
function photosShouldAnimate() {
  try {
    return !document.documentElement.classList.contains('no-animations')
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (_) { return false }
}

// 动画收尾（animationend 或兜底定时器）：撤掉后层、释放所有退场 blob。
// 这里也是按钮转圈的停止点：转圈覆盖「等图 + 旧退新入」全过程，到动画收尾才停，
// 不会请求一回来（几十毫秒）就停住、看着像没转。
function finishPhotoAnim() {
  photoAnimFallback.cancel()
  if (spinPending) { spinPending = false; photoSwitching.value = false }
  if (!photoAnimating.value) return
  photoAnimating.value = false
  const old = photoOutUrl.value
  photoOutUrl.value = ''
  revokeBlobUrl(old)
  for (const u of retiredPhotoUrls) revokeBlobUrl(u)
  retiredPhotoUrls.clear()
}

function onPhotoAnimEnd(e) {
  // 绑在前层 <img> 上，只有它自己的浮入动画会在这儿冒出来（后层是兄弟节点）。
  // 不比对 animationName：scoped 样式会给 @keyframes 名字加 hash 后缀，硬比对必然失配。
  if (e && e.target !== e.currentTarget) return
  finishPhotoAnim()
}

// 换图：**先**把新 URL 赋上去，**再**处理被替换的旧图。
// 反过来（先 revoke 再赋值）在并发下会出问题：两次 loadRandomPhoto 交错时，
// 后到的那次会把另一次刚显示的 blob 释放掉 → 裂图。
function replaceAlbumPhoto(blob, deferSpin = false) {
  const prev = albumPhoto.value
  const next = URL.createObjectURL(blob)
  const animated = !!(prev && String(prev).startsWith('blob:') && photosShouldAnimate())
  if (animated) {
    // 上一次还在退场的旧图先收进待释放，别让两层动画叠成一团
    if (photoOutUrl.value) retiredPhotoUrls.add(photoOutUrl.value)
    photoOutUrl.value = prev
    photoAnimating.value = true
    // 重建舞台 → 连着换图时关键帧从头播（只改 class 不会重启 CSS 动画）
    photoStageKey.value += 1
    photoAnimFallback(finishPhotoAnim, 700)
    // 只登记按钮触发的这一轮：动画收尾时由 finishPhotoAnim 停转圈
    if (deferSpin) spinPending = true
  } else {
    if (photoOutUrl.value) { retiredPhotoUrls.add(photoOutUrl.value); photoOutUrl.value = '' }
    photoAnimating.value = false
    retiredPhotoUrls.add(prev)
    for (const u of retiredPhotoUrls) revokeBlobUrl(u)
    retiredPhotoUrls.clear()
  }
  albumPhoto.value = next
  // 调用方据此决定「请求结束就停转圈」还是「等动画收尾再停」
  return animated
}

// 清空配图（首屏失败 / 组件卸载）：三层 URL 一个都不能漏。
function revokeAlbumPhoto() {
  photoAnimFallback.cancel()
  // 图都没了（首屏失败 / 切号 / 卸载）：转圈也必须停，否则按钮会一直 disabled
  spinPending = false
  photoSwitching.value = false
  photoAnimating.value = false
  revokeBlobUrl(albumPhoto.value)
  revokeBlobUrl(photoOutUrl.value)
  for (const u of retiredPhotoUrls) revokeBlobUrl(u)
  retiredPhotoUrls.clear()
  albumPhoto.value = ''
  photoOutUrl.value = ''
  // 图都没了还留着 id，点卡片会拿一个不存在的照片去相册页定位
  albumPhotoId.value = 0
}

// 点标题右侧的循环按钮：排除当前这张再抽，失败时**保留**当前图（别把用户的图弄没）。
function cycleAlbumPhoto() {
  if (photoSwitching.value || initialLoading.value) return
  if (!dashboardAlbums.value.length) return
  // 先清掉上一轮的登记：这次的转圈要等「这次」图回来后播的动画，别被旧动画收尾掐掉
  spinPending = false
  photoSwitching.value = true
  loadRandomPhoto(dashboardAlbums.value, { exclude: albumPhotoId.value, keepOnError: true })
}

// 随机取一张班级照片当首页配图。
// 注意：调用方可能并发触发（首屏 onMounted 与切回页面的 onActivated 都会调），
// 所以这里用请求序号守卫，只让最新一次写状态 —— 否则「慢的那次后到」会把新图换成旧图。
const albumPhotoSeq = createLatest()
async function loadRandomPhoto(albums, opts = {}) {
  const my = albumPhotoSeq.begin()
  const { exclude = 0, keepOnError = false } = opts
  const list = Array.isArray(albums) ? albums : []
  if (!list.length) {
    if (albumPhotoSeq.isCurrent(my)) revokeAlbumPhoto() // 里面已把转圈停掉
    return
  }
  // 这一轮是否真的播了换图动画：决定转圈「请求结束就停」还是「等动画收尾再停」
  let animated = false
  /* 只要一张图，就只问后端要一张：后端随机抽一张、直接把缩略图递过来，一次请求。
   * 原实现是遍历每个相册各拉一次全量照片列表、再自己随机挑一张 —— 真实数据
   * 12,968 行 / 3.44MB，而且每次进首页都会跑（onMounted + onActivated 各一次）。
   * exclude 只在「换一张」时带：后端把当前这张排掉，避免照片少时点了没变化。 */
  try {
    const thumbRes = await axios.get('/api/album/random-photo/thumb', {
      responseType: 'blob',
      params: exclude ? { exclude } : undefined,
    })
    // 过期响应：不换图、也不释放当前图（那是另一次调用的成果）
    if (!albumPhotoSeq.isCurrent(my)) return
    // 抽中的是哪一张，只能从响应头拿：body 是 JPEG，不带 id。
    // 二进制响应不进安全信道的 JSON 加解密，头原样透传；CORS 已放行 X-Photo-Id。
    // axios 的 AxiosHeaders 与 fetch 的 Headers 都有 .get()，裸对象走小写下标。
    const h = thumbRes.headers
    const rawId = h && (typeof h.get === 'function' ? h.get('X-Photo-Id') : h['x-photo-id'])
    const photoId = Number(rawId)
    albumPhotoId.value = Number.isInteger(photoId) && photoId > 0 ? photoId : 0
    animated = replaceAlbumPhoto(thumbRes.data, !!exclude)
  } catch (_) {
    // 没有照片 / 缩略图还在排队生成 / 请求失败：只有仍是最新一次才动图。
    // 手动「换一张」失败要保留当前这张（keepOnError），否则点一下按钮图就没了。
    if (albumPhotoSeq.isCurrent(my) && !keepOnError) revokeAlbumPhoto()
  } finally {
    // 只有「按钮触发 + 确实播了动画 + 仍是最新一次请求」才把停转圈交给动画收尾；
    // 静态替换（关闭动画）/ 请求失败 / 被新请求接管都在这里立刻停，按钮不会转个不停。
    if (!(albumPhotoSeq.isCurrent(my) && animated && spinPending)) {
      spinPending = false
      photoSwitching.value = false
    }
  }
}
function getStudentName(id) {
  const s = students.value.find(st => st.id === Number(id) || st.id === id)
  return s ? s.姓名 : null
}

function formatLeaveTime(leave) {
  if (!leave.开始时间) return ''
  const dt = new Date(leave.开始时间)
  return `${dt.getHours()}:${pad2(dt.getMinutes())}`
}

// ========== 加载数据 ==========
// 复用首屏预取缓存（请求已在路由导航进入首页时并发发起，见 useDashboardData）
async function loadData(force = false) {
  const firstScreen = initialLoading.value
  try {
    const d = await ensureDashboardData(force)
    // 首屏分段（v6 · P1-01）：从数据就绪到 DOM patch 完成，是 95ms 黑洞的最后一段。
    // 只标首次首屏；切回首页/后台刷新不重复打，避免日志噪音。
    const renderAt = perfNow()
    schedule.value = d.schedule
    duty.value = d.duty
    countdowns.value = d.countdowns
    leaves.value = d.leaves
    students.value = d.students
    summary.value = d.summary
    activities.value = d.activities
    dashboardAlbums.value = Array.isArray(d.album) ? d.album : []
    // 相册：后端随机抽一张；这份列表留给「换一张」判断有没有相册，不必重拉 dashboard
    loadRandomPhoto(dashboardAlbums.value)
    if (firstScreen && !firstRenderMarked) {
      firstRenderMarked = true
      // 不 await：不能因为打点把首屏骨架屏多留一帧；nextTick 回调里再记时刻
      nextTick().then(() => mark(`首页 patch 渲染 ${perfSince(renderAt)}ms`))
    }
  } catch (err) {
    // 后端不可达（没有 response）时，App 的「后端启动失败」遮罩会统一提示，这里不重复打扰；
    // 后端可达但返回错误才该让用户知道 —— 否则首屏看着「全是 0」像是数据没了。
    reportError(err, { action: '加载首页数据', level: err && err.response ? 'user' : 'log' })
  } finally {
    initialLoading.value = false
  }
}

let timer = null
// 首帧标记：onActivated 首次随挂载触发，跳过避免与 onMounted 重复加载
let firstActivate = true
// 首屏渲染段只打一次（后台刷新/切页回来不重复）
let firstRenderMarked = false
const refreshNow = () => { now.value = new Date() }

onMounted(() => {
  // 与 setup 首行那条配对，把「挂载 → 数据发起」再切一刀（见文件内 2-18 归因注释）
  mark('DashboardView 挂载')
  loadData()
  if (classDialogOpen.value) {
    // 从切班/建班的重建中回来：弹窗本来开着，先把班级信息与列表拉回来再显示。
    // 不能先显后填 —— ClassInfoDialog 只在 visible 由 false→true 时初始化表单，
    // 先开弹窗会得到一个字段全空的表单，且数据回来后也不会补。
    Promise.all([loadClassInfo(), loadClasses()]).finally(() => { showClassModal.value = true })
  } else {
    loadClassInfo()
  }
  // 每分钟刷新当前时间，让今日名单、窗口时间等随时间变化
  timer = setInterval(refreshNow, 60000)
})

// 每次从其他页面切回首页时强制重新拉取，保证「修改过数据回来自动更新」为最新
onActivated(() => {
  if (firstActivate) { firstActivate = false; return }
  loadData(true)
  // 班级信息（班名/班训/人数）也是用户可见数据，切回来必须一起重拉：
  // 只刷数据不刷它的话，换号后欢迎卡还挂着上一个账号的班名（审查 v4 · B06-03）。
  loadClassInfo()
  // 被 <KeepAlive> 缓存期间定时器是停的（见 onDeactivated），切回时恢复
  if (!timer) timer = setInterval(refreshNow, 60000)
})

// 被缓存但不可见时停掉每分钟的时间刷新，避免看不见的页面持续触发布局/渲染
onDeactivated(() => {
  if (timer) { clearInterval(timer); timer = null }
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  revokeAlbumPhoto()
})
</script>

<style scoped>
/* ======================== 班级信息大框 ======================== */
.class-info-card {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 20px;
  padding: 22px 28px;
  border-radius: var(--radius-surface);
  background: rgba(255, 255, 255, 0.42);
  backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
}
.info-part {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.info-divider {
  width: 1px;
  align-self: stretch;
  background: rgba(0, 0, 0, 0.12);
  margin: 4px 0;
}
/* 时钟取色通过变量下传（AnimatedClock 内以 var() 读取），夜间由 theme-night.css 覆盖 */
.clock-part {
  --ac-time-color: #111827;
  --ac-date-color: #4b5563;
}
/* 第二部分：班级信息 */
.class-name {
  font-size: 20px;
  font-weight: 700;
  color: #111827;
  margin-bottom: 8px;
}
.class-lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.class-line {
  font-size: 13px;
  color: #374151;
}
.line-label {
  color: #6b7280;
}
.class-placeholder {
  color: #9ca3af;
  font-style: italic;
}
/* 第三部分：倒计时（大字排版） */
.countdown-part {
  gap: 4px;
}
.cd-top {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
  line-height: 1.4;
}
.cd-item-name {
  color: #2563eb;
}
.cd-bottom {
  /* 数字大字、单位跟随基线对齐 */
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 16px;
  color: #4b5563;
}
.cd-num {
  font-size: 58px;
  font-weight: 800;
  line-height: 1;
  color: #2563eb;
}
.countdown-empty {
  font-size: 14px;
  color: #9ca3af;
}

/* 班费金额查看/隐藏切换：模糊渐入（与 AnimatedClock 时钟 charFlipIn 同款效果） */
.fee-blur-in {
  animation: feeBlurIn 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes feeBlurIn {
  0% { filter: blur(4px); transform: translateY(10px); opacity: 0.2; }
  100% { filter: blur(0px); transform: translateY(0); opacity: 1; }
}
/* 金额数字区预留固定最小宽度，数字在区内居中：切换时宽度不变，「元」位置不移动 */
.fee-amount {
  display: inline-block;
  min-width: 5.5em;
  text-align: center;
}
.fee-amount-sm {
  display: inline-block;
  min-width: 4em;
  text-align: right;
}
.fee-unit {
  flex: none;
  margin-left: 0.15em;
}

/* 看板卡片瀑布流排列：用 CSS 多列实现"砌墙"效果——
   矮卡片后面的内容自动顶上来填空隙，而不是逐行等高对齐；
   列数随容器宽度自适应（每列约 280px）。 */
.card-grid {
  column-width: 280px;
  column-gap: 20px;
}
.card-grid > * {
  break-inside: avoid; /* 卡片不跨列断开 */
  margin-bottom: 20px;
  width: 100%;
  display: inline-block; /* 保持卡片内块级尺寸稳定 */
  vertical-align: top;
}

.dashboard-page ::v-deep(.icon-glyph) {
  flex-shrink: 0;
}

/* 可点击卡片：指针 + 悬停高亮 */
.card-link {
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.card-link:hover {
  border-color: rgba(59, 130, 246, 0.35);
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.10);
}

/* 看板卡片底部的入口按钮：空态写「去XX」，有数据写「转到XX页面」。
   宽度按内容自适应、水平居中（`display:block` + `margin auto`），**不要** w-full 铺满卡片 ——
   铺满时 7 张卡底部是 7 条整宽色带，跟卡片里的小字数据抢视觉。
   配色与 EmptySnapshot 里「去设置」那颗完全同款（bg-info 实心蓝 + text-text-inverse）：
   「占位页按钮统一蓝色」是既定口径，四套主题各自有现成配方 ——
     base / base-accent → 饱和蓝底白字（accent 下 --color-info 跟随页面强调色）；
     glass             → rgba(59,130,246,.36) 蓝色玻璃 + #1e40af 深蓝字 + 主题描边；
     night             → theme-night.css 有专规则。
   所以这里不写任何 color / background / border，只留尺寸：
   写死色值就等于在主题之外开第五份副本。 */
.card-go-btn {
  display: block;
  margin: 12px auto 0;
  padding: 6px 20px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  /* Tailwind v4 的按钮默认 cursor 是 default，不是 pointer */
  cursor: pointer;
}

/* ===== 班级相册：循环按钮 + 磁贴式换图 =====
   两层 <img> 叠在同一舞台：旧图沿 z 轴向后退（缩小 + 淡出），新图从前面浮入
   （放大 + 淡入）落回原位，做出 Win10 开始菜单磁贴那种前后层次。
   perspective() 写在每层自己的 transform 里，不靠父容器建 3D 上下文 ——
   舞台必须 overflow:hidden 裁圆角，父级 perspective 在 Chromium 里会被扁平化。 */
.photo-stage {
  position: relative;
  height: 176px;
  border-radius: 8px;
  overflow: hidden;
  background-color: var(--color-bg-secondary, transparent);
}
.photo-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  backface-visibility: hidden;
}
.photo-stage .photo-out {
  z-index: 1;
  will-change: transform, opacity;
  animation: photo-retreat 480ms cubic-bezier(.4, 0, .75, .4) both;
}
.photo-stage .photo-in {
  z-index: 2;
  will-change: transform, opacity;
  /* 错峰 80ms：先看见旧图往后退，再看见新图从前面浮上来，不是两张同时半透明叠着 */
  animation: photo-float-in 480ms cubic-bezier(.16, .84, .3, 1) 80ms both;
}
@keyframes photo-retreat {
  from { transform: perspective(900px) translateZ(0) translateY(0); opacity: 1; }
  to   { transform: perspective(900px) translateZ(-170px) translateY(-8px); opacity: 0; }
}
@keyframes photo-float-in {
  from { transform: perspective(900px) translateZ(170px) translateY(12px); opacity: 0; }
  to   { transform: perspective(900px) translateZ(0) translateY(0); opacity: 1; }
}

/* 标题右侧的循环按钮：纯图标按钮，不要那圈深色描边。
   毛玻璃主题有 :root:is([data-theme="glass"]) button { border-width:1px; ... }，
   它没写 border-color → 继承 currentColor，于是在浅色卡片上显出一圈近黑的圆环，
   外加 box-shadow 细环与 ::before 渐变荧光描边。四套主题统一清掉，只留浅灰圆底 + 图标。
   !important 不能省：主题规则特异性 (0,2,1) 高过 scoped 的 (0,2,0)；
   配方与 index.css 的 .dtf-sort-btn 一致。颜色仍交给主题类，不在这儿写死。 */
.photo-cycle-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent !important;
  border-radius: 9999px !important;
  box-shadow: none !important;
  font-family: inherit;
  cursor: pointer;
  transition: color .18s ease, background-color .18s ease, transform .18s ease;
}
.photo-cycle-btn::before { display: none !important; }
/* 键盘焦点也不再画一圈 outline，改成图标变主色，避免又出现「边框」观感 */
.photo-cycle-btn:focus-visible {
  outline: none;
  color: var(--color-info, currentColor);
}
.photo-cycle-btn:not(.is-spinning):hover:not(:disabled) { transform: rotate(30deg); }
.photo-cycle-btn:disabled { opacity: .55; cursor: default; }
/* 一圈 560ms，与换图动画总时长（480ms + 80ms 错峰）对齐：
   从点击到动画收尾大致刚好转满一圈，不会停在半圈显得别扭。 */
.photo-cycle-btn.is-spinning { animation: photo-spin 560ms linear infinite; }
@keyframes photo-spin { to { transform: rotate(360deg); } }

/* 欢迎条右侧关键数据（在校 / 请假 / 课程）：可点击跳转，悬停给轻微底色反馈。
   内边距配负外边距抵消，静止时文字位置与原来完全一致。 */
.stat-link {
  cursor: pointer;
  padding: 2px 8px;
  margin: -2px -8px;
  border-radius: var(--radius-control);
  transition: background-color .15s ease;
}
.stat-link:hover {
  background: rgba(59, 130, 246, 0.08);
}

/* 班级名旁的齿轮按钮 */
.class-gear {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  justify-content: center;
  margin-right: 2px;
  padding: 4px 9px 4px 7px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}
.gear-text {
  font-size: 13px;
  line-height: 1;
  padding-top: 1px;
}
.class-gear:hover {
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
}

/* ======================== 首屏组件内加载条 ========================
   卡片外壳、标题、时钟始终常驻，只有依赖 /api/dashboard 的数据区替换成灰条。
   高度按各类卡片的常见行数对齐，数据到位后不产生明显跳动。
   底色与流光复用全局 .skeleton-block —— 它默认 height:320px，这里必须用双类选择器压回实际高度。 */
.skeleton-block.sk-title { display: block; height: 28px; width: 58%; border-radius: 6px; }
.skeleton-block.sk-num { display: block; height: 18px; width: 26px; border-radius: 4px; }
.skeleton-block.sk-text { display: block; height: 16px; width: 78%; border-radius: 4px; margin-bottom: 8px; }
.skeleton-block.sk-text-wide { width: 45%; }
.skeleton-block.sk-row { height: 34px; border-radius: 8px; margin-bottom: 6px; }
.skeleton-block.sk-hero { height: 34px; width: 150px; border-radius: 6px; margin-bottom: 12px; }
.skeleton-block.sk-photo { height: 176px; border-radius: 8px; margin-bottom: 6px; }
.skeleton-block.sk-btn { height: 31px; width: 120px; border-radius: 6px; margin: 12px auto 0; }
</style>
