const express = require('express');
const router = express.Router();
const { now, cleanUp, buildInsert, buildUpdate } = require('../utils/sql');
const { sanitizeField, normNumber } = require('../services/sanitize');
const { readRowsByIds } = require('../services/createdRows');
const { resolveOne } = require('../services/provisionalStudents');
const scoreStore = require('../services/scoreStore');

// 允许前端更新的字段白名单
const EDITABLE = ['姓名', '学号', '类型', '项目', '分值', '原因', '加分时间', 'source', 'group_name', '成员数'];

// ---------- 分页（v6 · 2-23）----------
// 背景：这个接口一次把整表返回，成绩会随学期线性增长（一学期上千条）。列表改成无限滚动后，
// 每次只要一屏的量；统计页签仍走全量（它要的是汇总，不是逐条）。
// hasMore 用「多取一条」判定，不跑 COUNT —— 与 services/searchLimits 同一口径。
// 注意：不带 limit 时仍是全量（统计页签/导出要的是汇总与全表），分页只在显式传 limit 时启用。
const PAGE_MAX = 200;

function pageOf(query) {
  const q = query || {};
  const n = Number(q.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), PAGE_MAX) : 0;
  const o = Number(q.offset);
  const offset = Number.isFinite(o) && o > 0 ? Math.trunc(o) : 0;
  return { limit, offset };
}

// GET /api/scores            → 全量 { data }
// GET /api/scores?limit=50&offset=0[&source=personal|group][&date=YYYY-MM-DD]
//   → 分页 { data, hasMore }
router.get('/', (req, res) => {
  const { limit, offset } = pageOf(req.query);
  const q = req.query || {};
  res.json(scoreStore.list({ source: q.source, date: q.date, limit, offset }));
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
        const stu = scoreStore.findStudentById(body.studentId);
        if (!stu) return res.status(404).json({ error: '学生不存在' });
        data.student_id = stu.id;
        data.姓名 = sanitizeField(body.姓名 || stu.姓名, 'score_records', '姓名');
        data.学号 = sanitizeField(body.学号 !== undefined ? body.学号 : (stu.学号 || null), 'score_records', '学号');
      } else {
        // 没传 studentId：姓名可能是名册外的人（转学生/借读/别班临时参加）。
        // 走与值日、座位、分组同一套 provisionalStudents 解析 —— 建一条 is_provisional=1
        // 的学生并回填 student_id，这样成绩引用有稳定身份：统计不会把同名两人混成一条，
        // 转正时只改状态位、成绩不用重指。空姓名仍按原行为（student_id 留空）落库。
        const rawName = String(body.姓名 == null ? '' : body.姓名).trim();
        if (!rawName) {
          data.student_id = null;
          data.姓名 = sanitizeField(body.姓名, 'score_records', '姓名');
          data.学号 = sanitizeField(body.学号, 'score_records', '学号');
        } else {
          const r = resolveOne(rawName, { create: true });
          if (r.error) return res.status(400).json({ error: r.error });
          // 正式名册里有多个同名：不替用户挑，交回前端从候选里选
          if (r.ambiguous) {
            return res.status(409).json({
              error: `名册中有 ${r.candidates.length} 个「${rawName}」，请从列表中指定是哪一位`,
              candidates: r.candidates,
            });
          }
          data.student_id = r.id;
          data.姓名 = sanitizeField(r.name, 'score_records', '姓名');
          data.学号 = sanitizeField(body.学号, 'score_records', '学号');
        }
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
        if (xuehao) student = scoreStore.findStudentByXuehao(xuehao);
        if (!student && name) {
          const sameName = scoreStore.findStudentsByName(name);
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

    const ids = scoreStore.insertMany(list);
    // created = 本次真正新建的行，供前端登记一条可撤销的批量导入（Q2-06）
    res.json({ message: `成功导入 ${list.length} 条加分记录`, created: readRowsByIds('score_records', ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// 供 /api/dashboard 聚合复用（挂在 router 函数对象上，不影响既有路由）
module.exports.readAll = scoreStore.readAll;
// 首页摘要只要「条数 + 今日 Top4」，不必把整表读进内存（v6 · 2-23）
module.exports.dashboardSummary = scoreStore.dashboardSummary;