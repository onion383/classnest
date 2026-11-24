// =========================================================================
// studentLabel.js —— 学生候选项的统一显示文案
//
// 为什么要有这一层：名册里可能有同名同姓的两个人，候选列表只显示姓名时
// 用户分不清点的是谁。统一显示「姓名 · 学号」，临时学生没有学号就标「临时」。
// 只管显示，不参与写入（格子里该存姓名还是 id 由各调用方自己决定）。
// =========================================================================

/**
 * 候选项显示文案。
 * @param {string} name 姓名
 * @param {string|number|null|undefined} xuehao 学号（临时学生为空）
 * @returns {string} 「姓名 · 学号」或「姓名 · 临时」
 */
export function formatStudentLabel(name, xuehao) {
  const n = String(name == null ? '' : name).trim()
  const x = String(xuehao == null ? '' : xuehao).trim()
  return x ? `${n} · ${x}` : `${n} · 临时`
}

/**
 * 从学生行取候选显示文案。行结构来自 /api/students（含 姓名 / 学号）。
 * @param {{姓名?: string, 学号?: string|number}} student
 * @returns {string}
 */
export function studentRowLabel(student) {
  const s = student || {}
  return formatStudentLabel(s.姓名, s.学号)
}
