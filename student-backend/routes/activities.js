const express = require('express');
const router = express.Router();
const { db, renumber } = require('../db');
const { now, cleanUp, maxPosition, buildInsert, buildUpdate } = require('../utils/sql');
const { readRowsByIds } = require('../services/createdRows');
const activityStore = require('../services/activityStore');
const { takeUndoSpec, writeWithUndo } = require('../services/writeWithUndo');

// 允许前端更新的字段白名单
const EDITABLE = ['时间', '主题', '地点', '简介', '参与人员'];

// GET /api/activities 全量列表
router.get('/', (req, res) => {
    res.json({ data: activityStore.readAll() });
});

// POST /api/activities 新增
router.post('/', (req, res) => {
  // 校验错误必须是 400：cleanUp 抛出的「不是合法日期」若不加 try 会被 Express 兜成
  // 500 + HTML 错误页，前端只看到「服务器错误」，看不出是时间填错了。
  try {
    const body = req.body || {};
    const spec = takeUndoSpec(body);
    const data = cleanUp(body, EDITABLE, 'activities');
    data.created_at = now();
    // position 的「取最大值 + 插入 + 重排」必须在同一个事务里：并发两个 POST 时
    // 两个请求都读到同一个 max，会写出重复 position（审查 v4 · B02-12）。
    const result = writeWithUndo(spec, () => db.transaction(() => {
      data.position = maxPosition('activities') + 1;
      const r = buildInsert('activities', data);
      renumber('activities');
      return r;
    })(), (result, hint) => ({ ...hint, row: { ...hint, id: result.lastInsertRowid } }));
    res.json({ id: result.lastInsertRowid, message: '添加活动成功', undoId: result.undoId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/activities/:id 编辑
router.put('/:id', (req, res) => {
  try {
    const spec = takeUndoSpec(req.body);
    const row = cleanUp(req.body || {}, EDITABLE, 'activities');
    if (Object.keys(row).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
    // 不存在的 id 必须 404：buildUpdate 对空结果不报错，原先一律回「修改成功」，
    // 前端在另一个窗口已删掉这条时看不到任何异常，用户以为改动保存了。
    // 撤销登记与写入同事务（V9-I-13）：payload 的 oldRow 由前端随 spec 带来（写前才知道），
    // newRow 用提交字段拼；changes===0（id 不存在）时 buildPayload 返回 null 不登记。
    const id = Number(req.params.id);
    const result = writeWithUndo(spec,
      () => buildUpdate('activities', row, req.params.id),
      (r, hint) => (r && r.changes > 0)
        ? { table: 'activities', rowId: id, oldRow: (hint && hint.oldRow) || null, newRow: { ...(hint && hint.oldRow), ...row, id } }
        : null);
    if (result.changes === 0) return res.status(404).json({ error: '活动不存在' });
    res.json({ message: '修改成功', undoId: result.undoId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/activities/:id 删除
router.delete('/:id', (req, res) => {
  const spec = takeUndoSpec(req.body) || takeUndoSpec(req.query);
  const id = Number(req.params.id);
  // 删除前的整行由前端随 spec.payload 带来（row_delete 的 inverse 需要完整列）。
  // changes===0（id 不存在）时不登记，避免撤销栈留下空记录。
  const result = writeWithUndo(spec,
    () => activityStore.removeById(id),
    (r, hint) => (r && r.changes > 0) ? (hint || { table: 'activities', row: { id } }) : null);
  if (result.changes === 0) return res.status(404).json({ error: '活动不存在' });
  renumber('activities');
  res.json({ message: '删除成功', undoId: result.undoId });
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

    // 序号分配与批量插入必须在同一事务内（K01-06）：事务外先读 maxPosition，
    // 并发 POST 会占用同一序号，导入行与手工新增行 position 重复。
    let list = [];
    const ids = db.transaction(() => {
      const startPos = maxPosition('activities');
      list = rows.map((row, idx) => {
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
      return activityStore.insertMany(list);
    })();
    // created = 本次真正新建的行，供前端登记可撤销的批量导入（Q2-06）
    res.json({ message: `成功导入 ${list.length} 条活动`, created: readRowsByIds('activities', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.readAll = activityStore.readAll;