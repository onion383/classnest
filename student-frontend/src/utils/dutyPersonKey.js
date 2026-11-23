// ===== 值日排表 / 指数里「人」的统一标识 =====
// key 有两种形态：
//   id:<学生id>   名册里的人（含临时学生）—— 身份明确，同名两人互不干扰
//   name:<姓名>   名册外的人、或历史快照里同名分不清的字符串 —— 只能按姓名认
//
// 为什么要这一层：排表的公平账本要按**身份**统计（两个同名的人各算各的），
// 而值日格里的历史数据、名册外手工输入的名字只有姓名。内部统一用 key，
// 只在「读格子 / 写格子 / 显示」三个边界转换 —— 转换函数只此一份，
// 散落到各处就会两套值域混用（表现是预览显示数字、确认后写回字符串）。
//
// 纯函数，不依赖 Vue：单测直接跑真实源码（不要另写一份实现，那等于测自己）。

export function buildNameById(students) {
  const m = new Map()
  for (const s of students || []) {
    if (s && s.id != null) m.set(Number(s.id), String(s.姓名 == null ? '' : s.姓名))
  }
  return m
}

// 姓名 → id，只放唯一命中的名字：同名两人无从判断，宁可退回 name: 形态，
// 也不能随便挑一个 —— 挑错等于把 A 的值日记到 B 头上，数字还看着很正常。
export function buildIdByName(nameById) {
  const m = new Map()
  const dup = new Set()
  for (const [id, name] of nameById || []) {
    const n = String(name == null ? '' : name).trim()
    if (!n) continue
    if (m.has(n)) dup.add(n)
    else m.set(n, id)
  }
  for (const n of dup) m.delete(n)
  return m
}

/**
 * 业务记录（带 student_id / 姓名 两个字段，如成绩、请假、成员行）属于谁。
 * 有稳定引用就只认 id —— 名册里两个同名的人必须各算各的；缺 id 的历史行才退回姓名。
 * 成绩统计、请假统计、点名候选等「按人聚合」的地方统一走这里，别各自再写一份。
 */
export function personKeyOfRecord(r) {
  if (!r) return ''
  const raw = r.student_id
  const asId = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  if (Number.isFinite(asId) && asId > 0) return `id:${asId}`
  return keyOfValue(r.姓名, null) || 'name:'
}

export function keyOfValue(v, idByName) {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return v > 0 ? `id:${v}` : ''
  if (typeof v === 'object') {
    // 历史快照里的对象形态：{student_id,name} / {id,姓名}
    const id = Number(v.student_id ?? v.id)
    if (Number.isInteger(id) && id > 0) return `id:${id}`
    const nm = String(v.name ?? v['姓名'] ?? '').trim()
    return nm ? `name:${nm}` : ''
  }
  const s = String(v).trim()
  if (!s) return ''
  // 已经是 key 形态就原样返回（草稿/预览之间来回转换时不能二次包一层 name:）
  if (s.startsWith('id:') || s.startsWith('name:')) return s
  const id = idByName ? idByName.get(s) : undefined
  return id != null ? `id:${id}` : `name:${s}`
}

export function valueOfKey(k) {
  if (!k) return ''
  if (k.startsWith('id:')) return Number(k.slice(3))
  if (k.startsWith('name:')) return k.slice(5)
  return k
}

export function nameOfKey(k, nameById) {
  if (!k) return ''
  if (k.startsWith('id:')) {
    const id = Number(k.slice(3))
    const n = nameById ? nameById.get(id) : undefined
    // 查不到姓名（学生已删 / 名册还没加载）显示 id 本身：宁可界面上出现数字，
    // 也不要变成空格 —— 空格看起来像「这里本来没人」
    return n == null ? `#${id}` : n
  }
  if (k.startsWith('name:')) return k.slice(5)
  return String(k)
}

// 整张表（项目 → 星期 → 人）在两个值域之间转换
function mapCells(cells, fn) {
  const out = {}
  for (const item of Object.keys(cells || {})) {
    const byDay = cells[item] || {}
    out[item] = {}
    for (const day of Object.keys(byDay)) {
      const arr = byDay[day]
      out[item][day] = Array.isArray(arr) ? arr.map(fn) : []
    }
  }
  return out
}

export function toKeyCells(cells, idByName) {
  return mapCells(cells, (v) => keyOfValue(v, idByName))
}

export function toValueCells(cells) {
  return mapCells(cells, valueOfKey)
}
