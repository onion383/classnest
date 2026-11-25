import { reportError } from '../../utils/reportError.js'
import axios from 'axios'
import { undoById, redoById } from '../../api/undo.js'
import { useNotification } from '../useNotification.js'
import { useThemeStore } from '../../stores/theme.js'
import { ASK_OTHER_KEY, AI_PERMISSION_FULL } from './aiConstants.js'
import { apiFetch } from '../../utils/apiUrl.js'
import { normalizeAsk } from './aiMessages.js'
import { encodeStreamRequest, decodeStreamEvent, clearSession, safe } from '../secureChannel.js'
import { classScopeKey } from '../../utils/classScope.js'
import { nextTick } from 'vue'

// 流式思维链在时间轴里的临时步骤 id：本轮思考结束前用它占位，后端下发完整
// reason 步骤时就地替换（位置不动、不新增），随后换回后端真实 id。
const LIVE_REASON_ID = '_live_reason'

// send / _streamReply / interrupt / retry / rollback / ask 相关的方法组（原 Options API mixin，现为 ctx 闭包 composable）。
// ctx 契约：状态 ref 用 .value 访问，跨模块方法经 ctx 运行时解析。
export function useAiChat(ctx) {
  return {
    // 点选项：多选=勾选/取消，单选=选中（再点一下取消）；选中「其他」只展开输入框，等填写后再继续
    pickAsk(qi, option) {
      const a = ctx.pendingAsk.value
      const q = a && a.questions[qi]
      if (!q) return
      if (q.multiple) {
        const arr = Array.isArray(q.picked) ? q.picked.slice() : []
        const i = arr.indexOf(option)
        if (i >= 0) arr.splice(i, 1)
        else arr.push(option)
        q.picked = arr
        return // 多选需显式点「下一页 / 完成」才继续
      }
      q.picked = q.picked === option ? undefined : option
      q.skipped = false // 重新选择后取消「跳过」标记
      // 选中「其他」需先填写补充内容；取消选中时不自动继续
      if (option === ASK_OTHER_KEY || q.picked === undefined) return
      // 单选：即点即走（分页前进 / 单题直接提交）
      if (a.questions.length > 1 && ctx.askPage.value < a.questions.length - 1) ctx.askPage.value += 1
      else ctx.submitAsk()
    },
    // 跳过当前「单选未作答」的题：标记 skipped（避免阻塞后续提交），分页前进，末题/单题直接提交
    skipAsk() {
      const a = ctx.pendingAsk.value
      if (!a) return
      const q = ctx.askCurrent.value || a.questions[0]
      if (q) q.skipped = true
      if (a.questions.length > 1 && ctx.askPage.value < a.questions.length - 1) ctx.askPage.value += 1
      else ctx.submitAsk()
    },
    // 「其他」补充内容输入（单选 / 多选通用），随答案一并回传
    setAskOther(qi, text) {
      const a = ctx.pendingAsk.value
      const q = a && a.questions[qi]
      if (q) q.other = String(text || '').slice(0, 200)
    },
    // 单题作答是否已有效：无选项题（自由作答）/ 已跳过 视为可过；多选需至少勾 1 项；选中「其他」必须已填写
    isAskQuestionReady(q) {
      if (!q || !q.options.length) return true
      if (q.skipped) return true
      const arr = Array.isArray(q.picked) ? q.picked : (q.picked ? [q.picked] : [])
      if (!arr.length) return false
      if (arr.includes(ASK_OTHER_KEY) && !String(q.other || '').trim()) return false
      return true
    },
    // 单题答案文本（多选用「、」连接；「其他」拼上补充内容；跳过的单选记为「跳过」）
    askAnswerText(q) {
      const one = (v) => (v === ASK_OTHER_KEY
        ? (String(q.other || '').trim() ? `其他：${String(q.other).trim()}` : '其他')
        : v)
      const arr = Array.isArray(q.picked) ? q.picked : (q.picked ? [q.picked] : [])
      if (!arr.length) return q && q.skipped ? '跳过' : '（未选择）'
      return arr.map(one).join('、')
    },
    // 多问题分页：翻到下一题
    askNext() {
      const a = ctx.pendingAsk.value
      const n = a && Array.isArray(a.questions) ? a.questions.length : 0
      if (ctx.askPage.value < n - 1) ctx.askPage.value += 1
    },
    // 汇总所有答案发送（单题只发答案本身；多题按「序号. 问题：答案」汇总）
    submitAsk() {
      const m = ctx._lastAssistant()
      if (!m || !m.ask || m.ask.answered || !ctx.askCanSubmit.value) return
      const qs = m.ask.questions || []
      m.ask.answered = true
      const text = qs.length > 1
        ? qs.map((x, i) => `${i + 1}. ${x.question}：${ctx.askAnswerText(x)}`).join('\n')
        : ctx.askAnswerText(qs[0])
      // 回答写入原助手消息的思维链，不再新增用户输入气泡
      ctx._sendFeedback(text, `用户回答：${text}`, m)
    },
    // 取消提问：标记已取消，并把「暂不回答」接着发起下一轮（写入思维链），避免对话停在原地
    dismissAsk() {
      const m = ctx._lastAssistant()
      if (!m || !m.ask || m.ask.answered || m.ask.dismissed || ctx.busy.value) return
      m.ask.dismissed = true
      ctx._sendFeedback('我暂不回答这个问题，请不要重复提问，按你的判断继续。', '用户暂不回答，继续处理', m)
    },
    // 复制这条回复的正文到剪贴板
    async copyMessage(m) {
      const text = m && m.content ? m.content : ''
      if (!text) return
      const { success: notify, error: notifyError } = useNotification()
      try {
        await navigator.clipboard.writeText(text)
        notify('已复制回复')
      } catch (_) {
        notifyError('复制失败')
      }
    },
    // 重试：丢弃这条回复（及其后并入它的隐藏反馈），用其上一条提问重新生成（同步删除落库旧消息，避免刷新后重复）
    async retryMessage(i) {
      if (!ctx.isRetryable(i)) return
      const dropped = ctx.messages.value.slice(i)
      const ids = dropped.map((m) => m._id).filter((v) => v != null)
      if (ctx.conversationId.value && ids.length) {
        try { await axios.post(`/api/ai/conversations/${ctx.conversationId.value}/messages/delete`, { ids }) } catch (_) { /* best-effort: 删除失败不阻塞重试 */ }
      } else if (ctx.conversationId.value) {
        try { await axios.delete(`/api/ai/conversations/${ctx.conversationId.value}/messages/last-assistant`) } catch (_) { /* best-effort: 删除失败不阻塞重试 */ }
      }
      ctx.messages.value.splice(i)
      ctx.messages.value.push({ role: 'assistant', loading: true, content: '', _live: true, steps: [], processOpen: true, isError: false })
      await ctx._streamReply()
    },
    // 点某条回复的「回退」：记下以哪条为界，弹确认框
    askRollback(i) {
      if (i == null || !ctx.isRollbackable(i)) return
      ctx.rollbackTarget.value = i
      ctx.rollbackConfirmShow.value = true
    },
    // 确认框点「确定」：关闭弹窗，以记下的索引执行回退
    onRollbackConfirm() {
      ctx.rollbackConfirmShow.value = false
      const i = ctx.rollbackTarget.value
      ctx.rollbackTarget.value = -1
      if (i >= 0) ctx.rollbackFrom(i)
    },
    // 以第 i 条助手消息为界：这条及其后的消息 + 这些消息里 AI 已执行的数据改动一起失效。
    // 先存完整快照，供「撤销回退 / 重做回退」在两种状态间来回切（undoRollback / redoRollback）。
    async rollbackFrom(i) {
      if (ctx.busy.value || !ctx.isRollbackable(i)) return
      // 回退要逐个 await undoById / 删消息 / 落库，期间必须占住 busy：
      // 否则用户能再发消息或再点回退，两轮并发操作同一批 undoIds → 重复撤回/乱序。
      // 与 send 一样用 finally 统一释放，异常路径也不留死 busy（#40）。
      ctx.busy.value = true
      const { success: notify } = useNotification()
      const list = ctx.messages.value
      // 起点往前找最近一条真实用户提问，连它一起删（否则会留下没有回复的孤立提问）
      let start = i - 1
      while (start >= 0 && !(list[start].role === 'user' && !ctx._isAutoMessage(list[start]))) start--
      if (start < 0) start = i
      const turn = list.slice(start)
      if (!turn.length) return
      // 快照必须在改动内存对象之前深拷贝：撤销时会把 proposal.undoIds 划掉、reverted 置 true，
      // 直接引用会让「复原」后的提案状态错乱（已撤回 / 撤不回来）。
      const snap = {
        conversationId: ctx.conversationId.value,
        start,
        messages: turn.map((m) => JSON.parse(JSON.stringify({
          role: m.role, content: m.content || '', _id: m._id, _auto: !!m._auto,
          images: m.images || [], attachments: m.attachments || [],
          steps: m.steps || [], reasoning: m.reasoning || '',
          processMs: m.processMs || 0, tokens: m.tokens || 0,
          promptTokens: m.promptTokens || 0, completionTokens: m.completionTokens || 0,
          proposal: m.proposal || null, ask: m.ask || null,
          isError: !!m.isError, interrupted: !!m.interrupted,
        }))),
        // 自动反馈消息落库靠 process.auto，不是 buildProc 的过程块结构
        proc: turn.map((m) => (m._auto ? { auto: true, text: m.content || '' } : ctx._buildProc(m))),
        undoIds: [], frontUndos: [], skipped: [],
        firstQuestion: (turn.find((m) => m.role === 'user' && !ctx._isAutoMessage(m)) || {}).content || '',
      }
      try {
        // 1) 还原这段里所有已执行且未撤回的数据改动（逆序，批量新增按相反顺序删除）
        for (const m of turn) {
          const p = m.proposal
          if (!p || !p.executed || p.reverted) continue
          if (p.kind === 'front' && p.frontUndo) {
            ctx._setFrontSetting(useThemeStore(), p.frontUndo.key, p.frontUndo.before)
            snap.frontUndos.push({ ...p.frontUndo })
            p.reverted = true
          } else if (p.undoIds && p.undoIds.length) {
            for (const id of p.undoIds.slice().reverse()) {
              const { data } = await undoById(id)
              if (!data || !data.ok) throw new Error((data && data.error) || '还原失败')
              // 撤一条就从队列里划掉一条：整段失败时已成功的那些不能再撤第二次，
              // 否则重试会对同一笔改动二次撤回（审查 v4 · B10-07）。
              p.undoIds = p.undoIds.filter((x) => x !== id)
              snap.undoIds.push(id)
            }
            p.reverted = true
          } else if (p.kind === 'snapshot_restore' || p.kind === 'skill') {
            // 这两类不登记撤销记录，本来就撤不回来，明确记下来给用户看
            snap.skipped.push(p.label || p.kind)
          }
        }
        // 2) 按落库 id 精确删除这段消息，再清出内存
        const ids = turn.map((m) => m._id).filter((v) => v != null)
        if (ctx.conversationId.value && ids.length) {
          try { await axios.post(`/api/ai/conversations/${ctx.conversationId.value}/messages/delete`, { ids }) } catch (_) { /* best-effort: 删除失败不阻塞回退 */ }
        }
        list.splice(start)
        // 3) 把这段的第一条提问放回输入框，供改改再发
        ctx.input.value = snap.firstQuestion
        ctx.rollbackSnapshot.value = snap
        ctx.rollbackUndone.value = false
        nextTick(() => {
          ctx.scrollBottom()
          if (ctx.composer.value) ctx.composer.value.focusInput()
        })
        notify(`已回退 ${snap.messages.length} 条消息与 ${snap.undoIds.length + snap.frontUndos.length} 处数据改动`)
        await ctx.loadConversationList()
      } catch (err) {
        reportError(err, { action: '回退' })
      } finally {
        ctx.busy.value = false
      }
    },
    // 后悔药是否还能用：会话一致、且消息条数仍是那次回退后的期望值
    // （回退后或撤销回退后用户又发了新消息，插回去会打乱顺序，直接让记录失效）
    _rollbackUsable(expected) {
      const snap = ctx.rollbackSnapshot.value
      return !!snap && !ctx.busy.value
        && snap.conversationId === ctx.conversationId.value
        && ctx.messages.value.length === expected
    },
    // 撤销回退：数据改回去、被删的消息原样落回来，之后仍可「重做回退」
    async undoRollback() {
      const snap = ctx.rollbackSnapshot.value
      if (!snap || ctx.rollbackUndone.value) return
      if (!ctx._rollbackUsable(snap.start)) { ctx.dismissRollback(); useNotification().error('回退后已产生新消息，无法再撤销'); return }
      try {
        ctx.busy.value = true
        // 1) 数据重做：按撤销顺序的逆序 redo（后端 flip 0→1）；前端设置应用 after
        for (const id of snap.undoIds.slice().reverse()) {
          const { data } = await redoById(id)
          if (!data || !data.ok) throw new Error((data && data.error) || '重做失败')
        }
        for (const f of snap.frontUndos) ctx._setFrontSetting(useThemeStore(), f.key, f.after)
        // 2) 消息重新落库：id 会变，逐条换掉快照里的 _id，供重做时精确删除
        for (let k = 0; k < snap.messages.length; k++) {
          const row = snap.messages[k]
          row._id = await ctx.persistMessage(row.role, row.content, row.images, snap.proc[k], row.attachments)
        }
        // 3) 还原前端消息对象（丢掉渲染缓存，交给 _computeHtml 重算 markdown）
        const restored = snap.messages.map((row) => ({
          ...JSON.parse(JSON.stringify(row)),
          _live: false, _blocks: null, _liveHtml: '', _liveTail: '',
          processDone: true, processOpen: false, loading: false,
        }))
        ctx.messages.value.splice(snap.start, 0, ...restored)
        for (const m of restored) if (m.role === 'assistant') ctx._computeHtml(m)
        ctx.input.value = ''
        ctx.rollbackUndone.value = true
        useNotification().success('已撤销回退：消息与数据改动已复原')
        await ctx.loadConversationList()
      } catch (err) {
        reportError(err, { action: '撤销回退' })
      } finally {
        ctx.busy.value = false
      }
    },
    // 重做回退：数据再撤销、消息再删掉，输入框重新放回那条提问
    async redoRollback() {
      const snap = ctx.rollbackSnapshot.value
      if (!snap || !ctx.rollbackUndone.value) return
      if (!ctx._rollbackUsable(snap.start + snap.messages.length)) { ctx.dismissRollback(); useNotification().error('撤销回退后已产生新消息，无法再重做'); return }
      try {
        ctx.busy.value = true
        // 1) 数据再撤销（后端 flip 1→0）；前端设置写回 before
        for (const id of snap.undoIds) {
          const { data } = await undoById(id)
          if (!data || !data.ok) throw new Error((data && data.error) || '还原失败')
        }
        for (const f of snap.frontUndos) ctx._setFrontSetting(useThemeStore(), f.key, f.before)
        // 2) 按当前（重新落库后的）id 删除消息并移出内存
        const ids = snap.messages.map((m) => m._id).filter((v) => v != null)
        if (ctx.conversationId.value && ids.length) {
          try { await axios.post(`/api/ai/conversations/${ctx.conversationId.value}/messages/delete`, { ids }) } catch (_) { /* best-effort: 删除失败不阻塞 */ }
        }
        ctx.messages.value.splice(snap.start)
        ctx.input.value = snap.firstQuestion
        ctx.rollbackUndone.value = false
        useNotification().success('已重做回退')
        await ctx.loadConversationList()
      } catch (err) {
        reportError(err, { action: '重做回退' })
      } finally {
        ctx.busy.value = false
      }
    },
    // 关掉提示条：丢弃这次后悔药记录，之后不再能撤销/重做
    dismissRollback() {
      ctx.rollbackSnapshot.value = null
      ctx.rollbackUndone.value = false
    },
    // auto=true 时为「自动反馈」消息（回答提问 / 执行或取消提案）：落库标记 process.auto，界面不渲染气泡
    // target 为「续写目标」助手消息：本轮输出继续追加到它身上（时间轴保持连续，不再拆成多段）
    // feedbackText 为自动反馈正文：自动轮不经过输入框，既不污染用户草稿，也不依赖清空来收尾
    async send(auto, autoText, target, feedbackText) {
      const isAuto = auto === true
      const cont = target && target.role === 'assistant' ? target : null
      const text = isAuto ? String(feedbackText ?? '').trim() : ctx.input.value.trim()
      const file = isAuto ? null : ctx.attachedFile.value
      if (!text && !file) return
      // AI 回复期间用户又写了一句话：不打断、不丢弃，排进等待队列，
      // 等本次回复（含全权限自动执行提案的续跑）整个结束后自动发送。
      if (ctx.busy.value && !isAuto) {
        ctx.queuedMessages.value.push({
          id: `q${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          text,
          // 附件/图片必须随队列一起存：原实现只存 text，排队期间用户附的文件在
          // sendNextQueued 时被丢掉，等轮到它发送已经没有 file 了（#17）。
          file: file || null,
          conversationId: ctx.conversationId.value || 0,
        })
        ctx.input.value = ''
        ctx.attachedFile.value = null
        return
      }
      // 自动反馈轮（全权限自动执行提案后的续跑）在 busy 未复位时也要能发起，
      // 所以这里不能有统一的 busy 闸门；用户手发已在 busy 时转为排队。
      if (!isAuto) {
        ctx.input.value = ''
        ctx.attachedFile.value = null
      }
      try {
        ctx.conversationId.value = await ctx.ensureConversation()
      } catch (_) { /* best-effort: 建会话失败也继续（本轮消息不落库） */ }

      // 构建消息内容和图片列表
      let messageContent = text
      let images = []
      // 本轮附件（{name, text}）：随用户消息落库，之后每一轮都作为完整上下文的一部分
      // 保留，AI 需要时用 read_document 按需读取（内容不直接塞进消息）
      let attachments = []
      if (file) {
        if (file.isImage) {
          // 图片：走 vision API 多模态
          images = [file.dataUrl]
        } else if (file.textContent) {
          messageContent = `文件「${file.name}」${text ? '\n' + text : ''}`
          attachments = [{ name: file.name, text: file.textContent }]
        }
      }

      // 自动反馈消息：落库标记（process.auto + 展示用文案），刷新后据此并入原助手消息的思维链
      const proc = isAuto ? { auto: true, text: autoText || text } : undefined
      const uid = await ctx.persistMessage('user', messageContent, images, proc, attachments)
      ctx.messages.value.push({ role: 'user', content: messageContent, images, attachments, _id: uid, _auto: isAuto })

      if (cont) {
        // 续写同一助手消息：不新建气泡，记住续写起点（基础正文/已定步骤），本轮输出追加其后
        cont._live = true
        // 续写复用旧气泡：上一轮若是错误消息，必须清掉标记，否则新回复会被当成错误
        cont.isError = false
        cont.loading = false
        cont.processDone = false
        cont.processOpen = true
        cont._blocks = null
        cont._liveSrc = null
        cont._liveHtml = ''
        cont._liveTail = ''
        // 基础正文（去掉尾部空白，避免多轮续写累积空行），本轮输出以空行分隔追加其后
        cont._baseContent = (cont.content || '').replace(/\s+$/, '')
        cont.content = cont._baseContent ? cont._baseContent + '\n\n' : ''
        cont._baseSteps = (cont.steps || []).length
        cont.reasoning = ''
        await ctx._streamReply(cont)
      } else {
        ctx.messages.value.push({ role: 'assistant', loading: true, content: '', _live: true, steps: [], processOpen: true, isError: false })
        await ctx._streamReply()
      }
    },
    // 本次回复结束后自动发送队列里的下一条：一次只发一条，
    // 这条的回复结束时再发下下条（由 _streamReply 的 streamDepth 收尾触发）。
    async sendNextQueued() {
      if (ctx.busy.value || !ctx.queuedMessages.value.length) return
      const q = ctx.queuedMessages.value[0]
      ctx.queuedMessages.value.shift()
      // 会话已切换：丢弃不属于当前会话的排队消息，继续找下一条
      if (q.conversationId !== (ctx.conversationId.value || 0)) return ctx.sendNextQueued()
      ctx.input.value = q.text
      // 恢复排队时一起存下的附件/图片（send 从 attachedFile 读），否则附件丢失
      ctx.attachedFile.value = q.file || null
      try {
        await ctx.send()
      } catch (e) {
        // 发送失败不要把用户写的话弄丢：放回队首（附件仍在 q.file 里）
        ctx.queuedMessages.value.unshift(q)
        reportError(e, { action: '发送排队消息' })
      }
    },
    // 从等待队列里移除一条（输入框上方的 ✕）
    removeQueued(id) {
      ctx.queuedMessages.value = ctx.queuedMessages.value.filter((q) => q.id !== id)
    },
    // 向 /api/ai/chat/stream 发起请求，把回复流式写入目标助手消息（发送 / 重试共用；不传则取最后一条助手）
    async _streamReply(target) {
      ctx.busy.value = true
      // 捕获发起本流的班级代次：切班/新建班级会 bumpClassScope 并销毁本组件，
      // 但流可能还在跑；finally 里若代次已变，绝不能用新 token 把旧班的提案写进新班（#39）。
      const myScope = classScopeKey.value
      // 全权限自动执行提案会在 finally 里嵌套发起续跑，用层数区分「整条任务链结束」
      // 与「中间某一轮结束」：只有最外层归零才能消费等待队列。
      ctx.streamDepth.value++
      // 「中断」按钮通过它停止本次响应：abort 后 fetch 读取会抛 AbortError
      ctx.abortCtrl.value = new AbortController()
      const cont = target && target.role === 'assistant' ? target : null
      let last = cont || ctx.messages.value[ctx.messages.value.length - 1]
      ctx.scrollBottom()
      try {
        // 客户端上下文窗口（F03-13）：只带最近 N 条 / 有限字符。
        // 有 conversationId 时后端会从库重建完整上下文，这份只是回退；
        // 回退路径同样要有界，否则长会话每轮都把整段历史塞进请求体。
        const usable = ctx.messages.value
          // 过滤掉：加载占位、写提案消息（结果已随「已执行/已取消」消息续跑）、正文为空的助手消息（提问轮正文已移入过程块）
          .filter((m) => !m.loading && !m.proposal && !(m.role === 'assistant' && !m.content))
        const kept = []
        let historyChars = 0
        for (let i = usable.length - 1; i >= 0; i--) {
          const m = usable[i]
          const len = typeof m.content === 'string' ? m.content.length : 0
          if (kept.length >= 60 || historyChars + len > 30000) break
          kept.unshift(m)
          historyChars += len
        }
        const history = kept.map((m) => {
          if (m.role === 'user' && m.images && m.images.length) {
            return {
              role: 'user',
              content: [
                { type: 'text', text: m.content || '' },
                ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            }
          }
          return { role: m.role, content: m.content || '' }
        })
        // 附件已随用户消息落库，后端会按 conversationId 从库中重建「完整上下文」；
        // 这里仍随请求聚合一份附件，作为「会话未落库（无 conversationId）」时的回退。
        const attachments = []
        for (const m of kept) {
          if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
            for (const a of m.attachments) attachments.push({ name: a.name, text: a.text, messageId: m._id })
          }
        }
        // 安全通道开启时整体加密请求体；关闭时原样明文（后端中间件透明兼容）
        // 本轮由用户在输入框按「/」启用的技能（md 指令文件名）：后端读取内容注入系统提示
        const payload = { messages: history, attachments, conversationId: ctx.conversationId.value || 0, skills: ctx.selectedSkills.value || [], webSearch: ctx.webSearchOn.value !== false }
        const doSend = async () => apiFetch('/api/ai/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await encodeStreamRequest(payload)),
          signal: ctx.abortCtrl.value.signal,
        })
        let resp = await doSend()
        // 加密会话被动过期（15 分钟）时后端返回 401：清会话、重新握手后重试一次（与 axios 层行为一致）
        if (resp.status === 401 && safe()) { clearSession(); resp = await doSend() }
        if (!resp.ok || !resp.body) throw new Error((resp.status === 400 && 'AI 未启用') || '请求失败')
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        if (!last) last = ctx.messages.value[ctx.messages.value.length - 1]
        last.loading = false
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            // 逐帧解码：明文帧直接解析，密文帧（安全通道开启时）解密还原
            const evt = await decodeStreamEvent(line.slice(5).trim())
            if (!evt) continue
            if (evt.type === 'delta') {
              last.content += evt.text || ''
              // 每输出完一行就即时渲染该行的 markdown，未完成的行先按纯文本
              ctx._updateLiveRender(last)
              // 正文开始输出 → 收起处理过程（避免界面跳动）
              if (last.reasoningStreaming) { last.reasoningStreaming = false; last.processOpen = false }
              ctx.scrollBottom()
            } else if (evt.type === 'reasoning') {
              // 思考直接作为时间轴末尾的一条「进行中」步骤实时增长。
              // 旧写法把它单独渲染在过程块最顶部（m.reasoning blob）：新一轮思考会插到
              // 所有历史步骤之上，本轮结束又变成 reason 步骤落到末尾 —— 看起来就是跳来跳去。
              if (!last.steps) last.steps = []
              let live = last.steps.find((s) => s.id === LIVE_REASON_ID)
              if (!live) {
                live = { id: LIVE_REASON_ID, kind: 'reason', title: '正在思考…', text: '', status: 'running' }
                last.steps.push(live)
              }
              live.text += evt.text || ''
              last.reasoningStreaming = true
              last.processOpen = true
              ctx.scrollBottom()
            } else if (evt.type === 'step') {
              if (!last.steps) last.steps = []
              let merged = false
              if (evt.step.kind === 'reason') {
                // 本轮思考收尾：后端下发完整步骤 → 原地替换「进行中」的临时步骤，
                // 位置不动、不新增；换回后端真实 id，下一轮才能再新建一条临时步骤
                // （沿用临时 id 会让下一轮命中这条已完成的思考，把新文字接到旧文字后面）。
                last.reasoningStreaming = false
                const li = last.steps.findIndex((s) => s.id === LIVE_REASON_ID)
                if (li !== -1) { last.steps.splice(li, 1, evt.step); merged = true }
              }
              if (!merged) {
                // 按 id 合并同一步（running → done/error）；没有对应步骤就按发生顺序追加到末尾
                const si = last.steps.findIndex((s) => s.id === evt.step.id)
                if (si === -1) last.steps.push(evt.step)
                else last.steps.splice(si, 1, { ...last.steps[si], ...evt.step })
              }
              last.processOpen = true
              ctx.scrollBottom()
            } else if (evt.type === 'sub_step') {
              // 子助手轨迹增量：按主步骤 id 找到 run_subagent 的运行中步骤，按子任务 index 分组追加。
              // done 事件带的是后端同一份全量 steps，会整体覆盖这份临时结构，
              // 因此既不会重复，也不会在收尾时把已显示的文字换掉。
              if (!last.steps) last.steps = []
              let host = last.steps.find((s) => s.id === evt.stepId)
              if (!host) host = last.steps.slice().reverse().find((s) => s.status === 'running' && s.kind === 'tool')
              if (host) {
                if (!host.subSteps) host.subSteps = []
                const idx = Number(evt.index) || 0
                while (host.subSteps.length <= idx) host.subSteps.push({ name: '子助手', steps: [] })
                const g = host.subSteps[idx]
                if (evt.name) g.name = evt.name
                if (evt.kind === 'reason') {
                  let s = g.steps.find((x) => x._round === evt.round && x.kind === 'reason')
                  if (!s) { s = { kind: 'reason', text: '', _round: evt.round }; g.steps.push(s) }
                  s.text += evt.text || ''
                } else if (evt.kind === 'tool') {
                  g.steps.push({ kind: 'tool', title: evt.title || '' })
                }
              }
              last.processOpen = true
              ctx.scrollBottom()
            } else if (evt.type === 'commit_process') {
              // 中间轮的草稿文本归入过程块：从正文移出，作为一条过程文本步骤
              if (!last.steps) last.steps = []
              last.steps.push({ id: 'pt' + last.steps.length + '_' + Date.now(), kind: 'text', text: evt.text, status: 'done' })
              // 续写时保留基础正文，只清掉本轮的草稿正文
              last.content = last._baseContent ? last._baseContent + '\n\n' : ''
              last.processOpen = true
              ctx.scrollBottom()
            } else if (evt.type === 'proposal') {
              last.proposal = evt.proposal
            } else if (evt.type === 'ask') {
              last.ask = normalizeAsk(evt.ask)
            } else if (evt.type === 'export_file') {
              // AI 导出的文件规格：流结束后再弹保存对话框，避免打断正在输出的正文
              last.exportFile = evt.exportFile
            } else if (evt.type === 'export_image') {
              // AI 导出的排布图规格：同样等流结束后渲染 PNG 并弹保存对话框
              last.exportImage = evt.exportImage
            } else if (evt.type === 'err') {
              // code='conversation_missing'：后端发现会话已被删除（前后端状态不一致）。
              // 必须清掉失效的 conversationId，否则每次发送都用同一个死 id → 每次都失败，
              // 用户被卡在「发不出消息」的状态里。清空后下次发送会自动新建会话。
              if (evt.code === 'conversation_missing') {
                ctx.conversationId.value = null
                ctx.messages.value = ctx.messages.value.filter((m) => m.role !== 'assistant' || !m.loading)
                try { await ctx.loadConversationList() } catch (_) { /* best-effort: 列表刷新失败不阻塞 */ }
              }
              last.content = (cont && last._baseContent ? last._baseContent + '\n\n' : '') + (evt.message || '请求失败')
              // 错误消息不再靠「⚠️」文案前缀区分（图标模式下那是彩色 emoji），改用显式字段
              last.isError = true
            } else if (evt.type === 'done') {
              last.reasoningStreaming = false
              last.processDone = true
              if (Array.isArray(evt.steps)) {
                // 续写时保留续写前已定的步骤，把本轮步骤追加其后（时间轴连续）
                const base = cont ? (last._baseSteps || 0) : 0
                last.steps = (last.steps || []).slice(0, base).concat(evt.steps)
              }
              last.processMs = evt.ms || 0
              last.tokens = evt.tokens || 0
              last.promptTokens = evt.promptTokens || 0
              last.completionTokens = evt.completionTokens || 0
              if (cont) {
                // 续写：把本轮正文追加到基础正文之后（reply 为最终轮正文，含 record 数据块）
                const round = evt.reply != null ? evt.reply : ''
                last.content = (last._baseContent ? last._baseContent + '\n\n' : '') + round
              } else if (!last.proposal) {
                // 以后端的 reply 为准：它是最终轮的正文，且包含 show_record 生成的 record 数据块
                last.content = evt.reply || last.content || ((last.ask || last.exportFile || last.exportImage) ? '' : '（无内容）')
              }
              // 提问轮不再把问题写进气泡正文：问题以「向你提问」步骤呈现在过程块，选项在浮窗里给出
              // 过程结束后自动收起；若没有任何过程内容，整块自行消失
              if ((last.steps && last.steps.length) || last.reasoning) last.processOpen = false
            }
          }
        }
        // AI 导出：流结束后弹出系统保存对话框生成并保存文件 / 排布图
        ctx.triggerPendingExport(last)
        ctx.triggerPendingImage(last)
        const proc = ctx._buildProc(last)
        // 正文为空但有过程块（写提案轮 / 提问轮）也落库，刷新后仍能看到步骤
        if (ctx.conversationId.value && (last.content || proc)) {
          // 续写：覆盖原助手消息（避免每轮新插入一行、刷新后又被拆成多段）
          if (cont && last._id) await ctx.updateMessage(last._id, last.content, proc)
          else last._id = await ctx.persistMessage('assistant', last.content, undefined, proc)
        }
        if (last.content === '' && !last.proposal && !last.ask && !last.exportFile && !last.exportImage) {
          last.content = '未收到回复'
          last.isError = true
        }
        // 后台预计算 markdown HTML（不阻塞 UI）
        ctx._computeHtml(last)
      } catch (err) {
        if (!last) last = ctx.messages.value[ctx.messages.value.length - 1]
        last.loading = false
        if (err && err.name === 'AbortError') {
          // 用户点了「中断」：保留已生成的部分正文并落库，不覆盖成报错
          last.interrupted = true
          if (!last.content && !last.proposal && !last.ask && !last.exportFile && !last.exportImage) last.content = '⏹ 已中断'
          const proc = ctx._buildProc(last)
          if (ctx.conversationId.value && (last.content || proc)) {
            if (cont && last._id) await ctx.updateMessage(last._id, last.content, proc)
            else last._id = await ctx.persistMessage('assistant', last.content, undefined, proc)
          }
          ctx._computeHtml(last)
        } else {
          last.content = (cont && last._baseContent ? last._baseContent + '\n\n' : '') + (err.response?.data?.error || err.message || '请求失败')
          last.isError = true
        }
      } finally {
        ctx.abortCtrl.value = null
        if (last) {
          last.reasoningStreaming = false
          last.processDone = true
          // 中断 / 异常时后端不会下发收尾步骤，把「进行中」的思考就地标成完成，
          // 否则落库后刷新会看到一条永远转圈的步骤。
          const live = (last.steps || []).find((s) => s.id === LIVE_REASON_ID)
          if (live) live.status = 'done'
        }
        // 流结束这一刻正文才刚变成 _blocks，里面的 AiRecordTable 还要异步取数、
        // 图片要加载、图表要绘制，高度会在之后继续长 —— 交给 ResizeObserver 在贴底时跟随。
        // 只做一次「贴底才置底」，不强制：用户翻历史时收尾不能把他拽回底部。
        ctx.scrollBottom()
        // 完全权限：写入提案不等用户确认，流一结束就自动执行。
        // 例外：技能（md 指令文件）变更即使在全权限下也须老师确认，故不自动执行（走浮窗确认）。
        //
        // ⚠️ busy 必须在提案执行**之后**才复位：
        //   executeProposal 是 async（要 POST 写库），提前置 false 会让用户在提案没写完时
        //   发下一条消息 → 两轮同时写同一张表 → 数据竞态。
        //   执行收尾的 _sendFeedback 是自动反馈轮，send 对 auto 放行 busy 闸门，
        //   因此它能在写库期间接着续跑（写回思维链 + 让 AI 说明结果），用户仍插不了队。
        // 代次校验：切班/新建班级后 myScope 已过期（组件被销毁、token 换成新班），
        // 旧流的提案绝不能在新班执行 —— 那是用旧班的意图写新班的库（#39）。
        const scopeStillCurrent = classScopeKey.value === myScope
        if (scopeStillCurrent
          && ctx.permissionMode.value === AI_PERMISSION_FULL
          && last && last.proposal && last.proposal.kind !== 'skill'
          && !last.proposal.executed && !last.proposal.dismissed && !last.interrupted) {
          try {
            await ctx.executeProposal(last)
          } catch (e) {
            // executeProposal 内部已 notifyError，这里只兜住它自己抛出来的异常
            console.error('[aiChat] 自动执行提案失败', e)
          }
        }
        ctx.busy.value = false        // 刷新会话列表（更新标题和消息数）
        await ctx.loadConversationList()
        ctx.streamDepth.value--
        // 只有最外层回复结束才发送队列下一条：内层（自动执行提案后的续跑）结束就发，
        // 新流会和外层的收尾重叠，且内层已把 busy 复位，等于并发两条回复。
        if (scopeStillCurrent && ctx.streamDepth.value === 0 && !ctx.busy.value) {
          ctx.sendNextQueued().catch((e) => console.error('[aiChat] 发送排队消息失败', e))
        }
      }
    },
    // 中断当前回复：停止流式请求并保留已完成的部分，用户可继续输入、发送下一条
    interrupt() {
      if (!ctx.busy.value || !ctx.abortCtrl.value) return
      try { ctx.abortCtrl.value.abort() } catch (_) { /* best-effort: 请求已结束时重复 abort 可忽略 */ }
    },
    // 惰性创建会话：首次发送时才建
    async ensureConversation() {
      if (ctx.conversationId.value) return ctx.conversationId.value
      const { data } = await axios.post('/api/ai/conversations', {})
      ctx.conversationId.value = data.id
      return data.id
    },
    async persistMessage(role, content, images, process, attachments) {
      if (!ctx.conversationId.value) return
      // 多模态消息：存为 JSON 数组
      const payload = (images && images.length)
        ? JSON.stringify([
            { type: 'text', text: content || '' },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ])
        : content
      const body = { role, content: payload }
      // 助手消息的过程块（步骤 / 思维链 / 耗时）一并落库，刷新后仍可查看
      if (process) body.process = process
      // 本轮上传的文件随消息落库，供后续轮次在完整上下文里读取
      if (Array.isArray(attachments) && attachments.length) body.attachments = attachments
      try {
        const { data } = await axios.post(`/api/ai/conversations/${ctx.conversationId.value}/messages`, body)
        // 返回落库 id，供回退功能精确删除本轮消息
        return (data && data.id) || undefined
      } catch (_) { /* best-effort: 持久化失败不阻塞对话 */ }
    },
    // 覆盖更新一条已落库的消息（续写同一助手消息时用，避免每轮新插入一行）
    async updateMessage(mid, content, process) {
      if (!ctx.conversationId.value || mid == null) return
      const body = { content: content || '' }
      if (process) body.process = process
      try { await axios.put(`/api/ai/conversations/${ctx.conversationId.value}/messages/${mid}`, body) } catch (_) { /* best-effort: 持久化失败不阻塞对话 */ }
    },
  }
}
