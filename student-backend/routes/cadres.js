const express = require('express');
const router = express.Router();
const { db } = require('../db');
const cadreStore = require('../services/cadreStore');
const studentLookup = require('../services/studentLookup');
const { resolveOne, resolvePickedForImport } = require('../services/provisionalStudents');
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
// 为职务添加担任学生。
// 权威字段是 student_id，student_name 只是快照（导出与列表展示不必每次 join）。
// 因此：能拿到 id 时姓名以 students 表为准，不信前端传的副本；拿不到 id 时按姓名认人，
// 名册外的名字在这里落一条临时学生 —— 班干部不再依赖「值日先输入过这个人」这种隐式顺序。
router.post('/:id/members', (req, res) => {
    const cadreId = Number(req.params.id);
  const cadre = cadreStore.findCadreBasic(cadreId);
  if (!cadre) {
    return res.status(404).json({ error: '职务不存在' });
  }
  let studentId = req.body.student_id ? Number(req.body.student_id) || null : null;
  let studentName = cleanText(req.body.student_name || '');

  if (studentId) {
    // 有 id 就以库里的姓名为准：前端传的 student_name 可能已经过时（改名后没刷新）
    const stu = studentLookup.findById(studentId, 'base');
    if (!stu) return res.status(404).json({ error: '学生不存在' });
    studentName = stu.姓名;
  } else if (studentName) {
    const r = resolveOne(studentName, { create: true });
    if (r.error) return res.status(400).json({ error: r.error });
    // 名册里多个同名：不替用户挑，id 留空、姓名照存 —— 与改动前行为一致
    // （班干部本来就允许「仅姓名」的成员；前端选人时总会带上 student_id）
    if (!r.ambiguous) {
      studentId = r.id;
      studentName = r.name;
    }
  } else {
    return res.status(400).json({ error: '请选择担任学生' });
  }
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
  const result = cadreStore.deleteMember(id);
  if (!result || result.changes === 0) return res.status(404).json({ error: '担任学生不存在' });
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
 * body: { fields, rows, studentIds? }
 * 列：`职务`（必填）、`上级职务`（可选，按名称匹配已有职务）、`可担任人数`（可选，仅新建时生效）、
 *     `担任学生`（可选，支持「张三、李四」等多种分隔符）
 * studentIds: 同名选人的结果，key = `${行idx}:${该行姓名的slotIdx}`（与 ImportExcel 一致），
 *   值 = 学生 id / 'new'。前端传了就按用户选的人落库，不传维持旧的按姓名解析。
 *
 * 语义是「合并追加」：同一上级下同名职务复用，已有成员不重复添加；
 * 导出文件可以原样导回（先序遍历保证上级行排在下级行之前）。
 */
router.post('/import', (req, res) => {
  try {
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
      return { rowNo, rowIdx: idx, title, parentName, maxCount, students };
    });

    // 按姓名认人：名册里唯一命中就用它，名册外就落一条临时学生（与单条新增同一套解析）。
    // 重名或建人失败（姓名超长等）一律返回 null —— 导入是整批一个事务，
    // 为了补一个 id 把已成功的行一起回滚不值得，退回「仅姓名成员」的老行为即可。
    const resolveMember = (name) => {
      try {
        const r = resolveOne(name, { create: true });
        return (r.ambiguous || r.error) ? null : r;
      } catch (_) {
        return null;
      }
    };

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
        for (let slotIdx = 0; slotIdx < item.students.length; slotIdx++) {
          const name = item.students[slotIdx];
          if (cadreStore.findMemberByName(node.id, name)) continue;
          if (cadreStore.countMembers(node.id) >= node.max_count) {
            throw new Error(`第 ${item.rowNo} 行：「${node.name}」人数已达上限 ${node.max_count} 人`);
          }
          // 同名选人：前端带 studentIds 时按用户选的人落 id（数字 id 不存在会抛 400，
          // 由外层 catch 回给前端）；没带则维持旧的按姓名解析（歧义留空）。
          const picked = studentIds && studentIds[`${item.rowIdx}:${slotIdx}`];
          const resolved = picked === undefined ? resolveMember(name) : resolvePickedForImport(picked, name);
          const studentId = resolved ? resolved.id : null;
          // 用户选中的人姓名以库为准（可能是临时学生），不再 blindly 用表格里的姓名快照
          const memberName = studentId ? (resolved.name || name) : name;
          const sort = cadreStore.maxMemberSort(node.id) + 1;
          const infoMember = cadreStore.insertMember(node.id, studentId, memberName, sort);
          created.members.push({
            id: infoMember.lastInsertRowid,
            cadre_id: node.id,
            student_id: studentId,
            student_name: memberName,
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