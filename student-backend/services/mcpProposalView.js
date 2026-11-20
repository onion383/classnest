// =========================================================================
// mcpProposalView.js —— 写提案的「人读视图」
//
// 为什么单独一层：mcp_proposals 里存的是意图（表名 + 操作 + 字段），直接丢给界面
// 就是「students · update_row · 确认/拒绝」——老师看不出改哪一行、改成什么，只能盲签。
// 盲签等于没有审核，所以确认卡片必须先能判断。
//
// 只读：行数据走 aiStore（与执行同一套原语），本文件不写库、不拼 SQL。
// 英文表名一律翻成中文（READ_TABLE_LABELS 是同一份来源），界面上不出现 students 这种 key。
// =========================================================================

const aiStore = require('./aiStore');
const { READ_TABLE_LABELS, WRITE_TABLES } = require('../routes/ai/ai.constants');

const OP_LABELS = { add: '新增', update: '修改', delete: '删除' };

const MAX_OPS = 20;      // 卡片里最多列这么多条操作，其余给「还有 N 条」
const MAX_FIELDS = 6;    // 每条操作最多列这么多字段
const MAX_VALUE_LEN = 60; // 单个值超过这个长度就截断（长文本/JSON 不该撑爆卡片）

// 删除时优先用这两列说明「删的是谁」，没有就按表的列顺序补，最多 3 列
const ID_COLS = ['姓名', '学号'];
const ID_COL_COUNT = 3;

// 表名 → 中文名。READ_TABLE_LABELS 覆盖全部可读表；WRITE_TABLES 里有更短的中文名兜底。
// 最后才退回 key —— 理论上走不到（单测钉住键集），但也不让界面炸成空白。
function tableLabel(key) {
  const ui = READ_TABLE_LABELS[key];
  if (ui && ui.label) return ui.label;
  return WRITE_TABLES[key] || key;
}

// 值统一成「能显示的一行字」：对象转 JSON 文本、空值转 null（界面显示「空」）、过长截断
function disp(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = v;
  if (typeof v === 'object') {
    try { s = JSON.stringify(v); } catch (_) { s = String(v); }
  }
  s = String(s);
  return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;
}

function fieldsOf(op, existing, cols) {
  // 删除：没有 data，改为列出这几行的身份列（谁被删了）
  if (op.operation === 'delete') {
    if (!existing) return [];
    const pick = [];
    for (const c of ID_COLS) if (cols.includes(c) && !pick.includes(c)) pick.push(c);
    for (const c of cols) {
      if (pick.length >= ID_COL_COUNT) break;
      if (c !== 'id' && !pick.includes(c)) pick.push(c);
    }
    return pick.map((c) => ({ col: c, before: disp(existing[c]), after: null }));
  }

  const data = op.data && typeof op.data === 'object' ? op.data : {};
  const out = [];
  for (const k of Object.keys(data)) {
    if (k === 'id') continue;
    // 只认真实列（拼错 / 多余字段在执行时会被 runRowOp 丢掉，预览里也不该出现）
    if (cols.length && !cols.includes(k)) continue;
    const before = existing ? existing[k] : null;
    // 修改时值没变的不列：批量改名里往往一半字段是原样带回来的
    if (op.operation === 'update' && String(before == null ? '' : before) === String(data[k] == null ? '' : data[k])) continue;
    out.push({ col: k, before: op.operation === 'add' ? null : disp(before), after: disp(data[k]) });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

function describeOp(op) {
  const table = String((op && op.table) || '');
  const operation = String((op && op.operation) || '');
  let cols = [];
  try { cols = aiStore.tableColumns(table) || []; } catch (_) { cols = []; }
  const id = operation === 'add' ? null : (Number(op.id) > 0 ? Number(op.id) : null);
  // add 不回读：批量导入 200 行时这一步能省掉 200 次查询
  let existing = null;
  if (id) { try { existing = aiStore.findRow(table, id); } catch (_) { existing = null; } }
  return {
    table_label: tableLabel(table),
    operation,
    op_label: OP_LABELS[operation] || operation,
    id,
    // 记录可能已被别处删掉：界面上要说明「这一行现在不存在」，而不是显示一个空改动
    missing: !!id && !existing,
    fields: fieldsOf({ table, operation, data: op.data }, existing, cols),
  };
}

// 两种提案统一成「操作列表」：单条提案（row_write）外层有表/操作，批量（row_batch）在 payload.ops
function opsOf(p) {
  if (p.kind === 'row_batch') {
    return p.payload && Array.isArray(p.payload.ops) ? p.payload.ops : [];
  }
  const pay = p.payload || {};
  return [{ table: p.table, operation: p.operation, id: pay.id, data: pay.data || {} }];
}

// 给界面用的完整视图。
// 故意不下发 payload / table / operation：payload 是内部结构，外层的 table 与 operation 是
// 英文（students / update），留着迟早被人顺手渲染到界面上（「students · update_row」）。
// 可读信息全在 ops 里；每条 op 上的 operation 是给前端分支用的代码值，不是展示文案。
function describe(p, { maxOps = MAX_OPS } = {}) {
  if (!p) return null;
  const all = opsOf(p);
  const shown = all.slice(0, maxOps).map(describeOp);
  const { payload, table, operation, ...rest } = p;
  return {
    ...rest,
    op_count: all.length,
    more_ops: Math.max(0, all.length - shown.length),
    ops: shown,
  };
}

// 已处理记录的视图：**不回读当前行，也不重算 diff**。
// 执行完再回读，那一行已经是新值了——拿它算「改前 → 改后」会得到「张三丰 → 张三丰」，
// 或者因为 before === after 被过滤成一片空白。历史卡片只说明「动了哪张表、哪一行」，
// 真实的改动值去看「更改审查」（那里存的是执行当时的快照）。
function describeDone(p) {
  if (!p) return null;
  const all = opsOf(p);
  const shown = all.slice(0, MAX_OPS).map((op) => {
    const table = String((op && op.table) || '');
    const operation = String((op && op.operation) || '');
    return {
      table_label: tableLabel(table),
      operation,
      op_label: OP_LABELS[operation] || operation,
      id: operation === 'add' ? null : (Number(op.id) > 0 ? Number(op.id) : null),
    };
  });
  const { payload, table, operation, ...rest } = p;
  return {
    ...rest,
    op_count: all.length,
    more_ops: Math.max(0, all.length - shown.length),
    ops: shown,
  };
}

module.exports = { describe, describeDone, tableLabel, opsOf, MAX_OPS, MAX_FIELDS };
