// 级联删除学生 + 同事务撤销登记（V8 · 5-2 / Q2-01）
//
// 旧实现：app.js 路由在 db.transaction 内 purge 七处 + 删学生，但撤销快照只随响应回前端，
// 由前端第二次 POST /api/undo 登记。两次请求两个事务——期间崩溃/登记失败就留下
// 「七处已删、无栈可撤」，只能手工重建。
//
// 本服务把「七处清理 + 删学生 + 撤销登记」收进同一个 db.transaction：登记失败连同
// 数据一起回滚，绝不留下撤不回来的半截状态。与 MCP 提案 confirm() 的同事务登记同构。
//
// 依赖全局 db Proxy（按当前请求的 ALS 绑定连接）；调用方必须在 withDb 上下文里调用。
// 撤销执行器 student_cascade_delete 的 payload 契约见 undo.executors.js:545-585，
// snapshot 形状（student 整行 + 六类关联行/计数）见 studentRelations.js:227-270。
const { db } = require('../db')
const { deleteRow } = require('./tableService')
const { purgeStudentRelations } = require('./studentRelations')
const undoStore = require('./undoStore')

// 六类关联一律全删。不保留「只删部分」的口径：
// 新库 student_id 上有 ON DELETE CASCADE，删主表时数据库会把没被应用层 purge 掉的关联
// 一起带走，而撤销快照只记应用层删的那些 —— 用户勾了「保留」的行静默消失且撤不回来。
// 全删后 purge 收进快照的正好是 CASCADE 会删的那一批，快照完整、撤销能整条还原。
// CASCADE 从「绕过勾选的捣乱者」退成「应用层漏清时的兜底」，两条路径删同一批行。
const ALL_RELATIONS = Object.freeze({
  leave: true, score: true, seat: true, duty: true, group: true, cadre: true,
})

/**
 * 删学生并级联清理全部关联，撤销快照与数据同事务落库。
 * @param {number} id 学生 id
 * @returns {{ removed: object, undoId: number|string }}
 */
function deleteStudentCascade(id) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id)
  if (!student) {
    const err = new Error('学生不存在')
    err.code = 'NOT_FOUND'
    throw err
  }

  let removed = null
  let undoId = null
  db.transaction(() => {
    removed = { student, ...purgeStudentRelations(student, ALL_RELATIONS) }
    // 六类关联已由 purge 全清，显式放行「删学生」的关联守卫：
    // 守卫只拦「没清就删主表」的直调，这里 purge 已经清完，放行不是留孤儿。
    deleteRow('students', id, { allowStudentOrphans: true })

    // 与数据同事务登记：INSERT undo_history 失败 → 七处清理和学生删除一起回滚。
    // origin='' → source='manual'（手工级联删除，与前端单条删除来源一致）。
    undoId = undoStore.push({
      key: 'students',
      type: 'student_cascade_delete',
      label: `删除学生「${student['姓名'] || `#${student.id}`}」及关联记录`,
      payload: removed,
      origin: '',
    })
  })()
  return { removed, undoId }
}

module.exports = { deleteStudentCascade }
