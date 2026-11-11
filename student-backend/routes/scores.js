const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { now, cleanUp, buildInsert, buildUpdate } = require('../utils/sql');
const { sanitizeField, normNumber } = require('../services/sanitize');
const { readRowsByIds } = require('../services/createdRows');

// 允许前端更新的字段白名单
const EDITABLE = ['姓名', '学号', '类型', '项目', '分值', '原因', '加分时间', 'source', 'group_name', '成员数'];

// 全量列表（共用于 GET /api/scores 与 /api/dashboard）
function readAll() {
  return db.prepare('SELECT * FROM score_records ORDER BY 加分时间 DESC, id DESC').all();
}

// GET /api/scores 全量列表（按加分时间倒序）
router.get('/', (req, res) => {
    res.json({ data: readAll() });
});

// POST /api/scores 添加加分（选学生自动带姓名学号；小组加分独立成一条 source='group' 记录）
router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const data = {};

    // 小组加分：单条独立记录，不展开成每人一条
    if (body.source === 'group' || body.group_name) {
      data.source = 'group';
      data.student_id = null;
      data.姓名 = null;
      data.学号 = null;
      data.group_name = body.group_name || null;
      // 成员数没有列级规则，必须自己防 NaN：`Number(x) || 0` 会把「abc」静默变成 0
      data.成员数 = normNumber(body.成员数, '成员数') ?? 0;
    } else {
      data.source = 'personal';
      if (body.studentId) {
        const stu = db.prepare('SELECT id, 姓名, 学号 FROM students WHERE id = ?').get(body.studentId);
        if (!stu) return res.status(404).json({ error: '学生不存在' });
        data.student_id = stu.id;
        data.姓名 = sanitizeField(body.姓名 || stu.姓名, 'score_records', '姓名');
        data.学号 = sanitizeField(body.学号 !== undefined ? body.学号 : (stu.学号 || null), 'score_records', '学号');
      } else {
        data.student_id = null;
        data.姓名 = sanitizeField(body.姓名, 'score_records', '姓名');
        data.学号 = sanitizeField(body.学号, 'score_records', '学号');
      }
    }

    data.类型 = body.类型 === '扣分' ? '扣分' : '加分';
    // 文本列同样要过清洗：零宽字符会让「同一项目」变成两个统计项（审查 v4 · B02-02）
    data.项目 = sanitizeField(body.项目, 'score_records', '项目');
    // 分值走列级规则（数字 + 范围 0~100000）；非数字直接报错，不再 `Number(x) || 0` 静默成 0 分
    data.分值 = sanitizeField(body.分值 ?? 0, 'score_records', '分值') ?? 0;
    data.原因 = sanitizeField(body.原因, 'score_records', '原因');
    // 加分时间按日期列清洗：裸写会把「2026-13-45」这类串原样落库，导出/排序时才炸
    data.加分时间 = sanitizeField(body.加分时间 || now(), 'score_records', '加分时间');
    data.created_at = now();

    const result = buildInsert('score_records', data);
    res.json({ id: result.lastInsertRowid, message: '添加加分成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/scores/:id 编辑
router.put('/:id', (req, res) => {
    const row = cleanUp(req.body || {}, EDITABLE, 'score_records');
  // 「分值」已由 cleanUp 按列级规则清洗（数字 + 范围），这里不再二次 Number()。
  // 「成员数」没有列级规则，cleanUp 可能原样留下字符串；Number('abc') = NaN，
  // better-sqlite3 会把 NaN 落成 NULL，于是成员数「凭空消失」。这里显式校验。
  if (row['成员数'] !== undefined && row['成员数'] !== null) {
    row['成员数'] = normNumber(row['成员数'], '成员数');
  }
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  buildUpdate('score_records', row, req.params.id);
  res.json({ message: '修改成功' });
});

// POST /api/scores/import —— 从 Excel 导入加分/扣分记录
// 入参沿用 ImportExcel 的 { fields, rows, mode }；mode 为 personal/group，避免导错对象类型。
router.post('/import', (req, res) => {
  try {
    const { fields, rows, mode } = req.body || {};
    if (!Array.isArray(fields) || !Array.isArray(rows)) {
      return res.status(400).json({ error: '缺少有效的字段或数据' });
    }

    // 按表头名取单元格；Excel 文件列顺序可以任意调整
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
      `INSERT INTO score_records
        (student_id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间, created_at, source, group_name, 成员数)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const list = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const groupName = cell(row, ['小组', '小组名', 'group_name']);
      const name = cell(row, ['姓名']);
      const xuehao = cell(row, ['学号']);
      const isGroup = mode === 'group' || (!mode && groupName);
      if (isGroup && !groupName) throw new Error(`第 ${rowNo} 行缺少「小组」`);
      if (!isGroup && !name) throw new Error(`第 ${rowNo} 行缺少「姓名」`);

      let student = null;
      if (!isGroup) {
        if (xuehao) student = db.prepare('SELECT id, 姓名, 学号 FROM students WHERE 学号 = ?').get(xuehao) || null;
        if (!student && name) {
          const sameName = db.prepare('SELECT id, 姓名, 学号 FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2').all(name);
          if (sameName.length === 1) student = sameName[0];
        }
      }

      const type = sanitizeField(cell(row, ['类型']) || '加分', 'score_records', '类型');
      const scoreRaw = cell(row, ['分值']);
      const fen = scoreRaw === '' ? 0 : sanitizeField(scoreRaw, 'score_records', '分值');
      const time = sanitizeField(cell(row, ['加分时间']) || now(), 'score_records', '加分时间', '日期');
      const memberCount = isGroup ? (normNumber(cell(row, ['成员数']), '成员数') ?? 0) : 0;

      return {
        student_id: isGroup ? null : (student ? student.id : null),
        姓名: isGroup ? null : (name || (student && student.姓名) || null),
        学号: isGroup ? null : (xuehao || (student && student.学号) || null),
        类型: type,
        项目: cell(row, ['项目']) || null,
        分值: fen ?? 0,
        原因: cell(row, ['原因']) || null,
        加分时间: time,
        created_at: now(),
        source: isGroup ? 'group' : 'personal',
        group_name: isGroup ? groupName : null,
        成员数: memberCount,
      };
    });

    const insertMany = db.transaction((items) => {
      const ids = [];
      for (const item of items) {
        ids.push(Number(insert.run(
          item.student_id, item.姓名, item.学号, item.类型, item.项目,
          item.分值, item.原因, item.加分时间, item.created_at,
          item.source, item.group_name, item.成员数
        ).lastInsertRowid));
      }
      return ids;
    });
    const ids = insertMany(list);
    // created = 本次真正新建的行，供前端登记一条可撤销的批量导入（Q2-06）
    res.json({ message: `成功导入 ${list.length} 条加分记录`, created: readRowsByIds('score_records', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.readAll = readAll;