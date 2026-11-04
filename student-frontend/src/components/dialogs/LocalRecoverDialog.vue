<template>
  <DialogShell :visible="visible" :z-index="10008" @overlay="$emit('close')">
    <div class="dialog-card bg-surface rounded-lg p-6 border border-border shadow-lg" style="width: 24rem; max-width: 92vw;">
      <h3 class="text-lg font-bold text-text mb-1">忘记密码</h3>

      <!-- 阶段 1：已登录，账号已知 —— 不列账号，直接用本机库验证这一个账号 -->
      <template v-if="phase === 'verifying'">
        <p class="text-xs text-text-muted mb-4">正在验证本机数据库中的账号「{{ username }}」…</p>
        <div class="flex justify-end">
          <button type="button" @click="$emit('close')" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme">取消</button>
        </div>
      </template>

      <!-- 阶段 2：验证失败（库不在本机、被移走、或不是同一账号） -->
      <template v-else-if="phase === 'error'">
        <p class="text-sm text-danger mb-4">{{ errorText }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" @click="$emit('close')" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme">关闭</button>
          <button type="button" @click="start" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme">重试</button>
        </div>
      </template>

      <!-- 阶段 3：验证通过，设置新密码（与登录页「忘记密码 → 设置新密码」同一套口径） -->
      <template v-else>
        <p class="text-xs text-text-muted mb-3">已通过本机数据库验证身份。设置新密码后即生效，原密码不再需要。</p>
        <input :value="username" readonly placeholder="账号" class="border border-border bg-surface text-text p-2 w-full mb-2 rounded" />
        <input v-model="password" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-2 rounded" @keydown.enter="submit" />
        <input v-model="confirm" type="password" placeholder="确认新密码" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-2 rounded" @keydown.enter="submit" />
        <p v-if="errorText" class="text-xs text-danger mb-2">{{ errorText }}</p>
        <div class="flex justify-end gap-2 mt-2">
          <button type="button" @click="$emit('close')" :disabled="busy" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme disabled:opacity-50">取消</button>
          <button type="button" @click="submit" :disabled="busy" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50">{{ busy ? '保存中…' : '设置新密码' }}</button>
        </div>
      </template>
    </div>
  </DialogShell>
</template>

<script setup vapor>
// 「设置 → 修改密码 → 忘记密码」专用：此时账号已经登录着，所以没有「选账号」这一步，
// 直接拿当前账号的库文件去 /api/db-recover 验证。验证通过后后端签的是 recover 态 token
// （只授权改密），本组件负责把它换成新密码 → 常规 token，收尾交给调用方。
//
// 登录页那条路径不能用这个弹窗：那里的忘记密码是嵌在登录卡片里的，而且还要先选账号/选恢复词。
// 两边共用的是 utils/localRecover.js 的请求层，不是 UI —— 请求分流只有一份，才不会一边处理了
// mustChangePassword、另一边没处理。
import DialogShell from '../base/DialogShell.vue'
import { ref, watch } from 'vue'
import { recoverFromLocalDb, submitRecoveredPassword } from '../../utils/localRecover.js'

defineOptions({ name: 'LocalRecoverDialog' })

const props = defineProps({
  visible: Boolean,
  // 当前账号的库标识（如 @1a2b3c4d5e6f），拼成 <slug>.db 交给后端定位
  slug: { type: String, default: '' },
  // 当前账号名；后端据此确认恢复的是同一个账号，而不是库里的第一个账号
  username: { type: String, default: '' },
})

const emit = defineEmits(['done', 'close'])

const phase = ref('verifying')   // verifying | form | error
const password = ref('')
const confirm = ref('')
const busy = ref(false)
const errorText = ref('')
// 序号守卫：关闭弹窗或重试时在途请求的结果必须丢掉，否则「关掉又开」会被上一次的
// 响应把阶段推成 form/error（utils/latestOnly.js 的同一套约定，这里只有一个请求位，够用）
let seq = 0

// immediate：本组件是懒加载的，首次点开时 visible 已经是 true，等 watch 触发就永远不会开始
watch(() => props.visible, (v) => {
  if (v) void start()
  else seq++
}, { immediate: true })

async function start() {
  const my = ++seq
  password.value = ''
  confirm.value = ''
  errorText.value = ''
  busy.value = false
  if (!props.slug) {
    phase.value = 'error'
    errorText.value = '缺少当前账号信息，请回到登录页用「忘记密码」恢复。'
    return
  }
  phase.value = 'verifying'
  try {
    const data = await recoverFromLocalDb({ file: props.slug + '.db', username: props.username })
    if (my !== seq) return
    // 本入口只在「有登录密码」时出现（只有 password / privacy 档显示修改密码按钮），
    // 走不到这里；万一真走到（比如后端判定与页面缓存不一致），直接交给调用方收尾，
    // 不要逼免密/明文账号再设一个密码。
    if (data.mustChangePassword === false) { emit('done'); return }
    phase.value = 'form'
  } catch (err) {
    if (my !== seq) return
    phase.value = 'error'
    errorText.value = err.response?.data?.error || '本机数据库验证失败，请回到登录页用「忘记密码」恢复。'
  }
}

async function submit() {
  if (busy.value) return
  errorText.value = ''
  if (!password.value || password.value.length < 6) {
    errorText.value = '新密码至少 6 位'
    return
  }
  if (password.value !== confirm.value) {
    errorText.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  try {
    await submitRecoveredPassword(password.value)
    emit('done')
  } catch (err) {
    errorText.value = err.response?.data?.error || '设置失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>
