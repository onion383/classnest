const express = require('express');
const router = express.Router();
const { db, renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate } = require('../utils/sql');
const { readRowsByIds } = require('../services/createdRows');

// 允许前端更新的字段白名单
const EDITABLE = ['时间', '主题', '地点', '简介', '参与人员'];

// 全量列表（共用于 GET /api/activities 与 /api/dashboard）
function readAll() {
  return db.prepare('SELECT * FROM activities ORDER BY position, id').all();
}

// GET /api/activities 全量列表
router.get('/', (req, res) => {
    res.json({ data: readAll() });
});

// POST /api/activities 新增
router.post('/', (req, res) => {
    const body = req.body || {};
  const data = cleanUp(body, EDITABLE, 'activities');
  data.created_at = now();
  // position 的「取最大值 + 插入 + 重排」必须在同一个事务里：并发两个 POST 时
  // 两个请求都读到同一个 max，会写出重复 position（审查 v4 · B02-12）。
  const result = db.transaction(() => {
    data.position = maxPosition('activities') + 1;
    const r = buildInsert('activities', data);
    renumber('activities');
    return r;
  })();
  res.json({ id: result.lastInsertRowid, message: '添加活动成功' });
});

// PUT /api/activities/:id 编辑
router.put('/:id', (req, res) => {
    const row = cleanUp(req.body || {}, EDITABLE, 'activities');
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  buildUpdate('activities', row, req.params.id);
  res.json({ message: '修改成功' });
});

// DELETE /api/activities/:id 删除
router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM activities WHERE id = ?').run(Number(req.params.id));
  renumber('activities');
  res.json({ message: '删除成功' });
});

// POST /api/activities/import —— 从 Excel 导入活动（按表头名映射，列顺序可任意）
// 校验与清洗完全复用 cleanUp：日期列按 table_meta 类型归一，空串落成 null。
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

    const startPos = maxPosition('activities');
    const insert = db.prepare(
      `INSERT INTO activities (时间, 主题, 地点, 参与人员, 简介, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const list = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const theme = cell(row, ['主题', '活动主题', '名称']);
      if (!theme) throw new Error(`第 ${rowNo} 行缺少「主题」`);
      const data = cleanUp({
        时间: cell(row, ['时间', '活动时间']),
        主题: theme,
        地点: cell(row, ['地点']),
        参与人员: cell(row, ['参与人员', '参与人']),
        简介: cell(row, ['简介', '说明']),
      }, EDITABLE, 'activities');
      return { ...data, created_at: now(), position: startPos + idx + 1 };
    });

    const insertMany = db.transaction((items) => {
      const ids = [];
      for (const item of items) {
        ids.push(Number(insert.run(item.时间, item.主题, item.地点, item.参与人员, item.简介, item.created_at, item.position).lastInsertRowid));
      }
      return ids;
    });
    const ids = insertMany(list);
    // created = 本次真正新建的行，供前端登记可撤销的批量导入（Q2-06）
    res.json({ message: `成功导入 ${list.length} 条活动`, created: readRowsByIds('activities', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.readAll = readAll;