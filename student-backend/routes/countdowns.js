const express = require('express');
const router = express.Router();
const { renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate } = require('../utils/sql');
const { readRowsByIds } = require('../services/createdRows');
const countdownStore = require('../services/countdownStore');

// 允许前端更新的字段白名单
const EDITABLE = ['名称', '截止日', '包含这一天'];

// GET /api/countdowns 全量列表
router.get('/', (req, res) => {
    res.json({ data: countdownStore.readAll() });
});

// POST /api/countdowns 新增
router.post('/', (req, res) => {
    const data = cleanUp(req.body || {}, EDITABLE, 'countdowns');
  data.position = maxPosition('countdowns') + 1;
  const result = buildInsert('countdowns', data);
  renumber('countdowns');
  res.json({ id: result.lastInsertRowid, message: '添加倒计时成功' });
});

// PUT /api/countdowns/:id 编辑
router.put('/:id', (req, res) => {
    const row = cleanUp(req.body || {}, EDITABLE, 'countdowns');
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  buildUpdate('countdowns', row, req.params.id);
  res.json({ message: '修改成功' });
});

// DELETE /api/countdowns/:id 删除
router.delete('/:id', (req, res) => {
    countdownStore.removeById(Number(req.params.id));
  renumber('countdowns');
  res.json({ message: '删除成功' });
});

// POST /api/countdowns/import —— 从 Excel 导入倒计时
// 「包含这一天」接受 是/否、true/false、1/0；「剩余天数」「状态」是导出时的派生列，导入时忽略。
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
    const toBool = (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      return s === '是' || s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
    };

    const startPos = maxPosition('countdowns');

    const list = rows.map((row, idx) => {
      const rowNo = idx + 1;
      const name = cell(row, ['名称', '倒计时']);
      const deadlineRaw = cell(row, ['截止日', '截止日期', '日期']);
      if (!name) throw new Error(`第 ${rowNo} 行缺少「名称」`);
      if (!deadlineRaw) throw new Error(`第 ${rowNo} 行缺少「截止日」`);
      const data = cleanUp({
        名称: name,
        截止日: deadlineRaw,
        包含这一天: toBool(cell(row, ['包含这一天', '包含截止日当天'])),
      }, EDITABLE, 'countdowns');
      return { ...data, created_at: now(), position: startPos + idx + 1 };
    });

    const ids = countdownStore.insertMany(list);
    // created = 本次真正新建的行，供前端登记可撤销的批量导入（Q2-06）
    res.json({ message: `成功导入 ${list.length} 条倒计时`, created: readRowsByIds('countdowns', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.readAll = countdownStore.readAll;