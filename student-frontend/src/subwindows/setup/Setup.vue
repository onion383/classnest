<template>
  <div class="setup-wrap">
    <!-- 画面切换（提示 / 欢迎 / 步骤）：只让内容淡出/淡入，整窗卡片的背景与模糊保持不动 -->
    <Transition name="wfade" mode="out-in">
    <!-- 低版本系统提示：与安装器同款一屏，复用欢迎页的卡片与居中布局，仅内容区不同 -->
    <div v-if="screen === 'warning'" class="setup-card bg-surface welcome">
      <div class="welcome-inner">
        <img src="/logo.webp" alt="logo" class="welcome-logo" />
        <div class="welcome-title">
          <span class="welcome-name">班集</span>
        </div>
        <p class="ow-msg">检测到您正在运行的系统版本过低，可能导致软件异常或崩溃，建议将系统升级到 Windows 10 1709 或更高版本</p>
        <div class="ow-btns">
          <div class="ow-actions">
            <button type="button" class="ow-btn ow-ghost" @click="quitSetup">退出程序</button>
            <button type="button" class="ow-btn ow-primary" @click="ignoreWarn">忽略</button>
          </div>
          <button type="button" class="ow-btn ow-ghost ow-download" @click="openDownload">获取最新的 Windows</button>
        </div>
        <label class="ow-remember">
          <input type="checkbox" v-model="warnRemember" />
          <span>不再提示</span>
        </label>
      </div>
    </div>

    <!-- 欢迎页：引导前的独立一屏，点击「开始」再进入下面的引导流程 -->
    <div v-else-if="screen === 'welcome'" class="setup-card bg-surface welcome">
      <button
        type="button"
        class="welcome-x dlg-close absolute! top-3 right-3"
        title="关闭"
        @click="askQuit()"
      >&times;</button>
      <div class="welcome-inner">
        <img src="/logo.webp" alt="logo" class="welcome-logo" />
        <div class="welcome-title">
          <span class="welcome-name">班集</span>
          <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold text-white bg-blue-500 leading-none">预览版</span>
        </div>
        <p class="welcome-hi">欢迎使用~</p>
        <p class="welcome-tip">目前这个版本仍然在测试状态，可能会不稳定或者有破坏性改动，尽请谅解</p>
        <p class="welcome-tip">首次使用前，我们需要进行一些初始化设置</p>
        <button type="button" class="btn-primary welcome-btn" @click="screen = 'mode'">开始</button>
      </div>
    </div>

    <!-- 引导方式：标题栏与步骤页完全同款（左上角位置、字号一致），下方两张卡片并排，
         底部同为「上一步 / 下一步」。两种方式写入的设置完全相同，差别只在走几步。 -->
    <div v-else-if="screen === 'mode'" class="setup-card bg-surface">
      <div class="setup-head">
        <h1 class="setup-title">引导方式</h1>
        <p class="setup-desc">两种方式引导的所有设置均可在进入软件后修改，请不用担心</p>
        <button
          type="button"
          class="setup-x dlg-close absolute! top-3 right-3"
          title="关闭"
          @click="askQuit()"
        >&times;</button>
      </div>

      <div class="mode-body" role="radiogroup" aria-label="引导方式">
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'fast'"
          class="mode-card"
          :class="{ 'is-active': mode === 'fast' }"
          @click="mode = 'fast'"
        >
          <span class="mode-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path class="ic-fill" d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
            </svg>
          </span>
          <span class="mode-card-head">
            <span class="mode-card-name">快速引导</span>
            <span class="mode-card-badge">推荐</span>
          </span>
          <span class="mode-card-steps">3 步骤</span>
          <span class="mode-card-note">帮助您快速完成软件的基础设置，其余的可以进入软件后再调整。</span>
          <span class="mode-card-list">
            <span class="mode-card-list-title">包括</span>
            <span class="mode-card-tags">
              <span class="mode-card-tag">用户须知</span>
              <span class="mode-card-tag">账户设置</span>
              <span class="mode-card-tag">班级与学期</span>
            </span>
          </span>
        </button>

        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'full'"
          class="mode-card"
          :class="{ 'is-active': mode === 'full' }"
          @click="mode = 'full'"
        >
          <span class="mode-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" />
              <circle class="ic-fill" cx="15" cy="7" r="2" />
              <circle class="ic-fill" cx="9" cy="12" r="2" />
              <circle class="ic-fill" cx="15" cy="17" r="2" />
            </svg>
          </span>
          <span class="mode-card-head">
            <span class="mode-card-name">全面引导</span>
          </span>
          <span class="mode-card-steps">6 步骤</span>
          <span class="mode-card-note">帮助您较为完整地完成软件设置，适合想一次配好的情况。</span>
          <span class="mode-card-list">
            <span class="mode-card-list-title">包括</span>
            <span class="mode-card-tags">
              <span class="mode-card-tag">用户须知</span>
              <span class="mode-card-tag">账户设置</span>
              <span class="mode-card-tag">班级与学期</span>
              <span class="mode-card-tag">主题选择</span>
              <span class="mode-card-tag">储存设置</span>
              <span class="mode-card-tag">功能开关</span>
            </span>
          </span>
        </button>
      </div>

      <div class="setup-foot">
        <div class="foot-btns">
          <button type="button" class="btn-ghost" @click="screen = 'welcome'">上一步</button>
          <button type="button" class="btn-primary" @click="startWizard(mode)">下一步</button>
        </div>
      </div>
    </div>

    <div v-else class="setup-card bg-surface">
      <!-- 顶部标题（可拖拽移动窗口） -->
      <div class="setup-head">
        <h1 class="setup-title">首次安装引导</h1>
        <p class="setup-desc">完成以下设置即可开始使用</p>
        <!-- 首次初始化进度：常驻右上角的小胶囊，任何一步都能看到后端在预热。
             放在标题栏里但 pointer-events:none —— 它只是状态展示，不该抢拖拽或点击；
             关闭按钮在它右侧（right-3），所以胶囊的 right 要留出关闭按钮的宽度。 -->
        <span
          class="perf-chip"
          :class="{ 'is-done': warmup.done }"
          :title="warmup.done ? '首次性能优化已完成' : (warmup.detail || warmup.phase || '正在初始化')"
        >
          <span class="perf-dot" :class="warmup.done ? 'is-ok' : 'is-run'"></span>
          <span>{{ warmup.done ? '首次性能优化已完成' : '首次性能优化中' }}</span>
          <span v-if="!warmup.done" class="perf-chip-num">{{ warmup.percent || 0 }}%</span>
        </span>
        <!-- 右上角关闭：作为可拖拽标题栏的子元素（与欢迎页 × 同结构），
             no-drag 才会真正生效、点击才可响应；点击完全退出软件（前后端） -->
        <button
          type="button"
          class="setup-x dlg-close absolute! top-3 right-3"
          title="关闭"
          @click="askQuit()"
        >&times;</button>
      </div>

      <div class="setup-body">
        <!-- 左栏：只读进度（顺序编号，不可点击切换） -->
        <aside class="setup-side glass-panel">
          <div
            v-for="it in list"
            :key="it.key"
            class="setup-item"
            :class="{ 'is-done': it.state === 'done', 'is-active': it.state === 'active' }"
          >
            <span class="setup-item-idx">{{ it.state === 'done' ? '✓' : it.no }}</span>
            <span class="setup-item-label">{{ it.label }}</span>
          </div>
        </aside>

        <!-- 右栏：当前步骤内容 -->
        <section class="setup-main glass-panel">
          <Transition :name="transitionName" mode="out-in">
          <div :key="paneKey" class="pane-wrap">
          <!-- ===== 用户须知 ===== -->
          <template v-if="current === 'notice'">
            <div class="pane">
              <div class="notice-list">
                <div class="notice-item">
                  <div class="notice-title">开源许可</div>
                  <p class="notice-desc">本软件依据 MIT License（MIT 许可证）发布，可自由使用、复制、修改、分发，也可用于商业用途；分发时保留版权声明与许可声明即可。完整条款见安装包内《用户协议》与仓库 LICENSE.md。</p>
                </div>
                <div class="notice-item">
                  <div class="notice-title">本地优先，数据安全</div>
                  <p class="notice-desc">所有数据均保存在您的本地设备中，遵循「本地优先」原则；本软件不会采集、上传或分析您的任何数据，仅在您使用 AI 助手、以及检查与下载更新时才会使用网络。</p>
                </div>
                <div class="notice-item">
                  <div class="notice-title">密码提醒</div>
                  <p class="notice-desc">如果您设置了账户的密码并开启了超级隐私模式，请牢牢记住账户密码和 12 词恢复词，一旦两者都丢失将无法恢复（开发者也没有办法哦）。如果您担心忘记密码，可以设置无密码账户。</p>
                </div>
              </div>
            </div>
          </template>

          <!-- ===== 账户设置 ===== -->
          <template v-else-if="current === 'account'">
            <!-- 已确认：只读摘要。此时账号还没真正创建（建库在点「完成」时），
                 所以给一个「修改」入口 —— 返回上一步改用户名不该是死路。 -->
            <div v-if="accountReady" class="done-box">
              <div class="done-head">
                <div class="done-title">账户信息已确认</div>
                <button type="button" class="btn-ghost done-edit" @click="editAccount">修改</button>
              </div>
              <div class="f-row">
                <label class="f-label">用户名</label>
                <div class="f-static">{{ account.username }}</div>
              </div>
              <div class="f-row">
                <label class="f-label">安全等级</label>
                <div class="f-static">{{ securityLevelLabel }}</div>
              </div>
              <p class="f-hint">点击「修改」可以再次修改账户。</p>
            </div>

            <template v-else>
              <!-- 账户信息 -->
              <div v-if="subKey === 'info'" class="pane">
                <div class="f-row">
                  <label class="f-label">安全等级</label>
                  <AppSelect v-model="account.securityLevel" :options="securityLevels" placeholder="请选择模式" class="flex-1 min-w-0" />
                </div>
                <div class="f-row">
                  <label class="f-label">用户名</label>
                  <input
                    v-model.trim="account.username"
                    class="f-input"
                    placeholder="2-30 个字符"
                    autocomplete="off"
                  />
                </div>
                <template v-if="canSetPassword">
                  <div class="f-row">
                    <label class="f-label">密码</label>
                    <input
                      v-model="account.password"
                      type="password"
                      class="f-input"
                      placeholder="至少 6 位"
                      autocomplete="new-password"
                    />
                  </div>
                  <div class="f-row">
                    <label class="f-label">确认密码</label>
                    <input
                      v-model="account.confirm"
                      type="password"
                      class="f-input"
                      placeholder="再次输入密码"
                      autocomplete="new-password"
                    />
                  </div>
                </template>
                <p v-if="account.securityLevel === 'plain'" class="f-hint ind">明文模式下数据库不加密，任何程序都可直接读取；之后可在系统设置中升级为加密等级。</p>
                <p v-else-if="account.securityLevel === 'nopass'" class="f-hint ind">数据仍加密，但登录无需密码；之后可在系统设置中切换为密码或隐私模式。</p>
                <p v-else-if="account.securityLevel === 'privacy'" class="f-hint ind">需凭密码或 12 词恢复词解锁数据库，两者都丢失将无法恢复。</p>
                <p v-if="errorMsg" class="f-error">{{ errorMsg }}</p>
              </div>

              <!-- 恢复密钥（仅超级隐私模式出现） -->
              <div v-else class="pane">
                <p class="f-hint">这是超级隐私模式的恢复词，也是忘记密码时的唯一凭证；请抄写保存，随后输入前 3 个词完成注册。</p>
                <div class="phrase-box">{{ recovery.phrase }}</div>
                <div class="btn-row">
                  <button type="button" class="btn-ghost" @click="downloadPhrase">下载文本</button>
                  <button type="button" class="btn-ghost" @click="copyPhrase">复制</button>
                </div>
                <div class="f-row">
                  <label class="f-label">抄写前 3 词</label>
                  <input
                    v-model="recovery.copyWords"
                    class="f-input"
                    placeholder="可带序号、可不带空格"
                    autocomplete="off"
                  />
                </div>
                <p v-if="errorMsg" class="f-error">{{ errorMsg }}</p>
              </div>
            </template>
          </template>

          <!-- ===== 班级与学期 ===== -->
          <template v-else-if="current === 'class'">
            <div class="pane">
              <div class="f-row">
                <label class="f-label">班级名称 <i class="req">*</i></label>
                <input v-model.trim="classInfo.name" class="f-input" placeholder="如：高一（3）班" autocomplete="off" />
              </div>
              <div class="f-row">
                <label class="f-label">学期名称 <i class="req">*</i></label>
                <input v-model.trim="semester.name" class="f-input" placeholder="如：2026秋季学期" autocomplete="off" />
              </div>
              <div class="f-row">
                <label class="f-label">开始日期</label>
                <input v-model="semester.start" type="date" class="f-input" />
              </div>
              <div class="f-row">
                <label class="f-label">结束日期</label>
                <input v-model="semester.end" type="date" class="f-input" />
              </div>
              <p v-if="errorMsg" class="f-error">{{ errorMsg }}</p>
              <p class="f-hint">学期起止日期已按当前月份填好推荐值，可直接修改。</p>
              <p class="f-hint">值日与座位的补存范围、座位指数结算都依赖它计算，之后也能在「设置 → 学期设置」里修改。</p>
            </div>
          </template>

          <!-- ===== 主题选择 ===== -->
          <template v-else-if="current === 'theme'">
            <div class="pane">
              <!-- 列表来自 store 的 allThemes -->
              <div class="theme-grid">
                <button
                  v-for="t in themeStore.allThemes"
                  :key="t.id"
                  type="button"
                  class="theme-card"
                  :class="{ 'is-active': themeStore.currentTheme === t.id }"
                  @click="pickTheme(t.id)"
                >
                  <span class="theme-preview" :style="previewStyle(t.id)">
                    <span class="tp-side"></span>
                    <span class="tp-bar"></span>
                    <span class="tp-dot"></span>
                  </span>
                  <span class="theme-name">{{ t.name }}</span>
                </button>
              </div>
              <!-- 日夜模式：与设置页同一控件；不支持夜间配色的主题固定日间并置灰 -->
              <div class="mode-row">
                <span class="f-label">日夜模式</span>
                <div class="mode-switch" :class="{ 'is-disabled': !nightSupported }">
                  <ViewSwitch :modelValue="pendingMode" :options="modeSwitchOptions" @update:modelValue="onSelectMode" />
                </div>
                <span class="mode-hint">{{ nightSupported ? '当前主题支持夜间配色' : '当前主题不支持夜间配色，固定为日间' }}</span>
              </div>
              <div class="anim-toggle">
                <span class="anim-toggle-text">
                  <span class="anim-toggle-label">启用动画效果</span>
                  <span class="anim-toggle-desc">关闭后禁用全部过渡与动画（含窗口淡入淡出、弹窗与列表动效）</span>
                </span>
                <AppSwitch :model-value="themeStore.animationsEnabled" aria-label="启用动画效果" @change="onAnimationsChange" />
              </div>
              <p class="f-hint">默认使用毛玻璃主题，点击即可实时预览效果。</p>
            </div>
          </template>

          <!-- ===== 储存设置 ===== -->
          <template v-else-if="current === 'storage'">
            <div class="pane">
              <div class="f-row">
                <label class="f-label">数据库目录</label>
                <div class="f-static truncate" :title="dirs.dataDir">{{ dirs.dataDir || '加载中…' }}</div>
                <button type="button" class="btn-info" :disabled="busyDataDir" @click="changeDataDir">
                  {{ busyDataDir ? '处理中…' : '修改' }}
                </button>
                <button type="button" class="btn-ghost" :disabled="busyDataDir" @click="openDir(dirs.dataDir)">打开</button>
              </div>
              <p class="f-hint ind">存放数据库与上传图片等用户数据的目录。</p>

              <div class="f-row">
                <label class="f-label">缩略图缓存</label>
                <div class="f-static truncate" :title="dirs.thumbsDir">{{ dirs.thumbsDir || '加载中…' }}</div>
                <button type="button" class="btn-info" :disabled="busyThumbsDir" @click="changeThumbsDir">
                  {{ busyThumbsDir ? '处理中…' : '修改' }}
                </button>
                <button type="button" class="btn-ghost" :disabled="busyThumbsDir" @click="openDir(dirs.thumbsDir)">打开</button>
              </div>
              <p class="f-hint ind">相册缩略图是可再生的缓存，可放到独立目录（如临时盘/SSD）。</p>

              <p v-if="errorMsg" class="f-error">{{ errorMsg }}</p>
              <p v-if="storageHint" class="f-ok">{{ storageHint }}</p>
            </div>
          </template>

          <!-- ===== 功能开关 ===== -->
          <template v-else-if="current === 'features'">
            <div class="pane">
              <!-- 三项默认关闭（opt-in）：首次进入不该先被一堆窗口围住 -->
              <!-- 卡片间距与「用户须知」的 .notice-list 保持一致（14px），别让三张卡贴成一块 -->
              <div class="feature-list">
                <div class="anim-toggle">
                  <span class="anim-toggle-text">
                    <span class="anim-toggle-label">启用工具箱</span>
                    <span class="anim-toggle-desc">屏幕左边的浮标，内含便签、截图与常用软件</span>
                  </span>
                  <AppSwitch :model-value="features.toolbox" aria-label="启用工具箱" @change="onFeatureChange('toolbox', $event)" />
                </div>
                <div class="anim-toggle">
                  <span class="anim-toggle-text">
                    <span class="anim-toggle-label">启用桌面小组件</span>
                    <span class="anim-toggle-desc">贴在桌面上显示时钟、便签与常用软件（置底显示，不挡操作）</span>
                  </span>
                  <AppSwitch :model-value="features.desktopWidget" aria-label="启用桌面小组件" @change="onFeatureChange('desktopWidget', $event)" />
                </div>
                <div class="anim-toggle">
                  <span class="anim-toggle-text">
                    <span class="anim-toggle-label">插入新 U 盘时自动打开</span>
                    <span class="anim-toggle-desc">用文件资源管理器打开刚插入的 U 盘（仅 Windows）</span>
                  </span>
                  <AppSwitch :model-value="features.usbAutoOpen" aria-label="插入新U盘时自动打开" @change="onFeatureChange('usbAutoOpen', $event)" />
                </div>
                <p v-if="errorMsg" class="f-error">{{ errorMsg }}</p>
                <p class="f-hint">都不是必选项，全部不勾也能正常使用。之后可随时在「设置 → 工具箱设置 / 桌面小组件设置」里改。</p>
              </div>
            </div>
          </template>

          </div>
          </Transition>
        </section>
      </div>

      <!-- 底部操作：首次初始化进度已挪到右上角胶囊（全程可见，不再只挂在最后一屏） -->
      <div class="setup-foot">
        <div class="foot-btns">
          <button type="button" class="btn-ghost" :disabled="!canPrev || busy" @click="prev">上一步</button>
          <span class="step-indicator">{{ activeNo }} / {{ totalSteps }}</span>
          <button type="button" class="btn-primary" :disabled="busy" @click="next">
            {{ nextLabel }}
          </button>
        </div>
      </div>
    </div>
    </Transition>
  </div>
  <!-- 关闭引导确认：× 的位置很小、误触代价却不小（会丢掉「已完成引导」标记，
       下次启动还得重走），所以关窗之前统一拦一道 -->
  <ConfirmDialog
    v-if="quitWarnVisible"
    :visible="quitWarnVisible"
    title="温馨提示"
    message="确认关闭引导吗？如果本次关闭引导，下次启动的时候需要重新引导。"
    :show-cancel="true"
    confirm-text="确认"
    cancel-text="取消"
    @confirm="onQuitConfirm"
    @cancel="quitWarnVisible = false"
  />
  <!-- 预热未完成时点「完成」的提示：只有「知道了」，没有取消（不是让用户选择，是告知） -->
  <ConfirmDialog
    v-if="perfWarnVisible"
    :visible="perfWarnVisible"
    title="温馨提示"
    message="首次性能优化还未完成，进入程序可能会卡顿，请不用担心。"
    :show-cancel="false"
    confirm-text="知道了"
    @confirm="onPerfWarnConfirm"
  />
  <!-- 安全等级风险说明：普通密码只有「确定」，超级隐私「确认 / 取消」（取消回退默认档） -->
  <ConfirmDialog
    v-if="levelTipVisible"
    :visible="levelTipVisible"
    title="安全等级说明"
    :message="levelTipMessage"
    :show-cancel="levelTipType === 'privacy'"
    :confirm-text="levelTipType === 'privacy' ? '确认' : '确定'"
    cancel-text="取消"
    @confirm="levelTipVisible = false"
    @cancel="onLevelTipCancel"
  />
</template>

<script setup>
import { setToken, setCurrentUser, getToken } from '../../utils/authStorage.js'
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import axios from 'axios'
import { useThemeStore } from '../../stores/theme'
import { waitForBackendReady } from '../../utils/backendReady'
import { SEND, INVOKE, RECEIVE } from '../../electronChannels.js'
import { storeMediaToken } from '../../utils/apiUrl'
import AppSelect from '../../components/base/AppSelect.vue'
import AppSwitch from '../../components/base/AppSwitch.vue'
import ViewSwitch from '../../components/base/ViewSwitch.vue'
import ConfirmDialog from '../../components/base/ConfirmDialog.vue'

// 主题预览色：仅用于「主题选择」的缩略示意（真实配色由各主题 CSS 变量驱动）
const PREVIEW = {
  base: { bg: '#f9fafb', side: '#1f2937', bar: '#22c55e' },
  glass: { bg: '#dfe9f5', side: '#ffffff', bar: '#3b82f6' },
  glass2: { bg: '#e6ecff', side: '#ffffff', bar: '#5b7cfa' },
}

// 引导方式：'fast'（3 步）/ 'full'（6 步）。两者共用同一份步骤实现，只差「中间三步走不走」。
// 「用户须知」两种模式都要走：开源许可、本地优先、密码提醒属于告知，不能因为选了快速就省掉。
// 每次进入都要选一次：开发模式每次启动都会重走引导，模式不该被上次的选择锁住。
const mode = ref('fast')

const FULL_STEPS = [
  { key: 'notice', label: '用户须知' },
  { key: 'account', label: '账户设置' },
  { key: 'class', label: '班级与学期' },
  { key: 'theme', label: '主题选择' },
  { key: 'storage', label: '储存设置' },
  { key: 'features', label: '功能开关' },
]
const FAST_STEPS = [
  { key: 'notice', label: '用户须知' },
  { key: 'account', label: '账户设置' },
  { key: 'class', label: '班级与学期' },
]
// 「性能优化」不在这里：它是一块常驻右上角的胶囊（见 .perf-chip），不占步骤编号。
// 快速模式也没有「完成」摘要屏：跳过的项本来就全用默认值，再列三行「改」等于
// 让用户逐个点开确认——正好违背「快速 = 降低认知成本」。要调的去设置里调。
const STEPS = computed(() => (mode.value === 'fast' ? FAST_STEPS : FULL_STEPS))

const SECURITY_LEVELS = [
  { value: 'plain', label: '明文模式（不加密）' },
  { value: 'nopass', label: '无密码模式（加密，免密码登录）' },
  { value: 'password', label: '普通密码模式（加密 + 登录密码）' },
  { value: 'privacy', label: '超级隐私模式（密码 + 恢复词才能解锁）' },
]

defineOptions({ name: 'Setup' })

const props = defineProps({
  // 首屏画面，由 src/setup/main.js 依据主进程 launch-plan / URL 参数解析后传入
  initialScreen: { type: String, default: 'welcome' },
  // 本次启动计划：warn=提示画面，setup=是否还需走首次引导（决定「忽略」后去哪）
  plan: { type: Object, default: () => ({ warn: false, setup: true }) },
})

const themeStore = useThemeStore()

// 当前画面：'warning'（低版本提示）| 'welcome'（欢迎）| 'wizard'（引导步骤）
const screen = ref(props.initialScreen) // 首屏由主进程计划决定
const warnRemember = ref(false) // 低版本提示页「不再提示」勾选
const step = ref(0)
const sub = ref(0)
const dir = ref(1) // 1=下一步（新卡片从右进）| -1=上一步（新卡片从左进）
// 账户表单是否已确认（草稿已就绪）。**这不等于账号已存在** —— 真正建库在点「完成」时，
// 所以中途返回上一步仍可改用户名（见 editAccount）。
const accountReady = ref(false)
// 后端草稿 id（所有安全等级都有；超级隐私模式还要靠它取恢复词）
const accountDraftId = ref('')
// 本轮引导是否已经建号：finish 里学期保存失败后重试时，绝不能重复调 confirm
// （草稿在 confirm 成功时已被消费，再调只会报「确认已过期」）
const accountCreated = ref(false)
const busy = ref(false)
const errorMsg = ref('')
const storageHint = ref('')
const account = ref({
  username: '',
  password: '',
  confirm: '',
  // plain=明文 | nopass=加密免密 | password=加密+密码 | privacy=超级隐私
  // 默认留空（下拉显示「请选择模式」）：与登录页注册保持一致，安全等级必须由用户自己选一次
  securityLevel: '',
})
// 安全等级风险说明弹窗（超级隐私模式的「取消」退回未选择状态）
const levelTipVisible = ref(false)
const levelTipType = ref('password')
const levelTipSuppress = ref(false)
const recovery = ref({
  phrase: '',
  draftId: '',
  copyWords: '',
  saved: false,
})
const classInfo = ref({ name: '' })
// 学期：id 非空 = 库里已有当前学期（引导在开发模式下每次启动都会重走，那就要「改」而不是「再插一条」）
const semester = ref({ id: null, name: '', start: '', end: '' })
const semesterPrefilled = ref(false)
// 功能开关：三项默认全关（与三个功能的默认值一致 —— 首次进入不先弹一堆窗口）
const features = ref({ toolbox: false, desktopWidget: false, usbAutoOpen: false })
// 工具箱的当前值只有读到了才可信：读不到就既不显示为「开」，也不在完成时回写（否则会把库里的开静默改掉）
const featuresLoaded = ref(false)
// 日夜模式切换：与设置页同一套控件（仅 glass / glass2 支持夜间配色）
const modeSwitchOptions = [
  { value: 'day', label: '日间', icon: 'sun' },
  { value: 'night', label: '夜间', icon: 'moon' },
]
const dirs = ref({ dataDir: '', thumbsDir: '' })
const busyDataDir = ref(false)
const busyThumbsDir = ref(false)
const warmup = ref({ phase: '', detail: '', percent: 0, done: false })
// 预热没跑完就点「完成」时的温馨提示（见 tryFinish）。只提示一次：学期保存失败留在
// 同一屏再点「完成」时不该再弹一遍，否则成了「每次都要点知道了」的拦路虎。
const perfWarnVisible = ref(false)
const perfWarnAcknowledged = ref(false)
// on() 返回的订阅句柄（非响应式），卸载时按句柄退订
let _onMain = null

const totalSteps = computed(() => STEPS.value.length)
const current = computed(() => STEPS.value[step.value].key)
const isLastStep = computed(() => step.value === STEPS.value.length - 1)
// 安全等级说明弹窗文案（与登录页注册保持一致）
const levelTipMessage = computed(() => {
  return levelTipType.value === 'privacy'
    ? '请您妥善保管好您的密钥，如果丢失，任何人将无法打开您的数据（包括开发者），若担心密码丢失，请使用其他模式'
    : '普通密码模式只能保证其他 Windows 用户无法访问，并且能保证自己复制数据库到其他电脑无法打开。同一个 Windows 用户仍然可以通过数据恢复打开，如果需要严格的保护隐私，请使用超级隐私模式'
})
const activeNo = computed(() => step.value + 1)
// 总能「上一步」：即使在第一步，也会回到最前面的欢迎页
const canPrev = computed(() => {
  return true
})
// 切换动画的 key：步骤或子步骤变化都会重新触发过渡
const paneKey = computed(() => `${current.value}-${subKey.value}`)
const transitionName = computed(() => dir.value < 0 ? 'slide-prev' : 'slide-next')
// 有密码时账户设置分 2 个子步骤，否则 1 个（无需抄写恢复密钥）
const subSteps = computed(() => {
  const arr = [
    { key: 'info', label: '账户信息' },
  ]
  if (recovery.value.phrase) arr.push({ key: 'recovery', label: '恢复密钥' })
  return arr
})
const subKey = computed(() => subSteps.value[Math.min(sub.value, subSteps.value.length - 1)].key)
const canSetPassword = computed(() => account.value.securityLevel === 'password' || account.value.securityLevel === 'privacy')
const securityLevels = SECURITY_LEVELS
const nightSupported = computed(() => themeStore.nightSupported)
const pendingMode = computed(() => themeStore.pendingMode)
const securityLevelLabel = computed(() => {
  return {
    plain: '明文模式',
    nopass: '无密码模式',
    password: '普通密码模式',
    privacy: '超级隐私模式',
  }[account.value.securityLevel] || '—'
})
// 学期起止校验：与后端 validateSemesterRange 同口径（YYYY-MM-DD 字典序即时间序）。
// 为什么前端也要拦：存反了 semesterRange() 解析成「结束 < 开始」，值日/座位的快照补存会整段
// 静默跳过，表现为「历史记录一直是空的」，而界面上看不出哪里错了。
const semesterDateError = computed(() => {
  const { start, end } = semester.value
  if (!start || !end) return '请填写学期起止日期'
  if (end < start) return '学期结束日期不能早于开始日期'
  return ''
})
const nextLabel = computed(() => {
  if (busy.value) return '处理中…'
  return isLastStep.value ? '完成' : '下一步'
})
// 左栏进度：已过步骤为 done、当前为 active、其后为 pending
const list = computed(() => {
  return STEPS.value.map((s, i) => ({
    key: s.key,
    label: s.label,
    no: i + 1,
    state: i < step.value ? 'done' : (i === step.value ? 'active' : 'pending'),
  }))
})

// 安全等级变化：清理不适用的密码与旧草稿，避免用上一等级的草稿完成注册
watch(() => account.value.securityLevel, (v) => {
  if (v === 'plain' || v === 'nopass') {
    account.value.password = ''
    account.value.confirm = ''
  }
  recovery.value.phrase = ''
  recovery.value.draftId = ''
  recovery.value.copyWords = ''
  recovery.value.saved = false
  // 取消隐私模式后回退到未选择是程序化赋值，不再弹一次普通密码说明
  if (!levelTipSuppress.value) tipSecurityLevel(v)
})
// 进入账户设置步骤不再主动弹说明：默认没有预选等级，说明只在用户自己选到
// 「普通密码 / 超级隐私」时由上面的 watch 弹一次（与登录页注册口径一致）
// 子步骤数量变化（密码清空 → 恢复密钥子步骤消失）时收敛下标
watch(subSteps, () => {
  if (sub.value > subSteps.value.length - 1) sub.value = subSteps.value.length - 1
})

// 选择安全等级时的风险说明弹窗（与登录页注册一致）：普通密码只有「确定」，超级隐私「确认 / 取消」
function tipSecurityLevel(v) {
  if (v !== 'password' && v !== 'privacy') return
  levelTipType.value = v
  levelTipVisible.value = true
}
// 超级隐私模式的「取消」：退回未选择状态（下拉重新显示「请选择模式」），且不再连锁弹出说明
function onLevelTipCancel() {
  levelTipVisible.value = false
  levelTipSuppress.value = true
  account.value.securityLevel = ''
  nextTick(() => { levelTipSuppress.value = false })
}
// ---------- 主题 ----------
function previewStyle(id) {
  const p = PREVIEW[id] || PREVIEW.glass
  return { background: p.bg, '--tp-side': p.side, '--tp-bar': p.bar }
}
function pickTheme(id) {
  themeStore.setTheme(id)
  // 切到不支持夜间配色的主题时，立即回落到日间
  if (!themeStore.nightSupported && themeStore.pendingMode === 'night') {
    themeStore.setMode('day')
  }
}
// 日夜模式：仅支持夜间配色的主题可切换
function onSelectMode(value) {
  if (!nightSupported.value) return
  themeStore.setMode(value)
}
// 动画效果总开关：立即生效
function onAnimationsChange(value) {
  themeStore.setAnimationsEnabled(!!value)
}
// ---------- 预热进度 ----------
function applyWarmup(w) {
  warmup.value = {
    phase: w.phase || '',
    detail: w.detail || '',
    percent: typeof w.percent === 'number' ? w.percent : 0,
    done: !!w.done,
  }
}
async function loadWarmup() {
  try {
    const w = await window.electron?.invoke(INVOKE.GET_SETUP_WARMUP)
    if (w) applyWarmup(w)
  } catch (_) {}
}
// ---------- 储存设置 ----------
async function loadDirs() {
  try {
    const res = await window.electron?.invoke(INVOKE.GET_DATA_DIRECTORIES)
    if (res) dirs.value = { dataDir: res.dataDir || '', thumbsDir: res.thumbsDir || '' }
  } catch (_) {}
}
async function pickDir() {
  try {
    const res = await window.electron?.invoke(INVOKE.SELECT_FOLDER)
    if (res && res.filePaths && res.filePaths.length) return res.filePaths[0]
  } catch (_) {}
  return ''
}
function openDir(p) {
  if (p) window.electron?.invoke(INVOKE.OPEN_FOLDER, p)
}
async function changeDataDir() {
  const picked = await pickDir()
  if (!picked) return
  errorMsg.value = ''
  storageHint.value = ''
  busyDataDir.value = true
  try {
    const res = await window.electron.invoke(INVOKE.SET_INITIAL_DATA_DIR, { dataDir: picked })
    if (res && res.ok) {
      dirs.value = { dataDir: res.dataDir, thumbsDir: res.thumbsDir }
      storageHint.value = res.changed ? '数据库目录已更新' : '目录未变化'
    }
  } catch (err) {
    errorMsg.value = err?.message || '数据库目录修改失败'
  } finally {
    busyDataDir.value = false
  }
}
async function changeThumbsDir() {
  const picked = await pickDir()
  if (!picked) return
  errorMsg.value = ''
  storageHint.value = ''
  busyThumbsDir.value = true
  try {
    const res = await window.electron.invoke(INVOKE.SET_INITIAL_DATA_DIR, { thumbsDir: picked })
    if (res && res.ok) {
      dirs.value = { dataDir: res.dataDir, thumbsDir: res.thumbsDir }
      storageHint.value = res.changed ? '缩略图缓存目录已更新' : '目录未变化'
    }
  } catch (err) {
    errorMsg.value = err?.message || '缩略图缓存目录修改失败'
  } finally {
    busyThumbsDir.value = false
  }
}
// ---------- 学期 ----------
// 预填推荐日期：日期口径由后端 autoSemester() 唯一决定（设置页「增加学期」用的也是它），
// 渲染层不再抄一份月份分档。已有当前学期时后端返回它的真实值，这里就变成「带出原值」。
//
// 分流依据是「有没有登录态」：引导进行中账号还没创建（建库推迟到「完成」），
// 这时只能走免登录的 /api/setup/semester-prefill 拿纯推荐值；
// 已有账号重进引导时仍走 schedule 接口，才能拿到当前学期的 id（走 PUT、不再插一条）。
async function loadSemesterPrefill() {
  if (semesterPrefilled.value) return
  const url = getToken() ? '/api/schedule/semesters/prefill' : '/api/setup/semester-prefill'
  try {
    const { data } = await axios.get(url)
    semester.value = {
      id: data.id ?? null,
      name: data.name || '',
      start: data.start_date || '',
      end: data.end_date || '',
    }
    semesterPrefilled.value = true
  } catch (_) {
    // 后端未就绪时留空：用户手填也能走完，不因为预填失败卡住引导
  }
}
// ---------- 功能开关 ----------
// 三项的真相分散在三处：桌面小组件在 localStorage、U 盘在主进程的 json、工具箱在后端库。
// 进入该步各读一次，避免「翻回来时显示成默认值」—— 显示值和真正会写入的值必须一致。
async function loadFeaturePrefs() {
  try {
    features.value.desktopWidget = (localStorage.getItem('desktopWidgetEnabled') ?? '0') === '1'
  } catch (_) {}
  try {
    const res = await window.electron?.invoke(INVOKE.GET_USB_AUTO_OPEN)
    features.value.usbAutoOpen = !!res?.enabled
  } catch (_) {}
  try {
    const { data } = await axios.get('/api/widget-settings')
    if (data && data.success) {
      features.value.toolbox = !!data.data.toolboxEnabled
      featuresLoaded.value = true
    }
  } catch (_) {
    // 后端未就绪/未登录：工具箱保持未勾选，完成时也不回写（见 saveFeaturePrefs）
  }
}
function onFeatureChange(key, value) {
  features.value[key] = !!value
  errorMsg.value = ''
}
// 不阻塞「完成」：这三项都是可选项，写失败的方向是「少弹窗口」，
// 用户之后在设置里再开一次即可，没必要把人卡在最后一步。
// force：本次刚建号时必须写 —— 建号前 GET 拿不到库里的值（401），
// 不能把「没读到」当成「用户没开过」，否则引导里勾上的工具箱会在进系统后消失。
async function saveFeaturePrefs({ force = false } = {}) {
  try { localStorage.setItem('desktopWidgetEnabled', features.value.desktopWidget ? '1' : '0') } catch (_) {}
  try { await window.electron?.invoke(INVOKE.SET_USB_AUTO_OPEN, features.value.usbAutoOpen) } catch (err) {
    console.error('[setup] 保存U盘自动打开设置失败:', err)
  }
  if (!featuresLoaded.value && !force) return
  // 后端 PUT 只更新传入的字段（见 routes/widgetSettings.js 的 sets 分支），
  // 所以这里只传工具箱开关，不会碰到两个保存路径与常用软件列表。
  try {
    await axios.put('/api/widget-settings', { toolboxEnabled: !!features.value.toolbox })
  } catch (err) {
    console.error('[setup] 保存工具箱开关失败:', err)
  }
}
// 只在这一步进入时拉一次：来回翻步骤不该把用户勾过的项重置回库里的值。
// 也不能放 onMounted —— 那时账户还没建，GET /api/widget-settings 会 401。
watch(current, (v) => {
  if (v === 'class') loadSemesterPrefill()
  if (v === 'features') loadFeaturePrefs()
})

// ---------- 导航 ----------
// 进入引导：mode 决定走 3 步还是 6 步，步骤表是 computed，这里只切开关
function startWizard(m) {
  mode.value = m
  step.value = 0
  sub.value = 0
  errorMsg.value = ''
  screen.value = 'wizard'
}
function next() {
  errorMsg.value = ''
  dir.value = 1
  if (current.value === 'notice') { step.value += 1; return }
  if (current.value === 'account') return nextAccount()
  if (current.value === 'class') {
    if (!classInfo.value.name) { errorMsg.value = '请填写班级名称'; return }
    if (!semester.value.name) { errorMsg.value = '请填写学期名称'; return }
    const dateErr = semesterDateError.value
    if (dateErr) { errorMsg.value = dateErr; return }
    // 快速模式下这里就是最后一步：校验通过直接收尾。
    // 千万不能统一 `step += 1` —— 越界后 current 取到 undefined.key 会整屏白掉。
    if (isLastStep.value) return tryFinish()
    step.value += 1
    return
  }
  if (current.value === 'theme') { step.value += 1; return }
  if (current.value === 'storage') { step.value += 1; return }
  // features（完整模式最后一步）直接收尾：「性能优化」不是一步，也不在这一步里，
  // 它是常驻右上角的胶囊（.perf-chip）。
  return tryFinish()
}
function prev() {
  errorMsg.value = ''
  storageHint.value = ''
  dir.value = -1
  if (current.value === 'account' && sub.value > 0) { sub.value -= 1; return }
  // 已在第一步：退回「引导方式」选择屏（再往前是欢迎页）
  if (step.value === 0) { screen.value = 'mode'; return }
  step.value -= 1
  if (current.value === 'account') sub.value = subSteps.value.length - 1
}
// ---------- 账户设置 ----------
// 这一整步只准备「草稿」：草稿只活在内存里（pendingRegs，30 分钟 TTL），库里还没有账号。
// 真正建库发生在点「完成」时（finish → confirmAccount）。这样中途关窗、或返回上一步
// 改用户名，都不会在库里留下一个改不掉的半成品账号。
async function nextAccount() {
  if (accountReady.value) { step.value += 1; sub.value = 0; return }
  const key = subKey.value
  if (key === 'info') return submitAccountInfo()
  return confirmRegister()
}
function validateAccountInfo() {
  const { username, password, confirm, securityLevel } = account.value
  if (!securityLevel) return '请先选择安全模式'
  if (!username || username.length < 2 || username.length > 30) return '用户名需在 2-30 个字符之间'
  if (canSetPassword.value) {
    if (!password) return '请设置登录密码'
    if (password.length < 6) return '密码长度至少 6 位'
    if (password !== confirm) return '两次输入的密码不一致'
  }
  return ''
}
async function submitAccountInfo() {
  const bad = validateAccountInfo()
  if (bad) { errorMsg.value = bad; return }
  busy.value = true
  try {
    const level = account.value.securityLevel
    const payload = {
      username: account.value.username,
      role: 'teacher',
      encrypted: level !== 'plain',
      // defer：只存草稿、不建库（后端 routes/auth.js 的 defer 分支）
      defer: true,
    }
    if (level === 'privacy') payload.privacy = true
    if (canSetPassword.value) payload.password = account.value.password
    const { data } = await axios.post('/api/register', payload)
    accountDraftId.value = data.draftId || ''
    if (!accountDraftId.value) throw new Error('账户信息暂存失败，请重试')
    const phrase = data.recovery?.phrase || ''
    if (phrase) {
      // 超级隐私模式的恢复词就是库钥匙的第二把钥匙，必须在建库前抄好，所以仍在这一步展示
      recovery.value.draftId = accountDraftId.value
      recovery.value.phrase = phrase
      recovery.value.copyWords = ''
      recovery.value.saved = false
      sub.value = 1
      return
    }
    accountReady.value = true
    step.value += 1
  } catch (err) {
    errorMsg.value = err?.response?.data?.error || err?.message || '账户信息暂存失败，请重试'
  } finally {
    busy.value = false
  }
}
// 恢复词抄写确认：只做前端校验，**不再请求后端** —— 建库留给 finish()，
// 这样「上一步」改完用户名不会留下一个已经确认过的旧账号。
function confirmRegister() {
  if (!recovery.value.saved) { errorMsg.value = '请先下载或复制恢复密钥'; return }
  if (!checkCopyWords()) { errorMsg.value = '抄写的前 3 个词不正确，请核对'; return }
  errorMsg.value = ''
  accountReady.value = true
  sub.value = 0
  step.value += 1
}
// 回上一步改账户：丢掉上一份草稿的引用即可（草稿在内存里自然过期，从未占用账号）。
// 恢复词一起清掉 —— 换用户名后旧恢复词不再对应任何账号，留着只会误导。
function editAccount() {
  accountReady.value = false
  accountDraftId.value = ''
  recovery.value.phrase = ''
  recovery.value.draftId = ''
  recovery.value.copyWords = ''
  recovery.value.saved = false
  sub.value = 0
  errorMsg.value = ''
}
// 前端比对前 3 词：兼容序号、空格、连写（与登录页一致）
function checkCopyWords() {
  const norm = (s) => String(s || '').replace(/[\s\d.、,，]/g, '')
  const words = String(recovery.value.phrase || '').split(/\s+/).filter(Boolean).slice(0, 3).map(norm)
  return words.length === 3 && norm(recovery.value.copyWords) === words.join('')
}
function downloadPhrase() {
  const blob = new Blob([recovery.value.phrase], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `恢复密钥-${account.value.username || 'account'}.txt`
  // 挂到 DOM 再点击，且延迟回收 URL：立即 revokeObjectURL 可能让下载拿到空文件
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  recovery.value.saved = true
  errorMsg.value = ''
}
async function copyPhrase() {
  try {
    await navigator.clipboard.writeText(recovery.value.phrase)
    recovery.value.saved = true
    errorMsg.value = ''
  } catch (_) {
    errorMsg.value = '复制失败，请手动选择文本复制'
  }
}
// ---------- 关闭引导 ----------
// 关闭按钮（欢迎页 / 引导方式 / 各步骤页）：先弹一次确认，再通知主进程完全退出软件。
// 为什么拦一道：引导中途关闭会保留账户但丢掉「已完成引导」标记 —— 下次启动还得重走一遍，
// 而 × 只有一个像素见方的位置，误触代价不小（用户以为只是关个提示框）。
const quitWarnVisible = ref(false)
function askQuit() {
  quitWarnVisible.value = true
}
function onQuitConfirm() {
  quitWarnVisible.value = false
  quitSetup()
}
// 真正的退出：不写「引导完成」标记——下次启动仍会重新进入引导，不会直接进入主窗口。
function quitSetup() {
  window.electron?.send(SEND.SETUP_QUIT)
}
// ---------- 低版本系统提示 ----------
// 忽略：记录「不再提示」（如勾选），随即从提示画面进入下一屏。
// 还需引导时本页自行切到欢迎画面；纯提示时主进程会直接开主窗口并关闭本窗口。
function ignoreWarn() {
  window.electron?.send(SEND.LAUNCH_SKIP_WARN, { remember: warnRemember.value })
  if (!props.plan || props.plan.setup) screen.value = 'welcome'
}
// 获取最新的 Windows：默认浏览器打开系统下载页，随后主进程退出班集
function openDownload() {
  window.electron?.send(SEND.LAUNCH_OPEN_DOWNLOAD)
}
// ---------- 完成 ----------
// 学期写入：有当前学期就改它，没有才新建（新建时后端会把新行标为当前学期）。
// 为什么不直接 POST 一条：开发模式下引导每次启动都走一遍，POST 会让学期行越堆越多。
async function saveSemester() {
  const body = {
    name: semester.value.name,
    start_date: semester.value.start,
    end_date: semester.value.end,
  }
  if (semester.value.id) await axios.put(`/api/schedule/semesters/${semester.value.id}`, body)
  else await axios.post('/api/schedule/semesters', body)
}
// 收尾入口：预热（首次初始化）还在跑时先告知一句「可能会卡顿」，确认后再进。
// 为什么不直接等它跑完：预热在后台跑，用户可能三步就走完了，不该被它拖住；
// 但一点提示都不给，进主界面第一下卡顿又会被当成「软件坏了」。
function tryFinish() {
  if (!warmup.value.done && !perfWarnAcknowledged.value) {
    perfWarnVisible.value = true
    return
  }
  return finish()
}
function onPerfWarnConfirm() {
  perfWarnVisible.value = false
  perfWarnAcknowledged.value = true
  finish()
}
// 建号：把草稿变成真正的账号库（全程只该调用一次）。
// 非隐私档只传 draftId；超级隐私档还要带密码与恢复词，后端要拿它们包裹主密钥。
async function confirmAccount() {
  const body = { draftId: accountDraftId.value }
  if (account.value.securityLevel === 'privacy') {
    body.password = account.value.password
    body.phrase = recovery.value.phrase
  }
  const { data } = await axios.post('/api/register/confirm', body)
  if (data && data.token) setToken(data.token)
  storeMediaToken(data && data.mediaToken)
  if (data && data.user) setCurrentUser(data.user)
  return data
}
// 回到某个步骤（草稿过期时把用户送回账户步骤，而不是让他停在最后一屏反复点「完成」）
function gotoStep(key) {
  const i = STEPS.value.findIndex((s) => s.key === key)
  if (i >= 0) { step.value = i; sub.value = 0 }
}
async function finish() {
  busy.value = true
  errorMsg.value = ''
  // 本次调用开始时是否已有账号：学期保存失败后用户再点「完成」，不能重复建号
  const isNewAccount = !accountCreated.value
  try {
    await waitBackend()
    // 1) 建号：引导里所有设置填完之后才真正落库（见账户步骤的 defer 注释）
    if (isNewAccount) {
      try {
        await confirmAccount()
        accountCreated.value = true
      } catch (err) {
        const status = err?.response?.status
        if (status === 400 || status === 409) {
          // 草稿过期（30 分钟）或用户名在等待期间被占用：只能回账户步骤重填
          accountReady.value = false
          accountDraftId.value = ''
          recovery.value.phrase = ''
          recovery.value.draftId = ''
          recovery.value.copyWords = ''
          recovery.value.saved = false
          sub.value = 0
          errorMsg.value = `${err?.response?.data?.error || '账户信息已过期'}，请重新填写账户信息`
          gotoStep('account')
        } else {
          errorMsg.value = err?.response?.data?.error || '账户创建失败，请重试'
        }
        busy.value = false
        return
      }
    }
    // 2) 班级信息：班风/学风已从引导页移走（首页齿轮里仍可填），这里只提交班名。
    // PUT /class-info 会把没传的字段写成空串 —— 首次安装时本来就是空的，无副作用。
    try {
      await axios.put('/api/widget-settings/class-info', { name: classInfo.value.name })
    } catch (err) {
      // 班级信息保存失败不阻塞进入系统，仅记录
      console.error('[setup] 保存班级信息失败:', err)
    }
    // 3) 学期单独写且失败要拦住「完成」：起止日期是值日/座位补存范围的唯一来源，
    // 静默失败会让用户以为配好了，实际后续补存全按旧范围（或空范围）走。
    try {
      await saveSemester()
    } catch (err) {
      errorMsg.value = err?.response?.data?.error || '学期设置保存失败，请重试'
      busy.value = false
      return
    }
    // 4) 功能开关在学期之后写：它失败不拦「完成」，所以放最后，别挡住关键的那步。
    // isNewAccount 时强制落库：建号前读不到库里的工具箱状态（401），不能拿「没读到」当「不该写」。
    await saveFeaturePrefs({ force: isNewAccount })
    busy.value = false
    window.electron?.send(SEND.SETUP_COMPLETE)
  } catch (err) {
    errorMsg.value = err?.message || '完成引导失败，请重试'
    busy.value = false
  }
}
// 储存目录变更会重启后端，等待其恢复后再建号/写入
async function waitBackend(timeout = 15000) {
  const start = Date.now()
  for (;;) {
    try {
      // 探活必须用免登录接口：引导进行中账号还没创建，拿 /api/accounts 探会被 401 挡住，
      // 每次都要白等满 15 秒。validateStatus 让任何 HTTP 响应都算「后端活着」。
      await axios.get('/api/setup/semester-prefill', { validateStatus: () => true })
      return true
    } catch (_) {}
    if (Date.now() - start > timeout) return false
    // 优先等就绪信号：后端一就绪立即重试；信号缺失时退化为 300ms 退避
    await waitForBackendReady(300)
  }
}

onMounted(() => {
  const api = window.electron
  // 存下 on() 返回的 wrapper 作为订阅句柄，卸载时按句柄退订
  _onMain = api.on(RECEIVE.FROM_MAIN, (payload) => {
    if (payload && payload.type === 'setup-warmup') applyWarmup(payload)
  })
  // 通知主进程渲染层已就绪
  api.send(SEND.SETUP_READY)
  loadWarmup()
  loadDirs()
  // 同步当前主题（**仅当用户还没选过主题时**才落默认毛玻璃）。
  //
  // ⚠️ 原来写的是 `if (themeStore.currentTheme !== 'glass') setTheme('glass')` ——
  // 但 currentTheme 在**没有**保存值时读出来也是 'glass'（见 stores/theme.js 的 readTheme），
  // 所以这个条件实际等价于「用户选了非 glass 的主题」→ 正好把用户自己选的主题改掉。
  // 二次进入引导窗口时尤其明显：用户刚选完主题，组件挂载就把选择抹了。
  //
  // 正确判据：看 localStorage 里**有没有**已保存的主题 id。
  // 没有 → 全新安装，落默认；有 → 用户选过，尊重用户的选择。
  let hasSavedTheme = false
  try {
    hasSavedTheme = !!localStorage.getItem('app-theme')
  } catch (_) { /* 无 localStorage 环境：按没选过处理 */ }
  if (!hasSavedTheme) themeStore.setTheme('glass')
})
onBeforeUnmount(() => {
  if (_onMain) window.electron.off(RECEIVE.FROM_MAIN, _onMain)
})
</script>

<style scoped>
.setup-wrap {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
}
/* 第一层毛玻璃：整窗卡片（窗外为系统亚克力） */
.setup-card {
  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0 !important;
  overflow: hidden;
}
/* 欢迎页：整窗居中一屏，可拖拽移动窗口 */
.welcome {
  position: relative;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
}
/* 右上角关闭按钮：与弹窗 × 同款，不可拖拽 */
.welcome-x {
  -webkit-app-region: no-drag;
}
/* 步骤页右上角关闭按钮：定位/尺寸等复用与欢迎页 × 相同的 Tailwind 工具类
   （必须用 absolute! 覆盖 theme-glass.css 里 `:root[data-theme] button { position: relative }`），
   这里仅补一条不可拖拽声明 */
.setup-x {
  -webkit-app-region: no-drag;
}
.welcome-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 0 24px;
  /* 整体略向下偏移：正中最容易显得上方空旷 */
  transform: translateY(24px);
}
.welcome-logo {
  width: 96px;
  height: 96px;
  object-fit: contain;
}
.welcome-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
}
.welcome-name {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--color-text);
}
.welcome-hi {
  margin: 8px 0 0;
  font-size: 16px;
  color: var(--color-text-secondary);
}
.welcome-tip {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--color-text-muted);
}
.welcome-btn {
  margin-top: 28px;
  padding: 10px 44px;
  font-size: 15px;
  -webkit-app-region: no-drag;
}

/* 引导方式：标题栏直接复用 .setup-head —— 与后续步骤页同一位置、同一字号，切换画面时标题不跳动。
   卡片区用与 .setup-body 相同的内边距（0 16px），左边缘和后面的步骤内容对齐。 */
.mode-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 2px 16px 0;
  -webkit-app-region: no-drag;
}
.mode-card {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  /* 垂直居中：两张卡的内容块高度必须相等，否则短的那张会整体下移、图标标题对不齐。
     高度靠 .mode-card-tags 的 min-height 兜底（见下），不靠这里的对齐方式。 */
  justify-content: center;
  gap: 4px;
  padding: 32px 22px 20px;
  text-align: left;
  cursor: pointer;
  color: inherit;
  background: var(--color-surface-hover);
  /* 圆角与左栏当前步骤同一档（--radius-control），深色/基础主题下毛玻璃的 button 圆角不生效，
     这里必须自己声明，否则只有玻璃主题是圆角。 */
  border-radius: var(--radius-control);
  /* 不加可见描边：只靠底色区分选中/未选中。毛玻璃主题给 button 补了 border-width/style，
     颜色声明成 transparent 就能压住，也不需要提高选择器权重。 */
  border: 1px solid transparent;
  /* 只给位移动画：底色的切换要跟左栏一样「一下就到」，加过渡反而显得迟钝。
     这里的位移只服务按下反馈（:active），悬停不位移——两张卡一起上浮很像按钮，画面会晃。
     要改回悬停上浮，记得把 transition 保留着，否则按下会瞬间跳。 */
  transition: transform 0.1s ease;
  -webkit-app-region: no-drag;
}
.mode-card:active {
  transform: translateY(1px);
}
/* 选中态只用淡蓝底（与左栏当前步骤同一套：--color-primary-light），不加蓝色描边——
   两张卡片并排时两道蓝框会把画面切碎。 */
.mode-card.is-active {
  background: var(--color-primary-light);
}
.mode-card-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--color-text-muted);
  /* 保留白底，但不描边：选中时淡蓝底上是一块白方块，正好把图标托起来 */
  background: var(--color-surface);
  border: 0;
}
.mode-card-icon svg {
  width: 21px;
  height: 21px;
}
.mode-card.is-active .mode-card-icon {
  color: var(--color-primary);
}
/* 选中时图标由「线条」变「实心」：只填这几块面，不换描边颜色，也不给方框加蓝边 */
.mode-card-icon svg .ic-fill {
  fill: none;
}
.mode-card.is-active .mode-card-icon svg .ic-fill {
  fill: currentColor;
}
.mode-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mode-card-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text);
}
.mode-card-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-inverse);
  background: var(--color-primary);
}
.mode-card-steps {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
}
.mode-card-note {
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--color-text-secondary);
}
.mode-card-list {
  width: 100%;
  margin-top: 20px;
  padding-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--color-border);
}
.mode-card-list-title {
  font-size: 12px;
  color: var(--color-text-muted);
}
.mode-card-tags {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  /* 固定两行高度：快速引导 4 个标签、全面引导 6 个（必占两行）。
     不定高的话两张卡的内容块高度不同，居中后图标就错行了。 */
  min-height: 64px;
}
.mode-card-tag {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

/* 低版本系统提示画面：复用欢迎页的卡片/居中布局，仅内容区样式不同（红字文案 + 两个按钮 + 下载链接 + 勾选框） */
.ow-msg {
  margin: 16px 0 0;
  max-width: 420px;
  font-size: 14px;
  line-height: 1.6;
  color: #b91c1c;
}
/* 按钮区：两行等宽对齐——下载按钮宽度 = 上排两按钮 + 间距 的总宽（132*2 + 14 = 278） */
.ow-btns {
  width: 278px;
  margin-top: 24px;
}
.ow-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
/* 上排两按钮等分整行，保证与下方下载按钮左右对齐 */
.ow-actions .ow-btn { flex: 1; }
/* 三个按钮统一尺寸：定高 + 定最小宽度，保证「退出程序 / 忽略」完全等大，下载按钮同高 */
.ow-btn {
  box-sizing: border-box;
  height: 40px;
  min-width: 132px;
  padding: 0 22px;
  font-size: 14px;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease;
  -webkit-app-region: no-drag;
}
/* 忽略：与欢迎页「开始」按钮同色（主题主色填充） */
.ow-primary {
  border: 1px solid var(--color-primary);
  background: var(--color-primary);
  color: var(--color-text-inverse);
}
.ow-primary:hover { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }
/* 次要按钮（退出程序 / 获取最新的 Windows）：主色描边、浅底 */
.ow-ghost {
  border: 1px solid rgba(30, 64, 175, .35);
  background: #fff;
  color: #1e40af;
}
.ow-ghost:hover { background: rgba(30, 64, 175, .06); }
/* 获取最新的 Windows：独立一行，宽度铺满与上排两按钮总宽一致 */
.ow-download { width: 100%; margin-top: 12px; }
.ow-remember {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.ow-remember input { cursor: pointer; }

/* 第二层毛玻璃：左右两栏各自一块半透明玻璃面板，叠加出层次 */
.glass-panel {
  background: rgba(255, 255, 255, var(--glass-opacity, 0.4));
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: var(--radius-surface);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06);
}

/* 字号阶梯：20 标题 / 16 状态标题 / 15 强调 / 14 正文 / 13 辅助 / 12 微标 */
.setup-head {
  padding: 14px 18px 8px;
  -webkit-app-region: drag;
}
.setup-title {
  margin: 0;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 700;
  color: var(--color-text);
}
.setup-desc {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
}

.setup-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 0 16px;
}

/* 左栏：只读进度 */
.setup-side {
  width: 190px;
  flex-shrink: 0;
  padding: 8px;
  overflow: hidden;
}
.setup-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  font-size: 15px;
  color: var(--color-text-muted);
}
.setup-item + .setup-item {
  margin-top: 4px;
}
.setup-item-idx {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
}
.setup-item.is-active {
  color: var(--color-text);
  font-weight: 600;
  background: var(--color-primary-light);
}
.setup-item.is-active .setup-item-idx {
  color: var(--color-text-inverse);
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.setup-item.is-done {
  color: var(--color-text-secondary);
}
.setup-item.is-done .setup-item-idx {
  color: var(--color-text-inverse);
  background: var(--color-success);
  border-color: var(--color-success);
}

/* 右栏：当前步骤 */
.setup-main {
  flex: 1;
  min-width: 0;
  padding: 16px 18px;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-app-region: no-drag;
}

/* 步骤卡片容器 + 左右切换过渡 */
.pane-wrap {
  min-height: 100%;
}
.slide-next-enter-active,
.slide-next-leave-active,
.slide-prev-enter-active,
.slide-prev-leave-active {
  transition: opacity 0.11s ease, transform 0.11s ease;
}
.slide-next-enter-from { opacity: 0; transform: translateX(26px); }
.slide-next-leave-to { opacity: 0; transform: translateX(-26px); }
.slide-prev-enter-from { opacity: 0; transform: translateX(-26px); }
.slide-prev-leave-to { opacity: 0; transform: translateX(26px); }

/* 欢迎页 → 步骤页过渡：只让正文内容淡出/淡入。
   - 卡片自身只提供过渡时长给 Vue 计时、不改变任何视觉属性 → 背景与模糊始终不淡出；
   - 右上角关闭按钮（.welcome-x / .setup-x）排除在外，全程保持常显；
   - 步骤页的 × 嵌在 .setup-head 内，故此处用 :not(.setup-x) 只淡出标题/说明。 */
.wfade-leave-active,
.wfade-enter-active {
  transition-duration: 0.08s;
}
.wfade-leave-active .welcome-inner,
.wfade-enter-active .welcome-inner,
.wfade-leave-active .setup-head > :not(.setup-x),
.wfade-enter-active .setup-head > :not(.setup-x),
.wfade-leave-active .setup-body,
.wfade-enter-active .setup-body,
.wfade-leave-active .setup-foot,
.wfade-enter-active .setup-foot {
  transition: opacity 0.08s ease;
}
.wfade-leave-to .welcome-inner,
.wfade-leave-to .setup-head > :not(.setup-x),
.wfade-leave-to .setup-body,
.wfade-leave-to .setup-foot { opacity: 0; }
.wfade-enter-from .welcome-inner,
.wfade-enter-from .setup-head > :not(.setup-x),
.wfade-enter-from .setup-body,
.wfade-enter-from .setup-foot { opacity: 0; }

/* 表单 */
.f-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.f-label {
  width: 92px;
  flex-shrink: 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--color-text);
}
.req { color: var(--color-danger); font-style: normal; }
.f-input {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  font-size: 14px;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.f-input::placeholder { color: var(--color-text-muted); }
.f-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-light);
}
.f-input:disabled { opacity: 0.6; cursor: not-allowed; }
.f-static {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  font-size: 14px;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-hint {
  margin: 0 0 0 104px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-muted);
}
.f-hint.ind { margin: -6px 0 12px 104px; }
.f-error {
  margin: 0 0 0 104px;
  font-size: 13px;
  color: var(--color-danger);
}
.f-ok {
  margin: 0 0 0 104px;
  font-size: 13px;
  color: var(--color-success);
}

/* ===== 夜间配色微调（仅引导窗口，不影响主界面） ===== */
/* 文字整体提亮：在本窗口内重映射文本色变量，层级保留但不发灰 */
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .setup-card {
  --color-text: #f2f6fd;
  --color-text-secondary: #cfdaeb;
  --color-text-muted: #aab8cd;
}
/* 第二层毛玻璃：夜间改为更淡的深蓝磨砂，去掉白色叠加造成的发灰感 */
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .glass-panel {
  background: rgba(34, 49, 80, 0.28);
  border-color: rgba(255, 255, 255, 0.07);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(8px) saturate(1.05);
  -webkit-backdrop-filter: blur(8px) saturate(1.05);
}
/* 低版本系统提示：红字与白底按钮跟随深色 */
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .ow-msg {
  color: #fca5a5;
}
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .ow-ghost {
  border-color: rgba(147, 197, 253, 0.35);
  background: rgba(59, 130, 246, 0.12);
  color: #bfdbfe;
}
:root[data-mode="night"]:is([data-theme="glass"], [data-theme="glass2"]) .ow-ghost:hover {
  background: rgba(59, 130, 246, 0.22);
}

/* 用户须知 */
.notice-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.notice-item {
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-bg);
}
.notice-title {
  margin-bottom: 5px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
.notice-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

/* 恢复密钥 */
.phrase-box {
  padding: 11px 13px;
  margin-bottom: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  word-break: break-all;
  user-select: text;
}
.btn-row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

/* 主题选择 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
.theme-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.theme-card.is-active {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}
.theme-preview {
  position: relative;
  display: block;
  height: 52px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border);
  overflow: hidden;
}
.tp-side {
  position: absolute;
  left: 5px;
  top: 5px;
  bottom: 5px;
  width: 26%;
  border-radius: var(--radius-xs);
  background: var(--tp-side, var(--color-surface));
  opacity: 0.95;
}
.tp-bar {
  position: absolute;
  left: 35%;
  right: 5px;
  top: 5px;
  height: 10px;
  border-radius: var(--radius-xs);
  background: var(--tp-bar, var(--color-primary));
  opacity: 0.9;
}
.tp-dot {
  position: absolute;
  left: 35%;
  right: 5px;
  top: 20px;
  bottom: 5px;
  border-radius: var(--radius-xs);
  background: var(--color-surface);
  opacity: 0.75;
}
.theme-name {
  font-size: 13px;
  text-align: center;
  color: var(--color-text-secondary);
}
.theme-card.is-active .theme-name {
  color: var(--color-primary);
  font-weight: 600;
}

/* 日夜模式（与设置页同一控件；不支持夜间配色的主题置灰） */
.mode-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
}
.mode-switch { display: inline-flex; }
.mode-switch.is-disabled { opacity: 0.5; pointer-events: none; }
.mode-hint {
  font-size: 13px;
  color: var(--color-text-muted);
}

/* 功能开关：卡片之间的间距对齐「用户须知」的 .notice-list（14px） */
.feature-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 动画效果开关 */
.anim-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-bg);
}
.anim-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.anim-toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
}
.anim-toggle-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

/* 完成态摘要 */
/* 「修改」跟标题同一行：按钮是标题旁的次要操作，不该单独占一行 */
.done-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.done-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-success);
}
.done-edit {
  padding: 3px 10px;
  font-size: 13px;
}

/* 首次初始化进度：右上角一枚小毛玻璃胶囊（关闭按钮左侧）。
   用 span 而不是 button —— 毛玻璃主题会给所有 button 补描边/发光/定死尺寸；
   pointer-events:none 让它只是状态展示，鼠标落下时归标题栏（仍然可以拖窗口）。 */
.perf-chip {
  position: absolute;
  top: 13px;
  /* 关闭按钮 right-3(12px) + 28px 宽 = 左边缘在 40px，这里留 8px 间隙 */
  right: 48px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  box-sizing: border-box;
  border-radius: 999px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  color: var(--color-text-secondary);
  /* 与 .dlg-close 同一套玻璃写法：底色/描边都由当前文字色派生，
     夜间模式下 --color-text 翻成亮色，这里跟着反转，不用再单独写夜间覆盖 */
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text) 10%, transparent);
  backdrop-filter: blur(10px) saturate(1.15);
  -webkit-backdrop-filter: blur(10px) saturate(1.15);
  box-shadow: 0 1px 6px var(--alpha-black-05, rgba(15, 23, 42, 0.05));
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  -webkit-app-region: no-drag;
}
.perf-chip-num {
  font-weight: 600;
  color: var(--color-text);
}
.perf-chip.is-done,
.perf-chip.is-done .perf-chip-num {
  color: var(--color-success);
}
.perf-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
}
.perf-dot.is-run { background: var(--color-primary); animation: perf-pulse 1.2s ease-in-out infinite; }
.perf-dot.is-ok { background: var(--color-success); }
@keyframes perf-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 底部 */
.setup-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 18px 14px;
  -webkit-app-region: no-drag;
}
.foot-btns {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.step-indicator {
  font-size: 13px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.btn-primary,
.btn-ghost,
.btn-info {
  padding: 8px 18px;
  border-radius: var(--radius-control);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  -webkit-app-region: no-drag;
}
.btn-primary {
  border: none;
  color: var(--color-text-inverse);
  background: var(--color-primary);
}
.btn-primary:hover { background: var(--color-primary-hover); }
.btn-ghost {
  color: var(--color-text-secondary);
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
}
.btn-ghost:hover { background: var(--color-border); }
.btn-info {
  color: var(--color-text-inverse);
  background: var(--color-info);
  border: none;
  padding: 8px 13px;
  white-space: nowrap;
}
.btn-info:hover { background: var(--color-info-hover); }
.btn-primary:disabled,
.btn-ghost:disabled,
.btn-info:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>