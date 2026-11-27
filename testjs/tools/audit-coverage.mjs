#!/usr/bin/env node
// audit-coverage.mjs —— 「入口 × 不变量」覆盖矩阵生成器
//
// 它不声称证明零 bug；它把审查对象从「文件读过没有」换成「格子有证据没有」。
// 每个不变量是一条可复用的检查规则；新增一条规则，全仓库同类入口一次性被扫。
// 静态结果只做分流：PASS（有守卫证据）/ GAP（缺守卫候选）/ UNKNOWN（需人工或时序测试）。
// GAP 与 UNKNOWN 都会让检查器返回非零，避免「报告写完就算覆盖」。
//
// 用法：
//   node testjs/tools/audit-coverage.mjs
//   node testjs/tools/audit-coverage.mjs --report-only
//   node testjs/tools/audit-coverage.mjs --out-dir=<dir> --date=2026-11-21
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', '..')
// 默认输出到系统临时目录：覆盖矩阵是过程产物，不该污染仓库（T01-10）。
// 需要归档时显式传 --out-dir=<目录>（T03-14）。
const DEFAULT_OUT = path.join(os.tmpdir(), 'classnest-coverage')

const STATUS = Object.freeze({ PASS: 'PASS', GAP: 'GAP', UNKNOWN: 'UNKNOWN', NA: 'N/A' })

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.trash', 'dist', 'build', '.vite', 'coverage',
  'tmp', '.workbuddy', 'release', 'release36',
])

function walk(dir, out = []) {
  let ents = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const ent of ents) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(path.join(dir, ent.name), out)
    } else if (/\.(js|mjs|cjs|vue)$/.test(ent.name)) {
      out.push(path.join(dir, ent.name))
    }
  }
  return out
}

function makeCtx(root) {
  const rawCache = new Map()
  const cleanCache = new Map()
  const ctx = {
    root,
    read(rel) {
      if (!rawCache.has(rel)) {
        let text = ''
        try {
          text = fs.readFileSync(path.join(root, rel), 'utf8')
        } catch (_) {
          text = ''
        }
        rawCache.set(rel, text)
      }
      return rawCache.get(rel)
    },
    rawLines(rel) {
      return ctx.read(rel).split(/\r?\n/)
    },
    clean(rel) {
      if (!cleanCache.has(rel)) cleanCache.set(rel, stripComments(ctx.read(rel)))
      return cleanCache.get(rel)
    },
    cleanLines(rel) {
      return ctx.clean(rel).split(/\r?\n/)
    },
    exists(rel) {
      return ctx.read(rel) !== ''
    },
    json(rel) {
      try {
        return JSON.parse(ctx.read(rel))
      } catch (_) {
        return null
      }
    },
    findLine(rel, re) {
      const lines = ctx.cleanLines(rel)
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) return i + 1
      }
      return 0
    },
  }
  return ctx
}

// 注释里的函数名会骗过正则；按行 blanks 掉注释，但保留行号。
function stripComments(src) {
  let inBlock = false
  let quote = ''
  return src.split(/\r?\n/).map((line) => {
    let out = ''
    let i = 0
    while (i < line.length) {
      const ch = line[i]
      const next = line[i + 1]
      if (inBlock) {
        if (ch === '*' && next === '/') {
          inBlock = false
          i += 2
        } else i += 1
        continue
      }
      if (quote) {
        out += ch
        if (ch === '\\' && next) {
          out += next
          i += 2
          continue
        }
        if (ch === quote) quote = ''
        i += 1
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        out += ch
        i += 1
        continue
      }
      if (ch === '/' && next === '/') break
      if (ch === '/' && next === '*') {
        inBlock = true
        i += 2
        continue
      }
      out += ch
      i += 1
    }
    return out
  }).join('\n')
}

function relOf(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/')
}

function collectRouteEntries(ctx) {
  const dir = path.join(ctx.root, 'student-backend', 'routes')
  const entries = []
  for (const abs of walk(dir)) {
    const rel = relOf(ctx.root, abs)
    const lines = ctx.cleanLines(rel)
    lines.forEach((line, idx) => {
      const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g
      let m
      while ((m = re.exec(line))) {
        entries.push({
          id: `route:${rel}:${idx + 1}:${m[1]}:${m[2]}`,
          kind: 'route',
          file: rel,
          line: idx + 1,
          method: m[1].toUpperCase(),
          apiPath: m[2],
        })
      }
    })
  }
  return entries
}

function collectIpcEntries(ctx) {
  const file = 'electron/ipc-channels.json'
  const data = ctx.json(file)
  if (!data) return []
  const entries = []
  for (const transport of ['send', 'invoke']) {
    for (const channel of data[transport] || []) {
      entries.push({
        id: `ipc:${transport}:${channel}`,
        kind: 'ipc',
        file,
        line: ctx.findLine(file, new RegExp(`"${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)),
        channel,
        transport,
      })
    }
  }
  return entries
}

function collectFrontendEntries(ctx) {
  const dir = path.join(ctx.root, 'student-frontend', 'src')
  const entries = []
  for (const abs of walk(dir)) {
    const rel = relOf(ctx.root, abs)
    const code = ctx.clean(rel)
    if (!code) continue
    const meta = {
      rawTimer: /setTimeout|setInterval|addEventListener|AbortController|d\.timeout\(|d\.interval\(|d\.listen\(|d\.defer\(/.test(code),
      scopeAwait: /await/.test(code) && /classScopeKey|dbSlug|isUnmounted|_unmounted|token/.test(code),
      usesSaveFile: /saveFile\(|save-file/.test(code),
      usesInflight: /(inFlight|inflight)/.test(code) && /\.delete\(/.test(code),
    }
    if (!meta.rawTimer && !meta.scopeAwait && !meta.usesSaveFile && !meta.usesInflight) continue
    entries.push({
      id: `fe:${rel}`,
      kind: 'frontend-file',
      file: rel,
      line: 1,
      meta,
    })
  }
  return entries
}

function collectAiToolEntries(ctx) {
  const dir = path.join(ctx.root, 'student-backend', 'routes', 'ai', 'ai.tools', 'tools.executors')
  return walk(dir).map((abs) => {
    const rel = relOf(ctx.root, abs)
    return { id: `ai-tool:${rel}`, kind: 'ai-tool', file: rel, line: 1 }
  })
}

function collectBackupEntries(ctx) {
  const files = [
    'student-backend/services/backupArchive.js',
    'student-backend/routes/account.js',
  ]
  return files.filter((rel) => ctx.exists(rel)).map((rel) => ({
    id: `backup:${rel}`,
    kind: 'backup',
    file: rel,
    line: 1,
  }))
}

function collectUndoEntries(ctx) {
  const rel = 'student-backend/services/undoStore.js'
  if (!ctx.exists(rel)) return []
  return [{ id: `undo:${rel}`, kind: 'undo-file', file: rel, line: 1 }]
}

function collectPrivacyEntries(ctx) {
  const files = [
    'student-backend/routes/ai/privacy.shared.js',
    'student-backend/services/aiWriteScope.js',
  ]
  return files.filter((rel) => ctx.exists(rel)).map((rel) => ({
    id: `privacy:${rel}`,
    kind: 'privacy-file',
    file: rel,
    line: 1,
  }))
}

function collectElectronEntries(ctx) {
  const files = [
    'electron/main/main.dev-loader.js',
    'electron/main/main.updater.js',
  ]
  return files.filter((rel) => ctx.exists(rel)).map((rel) => ({
    id: `electron:${rel}`,
    kind: 'electron-file',
    file: rel,
    line: 1,
  }))
}

function collectTargetFiles(ctx) {
  const files = [
    'student-backend/routes/auth.js',
    'student-backend/routes/ai/ai.dataRoutes.js',
    'student-backend/routes/undo/undo.executors.js',
    'student-backend/dbManager/dbManager.account.js',
    'student-backend/services/sessions.js',
    'electron/main/main.backend.js',
  ]
  return files.filter((rel) => ctx.exists(rel)).map((rel) => ({
    id: `target:${rel}`,
    kind: 'target-file',
    file: rel,
    line: 1,
  }))
}

function collectEntries(ctx) {
  return [
    ...collectRouteEntries(ctx),
    ...collectIpcEntries(ctx),
    ...collectFrontendEntries(ctx),
    ...collectAiToolEntries(ctx),
    ...collectBackupEntries(ctx),
    ...collectUndoEntries(ctx),
    ...collectPrivacyEntries(ctx),
    ...collectElectronEntries(ctx),
    ...collectTargetFiles(ctx),
  ]
}

function sliceCode(ctx, entry, count = 70) {
  const lines = ctx.cleanLines(entry.file)
  return lines.slice(Math.max(0, entry.line - 1), Math.max(0, entry.line - 1) + count).join('\n')
}

function codeOf(ctx, entry) {
  return ctx.clean(entry.file)
}

function functionBody(ctx, entry, startLine) {
  const lines = ctx.cleanLines(entry.file)
  const out = []
  let depth = 0
  let started = false
  for (let i = Math.max(0, startLine - 1); i < lines.length; i += 1) {
    const line = lines[i]
    out.push(line)
    for (const ch of line) {
      if (ch === '{') {
        depth += 1
        started = true
      } else if (ch === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

function evidence(entry, line, note) {
  return {
    evidence: line ? `${entry.file}:${line}` : entry.file,
    note: note || '',
  }
}

// 已人工复核、按设计不需要 404 的写入口（route.not_found_404 专用）。
// 判据是「用户是否会被告知成功但其实没写」——不谎报成功即可，状态码不必是 404。
// 加条目必须同时写理由；「改了更好」的不要加，去改代码。
const NOT_FOUND_404_REVIEWED = Object.freeze({
  'route:student-backend/routes/ai/ai.conversations.js:149:delete:/conversations/:id/messages/last-assistant':
    '幂等契约：返回 { success:true, removed:false }，removed 已如实表示没删到（重试前清理用）',
  // 行号随 V9-2-5 接入 writeWithUndo 下移（原 :54/:67 → :57/:74），语义未变：
  // updateRowWithRename / deleteRow 内部 throw「记录不存在」，路由回 400 —— 不谎报成功。
  'route:student-backend/routes/dynamicTable.js:57:put:/:id':
    'updateRow 内部 throw「记录不存在」，路由回 400 —— 不谎报成功，只是状态码口径不同',
  'route:student-backend/routes/dynamicTable.js:74:delete:/:id':
    'deleteRow 内部 throw「记录不存在」，同上',
  'route:student-backend/routes/undo/undo.js:232:delete:/:id':
    '幂等删除：撤销记录只从列表里点，重复删除无副作用，前端也不提示「删除成功」',
})

// 已人工复核、资源归属在别处的前端文件（lifecycle.resource_disposal 专用）。
// 判据只有一个：**这份资源有明确的释放者**（宿主组件卸载时释放 / 模块级单例随窗口存活 /
// 自身导出取消函数）。写不出释放者的就是真漏，去改代码，不要往这张表里加。
// 键就是矩阵里的 entry（fe:<rel>），所以文件改名/移动会立刻失配、重新变红。
const LIFECYCLE_REVIEWED = Object.freeze({
  'fe:student-frontend/src/components/base/NotificationToast.vue':
    '提示条实例的 timer 由 remove()/onHover/onLeave 三处显式清；组件只在 App 根挂一次，随窗口关闭结束',
  'fe:student-frontend/src/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.options.js':
    '_rejectTimer 归宿主 DutyArrangementDialog.vue，其 onBeforeUnmount 里 clearTimeout',
  'fe:student-frontend/src/components/tables/DynamicTable/DynamicTable.drag.js':
    '拖拽监听登记在 ctx._rowMove/_colMove 上，宿主 DynamicTable.vue 的 onBeforeUnmount 统一摘除',
  'fe:student-frontend/src/components/tables/GridView/GridView.drag.js':
    '同上：_rowMove/_colMove/_tableEnterCleanup/_rowsAnimTimer 由宿主 GridView.vue 的 onBeforeUnmount 释放',
  'fe:student-frontend/src/composables/ai/aiChat.js':
    'AbortController 存在 ctx.abortCtrl，换请求/停止时 abort，不是独立资源',
  'fe:student-frontend/src/composables/secureAxios.js':
    'setTimeout 只是重试退避的一次性排期，随 Promise 链结束',
  'fe:student-frontend/src/composables/useAlbumScan.js':
    '每个实例自带 stopAll()，调用方 AlbumView/AlbumTaskDialog 卸载时调用',
  'fe:student-frontend/src/composables/useAlbumTaskResume.js':
    '模块级单例排期，导出 cancel()，App 卸载时调用',
  'fe:student-frontend/src/composables/useDashboardData.js':
    'setTimeout(…,0) 只为首屏资源打点，一次性',
  'fe:student-frontend/src/composables/useElasticScroll.js':
    '模块级单例：started 短路只挂一次 window resize；wheel 监听挂在被绑元素上，随元素回收',
  'fe:student-frontend/src/composables/useNotification.js':
    '通知仓库是模块级单例，timer 在 remove/暂停/恢复里显式清',
  'fe:student-frontend/src/drag-probe.js':
    '离线探针页脚本：只在手动打开的 drag-probe.html 里跑，窗口关闭即整体销毁',
  'fe:student-frontend/src/main.js':
    '渲染层入口：监听绑在 window/document 上，窗口关闭即整体销毁',
  'fe:student-frontend/src/stores/theme.js':
    'Pinia store 单例，matchMedia 监听与切主题的无动画定时器都随进程存活',
  'fe:student-frontend/src/subwindows/desktop-widget/main.js':
    '桌面小组件窗口入口脚本，窗口关闭即整体销毁',
  'fe:student-frontend/src/subwindows/setup/main.js':
    '引导窗口入口脚本，窗口关闭即整体销毁',
  'fe:student-frontend/src/subwindows/widget/captureHide.js':
    '双 rAF + setTimeout(0) 一次性等帧，没有跨帧资源',
  'fe:student-frontend/src/subwindows/widget/main.js':
    '工具箱子窗口入口脚本，窗口关闭即整体销毁',
  'fe:student-frontend/src/utils/authSync.js':
    'createAuthSync 返回退订函数（return 里 removeEventListener），由安装方负责调用',
  'fe:student-frontend/src/utils/backendReady.js':
    '轮询定时器在 finally 里 clearTimeout，就绪或超时即释放',
  'fe:student-frontend/src/utils/dialogOverlayPulse.js':
    '全局事件委托，main.js 启动时只注册一次，随窗口关闭销毁',
  'fe:student-frontend/src/utils/dialogPrefetch.js':
    '模块级防抖排期：每次调用先清掉上一个 timer，模块随窗口存活',
  'fe:student-frontend/src/utils/disposables.js':
    '底座自身：createDisposables().dispose() 就是释放入口',
  'fe:student-frontend/src/utils/inpProbe.js':
    'dev 探针：installInpProbe 有 observer 短路，进程内只持有一个定时器，随窗口关闭释放，故意不提供停止入口',
  'fe:student-frontend/src/utils/pdfFont.js':
    'releaseTimer 是「延迟释放字体」的模块级防抖，重复调用自动清上一个',
  'fe:student-frontend/src/utils/routePrefetch.js':
    '同 dialogPrefetch：模块级防抖预取，每次调用先清掉上一个 timer，随窗口存活',
  'fe:student-frontend/src/utils/serialSaver.js':
    '只有 sleep 用的 setTimeout，随 Promise 链结束释放',
  'fe:student-frontend/src/views/SettingsView/SettingsView.appearance.js':
    '_perfTimer 归 SettingsView.vue：onDeactivated / onBeforeUnmount 调 _stopPerfPolling',
  'fe:student-frontend/src/views/SettingsView/SettingsView.data.js':
    'deleteTimer 归 SettingsView.vue：卸载调 clearDeleteTimer',
  'fe:student-frontend/src/views/SettingsView/SettingsView.search.js':
    '搜索弹窗的 scroll/resize 监听由 _removeSearchPopupListeners 摘，SettingsView.vue 卸载时调用',
})

// 已人工复核、确认「await 之后没有需要守卫的状态写入」的前端文件（async.scope_guard 专用）。
// 判据：**这个文件里的 await 回来后不写任何会被界面/后续请求消费的状态**，或操作本身是
// 单次提交（busy 锁 + 成功后关闭），不存在「旧响应盖新状态」的入口。写不出理由就改代码。
const ASYNC_REVIEWED = Object.freeze({
  'fe:student-frontend/src/utils/localRecover.js':
    '纯请求封装：只发请求并写 token，不持有组件状态；界面状态由调用方在 await 后守卫（Login 的恢复流程）',
  'fe:student-frontend/src/components/dialogs/CreateTokenDialog.vue':
    '单次提交：busy 期间禁用按钮且禁止关闭，没有重复读取或并发写入',
  'fe:student-frontend/src/components/dialogs/MoveAlbumDialog.vue':
    '单次提交：busy 锁 + 成功后关闭弹窗，没有并发读取覆盖',
  'fe:student-frontend/src/subwindows/widget/WidgetApp.vue':
    '唯一的 async 是 checkToolboxEnabled：await 只读取设置与会话开关，之后仅发 IPC 同步显隐，不写会被界面/后续请求消费的组件状态，不存在旧响应盖新状态',
})

// ai.privacy_read 的人工复核签字：这些工具「没有把业务表数据回给模型」。
// 有直接读取但回给用户本人（如图片）或只操作副本文件的，记 N/A 并写明理由；
// 一旦以后改成把行数据回传模型，这条签字会拦不住 —— 需要重新审视，所以文件改名会失配。
const AI_READ_REVIEWED = Object.freeze({
  'ai-tool:student-backend/routes/ai/ai.tools/tools.executors/executors.common.js':
    '纯日期/JSON/姓名工具函数，不读任何业务表',
  'ai-tool:student-backend/routes/ai/ai.tools/tools.executors/executors.snapshot.js':
    '只操作 .db 文件副本（创建/列出/还原本地快照），不把表数据回给模型',
  'ai-tool:student-backend/routes/ai/ai.tools/tools.executors/executors.image.js':
    '读课表/座位/值日 JSON 生成排布图给用户本人查看；回给模型的是「已生成」状态与目标名，不含表格内容',
})

const INVARIANTS = [
  {
    id: 'route.not_found_404',
    title: 'PUT/DELETE 对不存在的 id 返回 404',
    applies: (ctx, e) => e.kind === 'route' && ['PUT', 'PATCH', 'DELETE'].includes(e.method) && e.apiPath.includes(':id'),
    check(ctx, e) {
      // 已人工复核、按设计不需要 404 的入口。这里只收「语义上就该如此」的，
      // 凡是「改了更好」的一律改代码，不要往这张表里加（否则它会变成静默豁免）。
      // e.id 就是产出矩阵里的 entry 字段（如 route:...routes/undo/undo.js:232:delete:/:id）
      const reviewed = NOT_FOUND_404_REVIEWED[e.id]
      if (reviewed) return { status: STATUS.NA, ...evidence(e, e.line, reviewed) }
      const src = sliceCode(ctx, e)
      const line = ctx.findLine(e.file, /changes\s*===?\s*0|status\(404\)/)
      if (/(changes\s*===?\s*0|status\(404\))/.test(src) && line) {
        return { status: STATUS.PASS, ...evidence(e, line, '已找到 404 判据') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '写路径未发现 changes===0 / 404 判据') }
    },
  },
  {
    id: 'auth.account_hash_sync',
    title: '恢复密码必须同步账号哈希',
    applies: (ctx, e) => e.kind === 'route' && e.file.endsWith('routes/auth.js') && /recover/i.test(e.apiPath),
    check(ctx, e) {
      const src = functionBody(ctx, e, e.line)
      if (!/setPasswordByName/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '该恢复入口不写 users.password') }
      if (/accountSetPassword/.test(src)) {
        const line = ctx.findLine(e.file, /accountSetPassword/)
        return { status: STATUS.PASS, ...evidence(e, line, '已同步 accounts.password_hash') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '写 users.password 但未见 accountSetPassword') }
    },
  },
  {
    id: 'student.rename_cascade',
    title: '学生改名必须级联更新引用',
    applies: (ctx, e) => e.kind === 'route' && (
      /ai\.dataRoutes/.test(e.file) || /apply-batch/.test(e.apiPath) ||
      /dynamicTable/.test(e.file) || /mcpProposalExec/.test(e.file)
    ),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (/renameStudentRefs|updateRowWithRename/.test(src)) {
        const line = ctx.findLine(e.file, /renameStudentRefs|updateRowWithRename/)
        return { status: STATUS.PASS, ...evidence(e, line, '已找到级联调用') }
      }
      if (/applyRowStudentRef|students/.test(src) && /update|姓名/.test(src)) {
        return { status: STATUS.GAP, ...evidence(e, e.line, '学生写入路径未发现改名级联') }
      }
      return { status: STATUS.UNKNOWN, ...evidence(e, e.line, '静态规则无法判断是否涉及改名') }
    },
  },
  {
    id: 'ai.privacy_read',
    title: 'AI 工具读路径必须过读作用域',
    applies: (ctx, e) => e.kind === 'ai-tool',
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (/readScope|isTableReadable|closed_tables|requireReadable/.test(src)) {
        const line = ctx.findLine(e.file, /readScope|isTableReadable|closed_tables|requireReadable/)
        return { status: STATUS.PASS, ...evidence(e, line, '已接入读作用域') }
      }
      if (/query|readAll|findAll|SELECT|\.all\(|list\(/.test(src)) {
        return { status: STATUS.GAP, ...evidence(e, 1, '存在读取调用但未见 closed_tables 读闸门') }
      }
      const reviewed = AI_READ_REVIEWED[e.id]
      if (reviewed) return { status: STATUS.NA, ...evidence(e, 1, reviewed) }
      return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未发现直接读取调用，需人工确认派生读') }
    },
  },
  {
    id: 'ai.privacy_write',
    title: 'AI 写路径必须过只读表闸门',
    applies: (ctx, e) => e.kind === 'route' && /\/ai\//.test(e.file) && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(e.method),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (!/applyRowStudentRef|buildInsert\(|buildUpdate\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/.test(src)) {
        return { status: STATUS.NA, ...evidence(e, 0, '该 AI 入口不直接写业务表') }
      }
      if (/readonly_tables|aiWriteScope|isTableWritable/.test(src)) {
        const line = ctx.findLine(e.file, /readonly_tables|aiWriteScope|isTableWritable/)
        return { status: STATUS.PASS, ...evidence(e, line, '已接入只读表闸门') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '写表入口未发现只读表闸门') }
    },
  },
  {
    id: 'ipc.policy_declared',
    title: 'IPC 通道必须在策略文件声明',
    applies: (ctx, e) => e.kind === 'ipc',
    check(ctx, e) {
      const policy = ctx.json('electron/ipc-policy.json') || {}
      if (Object.prototype.hasOwnProperty.call(policy, e.channel)) {
        const line = ctx.findLine('electron/ipc-policy.json', new RegExp(`"${e.channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
        return { status: STATUS.PASS, ...evidence(e, line, '策略文件已声明该通道') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, `ipc-policy.json 未声明 ${e.channel}`) }
    },
  },
  {
    id: 'write.transaction_scope',
    title: '建档副作用必须在同一事务内可回滚',
    applies: (ctx, e) => e.kind === 'route' && (
      /import/i.test(e.apiPath) || /duty\.js$/.test(e.file) || /ai\.dataRoutes\.js$/.test(e.file)
    ) && /tryResolve\s*\(|resolveNames\s*\(|resolveOne\s*\(/.test(codeOf(ctx, e)),
    check(ctx, e) {
      const lines = ctx.cleanLines(e.file)
      // 只看当前这个 import 处理器：同一文件其它路由里的 resolveOne 与本次导入无关，
      // 用文件级首行比较会把「helper 定义在前、调用在事务内」误判成 GAP（2-1 已修仍报红）。
      const start = Math.max(0, (e.line || 1) - 1)
      const ROUTE_RE = /^\s*(router|app)\.(get|post|put|patch|delete)\s*\(/
      let end = lines.length
      for (let i = start + 1; i < lines.length; i += 1) {
        if (ROUTE_RE.test(lines[i])) { end = i; break }
      }
      const seg = lines.slice(start, end)
      // 定义行不算「调用」：`const tryResolve = (name) => resolveOne(...)` 是 helper 声明；
      // `const r = tryResolve(name)` 仍是调用（右侧不是函数字面量）。
      const isDef = (l) => /const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/.test(l)
      const isCall = (l) => /(tryResolve|resolveMember|resolveOne|resolveNames)\s*\(/.test(l) && !isDef(l)
      const resolveIdx = seg.findIndex(isCall)
      if (resolveIdx < 0) return { status: STATUS.NA, ...evidence(e, 0, '未发现临时学生建档') }
      const txIdx = seg.findIndex((l) => /transaction\s*\(/.test(l))
      if (txIdx < 0) {
        return { status: STATUS.GAP, ...evidence(e, start + resolveIdx + 1, `建档且无事务；失败时临时学生无法回滚`) }
      }
      // 建档调用必须发生在事务开始之后（在同一处理器内、事务回调里）
      const callAfterTx = seg.slice(txIdx + 1).findIndex(isCall)
      if (callAfterTx >= 0) {
        return { status: STATUS.PASS, ...evidence(e, start + txIdx + 1, '事务先于建档调用') }
      }
      return {
        status: STATUS.GAP,
        ...evidence(e, start + resolveIdx + 1, `建档调用在事务之前（事务在 ${start + txIdx + 1}）；失败时临时学生无法回滚`),
      }
    },
  },
  {
    id: 'restore.path_containment',
    title: '恢复解压必须做路径逃逸与同步异常兜底',
    applies: (ctx, e) => e.kind === 'backup' && /zip\.on\(\s*['"]entry['"]/.test(codeOf(ctx, e)),
    check(ctx, e) {
      const lines = ctx.cleanLines(e.file)
      const onLine = ctx.findLine(e.file, /zip\.on\(\s*['"]entry['"]/)
      const window = lines.slice(Math.max(0, onLine - 1), Math.max(0, onLine - 1) + 40).join('\n')
      const hasContain = /isUnsafeName|path\.resolve|startsWith\(/.test(window)
      const hasCatch = /try\s*\{/.test(window)
      if (hasContain && hasCatch) return { status: STATUS.PASS, ...evidence(e, onLine, 'entry 回调已有路径校验与异常边界') }
      return { status: STATUS.GAP, ...evidence(e, onLine, `路径校验=${hasContain} 异常边界=${hasCatch}`) }
    },
  },
  {
    id: 'async.scope_guard',
    title: 'await 后写入必须校验班级/卸载代次',
    applies: (ctx, e) => e.kind === 'frontend-file' && e.meta.scopeAwait,
    check(ctx, e) {
      const src = codeOf(ctx, e)
      // 已认识的守卫写法：代次（generation / scopeAtStart / sessionGen）、
      // 只认最后一次（isCurrent）、卸载标记（_unmounted / disposed）、中断（abort()）
      if (/[Gg]eneration|scopeAtStart|isCurrent|sessionGen|disposed|_unmounted|abort\(\)/.test(src)) {
        const line = ctx.findLine(e.file, /[Gg]eneration|scopeAtStart|isCurrent|sessionGen|disposed|_unmounted|abort\(\)/)
        return { status: STATUS.PASS, ...evidence(e, line, '已找到代次/卸载/中断守卫') }
      }
      const reviewed = ASYNC_REVIEWED[e.id]
      if (reviewed) return { status: STATUS.NA, ...evidence(e, e.line, reviewed) }
      return { status: STATUS.UNKNOWN, ...evidence(e, 1, '静态扫描无法证明时序正确，需时序测试或人工确认') }
    },
  },
  {
    id: 'lifecycle.resource_disposal',
    title: '定时器/监听器必须进入 disposables',
    applies: (ctx, e) => e.kind === 'frontend-file' && e.meta.rawTimer,
    check(ctx, e) {
      const src = codeOf(ctx, e)
      const timerLine = ctx.findLine(e.file, /setTimeout|setInterval|addEventListener|AbortController/)
      if (/utils\/disposables|d\.timeout\(|d\.interval\(|d\.listen\(|d\.defer\(/.test(src)) {
        const line = ctx.findLine(e.file, /utils\/disposables|d\.timeout\(|d\.interval\(|d\.listen\(|d\.defer\(/)
        return { status: STATUS.PASS, ...evidence(e, line, '已使用 disposables') }
      }
      // 先看 disposables（改好了就该变 PASS），再看人工复核表：表里只收「释放者明确在别处」的
      const reviewed = LIFECYCLE_REVIEWED[e.id]
      if (reviewed) return { status: STATUS.NA, ...evidence(e, e.line, reviewed) }
      if (/onUnmounted|onBeforeUnmount/.test(src)) {
        const hookLine = ctx.findLine(e.file, /onUnmounted|onBeforeUnmount/)
        return {
          status: STATUS.GAP,
          evidence: `${e.file}:${timerLine || 1}`,
          note: `裸资源在 ${timerLine || '?'}，卸载钩子在 ${hookLine || '?'}；未用 disposables`,
        }
      }
      return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未发现卸载钩子，需确认是否短生命周期局部资源') }
    },
  },
  {
    id: 'auth.revoke_all_slugs',
    title: '恢复密码必须吊销账号全部班级会话',
    applies: (ctx, e) => e.kind === 'route' && e.file.endsWith('routes/auth.js') && /recover-password/.test(e.apiPath),
    check(ctx, e) {
      const src = functionBody(ctx, e, e.line)
      if (!/setPasswordByName|bcryptHash/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '该入口不改密码') }
      if (/rotateAccountSessions|accountSlugsForRevoke/.test(src)) {
        const line = ctx.findLine(e.file, /rotateAccountSessions|accountSlugsForRevoke/)
        return { status: STATUS.PASS, ...evidence(e, line, '恢复改密与改密主路径同口径') }
      }
      if (/revokeAccountSessions/.test(src)) {
        const line = ctx.findLine(e.file, /revokeAccountSessions/)
        return { status: STATUS.GAP, ...evidence(e, line, '只吊销单 slug，其它班级旧令牌仍有效') }
      }
      return { status: STATUS.UNKNOWN, ...evidence(e, e.line, '未找到会话吊销调用') }
    },
  },
  {
    id: 'auth.session_opts_key',
    title: '登录保持天数必须按账号名取键',
    applies: (ctx, e) => e.kind === 'target-file' && /routes\/auth\.js$/.test(e.file),
    check(ctx, e) {
      const bad = ctx.findLine(e.file, /signOptsFor\(\s*user\.dbSlug/)
      if (bad) return { status: STATUS.GAP, ...evidence(e, bad, 'signOptsFor 传 dbSlug，设置按 username 存') }
      const good = ctx.findLine(e.file, /signOptsFor\(\s*user\.username/)
      if (good) return { status: STATUS.PASS, ...evidence(e, good, '键与 authPolicy 一致') }
      return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未找到 signOptsFor 调用') }
    },
  },
  {
    id: 'auth.recovery_rename_fallback',
    title: '本机恢复必须兼容改名后的用户名',
    applies: (ctx, e) => e.kind === 'route' && e.file.endsWith('routes/auth.js') && /db-recover/.test(e.apiPath),
    check(ctx, e) {
      const src = functionBody(ctx, e, e.line)
      if (!/resolveByUsername/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '该入口不按用户名解析') }
      if (/findFirstUser\s*\(|resolveByUsername\([^)]*\)\s*\|\|/.test(src)) {
        const line = ctx.findLine(e.file, /findFirstUser\s*\(|resolveByUsername\([^)]*\)\s*\|\|/)
        return { status: STATUS.PASS, ...evidence(e, line, '改名后仍有兜底认人') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '按新名查不到就直接失败，改名后无法本机恢复') }
    },
  },
  {
    id: 'undo.cascade_delete_snapshot',
    title: '批量删学生必须登记级联撤销快照',
    applies: (ctx, e) => e.kind === 'target-file' && /ai\.dataRoutes\.js$/.test(e.file),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (!/purgeStudentRelations/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '未发现级联清理') }
      if (/=\s*purgeStudentRelations\s*\(/.test(src) && /student_cascade_delete/.test(src)) {
        const line = ctx.findLine(e.file, /student_cascade_delete/)
        return { status: STATUS.PASS, ...evidence(e, line, '保留返回值并登记级联撤销') }
      }
      return { status: STATUS.GAP, ...evidence(e, ctx.findLine(e.file, /purgeStudentRelations/) || 1, '丢弃级联结果，撤销只恢复主表') }
    },
  },
  {
    id: 'account.rename_list_visibility',
    title: '账号改名不得让其它班级从登录列表消失',
    applies: (ctx, e) => e.kind === 'target-file' && /dbManager\.account\.js$/.test(e.file),
    check(ctx, e) {
      const line = ctx.findLine(e.file, /function\s+registryListValid|registryListValid\s*=/)
      if (!line) return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未找到 registryListValid') }
      const body = functionBody(ctx, e, line)
      if (/WHERE\s+username\s*=\s*\?|registry\.username/.test(body)) {
        return { status: STATUS.GAP, ...evidence(e, line, '按 registry.username 过滤，改名后其它班被隐藏') }
      }
      if (/findFirstUser|slug/.test(body)) return { status: STATUS.PASS, ...evidence(e, line, '不再假设 registry 名与库内用户名一致') }
      return { status: STATUS.UNKNOWN, ...evidence(e, line, '判据需人工确认') }
    },
  },
  {
    id: 'write.sanitize_gate',
    title: '课表 cells 写入必须过 sanitizeField',
    applies: (ctx, e) => e.kind === 'route' && /routes\/schedule\.js$/.test(e.file) && e.method === 'PUT',
    check(ctx, e) {
      const src = functionBody(ctx, e, e.line)
      if (!/cells/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '该 PUT 不写 cells') }
      if (/sanitizeField\([^)]*['"]cells['"]/.test(src)) {
        const line = ctx.findLine(e.file, /sanitizeField\([^)]*['"]cells['"]/)
        return { status: STATUS.PASS, ...evidence(e, line, 'cells 走统一清洗') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '只做 Array.isArray，坏载荷可入库') }
    },
  },
  {
    id: 'seat.single_cell_validation',
    title: '座位单格写入必须复用统一校验',
    // 只针对真正的「单格」写入口：PATCH /cell 与 PATCH /master/cell。
    // 原先 applies 覆盖 seats.js 的所有 POST/PUT/PATCH，把 /weight、/draft、/settings、
    // /snapshot、/history/week 这些「整表/元数据写入」也算进来，报出一批假 GAP；
    // 整表写的矩阵规范化是另一条不变量（快照/周历史见 4-10）。
    applies: (ctx, e) => e.kind === 'route' && /routes\/seats\.js$/.test(e.file) && e.method === 'PATCH' && /\/cell$/.test(e.apiPath),
    check(ctx, e) {
      const RE = /writeSeatCell|seatWrite|validateRow|assertHolesEmpty/
      // writeSeatCell 是 services/seatWrite.js 的导出名；旧正则只认模块名 seatWrite，
      // 于是「已经全部收敛到 writeSeatCell」的两个 handler 被误判成绕过（4-4 复核结论）。
      let src = functionBody(ctx, e, e.line)
      if (!RE.test(src)) {
        // 单行注册（router.patch('/cell', cellPatchHandler('seat_layout'))）时，
        // functionBody 从注册行抓不到 handler 体 —— 真正的函数体在工厂函数里，跟过去看。
        const rawLine = ctx.cleanLines(e.file)[e.line - 1] || ''
        const factory = (rawLine.match(/\b([A-Za-z_$][\w$]*Handler)\s*\(/) || [])[1]
        if (factory) {
          const fl = ctx.findLine(e.file, new RegExp(`function\\s+${factory}\\s*\\(`))
          if (fl) src = functionBody(ctx, e, fl)
        }
      }
      if (RE.test(src)) {
        const line = ctx.findLine(e.file, RE)
        return { status: STATUS.PASS, ...evidence(e, line, '单格写入复用统一校验') }
      }
      return { status: STATUS.GAP, ...evidence(e, e.line, '单格写绕过 seatWrite/validateRow') }
    },
  },
  {
    id: 'undo.cell_layout_guard',
    title: '撤销回写格子前必须校验布局边界',
    applies: (ctx, e) => e.kind === 'target-file' && /undo\.executors\.js$/.test(e.file),
    check(ctx, e) {
      // grid_cell 的边界校验落在两处：全局上限（SEAT_MAX_ROWS/SEAT_MAX_GRID_COLS）+
      // 当前布局（currentSeatGeometry 比 rows/cols）。旧判据只认 assertCellInLayout 这个名字，
      // 实际实现叫 currentSeatGeometry，被误判成「只卡 50×60 上限」（4-5 复核结论）。
      const line = ctx.findLine(e.file, /currentSeatGeometry|assertCellInLayout/)
      if (line) return { status: STATUS.PASS, ...evidence(e, line, '回写前校验行列在当前布局内') }
      return { status: STATUS.GAP, ...evidence(e, 1, '只校验 50×60 上限，不校验当前布局') }
    },
  },
  {
    id: 'undo.geometry_authoritative',
    title: '撤销几何必须以库内值为权威',
    applies: (ctx, e) => e.kind === 'target-file' && /undo\.executors\.js$/.test(e.file),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (!/oldCols|newCols|oldRows|newRows/.test(src)) return { status: STATUS.NA, ...evidence(e, 0, '未发现几何透传字段') }
      if (/oldCols|newCols|oldRows|newRows/.test(src)) {
        // 现在的口径：几何从快照自带的 types 形状推导（geometryOfSnapshot），
        // 前端另传的 old/new 几何不再采信，不一致只打 warn（warnGeometryDrift）。
        // 旧判据只认 authoritative/dbLayout 这些名字，实现用的是 geometryOfSnapshot —— 误报（4-5）。
        if (/geometryOfSnapshot|warnGeometryDrift|authoritative|dbLayout|readLayout|fetchLayout/.test(src)) {
          const line = ctx.findLine(e.file, /geometryOfSnapshot|warnGeometryDrift|authoritative|dbLayout|readLayout|fetchLayout/)
          return { status: STATUS.PASS, ...evidence(e, line, '几何按快照 types 推导，不采信透传值') }
        }
        return { status: STATUS.GAP, ...evidence(e, ctx.findLine(e.file, /oldCols|newCols/) || 1, '采信前端透传的 old/new 几何') }
      }
      return { status: STATUS.NA, ...evidence(e, 0, '未发现几何透传字段') }
    },
  },
  {
    id: 'process.kill_tree_detached',
    title: '长生命周期子进程必须可整树清理',
    applies: (ctx, e) => e.kind === 'target-file' && /main\.backend\.js$/.test(e.file),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      // 整树清理有两条路，二选一即可：
      //   ① spawn detached:true + kill(-pid) 进程组杀；
      //   ② taskkill /PID /T /F（Windows 按 PID 连孙进程一起杀，不要求 detached）。
      // 后端是 fork（不提供 detached 选项），走的是 ②；
      // 老判据要求 detached && tree 会把这条已修实现误判 GAP。
      const tree = /taskkill|kill\s*\(\s*-|killTree/.test(src)
      if (tree) {
        const line = ctx.findLine(e.file, /taskkill|kill\s*\(\s*-|killTree/)
        return { status: STATUS.PASS, ...evidence(e, line, '具备整树清理（进程组杀 / taskkill \/T / killTree 工具）') }
      }
      return { status: STATUS.GAP, ...evidence(e, 1, '未见整树清理，裸 kill 会留孙进程') }
    },
  },
  {
    id: 'process.startup_singleflight',
    title: '后端启动必须有单飞守卫',
    applies: (ctx, e) => e.kind === 'target-file' && /main\.backend\.js$/.test(e.file),
    check(ctx, e) {
      // 两种接线都算单飞：老写法在 backend.js 内部自己存 Promise，新写法用
      // main.single-flight.js 的 createSingleFlight 包住 startBackend。
      // 只认老写法会把已修的实现误判 GAP（v7 7-3 复核踩到）。
      const line = ctx.findLine(e.file,
        /if\s*\(\s*starting\s*\)|startingPromise|startPromise|startBackend\s*=\s*createSingleFlight|createSingleFlight\(/)
      if (line) return { status: STATUS.PASS, ...evidence(e, line, '并发启动复用同一 Promise') }
      return { status: STATUS.GAP, ...evidence(e, 1, '未见单飞守卫，重复启动会抢端口') }
    },
  },
  {
    id: 'ipc.save_result_discriminator',
    title: '保存结果必须区分成功/取消/失败',
    applies: (ctx, e) => e.kind === 'frontend-file' && e.meta.usesSaveFile,
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (/result\.outcome|outcome\s*===|outcome\s*!==/.test(src)) {
        const line = ctx.findLine(e.file, /result\.outcome|outcome\s*===|outcome\s*!==/)
        return { status: STATUS.PASS, ...evidence(e, line, '消费方检查 outcome') }
      }
      if (/result\.canceled/.test(src)) {
        const line = ctx.findLine(e.file, /result\.canceled/)
        return { status: STATUS.GAP, ...evidence(e, line, '只看 canceled，失败也被当成已保存') }
      }
      // 间接消费：文件只调 saveFile(...) 并把结果透传/忽略，三态判定在统一封装里。
      // saveFile.js 用 classifySaveResult 把 outcome 分成 ok/canceled/fail（取消吞掉、失败抛出），
      // 这本身就是完整的三态区分；矩阵原先在这里报 UNKNOWN 是判据没认出这条链路（7-9 人工复核）。
      if (/saveFile\s*\(/.test(src)) {
        const wrapper = ctx.read('student-frontend/src/utils/saveFile.js')
        if (/classifySaveResult/.test(wrapper) && /kind === 'canceled'/.test(wrapper) && /throw new Error/.test(wrapper)) {
          const line = ctx.findLine(e.file, /saveFile\s*\(/)
          return { status: STATUS.PASS, ...evidence(e, line, '经统一 saveFile 封装消费三态（取消返回空串、失败抛异常）') }
        }
        return { status: STATUS.GAP, ...evidence(e, 1, '调 saveFile 但封装未做三态区分') }
      }
      return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未发现保存结果消费点') }
    },
  },
  {
    id: 'async.inflight_cleanup',
    title: '批量加载必须在 finally 清 in-flight 键',
    applies: (ctx, e) => e.kind === 'frontend-file' && e.meta.usesInflight,
    check(ctx, e) {
      if (/finally\s*\{/.test(codeOf(ctx, e))) {
        const line = ctx.findLine(e.file, /finally\s*\{/)
        return { status: STATUS.PASS, ...evidence(e, line, '异常路径也清理') }
      }
      return { status: STATUS.GAP, ...evidence(e, ctx.findLine(e.file, /inFlight|inflight/) || 1, '只在成功路径 delete，失败后永久中毒') }
    },
  },
  {
    id: 'auth.session_idle_ttl',
    title: '滑动续期会话必须刷新最后活动时间',
    applies: (ctx, e) => e.kind === 'target-file' && /services\/sessions\.js$/.test(e.file),
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (!/has\s*\(/.test(src)) return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未找到 has(sid) 判据') }
      if (/touch|at\s*[:=]\s*(?:now|Date\.now)|lastActive|lastSeen/.test(src)) {
        const line = ctx.findLine(e.file, /touch|at\s*[:=]\s*(?:now|Date\.now)|lastActive|lastSeen/)
        return { status: STATUS.PASS, ...evidence(e, line, '命中会话会刷新时间') }
      }
      return { status: STATUS.GAP, ...evidence(e, ctx.findLine(e.file, /has\s*\(/) || 1, 'has(sid) 不刷新 at，TTL 按登录时间算') }
    },
  },
  {
    id: 'privacy.write_scope',
    title: '「完全禁止」必须同时阻断写入',
    applies: (ctx, e) => e.kind === 'privacy-file',
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (/privacy\.shared\.js$/.test(e.file)) {
        const line = ctx.findLine(e.file, /lv\s*===\s*['"]none['"]/)
        if (!line) return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未找到 none 分支') }
        const targetLine = ctx.cleanLines(e.file)[line - 1] || ''
        if (/readonly_tables|ro\.add/.test(targetLine)) {
          return { status: STATUS.PASS, ...evidence(e, line, 'none 同时写入只读集合') }
        }
        return { status: STATUS.GAP, ...evidence(e, line, 'none 只写 closed_tables；写闸门只看 readonly_tables，可绕过') }
      }
      if (/closed_tables/.test(src)) {
        const line = ctx.findLine(e.file, /closed_tables/)
        return { status: STATUS.PASS, ...evidence(e, line, '写作用域包含 closed_tables') }
      }
      return { status: STATUS.GAP, ...evidence(e, 1, '写作用域只检查 readonly_tables，未包含 closed_tables') }
    },
  },
  {
    id: 'dev.subwindow_identity',
    title: '开发子窗口加载前必须校验页面身份',
    applies: (ctx, e) => e.kind === 'electron-file' && /main\.dev-loader\.js$/.test(e.file),
    check(ctx, e) {
      const line = ctx.findLine(e.file, /function\s+loadUrlWithRetry|const\s+loadUrlWithRetry/)
      if (!line) return { status: STATUS.UNKNOWN, ...evidence(e, 1, '未找到 loadUrlWithRetry') }
      const body = functionBody(ctx, e, line)
      if (/looksLikeOurVite/.test(body)) {
        return { status: STATUS.PASS, ...evidence(e, line, '子窗口加载路径有身份校验') }
      }
      return { status: STATUS.GAP, ...evidence(e, line, 'loadUrlWithRetry 只探测 HTTP 200，未校验页面身份') }
    },
  },
  // updater.spawn_error 已移除：批次 52 把静默 spawn(/SILENT) 改为 shell.openPath 交给 Windows 安装向导，
  // 这条针对 spawn 的不变量失去适用对象（恒 UNKNOWN）。openPath 失败的用户可见兜底由
  // testjs/units/desktop/updater-manual-install.test.js「openPath 失败：报错但应用不退出」守着。
  {
    id: 'undo.idempotency',
    title: '撤销方向回写必须 CAS',
    applies: (ctx, e) => e.kind === 'undo-file',
    check(ctx, e) {
      const src = codeOf(ctx, e)
      if (/dir\s*=\s*\?[\s\S]{0,80}AND\s+dir\s*=\s*\?|AND\s+dir\s*=\s*\?/.test(src)) {
        const line = ctx.findLine(e.file, /AND\s+dir\s*=\s*\?/)
        return { status: STATUS.PASS, ...evidence(e, line, '已找到方向 CAS 条件') }
      }
      return { status: STATUS.GAP, ...evidence(e, 1, '未找到方向 CAS 条件') }
    },
  },
]

function runAudit({ root = DEFAULT_ROOT, date = new Date().toISOString().slice(0, 10), outDir = DEFAULT_OUT, write = false } = {}) {
  const ctx = makeCtx(root)
  const entries = collectEntries(ctx)
  const cells = []
  for (const entry of entries) {
    for (const inv of INVARIANTS) {
      if (!inv.applies(ctx, entry)) continue
      let result
      try {
        result = inv.check(ctx, entry)
      } catch (err) {
        result = { status: STATUS.UNKNOWN, evidence: entry.file, note: `检查器异常：${err.message}` }
      }
      cells.push({
        invariant: inv.id,
        title: inv.title,
        findingKey: (entry.kind === 'route' || entry.kind === 'ipc')
          ? `${inv.id}:${entry.id}`
          : `${inv.id}:${entry.file}`,
        entry: entry.id,
        kind: entry.kind,
        file: entry.file,
        line: entry.line,
        status: result.status,
        evidence: result.evidence || entry.file,
        note: result.note || '',
      })
    }
  }
  const byStatus = { PASS: 0, GAP: 0, UNKNOWN: 0, 'N/A': 0 }
  for (const c of cells) byStatus[c.status] = (byStatus[c.status] || 0) + 1
  const uniqueGAP = new Set(cells.filter((c) => c.status === STATUS.GAP).map((c) => c.findingKey)).size
  const uniqueUnknown = new Set(cells.filter((c) => c.status === STATUS.UNKNOWN).map((c) => c.findingKey)).size
  const byInvariant = INVARIANTS.map((inv) => {
    const own = cells.filter((c) => c.invariant === inv.id)
    return {
      id: inv.id,
      title: inv.title,
      total: own.length,
      PASS: own.filter((c) => c.status === STATUS.PASS).length,
      GAP: own.filter((c) => c.status === STATUS.GAP).length,
      UNKNOWN: own.filter((c) => c.status === STATUS.UNKNOWN).length,
    }
  })
  const result = {
    root,
    date,
    entries,
    cells,
    summary: { entries: entries.length, cells: cells.length, byStatus, uniqueGAP, uniqueUnknown },
    invariants: byInvariant,
  }
  result.markdown = renderMarkdown(result)
  if (write) {
    fs.mkdirSync(outDir, { recursive: true })
    const mdPath = path.join(outDir, `coverage-matrix-${date}.md`)
    const jsonPath = path.join(outDir, `coverage-matrix-${date}.json`)
    fs.writeFileSync(mdPath, result.markdown, 'utf8')
    fs.writeFileSync(jsonPath, JSON.stringify({
      date,
      summary: result.summary,
      invariants: result.invariants,
      cells: result.cells,
    }, null, 2) + '\n', 'utf8')
    result.written = { mdPath, jsonPath }
  }
  return result
}

function renderMarkdown(result) {
  const { summary, cells, invariants, date } = result
  const lines = []
  lines.push(`# v7 覆盖矩阵（生成于 ${date}）`)
  lines.push('')
  lines.push('> 本文件由 `testjs/tools/audit-coverage.mjs` 生成，不要手改。')
  lines.push('> 覆盖单位是「入口 × 不变量」，不是「文件被读过」。`GAP` 与 `UNKNOWN` 都算未覆盖。')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push(`- 入口：${summary.entries}`)
  lines.push(`- 适用格子：${summary.cells}`)
  lines.push(`- 状态：PASS ${summary.byStatus.PASS} · GAP ${summary.byStatus.GAP} · UNKNOWN ${summary.byStatus.UNKNOWN}`)
  lines.push(`- 去重后待处置：GAP ${summary.uniqueGAP} 项 · UNKNOWN ${summary.uniqueUnknown} 项`)
  lines.push('')
  lines.push('## 不变量覆盖')
  lines.push('')
  lines.push('| 不变量 | 说明 | 适用 | PASS | GAP | UNKNOWN |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const inv of invariants) {
    lines.push(`| ${inv.id} | ${inv.title} | ${inv.total} | ${inv.PASS} | ${inv.GAP} | ${inv.UNKNOWN} |`)
  }
  for (const status of ['GAP', 'UNKNOWN']) {
    lines.push('')
    lines.push(`## ${status} 明细`)
    for (const inv of invariants.filter((x) => x[status] > 0)) {
      lines.push('')
      lines.push(`### ${inv.id} · ${inv.title}`)
      lines.push('')
      lines.push('| 入口 | 证据 | 说明 |')
      lines.push('| --- | --- | --- |')
      for (const c of cells.filter((x) => x.invariant === inv.id && x.status === status)) {
        lines.push(`| ${c.entry} | ${c.evidence} | ${String(c.note).replace(/\|/g, '\\|')} |`)
      }
    }
  }
  lines.push('')
  lines.push('## 完整矩阵')
  lines.push('')
  lines.push('| 入口 | 不变量 | 状态 | 证据 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const c of cells) {
    lines.push(`| ${c.entry} | ${c.invariant} | ${c.status} | ${c.evidence} | ${String(c.note).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function parseArgs(argv) {
  const opt = { root: DEFAULT_ROOT, outDir: DEFAULT_OUT, date: new Date().toISOString().slice(0, 10), reportOnly: false }
  for (const arg of argv) {
    if (arg === '--report-only') opt.reportOnly = true
    else if (arg.startsWith('--root=')) opt.root = path.resolve(arg.slice(7))
    else if (arg.startsWith('--out-dir=')) opt.outDir = path.resolve(arg.slice(10))
    else if (arg.startsWith('--date=')) opt.date = arg.slice(7)
  }
  return opt
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const result = runAudit({ root: opt.root, outDir: opt.outDir, date: opt.date, write: !opt.reportOnly })
  console.log(`入口 ${result.summary.entries} · 格子 ${result.summary.cells} · PASS ${result.summary.byStatus.PASS} · GAP ${result.summary.byStatus.GAP} · UNKNOWN ${result.summary.byStatus.UNKNOWN}`)
  if (result.written) console.log(`已写入 ${result.written.mdPath}\n已写入 ${result.written.jsonPath}`)
  const blocking = result.summary.byStatus.GAP + result.summary.byStatus.UNKNOWN
  if (!opt.reportOnly && blocking > 0) {
    console.error(`未覆盖 ${blocking} 格；覆盖检查失败。`)
    process.exit(1)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()

export { runAudit, collectEntries, INVARIANTS, STATUS }
