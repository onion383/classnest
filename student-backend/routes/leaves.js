const express = require('express');
const router = express.Router();
const { db, renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate } = require('../utils/sql');
const { sanitizeField } = require('../services/sanitize');
const { validateRow } = require('../services/businessRules');
const { reorderRows } = require('../services/tableService');
const { readRowsByIds } = require('../services/createdRows');
const leaveStore = require('../services/leaveStore');
const { resolveOne } = require('../services/provisionalStudents');

// 允许前端更新的字段白名单
const EDITABLE = ['姓名', '类型', '开始时间', '结束时间', '家长联系电话', '学生联系电话', '状态', '返校时间', '备注'];

// 今日到班两张只读表的列顺序存储名（复用 table_meta，不改表结构）
const TODAY_COLUMN_TABLES = {
  active: 'leave_today_active',
  returned: 'leave_today_returned',
  records: 'leave_records_columns'
};

function listOrders() {
  return leaveStore.readAll();
}

// ---------- 分页与范围过滤（v6 · 2-23）----------
// 请假记录会随学期线性增长，列表改成滚动加载后每次只要一屏；
// 但「今日到班」要的是另一批数据（请假中 + 今天已返校），得单独按范围取。
// 范围判定与 hasMore 口径都收在 services/leaveStore（多取一条，不跑 COUNT）。
const PAGE_MAX = 200;

function pageOf(query) {
  const q = query || {};
  const n = Number(q.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), PAGE_MAX) : 0;
  const o = Number(q.offset);
  const offset = Number.isFinite(o) && o > 0 ? Math.trunc(o) : 0;
  return { limit, offset };
}

// GET /api/leaves            → 全量 { data }（挂件、导出、AI 工具都依赖这个语义）
// GET /api/leaves?limit=50&offset=0[&scope=today&date=YYYY-MM-DD] → 分页 { data, hasMore }
router.get('/', (req, res) => {
  const q = req.query || {};
  const { limit, offset } = pageOf(q);
  const { rows, hasMore } = leaveStore.readList({ scope: q.scope, date: q.date, limit, offset });
  if (!limit) return res.json({ data: rows });
  res.json({ data: rows, hasMore });
});

// POST /api/leaves 添加请假（学生联系方式从学生表自动带出）
router.post('/', (req, res) => {
    const body = req.body || {};
  const data = {};

  // 首选通过 studentId 从学生表带出姓名与联系方式
  if (body.studentId) {
    const stu = leaveStore.findStudentById(body.studentId);
    if (!stu) return res.status(404).json({ error: '学生不存在' });
    data.student_id = stu.id;
    // 文本列统一走 sanitizeField：裸赋值会把零宽字符/控制字符/超长串原样落库，
    // 之后搜索、导出、AI 读到的都是脏值（审查 v4 · B02-02）。
    data.姓名 = sanitizeField(body.姓名 || stu.姓名, 'leave_records', '姓名');
    data.家长联系电话 = sanitizeField(body.家长联系电话 !== undefined ? body.家长联系电话 : (stu.家长联系电话 || null), 'leave_records', '家长联系电话');
    data.学生联系电话 = sanitizeField(body.学生联系电话 !== undefined ? body.学生联系电话 : (stu.学生联系电话 || null), 'leave_records', '学生联系电话');
  } else {
    // 没传 studentId：姓名可能是名册外的人（转学生 / 借读 / 别班临时参加）。
    // 走与加减分（routes/scores.js POST）同一套 provisionalStudents 解析：建一条
    // is_provisional=1 的学生并回填 student_id，请假记录才有稳定身份 ——
    // 统计不会把同名两人混成一条，转正时只改状态位、记录不用重指。
    // 空姓名仍按原行为（student_id 留空）落库，不能被解析器拦成 400。
    const rawName = String(body.姓名 == null ? '' : body.姓名).trim();
    if (!rawName) {
      data.student_id = null;
      data.姓名 = sanitizeField(body.姓名, 'leave_records', '姓名');
      data.家长联系电话 = sanitizeField(body.家长联系电话, 'leave_records', '家长联系电话');
      data.学生联系电话 = sanitizeField(body.学生联系电话, 'leave_records', '学生联系电话');
    } else {
      const r = resolveOne(rawName, { create: true });
      if (r.error) return res.status(400).json({ error: r.error });
      // 名册里有多个同名：这里**刻意不**回 409（与加减分不同）。
      // 加减分有候选选择弹窗接得住 409；请假还能从「表格内直接新增一行」进来
      // （LeaveManagement.saveNewRow），那条路没有选人步骤 —— 回 409 等于把一条
      // 原本能落的记录直接丢掉。所以歧义时退回「只存姓名、student_id 留空」的老行为：
      // 不在没有选择 UI 的地方制造新错误。
      // resolveOne 在歧义时本身返回 id: null，这里的三元只是把意图写明白：
      // 「歧义 → 不回填」，不依赖下游实现的空值约定。
      data.student_id = r.ambiguous ? null : r.id;
      data.姓名 = sanitizeField(r.ambiguous ? rawName : r.name, 'leave_records', '姓名');
      // 手输姓名时联系方式只认请求体：临时学生本来就没有电话，正式学生的电话
      // 也要等用户显式传才带 —— 不在这里凭空补，避免「同一条记录两种来源」。
      data.家长联系电话 = sanitizeField(body.家长联系电话, 'leave_records', '家长联系电话');
      data.学生联系电话 = sanitizeField(body.学生联系电话, 'leave_records', '学生联系电话');
    }
  }

  data.类型 = body.类型 ? sanitizeField(body.类型, 'leave_records', '类型', '文字') : null;
  data.开始时间 = sanitizeField(body.开始时间 || null, 'leave_records', '开始时间', '日期');
  data.结束时间 = sanitizeField(body.结束时间 || null, 'leave_records', '结束时间', '日期');
  data.备注 = sanitizeField(body.备注, 'leave_records', '备注');
  data.状态 = '请假中';
  data.返校时间 = null;
  data.created_at = now();

  // 跨字段校验：结束时间必须晚于开始时间（不合法直接拒绝，避免写入「负时长 / 倒置」请假）
  validateRow('leave_records', { 开始时间: data.开始时间, 结束时间: data.结束时间 });

  data.position = maxPosition('leave_records') + 1;
  const result = buildInsert('leave_records', data);
  renumber('leave_records');
  res.json({ id: result.lastInsertRowid, message: '添加请假成功' });
});

// PUT /api/leaves/:id 编辑
router.put('/:id', (req, res) => {
  try {
    const row = cleanUp(req.body || {}, EDITABLE, 'leave_records');
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  // cleanUp 的跨字段校验只能看到本次请求带的列：只改「结束时间」时「开始时间」为空，
  // assertLeaveWindow 在任一时间为空时直接放行 → 结束时间可以被改到开始之前。
  // 这里用库里的旧行补齐后再校验一次（新增接口本来就有这条校验，行为要对齐）。
  if (row.开始时间 !== undefined || row.结束时间 !== undefined) {
    const old = leaveStore.findWindow(Number(req.params.id));
    if (!old) return res.status(404).json({ error: '记录不存在' });
    const start = row.开始时间 !== undefined ? row.开始时间 : old.开始时间;
    const end = row.结束时间 !== undefined ? row.结束时间 : old.结束时间;
    try {
      validateRow('leave_records', { 开始时间: start, 结束时间: end });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // 改姓名 = 换成另一个人（或名册外的人），必须重新认人 —— 否则记录显示新名字、
  // student_id 还指着旧学生，统计按 id 归集时会算到旧人头上，且不报任何错。
  // 只在姓名**真的变了**时才重认：前端表格 PUT 会带整行，无条件重认会让「只改状态」
  // 也去跑一次认人（同名歧义时还会把已有 id 冲成 null）。
  if (row.姓名 !== undefined) {
    const old = leaveStore.findRowById(req.params.id);
    if (!old) return res.status(404).json({ error: '记录不存在' });
    const nextName = String(row.姓名 == null ? '' : row.姓名).trim();
    const prevName = String(old.姓名 == null ? '' : old.姓名).trim();
    if (nextName !== prevName) {
      if (!nextName) {
        row.student_id = null;
      } else {
        const r = resolveOne(nextName, { create: true });
        if (r.error) return res.status(400).json({ error: r.error });
        // 同名歧义：不替用户猜，id 留空、姓名照存（与新增/导入同口径）
        row.student_id = r.ambiguous ? null : r.id;
        row.姓名 = r.ambiguous ? nextName : r.name;
      }
    }
  }

  buildUpdate('leave_records', row, req.params.id);
    res.json({ message: '修改成功' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/leaves/reorder 保存整表行顺序（前端传全量 id 顺序）
router.post('/reorder', (req, res) => {
    const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids 不能为空' });
  reorderRows('leave_records', ids.map(Number));
  res.json({ message: '排序成功' });
});

// GET /api/leaves/today-columns 读取今日到班两张表的列顺序
router.get('/today-columns', (req, res) => {
    const rows = leaveStore.listTodayColumns([
    TODAY_COLUMN_TABLES.active, TODAY_COLUMN_TABLES.returned, TODAY_COLUMN_TABLES.records,
  ]);
  const out = { active: [], returned: [], records: [] };
  rows.forEach(r => {
    if (r.table_name === TODAY_COLUMN_TABLES.active) out.active.push(r.column_name);
    else if (r.table_name === TODAY_COLUMN_TABLES.returned) out.returned.push(r.column_name);
    else out.records.push(r.column_name);
  });
  res.json(out);
});

// POST /api/leaves/today-columns 保存某张表的列顺序 { table: 'active'|'returned', order: [...] }
router.post('/today-columns', (req, res) => {
    const { table, order } = req.body || {};
  const tableName = TODAY_COLUMN_TABLES[table];
  if (!tableName || !Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: '参数不合法' });
  }
  leaveStore.replaceTodayColumns(tableName, order);
  res.json({ message: '列顺序已保存' });
});

// POST /api/leaves/import —— 从 Excel 导入请假记录
// 入参沿用 ImportExcel 的 { fields, rows }；表头顺序可任意调整。
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

    // 建临时学生可能因列级校验失败（超长姓名等）；导入是整批一个事务，
    // 不能为了一行补 id 把整批废掉 —— 失败就退回「student_id 留空」，与改动前一致。
    const tryResolve = (name) => {
      try {
        const r = resolveOne(name, { create: true });
        return (r.ambiguous || r.error) ? null : r;
      } catch (_) {
        return null;
      }
    };

    const startPos = maxPosition('leave_records');

    // 整批（认人建档 + 校验 + 写记录）必须在同一个事务里。
    // 关键：tryResolve 建档是在 rows.map 阶段即时 INSERT 临时学生的，若在事务外，
    // 后面某行校验 throw 会让整批 400，但前面已建的临时学生残留、没有 created 可撤销。
    // 与班干部导入（cadres.js）同一口径：解析/建档也纳入事务，失败整批回滚。
    const run = db.transaction(() => {
      const list = rows.map((row, idx) => {
        const rowNo = idx + 1;
        const name = cell(row, ['姓名']);
        const xuehao = cell(row, ['学号']);
        let student = null;
        if (xuehao) {
          // 学号不唯一（可空、可重复）：只有「恰好 1 条」才能定人。
          // 撞到 2 条就退回按姓名认人，绝不静默取第一条 —— 那会把整张表记到同一个学生头上。
          const byXuehao = leaveStore.findStudentsByXuehao(xuehao);
          if (byXuehao.length === 1) student = byXuehao[0];
        }
        if (!student && name) {
          // 学号没命中就按姓名认人；名册里查不到的名字在这里落一条临时学生（与新增请假、
          // 加减分同一套解析）。否则这条记录只剩下一个字符串，后续改名、统计都会对不上人。
          //
          // 重名（名册里 ≥2 个同名）刻意不抛错：导入整批一个事务，抛错会让整批失败，
          // 而原行为只是「这一行 student_id 留空」。不为了补 id 把能导的行一起废掉 ——
          // 需要用户决策的同名歧义交给「选人」那条路（AddLeaveDialog 直接传 studentId），
          // 不让批量导入替用户猜。
          const r = tryResolve(name);
          if (r && r.id) {
            // 命中后按 id 重查一次：正式学生带得出联系方式，临时学生这两列是 null
            student = leaveStore.findStudentById(r.id) || { id: r.id, 姓名: r.name };
          }
        }

        const finalName = name || (student && student.姓名) || '';
        if (!finalName) throw new Error(`第 ${rowNo} 行缺少「姓名」`);
        const start = sanitizeField(cell(row, ['开始时间']), 'leave_records', '开始时间');
        const end = sanitizeField(cell(row, ['结束时间']), 'leave_records', '结束时间');
        if (!start || !end) throw new Error(`第 ${rowNo} 行缺少「开始时间」或「结束时间」`);

        validateRow('leave_records', { 开始时间: start, 结束时间: end });

        return {
          position: startPos + idx + 1,
          student_id: student ? student.id : null,
          姓名: finalName,
          类型: sanitizeField(cell(row, ['类型']) || '其他', 'leave_records', '类型'),
          开始时间: start,
          结束时间: end,
          家长联系电话: cell(row, ['家长联系电话']) || (student && student.家长联系电话) || null,
          学生联系电话: cell(row, ['学生联系电话']) || (student && student.学生联系电话) || null,
          状态: sanitizeField(cell(row, ['状态']) || '请假中', 'leave_records', '状态'),
          返校时间: cell(row, ['返校时间']) ? sanitizeField(cell(row, ['返校时间']), 'leave_records', '返校时间', '日期') : null,
          备注: cell(row, ['备注']) || null,
          created_at: now(),
        };
      });

      const ids = leaveStore.insertMany(list);
      renumber('leave_records');
      return { count: list.length, ids };
    });

    const { count, ids } = run();
    // created = 本次真正新建的行（撤销导入的唯一 inverse 来源，见 services/createdRows）
    res.json({ message: `成功导入 ${count} 条请假记录`, created: readRowsByIds('leave_records', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/leaves/:id 删除
router.delete('/:id', (req, res) => {
    leaveStore.removeById(Number(req.params.id));
  renumber('leave_records');
  res.json({ message: '删除成功' });
});

// POST /api/leaves/:id/return 销假（标记已返校）
router.post('/:id/return', (req, res) => {
    const result = leaveStore.markReturned(Number(req.params.id), now());
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已销假' });
});

// POST /api/leaves/:id/unreturn 撤销销假（恢复为请假中）
router.post('/:id/unreturn', (req, res) => {
    const result = leaveStore.markUnreturned(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已撤销销假' });
});

// POST /api/leaves/:id/cancel 取消请假
router.post('/:id/cancel', (req, res) => {
    const result = leaveStore.markCanceled(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已取消请假' });
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.listOrders = listOrders;