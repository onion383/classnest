<template>
  <div class="flex justify-center items-center h-screen login-bg">
    <!-- 卡片外壳（尺寸过渡的落点）：
         · 宽度挂在这一层 —— 各形态内容互换，元素一旦被替换就接不上旧宽度，改内容自身的宽只会瞬跳；
         · 玻璃描边 / 外发光 login-glow 也在这一层：内层卡片要 overflow:hidden 给高度过渡做裁剪，
           留在里面会把 inset:-2px 的描边一起剪掉；rounded-3xl 也必须在这层（::before 圆角是 inherit）；
         · 抄写密钥（mode==='recovery'）时**不卸载**：表单留在弹窗背后（见 cardMode），宽度收回 20rem。
           整块消失会让背景里的卡片硬切一下；收回宽度是连续变化，返回时也能平滑长回去。 -->
    <div class="login-card-sizer login-glow rounded-3xl" :style="{ width: cardWidth }">
      <!-- 常驻卡片盒：背景 / 圆角 / 阴影 + 高度过渡的裁剪层；四种形态只在内部互换，盒子本身始终存在。
           一个 form 承载所有形态（提交按 mode 分派），Enter 键行为与拆成四个 form 时一致。
           抄写密钥期间整块 inert：弹窗在前面，背后的表单既不该被点到，也不该被 Tab 键走进去。 -->
      <form
        ref="cardRef"
        class="login-card bg-surface p-8 rounded-3xl shadow-card w-full"
        :inert="mode === 'recovery'"
        :aria-hidden="mode === 'recovery' ? 'true' : null"
        @submit.prevent="onPageSubmit"
      >
        <!-- 登录表单 -->
        <template v-if="cardMode === 'login'">
          <h2 class="text-xl font-bold mb-4">班集登录</h2>
          <p v-if="loginError" class="text-danger text-[15px] font-medium mb-2">{{ loginError }}</p>
          <input v-model="username" placeholder="账号" autocomplete="off" class="border border-border p-2 w-full mb-2 rounded-xl" />
          <input v-model="password" type="password" placeholder="密码（留空则无密码登录）" autocomplete="new-password" class="border border-border p-2 w-full mb-4 rounded-xl" />
          <div class="flex gap-2">
            <button type="submit" :disabled="busy" class="bg-info text-text-inverse px-4 py-2 flex-1 rounded-xl disabled:opacity-50">
              {{ busy ? '登录中…' : '登录' }}
            </button>
            <button type="button" :disabled="busy" class="bg-surface-hover px-4 py-2 flex-1 rounded-xl disabled:opacity-50" @click="switchMode('register')">
              注册
            </button>
          </div>
          <button type="button" :disabled="busy" class="mt-2 bg-surface-hover px-4 py-2 rounded-xl w-full disabled:opacity-50" @click="openDbPicker">
            从数据库登录
          </button>
          <p class="text-center mt-3">
            <a class="cursor-pointer underline text-xs text-text-muted" @click="switchMode('recover')">忘记密码？</a>
          </p>
        </template>

        <!-- 从备份恢复（新电脑 / 换机：只需备份包 + 密码或助记词） -->
        <template v-else-if="cardMode === 'restore'">
          <h2 class="text-xl font-bold mb-1">从备份恢复</h2>
          <p class="text-xs text-text-muted mb-4">
            <a class="cursor-pointer underline" @click="switchMode('login')">返回登录</a>
          </p>
          <input v-if="restoreFile" :value="restoreBundle?.username || ''" readonly placeholder="账号" autocomplete="off" class="border p-2 w-full mb-2 rounded-xl" />
          <input v-model="password" type="password" placeholder="密码（与导出时一致）" autocomplete="new-password" class="border p-2 w-full mb-2 rounded-xl" />
          <input v-model="recoverPhrase" placeholder="或助记词（12字）" autocomplete="off" class="border p-2 w-full mb-4 rounded-xl" />
          <button type="submit" :disabled="busy" @mouseenter="prefetch(loadConfirmDialog)" class="bg-info text-text-inverse px-4 py-2 rounded-xl w-full disabled:opacity-50">
            {{ busy ? '恢复中…' : '解包并恢复' }}
          </button>
        </template>

        <!-- 注册：单页（安全等级 + 账号 + 密码） -->
        <template v-else-if="cardMode === 'register'">
          <h2 class="text-xl font-bold mb-1">注册账号</h2>
          <p class="text-xs text-text-muted mb-4">
            <a class="cursor-pointer underline" @click="switchMode('login')">已有账号，去登录</a>
          </p>
          <AppSelect v-model="securityLevel" :options="securityLevelOptions" placeholder="请选择模式" class="w-full mb-2" />
          <input v-model="username" placeholder="账号" class="border border-border p-2 w-full mb-2 rounded-xl" autocomplete="off" />
          <template v-if="registerNeedsPassword">
            <input v-model="password" type="password" placeholder="密码（至少 6 位）" autocomplete="new-password" class="border border-border p-2 w-full mb-2 rounded-xl" />
            <input v-model="confirm" type="password" placeholder="确认密码" autocomplete="new-password" class="border border-border p-2 w-full mb-4 rounded-xl" />
          </template>
          <button type="submit" :disabled="busy" class="bg-info text-text-inverse px-4 py-2 rounded-xl w-full disabled:opacity-50">
            {{ busy ? '创建中…' : '注册' }}
          </button>
        </template>

        <!-- 注册：恢复密钥由共用弹窗展示（与「切换安全等级 → 超级隐私」同一套交互） -->

        <!-- 忘记密码：统一入口（恢复词恢复 / 本机信息恢复） -->
        <template v-else-if="cardMode === 'recover'">
          <h2 class="text-xl font-bold mb-1">找回密码</h2>
          <p v-if="recoverStep !== 'setpass'" class="text-xs text-text-muted mb-4">
            <a class="cursor-pointer underline" @click="recoverBack">{{ recoverStep === 'menu' ? '返回登录' : '上一步' }}</a>
          </p>
          <p v-else class="mb-4"></p>

          <!-- 步骤 1：选择验证方式 -->
          <template v-if="recoverStep === 'menu'">
            <p class="text-xs text-text-muted mb-3">验明身份后即可设置新密码。</p>
            <button type="button" :disabled="busy" class="bg-surface-hover px-4 py-2 rounded-xl w-full mb-2 disabled:opacity-50" @click="recoverStep = 'phrase'">
              使用恢复词恢复
            </button>
            <button type="button" :disabled="busy" class="bg-surface-hover px-4 py-2 rounded-xl w-full disabled:opacity-50" @click="openLocalRecover">
              使用本机信息恢复
            </button>
          </template>

          <!-- 步骤 2a：恢复词恢复 -->
          <template v-else-if="recoverStep === 'phrase'">
            <p class="text-xs text-text-muted mb-2">不用记账号，系统会按恢复词在本机定位对应的账号。</p>
            <input v-model="recoverPhrase" placeholder="12 个恢复词" autocomplete="off" class="border p-2 w-full mb-2 rounded-xl" />
            <input v-model="password" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" class="border p-2 w-full mb-2 rounded-xl" />
            <input v-model="confirm" type="password" placeholder="确认新密码" autocomplete="new-password" class="border p-2 w-full mb-4 rounded-xl" />
            <button type="submit" :disabled="busy" class="bg-info text-text-inverse px-4 py-2 rounded-xl w-full disabled:opacity-50">
              {{ busy ? '重置中…' : '重置密码' }}
            </button>
          </template>

          <!-- 步骤 2b：本机信息恢复（点选本机已登记账号） -->
          <template v-else-if="recoverStep === 'local'">
            <p class="text-xs text-text-muted mb-2">选择一个本机账号。超级隐私模式的账号没有主密钥包裹，只能用恢复词恢复。</p>
            <p class="text-[11px] text-text-muted mb-2">提醒：同一 Windows 账号下，本机恢复等同于共用钥匙；重要账号请使用超级隐私模式。</p>
            <div v-if="recoverAccounts.length" class="mb-2 max-h-44 overflow-auto rounded-xl border border-border">
              <button
                v-for="a in recoverAccounts"
                :key="a.slug"
                type="button"
                class="w-full text-left px-3 py-2 text-sm border-b border-border"
                :class="recoverSlug === a.slug ? 'bg-surface-hover' : ''"
                @click="recoverSlug = a.slug"
              >
                <span class="font-medium">{{ a.username }}</span>
                <span class="block text-[11px] text-text-muted">{{ a.slug }}.db</span>
              </button>
            </div>
            <p v-else class="text-xs text-text-muted mb-2">
              {{ recoverLoading ? '正在读取本机账号…' : '本机没有可恢复的账号，请改用恢复词或从备份恢复。' }}
            </p>
            <button type="submit" :disabled="busy || !recoverSlug" class="bg-info text-text-inverse px-4 py-2 rounded-xl w-full disabled:opacity-50">
              {{ busy ? '恢复中…' : '恢复' }}
            </button>
          </template>

          <!-- 步骤 3：本机恢复成功后强制设置新密码 -->
          <template v-else-if="recoverStep === 'setpass'">
            <p class="text-xs text-text-muted mb-2">已通过本机数据库验证身份，请设置新密码后进入系统。</p>
            <input :value="recoveredAccount" readonly placeholder="账号" class="border p-2 w-full mb-2 rounded-xl" />
            <input v-model="password" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" class="border p-2 w-full mb-2 rounded-xl" />
            <input v-model="confirm" type="password" placeholder="确认新密码" autocomplete="new-password" class="border p-2 w-full mb-4 rounded-xl" />
            <button type="submit" :disabled="busy" class="bg-info text-text-inverse px-4 py-2 rounded-xl w-full disabled:opacity-50">
              {{ busy ? '保存中…' : '设置新密码' }}
            </button>
          </template>
        </template>
      </form>
    </div>

    <!-- 注册（超级隐私）：恢复词展示 + 抄写确认，与设置页「切到超级隐私」共用同一组件 -->
    <RecoveryKeyDialog
      v-if="mode === 'recovery'"
      :visible="true"
      :phrase="recoveryPhrase"
      :username="restoredUsername"
      description="这是超级隐私模式的恢复词，也是忘记密码时的唯一凭证。请点击「下载文本」保存到安全的地方，然后抄写前 3 个词完成注册。"
      confirm-text="确认并完成注册"
      cancel-text="返回"
      @confirm="onRecoveryConfirm"
      @cancel="switchMode('register')"
    />

    <!-- 确认弹窗（覆盖恢复 / 注册完成确认） -->
    <ConfirmDialog
      v-if="confirmMounted"
      :visible="confirmVisible"
      :message="confirmMessage"
      :title="confirmTitle"
      :show-cancel="true"
      :confirm-text="confirmText"
      :cancel-text="cancelText"
      @confirm="onConfirmAction"
      @cancel="cancelConfirm"
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
  </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { setToken, setCurrentUser } from '../utils/authStorage.js'
import axios from 'axios';
import { defineAsyncComponent, ref, computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useNotification } from '../composables/useNotification.js';
import { reportError } from '../utils/reportError.js';
import AppSelect from '../components/base/AppSelect.vue';
import '../styles/dialog-transition.css';
import { storeMediaToken } from '../utils/apiUrl';
import { fetchLocalAccounts, recoverFromLocalDb, submitRecoveredPassword } from '../utils/localRecover.js';
import { useDisposables } from '../utils/disposables.js';
import { INVOKE } from '../electronChannels.js';

// 弹窗类组件懒加载：打开时才加载对应 chunk
// 悬停预取：ConfirmDialog 的 chunk 提前加载（供 @mouseenter → prefetch 使用）
const loadConfirmDialog = () => import('../components/base/ConfirmDialog.vue');
const ConfirmDialog = defineAsyncComponent(loadConfirmDialog);
// 恢复词弹窗：注册（超级隐私）与设置页切换等级共用同一个组件
const loadRecoveryKeyDialog = () => import('../components/dialogs/RecoveryKeyDialog.vue');
const RecoveryKeyDialog = defineAsyncComponent(loadRecoveryKeyDialog);

// 注册可选的四种安全等级（与引导页 / 系统设置共用同一套文案）
const SECURITY_LEVELS = [
  { value: 'plain', label: '明文模式（不加密）' },
  { value: 'nopass', label: '无密码模式（加密，免密码登录）' },
  { value: 'password', label: '普通密码模式（加密 + 登录密码）' },
  { value: 'privacy', label: '超级隐私模式（密码 + 恢复词才能解锁）' },
];

const router = useRouter();

const mode = ref('login');           // login | register | recovery | recover
// 模板渲染用的形态：抄写密钥（recovery）阶段表单不卸载，继续按「注册」渲染留在弹窗背后。
// 卸载会让背景里的卡片硬切一下；留着它 + 宽度收回 20rem，视觉上就是卡片自己缩了一下。
const cardMode = computed(() => (mode.value === 'recovery' ? 'register' : mode.value));
// 卡片宽度：只有注册页要放得下最长的安全等级文案（24rem），其余 20rem —— 抄写密钥阶段也算「其余」，
// 所以那一步是 24rem → 20rem 的连续收缩（宽度过渡见文件末尾样式），form 本身一律 w-full。
const cardWidth = computed(() => (mode.value === 'register' ? '24rem' : '20rem'));
// 注册安全等级：plain | nopass | password | privacy
// 默认留空（下拉显示「请选择模式」）：预选任何一档都会让人误以为已经选好了，
// 而安全等级直接决定加密方式与能否找回，必须由用户自己确认一次。
const securityLevel = ref('');
const levelTipVisible = ref(false);    // 安全等级风险说明弹窗
const levelTipType = ref('password');  // password | privacy
const levelTipSuppress = ref(false);   // 回退赋值时抑制再次弹窗
const username = ref('');
const password = ref('');
const confirm = ref('');
const loginError = ref('');            // 登录失败时内联显示在表单上方
// 忘记密码：menu=选择方式 | phrase=恢复词恢复 | local=本机信息恢复 | setpass=强制设新密码
const recoverStep = ref('menu');
const recoverPhrase = ref('');
const recoverAccounts = ref([]);       // 本机已登记且可恢复（非隐私）的账号列表
const recoverLoading = ref(false);
const recoverSlug = ref('');           // 本机恢复选中的库 slug
const recoveredAccount = ref('');      // 本机恢复成功后的账号（只读展示）
const recoveredUser = ref(null);       // 本机恢复签发的登录用户信息
// 注册成功后的恢复密钥展示（下载 / 抄写校验都在 RecoveryKeyDialog 内部完成）
const recoveryPhrase = ref('');
const draftId = ref('');             // 待确认注册草稿 id（抄写通过后真正建库）
const restoredUsername = ref('');
const busy = ref(false);
const restoreBundle = ref(null);
const restoreFile = ref('');
const confirmVisible = ref(false);
const confirmMounted = ref(false);
const confirmMessage = ref('');
const confirmTitle = ref('');
const confirmPayload = ref(null);
const confirmAction = ref('restore');   // restore=覆盖恢复 | recovery=注册完成
const confirmText = ref('确定');
const cancelText = ref('取消');

const registerNeedsPassword = computed(() => {
  return securityLevel.value === 'password' || securityLevel.value === 'privacy';
});
const securityLevelOptions = computed(() => SECURITY_LEVELS);
// 安全等级说明弹窗文案（超级隐私模式的「取消」会退回未选择状态）
const levelTipMessage = computed(() => {
  return levelTipType.value === 'privacy'
    ? '请您妥善保管好您的密钥，如果丢失，任何人将无法打开您的数据（包括开发者），若担心密码丢失，请使用其他模式'
    : '普通密码模式只能保证其他 Windows 用户无法访问，并且能保证自己复制数据库到其他电脑无法打开。同一个 Windows 用户仍然可以通过数据恢复打开，如果需要严格的保护隐私，请使用超级隐私模式';
});

// 懒加载弹窗保活：首次打开后保持挂载，关闭只降 visible，保留退出动画
watch(confirmVisible, (n) => { if (n) confirmMounted.value = true });
watch(securityLevel, (v) => {
  // 取消隐私模式后回退到普通密码是程序化赋值，不再弹一次普通密码说明
  if (levelTipSuppress.value) return;
  tipSecurityLevel(v);
});

function switchMode(m) {
  mode.value = m; loginError.value = ''; busy.value = false;
  if (m === 'restore') { password.value = ''; recoverPhrase.value = ''; restoreBundle.value = null; restoreFile.value = ''; }
  // 注册页不再默认预选安全等级（进来没有选择 → 不弹任何说明），
  // 只有用户自己选到「普通密码 / 超级隐私」时由 watch(securityLevel) 弹一次说明。
  if (m === 'recover') {
    recoverStep.value = 'menu';
    recoverPhrase.value = ''; recoverAccounts.value = []; recoverSlug.value = '';
    recoveredAccount.value = '';
    recoveredUser.value = null; password.value = ''; confirm.value = '';
  }
}
// 四种形态共用同一个 <form>（模板里按 mode 分支），Enter / 提交都从这里分派，
// 与拆成四个 form 时的行为一致；卡片因此只换内容、不换盒子，高度才有得过渡。
function onPageSubmit() {
  if (mode.value === 'login') return login();
  if (mode.value === 'restore') return restore();
  if (mode.value === 'register') return register();
  if (mode.value === 'recover') return onRecoverSubmit();
}
// 卡片高度过渡：高度是内容撑出来的 auto，光改宽度接不上旧高度，只能
// 「换内容前记旧高 → 换完量新高 → 播一段 height 动画 → 结束交还 auto」。
// 用 WAAPI 而不是 CSS transition：transition 要靠「先钉成 from、强制回流、再改成 to」起跳，
// 实测变矮那个方向两次赋值会被合并成一次、动画根本不播；WAAPI 直接给首尾关键帧，两个方向都稳。
// 过渡期间才加 .login-card--clip（overflow:hidden）：变矮的那一段旧内容会溢出卡片；
// 常驻则会把输入框聚焦光圈等溢出特效一起剪掉。
const cardRef = ref(null);
const d = useDisposables();
const HEIGHT_ANIM_MS = 260;             // 与 .login-card-sizer 的宽度过渡时长保持一致
let cardAnim = null;
let cardAnimSeq = 0;
// 凡是「字段数量会变」的开关都得过这一层，否则就是瞬跳：
// · mode —— 登录 / 注册 / 找回 / 从备份恢复，四态内容多寡完全不同；
// · securityLevel —— 只有 password / privacy 才多出两个密码框（见 registerNeedsPassword）；
// · recoverStep —— menu → phrase → local → setpass，每步字段数都不一样。
// 同一次切换里多个值一起变（例如改等级时顺带清空错误）由 Vue 合并成一次调用，只播一段动画。
async function animateCardHeight() {
  const seq = ++cardAnimSeq;
  const el = cardRef.value;
  // 视图卸载过（例如已跳去首页）时就没有可量的高度
  if (!el) return;
  // 上一次可能还没播完：先撤掉动画与裁剪，否则这里量到的是被动画覆盖的旧值
  if (cardAnim) { cardAnim.cancel(); cardAnim = null; }
  el.style.height = '';
  el.classList.remove('login-card--clip');
  const from = el.offsetHeight;           // pre flush：此刻还是旧形态
  await nextTick();
  const card = cardRef.value;
  if (seq !== cardAnimSeq || !card) return;
  const to = card.offsetHeight;
  if (!to || Math.abs(to - from) < 1) return;
  // 关闭动画效果时直接就位（WAAPI 不受 html.no-animations 的 CSS 兜底约束，得自己判）
  if (document.documentElement.classList.contains('no-animations')) return;
  card.classList.add('login-card--clip');
  const anim = card.animate(
    [{ height: from + 'px' }, { height: to + 'px' }],
    { duration: HEIGHT_ANIM_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  );
  cardAnim = anim;
  const done = () => {
    if (seq !== cardAnimSeq) return;      // 已被下一次切换接管
    card.style.height = '';
    card.classList.remove('login-card--clip');
    cardAnim = null;
  };
  anim.onfinish = done;
  d.timeout(done, HEIGHT_ANIM_MS + 80);   // onfinish 没派发（被打断 / 环境异常）时兜底
}
watch([mode, securityLevel, recoverStep], () => { void animateCardHeight(); });
// 找回密码「本机账号列表」是异步到货的：列表撑高卡片那一刻也走同一段动画。
// 空数组要跳过 —— 打开该步骤时会先赋一次 []，那时高度没变，别白播一段。
watch(recoverAccounts, (list) => {
  if (!Array.isArray(list) || list.length === 0) return;
  void animateCardHeight();
});
// 登录失败的内联错误行同样是内容增减（出现 / 换行数变多），一并走动画。
// 空串之间赋值高度没变，animateCardHeight 自己会在 |Δ| < 1 时提前返回。
watch(loginError, () => { void animateCardHeight(); });
// 选择安全等级时的风险说明弹窗：普通密码只有「确定」，超级隐私「确认 / 取消」
function tipSecurityLevel(v) {
  if (v !== 'password' && v !== 'privacy') return;
  levelTipType.value = v;
  levelTipVisible.value = true;
}
// 超级隐私模式的「取消」：退回未选择状态（下拉重新显示「请选择模式」），且不再连锁弹出说明
function onLevelTipCancel() {
  levelTipVisible.value = false;
  levelTipSuppress.value = true;
  securityLevel.value = '';
  nextTick(() => { levelTipSuppress.value = false; });
}
// 「从数据库登录」：选 .db 库文件，或 .json 备份包（转去「从备份恢复」填密码/助记词）。
//
// 走主进程的原生 dialog（IPC select-db-file），不用渲染层的 <input type="file">：
// Chromium 的 file chooser 传不了默认目录，每次都从系统上次停留的位置开始，
// 停在 OneDrive / 网络位置时光枚举目录就要 0.5~2 秒 —— 点下去就像「卡了一下才弹框」。
// 主进程这条能记住上次目录（首次落在数据目录，.db 就在那里），并按 .db/.json 过滤。
//
// 返回三态（见 electron/main/main.ipc-contract.js）：ok / fail / canceled。
// 取消要安静吞掉，不能弹「选择失败」。
async function openDbPicker() {
  let res;
  try {
    res = await window.electron.invoke(INVOKE.SELECT_DB_FILE);
  } catch (err) {
    useNotification().error('打开文件选择器失败');
    return;
  }
  if (!res || res.outcome === 'canceled') return;
  if (res.outcome !== 'ok') return useNotification().error(res.error || '选择文件失败');

  // 备份包：主进程已把文本读出来，这里直接解析（省掉一次 FileReader）
  if (res.kind === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(res.text);
      if (parsed.version !== 2) throw new Error('不是有效的 v2 备份包');
    } catch (err) {
      return useNotification().error('备份文件无法解析：' + err.message);
    }
    restoreBundle.value = parsed;
    restoreFile.value = res.name;
    mode.value = 'restore';
    useNotification().info('已识别备份包，账号 ' + (parsed.username || '…') + '：请输入密码或助记词后点「解包并恢复」');
    return;
  }

  // 本机已有 .db 库文件：后端按文件名在数据目录里找登记（不读这个路径本身）
  busy.value = true;
  axios.post('/api/db-login', { file: res.name }).then(res => {
    username.value = res.data.username;
    useNotification().success('已选择数据库，账号 ' + res.data.username + '，请输入密码登录');
  }).catch(err => {
    reportError(err, { action: '打开数据库' });
  }).finally(() => { busy.value = false; });
}
function login() {
  loginError.value = '';
  busy.value = true;
  axios.post('/api/login', { username: username.value, password: password.value }).then(res => {
    setToken(res.data.token);
    storeMediaToken(res.data.mediaToken);
    setCurrentUser(res.data.user);
    router.push('/');
  }).catch(err => {
    // 账号/密码错误：内联显示在表单上方，不再弹提示条
    loginError.value = err.response?.data?.error || '登录失败';
  }).finally(() => { busy.value = false; });
}
function register() {
  if (!securityLevel.value) return useNotification().warning('请先选择安全模式');
  if (!username.value) return useNotification().warning('请填写账号');
  if (registerNeedsPassword.value) {
    if (!password.value || password.value.length < 6) return useNotification().warning('密码长度至少 6 位');
    if (password.value !== confirm.value) return useNotification().warning('两次输入的密码不一致');
  }
  busy.value = true;
  // 隐私等级会跳到恢复词弹窗：先预取 chunk，避免展示前出现空白等待
  prefetch(loadRecoveryKeyDialog);
  const payload = { username: username.value, role: 'teacher', level: securityLevel.value };
  if (registerNeedsPassword.value) payload.password = password.value;
  axios.post('/api/register', payload).then(res => {
    restoredUsername.value = res.data.user.username;
    if (res.data.draftId) {
      // 仅超级隐私模式：先展示恢复词，抄写通过后再确认建库
      draftId.value = res.data.draftId;
      recoveryPhrase.value = res.data.recovery.phrase;
      mode.value = 'recovery';
    } else {
      // 其余等级：建库即签发登录态，直接进入系统
      setToken(res.data.token);
      storeMediaToken(res.data.mediaToken);
      setCurrentUser(res.data.user);
      router.push('/');
    }
  }).catch(err => {
    reportError(err, { action: '注册' });
  }).finally(() => { busy.value = false; });
}
// 恢复词弹窗的下载 / 复制 / 抄写校验都在 RecoveryKeyDialog 内完成，
// 这里只接手「已确认保存」之后的动作：先弹一次「仅此一份」的警示，再真正建库。
function onRecoveryConfirm() {
  confirmAction.value = 'recovery';
  confirmTitle.value = '重要提醒';
  confirmText.value = '我已确认保存，继续注册';
  cancelText.value = '返回保存恢复密钥';
  // ConfirmDialog 按纯文本插值渲染（非 v-html），这里不能带 HTML 标签
  confirmMessage.value = '恢复密钥是忘记密码后唯一的恢复凭证，在这里只会出现一次，请仔细检查恢复密钥是否已经保存到安全的地方，如果密码和恢复密钥同时丢失，将会无法访问该账号';
  confirmVisible.value = true;
}
async function confirmRecovery() {
  confirmVisible.value = false;
  busy.value = true;
  axios.post('/api/register/confirm', {
    draftId: draftId.value,
    password: password.value,
    phrase: recoveryPhrase.value,
  })
    .then(res => {
      // 注册成功即自动登录并进入首页
      setToken(res.data.token);
      storeMediaToken(res.data.mediaToken);
      setCurrentUser(res.data.user);
      router.push('/');
    })
    .catch(err => {
      // 确认建库失败：恢复词弹窗已经关掉了，改用提示条，避免错误无处显示
      reportError(err, { action: '确认注册' });
    })
    .finally(() => { busy.value = false; });
}
async function restore() {
  const b = restoreBundle.value;
  // 无密码账号的备份包已带明文 key，无需密码/助记词；有密码包才需其一
  if (!b.key && !password.value && !recoverPhrase.value) return useNotification().warning('请至少输入密码或助记词之一');
  const payload = {
    data: b.data,
    slug: b.slug,
    username: b.username,
    wrappedByPassword: b.wrappedByPassword,
    wrappedByMnemonic: b.wrappedByMnemonic,
    key: b.key,
    password: password.value || undefined,
    mnemonic: recoverPhrase.value || undefined,
    memory: b.memory, // AI 长期记忆（随备份包一起还原）
  };
  busy.value = true;
  try {
    const res = await axios.post('/api/account/restore-offline', payload);
    // 覆盖恢复成功：后端已签发登录态，直接存 token 并跳首页
    if (res.data.token) {
      setToken(res.data.token);
      storeMediaToken(res.data.mediaToken);
      setCurrentUser(res.data.user);
      router.push('/');
      return;
    }
    useNotification().success('恢复成功！账号 ' + (res.data.username || b.username) + ' 已还原，请用其密码登录。');
    afterRestore(b, res.data.username);
  } catch (err) {
    const data = err.response?.data || {};
    // 本机已存在同一账号，需用户确认后才真正覆盖
    if (data.needConfirm) {
      confirmAction.value = 'restore';
      confirmTitle.value = '';
      confirmText.value = '确定';
      cancelText.value = '取消';
      confirmMessage.value = data.message || '本机已存在同名账号，是否确认覆盖？';
      confirmPayload.value = payload;
      confirmVisible.value = true;
      useNotification().info('该账号在本机已存在，请确认后覆盖恢复');
    } else {
      useNotification().error(data.error || '恢复失败');
    }
  } finally { busy.value = false; }
}
async function confirmRestore() {
  confirmVisible.value = false;
  const b = restoreBundle.value;
  const payload = confirmPayload.value;
  confirmPayload.value = null;
  if (!payload) return;
  busy.value = true;
  try {
    payload.confirm = true;
    const res = await axios.post('/api/account/restore-offline', payload);
    // 覆盖恢复成功：后端已签发登录态，直接存 token 并跳首页
    if (res.data.token) {
      setToken(res.data.token);
      storeMediaToken(res.data.mediaToken);
      setCurrentUser(res.data.user);
      router.push('/');
      return;
    }
    useNotification().success('已覆盖恢复！账号 ' + (res.data.username || (b ? b.username : '')) + ' 已还原，请用其密码登录。');
    afterRestore(b, res.data.username);
  } catch (err) {
    reportError(err, { action: '覆盖恢复' });
  } finally { busy.value = false; }
}
function onConfirmAction() {
  if (confirmAction.value === 'restore') confirmRestore();
  else if (confirmAction.value === 'recovery') confirmRecovery();
}
function cancelConfirm() {
  if (confirmAction.value === 'restore') useNotification().info('已取消恢复');
  confirmVisible.value = false;
  confirmPayload.value = null;
}
function afterRestore(b, restoredUsername) {
  const name = restoredUsername || (b && b.username) || '';
  username.value = name;
  password.value = '';
  recoverPhrase.value = '';
  restoreBundle.value = null;
  restoreFile.value = '';
  switchMode('login');
}
// 忘记密码：返回上一步（setpass 阶段已签发恢复 token，不提供返回，避免留下未改密的登录态）
function recoverBack() {
  if (recoverStep.value === 'menu') return switchMode('login');
  recoverStep.value = 'menu';
  recoverPhrase.value = '';
  recoverAccounts.value = [];
  recoverSlug.value = '';
  password.value = '';
  confirm.value = '';
}
// 本机恢复：列出本机已登记账号（隐私库除外），由用户按账号名点选
// 请求层与「设置 → 修改密码 → 忘记密码」共用（utils/localRecover.js），别在这里另写一份
function openLocalRecover() {
  recoverStep.value = 'local';
  recoverSlug.value = '';
  recoverAccounts.value = [];
  recoverLoading.value = true;
  fetchLocalAccounts().then(list => {
    recoverAccounts.value = list;
  }).catch(err => {
    reportError(err, { action: '读取本机账号' });
  }).finally(() => { recoverLoading.value = false; });
}
function onRecoverSubmit() {
  if (recoverStep.value === 'phrase') return resetByPhrase();
  if (recoverStep.value === 'local') return recoverByLocalAccount();
  if (recoverStep.value === 'setpass') return saveRecoveredPassword();
}
// 恢复词恢复：只凭恢复词定位账号 + 新密码重置（隐私库与非隐私库都由后端按恢复词校验）
function resetByPhrase() {
  if (!recoverPhrase.value) return useNotification().warning('请填写恢复词');
  if (!password.value || password.value.length < 6) return useNotification().warning('新密码至少 6 位');
  if (password.value !== confirm.value) return useNotification().warning('两次输入的新密码不一致');
  busy.value = true;
  axios.post('/api/recover-password', {
    phrase: recoverPhrase.value,
    newPassword: password.value,
  }).then(res => {
    // 后端按恢复词定位到账号后回传用户名，顺带填好登录框
    const name = res.data && res.data.username;
    if (name) username.value = name;
    useNotification().success(name ? '账号 ' + name + ' 的密码已重置，请用新密码登录' : '密码已重置，请使用新密码登录');
    recoverPhrase.value = '';
    password.value = '';
    confirm.value = '';
    switchMode('login');
  }).catch(err => {
    reportError(err, { action: '重置' });
  }).finally(() => { busy.value = false; });
}
// 本机信息恢复：选中的本机库即凭证。后端按账号的安全等级分流：
// 有登录密码（password）时签发的是 recover 态 token，只能先改密换正式 token；
// 明文 / 免密账号本来就没有登录密码，后端直接给常规 token —— 不该被迫设一个密码
// （强设会把免密档静默升级成普通密码、给明文库写进它不允许存在的密码哈希）。
// 请求与落 token 都在 utils/localRecover.js（设置页「忘记密码」共用同一份）。
function recoverByLocalAccount() {
  if (!recoverSlug.value) return useNotification().warning('请先选择要恢复的账号');
  busy.value = true;
  recoverFromLocalDb({ file: recoverSlug.value + '.db' }).then(data => {
    if (data.mustChangePassword === false) {
      setCurrentUser(data.user || {});
      useNotification().success('已通过本机数据库验证，正在进入系统');
      return router.push('/');
    }
    recoveredUser.value = data.user;
    recoveredAccount.value = data.user.username;
    username.value = data.user.username;
    password.value = '';
    confirm.value = '';
    recoverStep.value = 'setpass';
    useNotification().info('已验证本机数据库，请设置新密码');
  }).catch(err => {
    reportError(err, { action: '恢复' });
  }).finally(() => { busy.value = false; });
}
function saveRecoveredPassword() {
  if (!password.value || password.value.length < 6) return useNotification().warning('新密码至少 6 位');
  if (password.value !== confirm.value) return useNotification().warning('两次输入的新密码不一致');
  busy.value = true;
  // 后端换发了不含 recover 标记的常规 token（token 落盘在 utils/localRecover.js 里）
  submitRecoveredPassword(password.value).then(() => {
    setCurrentUser(recoveredUser.value || {});
    useNotification().success('新密码已设置');
    router.push('/');
  }).catch(err => {
    reportError(err, { action: '设置新密码' });
  }).finally(() => { busy.value = false; });
}
</script>

<style>
/* 登录卡片宽度过渡：切换形态（登录 ↔ 注册 …）时从 20rem 平滑长到 24rem，而不是瞬跳。
   必须盯在「一直存在的」外壳上，form 是每次互换的新元素，改它自身的宽接不上旧宽度。
   关闭动画时全局 html.no-animations 会把时长压到 0，这里不用另外判断。 */
.login-card-sizer {
  transition: width 0.26s cubic-bezier(0.4, 0, 0.2, 1);
}
/* 卡片高度过渡的裁剪层：高度动画由 script 里的 watch(mode) 用 WAAPI 播，
   只有「变矮」那一小段旧内容会溢出卡片，所以只在过渡期间加这个类；
   常驻 overflow:hidden 会连带剪掉输入框聚焦光圈等溢出特效，不能常开。 */
.login-card--clip {
  overflow: hidden;
}
</style>