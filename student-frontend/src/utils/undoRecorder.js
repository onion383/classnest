// =========================================================================
// undoRecorder.js —— 撤销登记的**唯一入口**（Q2-03~10 / §4-6 / §4-7）
//
// 根因不是「某几个页面忘了调 pushUndo」，而是登记一直被建模成调用点自愿行为：
//   · 全库曾有 6 种写法：useUndo.js 的 5 个平行封装、useTableCRUD 内联 pushUndo、
//     GroupManageView 直接 axios.post('/api/undo')、CadreManage 内联 pushUndo、
//     4 个相册组件内联 pushUndo、AI 执行器自己的 _pushUndo；
//   · 每个通道各自决定「失败了怎么办」，三条写成 .catch(() => {}) —— 操作已落库，
//     撤销栈里却没有这条，用户按 Ctrl+Z 才发现撤不回来（Q2-10）；
//   · 每个通道各自决定「成功后刷不刷 Ctrl+Z 可用态」，批次里逐条刷会打爆 /status。
//
// 所以这里把登记收成一件事：**调用方只描述「发生了什么」，入口负责校验、发送、
// 失败弱提示、成功后刷新可用态**。新增写路径只有这一条路可走，天然继承护栏。
//
// 本模块零静态依赖（副作用全部可注入），因此能被 node 单测直接 import 并断言行为；
// 真实运行时的默认副作用走惰性 import，装配点在 useUndo.js。
// =========================================================================

// 默认失败提示：console 一定留痕；通知组件惰性加载，不可用时只保留日志。
// 绝不能退化成静默 —— 那就是 Q2-10 本身。
export function warnUndoFailed(label, err) {
  const text = label ? `「${label}」已完成，但本次无法撤销` : '操作已完成，但本次无法撤销'
  console.warn('[undo] 登记撤销失败：', label || '', err || '')
  import('../composables/useNotification.js')
    .then(({ useNotification }) => useNotification().warning(text))
    .catch(() => { /* 通知不可用时仅保留日志 */ })
}

// 一次用户动作可能登记多条记录（拖一次座位改多格、批量删 N 行）。
// 同 origin 的记录后端 Ctrl+Z 时整批回退，一次动作一步退完。
export function newUndoBatchId() {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 新增/编辑接口的响应通常只带 id，但 row_insert/row_update 的 inverse 需要**完整行**
// （redo 会按真实列重建，position 这类列猜不得；学生改名还要靠 姓名 反向级联）。
// 统一在最近一次全表快照里按 id 取，取不到才用提交数据兜底 —— 各页面不再各写一份。
export function rowSnapshot(rows, id, fallback) {
  const found = Array.isArray(rows) ? rows.find(r => r && r.id === id) : null
  return found ? { ...found } : { ...(fallback || {}), id }
}

// 登记内容的合法性：不合法就不发请求，但仍要走失败提示。
// 漏 key/type 后端会 400，漏 payload 会写进一条永远无法执行的撤销记录 —— 两者都必须拦住。
export function validateUndoSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return '登记内容缺失'
  if (typeof spec.key !== 'string' || !spec.key.trim()) return '缺少表 key'
  if (typeof spec.type !== 'string' || !spec.type.trim()) return '缺少命令类型'
  if (!spec.payload || typeof spec.payload !== 'object' || Array.isArray(spec.payload)) return 'payload 必须是对象'
  return null
}

// 默认通道：没有装配也能工作（日志 + 请求），只是不刷 Ctrl+Z 可用态。
// 用惰性 import 而不是顶层 import，是为了让本模块保持零静态依赖、可单测。
const fallbackHooks = {
  transport(spec) {
    return import('../api/undo.js').then(({ pushUndo }) => pushUndo(spec))
  },
  notifyFailure: warnUndoFailed,
  // 装配由 useUndo.js 在模块加载时完成；App.vue 等入口静态导入它，应用里必然已装配。
  // 这里留空实现而不是动态 import：动态拉一个已被静态导入的模块只会让打包器
  // 报 INEFFECTIVE_DYNAMIC_IMPORT，且真实运行时根本走不到。
  onRegistered: () => {},
}

let hooks = null
function currentHooks() { return hooks || fallbackHooks }

// 装配真实副作用：transport 走全局 axios（安全通道）、notifyFailure 接通知、
// onRegistered 刷 Ctrl+Z 可用态。只在 useUndo.js 模块加载时调一次。
export function configureUndoRecorder(next) {
  if (!next || typeof next.transport !== 'function') throw new TypeError('configureUndoRecorder 需要 transport')
  hooks = {
    transport: next.transport,
    notifyFailure: next.notifyFailure || warnUndoFailed,
    onRegistered: next.onRegistered || (() => {}),
  }
}

// 仅供单测隔离：清掉装配，回到默认通道。
export function resetUndoRecorderForTest() { hooks = null }

// 登记一条撤销记录。
//   spec = { key, type, label, payload, origin?, refresh? }
//   refresh 缺省 = !origin（批次由调用方 flushUndoStatus 统一刷一次，不逐条发 /status）
//   返回 Promise<撤销记录 id | null>；失败一律返回 null 并提示，绝不把异常抛回主流程
//   —— 业务操作已经落库，抛回去只会让界面误报「操作失败」。
export function recordUndo(spec) {
  const h = currentHooks()
  const label = spec && spec.label ? String(spec.label) : ''
  const invalid = validateUndoSpec(spec)
  if (invalid) {
    h.notifyFailure(label, new Error(invalid))
    return Promise.resolve(null)
  }
  const body = {
    key: spec.key,
    type: spec.type,
    label,
    payload: spec.payload,
    origin: spec.origin || '',
  }
  const shouldRefresh = spec.refresh === undefined ? !body.origin : spec.refresh === true
  let pending
  try {
    pending = h.transport(body)
  } catch (err) {
    h.notifyFailure(label, err)
    return Promise.resolve(null)
  }
  return Promise.resolve(pending)
    .then((res) => {
      // 刷新可用态是附带动作，它炸了不能把「登记成功」伪装成失败
      if (shouldRefresh) {
        try { h.onRegistered() } catch (_) { /* 状态查询失败不打断用户 */ }
      }
      return (res && res.data && res.data.id) || null
    })
    .catch((err) => {
      h.notifyFailure(label, err)
      return null
    })
}
