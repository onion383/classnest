const express = require('express');
const router = express.Router();
const { db } = require('../db');
const cadreStore = require('../services/cadreStore');
const { cleanText } = require('../services/sanitize');

// ======================== 数据读写 ========================
// cadres: { id, name, parent_id, max_count, sort_order, children: [], members: [] }

// 读取全部职务节点
function allCadres() {
  return cadreStore.allCadres();
}

// 组装成树并附上担任学生
function buildTree() {
  const all = allCadres();
  const byId = new Map();
  all.forEach(c => byId.set(c.id, { ...c, children: [], members: cadreStore.membersOf(c.id) }));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ======================== 职务 CRUD ========================
// 获取完整职务树（含担任学生）
router.get('/', (req, res) => {
    res.json({ tree: buildTree() });
});

// 新增职务
router.post('/', (req, res) => {
    const name = cleanText(req.body.name || '');
  if (!name) return res.status(400).json({ error: '职务名不能为空' });
  const parentId = Number(req.body.parent_id) || 0;
  const maxCount = Math.max(1, Number(req.body.max_count) || 1);
  // 校验父职务存在（若指定）
  if (parentId && !cadreStore.cadreExists(parentId)) {
    return res.status(400).json({ error: '上级职务不存在' });
  }
  const maxSort = cadreStore.maxSort();
  const info = cadreStore.insertCadre(name, parentId, maxCount, maxSort + 1);
  res.json({ id: info.lastInsertRowid, tree: buildTree() });
});

// 更新职务
router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
  const node = cadreStore.findCadre(id);
  if (!node) return res.status(404).json({ error: '职务不存在' });
  const name = req.body.name !== undefined ? cleanText(req.body.name) : node.name;
  if (!name) return res.status(400).json({ error: '职务名不能为空' });
  const parentId = req.body.parent_id !== undefined ? (Number(req.body.parent_id) || 0) : node.parent_id;
  const maxCount = req.body.max_count !== undefined ? Math.max(1, Number(req.body.max_count) || 1) : node.max_count;
  // 防循环：新父级不能是自身或其子孙
  if (parentId === id) return res.status(400).json({ error: '上级不能是自身' });
  if (parentId) {
    let cur = parentId;
    const visited = new Set();
    while (cur) {
      if (cur === id) return res.status(400).json({ error: '不能把职务挂到自己的下级' });
      if (visited.has(cur)) break;
      visited.add(cur);
      const p = cadreStore.findParentId(cur);
      cur = p ? p : 0;
    }
  }
  cadreStore.updateCadre(id, name, parentId, maxCount);
  res.json({ tree: buildTree() });
});

// 删除职务：级联删除其担任学生，其直接子职务上移挂到被删职务的上级
router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
  const node = cadreStore.findCadre(id);
  if (!node) return res.status(404).json({ error: '职务不存在' });
  cadreStore.deleteCadreCascade(id, node.parent_id);
  res.json({ tree: buildTree() });
});

// ======================== 担任学生 ========================
// 为职务添加担任学生（student_id 可空，用于值日输入产生的"仅姓名"学生）
router.post('/:id/members', (req, res) => {
    const cadreId = Number(req.params.id);
  const cadre = cadreStore.findCadreBasic(cadreId);
  if (!cadre) {
    return res.status(404).json({ error: '职务不存在' });
  }
  const studentId = req.body.student_id ? Number(req.body.student_id) || null : null;
  const studentName = cleanText(req.body.student_name || '');
  if (!studentName) return res.status(400).json({ error: '请选择担任学生' });
  // max_count 原来只有渲染层拦（CadreManage.vue）：直接调接口能给一个 1 人职务塞任意多人，
  // 班级页会显示成「任命 5/1」。这里补上同一句判断。
  const maxCount = Math.max(1, Number(cadre.max_count) || 1);
  const curCount = cadreStore.countMembers(cadreId);
  if (curCount >= maxCount) {
    return res.status(400).json({ error: `「${cadre.name}」人数已达上限 ${maxCount} 人` });
  }
  const maxSort = cadreStore.maxMemberSort(cadreId);
  const info = cadreStore.insertMember(cadreId, studentId, studentName, maxSort + 1);
  res.json({ id: info.lastInsertRowid, tree: buildTree() });
});

// 移除担任学生
router.delete('/members/:id', (req, res) => {
    const id = Number(req.params.id);
  cadreStore.deleteMember(id);
  res.json({ tree: buildTree() });
});

// 移动职务：挂到 parentId(0=顶级) 下第 index 位（排序），index 为去掉自身后目标位置，可为 null 表示放在末尾
router.post('/:id/move', (req, res) => {
    const id = Number(req.params.id);
  const node = cadreStore.findCadre(id);
  if (!node) return res.status(404).json({ error: '职务不存在' });
  const parentId = Number(req.body.parent_id) || 0;
  let index = Number.isFinite(req.body.index) ? Number(req.body.index) : null;
  if (parentId === id) return res.status(400).json({ error: '上级不能是自身' });
  if (parentId) {
    let cur = parentId;
    const visited = new Set();
    while (cur) {
      if (cur === id) return res.status(400).json({ error: '不能把职务挂到自己的下级' });
      if (visited.has(cur)) break;
      visited.add(cur);
      const p = cadreStore.findParentId(cur);
      cur = p ? p : 0;
    }
  }
  cadreStore.moveCadre(id, parentId, index);
  res.json({ tree: buildTree() });
});

// 移动担任学生：挂到 cadreId 下第 index 位（index 为去掉自身后的目标位置，null 表示末尾）
router.post('/members/:id/move', (req, res) => {
    const id = Number(req.params.id);
  const mem = cadreStore.findMember(id);
  if (!mem) return res.status(404).json({ error: '担任学生不存在' });
  const cadreId = Number(req.body.cadre_id) || 0;
  const target = cadreStore.findCadreBasic(cadreId);
  if (!target) {
    return res.status(400).json({ error: '职务不存在' });
  }
  // 跨职务移动也要守目标名额：单条添加接口（POST /:id/members）查了 max_count，
  // 漏在这里就能靠拖拽把「班长（限 1 人）」塞成 3 个人，前端计数与评优统计一起失真。
  // 同一职务内拖动人数不变，不需要校验。
  if (Number(mem.cadre_id) !== cadreId) {
    const maxCount = Math.max(1, Number(target.max_count) || 1);
    const curCount = cadreStore.countMembers(cadreId);
    if (curCount >= maxCount) {
      return res.status(400).json({ error: `「${target.name}」人数已达上限 ${maxCount} 人` });
    }
  }
  let index = Number.isFinite(req.body.index) ? Number(req.body.index) : null;
  cadreStore.moveMember(id, cadreId, index);
  res.json({ tree: buildTree() });
});


/**
 * POST /api/cadres/import —— 从 Excel 导入班干部职务与担任学生
 * body: { fields, rows }
 * 列：`职务`（必填）、`上级职务`（可选，按名称匹配已有职务）、`可担任人数`（可选，仅新建时生效）、
 *     `担任学生`（可选，支持「张三、李四」等多种分隔符）
 *
 * 语义是「合并追加」：同一上级下同名职务复用，已有成员不重复添加；
 * 导出文件可以原样导回（先序遍历保证上级行排在下级行之前）。
 */
router.post('/import', (req, res) => {
  try {
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
    // 「担任学生」既支持顿号/逗号/分号/斜杠，也支持空格分隔
    const splitNames = (raw) => String(raw || '')
      .split(/[、,，;；/|\s]+/)
      .map((s) => cleanText(s))
      .filter(Boolean);

    const list = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const title = cleanText(cell(row, ['职务', '职务名称']));
      if (!title) throw new Error(`第 ${rowNo} 行缺少「职务」`);
      const parentName = cleanText(cell(row, ['上级职务', '上级']));
      const maxRaw = cell(row, ['可担任人数', '人数上限']);
      let maxCount = null;
      if (maxRaw !== '') {
        const n = Number(maxRaw);
        if (!Number.isFinite(n) || n < 1) throw new Error(`第 ${rowNo} 行的「可担任人数」需要是大于 0 的数字`);
        maxCount = Math.max(1, Math.floor(n));
      }
      const students = splitNames(cell(row, ['担任学生', '姓名', '学生']));
      return { rowNo, title, parentName, maxCount, students };
    });

    // 本次导入真正新建的行（同名职务/成员只复用不修改）——撤销导入按这份清单精确回滚
    const created = { cadres: [], members: [] };

    const tx = db.transaction(() => {
      for (const item of list) {
        let parentId = 0;
        if (item.parentName) {
          const parents = cadreStore.findCadresByName(item.parentName);
          if (parents.length === 0) throw new Error(`第 ${item.rowNo} 行的上级职务「${item.parentName}」不存在`);
          if (parents.length > 1) throw new Error(`第 ${item.rowNo} 行的上级职务「${item.parentName}」有重名，请先在页面里区分`);
          parentId = parents[0].id;
        }
        let node = cadreStore.findCadreByNameAndParent(item.title, parentId);
        if (!node) {
          const sort = cadreStore.maxSort() + 1;
          const info = cadreStore.insertCadre(item.title, parentId, item.maxCount || 1, sort);
          node = { id: info.lastInsertRowid, name: item.title, max_count: item.maxCount || 1 };
          created.cadres.push({ id: node.id, name: node.name, parent_id: parentId, max_count: node.max_count, sort_order: sort });
        }
        for (const name of item.students) {
          if (cadreStore.findMemberByName(node.id, name)) continue;
          if (cadreStore.countMembers(node.id) >= node.max_count) {
            throw new Error(`第 ${item.rowNo} 行：「${node.name}」人数已达上限 ${node.max_count} 人`);
          }
          const sameName = cadreStore.findStudentIdsByName(name);
          const studentId = sameName.length === 1 ? sameName[0].id : null;
          const sort = cadreStore.maxMemberSort(node.id) + 1;
          const infoMember = cadreStore.insertMember(node.id, studentId, name, sort);
          created.members.push({
            id: infoMember.lastInsertRowid,
            cadre_id: node.id,
            student_id: studentId,
            student_name: name,
            sort_order: sort
          });
        }
      }
    });
    tx();

    res.json({ message: `成功导入 ${list.length} 行班干部数据`, tree: buildTree(), created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;