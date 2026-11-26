const express = require('express');
const router = express.Router();
const groupDim = require('../services/groupDim');
const { takeUndoSpec, writeWithUndo } = require('../services/writeWithUndo');

// 维度设置可能同时改字段（cell_update）和改组数（group_snapshot）——一写多登记。
// buildPayload 按 spec.type 分派：cell_update 保持前端原 payload，group_snapshot 后端填 after。
function dimensionSettingsPayload(result, hint, spec) {
  if (spec && spec.type === 'group_snapshot') {
    const before = hint && hint.oldValue
    if (!Array.isArray(before)) return null
    return { dimId: result.dimId, oldValue: before, newValue: groupDim.structureSnapshot(result.dimId) }
  }
  return hint
}

// 结构变更的撤销登记：写与 after 快照在同一事务生成，前端把 before 作 spec.payload 带来。
// 返回 { ...writeResult, undoId }；spec 是 group_snapshot，payload = { dimId, oldValue: before, newValue: after }。
function withStructureUndo(spec, dimId, writeFn) {
  return writeWithUndo(spec, () => {
    const result = writeFn() || {};
    // after 必须在同一事务里读：写后状态，不能靠前端二次 GET（那是写后补登记窗口）
    return { ...result, _snapshot: dimId == null ? null : groupDim.structureSnapshot(dimId) };
  }, (result, hint) => {
    const before = hint && hint.oldValue;
    // before 缺失或快照读不到时不登记（与前端 recordGroupStructure 同口径）
    if (!Array.isArray(before) || result._snapshot == null) return null;
    return { dimId, oldValue: before, newValue: result._snapshot };
  });
}

// ============ 上限常量（与前端一致） ============
const MAX_MEMBERS_PER_GROUP = 99; // 每组最大人数
const MAX_GROUP_COUNT = 50;       // 单个维度最大小组数
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

// 语句与「读多次再写多次」的复合操作都在 services/groupDim.js：
// 这里只留 HTTP 形状、上限常量与「内置宿舍组 vs 普通维度」的分支。

// GET /api/group-manage/bootstrap —— 维度列表 + 第一个维度详情（供前端初始加载）
router.get('/bootstrap', (req, res) => {
    const dimensions = groupDim.listDimensions();
  let active = null;
  if (dimensions.length > 0) {
    active = groupDim.loadDimension(dimensions[0].id);
  }
  res.json({ dimensions, active });
});

// GET /api/group-manage/:dimId —— 读取指定维度详情
router.get('/:dimId', (req, res) => {
    const data = groupDim.loadDimension(Number(req.params.dimId));
  if (!data) return res.status(404).json({ error: '维度不存在' });
  res.json({ dimensions: groupDim.listDimensions(), ...data });
});

// POST /api/group-manage/dimensions —— 新增维度（按组数自动初始化小组）
router.post('/dimensions', (req, res) => {
  try {
    const { name, leader_title = '', members_per_group = 0, group_count = 0 } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入维度名称' });
    const dimId = groupDim.createDimension({
      name,
      leaderTitle: leader_title,
      membersPerGroup: clamp(members_per_group, 0, MAX_MEMBERS_PER_GROUP),
      groupCount: clamp(group_count, 0, MAX_GROUP_COUNT),
    });
    res.json({ id: dimId, message: '添加成功' });
  } catch (err) {
    res.status((err && err.status) || 500).json({ error: err.message });
  }
});

// PUT /api/group-manage/dimensions/:id —— 修改维度设置（维度级：组名/组长称呼/每组人数/组数；内置宿舍组用男/女生宿舍数）
router.put('/dimensions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, leader_title, members_per_group, group_count } = req.body;
    const specs = req.body._undoSpecs;
    const dim = groupDim.dimensionById(id);
    if (!dim) return res.status(404).json({ error: '维度不存在' });

    // ===== 内置宿舍组（特殊表单）：组名不可改，用 男/女生宿舍数 管理组 =====
    if (dim.is_default) {
      const male = req.body.male_group_count !== undefined ? clamp(req.body.male_group_count, 0, MAX_GROUP_COUNT) : dim.male_group_count;
      const female = req.body.female_group_count !== undefined ? clamp(req.body.female_group_count, 0, MAX_GROUP_COUNT) : dim.female_group_count;
      const mpg = members_per_group !== undefined ? clamp(members_per_group, 0, MAX_MEMBERS_PER_GROUP) : dim.members_per_group;
      const out = writeWithUndo(specs, () => {
        groupDim.updateDefaultDimension(id, {
          leaderTitle: leader_title !== undefined ? String(leader_title).trim() : dim.leader_title,
          membersPerGroup: mpg, maleCount: male, femaleCount: female,
        });
        return { dimId: id };
      }, dimensionSettingsPayload);
      const { dimId: _d, ...body } = out;
      return res.json({ ...body, message: '保存成功' });
    }

    // ===== 普通维度 =====
    const newCount = group_count !== undefined ? clamp(group_count, 0, MAX_GROUP_COUNT) : dim.group_count;
    const newMpg = members_per_group !== undefined ? clamp(members_per_group, 0, MAX_MEMBERS_PER_GROUP) : dim.members_per_group;
    // V9-2-5 · 899：组名自动编号原先是这次 PUT 之后的第二次请求（applyGroupNames →
    // rename-batch），group_snapshot 的 after 在那时尚未改名、会漏组名。把改名合进同一
    // 事务：改维度设置 → 批量改组名 → 由 dimensionSettingsPayload 读改名后的结构快照，
    // 一步到位且撤销与两处写共存亡。前端「无变化跳过」已保证 items 只含真改的组。
    const groupRenames = Array.isArray(req.body.groupRenames) ? req.body.groupRenames : [];
    for (const it of groupRenames) {
      const rid = Number(it && it.id);
      const rname = it && typeof it.name === 'string' ? it.name.trim() : '';
      if (!Number.isInteger(rid) || rid <= 0 || !rname || rname.length > 50) {
        return res.status(400).json({ error: '组名批量更新参数不合法' });
      }
    }
    const out = writeWithUndo(specs, () => {
      groupDim.updateDimension(id, {
        name: name !== undefined ? String(name).trim() : dim.name,
        leaderTitle: leader_title !== undefined ? String(leader_title).trim() : dim.leader_title,
        membersPerGroup: newMpg, groupCount: newCount,
      });
      if (groupRenames.length) groupDim.renameGroupsBatch(groupRenames.map((it) => ({ id: Number(it.id), name: String(it.name).trim() })));
      return { dimId: id };
    }, dimensionSettingsPayload);
    const { dimId: _d2, ...body } = out;
    res.json({ ...body, message: '保存成功' });
  } catch (err) {
    res.status((err && err.status) || 500).json({ error: err.message });
  }
});

// DELETE /api/group-manage/dimensions/:id —— 删除维度（级联删除组与成员；内置宿舍组不可删除）
router.delete('/dimensions/:id', (req, res) => {
    const id = Number(req.params.id);
  const dim = groupDim.dimensionById(id);
  if (!dim) return res.status(404).json({ error: '维度不存在' });
  if (dim.is_default) return res.status(400).json({ error: '内置宿舍组不可删除' });
  // removed 带回完整快照：维度删除原先不可撤销，删掉后所有小组/成员只能手工重建。
  // 删除与撤销登记同事务，第二次登记失败不会让这步变成不可撤销。
  const spec = takeUndoSpec(req.body) || takeUndoSpec(req.query);
  const out = writeWithUndo(spec, () => ({ removed: groupDim.deleteDimension(id) }),
    (result) => result.removed);
  res.json({ ...out, message: '删除成功' });
});

// ============ 组 ============

// POST /api/group-manage/dimensions/:dimId/groups —— 新增组
router.post('/dimensions/:dimId/groups', (req, res) => {
  try {
    const dimId = Number(req.params.dimId);
    const dim = groupDim.dimensionById(dimId);
    if (!dim) return res.status(404).json({ error: '维度不存在' });
    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入小组名字' });
    if (groupDim.groupCount(dimId) >= MAX_GROUP_COUNT) {
      return res.status(400).json({ error: `小组数量不能超过 ${MAX_GROUP_COUNT} 个` });
    }
    const spec = takeUndoSpec(req.body);
    const out = withStructureUndo(spec, dimId, () => {
      const newId = groupDim.addGroup(dimId, name);
      return { id: newId };
    });
    res.json({ ...out, message: '添加成功' });
  } catch (err) {
    res.status((err && err.status) || 500).json({ error: err.message });
  }
});

// PUT /api/group-manage/groups/:id —— 修改小组名字
// PUT /api/group-manage/groups/rename-batch —— 批量改名（组名自动编号一次往返）
// 必须声明在 /groups/:id 之前：Express 会把 rename-batch 先当成 :id 匹配掉。
router.put('/groups/rename-batch', (req, res) => {
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: '请提供要改名的 items 数组' });
  if (items.length > 500) return res.status(400).json({ error: '一次最多改名 500 个小组' });
  // 同 id 后写覆盖先写，避免重复项把同一条更新两次
  const byId = new Map();
  for (const it of items) {
    const id = Number(it && it.id);
    const name = it && typeof it.name === 'string' ? it.name.trim() : '';
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '小组 id 必须是正整数' });
    if (!name) return res.status(400).json({ error: '小组名字不能为空' });
    if (name.length > 50) return res.status(400).json({ error: '小组名字不能超过 50 个字' });
    byId.set(id, name);
  }
  if (!byId.size) return res.status(400).json({ error: '请提供至少一个要改名的小组' });
  try {
    const updated = groupDim.renameGroupsBatch([...byId].map(([id, name]) => ({ id, name })));
    res.json({ message: '保存成功', updated });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.put('/groups/:id', (req, res) => {
    const id = Number(req.params.id);
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入小组名字' });
  const g = groupDim.groupById(id);
  if (!g) return res.status(404).json({ error: '小组不存在' });
  const spec = takeUndoSpec(req.body);
  const out = writeWithUndo(spec, () => { groupDim.renameGroup(id, name); return {} });
  res.json({ ...out, message: '保存成功' });
});

// DELETE /api/group-manage/groups/:id —— 删除组（级联删除成员）
router.delete('/groups/:id', (req, res) => {
    const id = Number(req.params.id);
  const g = groupDim.groupById(id);
  if (!g) return res.status(404).json({ error: '小组不存在' });
  const spec = takeUndoSpec(req.body) || takeUndoSpec(req.query);
  const out = withStructureUndo(spec, g.dimension_id, () => {
    groupDim.deleteGroup(id, g.dimension_id);
    return {};
  });
  res.json({ ...out, message: '删除成功' });
});

// ============ 组成员 ============

// POST /api/group-manage/groups/:groupId/members —— 新增成员
router.post('/groups/:groupId/members', (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const g = groupDim.groupById(groupId);
    if (!g) return res.status(404).json({ error: '小组不存在' });
    const { member_name = '', remark = '', student_id = null } = req.body;
    const name = String(member_name).trim();
    if (!name) return res.status(400).json({ error: '成员姓名不能为空' });
    const dim = groupDim.dimensionById(g.dimension_id);
    const perGroupLimit = dim && dim.members_per_group > 0 ? dim.members_per_group : MAX_MEMBERS_PER_GROUP;
    const effectiveLimit = Math.min(perGroupLimit, MAX_MEMBERS_PER_GROUP);
    if (groupDim.memberCount(groupId) >= effectiveLimit) {
      return res.status(400).json({ error: `该组人数已达上限 ${effectiveLimit} 人` });
    }
    // student_id 是前端从名册选人时带上的权威引用；同名两人靠它区分，姓名只是快照。
    const spec = takeUndoSpec(req.body);
    let added = null;
    const out = withStructureUndo(spec, g.dimension_id, () => {
      added = groupDim.addMember(groupId, name, remark, student_id);
      return { id: added.id };
    });
    res.json({
      ...out,
      student: added.student && added.student.id ? { id: added.student.id, 姓名: added.student.name, is_provisional: !!added.student.is_provisional } : null,
      message: '添加成功',
    });
  } catch (err) {
    // 「student_id 指向已删除的学生」这类是用户填错/界面过期（err.status = 400），
    // 不是服务端故障；其余真异常仍按 500 报，别把两种混成一个状态码。
    res.status(err && err.status ? err.status : 500).json({ error: err.message });
  }
});

// PUT /api/group-manage/group-members/:id —— 修改成员
router.put('/group-members/:id', (req, res) => {
    const id = Number(req.params.id);
  const { member_name, remark, student_id } = req.body;
  if (!groupDim.memberById(id)) return res.status(404).json({ error: '成员不存在' });
  const inlineSpecs = req.body._undoSpecs;
  const single = takeUndoSpec(req.body);
  const specs = Array.isArray(inlineSpecs) ? inlineSpecs : (single ? [single] : null);
  let saved = null;
  try {
    // 登记与写入同事务；改名那条的 newRef（后端解析出的 student_id）由 buildPayload 补。
    saved = writeWithUndo(specs, () => groupDim.updateMember(id, { memberName: member_name, remark, studentId: student_id }),
      (result, hint) => {
        const p = { ...hint }
        if (p.newRef === '__SAVED_STUDENT_ID__') p.newRef = result.studentId == null ? null : Number(result.studentId)
        return p
      });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ message: '保存成功', member_name: saved.name, student_id: saved.studentId, undoId: saved.undoId, undoIds: saved.undoIds });
});

// DELETE /api/group-manage/group-members/:id —— 删除成员
router.delete('/group-members/:id', (req, res) => {
    const id = Number(req.params.id);
  // 先查成员及其维度（404 在事务外），删除与快照登记同事务。
  const mem = groupDim.memberById(id);
  if (!mem) return res.status(404).json({ error: '成员不存在' });
  const grp = groupDim.groupById(mem.group_id);
  const dimId = grp && grp.dimension_id;
  const spec = takeUndoSpec(req.body) || takeUndoSpec(req.query);
  const out = withStructureUndo(spec, dimId, () => {
    if (!groupDim.deleteMember(id)) { const e = new Error('成员不存在'); e.status = 404; throw e }
    return {};
  });
  res.json({ ...out, message: '删除成功' });
});

// POST /api/group-manage/group-members/move —— 移动成员（同组排序 / 跨组移动）
// body: { memberId, targetGroupId, targetIndex }  targetIndex 为成员在目标组移动后的最终位置（0 起）
router.post('/group-members/move', (req, res) => {
  try {
    const memberId = Number(req.body.memberId);
    const targetGroupId = Number(req.body.targetGroupId);
    const targetIndex = Math.max(0, Number(req.body.targetIndex) || 0);
    const m = groupDim.memberById(memberId);
    if (!m) return res.status(404).json({ error: '成员不存在' });
    const tgt = groupDim.groupById(targetGroupId);
    if (!tgt) return res.status(404).json({ error: '目标小组不存在' });

    const sourceGroupId = m.group_id;
    // 跨组移入：目标组满员则拒绝，避免超出人数上限
    if (sourceGroupId !== targetGroupId) {
      const dim = groupDim.dimensionById(tgt.dimension_id);
      const perGroupLimit = dim && dim.members_per_group > 0 ? dim.members_per_group : MAX_MEMBERS_PER_GROUP;
      const limit = Math.min(perGroupLimit, MAX_MEMBERS_PER_GROUP);
      if (groupDim.memberCount(targetGroupId) >= limit) {
        return res.status(400).json({ error: `该组人数已达上限 ${limit} 人，无法移入` });
      }
    }
    const spec = takeUndoSpec(req.body);
    const out = withStructureUndo(spec, tgt.dimension_id, () => {
      groupDim.moveMember(memberId, sourceGroupId, targetGroupId, targetIndex);
      const dimData = groupDim.loadDimension(tgt.dimension_id);
      if (!dimData) { const e = new Error('维度不存在'); e.status = 404; throw e }
      return dimData;
    });
    const { _snapshot, ...dimData } = out;
    res.json({ dimensions: groupDim.listDimensions(), ...dimData });
  } catch (err) {
    res.status((err && err.status) || 500).json({ error: err.message });
  }
});

// POST /api/group-manage/dimensions/:dimId/apply-grouping —— 智能分组写回
// body: { groups: [ [姓名, ...], ... ], studentIds? }；每组第一个姓名为组长。
// studentIds 是同名选人/名册带 id 的结果，key = `${组号}:${组内位置}`（与 groups 下标一一对应）。
// 清空该维度下所有小组成员，再按顺序把姓名写回对应（第 i 组 → groups[i]）。
router.post('/dimensions/:dimId/apply-grouping', (req, res) => {
  try {
    const dimId = Number(req.params.dimId);
    const dim = groupDim.dimensionById(dimId);
    if (!dim) return res.status(404).json({ error: '维度不存在' });
    const rawGroups = req.body?.groups;
    if (!Array.isArray(rawGroups)) return res.status(400).json({ error: '分组数据格式不正确' });
    const studentIds = req.body?.studentIds;
    const groupTotal = groupDim.groupCount(dimId);
    if (rawGroups.length > groupTotal) {
      return res.status(400).json({ error: `分组数量不能超过该维度的 ${groupTotal} 个小组` });
    }
    // 与单条添加/移动保持同一上限：每组人数不得超过维度设置（且不超过硬上限）
    const perGroupLimit = dim.members_per_group > 0
      ? Math.min(dim.members_per_group, MAX_MEMBERS_PER_GROUP)
      : MAX_MEMBERS_PER_GROUP;
    for (let gi = 0; gi < rawGroups.length; gi++) {
      const names = rawGroups[gi];
      if (!Array.isArray(names)) return res.status(400).json({ error: `第 ${gi + 1} 组的数据需要是姓名数组` });
      const count = names.filter((name) => String(name ?? '').trim()).length;
      if (count > perGroupLimit) {
        return res.status(400).json({ error: `第 ${gi + 1} 组有 ${count} 人，超过上限 ${perGroupLimit} 人` });
      }
    }

    const spec = takeUndoSpec(req.body);
    const out = withStructureUndo(spec, dimId, () => {
      groupDim.replaceGroupMembers(dimId, rawGroups, studentIds);
      return groupDim.loadDimension(dimId);
    });
    const { _snapshot, ...data } = out;
    res.json({ dimensions: groupDim.listDimensions(), ...data });
  } catch (err) {
    res.status((err && err.status) || 500).json({ error: err.message });
  }
});

/**
 * POST /api/group-manage/dimensions/:dimId/import —— 从 Excel 导入小组成员
 * body: { fields, rows }
 * 列：`小组`（必填）、`姓名`（必填）、`备注`（可选）
 *
 * 语义是「合并追加」：同名小组存在则复用，不存在的普通维度会自动新建；
 * 同一小组内重复姓名会跳过，不会重复写入。内置宿舍维度不允许新建小组（宿舍数由设置决定）。
 */
router.post('/dimensions/:dimId/import', (req, res) => {
  try {
    const dimId = Number(req.params.dimId);
    const dim = groupDim.dimensionById(dimId);
    if (!dim) return res.status(404).json({ error: '维度不存在' });
    const { fields, rows, studentIds } = req.body || {};
    if (!Array.isArray(fields) || !Array.isArray(rows)) {
      return res.status(400).json({ error: '缺少有效的字段或数据' });
    }

    const cell = (row, names) => {
      for (const n of names) {
        const i = fields.indexOf(n);
        if (i >= 0) {
          const v = row[i];
          if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
      }
      return '';
    };

    // 先整体解析成条目（缺列直接报错，不带行号之外的副作用），再交给 service 落库
    // studentIds 是同名选人结果（key = 行号），前端传了就按用户选的人落 id。
    const entries = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const groupName = cell(row, ['小组', '小组名', '组名']);
      const memberName = cell(row, ['姓名', '成员姓名', '成员']);
      if (!groupName) throw new Error(`第 ${rowNo} 行缺少「小组」`);
      if (!memberName) throw new Error(`第 ${rowNo} 行缺少「姓名」`);
      const picked = studentIds && studentIds[String(idx)];
      return { groupName, memberName, remark: cell(row, ['备注']), rowNo, picked };
    });

    const perGroupLimit = dim.members_per_group > 0
      ? Math.min(dim.members_per_group, MAX_MEMBERS_PER_GROUP)
      : MAX_MEMBERS_PER_GROUP;

    let createdGroups = 0, addedMembers = 0, skippedMembers = 0;
    const spec = takeUndoSpec(req.body);
    const out = withStructureUndo(spec, dimId, () => {
      const r = groupDim.importMembers({
        dimId, entries,
        allowCreateGroups: !dim.is_default,
        perGroupLimit,
        maxGroupCount: MAX_GROUP_COUNT,
      });
      createdGroups = r.createdGroups; addedMembers = r.addedMembers; skippedMembers = r.skippedMembers;
      return groupDim.loadDimension(dimId);
    });
    const { _snapshot, ...data } = out;
    res.json({
      message: `成功导入 ${addedMembers} 名成员${createdGroups ? `，新建 ${createdGroups} 个小组` : ''}`,
      skipped: skippedMembers,
      dimensions: groupDim.listDimensions(),
      ...data,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
