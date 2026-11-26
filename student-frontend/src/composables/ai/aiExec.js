import axios from 'axios'
import { useNotification } from '../useNotification.js'
import { recordUndo as recordUndoSpec } from '../../utils/undoRecorder.js'
import { useThemeStore } from '../../stores/theme.js'
import { EXEC, DOC_UNDO_KEY } from './aiConstants.js'

// 提案执行 + undo 登记 + 前端设置读写 相关的方法组（原 Options API mixin，现为 ctx 闭包 composable）。
// ctx 契约：状态 ref 用 .value 访问，跨模块方法经 ctx 运行时解析。
export function useAiExec(ctx) {
  return {
    // 浮窗内点「确认执行」：找到当前待确认提案所属的消息并执行
    confirmProposal() {
      const m = ctx._lastAssistant()
      if (m && m.proposal) ctx.executeProposal(m)
    },
    // 取消写入：标记已取消，把「已取消」接着发起下一轮（写入思维链），让 AI 继续回应
    dismissProposal() {
      const m = ctx._lastAssistant()
      if (!m || !m.proposal || m.proposal.executing || m.proposal.executed || m.proposal.dismissed || ctx.busy.value) return
      m.proposal.dismissed = true
      ctx._sendFeedback(
        `已取消：${m.proposal.label}。（数据未发生任何变更。请勿重复生成同一提案；如需调整方案，请先说明修改点或询问用户。）`,
        `已取消：${m.proposal.label}`,
        m
      )
    },
    // 把「用户反馈」写回原助手消息的思维链，并作为用户消息发给模型续跑（不新增用户输入气泡）
    // 续写目标即这条原助手消息：本轮输出继续写回它，时间轴保持连续
    _sendFeedback(content, stepText, sourceMsg) {
      const msg = sourceMsg || ctx._lastAssistant()
      const isAssistant = msg && msg.role === 'assistant'
      if (isAssistant) {
        if (!msg.steps) msg.steps = []
        msg.steps.push({ id: 'fb' + msg.steps.length + '_' + Date.now(), kind: 'text', text: stepText, status: 'done' })
        // 此刻提案/提问状态已被改写（已执行 / 已取消 / 已回答）：立即回写落库，
        // 避免续跑期间刷新时又还原成「待确认」，造成重复执行同一笔数据更改。
        if (msg._id != null) ctx.updateMessage(msg._id, msg.content || '', ctx._buildProc(msg))
      }
      // 反馈文本直接作为参数交给 send，不再写 ctx.input：输入框是用户可编辑的草稿，
      // 原先靠 send() 清空才不残留，而全权限自动执行提案时 send 会被 busy 闸门挡下，
      // 于是「已执行：…」这类内部文案留在输入框里，续跑也被一起吞掉。
      return ctx.send(true, stepText, isAssistant ? msg : null, content)
    },
    async executeProposal(m) {
      if (m.proposal.executing || m.proposal.executed) return
      // 这里仍需要 notifyError：失败分支要把原因同时告诉用户和 AI
      const { success: notify, error: notifyError } = useNotification()
      m.proposal.executing = true
      m.proposal.executed = false
      let executedLabel = ''
      // 本次执行产生的撤销记录统一打上同一批次标识，供 AI 的 undo_change 工具整批回退
      // 若该提案出自 run_subagent 的核查结果，前缀标记为「子agent:名 · 任务」，便于 list_changes 区分来源
      const note = m.proposal.originNote ? `子agent:${m.proposal.originNote}` : 'ai'
      const origin = `${note}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        if (m.proposal.kind === 'front') {
          // 前端设置提案：读旧值 → 经主题 store 立即应用 → 记下前后值供撤销
          const p = m.proposal
          const store = useThemeStore()
          const before = ctx._readFrontSetting(p.key)
          ctx._setFrontSetting(store, p.key, p.value)
          const after = ctx._readFrontSetting(p.key)
          m.proposal.frontUndo = { key: p.key, before, after, label: p.label }
          m.proposal.executing = false
          m.proposal.executed = true
          notify(p.label + ' 已应用')
          executedLabel = p.label
        } else if (m.proposal.kind === 'skill') {
          // 技能（md 指令文件）提案：新建 / 更新 / 删除，确认后落盘到技能库。
          // 技能文件不在数据撤销体系内，故不登记 undo；执行后刷新输入框「/」候选列表。
          const p = m.proposal
          const name = String(p.name || '')
          if (p.operation === 'delete') {
            await axios.delete(`/api/ai/skills/${encodeURIComponent(name)}`)
          } else if (p.operation === 'update') {
            await axios.put(`/api/ai/skills/${encodeURIComponent(name)}`, { name, content: p.content })
          } else {
            await axios.post('/api/ai/skills', { name, content: p.content })
          }
          await ctx.loadSkillOptions()
          m.proposal.executing = false
          m.proposal.executed = true
          notify(p.label + ' 已执行')
          executedLabel = p.label
        } else if (m.proposal.kind === 'json') {
          // 整块写入（课表/座位/权重/值日等「非行式」表）：按 id 覆盖指定列
          const p = m.proposal
          // payload（before/after）由后端在同事务里用写结果生成，前端不再二次登记。
          const spec = { key: DOC_UNDO_KEY[p.table] || p.table, type: 'doc_update', label: p.label, payload: {} }
          const resp = await axios.post('/api/ai/doc', { table: p.table, id: p.id, values: p.values, _undoSpec: spec })
          const d = resp.data || {}
          // 存下写入前的原始行：供「改动总结」统计被覆盖掉的原有非空格数，并在明细抽屉里对照
          m.proposal.gridBefore = d.before == null ? null : d.before
          const uid = await ctx._pushUndo('doc_update', DOC_UNDO_KEY[p.table] || p.table, p.label, { table: p.table, id: p.id, before: d.before, after: d.after, label: p.label }, origin, d.undoId)
          m.proposal.undoIds = uid != null ? [uid] : []
          m.proposal.executing = false
          m.proposal.executed = true
          notify(p.label + ' 已执行')
          executedLabel = p.label
        } else if (m.proposal.kind === 'batch_ops' || (m.proposal.operation === 'update' && m.proposal.batch)) {
          // 跨表批量操作 / 单表批量修改：统一走后端单事务接口（全部成功或全部回滚）
          const p = m.proposal
          const ops = p.kind === 'batch_ops'
            ? (Array.isArray(p.ops) ? p.ops : [])
            : ((p.data && p.data.updates) || []).map((u) => ({ action: 'update', table: p.table, id: u.id, changes: u.changes }))
          // 撤销登记随批量写一起发：后端在同事务里为每条结果登记并回 undoIds，
          // 前端不再逐条二次 POST（V9-2-5）。spec 与 ops 一一对应。
          const specs = ops.map((op) => {
            const a = String(op.action || '')
            const type = a === 'doc' ? 'doc_update'
              : a === 'add' ? 'row_insert'
              : a === 'update' ? 'row_update'
              : a === 'delete' ? (op.table === 'students' ? 'student_cascade_delete' : 'row_delete')
              : 'batch'
            return { key: op.table || p.table || '', type, label: p.label, payload: {}, origin }
          })
          const res = await axios.post('/api/ai/apply-batch', { ops, _undoSpecs: specs })
          const results = (res.data && res.data.results) || []
          const backendUndoIds = (res.data && res.data.undoIds) || []
          const undoIds = []
          for (let i = 0; i < results.length; i++) {
            const uid = await ctx._pushUndoForBatch(results[i], p.label, origin, backendUndoIds[i])
            if (uid != null) undoIds.push(uid)
          }
          m.proposal.undoIds = undoIds
          m.proposal.executing = false
          m.proposal.executed = true
          notify(`${p.label} 已执行（${results.length} 项）`)
          executedLabel = `${p.label}（${results.length} 项）`
        } else if (m.proposal.kind === 'snapshot_restore') {
          // 还原到整库快照：覆盖当前全部数据（不可撤销），须老师已确认
          const p = m.proposal
          await axios.post('/api/ai/snapshot/restore', { snapshot: p.snapshot })
          m.proposal.executing = false
          m.proposal.executed = true
          notify(p.label + ' 已还原（当前数据已回到该快照）')
          executedLabel = p.label
        } else {
        const end = EXEC[m.proposal.table]
        if (!end) throw new Error('该表暂不支持 AI 写入')
        const { operation, data } = m.proposal
        // 记录本次更改对应的撤销记录 id，供下方「撤回更改」精确回退。
        // 直接绑到 proposal：逐项写入时每成功一项就登记，中途失败时已成功项也能撤回
        // （局部变量只在全部成功才赋值，部分失败会让已写入的行既没标记也没撤销 ID）。
        const undoIds = (m.proposal.undoIds = Array.isArray(m.proposal.undoIds) ? m.proposal.undoIds : [])
        // 批量新增：逐行写入（任一行失败即中断，已写入的行保留）
        if (operation === 'add' && m.proposal.batch) {
          const rows = Array.isArray(data && data.rows) ? data.rows : []
          let ok = 0
          for (const r of rows) {
            const payload = ctx.cleanPayload(r)
            const spec = { key: end.undoKey, type: 'row_insert', label: ctx._rowName(payload), payload }
            const res = await axios.post(end.url, { ...payload, _undoSpec: spec })
            const added = { id: res.data?.id ?? res.data?.row?.id, ...payload }
            if (added.id != null) {
              const uid = await ctx._pushUndo('row_insert', end.undoKey, ctx._rowName(added), { table: end.undoKey, row: added }, origin, res.data?.undoId)
              if (uid != null) undoIds.push(uid)
            }
            ok++
          }
          m.proposal.undoIds = undoIds
          m.proposal.executing = false
          m.proposal.executed = true
          notify(`${m.proposal.label} 已执行（${ok} 条）`)
          executedLabel = `${m.proposal.label}（${ok} 条）`
        } else if (operation === 'delete' && m.proposal.batch) {
          // 批量删除：逐条先取整条记录再删除，撤销时可整条恢复（任一条失败即中断）
          const ids = Array.isArray(data && data.ids) ? data.ids : []
          let ok = 0
          // 删除后记录在库里就查不到了，这里把原始行一并存下供「改动明细」展示
          const deletedRows = []
          for (const id of ids) {
            const oldRow = await ctx._fetchRow(end.undoKey, id)
            const spec = oldRow ? { key: end.undoKey, type: 'row_delete', label: ctx._rowName(oldRow), payload: { table: end.undoKey, row: oldRow } } : null
            const res = await axios.delete(`${end.url}/${id}`, { data: spec ? { _undoSpec: spec } : {} })
            if (oldRow) {
              deletedRows.push(oldRow)
              const uid = await ctx._pushUndo('row_delete', end.undoKey, ctx._rowName(oldRow), { table: end.undoKey, row: oldRow }, origin, res.data?.undoId)
              if (uid != null) undoIds.push(uid)
            }
            ok++
          }
          m.proposal.deletedRows = deletedRows
          m.proposal.undoIds = undoIds
          m.proposal.executing = false
          m.proposal.executed = true
          notify(`${m.proposal.label} 已执行（${ok} 条）`)
          executedLabel = `${m.proposal.label}（${ok} 条）`
        } else {
          if (operation === 'add') {
            const payload = ctx.cleanPayload(data)
            const spec = { key: end.undoKey, type: 'row_insert', label: ctx._rowName(payload), payload }
            const res = await axios.post(end.url, { ...payload, _undoSpec: spec })
            const added = { id: res.data?.id ?? res.data?.row?.id, ...payload }
            if (added.id != null) {
              const uid = await ctx._pushUndo('row_insert', end.undoKey, ctx._rowName(added), { table: end.undoKey, row: added }, origin, res.data?.undoId)
              if (uid != null) undoIds.push(uid)
            }
          } else if (operation === 'update') {
            // 先取旧值，再写入，撤销时可还原到旧值
            const oldRow = await ctx._fetchRow(end.undoKey, data.id)
            // 拿不到旧值就无法登记撤销：宁可中止这条修改，也不留下「改了但撤不回」的状态（B12-03）
            if (!oldRow) throw new Error(`没有找到要修改的记录（id=${data.id}），已取消该修改`)
            const changes = ctx.cleanPayload(data.changes || {})
            const newRow = { ...oldRow, ...(data.changes || {}) }
            const spec = { key: end.undoKey, type: 'row_update', label: ctx._rowName(newRow), payload: { table: end.undoKey, rowId: data.id, oldRow, newRow } }
            const res = await axios.put(`${end.url}/${data.id}`, { ...changes, _undoSpec: spec })
            const uid = await ctx._pushUndo('row_update', end.undoKey, ctx._rowName(newRow), { table: end.undoKey, rowId: data.id, oldRow, newRow }, origin, res.data?.undoId)
            if (uid != null) undoIds.push(uid)
          } else if (operation === 'delete') {
            // 先取整条记录，再删除，撤销时可整条恢复
            const oldRow = await ctx._fetchRow(end.undoKey, data.id)
            const spec = oldRow ? { key: end.undoKey, type: 'row_delete', label: ctx._rowName(oldRow), payload: { table: end.undoKey, row: oldRow } } : null
            const res = await axios.delete(`${end.url}/${data.id}`, { data: spec ? { _undoSpec: spec } : {} })
            m.proposal.deletedRows = oldRow ? [oldRow] : []
            if (oldRow) {
              const uid = await ctx._pushUndo('row_delete', end.undoKey, ctx._rowName(oldRow), { table: end.undoKey, row: oldRow }, origin, res.data?.undoId)
              if (uid != null) undoIds.push(uid)
            }
          } else {
            throw new Error('未知操作')
          }
          m.proposal.undoIds = undoIds
          m.proposal.executing = false
          m.proposal.executed = true
          notify(m.proposal.label + ' 已执行')
          executedLabel = m.proposal.label
        }
        }
      } catch (err) {
        // 失败也把结果发回给 AI 继续处理：关闭浮窗、上报失败原因，不在此结束对话
        m.proposal.executing = false
        // 逐项写入中途失败时，已成功项的撤销 ID 已累积在 proposal.undoIds 上：
        // 保留 executed=true + 标 partial，让「撤回更改」能精确撤掉已落盘的部分，
        // 否则这部分数据既没执行标记又没撤销入口 = 永久残留（#17）。
        const partial = Array.isArray(m.proposal.undoIds) && m.proposal.undoIds.length > 0
        m.proposal.executed = partial
        m.proposal.partial = partial
        m.proposal.dismissed = !partial
        const msg = err.response?.data?.error || err.message || '未知错误'
        notifyError('执行失败：' + msg)
        await ctx._sendFeedback(
          `执行失败：${m.proposal.label}（原因：${msg}），请分析后告诉我怎么处理。`,
          `执行失败：${m.proposal.label}（原因：${msg}）`,
          m
        )
        return
      }
      // 无论成功或失败都接着发起下一轮：把结果写入思维链并作为用户消息发回，让 AI 继续，工具不结束对话
      // 明确告诉模型「该项已落盘」：提案轮的助手正文与工具调用不会进入后续上下文，
      // 若不点明已完成，模型会因看不到自己的提案记录而反复重复生成同一提案（尤其新建技能后再被报「已存在」）
      await ctx._sendFeedback(
        `已执行：${executedLabel}。（该项已由系统成功完成并落盘。请勿重复调用同一写入/提案工具，也不要重复生成同一提案；如无其它事项，用一两句话简短确认即可。）`,
        `已执行：${executedLabel}`,
        m
      )
    },
    // 读取一项前端设置的当前值（与 _setFrontSetting 的 value 类型一致）
    // 读一项前端设置：统一从主题 store 取（与界面同源），不再裸读 localStorage ——
    // 裸键与 store 双真相会漂移（键名/默认值/写入路径任一变化都会让 AI 回读到假值）。
    // 不透明度两项不能用 `parseFloat(x) || 默认值`：0 是合法取值（滑到底 = 完全透明），
    // 会被 `||` 判成"没设置"。AI 回读设置值时必须与 store 的读数口径一致。
    _readFrontSetting(key) {
      const store = useThemeStore()
      switch (key) {
        case 'theme': return store.currentTheme || 'glass'
        case 'mode': return store.pendingMode === 'night' ? 'night' : 'day'
        case 'iconStyle': return store.iconStyle || 'color'
        case 'topbarColor': return store.topbarColor || 'light'
        case 'animations': return !!store.animationsEnabled
        // store 的不透明度本身就是 number（0 是合法值），直接透传即可
        case 'bgMaskOpacity': return store.bgMaskOpacity
        case 'glassOpacity': return store.glassOpacity
        // 无 store 的独立偏好：localStorage 即唯一真相，不存在双源
        case 'mergeNotifications': return (localStorage.getItem('mergeNotifications') ?? '1') !== '0'
        default: return null
      }
    },
    // 经主题 store 应用一项前端设置（立即生效并写 localStorage；mergeNotifications 无 store，直接写 localStorage）
    _setFrontSetting(store, key, value) {
      switch (key) {
        case 'theme': store.setTheme(String(value)); break
        case 'mode': store.setMode(value === 'night' ? 'night' : 'day'); break
        case 'iconStyle': store.setIconStyle(String(value)); break
        case 'topbarColor': store.setTopbarColor(String(value)); break
        case 'animations': store.setAnimationsEnabled(!!value); break
        case 'bgMaskOpacity': {
          // 直接 Number(value) 会把 'abc' 变成 NaN：CSS 变量写成 NaN 后透明度设置失效，
          // 且 NaN 会被 localStorage 持久化，下次启动只能靠 readNum 兜底。先校验再设。
          const n = Number(value)
          if (Number.isFinite(n)) store.setBgMaskOpacity(n)
          break
        }
        case 'glassOpacity': {
          const n = Number(value)
          if (Number.isFinite(n)) store.setGlassOpacity(n)
          break
        }
        case 'mergeNotifications': localStorage.setItem('mergeNotifications', value ? '1' : '0'); break
      }
    },
    // 登记一条撤销记录，返回其 id（撤回按钮据此精确回退这次更改）
    // origin：AI 提案执行时传入的批次标识（供 AI 的 undo_change 工具整批回退）；手动编辑不传
    async _pushUndo(type, key, label, payload, origin, registeredUndoId) {
      // 原先 try/catch 静默返回 null：AI 改完数据却没进撤销栈，用户完全不知道。
      // 统一入口负责失败弱提示 + 刷新可用态；这里仍按原语义返回 null，
      // 调用方据此放弃该条的精确撤回能力（不会误以为撤得回来）。
      // registeredUndoId：后端已在写请求里同事务登记时传入，跳过二次 POST。
      return recordUndoSpec({ key, type, label, payload, origin, refresh: true }, registeredUndoId)
    },
    // 批量事务返回的单项结果 → 登记一条撤销记录（供撤回按钮逐条回退）
    // r：{ action:'add'|'update'|'delete'|'doc', table, id, row, before, after }
    async _pushUndoForBatch(r, label, origin, registeredUndoId) {
      if (!r || !r.action) return null
      if (r.action === 'add') {
        return ctx._pushUndo('row_insert', r.table, ctx._rowName(r.row), { table: r.table, row: r.row }, origin, registeredUndoId)
      }
      if (r.action === 'update') {
        const row = r.after || r.before || {}
        return ctx._pushUndo('row_update', r.table, ctx._rowName(row), { table: r.table, rowId: r.id, oldRow: r.before, newRow: r.after }, origin, registeredUndoId)
      }
      if (r.action === 'delete') {
        // 删学生连带清了 7 处松耦合关联（请假/加分/座位/值日/小组/班干部）。
        // 后端把 purge 的快照随结果返回（purged + undoType），这里必须登记
        // student_cascade_delete 整包撤销；否则沿用 row_delete 只恢复主表，
        // 6 类关联永久丢失。普通表删除仍走 row_delete，语义不变。
        if (r.undoType === 'student_cascade_delete' && r.purged) {
          return ctx._pushUndo('student_cascade_delete', r.table, ctx._rowName(r.row), {
            student: r.row,
            ...r.purged,
          }, origin, registeredUndoId)
        }
        return ctx._pushUndo('row_delete', r.table, ctx._rowName(r.row), { table: r.table, row: r.row }, origin, registeredUndoId)
      }
      if (r.action === 'doc') {
        return ctx._pushUndo('doc_update', DOC_UNDO_KEY[r.table] || r.table, label, { table: r.table, id: r.id, before: r.before, after: r.after, label }, origin, registeredUndoId)
      }
      return null
    },
    // 读取某条记录的完整字段（记录编辑/删除前的旧值，供撤回还原）
    async _fetchRow(table, id) {
      try {
        const { data } = await axios.get(`/api/ai/records/${table}?ids=${id}`)
        return (data && data.data && data.data.rows && data.data.rows[0]) || null
      } catch (_) { return null }
    },
    // 撤销记录展示用名称（与全局撤销保持一致的取名规则）
    _rowName(row) {
      if (!row) return ''
      return row.姓名 || row.group_name || row.主题 || row.名称 || row.name || (row.id != null ? `#${row.id}` : '')
    },
    // 仅保留合法的业务字段，剔除内部列（id/position/created_at 等）
    cleanPayload(obj) {
      const drop = new Set(['id', 'position', 'created_at', 'student_id', 'group_id', 'dimension_id'])
      const out = {}
      for (const k of Object.keys(obj || {})) {
        if (!drop.has(k)) out[k] = obj[k]
      }
      return out
    },
  }
}
