const express = require('express');
const router = express.Router();
const { renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate, isDateStr } = require('../utils/sql');
const { readRowsByIds } = require('../services/createdRows');
const countdownStore = require('../services/countdownStore');
const { takeUndoSpec, writeWithUndo } = require('../services/writeWithUndo');

// 允许前端更新的字段白名单
const EDITABLE = ['名称', '截止日', '包含这一天'];

// GET /api/countdowns 全量列表
router.get('/', (req, res) => {
    res.json({ data: countdownStore.readAll() });
});

// POST /api/countdowns 新增
router.post('/', (req, res) => {
    const spec = takeUndoSpec(req.body);
    const data = cleanUp(req.body || {}, EDITABLE, 'countdowns');
  // 必填校验（K03-07）：名称/截止日为空会落一条永远无法显示「还剩几天」的脏记录。
  if (!String(data.名称 == null ? '' : data.名称).trim()) return res.status(400).json({ error: '请填写倒计时名称' });
  if (!String(data.截止日 == null ? '' : data.截止日).trim()) return res.status(400).json({ error: '请选择截止日' });
  if (!isDateStr(data.截止日)) return res.status(400).json({ error: '截止日格式不正确（应为 YYYY-MM-DD）' });
  const result = writeWithUndo(spec, () => {
    data.position = maxPosition('countdowns') + 1;
    const r = buildInsert('countdowns', data);
    renumber('countdowns');
    return r;
  }, (result, hint) => ({ ...hint, row: { ...hint, id: result.lastInsertRowid } }));
  res.json({ id: result.lastInsertRowid, message: '添加倒计时成功', undoId: result.undoId });
});

// PUT /api/countdowns/:id 编辑
router.put('/:id', (req, res) => {
  const spec = takeUndoSpec(req.body);
  const row = cleanUp(req.body || {}, EDITABLE, 'countdowns');
  if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  // 撤销登记与写入同事务（V9-I-13）；changes===0（id 不存在）不登记。
  const id = Number(req.params.id);
  const result = writeWithUndo(spec,
    () => buildUpdate('countdowns', row, req.params.id),
    (r, hint) => (r && r.changes > 0)
      ? { table: 'countdowns', rowId: id, oldRow: (hint && hint.oldRow) || null, newRow: { ...(hint && hint.oldRow), ...row, id } }
      : null);
  if (result.changes === 0) return res.status(404).json({ error: '倒计时不存在' });
  res.json({ message: '修改成功', undoId: result.undoId });
});

// DELETE /api/countdowns/:id 删除
router.delete('/:id', (req, res) => {
  const spec = takeUndoSpec(req.body) || takeUndoSpec(req.query);
  const id = Number(req.params.id);
  const result = writeWithUndo(spec,
    () => countdownStore.removeById(id),
    (r, hint) => (r && r.changes > 0) ? (hint || { table: 'countdowns', row: { id } }) : null);
  if (result.changes === 0) return res.status(404).json({ error: '倒计时不存在' });
  renumber('countdowns');
  res.json({ message: '删除成功', undoId: result.undoId });
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