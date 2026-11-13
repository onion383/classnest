const express = require('express');
const router = express.Router();
const groupDim = require('../services/groupDim');

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
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/group-manage/dimensions/:id —— 修改维度设置（维度级：组名/组长称呼/每组人数/组数；内置宿舍组用男/女生宿舍数）
router.put('/dimensions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, leader_title, members_per_group, group_count } = req.body;
    const dim = groupDim.dimensionById(id);
    if (!dim) return res.status(404).json({ error: '维度不存在' });

    // ===== 内置宿舍组（特殊表单）：组名不可改，用 男/女生宿舍数 管理组 =====
    if (dim.is_default) {
      const male = req.body.male_group_count !== undefined ? clamp(req.body.male_group_count, 0, MAX_GROUP_COUNT) : dim.male_group_count;
      const female = req.body.female_group_count !== undefined ? clamp(req.body.female_group_count, 0, MAX_GROUP_COUNT) : dim.female_group_count;
      const mpg = members_per_group !== undefined ? clamp(members_per_group, 0, MAX_MEMBERS_PER_GROUP) : dim.members_per_group;
      groupDim.updateDefaultDimension(id, {
        leaderTitle: leader_title !== undefined ? String(leader_title).trim() : dim.leader_title,
        membersPerGroup: mpg,
        maleCount: male,
        femaleCount: female,
      });
      return res.json({ message: '保存成功' });
    }

    // ===== 普通维度 =====
    const newCount = group_count !== undefined ? clamp(group_count, 0, MAX_GROUP_COUNT) : dim.group_count;
    const newMpg = members_per_group !== undefined ? clamp(members_per_group, 0, MAX_MEMBERS_PER_GROUP) : dim.members_per_group;
    groupDim.updateDimension(id, {
      name: name !== undefined ? String(name).trim() : dim.name,
      leaderTitle: leader_title !== undefined ? String(leader_title).trim() : dim.leader_title,
      membersPerGroup: newMpg,
      groupCount: newCount,
    });
    res.json({ message: '保存成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/group-manage/dimensions/:id —— 删除维度（级联删除组与成员；内置宿舍组不可删除）
router.delete('/dimensions/:id', (req, res) => {
    const id = Number(req.params.id);
  const dim = groupDim.dimensionById(id);
  if (!dim) return res.status(404).json({ error: '维度不存在' });
  if (dim.is_default) return res.status(400).json({ error: '内置宿舍组不可删除' });
  // removed 带回完整快照：维度删除原先不可撤销，删掉后所有小组/成员只能手工重建。
  const removed = groupDim.deleteDimension(id);
  res.json({ message: '删除成功', removed });
});

// 移动维度
router.post('/dimensions/move', (req, res) => {
  try {
    const { id, direction } = req.body;
    // 「确保内置默认维度存在」是写操作，已与排序更新一起收进 groupDim.moveDimension 的同一事务：
    // 排序中途失败时不会凭空多出一个默认维度（原先它藏在读函数里、且独立提交）。
    if (!groupDim.moveDimension(Number(id), direction)) {
      return res.status(400).json({ error: '已到边界' });
    }
    res.json({ message: '排序已更新' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    res.json({ id: groupDim.addGroup(dimId, name), message: '添加成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/group-manage/groups/:id —— 修改小组名字
router.put('/groups/:id', (req, res) => {
    const id = Number(req.params.id);
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入小组名字' });
  const g = groupDim.groupById(id);
  if (!g) return res.status(404).json({ error: '小组不存在' });
  groupDim.renameGroup(id, name);
  res.json({ message: '保存成功' });
});

// DELETE /api/group-manage/groups/:id —— 删除组（级联删除成员）
router.delete('/groups/:id', (req, res) => {
    const id = Number(req.params.id);
  const g = groupDim.groupById(id);
  if (!g) return res.status(404).json({ error: '小组不存在' });
  groupDim.deleteGroup(id, g.dimension_id);
  res.json({ message: '删除成功' });
});

// ============ 组成员 ============

// POST /api/group-manage/groups/:groupId/members —— 新增成员
router.post('/groups/:groupId/members', (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const g = groupDim.groupById(groupId);
    if (!g) return res.status(404).json({ error: '小组不存在' });
    const { member_name = '', remark = '' } = req.body;
    const name = String(member_name).trim();
    if (!name) return res.status(400).json({ error: '成员姓名不能为空' });
    const dim = groupDim.dimensionById(g.dimension_id);
    const perGroupLimit = dim && dim.members_per_group > 0 ? dim.members_per_group : MAX_MEMBERS_PER_GROUP;
    const effectiveLimit = Math.min(perGroupLimit, MAX_MEMBERS_PER_GROUP);
    if (groupDim.memberCount(groupId) >= effectiveLimit) {
      return res.status(400).json({ error: `该组人数已达上限 ${effectiveLimit} 人` });
    }
    const { id, student } = groupDim.addMember(groupId, name, remark);
    res.json({
      id,
      // 回传解析结果，供前端以后把成员绑定到 student_id；现在先只用于提示/调试
      student: student && student.id ? { id: student.id, 姓名: name, is_provisional: !!student.is_provisional } : null,
      message: '添加成功',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/group-manage/group-members/:id —— 修改成员
router.put('/group-members/:id', (req, res) => {
    const id = Number(req.params.id);
  const { member_name, remark } = req.body;
  if (!groupDim.memberById(id)) return res.status(404).json({ error: '成员不存在' });
  groupDim.updateMember(id, { memberName: member_name, remark });
  res.json({ message: '保存成功' });
});

// DELETE /api/group-manage/group-members/:id —— 删除成员
router.delete('/group-members/:id', (req, res) => {
    const id = Number(req.params.id);
  if (!groupDim.deleteMember(id)) return res.status(404).json({ error: '成员不存在' });
  res.json({ message: '删除成功' });
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
    groupDim.moveMember(memberId, sourceGroupId, targetGroupId, targetIndex);

    const dimData = groupDim.loadDimension(tgt.dimension_id);
    if (!dimData) return res.status(404).json({ error: '维度不存在' });
    res.json({ dimensions: groupDim.listDimensions(), ...dimData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group-manage/dimensions/:dimId/apply-grouping —— 智能分组写回
// body: { groups: [ [姓名, ...], ... ] }；每组第一个姓名为组长。
// 清空该维度下所有小组成员，再按顺序把姓名写回对应（第 i 组 → groups[i]）。
router.post('/dimensions/:dimId/apply-grouping', (req, res) => {
  try {
    const dimId = Number(req.params.dimId);
    const dim = groupDim.dimensionById(dimId);
    if (!dim) return res.status(404).json({ error: '维度不存在' });
    const rawGroups = req.body?.groups;
    if (!Array.isArray(rawGroups)) return res.status(400).json({ error: '分组数据格式不正确' });
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

    groupDim.replaceGroupMembers(dimId, rawGroups);

    const data = groupDim.loadDimension(dimId);
    res.json({ dimensions: groupDim.listDimensions(), ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { fields, rows } = req.body || {};
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
    const entries = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const groupName = cell(row, ['小组', '小组名', '组名']);
      const memberName = cell(row, ['姓名', '成员姓名', '成员']);
      if (!groupName) throw new Error(`第 ${rowNo} 行缺少「小组」`);
      if (!memberName) throw new Error(`第 ${rowNo} 行缺少「姓名」`);
      return { groupName, memberName, remark: cell(row, ['备注']), rowNo };
    });

    const perGroupLimit = dim.members_per_group > 0
      ? Math.min(dim.members_per_group, MAX_MEMBERS_PER_GROUP)
      : MAX_MEMBERS_PER_GROUP;

    const { createdGroups, addedMembers, skippedMembers } = groupDim.importMembers({
      dimId,
      entries,
      allowCreateGroups: !dim.is_default,
      perGroupLimit,
      maxGroupCount: MAX_GROUP_COUNT,
    });

    const data = groupDim.loadDimension(dimId);
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
