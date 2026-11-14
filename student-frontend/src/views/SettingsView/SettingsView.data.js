// ===== 设置页：学期设置、撤销记录、弹窗/消息、账号与数据库导出 =====
// 纯代码搬运自 SettingsView.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
import { getCurrentUser, setCurrentUser, clearAuth } from '../../utils/authStorage.js'
import { reportError } from '../../utils/reportError.js'
import axios from 'axios'
import { listUndo, undoById, redoById, undoBatch, redoBatch, clearUndo } from '../../api/undo'
import { pad2 } from '../../utils/dateTime.js'
import { invalidateSemesterStart } from '../../utils/semesterStart.js'
import { clearMediaToken } from '../../utils/apiUrl'
import { AUTH_API } from '../../utils/apiPaths.js'
import { friendlyError } from '../../utils/blobError.js'
// 删班 = 换库，与切班走同一条收尾：清模块级缓存 + 作废 KeepAlive 里的视图实例。
import { resetUserScopedCaches } from '../../utils/userScopedCache.js'
import { bumpClassScope } from '../../utils/classScope.js'
import { useNotification } from '../../composables/useNotification.js'

// 这里不再自己读 Blob：响应错误拦截器（utils/blobError.js）已把失败体还原成对象，
// 统一从 friendlyError 取文案，避免每个 blob 调用点各写一份解析。

// 把同一次动作的多条记录折成一行：同 origin、同方向的连续记录算「一次改动（N 项）」，
// 无 origin 的单条记录仍是一行。这样设置页与 Ctrl+Z 的口径一致：一次动作 = 一步。
function foldUndoEntries(records) {
  const entries = []
  for (const rec of records || []) {
    const last = entries[entries.length - 1]
    if (rec.origin && last && last.origin === rec.origin && last.dir === rec.dir) {
      last.ids.push(rec.id)
      last.count += 1
      continue
    }
    entries.push({
      key: rec.origin ? `o-${rec.origin}-${rec.dir}` : `r-${rec.id}`,
      origin: rec.origin || '',
      ids: [rec.id],
      ts: rec.ts,
      dir: rec.dir,
      label: rec.label,
      count: 1
    })
  }
  // 多条时统一文案：逐格 label 拼起来太长，只给条数
  return entries.map(e => (e.count > 1 ? { ...e, label: `一次改动（${e.count} 项）` } : e))
}

export function useSettingsData(ctx) {
  return {
    // ==================== 学期设置 ====================
    // 载入学期列表：默认选中当前学期（播种/新增学期时后端会把最新学期标为当前）
    async loadSemesterSettings() {
      try {
        const { data } = await axios.get('/api/schedule/semesters')
        ctx.semesters.value = data.semesters || []
        const cur = data.current || ctx.semesters.value[0] || null
        ctx.semesterId.value = cur ? cur.id : null
        ctx.semesterStart.value = cur ? (cur.start_date || '') : ''
        ctx.semesterEnd.value = cur ? (cur.end_date || '') : ''
        ctx.semesterDateErrorText.value = ''
      } catch (_) { /* 后端未就绪时静默忽略 */ }
    },
    // 选择学期：同时切换为当前学期（课程表、座位补存范围、座位指数结算都按它走）
    async onSelectSemester(id) {
      const target = ctx.semesters.value.find(s => s.id === id)
      if (!target) return
      ctx.semesterId.value = id
      ctx.semesterStart.value = target.start_date || ''
      ctx.semesterEnd.value = target.end_date || ''
      // 换学期等于换了一组日期，之前那个学期的未保存改动不再有意义
      ctx.semesterDateErrorText.value = ''
      try {
        await axios.put('/api/schedule/semesters/current', { id })
        // 换学期 = 换开学日：值日/座位那边缓存的 semester_start 必须失效
        invalidateSemesterStart()
      } catch (err) {
        reportError(err, { action: '切换学期' })
      }
    },
    // 增加学期：先弹小窗输入学期名（必填），起止日期留空由后端按当前月份推算默认值
    openAddSemester() {
      ctx.newSemesterName.value = ''
      ctx.showAddSemester.value = true
    },
    async confirmAddSemester() {
      const name = (ctx.newSemesterName.value || '').trim()
      if (!name) {
        ctx.notifyError('请输入学期名')
        return
      }
      if (ctx.busySemester.value) return
      ctx.busySemester.value = true
      try {
        const res = await axios.post('/api/schedule/semesters', { name })
        // 新增学期会被后端标为「当前学期」，即 semester_start 变了 → 缓存必须失效
        invalidateSemesterStart()
        ctx.showAddSemester.value = false
        await ctx.loadSemesterSettings()
        ctx.notifySuccess(`已增加学期：${res.data.name}`)
      } catch (err) {
        reportError(err, { action: '增加学期' })
      } finally {
        ctx.busySemester.value = false
      }
    },
    openRenameSemester() {
      const cur = ctx.activeSemester.value
      if (!cur) return
      ctx.semesterNameDraft.value = cur.name || ''
      ctx.showRenameSemester.value = true
    },
    async saveSemesterName() {
      const id = ctx.semesterId.value
      const name = (ctx.semesterNameDraft.value || '').trim()
      if (!id || !name) return
      try {
        await axios.put(`/api/schedule/semesters/${id}`, { name })
        invalidateSemesterStart()
        ctx.showRenameSemester.value = false
        await ctx.loadSemesterSettings()
        ctx.notifySuccess('学期名已修改')
      } catch (err) {
        reportError(err, { action: '修改学期名' })
      }
    },
    // 学期起止日期：改完点「保存」才写入。
    // 原来用 @change 即时保存，但那样改一半就会写库 —— 典型场景是先把开始日期往后挪，
    // 此时结束日期还停在原处，区间瞬间变成「结束 < 开始」，把非法值存进去。
    // 即时保存还完全静默：成功零反馈、失败只弹 alert，用户无法确认到底存上没有。
    async saveSemesterSettings() {
      if (!ctx.semesterId.value) return
      if (ctx.busySemesterDate.value) return
      // 先校验，不通过就不发请求（后端也拦一道，见 schedule.js 的 validateSemesterRange）
      const err = ctx.semesterDateError.value
      if (err) {
        ctx.semesterDateErrorText.value = err
        ctx.notifyError(err)
        return
      }
      ctx.semesterDateErrorText.value = ''
      ctx.busySemesterDate.value = true
      try {
        await axios.put(`/api/schedule/semesters/${ctx.semesterId.value}`, {
          start_date: ctx.semesterStart.value,
          end_date: ctx.semesterEnd.value,
        })
        invalidateSemesterStart()
        // 同步本地列表里的这一条：否则 semesterDatesDirty 仍会认为「有未保存的改动」，
        // 保存按钮一直可点，用户会以为没存上而反复点。
        const row = ctx.semesters.value.find(s => s.id === ctx.semesterId.value)
        if (row) {
          row.start_date = ctx.semesterStart.value
          row.end_date = ctx.semesterEnd.value
        }
        ctx.notifySuccess('学期起止日期已保存')
      } catch (err) {
        ctx.semesterDateErrorText.value = err.response?.data?.error || '学期设置保存失败'
        ctx.notifyError(ctx.semesterDateErrorText.value)
      } finally {
        ctx.busySemesterDate.value = false
      }
    },
    // 删除学期：先弹确认框，确认后调 DELETE；删的是当前学期时后端会自动把剩下的设为当前
    requestDeleteSemester() {
      if (!ctx.semesterId.value) return
      ctx.showDeleteSemester.value = true
    },
    async confirmDeleteSemester() {
      const id = ctx.semesterId.value
      ctx.showDeleteSemester.value = false
      if (!id || ctx.busySemester.value) return
      ctx.busySemester.value = true
      try {
        await axios.delete(`/api/schedule/semesters/${id}`)
        invalidateSemesterStart()
        await ctx.loadSemesterSettings()
        ctx.notifySuccess('学期已删除')
      } catch (err) {
        reportError(err, { action: '删除学期' })
      } finally {
        ctx.busySemester.value = false
      }
    },
    // ==================== 撤销记录 ====================
    async loadUndo() {
      try {
        const { data } = await listUndo()
        ctx.undoGroups.value = (data.groups || []).map(g => ({ ...g, entries: foldUndoEntries(g.records) }))
      } catch { }
    },
    // 设置页的撤销/重做按钮：批次走 /origin/:origin/*（整批），单条走 /:id/*
    async undoEntry(entry) {
      if (ctx.busyUndo.value || !entry) return
      ctx.busyUndo.value = true
      try {
        const { data } = entry.origin
          ? await undoBatch(entry.origin)
          : await undoById(entry.ids[0])
        if (data.ok) ctx.showAlert(data.label ? `已撤销：${data.label}` : '已成功撤销')
      } catch (err) {
        ctx.showAlert(err.response?.data?.error || '撤销失败，可能目标数据已被删除')
      } finally {
        ctx.busyUndo.value = false
        await ctx.loadUndo()
      }
    },
    async redoEntry(entry) {
      if (ctx.busyUndo.value || !entry) return
      ctx.busyUndo.value = true
      try {
        const { data } = entry.origin
          ? await redoBatch(entry.origin)
          : await redoById(entry.ids[0])
        if (data.ok) ctx.showAlert(data.label ? `已重做：${data.label}` : '已成功重做')
      } catch (err) {
        ctx.showAlert(err.response?.data?.error || '重做失败')
      } finally {
        ctx.busyUndo.value = false
        await ctx.loadUndo()
      }
    },
    clearUndo() {
      if (ctx.busyUndo.value) return
      ctx.showConfirm('确定清空所有撤销记录吗？此操作不可恢复。', async () => {
        ctx.busyUndo.value = true
        try {
          await clearUndo('all')
        } finally {
          ctx.busyUndo.value = false
          await ctx.loadUndo()
        }
      })
    },
    groupLabel(key) {
      return ctx._undoKeyLabels.value[key] || key
    },
    // 口径是「步」而不是「条」：一次动作（批次）只算一步，与 Ctrl+Z 一致
    undoableCount(group) {
      return (group.entries || []).filter(e => e.dir === 1).length
    },
    fmtTs(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    },
    // Account
    openModal(type) {
      ctx.modalType.value = type
      ctx.newUsername.value = ''
      ctx.usernamePassword.value = ''
      ctx.oldPassword.value = ''
      ctx.newPassword.value = ''
      ctx.confirmPassword.value = ''
      ctx.pwdError.value = ''
      ctx.busyPwd.value = false
      ctx.usernameError.value = ''
      ctx.busyUsername.value = false
      ctx.exportPassword.value = ''
      ctx.exportEncrypt.value = ctx.dbEncrypted.value
      ctx.exportDbPwd.value = ''
    },
    closeModal() {
      ctx.modalType.value = ''
    },
    showAlert(msg) {
      ctx.dialog.value = { visible: true, message: msg, type: 'alert', showCancel: false }
    },
    showConfirm(msg, onConfirm, confirmText) {
      ctx.dialog.value = { visible: true, message: msg, type: 'confirm', showCancel: true, confirmText }
      ctx.dialogCallback.value = onConfirm
    },
    onDialogConfirm() {
      ctx.clearDeleteTimer()
      ctx.dialog.value.visible = false
      if (ctx.dialogCallback.value) {
        ctx.dialogCallback.value()
        ctx.dialogCallback.value = null
      }
    },
    // 取消/关闭弹窗：一并停掉倒计时定时器
    onDialogCancel() {
      ctx.clearDeleteTimer()
      ctx.dialog.value.visible = false
    },
    clearDeleteTimer() {
      if (ctx.deleteTimer) {
        clearInterval(ctx.deleteTimer)
        ctx.deleteTimer = null
      }
    },
    async changeUsername() {
      if (ctx.busyUsername.value) return
      ctx.usernameError.value = ''
      const name = String(ctx.newUsername.value || '').trim()
      if (!name) { ctx.usernameError.value = '请输入新用户名'; return }
      if (name === ctx.user.value.username) { ctx.usernameError.value = '新用户名和当前用户名相同'; return }
      // 明文 / 无密码两档没有登录密码（切等级时后端已把 users.password 置空），
      // 后端 PUT /username 对免密账号本就跳过校验，前端不能在这里无条件拦住。
      if (ctx.hasLoginPassword.value && !ctx.usernamePassword.value) { ctx.usernameError.value = '请输入当前密码'; return }
      ctx.busyUsername.value = true
      try {
        const res = await axios.put('/api/account/username', {
          newUsername: name,
          // 无密码等级下密码框不出现，传空串即可（后端见 password 为空直接跳过校验）
          password: ctx.hasLoginPassword.value ? ctx.usernamePassword.value : '',
        })
        const currentUser = getCurrentUser() || {}
        currentUser.username = name
        setCurrentUser(currentUser)
        ctx.closeModal()
        ctx.showAlert(res.data.message)
      } catch (err) {
        // 与修改密码一致：服务端错误就地显示，别用 alert 把输入清空
        ctx.usernameError.value = err.response?.data?.error || '修改失败，请稍后重试'
      } finally {
        ctx.busyUsername.value = false
      }
    },
    async changePassword() {
      if (ctx.busyPwd.value) return
      ctx.pwdError.value = ''
      const oldPwd = ctx.oldPassword.value
      const newPwd = ctx.newPassword.value
      // 这几条后端都拦不住（PUT /account/password 原来只校验「新密码非空」），必须前端先挡：
      // 长度、两次是否一致、是否与原密码相同。少任何一条，用户都可能把密码设成自己都打不出来的东西。
      if (!newPwd) { ctx.pwdError.value = '请输入新密码'; return }
      if (String(newPwd).length < 6) { ctx.pwdError.value = '新密码长度至少 6 位'; return }
      if (newPwd !== ctx.confirmPassword.value) { ctx.pwdError.value = '两次输入的新密码不一致'; return }
      if (oldPwd && newPwd === oldPwd) { ctx.pwdError.value = '新密码不能和原密码相同'; return }
      ctx.busyPwd.value = true
      try {
        const res = await axios.put('/api/account/password', {
          oldPassword: oldPwd,
          newPassword: newPwd,
        })
        ctx.closeModal()
        ctx.showAlert(res.data.message)
      } catch (err) {
        // 服务端错误（如「原密码错误」）就地显示在弹窗内：用 alert 会连带清空已输入的三个框，
        // 用户得从头再填一遍，而这里本来就是最容易再错一次的地方。
        ctx.pwdError.value = err.response?.data?.error || '修改失败，请稍后重试'
      } finally {
        ctx.busyPwd.value = false
      }
    },
    confirmLogout() {
      ctx.showConfirm('确认退出登录？', async () => {
        // 通知后端吊销本次会话：原 token 立即失效（先发请求再清本地，token 已清会 401）
        try { await axios.post(AUTH_API.logout) } catch (_) {}
        clearAuth()
        clearMediaToken()
        ctx.router.push('/login')
      }, '确认')
    },
    // 打开「删除账号」警告弹窗：确定按钮先置灰，10 秒倒计时结束后才可点击
    openDeleteAccount() {
      ctx.clearDeleteTimer()
      ctx.dialog.value = {
        visible: true,
        title: '警告',
        message: '删除账号后无法恢复，请谨慎决定',
        type: 'confirm',
        showCancel: true,
        confirmText: '确定(10)',
        confirmDisabled: true,
      }
      ctx.dialogCallback.value = () => ctx.performDeleteAccount()
      let remain = 10
      ctx.deleteTimer = setInterval(() => {
        remain -= 1
        if (remain <= 0) {
          ctx.clearDeleteTimer()
          ctx.dialog.value.confirmText = '确定'
          ctx.dialog.value.confirmDisabled = false
        } else {
          ctx.dialog.value.confirmText = `确定(${remain})`
        }
      }, 1000)
    },
    // 真正删除当前账号：删除后清除本地登录态并回到登录页
    async performDeleteAccount() {
      try {
        await axios.delete('/api/account')
        clearAuth()
        clearMediaToken()
        ctx.router.push('/login')
      } catch (err) {
        ctx.showAlert(err.response?.data?.error || '删除失败')
      }
    },
    // 班级列表 + 当前班。账号信息区的「当前班级」和危险区的「删除该班级」
    // 共用这一次请求（两者都只关心「有几个班、现在在哪个」）。
    async loadClasses() {
      try {
        const r = await axios.get('/api/account/classes')
        const list = r.data?.classes || []
        ctx.classList.value = list
        ctx.currentSlug.value = r.data?.current || ''
        ctx.classCount.value = list.length
      } catch (_) {
        // 拉不到就按「没有班级信息」处理：危险区不显示删班入口，账号区显示 —
        ctx.classList.value = []
        ctx.currentSlug.value = ''
        ctx.classCount.value = 0
      }
    },
    // 打开班级弹窗：与首页齿轮打开的是同一个组件。先拉数据再显示 ——
    // ClassInfoDialog 只在 visible false→true 时初始化表单，先开再填会得到一个空表单。
    async openClassDialog() {
      await Promise.all([ctx.loadClasses(), ctx.loadClassInfo()])
      ctx.classDialogVisible.value = true
    },
    // 弹窗里的班名/口号/班风/学风
    async loadClassInfo() {
      try {
        const r = await axios.get('/api/widget-settings/class-info')
        const d = r.data?.data
        if (d) {
          ctx.classInfo.value = {
            name: d.name ?? '',
            motto: d.motto ?? '',
            mottoStyle: d.mottoStyle ?? '',
            xuefeng: d.xuefeng ?? '',
          }
        }
      } catch (_) {
        // 拉不到就让弹窗显示空表单，用户填写后保存即可
      }
    },
    // 保存班级信息（班名/口号/班风/学风）
    async saveClassInfoFromSettings(data) {
      try {
        await axios.put('/api/widget-settings/class-info', data || {})
        ctx.classInfo.value = { ...(data || {}) }
        ctx.classDialogVisible.value = false
        // 班名可能改了，账号信息区那行要跟着更新
        await ctx.loadClasses()
        useNotification().success('班级信息保存成功')
      } catch (err) {
        ctx.showAlert(err.response?.data?.error || '班级信息保存失败，请重试')
      }
    },
    // 设置页的弹窗只做切换，没有「保存」按钮 —— 铅笔改的名字必须当场落库，否则一关就丢。
    // 先读一次完整的 class-info 再写回：PUT 是整对象覆盖，只发 name 会把口号/班风/学风抹掉。
    async renameClassFromSettings(name) {
      const clean = String(name || '').trim().slice(0, 50)
      if (!clean || clean === ctx.currentClassName.value) return
      try {
        const cur = await axios.get('/api/widget-settings/class-info')
        const d = cur.data?.data || {}
        await axios.put('/api/widget-settings/class-info', { ...d, name: clean })
        ctx.classInfo.value = { ...d, name: clean }
        // 下拉里的班名来自 classes 列表，改完要重新拉一次才显示新名
        await ctx.loadClasses()
        useNotification().success('班级名称已更新')
      } catch (err) {
        // 重名由后端 409 兜底（前端已在弹窗里拦过一轮，这里是绕过前端时的最后一道）
        ctx.showAlert(err.response?.data?.error || '班级重命名失败，请重试')
      }
    },
    // 新建班级：建完直接切进去，与首页同一条路径
    async createClassFromSettings(className) {
      if (!className || ctx.switchingClass.value) return
      ctx.switchingClass.value = true
      try {
        const r = await axios.post('/api/account/class', { className })
        const slug = r.data?.slug
        if (!slug) throw new Error('后端未返回班级标识')
        await axios.post('/api/account/switch-class', { slug })
        // 与 switchClassFromSettings 同理：不关弹窗，让它跟着重建原地恢复，
        // 建完班就能接着在同一个弹窗里改名/继续切。
        resetUserScopedCaches()
        bumpClassScope()
      } catch (err) {
        ctx.switchingClass.value = false
        ctx.showAlert(err.response?.data?.error || '新建班级失败，请重试')
      }
    },
    // 设置页里切班。与首页的 applyClassSwitch 是同一条收尾，顺序不能反：
    // 先清模块级缓存并让在途响应作废，再作废 KeepAlive 里的视图实例。
    // 新 token 由后端随 X-Renewed-Token 下发，响应拦截器自动落盘。
    async switchClassFromSettings(slug) {
      if (!slug || slug === ctx.currentSlug.value || ctx.switchingClass.value) return
      ctx.switchingClass.value = true
      try {
        await axios.post('/api/account/switch-class', { slug })
        // 这里刻意**不关**弹窗：切班要重建整个视图（见 classScope.js），
        // 关掉会写回 settingsClassDialogOpen=false，重建后就不再恢复，
        // 用户每切一个班就被弹出一次。留着开，新实例挂载时原地恢复。
        resetUserScopedCaches()
        bumpClassScope()
      } catch (err) {
        ctx.switchingClass.value = false
        ctx.showAlert(err.response?.data?.error || '切换班级失败，请重试')
      }
    },
    // 打开「删除该班级」警告弹窗：与删账号同一套 10 秒倒计时（删除不可恢复，
    // 倒计时挡的是手滑连点）。先拉一次班级列表，因为「只有一个班」必须当场拦住 ——
    // 否则用户盯着倒计时数满 10 秒，点下去才被告知不能删。
    async openDeleteClass() {
      let classes = []
      let current = ''
      try {
        const r = await axios.get('/api/account/classes')
        classes = r.data?.classes || []
        current = r.data?.current || ''
      } catch (_) {
        ctx.showAlert('读取班级列表失败，请稍后再试')
        return
      }
      if (classes.length <= 1) {
        ctx.showAlert('这是你唯一的班级。删除后就没有可用数据了；如需销毁全部数据，请使用「删除账号」。')
        return
      }
      const name = classes.find((c) => c.slug === current)?.className || '当前班级'

      ctx.clearDeleteTimer()
      ctx.dialog.value = {
        visible: true,
        title: '删除该班级',
        message: `将删除「${name}」及其全部数据（学生、成绩、班费、相册……），不可恢复。其它班级不受影响。`,
        type: 'confirm',
        showCancel: true,
        confirmText: '确定(10)',
        confirmDisabled: true,
      }
      ctx.dialogCallback.value = () => ctx.performDeleteClass()
      let remain = 10
      ctx.deleteTimer = setInterval(() => {
        remain -= 1
        if (remain <= 0) {
          ctx.clearDeleteTimer()
          ctx.dialog.value.confirmText = '确定'
          ctx.dialog.value.confirmDisabled = false
        } else {
          ctx.dialog.value.confirmText = `确定(${remain})`
        }
      }, 1000)
    },
    // 删除当前班级。后端会把会话切到剩下的那个班并换发 token
    // （随 X-Renewed-Token 下发，响应拦截器自动落盘），所以这里不用自己处理凭据。
    async performDeleteClass() {
      try {
        const r = await axios.delete('/api/account/class')
        // 换库了，与切班同一条路径：先清模块缓存并让在途响应作废，再作废缓存的视图实例。
        // 顺序不能反（见 views/DashboardView.vue 的 applyClassSwitch 注释）。
        resetUserScopedCaches()
        bumpClassScope()
        const target = (r.data?.classes || []).find((c) => c.slug === r.data?.current)
        // 提示放在清理之后：resetUserScopedCaches 会清空通知列表
        useNotification().success(`班级已删除，已切换到「${target?.className || '剩余班级'}」`)
      } catch (err) {
        ctx.showAlert(err.response?.data?.error || '删除失败')
      }
    },
    async exportDb() {
      // 是否有登录密码：以安全等级为准（securityLevel），不用 localStorage 里的 user 快照 ——
      // 本次会话里刚把等级从「普通密码」切成「免密」时那份快照是旧的，
      // 会出现「界面没让我填密码、这里却拦着要密码」的死结。
      // 无密码账号后端本来就不校验密码（account.js 只在 user.password 存在时才比对）。
      const needsPassword = !!ctx.hasLoginPassword.value
      const loginPwd = ctx.exportPassword.value
      // 有密码账号：必须先校验登录密码
      if (needsPassword && !loginPwd) {
        ctx.showAlert('请输入登录密码以导出数据库')
        return
      }
      // 勾选加密（仅加密库有意义）：无密码账号必须提供一个导出密码（否则没有口令可供包裹库钥匙）
      if (ctx.dbEncrypted.value && ctx.exportEncrypt.value && !needsPassword && !ctx.exportDbPwd.value) {
        ctx.showAlert('该账号未设置密码，请设置一个导出密码以加密备份')
        return
      }
      ctx.busyExport.value = true
      ctx.exportProgress.value = 0
      try {
        const body = { encrypt: ctx.exportEncrypt.value ? '1' : '0' }
        if (needsPassword) body.password = loginPwd
        if (ctx.dbEncrypted.value && ctx.exportEncrypt.value && ctx.exportDbPwd.value) body.dbPassword = ctx.exportDbPwd.value
        // v3：整包 ZIP 流式下载（库 + 收据原件 + AI 技能 + 回收站 + 快照 + 清单）。
        // responseType: 'blob' 让 axios 不要把二进制当文本解 —— 否则中文文件名与 CRC 全毁。
        const res = await axios.post('/api/account/export-zip', body, {
          responseType: 'blob',
          onDownloadProgress: (e) => { ctx.exportProgress.value = e.loaded || 0 },
        })
        const date = new Date().toISOString().slice(0, 10)
        // 用户名可能含空格/斜杠等，直接当文件名会被浏览器改得很难认，先归一
        const who = String(ctx.user.value.username || 'classnest').replace(/[\\/:*?"<>|]/g, '_')
        const url = URL.createObjectURL(res.data)
        const a = document.createElement('a')
        a.href = url
        a.download = `${who}-备份-${date}.zip`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // ⚠️ 必须延迟撤销：浏览器下载是**异步**读取 blob 的，
        // 同步 revokeObjectURL 会让下载拿到 0 字节文件。
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        ctx.closeModal()
        ctx.showAlert('导出成功。备份包内含收据原件等文件，请妥善保管；加密导出时所用的数据库密码不在包内，请一并记住')
      } catch (err) {
        ctx.showAlert(friendlyError(err, '导出失败'))
      } finally {
        ctx.busyExport.value = false
        ctx.exportProgress.value = 0
      }
    },
  }
}
