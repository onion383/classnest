// ===== 成绩统计里的「人」标识与聚合（v7 §5-4 / #20）=====
//
// 事故面：个人加分统计原先按**姓名**聚合（`byId[r.姓名]`），今日人数也按姓名去重：
// 名册里两个「张子涵」各自加减的分会被合成一条，人数也只算一个。
// 记录本身是有 `student_id` 的（后端写入时已回填），所以这里改成按 id 认人，
// 姓名只用于显示；只有历史记录没有 id 时才退回按姓名。
//
// key 形态与值日排表共用同一套（utils/dutyPersonKey.js）：id:<id> / name:<姓名>。
// 不要另发明一套 —— 两套值域混用后，同一个人在不同页面会被算成两个人。

import { personKeyOfRecord } from './dutyPersonKey.js'

/** 一条成绩记录属于谁：优先 student_id，缺失才按姓名兜底（实现与请假统计共用一份）。 */
export const personKeyOf = personKeyOfRecord

/**
 * 个人成绩聚合。
 * @param {Array} records 个人记录（含 类型 / 分值 / 姓名 / 学号 / student_id）
 * @param {'add'|'sub'|'net'} mode
 * @returns {Array<{key: string, name: string, value: number, _max: number}>} 已按数值降序
 */
export function aggregatePersonal(records, mode = 'add') {
  const byKey = new Map()
  for (const r of records || []) {
    if (!r) continue
    const key = personKeyOf(r)
    let o = byKey.get(key)
    if (!o) {
      o = {
        key,
        name: String(r.姓名 == null ? '' : r.姓名).trim() || '未命名',
        xuehao: String(r.学号 == null ? '' : r.学号).trim(),
        add: 0,
        sub: 0,
      }
      byKey.set(key, o)
    }
    const v = Number(r.分值) || 0
    if (r.类型 === '扣分') o.sub += v
    else o.add += v
  }

  const rows = [...byKey.values()]
    .map((o) => ({
      key: o.key,
      name: o.name,
      xuehao: o.xuehao,
      value: mode === 'sub' ? o.sub : mode === 'net' ? o.add - o.sub : o.add,
    }))
    .filter((o) => o.value !== 0)
    .sort((a, b) => b.value - a.value)

  // 同名不同人：姓名后补上学号（没有学号就用 id），否则两行长得一模一样，
  // 用户会以为系统把一个人的分拆成了两条。
  const sameName = new Map()
  for (const r of rows) sameName.set(r.name, (sameName.get(r.name) || 0) + 1)
  for (const r of rows) {
    if (sameName.get(r.name) <= 1) continue
    const tag = r.xuehao || (String(r.key).startsWith('id:') ? `#${String(r.key).slice(3)}` : '')
    if (tag) r.name = `${r.name}（${tag}）`
  }

  // 空行集时 Math.max() = -Infinity，而 -Infinity 是 truthy，`max || 1` 兜不住（F05-05）。
  // 用 0 作为初值 + 非有限值兜底，进度条分母永远 ≥ 1。
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.value)))
  for (const r of rows) r._max = Number.isFinite(max) && max > 0 ? max : 1
  return rows
}

/** 去重人数：同名两人算两个。 */
export function countDistinctPeople(records) {
  const s = new Set()
  for (const r of records || []) {
    if (!r) continue
    s.add(personKeyOf(r))
  }
  return s.size
}
