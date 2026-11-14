// ===== 设置页：外观主题、小组件/会话/USB、数据目录与加密、性能与重启 =====
// 纯代码搬运自 SettingsView.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
import axios from 'axios'
import { useNotification } from '../../composables/useNotification'
import { SEND, INVOKE } from '../../electronChannels.js'
import { readFastStartup, writeFastStartup } from '../../utils/fastStartup.js'
import { getToken } from '../../utils/authStorage.js'

export function useSettingsAppearance(ctx) {
  return {
    // Theme
    onThemeSelect() {
      ctx.themeStore.setTheme(ctx.selectedThemeId.value)
    },
    // 提示合并（立即生效，无需保存）
    onMergeNotificationsChange(value) {
      ctx.mergeNotifications.value = !!value
      localStorage.setItem('mergeNotifications', ctx.mergeNotifications.value ? '1' : '0')
    },
    // 图标样式：线性图标 / Emoji
    onIconStyleChange() {
      ctx.themeStore.setIconStyle(ctx.iconStyle.value)
    },
    // 顶栏/侧边栏毛玻璃配色：深蓝 / 白色调（立即生效）
    onTopbarColorChange() {
      ctx.themeStore.setTopbarColor(ctx.topbarColor.value)
    },
    // 日夜模式（仅支持夜间配色的主题）：手动切换即视为放弃「跟随系统」
    onSelectMode(value) {
      ctx.themeStore.setMode(value)
    },
    // 跟随系统开关：立即生效，开启时按系统深色/浅色偏好切换
    onFollowSystemChange(value) {
      ctx.themeStore.setFollowSystem(!!value)
    },
    // 动画效果总开关：立即生效，无需保存
    onAnimationsChange(value) {
      ctx.themeStore.setAnimationsEnabled(!!value)
    },
    // Background image
    async onBgImageFileChange(e) {
      const file = e.target.files[0]
      if (!file) return
      ctx.bgImageFileName.value = file.name

      // 检查是否在 Electron 环境中，且文件大于 2MB，使用后端存储
      if (window.electron && window.electron.invoke && file.size > 2 * 1024 * 1024) {
        // 读取文件为 base64 后传给主进程保存
        const reader = new FileReader()
        reader.onload = async (ev) => {
          try {
            const base64Data = ev.target.result.split(',')[1] // 去掉 data:image/...;base64, 前缀
            const result = await window.electron.invoke(INVOKE.SAVE_BACKGROUND_IMAGE, {
              name: file.name,
              base64: base64Data
            })
            if (result.success && result.url) {
              ctx.bgImageUrl.value = result.url
              ctx.themeStore.setBackgroundImage(result.url)
            } else {
              ctx.showAlert(result.error || '保存图片失败')
            }
          } catch (err) {
            console.error('保存图片失败:', err)
            ctx.showAlert('保存图片失败: ' + (err?.message || '未知错误'))
          }
        }
        // 读盘失败/取消时补上反馈，否则界面停在「已选择文件」却什么都没发生
        reader.onerror = () => {
          console.error('读取背景图片失败:', reader.error)
          ctx.showAlert('读取图片失败，请重试')
        }
        reader.onabort = () => ctx.showAlert('已取消读取图片')
        reader.readAsDataURL(file)
      } else {
        // 小图片或非 Electron 环境，使用 base64
        if (file.size > 2 * 1024 * 1024) {
          ctx.showAlert('图片过大，请选择 2MB 以下的图片')
          return
        }
        const reader = new FileReader()
        reader.onload = (ev) => {
          ctx.bgImageUrl.value = ev.target.result
          ctx.themeStore.setBackgroundImage(ev.target.result)
        }
        reader.onerror = () => {
          console.error('读取背景图片失败:', reader.error)
          ctx.showAlert('读取图片失败，请重试')
        }
        reader.onabort = () => ctx.showAlert('已取消读取图片')
        reader.readAsDataURL(file)
      }
    },
    clearBgImage() {
      ctx.bgImageUrl.value = ''
      ctx.bgImageFileName.value = ''
      ctx.themeStore.setBackgroundImage('')
      if (ctx.bgImageInput.value) ctx.bgImageInput.value.value = ''
    },
    onBgMaskOpacityChange(e) {
      ctx.themeStore.setBgMaskOpacity(parseFloat(e.target.value))
    },
    onGlassOpacityChange(e) {
      ctx.themeStore.setGlassOpacity(parseFloat(e.target.value))
    },
    // ==================== 工具箱设置 ====================
    async loadWidgetSettings() {
      try {
        const res = await axios.get('/api/widget-settings')
        if (res.data.success) {
          ctx.toolboxEnabled.value = res.data.data.toolboxEnabled
          ctx.noteSavePath.value = res.data.data.noteSavePath || ''
          ctx.screenshotSavePath.value = res.data.data.screenshotSavePath || ''
        }
      } catch (err) {
        console.error('加载工具箱设置失败:', err)
      } finally {
        ctx.loaded.value = true
      }
    },
    async saveWidgetSettings() {
      try {
        await axios.put('/api/widget-settings', {
          toolboxEnabled: ctx.toolboxEnabled.value,
          noteSavePath: ctx.noteSavePath.value,
          screenshotSavePath: ctx.screenshotSavePath.value
        })
        window.electron?.send(SEND.TO_WIDGET, { type: 'settings-changed' })
      } catch (err) {
        // 工具箱开关/保存路径失败必须可感知：界面已切换、库里没改，静默会在重启后"设置回滚"
        console.error('保存工具箱设置失败:', err)
        ctx.notifyError('工具箱设置保存失败，改动未保存')
      }
    },
    onToolboxChange(value) {
      ctx.toolboxEnabled.value = !!value
      if (!ctx.loaded.value) return
      ctx.saveWidgetSettings()
      // 立即生效（不再有「本次启用」这个会话开关）：
      // true 会重建/显示浮窗，false 会直接销毁浮窗释放渲染进程。
      window.electron?.send(SEND.WIDGET_SET_SESSION_VISIBLE, ctx.toolboxEnabled.value)
    },
    async loadUsbAutoOpen() {
      try {
        const res = await window.electron?.invoke(INVOKE.GET_USB_AUTO_OPEN)
        ctx.usbAutoOpen.value = !!res?.enabled
      } catch (_) {}
    },
    // 切换「启用桌面小组件」：持久化到 localStorage，并即时通知主进程创建/关闭桌面小组件窗口
    onDesktopWidgetChange(value) {
      ctx.desktopWidgetEnabled.value = !!value
      try { localStorage.setItem('desktopWidgetEnabled', ctx.desktopWidgetEnabled.value ? '1' : '0') } catch (_) {}
      window.electron?.send(SEND.DESKTOP_WIDGET_ENABLED, ctx.desktopWidgetEnabled.value)
    },
    async onUsbAutoOpenChange(value) {
      ctx.usbAutoOpen.value = !!value
      try {
        await window.electron?.invoke(INVOKE.SET_USB_AUTO_OPEN, ctx.usbAutoOpen.value)
      } catch (_) {
        console.error('保存U盘自动打开设置失败')
      }
    },
    async loadDataDirs() {
      try {
        const res = await window.electron?.invoke(INVOKE.GET_DATA_DIRECTORIES)
        if (res) {
          ctx.dataDir.value = res.dataDir
          ctx.screenshotDir.value = res.screenshotDir || ''
        }
      } catch (_) {}
    },
    async changeDataDir() {
      const picked = await ctx.pickDir()
      if (!picked) return
      ctx.showConfirm(`确定把数据库目录搬迁到「${picked}」吗？搬迁期间所有窗口会暂时关闭并显示迁移进度，请勿强行停止程序，完成后会自动重开主界面。`, async () => {
        ctx.busyDataDir.value = true
        try {
          const res = await window.electron.invoke(INVOKE.SET_DATA_DIR, picked)
          if (res?.ok) {
            ctx.dataDir.value = res.dataDir
            ctx.showAlert(res.changed ? '数据库目录搬迁成功，应用服务已重启。' : '目录未变化。')
          }
        } catch (err) {
          ctx.showAlert(err?.message || '数据库目录搬迁失败')
        } finally {
          ctx.busyDataDir.value = false
        }
      })
    },
    // 缩略图缓存与 AI 技能目录已固定为数据根目录下的子文件夹，不再提供独立切换入口。
    // 读取本账号的安全等级
    async loadSecurityLevel() {
      try {
        const { data } = await axios.get('/api/account/security-level')
        ctx.securityLevel.value = data.level || ''
      } catch (_) { /* 读取失败保持空值 */ } finally {
        ctx.securityLevelLoading.value = false
      }
    },
    // 下拉切换安全等级：先弹确认框（按需收集当前密码 / 新密码），确认后再真正切换
    onSecurityLevelChange(target) {
      if (!target || target === ctx.securityLevel.value) return
      ctx.securityDialog.value = { open: true, target, password: '', newPassword: '', confirmPassword: '', error: '' }
    },
    closeSecurityDialog() {
      if (ctx.busySecurityLevel.value) return
      ctx.securityDialog.value.open = false
    },
    async confirmSecurityLevel() {
      const d = ctx.securityDialog.value
      if (ctx.securityNeedsCurrent.value && !d.password) {
        d.error = '请输入当前登录密码'
        return
      }
      if (ctx.securityNeedsNew.value && String(d.newPassword).length < 6) {
        d.error = '新密码长度至少 6 位'
        return
      }
      // 二次确认：首次设密码打错一个字就进不去自己刚设的墙。普通密码还能在原机走本机信息
      // 恢复，超级隐私只有恢复词，所以提示语按目标等级分开（见 SettingsView 的 securityNewPwdHint）。
      // 两次输入不一致就提交，等于给用户凭空造一次找回。
      if (ctx.securityNeedsNew.value) {
        if (!d.confirmPassword) {
          d.error = '请再次输入新密码'
          return
        }
        if (d.newPassword !== d.confirmPassword) {
          d.error = '两次输入的新密码不一致'
          return
        }
      }
      ctx.busySecurityLevel.value = true
      d.error = ''
      try {
        const { data } = await axios.post('/api/account/security-level', {
          level: d.target,
          password: ctx.securityNeedsCurrent.value ? d.password : '',
          newPassword: ctx.securityNeedsNew.value ? d.newPassword : '',
        })
        ctx.securityLevel.value = data.level || d.target
        if (data.phrase) {
          ctx.privacyPhrase.value = data.phrase
          ctx.syncPrivacyPhraseGuard(true)
        }
        d.open = false
        d.password = ''
        d.newPassword = ''
        d.confirmPassword = ''
        ctx.notifySuccess('安全等级已更新')
      } catch (err) {
        d.error = err.response?.data?.error || '切换失败'
      } finally {
        ctx.busySecurityLevel.value = false
      }
    },
    // 恢复词展示期间把窗口排除在屏幕捕获之外；离开设置页/关闭展示时恢复
    syncPrivacyPhraseGuard(on) {
      try {
        window.electron?.invoke(INVOKE.SET_CONTENT_PROTECTION, !!on)
      } catch (_) { /* 非 Electron 环境忽略 */ }
    },
    clearPrivacyPhrase() {
      ctx.privacyPhrase.value = ''
      ctx.syncPrivacyPhraseGuard(false)
    },
    // 切换已生效、恢复词只返回这一次：关掉弹窗前再确认一遍，避免手快点掉后永久丢失
    onPrivacyPhraseSaved() {
      ctx.showConfirm('确认已把恢复词保存到安全位置？关闭后无法再次查看。', () => {
        ctx.clearPrivacyPhrase()
      }, '确认已保存')
    },
    async pickDir() {
      try {
        const result = await window.electron?.invoke(INVOKE.SELECT_FOLDER)
        if (result && result.filePaths && result.filePaths.length > 0) {
          return result.filePaths[0]
        }
      } catch (_) {}
      return ''
    },
    async openDir(path) {
      if (!path) return
      try {
        await window.electron?.invoke(INVOKE.OPEN_FOLDER, path)
      } catch (err) {
        console.error('打开文件夹失败:', err)
      }
    },
    async selectFolder(type) {
      try {
        const result = await window.electron?.invoke(INVOKE.SELECT_FOLDER)
        if (result && result.filePaths && result.filePaths.length > 0) {
          const path = result.filePaths[0]
          if (type === 'note') {
            ctx.noteSavePath.value = path
          } else {
            ctx.screenshotSavePath.value = path
          }
          ctx.saveWidgetSettings()
        }
      } catch (err) {
        console.error('选择文件夹失败:', err)
      }
    },
    // ==================== 性能面板 ====================
    // 快速启动开关：只写 localStorage，**下一次启动**才改变占位页的让位时机
    // （本次启动的占位页早已移除，改它没有即时效果，所以不做任何运行期动作）。
    // 写失败（存储被禁）时把头值回滚，避免面板显示与真实生效值不一致。
    onFastStartupChange(value) {
      const on = !!value
      ctx.fastStartup.value = on
      if (!writeFastStartup(on)) {
        ctx.fastStartup.value = readFastStartup()
        ctx.notifyError('设置未能保存（本地存储不可用），下次启动仍按原来的方式')
      }
    },
    // 清理图片微缩图：删掉**所有账号**的缩略图缓存文件，相册索引一行不动。
    // 范围取「所有账号」是为了和统计口径一致 —— 上面那格数字就是整个缩略图目录的合计，
    // 只清当前账号的话数字只掉一小截，用户会以为没生效（详见 routes/album.js 的注释）。
    // 清完必须强制重算磁盘占用，否则 20s 节流会让用户盯着旧数字。
    purgeThumbs() {
      if (ctx.busyPurgeThumbs.value || ctx.busyDisk.value) return
      const bytes = (ctx.diskUsage.value && ctx.diskUsage.value.thumbs) || 0
      if (!bytes) return
      ctx.showConfirm(
        `确定清理图片微缩图缓存吗？将删除所有账号的缩略图文件，约释放 ${ctx.fmtBytes(bytes)}。\n`
        + '照片本身和相册索引都不受影响，下次打开相册时会自动重建（首次进入会略慢）。',
        async () => {
          ctx.busyPurgeThumbs.value = true
          try {
            const res = await axios.post('/api/album/thumbs/purge', {}, {
              headers: { Authorization: 'Bearer ' + (getToken() || '') },
            })
            const d = (res.data && res.data.data) || {}
            const skipped = d.failed ? `，${d.failed} 个文件被占用未删除` : ''
            ctx.notifySuccess(`已清理 ${d.files || 0} 个微缩图文件，释放 ${ctx.fmtBytes(d.bytes || 0)}${skipped}`)
          } catch (err) {
            const msg = (err.response && err.response.data && err.response.data.error) || err.message || '未知错误'
            ctx.notifyError('清理失败：' + msg)
          } finally {
            ctx.busyPurgeThumbs.value = false
            await ctx.loadDiskUsage(true)
          }
        },
        '清理',
      )
    },
    // 「整理」：只删没有索引引用的孤儿微缩图，正在用的图一张不动。
    // 两步走：先发一次**只读对账**拿数字，确认框里如实告诉用户要删几张、多大；
    // 用户点确认才带 apply=true 发第二次。后端把 apply 缺省当 false，
    // 所以哪怕前端漏传也不会误删（删文件这件事不能有「默认就动手」）。
    async sweepThumbs() {
      if (ctx.busySweepThumbs.value || ctx.busyPurgeThumbs.value || ctx.busyDisk.value) return
      const headers = { Authorization: 'Bearer ' + (getToken() || '') }
      ctx.busySweepThumbs.value = true
      let d = {}
      try {
        const probe = await axios.post('/api/album/thumbs/sweep', {}, { headers })
        d = (probe.data && probe.data.data) || {}
      } catch (err) {
        const msg = (err.response && err.response.data && err.response.data.error) || err.message || '未知错误'
        ctx.notifyError('孤儿检测失败：' + msg)
        return
      } finally {
        ctx.busySweepThumbs.value = false
      }
      const skipped = (d.skipped && d.skipped.length)
        ? `\n另有 ${d.skipped.length} 个账号的库未解锁或无法对账，它们的缩略图已跳过、不会删除。` : ''
      if (!d.orphans) {
        ctx.notifySuccess(`没有发现孤儿微缩图${skipped ? `（${d.skipped.length} 个账号已跳过）` : ''}`)
        return
      }
      ctx.showConfirm(
        `发现 ${d.orphans} 张没有索引引用的微缩图，约 ${ctx.fmtBytes(d.bytes)}。\n`
        + '只删除这些孤儿，正在使用的微缩图、照片和相册索引都不受影响。' + skipped,
        async () => {
          ctx.busySweepThumbs.value = true
          try {
            const res = await axios.post('/api/album/thumbs/sweep', { apply: true }, { headers })
            const r = (res.data && res.data.data) || {}
            const busy = r.failed ? `，${r.failed} 个文件被占用未删除` : ''
            ctx.notifySuccess(`已整理 ${r.deleted || 0} 张孤儿微缩图，释放 ${ctx.fmtBytes(r.freed || 0)}${busy}`)
          } catch (err) {
            const msg = (err.response && err.response.data && err.response.data.error) || err.message || '未知错误'
            ctx.notifyError('整理失败：' + msg)
          } finally {
            ctx.busySweepThumbs.value = false
            await ctx.loadDiskUsage(true)
          }
        },
        '整理',
      )
    },
    // 「整理」：对当前账号库执行 VACUUM，把删除记录后留在 freelist 里的空闲页真正还给磁盘。
    // 为什么不做自动整理：VACUUM 会独占库文件、重写整份数据，期间后端是同步阻塞的，
    // 只能由用户显式点一次并接受短暂卡顿（大库可能几秒），不能偷偷在后台做。
    vacuumDb() {
      if (ctx.busyVacuum.value || ctx.busyDisk.value) return
      const bytes = (ctx.diskUsage.value && ctx.diskUsage.value.currentAccount) || 0
      const sizeText = bytes ? `（当前 ${ctx.fmtBytes(bytes)}）` : ''
      ctx.showConfirm(
        `确定整理当前账号的数据库吗？${sizeText}\n`
        + '会把删除记录后留下的空闲空间真正还给磁盘；耗时与库大小成正比（实测约 3 秒/GB），'
        + '期间请不要操作，数据、照片和索引都不受影响，完成后不需要重启。',
        async () => {
          ctx.busyVacuum.value = true
          ctx.vacuumDialog.value = true
          let doneMsg = ''
          let failed = false
          try {
            const res = await axios.post('/api/data/vacuum', {}, {
              headers: { Authorization: 'Bearer ' + (getToken() || '') },
              // 兜底：后端若长时间不响应（例如被看门狗重启），别让进度框永远挂着
              timeout: 180000,
            })
            const d = (res.data && res.data.data) || {}
            const freed = d.noop
              ? '没有可回收的空间（库文件已经很紧凑）'
              : `释放 ${ctx.fmtBytes(d.freedBytes || 0)}`
            doneMsg = `已整理数据库，${freed}（${Math.round(d.durationMs || 0)}ms）`
          } catch (err) {
            failed = true
            const msg = (err.response && err.response.data && err.response.data.error) || err.message || '未知错误'
            doneMsg = '整理失败：' + msg
          }
          ctx.vacuumDialog.value = false
          ctx.busyVacuum.value = false
          if (failed) ctx.notifyError(doneMsg)
          else ctx.notifySuccess(doneMsg)
          // 强制重算磁盘占用：不走 20s 节流，否则用户会盯着整理前的旧数字
          await ctx.loadDiskUsage(true)
        },
        '整理',
      )
    },
    // 进度框的「取消」：只撤销等待，不中止后端（VACUUM 是同步原语，无法中途叫停）。
    // busyVacuum 保持 true，避免用户以为取消了就又能点一次，把两次整理排进队列。
    cancelVacuumWait() {
      if (!ctx.vacuumDialog.value) return
      ctx.vacuumDialog.value = false
      ctx.notifyInfo('已关闭进度提示，整理会在后台继续，完成后提示结果')
    },
    // 「清理」日志：把四个日志出口截断为 0。
    // 日志是主进程写的（backend.log 的写流、inp.log/desktop-layer.log 的追加），
    // 后端进程够不到 userData 根那份，所以走 IPC 而不是业务路由。
    // 只截断不删文件：backend.log 的写句柄还开着，删文件在 Windows 上会 EBUSY。
    clearLogs() {
      if (ctx.busyLogs.value || ctx.busyDisk.value) return
      const bytes = (ctx.diskUsage.value && ctx.diskUsage.value.logs) || 0
      if (!bytes) return
      ctx.showConfirm(
        `确定清空日志吗？约释放 ${ctx.fmtBytes(bytes)}。\n`
        + '只清后端 / 启动 / INP / 桌面挂件四个日志文件，不影响任何数据和照片；'
        + '运行期的日志会继续照常写入。',
        async () => {
          ctx.busyLogs.value = true
          try {
            const res = await window.electron?.invoke(INVOKE.PERF_LOGS_CLEAR)
            // 与其它通道同判据：主进程走 ok()/fail() 契约
            if (!res || res.outcome !== 'ok') {
              throw new Error((res && res.error) || '主进程未返回结果')
            }
            ctx.notifySuccess(`已清空 ${res.files || 0} 个日志文件，释放 ${ctx.fmtBytes(res.clearedBytes || 0)}`)
          } catch (err) {
            ctx.notifyError('清理日志失败：' + (err.message || '未知错误'))
          } finally {
            ctx.busyLogs.value = false
            await ctx.loadDiskUsage(true)
          }
        },
        '清理',
      )
    },
    // 轮询开关：进入页面（含从 KeepAlive 恢复）开始，离开即停，避免常驻采样
    _startPerfPolling() {
      if (ctx._perfTimer.value) return
      ctx.loadPerf()
      ctx._perfTimer.value = setInterval(() => {
        if (document.visibilityState !== 'visible') return
        ctx.loadPerf()
      }, 1000)
    },
    _stopPerfPolling() {
      if (!ctx._perfTimer.value) return
      clearInterval(ctx._perfTimer.value)
      ctx._perfTimer.value = null
    },
    // 提示条：复用项目统一的 useNotification
    notifySuccess(msg) {
      useNotification().success(msg)
    },
    notifyError(msg) {
      useNotification().error(msg)
    },
    notifyInfo(msg) {
      useNotification().info(msg)
    },
    // 取一次逐进程内存快照，并更新三个重启目标的存活状态
    async loadPerf() {
      try {
        const snap = await window.electron?.invoke(INVOKE.PERF_SNAPSHOT)
        if (snap) {
          ctx.perfProcs.value = Array.isArray(snap.procs) ? snap.procs : []
          // 首位条形目标占比每次采样在 85%~95% 间跳动，避免最高占用恒为满格
          ctx.perfTopRatio.value = 0.85 + Math.random() * 0.1
          ctx.perfTotal.value = snap.total ?? null
          ctx.perfAvg.value = snap.avg1min ?? null
          ctx.perfMax.value = snap.max ?? null
          ctx.perfFront.value = snap.frontKB ?? null
          ctx.perfBackend.value = snap.backendKB ?? null
          ctx.perfOther.value = snap.otherKB ?? null
          ctx.perfAlive.value = {
            front: !!(snap.alive && snap.alive.front),
            backend: !!(snap.alive && snap.alive.backend),
            widget: !!(snap.alive && snap.alive.widget),
          }
        }
      } catch (_) { /* 后端未就绪等场景静默忽略 */ }
    },
    // 取上次启动耗时
    async loadStartup() {
      try {
        const t = await window.electron?.invoke(INVOKE.PERF_STARTUP)
        // 不做取整：主进程传来的 total 带 getCreationTime 的微秒级小数，
        // 面板按秒原样呈现（如 1.17285693359375 s）。
        ctx.perfStartupTotal.value = t?.total || 0
      } catch (_) {}
    },
    // 空间管理：按四类 + 其他兜底统计磁盘占用。
    // 不进内存轮询链（体积扫描是目录遍历，代价比读计数大得多）：
    // 设置页进入时触发一次、手动「重新统计」触发一次，20s 内重复进入不重扫。
    async loadDiskUsage(force = false) {
      if (ctx.busyDisk.value) return
      if (!force && ctx.diskUsage.value && Date.now() - ctx._diskAt < 20000) return
      ctx.busyDisk.value = true
      ctx._diskAt = Date.now()
      try {
        // 当前账号 slug 由登录态给出（auth 接口的 dbSlug），主进程据此把库文件分到「该账号」，
        // 拿不到就全部归到「其他账号」，不会错记到当前账号头上。
        const slug = ctx.user.value?.dbSlug || ''
        const res = await window.electron?.invoke(INVOKE.PERF_DISK_USAGE, { slug })
        // 判据与其它通道一致：主进程走 ok()/fail() 契约（见 electron/main/main.ipc-contract.js）
        if (res && res.outcome === 'ok') {
          ctx.diskUsage.value = res
          ctx.diskUsageError.value = ''
          ctx.diskTip.value = null // 数据换了，旧的悬浮详情不能留着
          ctx.diskTipSuppressed.value = false // 新数据可以正常预览
        } else if (res && res.outcome === 'fail') {
          ctx.diskUsageError.value = res.error || '统计失败'
        }
      } catch (err) {
        ctx.diskUsageError.value = String((err && err.message) || err)
      } finally {
        ctx.busyDisk.value = false
      }
    },
    // 空间管理：点彩条/图例选中分类；再点同一段或点别处都退出预览
    selectDiskSegment(key) {
      const next = ctx.selectedDiskKey.value === key ? null : key
      if (next) {
        ctx.selectedDiskKey.value = next
        ctx.diskTipSuppressed.value = false
      } else {
        ctx.clearDiskPreview()
      }
    },
    // 退出预览：清选中 + 关浮窗，并抑制到鼠标离开彩条/图例后才恢复，
    // 否则鼠标没动、下一次 mousemove 会立刻把浮窗弹回来。
    clearDiskPreview() {
      ctx.selectedDiskKey.value = null
      ctx.diskTip.value = null
      ctx.diskTipSuppressed.value = true
    },
    // document 级点击：落在彩条分段或图例行以外的任何地方都算「点别处」
    onDiskOutsideClick(ev) {
      const t = ev.target
      if (t && typeof t.closest === 'function' && t.closest('.disk-seg, .disk-legend-row')) return
      if (!ctx.selectedDiskKey.value && !ctx.diskTip.value && !ctx.diskTipSuppressed.value) return
      ctx.clearDiskPreview()
    },
    // 悬浮详情跟随鼠标：浮层宽 216px，靠近视口右/下边缘时翻到左上，避免被裁掉
    showDiskTip(seg, ev) {
      if (ctx.diskTipSuppressed.value) return
      const x = Math.max(8, Math.min(ev.clientX + 16, window.innerWidth - 232))
      const y = ev.clientY + 16 + 128 > window.innerHeight
        ? Math.max(8, ev.clientY - 128)
        : ev.clientY + 16
      ctx.diskTip.value = { x, y, seg }
    },
    // 鼠标移出彩条/图例：浮窗消失，同时解除抑制（下次进入可以正常预览）
    hideDiskTip() {
      ctx.diskTip.value = null
      ctx.diskTipSuppressed.value = false
    },
    // 字节 → 磁盘容量文本：1GB 以上用 GB（一位小数），其余四舍五入到整 MB
    fmtBytes(bytes) {
      if (typeof bytes !== 'number' || bytes < 0) return '--'
      const mb = bytes / 1048576
      if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
      return `${Math.round(mb)} MB`
    },
    // KB → MB 文本；无数据时占位，保持列宽稳定
    fmtMem(kb) {
      if (kb === null || kb === undefined) return '--'
      return `${Math.round(kb / 1024)} MB`
    },
    // 条形宽度百分比：以总计为分母，最小值 3% 让很小的值也可见，封顶 100%
    barPct(kb) {
      if (!kb) return 0
      return Math.min(100, Math.max(3, Math.round((kb / ctx.perfMaxKB.value) * 100)))
    },
    // 手动回收：主进程 + 各渲染进程 + 后端
    async recycleAll() {
      if (ctx.busyGc.value) return
      ctx.busyGc.value = true
      try {
        await window.electron?.invoke(INVOKE.PERF_GC)
        await ctx.loadPerf()
        ctx.notifySuccess('已执行内存回收')
      } catch (_) {
        ctx.notifyError('内存回收失败')
      } finally {
        ctx.busyGc.value = false
      }
    },
    // 重启前端：页面会自行重载，无需提示
    restartFrontend() {
      window.electron?.invoke(INVOKE.PERF_RESTART_FRONTEND)
    },
    // 重启后端：复用已有的 restart-backend 通道
    async restartBackend() {
      if (ctx.busyRestartBackend.value) return
      ctx.busyRestartBackend.value = true
      try {
        await window.electron?.invoke(INVOKE.RESTART_BACKEND)
        await ctx.loadPerf()
        ctx.notifySuccess('后端已重启')
      } catch (_) {
        ctx.notifyError('后端重启失败')
      } finally {
        ctx.busyRestartBackend.value = false
      }
    },
    // 重启小组件：销毁并重建原本存在的窗口
    async restartWidget() {
      if (ctx.busyRestartWidget.value) return
      ctx.busyRestartWidget.value = true
      try {
        await window.electron?.invoke(INVOKE.PERF_RESTART_WIDGET)
        await ctx.loadPerf()
        ctx.notifySuccess('小组件已重启')
      } catch (_) {
        ctx.notifyError('小组件重启失败')
      } finally {
        ctx.busyRestartWidget.value = false
      }
    },
    // 全部重启：打包版直接重启 Electron 本体（主进程/前端/小组件/后端一并重启）。
    // 开发模式下 Electron 由 `npm run electron:dev` 的 concurrently --kill-others 托管，
    // app.relaunch 让 Electron 退出时会连带杀掉 Vite，新实例拿不到 dev server 会卡在
    // 加载页（停在「本地服务已就绪」），故 dev 退化为软重启：后端/小组件重启 + 前端重载。
    restartAll() {
      if (ctx.busyRestartAll.value) return
      ctx.busyRestartAll.value = true
      if (import.meta.env.DEV) {
        ctx._softRestartAll()
      } else {
        window.electron?.invoke(INVOKE.PERF_RELAUNCH_APP)
      }
    },
    async _softRestartAll() {
      try {
        await window.electron?.invoke(INVOKE.RESTART_BACKEND)
        await window.electron?.invoke(INVOKE.PERF_RESTART_WIDGET)
        ctx.notifySuccess('正在重启全部进程')
        window.electron?.invoke(INVOKE.PERF_RESTART_FRONTEND)
      } catch (_) {
        ctx.notifyError('全部重启失败')
        ctx.busyRestartAll.value = false
      }
    },
  }
}
