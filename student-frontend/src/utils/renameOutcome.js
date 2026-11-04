// =========================================================================
// renameOutcome.js —— 「改名级联结果」的判定（纯函数）
//
// 背景：学生改名时，后端会把「只存姓名」的关联表（值日表 / 座位表 / 加减分 /
// 请假 / 小组 / 班干部）一并改名。当旧名**仍有另一个同名学生**时，后端会
// 跳过级联（宁可不同步，也不能改错人），并在响应里回：
//
//   { renamed: { changed: false, skipped: 'duplicate-name', counts: {...} } }
//
// 但前端此前**完全不读这个字段** —— 用户看到的是「修改成功」，却不知道
// 值日表/座位表里还挂着旧名，历史值日指数从此归不到他名下，且界面不报任何错。
//
// 本模块把「这个响应意味着什么」收敛成一处纯函数，便于单测，也便于后端
// 将来加新的 skipped 原因时只改这一处。
// =========================================================================

// skipped 原因 → 给用户看的话
const SKIP_MESSAGES = {
  'duplicate-name': '有同名学生，改名未同步到值日表/座位表等关联记录，请手动核对',
};

/**
 * 判定一次改名请求的结果。
 * @param {object} res  axios 响应（或其 data）
 * @returns {{ skipped: boolean, message: string, counts: object }}
 *   skipped=true 时 message 是可直接展示给用户的提示；skipped=false 时 message 为空串。
 */
export function readRenameOutcome(res) {
  const data = (res && res.data !== undefined) ? res.data : res
  const renamed = data && typeof data === 'object' ? data.renamed : null
  if (!renamed || typeof renamed !== 'object') {
    return { skipped: false, message: '', counts: {} }
  }
  const counts = (renamed.counts && typeof renamed.counts === 'object') ? renamed.counts : {}
  const reason = typeof renamed.skipped === 'string' ? renamed.skipped : ''
  if (!reason) {
    return { skipped: false, message: '', counts }
  }
  return {
    skipped: true,
    message: SKIP_MESSAGES[reason] || `改名未同步到关联记录（${reason}），请手动核对`,
    counts,
  }
}
