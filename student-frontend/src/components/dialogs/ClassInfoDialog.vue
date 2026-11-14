<template>
  <DialogShell :visible="visible" :z-index="10001" @overlay="$emit('cancel')">
    <div class="bg-surface p-5 rounded-xl w-[440px] max-w-full shadow-lg dialog-card class-switch-card" @keydown="onKeydown">
      <h3 class="text-lg font-bold mb-4 text-text">{{ switchOnly ? '班级切换' : '班级信息设置' }}</h3>

      <!-- 班级切换 + 重命名。切班换的是整个库（学生/座位/班费/相册全都不同），
           所以单独放最上面，和下面的口号/班风分开，避免误以为只是改个名字。 -->
      <div class="mb-5">
        <div class="flex items-center gap-2 mb-1.5">
          <label class="text-sm text-text-secondary">班级切换</label>
          <button type="button" :disabled="switching" @click="addClassVisible = true" class="add-class-btn">
            ＋ 新建班级
          </button>
        </div>
        <!-- 切换器：多班时是下拉（班级一多，一列按钮会把弹窗撑爆，而下拉有固定高度 +
             内部滚动）；单班时是一行只读班名 —— 下拉只有一个选项没有意义。
             右侧铅笔常驻：单班时它就是唯一的改班名入口，不能跟着切换器一起藏掉。
             点铅笔 → 原位换成输入框 → 回车/Esc/点自己确认 → 自动变回。 -->
        <div class="flex items-stretch gap-2">
          <div class="flex-1 min-w-0">
            <input
              v-if="renaming"
              ref="renameInput"
              v-model="renameDraft"
              type="text"
              maxlength="50"
              placeholder="班级名称"
              class="rename-input"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
            <AppSelect
              v-else-if="classes.length > 1"
              :model-value="currentSlug"
              :options="classOptions"
              :disabled="switching"
              placeholder="选择班级"
              @change="onPickClass"
            />
            <div v-else class="class-static" :title="classStaticText">{{ classStaticText }}</div>
          </div>
          <button
            ref="renameBtn"
            type="button"
            class="rename-btn"
            :class="{ 'rename-btn--on': renaming }"
            :title="renaming ? '完成重命名' : '重命名当前班级'"
            @mousedown.prevent
            @click="renaming ? commitRename() : startRename()"
          >
            <IconGlyph :name="renaming ? 'check' : 'edit'" tint="current" glyph :size="14" :stroke-width="1.8" />
          </button>
        </div>
        <!-- 重名提示跟着这一个入口走：班名现在只有铅笔能改，提示放别处等于看不见 -->
        <p v-if="nameDuplicate" class="mt-1.5 text-xs text-danger">已有同名班级，请换个名字</p>
        <p v-else class="mt-1.5 text-xs text-text-muted">
          <template v-if="renaming">输入新班名，回车确认，Esc 取消</template>
          <template v-else-if="switching">切换中…</template>
          <template v-else-if="classes.length > 1">切换后页面会换成该班的数据（两个班完全独立）</template>
          <template v-else>点右侧铅笔可修改班级名称</template>
        </p>
      </div>

      <!-- 口号/班风/学风是首页展示用的文案，属于「班级信息设置」。
           从设置页打开时只做切换（switchOnly），这三栏在那里是多余的：
           用户点的是「切换」，弹窗里再摆三段长文本输入，会把切换器挤到上面一小条。 -->
      <div v-if="!switchOnly" class="space-y-3 mb-5">
        <div>
          <label class="block text-sm text-text-secondary mb-1">班级口号</label>
          <textarea v-model="form.motto" rows="2" placeholder="填写班级口号"
            class="w-full px-3 py-2 text-sm rounded-lg bg-surface-hover border border-border focus:outline-none focus:border-primary resize-y" />
        </div>
        <div>
          <label class="block text-sm text-text-secondary mb-1">班风</label>
          <textarea v-model="form.mottoStyle" rows="2" placeholder="填写班风"
            class="w-full px-3 py-2 text-sm rounded-lg bg-surface-hover border border-border focus:outline-none focus:border-primary resize-y" />
        </div>
        <div>
          <label class="block text-sm text-text-secondary mb-1">学风</label>
          <textarea v-model="form.xuefeng" rows="2" placeholder="填写学风"
            class="w-full px-3 py-2 text-sm rounded-lg bg-surface-hover border border-border focus:outline-none focus:border-primary resize-y" />
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <!-- 只做切换时没有可保存的东西（改名是当场落库的），留一个「关闭」就够 -->
        <template v-if="switchOnly">
          <button type="button" @click="$emit('cancel')" class="px-4 py-2 rounded-lg bg-surface-hover border border-border">关闭</button>
        </template>
        <template v-else>
          <button type="button" @click="$emit('cancel')" class="px-4 py-2 rounded-lg glass-cancel">取消</button>
          <button type="button" @click="submit" :disabled="nameDuplicate"
            class="px-4 py-2 rounded-lg bg-primary text-text-inverse hover:bg-primary-hover transition-theme disabled:opacity-50 disabled:cursor-not-allowed">保存</button>
        </template>
      </div>
    </div>
  </DialogShell>

  <!-- 二级弹窗：放在 DialogShell 外面，自己再 Teleport 一层，层级才压得住。
       输入与提交都由它自己管，本组件只负责转成 create-class 事件给父级。 -->
  <AddClassDialog
    :visible="addClassVisible"
    :busy="switching"
    :existing-names="classNames"
    @confirm="onCreateConfirm"
    @cancel="addClassVisible = false"
  />
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import { ref, computed, watch, nextTick } from 'vue'
import DialogShell from '../base/DialogShell.vue'
import AppSelect from '../base/AppSelect.vue'
import IconGlyph from '../base/IconGlyph.vue'
import AddClassDialog from './AddClassDialog.vue'

defineOptions({ name: 'ClassInfoDialog' })

const props = defineProps({
  visible: { type: Boolean, default: false },
  classData: { type: Object, default: () => ({}) },
  // 多班级：该账号名下的全部班级（含当前班）。父组件在打开弹窗时拉一次。
  classes: { type: Array, default: () => [] },
  currentSlug: { type: String, default: '' },
  // 切换进行中：由父组件控制，避免用户连点导致并发切班
  switching: { type: Boolean, default: false },
  // 只做切换（设置页那份用）：藏掉口号/班风/学风与保存按钮，只留切换器。
  // 这三栏是首页展示文案，属于「班级信息设置」，在设置页点「切换」时摆出来是多余的。
  switchOnly: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm', 'cancel', 'switch-class', 'create-class', 'rename-class'])

const form = ref({ name: '', motto: '', mottoStyle: '', xuefeng: '' })
// 铅笔按钮：打开弹窗后把焦点放它上面 —— 班名现在只有这一个入口，
// 聚焦它之后「回车进入编辑 → 输入 → 回车确认」整条键盘路径是通的。
const renameBtn = ref(null)
// 「新增班级」二级弹窗的显隐。输入内容与提交都在 AddClassDialog 内部，
// 这里只持有显隐 + 把确认转成 create-class 事件。
const addClassVisible = ref(false)
// 传给二级弹窗判重名用。只取名字，不传整个 classes：子组件不需要 slug。
const classNames = computed(() => (props.classes || []).map((c) => c.className))

// 下拉选项：value 用 slug（切换靠它），label 用班名。
// 当前班的 label 跟随 form.name：铅笔里刚改的名字还没保存，下拉也要立刻显示，
// 否则用户改完看到下拉还是旧名，会以为没改成功。
const classOptions = computed(() => (props.classes || []).map((c) => ({
  value: c.slug,
  label: (c.slug === props.currentSlug && (form.value.name || '').trim())
    || c.className
    || '未命名班级',
})))

const currentClassName = computed(
  () => (props.classes || []).find((x) => x.slug === props.currentSlug)?.className || ''
)

// 单班时切换器是一行只读班名（下拉只有一个选项没有意义）。
// 跟随 form.name 而不是已保存的班名：铅笔改完还没保存时，这里就该显示新名字。
const classStaticText = computed(
  () => (form.value.name || '').trim() || currentClassName.value || '未命名班级'
)

// ---- 铅笔内联重命名：下拉原位换成输入框 ----
const renaming = ref(false)
const renameDraft = ref('')
const renameInput = ref(null)

function startRename() {
  // 预填 form.name：用户可能刚在下面的「班级名称」里改过还没保存，
  // 这里应该接着那个值改，而不是退回已保存的旧名。
  renameDraft.value = form.value.name || currentClassName.value
  renaming.value = true
  // 全选：改名基本都是整段替换，省掉手动清空
  nextTick(() => { renameInput.value?.select() })
}

function cancelRename() {
  renaming.value = false
  renameDraft.value = ''
}

function commitRename() {
  // 幂等守卫：回车会先走这里，随后元素被移除还会再触发一次 blur
  if (!renaming.value) return
  renaming.value = false
  const v = renameDraft.value.trim()
  // 空名不写回：让下面的「班级名称」保持原值，别把班名清空
  if (!v) return
  // 只写进表单，不直接调接口 —— 首页那份弹窗的语义就是「改完点保存」。
  // 重名由 nameDuplicate 就地提示，保存按钮会跟着禁用。
  form.value.name = v
  // 但「只做切换」那份没有保存按钮：名字不在这里落库，一关弹窗就丢了。
  // 所以这种模式下当场提交；重名不提交（必然 409），留给上面的红字提示。
  if (props.switchOnly && !nameDuplicate.value) emit('rename-class', v)
}

// AppSelect 的 commit 不判重：点当前项也会 emit change，所以在这里挡掉，
// 不然会拿一个和当前相同的 slug 去请求切班。
function onPickClass(slug) {
  if (!slug || slug === props.currentSlug) return
  emit('switch-class', slug)
}

// 改班名也要防重：只在「新增班级」拦是不够的，改个名照样能造出两个同名班。
// 排除当前班 —— 改成自己原来的名字不算重名。
const nameDuplicate = computed(() => {
  const v = (form.value.name || '').trim()
  if (!v) return false
  return (props.classes || []).some(
    (c) => c.slug !== props.currentSlug && String(c.className || '').trim() === v
  )
})

function onCreateConfirm(className) {
  // 不在成功后关弹窗：建库成功会立刻切班，整个父组件随之重建，弹窗自然消失；
  // 失败时留着，用户可以改个名字重试，不用重新点开。
  emit('create-class', className)
}

watch(() => props.visible, (v) => {
  // 主弹窗收起时二级必须一起收：父级可能因为非 Esc 的原因关闭本弹窗
  // （父组件置 visible=false、路由切换等），留下一个没有父级的浮层很怪。
  if (!v) { addClassVisible.value = false; return }
  form.value = {
    name: props.classData.name || '',
    motto: props.classData.motto || '',
    mottoStyle: props.classData.mottoStyle || '',
    xuefeng: props.classData.xuefeng || ''
  }
  // 二级弹窗每次打开都收起，避免上次没提交的状态残留
  addClassVisible.value = false
  // 焦点给铅笔：班名已经没有独立输入框了，聚焦它才能「回车进编辑 → 输入 → 回车确认」。
  // 但「只做切换」那份不抢焦点 —— 那里的主操作是下拉，焦点落在铅笔上会让回车误进改名。
  if (!props.switchOnly) nextTick(() => { renameBtn.value?.focus() })
})

// 回车确定：textarea 内回车用于换行、输入法合成态回车不上屏，均不触发保存
function onKeydown(e) {
  if (e.key !== 'Enter' || e.isComposing) return
  const tag = e.target && e.target.tagName
  if (tag === 'TEXTAREA') return
  // 焦点在按钮上时，回车是「按这个按钮」，不是「提交表单」。
  // 之前不排除按钮，焦点停在「取消」上按回车会 preventDefault 掉按钮自己的激活、
  // 转而执行 submit —— 用户想取消，结果保存了（审查 v4 · B07-01）。
  if (tag === 'BUTTON' || tag === 'A') return
  e.preventDefault()
  submit()
}
function submit() {
  // 重名时不提交：按钮已禁用，这里再拦一道（回车提交走的是同一条路径）
  if (nameDuplicate.value) return
  emit('confirm', { ...form.value })
}
</script>

<style scoped>
/* 入场动画：通用 dialogCardIn 在 70% 关键帧会放到 101.5%，切班/建班会让整个视图
   重建、本弹窗「原地恢复」，那段过冲就会重播一次 —— 看起来正是弹窗被微微撑大。
   这里改成单调放大的短动画（不过冲），关闭动画自补一份：外层 Transition 的
   .dialog-leave-active .dialog-card 会被上面的 animation 简写盖掉。 */
.class-switch-card {
  animation: classSwitchCardIn 0.22s ease-out;
}
@keyframes classSwitchCardIn {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}
.dialog-leave-active .class-switch-card {
  animation: classSwitchCardOut 0.22s ease-in forwards;
}
@keyframes classSwitchCardOut {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.97); }
}

/* 「＋ 新建班级」暖色毛玻璃按钮。
   底色不写死：取主题的 warning 色阶（各主题都是琥珀/暖橙系），用 color-mix 调成
   半透明再叠 backdrop-filter。这样浅色主题是淡橙玻璃、夜间主题自动变成深橙玻璃，
   文字色用 warning-hover（各主题都给了一档更深的同色相），对比度不用另算。 */
.add-class-btn {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-warning-hover, var(--color-warning));
  background: color-mix(in srgb, var(--color-warning) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning) 28%, transparent);
  backdrop-filter: blur(10px) saturate(1.5);
  /* 只有玻璃自身的内高光，不投外阴影：暖色玻璃要「贴」在弹窗上，
     一旦有外投影就会浮起来，和弹窗本身的毛玻璃层次打架。 */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
/* 悬浮只加深底色与描边，不出现任何阴影 */
.add-class-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-warning) 20%, transparent);
  border-color: color-mix(in srgb, var(--color-warning) 40%, transparent);
}
.add-class-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--color-warning) 26%, transparent);
}
.add-class-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 单班时的只读班名：内边距与下拉/输入框一致，这样三种状态切换时高度不跳；
   但刻意不描边 —— 它不可点击，做成下拉的样子会诱导用户去点。
   字号/行高必须对齐 AppSelect 根元素上的 14px / 21px：只写 font: inherit 会继承
   弹窗卡片的 16px（行高 24px），比下拉整整高 3px —— 状态一换，弹窗就跟着被撑大。
   蓝色聚焦环（输入框 focus / 下拉展开）只改 border-color 与 box-shadow，不参与布局；
   真正让弹窗尺寸变化的是这里的盒子高度，别再去动那个蓝框。 */
.class-static {
  padding: 7px 10px;
  font: inherit;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 铅笔内联重命名的输入框：内边距、边框、圆角全部对齐 AppSelect 的触发器，
   切换模式的瞬间盒子尺寸不跳，观感才像「同一个控件换了张脸」。 */
.rename-input {
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  /* 与下拉触发器同字号同行高（见 .class-static 注释），三种状态盒子都是 37px */
  font-size: 14px;
  line-height: 21px;
  color: inherit;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background-color: var(--color-surface-hover);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease;
}
.rename-input:focus {
  background-color: var(--color-surface);
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

/* 铅笔/完成按钮：高度靠父级 items-stretch 与下拉拉齐，只固定宽度 */
.rename-btn {
  flex: none;
  width: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  background-color: transparent;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}
.rename-btn:hover {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  background-color: var(--color-surface-hover);
}
/* 编辑态：按钮变成「确认」，用主色描边 + 淡底标出当前处于编辑中 */
.rename-btn--on {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  background-color: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

/* 取消按钮毛玻璃适配：半透明白遮罩 + 背景模糊 + 无边框 */
.glass-cancel {
  border: none !important;
  border-width: 0 !important;
  box-shadow: none !important;
  background-color: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(12px) saturate(1.3);
  color: var(--color-text);
  transition: background-color 0.15s ease;
}
.glass-cancel::before {
  display: none !important;
}
.glass-cancel:hover {
  background-color: rgba(255, 255, 255, 0.56);
}
</style>