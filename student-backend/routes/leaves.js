const express = require('express');
const router = express.Router();
const { db, renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate } = require('../utils/sql');
const { sanitizeField } = require('../services/sanitize');
const { validateRow } = require('../services/businessRules');
const { reorderRows } = require('../services/tableService');
const { readRowsByIds } = require('../services/createdRows');

// 允许前端更新的字段白名单
const EDITABLE = ['姓名', '类型', '开始时间', '结束时间', '家长联系电话', '学生联系电话', '状态', '返校时间', '备注'];

// 今日到班两张只读表的列顺序存储名（复用 table_meta，不改表结构）
const TODAY_COLUMN_TABLES = {
  active: 'leave_today_active',
  returned: 'leave_today_returned',
  records: 'leave_records_columns'
};

function listOrders() {
  return db.prepare('SELECT * FROM leave_records ORDER BY position, id').all();
}

// GET /api/leaves 全量列表（不设 HTTP 缓存：安全模式下响应是会话绑定的密文，且请假增删后要立刻可见）
router.get('/', (req, res) => {
  res.json({ data: listOrders() });
});

// POST /api/leaves 添加请假（学生联系方式从学生表自动带出）
router.post('/', (req, res) => {
    const body = req.body || {};
  const data = {};

  // 首选通过 studentId 从学生表带出姓名与联系方式
  if (body.studentId) {
    const stu = db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE id = ?').get(body.studentId);
    if (!stu) return res.status(404).json({ error: '学生不存在' });
    data.student_id = stu.id;
    // 文本列统一走 sanitizeField：裸赋值会把零宽字符/控制字符/超长串原样落库，
    // 之后搜索、导出、AI 读到的都是脏值（审查 v4 · B02-02）。
    data.姓名 = sanitizeField(body.姓名 || stu.姓名, 'leave_records', '姓名');
    data.家长联系电话 = sanitizeField(body.家长联系电话 !== undefined ? body.家长联系电话 : (stu.家长联系电话 || null), 'leave_records', '家长联系电话');
    data.学生联系电话 = sanitizeField(body.学生联系电话 !== undefined ? body.学生联系电话 : (stu.学生联系电话 || null), 'leave_records', '学生联系电话');
  } else {
    data.student_id = null;
    data.姓名 = sanitizeField(body.姓名, 'leave_records', '姓名');
    data.家长联系电话 = sanitizeField(body.家长联系电话, 'leave_records', '家长联系电话');
    data.学生联系电话 = sanitizeField(body.学生联系电话, 'leave_records', '学生联系电话');
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
    const row = cleanUp(req.body || {}, EDITABLE, 'leave_records');
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  // cleanUp 的跨字段校验只能看到本次请求带的列：只改「结束时间」时「开始时间」为空，
  // assertLeaveWindow 在任一时间为空时直接放行 → 结束时间可以被改到开始之前。
  // 这里用库里的旧行补齐后再校验一次（新增接口本来就有这条校验，行为要对齐）。
  if (row.开始时间 !== undefined || row.结束时间 !== undefined) {
    const old = db.prepare('SELECT 开始时间, 结束时间 FROM leave_records WHERE id = ?').get(Number(req.params.id));
    if (!old) return res.status(404).json({ error: '记录不存在' });
    const start = row.开始时间 !== undefined ? row.开始时间 : old.开始时间;
    const end = row.结束时间 !== undefined ? row.结束时间 : old.结束时间;
    try {
      validateRow('leave_records', { 开始时间: start, 结束时间: end });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  buildUpdate('leave_records', row, req.params.id);
  res.json({ message: '修改成功' });
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
    const rows = db.prepare(
    'SELECT table_name, column_name FROM table_meta WHERE table_name IN (?, ?, ?) ORDER BY sort_order'
  ).all(TODAY_COLUMN_TABLES.active, TODAY_COLUMN_TABLES.returned, TODAY_COLUMN_TABLES.records);
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
  const del = db.prepare('DELETE FROM table_meta WHERE table_name = ?');
  const ins = db.prepare('INSERT INTO table_meta (table_name, column_name, data_type, sort_order) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    del.run(tableName);
    order.forEach((name, i) => ins.run(tableName, String(name), '文字', i + 1));
  })();
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

    const insert = db.prepare(
      `INSERT INTO leave_records
        (position, student_id, 姓名, 类型, 开始时间, 结束时间, 家长联系电话, 学生联系电话, 状态, 返校时间, 备注, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const startPos = maxPosition('leave_records');

    const list = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const name = cell(row, ['姓名']);
      const xuehao = cell(row, ['学号']);
      let student = null;
      if (xuehao) student = db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE 学号 = ?').get(xuehao) || null;
      if (!student && name) {
        const sameName = db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2').all(name);
        if (sameName.length === 1) student = sameName[0];
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

    const insertMany = db.transaction((items) => {
      const ids = [];
      for (const item of items) {
        ids.push(Number(insert.run(
          item.position, item.student_id, item.姓名, item.类型, item.开始时间, item.结束时间,
          item.家长联系电话, item.学生联系电话, item.状态, item.返校时间, item.备注, item.created_at
        ).lastInsertRowid));
      }
      return ids;
    });
    const ids = insertMany(list);
    renumber('leave_records');
    // created = 本次真正新建的行（撤销导入的唯一 inverse 来源，见 services/createdRows）
    res.json({ message: `成功导入 ${list.length} 条请假记录`, created: readRowsByIds('leave_records', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/leaves/:id 删除
router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM leave_records WHERE id = ?').run(Number(req.params.id));
  renumber('leave_records');
  res.json({ message: '删除成功' });
});

// POST /api/leaves/:id/return 销假（标记已返校）
router.post('/:id/return', (req, res) => {
    const result = db.prepare("UPDATE leave_records SET 状态='已返校', 返校时间=? WHERE id = ?").run(now(), Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已销假' });
});

// POST /api/leaves/:id/unreturn 撤销销假（恢复为请假中）
router.post('/:id/unreturn', (req, res) => {
    const result = db.prepare("UPDATE leave_records SET 状态='请假中', 返校时间=NULL WHERE id = ?").run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已撤销销假' });
});

// POST /api/leaves/:id/cancel 取消请假
router.post('/:id/cancel', (req, res) => {
    const result = db.prepare("UPDATE leave_records SET 状态='已取消' WHERE id = ?").run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已取消请假' });
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.listOrders = listOrders;