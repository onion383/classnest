<template>
  <DialogShell :visible="visible" :z-index="10001">
      <div class="bg-surface rounded-lg p-6 border border-border shadow-lg dialog-card" style="width: 26rem; max-width: 92vw;">
        <h3 class="text-lg font-bold mb-1">{{ title }}</h3>
        <p class="text-xs text-text-muted mb-3">{{ description }}</p>
        <div v-if="phrase" class="p-3 rounded-lg mb-3 font-mono text-sm leading-6 bg-bg border border-border select-all break-all">{{ phrase }}</div>
        <div class="flex gap-2 mb-3">
          <button type="button" @click="downloadTxt" class="bg-info hover:bg-info-hover text-text-inverse px-3 py-2 rounded-lg text-sm flex-1">下载文本</button>
          <button type="button" @click="copyPhrase" class="bg-info hover:bg-info-hover text-text-inverse px-3 py-2 rounded-lg text-sm flex-1">复制</button>
        </div>
        <input v-model="copyWords" placeholder="抄写前 3 个词（可带序号、可不带空格）" autocomplete="off" class="border border-border bg-surface text-text p-2 w-full rounded-lg" @keydown.enter="submit" />
        <p v-if="errorText" class="text-xs text-danger mt-2">{{ errorText }}</p>
        <p v-else class="text-xs text-text-muted mt-2">{{ downloaded ? '已保存到本地，抄写前 3 个词后即可继续。' : '请先点「下载文本」保存到本地，再抄写前 3 个词。' }}</p>
        <div class="flex justify-center gap-2 mt-4">
          <button v-if="cancelText" type="button" @click="$emit('cancel')" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme">{{ cancelText }}</button>
          <button type="button" @click="submit" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme">{{ confirmText }}</button>
        </div>
      </div>
  </DialogShell>
</template>

<script setup vapor>
// 恢复词的唯一展示入口：注册（超级隐私）与「切换安全等级 → 超级隐私」共用同一套交互。
// 两边约束一致：必须先下载到本地、再抄写前 3 个词，才允许继续 —— 恢复词只出现这一次，
// 用户没真正保存就关掉等于把账号锁死。确认之后做什么由调用方决定（注册要继续建库，
// 切换只是关弹窗），所以这里只 $emit('confirm')，不碰业务请求。
//
// 层级取 10001（低于 ConfirmDialog 的 10006）：注册路径点「确认」后还要在其上弹「仅此一份」的警示框。
import '../../styles/dialog-transition.css'
import DialogShell from '../base/DialogShell.vue'
import { ref, watch } from 'vue'
import { INVOKE } from '../../electronChannels.js'
import { useNotification } from '../../composables/useNotification.js'
import { reportError } from '../../utils/reportError.js'
import { classifySaveResult } from '../../utils/saveResult.js'

defineOptions({ name: 'RecoveryKeyDialog' })

const props = defineProps({
  visible: Boolean,
  // 12 个恢复词（空格分隔）
  phrase: { type: String, default: '' },
  // 仅用于写入 txt 文件的「账号：xxx」一行
  username: { type: String, default: '' },
  title: { type: String, default: '保存恢复密钥' },
  description: { type: String, default: '这是超级隐私模式的恢复词，也是忘记密码时的唯一凭证。请点击「下载文本」保存到安全的地方，然后抄写前 3 个词完成确认。' },
  confirmText: { type: String, default: '确认并完成注册' },
  // 传了才显示取消按钮；「切换安全等级」场景不给退路，传空串
  cancelText: { type: String, default: '' },
})

const emit = defineEmits(['confirm', 'cancel'])

const downloaded = ref(false)
const copyWords = ref('')
const errorText = ref('')

// 每次打开（或换了一份恢复词）都从零开始：下载标记与抄写内容不能跨次复用，
// 否则第二次打开会带着上一份的「已下载」直接放行。
watch(() => [props.visible, props.phrase], () => {
  downloaded.value = false
  copyWords.value = ''
  errorText.value = ''
})

async function downloadTxt() {
  const content = `班集 - 恢复密钥\n账号：${props.username}\n\n请妥善保存以下恢复词，忘记密码时可用来找回：\n\n${props.phrase}\n`
  const fileName = `恢复密钥-${props.username || 'account'}.txt`
  try {
    // 走 Electron 原生保存对话框，写盘成功才返回成功；用户取消则保持锁定。
    // 三态判定与 utils/saveFile.js 共用：写盘失败（fail）必须报错，不能被当成取消。
    const res = await window.electron.invoke(INVOKE.SAVE_FILE, { defaultName: fileName, data: content })
    const kind = classifySaveResult(res)
    if (kind === 'canceled') return
    if (kind === 'fail') {
      reportError(new Error((res && res.error) || '保存文件失败'), { action: '保存恢复密钥' })
      return
    }
    downloaded.value = true
    useNotification().success('恢复密钥文本已保存到本地')
  } catch (e) {
    reportError(e, { action: '保存恢复密钥' })
  }
}

async function copyPhrase() {
  try {
    // 主进程写剪贴板并定时清空：恢复词不该长期留在系统剪贴板里
    await window.electron.invoke(INVOKE.COPY_SENSITIVE_TEXT, { text: props.phrase, ttlMs: 60000 })
    useNotification().success('恢复词已复制，60 秒后自动清空剪贴板')
  } catch (_) {
    useNotification().error('复制失败，请手动抄写')
  }
}

function submit() {
  errorText.value = ''
  if (!downloaded.value) {
    errorText.value = '请先将恢复密钥保存到本地再继续'
    return
  }
  const expected = props.phrase
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(w => w.replace(/^\d+\./, ''))
  const raw = copyWords.value || ''

  // 兼容三种输入：带空格分词 / 无空格但带序号（如 1.水2.络3.木）/ 纯顶住汉字（水络木）
  const bySpace = raw.split(/\s+/).filter(Boolean).map(w => w.replace(/^\d+\./, ''))
  const byId = [...raw.matchAll(/\d+\.\s*([^\d]+)/g)].map(m => m[1].replace(/\s+/g, ''))
  const chars = raw.replace(/[^\u4e00-\u9fa5]/g, '').split('')

  const spacedOk = bySpace.length === expected.length && expected.every((w, i) => bySpace[i] === w)
  const bracketedOk = byId.length === expected.length && expected.every((w, i) => byId[i] === w)
  const jammedOk = !spacedOk && chars.length >= 3 && chars.join('') === expected.join('')

  if (!spacedOk && !bracketedOk && !jammedOk) {
    errorText.value = '前 3 个词抄写不正确，请按顺序抄写，如「' + expected.join(' ') + '」'
    return
  }
  emit('confirm')
}
</script>
