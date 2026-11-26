// ==================== 写与撤销登记同事务（V9-I-13 / Q2-01） ====================
//
// 根因：常规业务写是「先写数据 → 响应后前端第二次 POST /api/undo 补登记」。
// 两次请求之间崩溃、或第二次登记失败，就留下「有数据、撤销栈却没有」的状态——
// 用户按 Ctrl+Z 才发现撤不回来。
//
// 修法：前端把 undoSpec 随写请求一起发（body._undoSpec），后端在这一次请求的
// 同一个数据库事务里：写数据 → undoStore.push(spec) → 提交。响应带回 undoId，
// 前端见到 undoId 就不再发第二次登记。任一步失败整笔回滚，不会留半截。
//
// payload 仍由前端提供（单元格旧值、拖拽前后顺序、整块快照只有界面知道），
// 后端负责的是「登记与写入共存亡」这个原子性，不猜 payload。
//
// 边界：
//   · _undoSpec 是保留字段，必须在写表前从 body 移除，绝不能当列名落库。
//   · spec 非法（缺 key/type/payload）时不阻断业务写，按「无登记」处理并留日志——
//     登记是撤销能力，不该反过来让正常业务写失败。
//   · 嵌套事务：better-sqlite3 的 db.transaction 在已开启事务时退化为 SAVEPOINT，
//     本函数包住外层、tableService 内部还有自己的事务时，内层失败仍会回滚整笔。
// =========================================================================

const { db } = require('../db')
const undoStore = require('./undoStore')

// 从请求体取出 undoSpec 并移除保留字段。原地改 body（路由随后把它交给写函数）。
function takeUndoSpec(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const spec = body._undoSpec
  delete body._undoSpec
  return spec && typeof spec === 'object' ? spec : null
}

function validSpec(spec) {
  return !!spec && typeof spec.key === 'string' && !!spec.key.trim()
    && typeof spec.type === 'string' && !!spec.type.trim()
    && !!spec.payload && typeof spec.payload === 'object' && !Array.isArray(spec.payload)
}

// 在单事务里执行 writeFn() 并登记撤销。返回 { ...writeResult, undoId }。
// 一写多登记（如改职务同时改名字和名额）：spec 传数组，全部在同一事务里登记，
// 响应回 undoIds 数组，前端据此跳过多次二次 POST。
// 没有合法 spec 时退化为直接 writeFn()（兼容不带撤销的调用方，如接口/脚本）。
// buildPayload(writeResult) 可选：payload 依赖写结果（新建 id、后端算出的 tree/removed）时，
// 由后端在同事务里用写结果生成，前端只传 key/type/label + 已知部分（payloadHint）。
// 这样「写」和「登记 payload 的生成」都在同一请求/事务内，不留跨请求窗口。
function writeWithUndo(spec, writeFn, buildPayload) {
  const specs = (Array.isArray(spec) ? spec : [spec]).filter(validSpec)
  if (!specs.length) return writeFn()
  return db.transaction(() => {
    const result = writeFn() || {}
    const ids = []
    for (const s of specs) {
      // 第三参 spec 供一写多登记时按 type 分派；已有两参调用不受影响。
      const payload = typeof buildPayload === 'function' ? buildPayload(result, s.payload, s) : s.payload
      // buildPayload 返回 null 表示「没有实际变化，不该登记」（如拖拽前后顺序相同）
      if (payload == null) { ids.push(null); continue }
      ids.push(undoStore.push({
        key: s.key,
        type: s.type,
        label: typeof s.label === 'string' ? s.label : '',
        payload,
        origin: typeof s.origin === 'string' ? s.origin : '',
      }))
    }
    const realIds = ids.filter((id) => id != null)
    // 单条仍回 undoId（兼容已接入的点）；多条回 undoIds 数组。
    return realIds.length === 1 ? { ...result, undoId: realIds[0] }
      : realIds.length > 1 ? { ...result, undoIds: realIds } : result
  })()
}

module.exports = { takeUndoSpec, validSpec, writeWithUndo }
