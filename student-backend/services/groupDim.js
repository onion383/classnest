// ==================== 分组（维度 / 小组 / 成员）的 SQL 出口 ====================
// 档 C · M12-B1：分组路由只保留 HTTP 形状、上限常量与「内置宿舍组 vs 普通维度」的分支判断，
// 语句与「读多次再写多次」的复合操作收在这里。
//
// 放进 service 的判据：这条操作如果**必须在一个事务里**才能保持一致性（增删组时的重排、
// 成员移动、导入的合并追加），整条搬进来 —— 事务边界跟着数据操作走，路由只收结果。
// 反过来，能由路由先算出来的判断（维度存不存在、是不是内置、组数/人数上限）仍留在路由。
const { db } = require('../db')
const { ensureProvisionalStudent } = require('./provisionalStudents')

// ============ 维度 ============

// 确保存在内置的「宿舍组」默认维度（不可删除/不可改名，作为首页第一个 tab）
function ensureDefaultDimension() {
  const existing = db.prepare('SELECT * FROM group_dimensions WHERE is_default = 1').get()
  if (existing) return
  const existsByName = db.prepare('SELECT * FROM group_dimensions WHERE name = ?').get('宿舍组')
  const tx = db.transaction(() => {
    // 若已有同名普通维度，直接升级为默认；否则新建
    if (existsByName) {
      db.prepare('UPDATE group_dimensions SET is_default = 1, sort_order = 1 WHERE id = ?').run(existsByName.id)
    } else {
      db.prepare(
        `INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order, male_group_count, female_group_count) VALUES (?, '宿舍长', 6, 0, 1, 1, 0, 0)`
      ).run('宿舍组')
    }
  })
  tx()
}

// 列出所有分组维度（先确保内置默认维度存在）
function listDimensions() {
  ensureDefaultDimension()
  return db.prepare('SELECT * FROM group_dimensions ORDER BY sort_order, id').all()
}

// 维度原始行（含 is_default / 各类上限），供路由做分支与前缀判断
function dimensionById(id) {
  return db.prepare('SELECT * FROM group_dimensions WHERE id = ?').get(id)
}

// 读取某个维度及全部组/成员
function loadDimension(dimId) {
  const dim = dimensionById(dimId)
  if (!dim) return null
  const groups = db.prepare('SELECT id, name, gender, sort_order FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
  const membersStmt = db.prepare('SELECT id, group_id, member_name, remark FROM group_members WHERE group_id = ? ORDER BY sort_order, id')
  const data = groups.map(g => ({ ...g, members: membersStmt.all(g.id) }))
  return { dimension: dim, groups: data }
}

// 新增维度（按组数自动初始化小组）；返回新维度 id
function createDimension({ name, leaderTitle = '', membersPerGroup = 0, groupCount = 0 }) {
  const maxSort = db.prepare('SELECT MAX(sort_order) AS max FROM group_dimensions').get().max || 0
  const tx = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, sort_order) VALUES (?, ?, ?, ?, ?)`
    ).run(String(name).trim(), String(leaderTitle).trim(), membersPerGroup, groupCount, maxSort + 1)
    const dimId = result.lastInsertRowid
    insertGroups(dimId, '', groupCount)
    return dimId
  })
  return tx()
}

// 内置宿舍组：组名不可改，只更新组长称呼 / 每组人数 / 男女生宿舍数，然后同步组
function updateDefaultDimension(id, { leaderTitle, membersPerGroup, maleCount, femaleCount }) {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE group_dimensions SET leader_title = ?, members_per_group = ?, male_group_count = ?, female_group_count = ? WHERE id = ?`
    ).run(leaderTitle, membersPerGroup, maleCount, femaleCount, id)
    syncGenderGroups(id, maleCount, femaleCount)
  })
  tx()
}

// 普通维度：更新四项设置并同步组数量
function updateDimension(id, { name, leaderTitle, membersPerGroup, groupCount }) {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE group_dimensions SET name = ?, leader_title = ?, members_per_group = ?, group_count = ? WHERE id = ?`
    ).run(name, leaderTitle, membersPerGroup, groupCount, id)
    syncGroups(id, groupCount)
  })
  tx()
}

// 删除维度的排序快照：必须取**删除前**的值 —— 删除后会把剩余维度重排成 1..n，
// 撤销时若只重插维度行，其余维度的 sort_order 已被改过，顺序回不到原样。
function dimensionSortSnapshot() {
  return db.prepare('SELECT id, sort_order FROM group_dimensions ORDER BY sort_order, id').all()
}

// 删除维度（级联组与成员 + 重排剩余维度）；返回删除前的完整快照供撤销
function deleteDimension(id) {
  const dim = dimensionById(id)
  if (!dim) return null
  const groups = db.prepare('SELECT * FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(id)
  const groupIds = groups.map((g) => g.id)
  // 成员按组一次性取回（含 id / sort_order），撤销时可直接重建
  const members = groupIds.length
    ? db.prepare(`SELECT * FROM group_members WHERE group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY group_id, sort_order, id`).all(...groupIds)
    : []
  const sortOrders = dimensionSortSnapshot()
  const delMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?')
  const tx = db.transaction(() => {
    for (const g of groups) delMembers.run(g.id)
    db.prepare('DELETE FROM groups WHERE dimension_id = ?').run(id)
    db.prepare('DELETE FROM group_dimensions WHERE id = ?').run(id)
    renumberDimensions()
  })
  tx()
  return { dimension: dim, groups, members, sortOrders }
}

// 维度内部排序重排成 1..n
function renumberDimensions() {
  const rest = db.prepare('SELECT id FROM group_dimensions ORDER BY sort_order, id').all()
  const upd = db.prepare('UPDATE group_dimensions SET sort_order = ? WHERE id = ?')
  rest.forEach((r, i) => upd.run(i + 1, r.id))
}

// 上移 / 下移一个维度。返回 false 表示已到边界（路由据此回 400）。
// 「确保内置默认维度存在」是一个**写**，必须与排序更新同事务 ——
// 它若独立提交，用户在「排序到边界」时也会凭空多出一个维度。
function moveDimension(id, direction) {
  let moved = false
  const tx = db.transaction(() => {
    ensureDefaultDimension()
    const dims = db.prepare('SELECT * FROM group_dimensions ORDER BY sort_order, id').all()
    const idx = dims.findIndex(d => d.id === id)
    const target = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || target < 0 || target >= dims.length) return
    const tmp = dims[idx]; dims[idx] = dims[target]; dims[target] = tmp
    const upd = db.prepare('UPDATE group_dimensions SET sort_order = ? WHERE id = ?')
    // 逐条 UPDATE 也放进同一个事务：中途失败时排序不会只改一半
    dims.forEach((d, i) => upd.run(i + 1, d.id))
    moved = true
  })
  tx()
  return moved
}

// ============ 小组 ============

// 在维度下追加 count 个空小组（组名留空，由用户填写）
function insertGroups(dimId, baseName = '', count) {
  const maxSort = db.prepare('SELECT MAX(sort_order) AS max FROM groups WHERE dimension_id = ?').get(dimId).max || 0
  const stmt = db.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, ?)')
  for (let i = 0; i < count; i++) {
    stmt.run(dimId, baseName, maxSort + i + 1)
  }
}

// 将维度下的小组数量同步到 newCount：少了补、多了删（连同成员）
function syncGroups(dimId, newCount) {
  const existing = db.prepare('SELECT id FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
  if (existing.length < newCount) {
    insertGroups(dimId, '', newCount - existing.length)
  } else if (existing.length > newCount) {
    const removeList = existing.slice(newCount)
    const delMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?')
    const delGroup = db.prepare('DELETE FROM groups WHERE id = ?')
    for (const g of removeList) {
      delMembers.run(g.id)
      delGroup.run(g.id)
    }
    renumberGroups(dimId)
  }
}

// 宿舍（内置）维度：按 男生宿舍数 + 女生宿舍数 同步组，组名带编号并标记性别。
// 只在数量变化时增删差额，并统一规范组名与排序。
// 不能像原来那样「全删重建」：老师只是改一下每组人数 / 组长称呼，全班宿舍分配
//（谁在几号宿舍）就会被一起清空，而这一步没有写撤销记录，等于不可恢复。
function syncGenderGroups(dimId, maleCount, femaleCount) {
  const groups = db.prepare('SELECT id, gender FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
  // 老数据的 gender 可能为空：按「男」处理（原实现也是先男后女）
  const male = groups.filter(g => Number(g.gender) !== 1)
  const female = groups.filter(g => Number(g.gender) === 1)

  const delMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?')
  const delGroup = db.prepare('DELETE FROM groups WHERE id = ?')
  const updGroup = db.prepare('UPDATE groups SET name = ?, gender = ?, sort_order = ? WHERE id = ?')
  const insGroup = db.prepare('INSERT INTO groups (dimension_id, name, gender, sort_order) VALUES (?, ?, ?, ?)')

  let sort = 1
  const plans = [
    { list: male, count: maleCount, prefix: '男生宿舍', gender: 0 },
    { list: female, count: femaleCount, prefix: '女生宿舍', gender: 1 },
  ]
  plans.forEach(({ list, count, prefix, gender }) => {
    // 多出来的组从尾部删（连同成员）
    for (let i = count; i < list.length; i++) {
      delMembers.run(list[i].id)
      delGroup.run(list[i].id)
    }
    for (let i = 0; i < count; i++) {
      const name = `${prefix}${i + 1}`
      // 保留的组只改名/性别/排序，id 不变 → 成员分配原样留着
      if (i < list.length) updGroup.run(name, gender, sort++, list[i].id)
      else insGroup.run(dimId, name, gender, sort++)
    }
  })
}

function groupById(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id)
}

function groupCount(dimId) {
  return db.prepare('SELECT COUNT(*) AS c FROM groups WHERE dimension_id = ?').get(dimId).c
}

// 新增一个组（排到末尾）；返回新组 id
function addGroup(dimId, name) {
  const maxSort = db.prepare('SELECT MAX(sort_order) AS max FROM groups WHERE dimension_id = ?').get(dimId).max || 0
  const result = db.prepare(
    `INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, ?)`
  ).run(dimId, String(name).trim(), maxSort + 1)
  return result.lastInsertRowid
}

function renameGroup(id, name) {
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(String(name).trim(), id)
}

// 删除组（级联成员 + 同维度重排）
function deleteGroup(id, dimensionId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    renumberGroups(dimensionId)
  })
  tx()
}

function renumberGroups(dimId) {
  const rest = db.prepare('SELECT id FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
  const upd = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?')
  rest.forEach((r, i) => upd.run(i + 1, r.id))
}

// ============ 组成员 ============

function memberById(id) {
  return db.prepare('SELECT * FROM group_members WHERE id = ?').get(id)
}

function memberCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(groupId).c
}

// 新增成员：新名字也要有稳定身份 —— 解析/建档与写成员在同一个事务里，
// 避免「建了临时学生但成员没插进去」的半截状态。
function addMember(groupId, name, remark) {
  const maxSort = db.prepare('SELECT MAX(sort_order) AS max FROM group_members WHERE group_id = ?').get(groupId).max || 0
  let result
  let student = null
  db.transaction(() => {
    student = ensureProvisionalStudent(name)
    result = db.prepare(
      `INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?, ?, ?, ?)`
    ).run(groupId, name, String(remark).trim(), maxSort + 1)
  })()
  return { id: result.lastInsertRowid, student }
}

// 修改成员：改成新名字时同样解析/建档（与名册保持一致），与更新同事务。
// member_name 传 undefined 表示本次不改名。
function updateMember(id, { memberName, remark }) {
  const m = memberById(id)
  if (!m) return null
  const nextName = memberName !== undefined ? String(memberName).trim() : m.member_name
  db.transaction(() => {
    if (memberName !== undefined && nextName) ensureProvisionalStudent(nextName)
    db.prepare('UPDATE group_members SET member_name = ?, remark = ? WHERE id = ?').run(
      nextName,
      remark !== undefined ? String(remark).trim() : m.remark,
      id
    )
  })()
  return nextName
}

// 删除成员并重排同组
function deleteMember(id) {
  const m = memberById(id)
  if (!m) return false
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE id = ?').run(id)
    renumberMembers(m.group_id)
  })
  tx()
  return true
}

function renumberMembers(groupId) {
  const rest = db.prepare('SELECT id FROM group_members WHERE group_id = ? ORDER BY sort_order, id').all(groupId)
  const upd = db.prepare('UPDATE group_members SET sort_order = ? WHERE id = ?')
  rest.forEach((r, i) => upd.run(i + 1, r.id))
}

// 移动成员（同组排序 / 跨组移动），targetIndex 为移动后的最终位置（0 起）
function moveMember(memberId, sourceGroupId, targetGroupId, targetIndex) {
  const getIds = (gid) => db.prepare('SELECT id FROM group_members WHERE group_id = ? ORDER BY sort_order, id').all(gid).map(r => r.id)
  const upd = db.prepare('UPDATE group_members SET sort_order = ? WHERE id = ?')
  const tx = db.transaction(() => {
    if (sourceGroupId === targetGroupId) {
      const ids = getIds(sourceGroupId).filter(id => id !== memberId)
      const idx = Math.min(targetIndex, ids.length)
      ids.splice(idx, 0, memberId)
      ids.forEach((id, i) => upd.run(i + 1, id))
    } else {
      // 从源组移除并重排
      const srcIds = getIds(sourceGroupId).filter(id => id !== memberId)
      srcIds.forEach((id, i) => upd.run(i + 1, id))
      // 改到目标组
      db.prepare('UPDATE group_members SET group_id = ? WHERE id = ?').run(targetGroupId, memberId)
      // 插入目标组并重排
      const ids = getIds(targetGroupId).filter(id => id !== memberId)
      const idx = Math.min(targetIndex, ids.length)
      ids.splice(idx, 0, memberId)
      ids.forEach((id, i) => upd.run(i + 1, id))
    }
  })
  tx()
}

// 智能分组写回：清空该维度下所有小组成员，再按顺序把姓名写回对应（第 i 组 → groups[i]）
function replaceGroupMembers(dimId, groupsInput) {
  const groups = db.prepare('SELECT id FROM groups WHERE dimension_id = ? ORDER BY sort_order, id').all(dimId)
  const tx = db.transaction(() => {
    const delMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?')
    const insert = db.prepare('INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?, ?, ?, ?)')
    groups.forEach((g, gi) => {
      delMembers.run(g.id)
      const names = groupsInput[gi] || []
      names.forEach((name, i) => {
        const n = String(name || '').trim()
        if (!n) return
        insert.run(g.id, n, '', i + 1)
      })
    })
  })
  tx()
}

/**
 * 导入成员：语义是「合并追加」—— 同名小组存在则复用，不存在时按 allowCreateGroups 决定
 * 是新建还是报错；同一小组内重复姓名跳过，不会重复写入。
 * entries: [{ groupName, memberName, remark, rowNo }]，按行顺序处理（报错带行号）。
 * 返回 { createdGroups, addedMembers, skippedMembers }；出错抛 Error，外层事务整体回滚。
 */
function importMembers({ dimId, entries, allowCreateGroups, perGroupLimit, maxGroupCount }) {
  let createdGroups = 0
  let addedMembers = 0
  let skippedMembers = 0

  const tx = db.transaction(() => {
    const findGroup = db.prepare('SELECT id, name FROM groups WHERE dimension_id = ? AND name = ? ORDER BY sort_order, id LIMIT 1')
    const insertGroup = db.prepare('INSERT INTO groups (dimension_id, name, sort_order) VALUES (?, ?, ?)')
    const findMember = db.prepare('SELECT id FROM group_members WHERE group_id = ? AND member_name = ?')
    const insertMember = db.prepare('INSERT INTO group_members (group_id, member_name, remark, sort_order) VALUES (?, ?, ?, ?)')
    const countMembers = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?')
    const maxGroupSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups WHERE dimension_id = ?')
    const maxMemberSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM group_members WHERE group_id = ?')
    const countGroups = db.prepare('SELECT COUNT(*) AS n FROM groups WHERE dimension_id = ?')

    for (const { groupName, memberName, remark, rowNo } of entries) {
      let group = findGroup.get(dimId, groupName)
      if (!group) {
        if (!allowCreateGroups) {
          throw new Error(`第 ${rowNo} 行：内置宿舍组不能新建小组「${groupName}」，请先在「设置」里调整男/女生宿舍数`)
        }
        if (countGroups.get(dimId).n >= maxGroupCount) {
          throw new Error(`第 ${rowNo} 行：小组数量不能超过 ${maxGroupCount} 个`)
        }
        const sort = (maxGroupSort.get(dimId).m || 0) + 1
        const info = insertGroup.run(dimId, groupName, sort)
        group = { id: info.lastInsertRowid, name: groupName }
        createdGroups += 1
      }

      if (findMember.get(group.id, memberName)) {
        skippedMembers += 1
        continue
      }
      const cur = countMembers.get(group.id).n
      if (cur >= perGroupLimit) {
        throw new Error(`第 ${rowNo} 行：「${group.name}」人数已达上限 ${perGroupLimit} 人`)
      }
      const sort = (maxMemberSort.get(group.id).m || 0) + 1
      ensureProvisionalStudent(memberName)
      insertMember.run(group.id, memberName, remark, sort)
      addedMembers += 1
    }
  })
  tx()
  return { createdGroups, addedMembers, skippedMembers }
}

module.exports = {
  listDimensions,
  dimensionById,
  loadDimension,
  createDimension,
  updateDefaultDimension,
  updateDimension,
  deleteDimension,
  moveDimension,
  groupById,
  groupCount,
  addGroup,
  renameGroup,
  deleteGroup,
  memberById,
  memberCount,
  addMember,
  updateMember,
  deleteMember,
  moveMember,
  replaceGroupMembers,
  importMembers,
}
