// =========================================================================
// dataExport.js —— 系统设置「数据管理」的数据源
//
// 职责只有两件事：
//   1. 把库里的业务表**表格化**成统一的 { fields, rows } —— 前端拿到的形状
//      与 ExportExcel 组件要求的完全一致，这样才能真正复用那套导出实现（xlsx
//      带边框、csv 转义、md 表格等），而不是在设置页重写第二份格式逻辑。
//   2. 把前端生成好的若干文件打成一个 zip（可选密码），见 services/zipWriter.js。
//
// 为什么不直接 SELECT * 就返回：
//   座位 / 值日 / 课程表 / 小组这几张表是「整块 JSON」存法（seats 是二维数组、
//   duty.cells 是 {项目:{星期:[人名]}}），原样导出只会得到一列看不懂的 JSON 文本。
//   这里统一展平成「一行一条记录」的明细表，用户拿到的才是能和页面表格对上的数据。
// =========================================================================
const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { safeJson } = require('../utils/json');
const { writeZip } = require('../services/zipStream');
const { memSnapshot, logExportMemory } = require('../services/perfMem');
// 值日列名的唯一读取入口（日常值日=星期几，大扫除=分组名+全部）
const dutyConfig = require('../services/dutyConfig');
const { SEAT_CELL, columnLabels, rowIsAisle } = require('../services/seatGrid');
const dbManager = require('../dbManager/dbManager');
const fs = require('fs');
const path = require('path');

const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 单表读取失败不应该让整份导出挂掉（旧库缺表 / 列被删过）：
// 该表返回空表，其余表照常导出，前端会看到「N 行」为 0 而不是整个按钮报错。
function all(sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}
function get(sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch (_) { return null; }
}

// 1-3：只取行数，不物化整表。
// `/tables` 以前为了一个数字调用 build() —— 那会把整张表建成行对象再丢掉。
// 这里直接 COUNT(*)，代价与表大小无关；表不存在时 `get` 已吞掉异常返回 null。
function countOf(tableName) {
  const row = get(`SELECT COUNT(*) AS n FROM ${tableName}`);
  return Number(row && row.n) || 0;
}

// { fields, rows } —— rows 为对象数组，字段顺序由 fields 决定
function table(headers, rows) {
  return { fields: headers.map((name) => ({ name })), rows };
}

// 按列名白名单取值，缺失列补空串（不同版本库里列可能不一样）
function pick(row, cols) {
  const out = {};
  for (const c of cols) {
    const v = row ? row[c] : null;
    out[c] = v === null || v === undefined ? '' : v;
  }
  return out;
}

// 单元格里不能出现裸 JSON。快照 payload、班级信息这些天然是结构化数据，
// JSON.stringify 出来在 Excel 里就是一坨引号花括号，等于没导出。
// 这里转成「键: 值；键: 值」的人读文本；嵌套太深就停，避免一个单元格几千字。
// labels 把库里存的英文键翻成中文（中文键原样保留，不会被动到）。
function readable(value, depth = 0, labels = null) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (depth >= 3) return '…';
  if (Array.isArray(value)) {
    if (!value.length) return '';
    return value.map((v) => readable(v, depth + 1, labels)).filter((s) => s !== '').join('、');
  }
  const parts = [];
  for (const [k, v] of Object.entries(value)) {
    const s = readable(v, depth + 1, labels);
    if (s !== '') parts.push(`${(labels && labels[k]) || k}: ${s}`);
  }
  return parts.join('；');
}

// ---- 结构化列的键名翻译 ----
// 每个 JSON 列的键集合是固定的，缺了哪套就会把英文键直接印到表格里。
const LABELS_SNAPSHOT = {
  cells: '内容', settings: '设置', days: '星期', items: '项目', weights: '权重',
  seats: '座位', mode: '模式', rows: '行数', cols: '列数', kind: '类型',
  conditions: '条件', savedAt: '保存时间', groupsConfig: '分组配置', aisleCols: '走廊列',
};
const LABELS_CLASS_INFO = { name: '班名', motto: '班级口号', mottoStyle: '班风', xuefeng: '学风' };
const LABELS_DESKTOP_APP = { id: '编号', name: '软件名', path: '路径', icon: '图标' };
const LABELS_UNDO = { before: '修改前', after: '修改后', fields: '字段', table: '数据表' };

// 枚举值翻译：库里存英文码，表格里给人看中文
const DOMAIN_LABELS = { schedule: '课程表', duty: '值日表', seat: '座位表' };
const ALBUM_KIND_LABELS = { folder: '文件夹相册', virtual: '虚拟相册' };
const UNDO_TYPE_LABELS = {
  update: '修改', insert: '新增', delete: '删除', batch: '批量',
  full_reload: '整表重载', move: '移动', swap: '交换',
};

function labelOf(map, value) {
  if (!value) return '';
  return map[value] || String(value);
}

// 学生 id → 姓名（座位表里存的是 id，直接导出数字没人看得懂）
function studentNameMap() {
  const map = {};
  for (const s of all('SELECT id, 姓名 FROM students')) map[s.id] = s.姓名 || '';
  return map;
}

// ---------- 各表定义 ----------

function tStudents() {
  const cols = ['学号', '年级', '班级', '姓名', '年龄', '家长联系电话', '学生联系电话', '备注'];
  const rows = all('SELECT * FROM students ORDER BY position ASC, id ASC').map((r) => pick(r, cols));
  return table(cols, rows);
}

function tScores() {
  const cols = ['姓名', '学号', '类型', '项目', '分值', '原因', '加分时间', '来源', '小组', '成员数'];
  const rows = all('SELECT * FROM score_records ORDER BY 加分时间 DESC, id DESC').map((r) => ({
    ...pick(r, cols.slice(1, 7)),
    姓名: r.姓名 || '',
    来源: r.source === 'group' ? '小组' : '个人',
    小组: r.group_name || '',
    // 只有小组加分才有成员数；个人记录显示 0 会被误读成「零个人」
    成员数: r.source === 'group' && r.成员数 != null ? r.成员数 : '',
  }));
  return table(cols, rows);
}

function tFees() {
  const cols = ['收支编码', '收支类型', '收支金额', '收支时间', '备注', '收据'];
  const rows = all('SELECT * FROM fee_records ORDER BY position ASC, id ASC').map((r) => {
    const receipts = safeJson(r.收据, [], '收据');
    const list = Array.isArray(receipts) ? receipts.filter(Boolean) : [];
    // 收据是路径数组。单元格里换行列出，比「3 张」保留的信息更多。
    // 元素有两种形状：老数据是路径字符串，新数据是 { path, name, size, kind } ——
    // 直接 join 对象会得到一串 [object Object]（而它不是 JSON，靠「无裸 JSON」那条判据抓不到）
    const names = list.map(receiptNameOf).filter(Boolean);
    return { ...pick(r, cols.slice(0, 5)), 收据: names.join('\n') };
  });
  return table(cols, rows);
}

/** 收据条目 → 显示用文件名（老数据是纯路径，新数据带原始名） */
function receiptNameOf(it) {
  if (typeof it === 'string') return path.basename(it);
  const raw = it && (it.name || it.path);
  return raw ? path.basename(String(raw)) : '';
}

// 数据管理是「导库」口径：直接按库里的 fee_records 分组。
// 班费页那份是按**当前表格内容**分的（含还没保存的新行、正在编辑的值），两者语义不同，
// 不要互相替代 —— 一个要「备份数据库」，一个要「导出我现在看到的」。
// 编码为空 / 全空白的落「未编号」，与 zip 里的目录名规则一致。
function collectReceiptGroups() {
  const groups = new Map();
  for (const r of all('SELECT * FROM fee_records ORDER BY position ASC, id ASC')) {
    const list = safeJson(r.收据, [], '收据');
    if (!Array.isArray(list) || !list.length) continue;
    const code = String(r.收支编码 == null ? '' : r.收支编码).trim();
    const bucket = groups.get(code) || [];
    for (const it of list) {
      if (!it) continue;
      const p = typeof it === 'string' ? it : it.path;
      if (!p) continue;
      bucket.push({ path: p, name: receiptNameOf(it) });
    }
    groups.set(code, bucket);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length)
    .map(([code, items]) => ({ code, items }));
}

function tLeaves() {
  const cols = ['姓名', '类型', '开始时间', '结束时间', '家长联系电话', '学生联系电话', '状态', '返校时间', '备注'];
  const rows = all('SELECT * FROM leave_records ORDER BY position ASC, id ASC').map((r) => pick(r, cols));
  return table(cols, rows);
}

// ---------- 座位网格 ----------
// 座位本来就是二维网格，导出必须是一张网（行号 + 列头 + 走廊列），
// 拆成「座位行/座位列/姓名」明细等于把布局信息丢了。
//
// 走廊现在已是 seats 里的**真实列**，几何由 types 矩阵表达（0=座位 1=走廊 2=空位，
// 与前端 composables/useSeatGrid.js 同构）。这里只做「遍历 + 转文本」，
// 不再按 mode/showAisle 推导走廊位置 —— 原先那三个镜像函数（seatDisplayColCount /
// seatIsAisleCol / 按公式拼表头的 seatColHeaders）随异形网格改造删除：
// 留着它们就会在网格数据上**再插一遍**走廊列，导出列数直接翻倍。
// 表头/行走廊判定统一走 services/seatGrid.js，别在本文件再复制一份。

// 座位：seats 是二维数组，值可能是 student_id（数字）或手工录入的姓名（字符串）。
// 整张表按页面布局输出：第一行讲台，其余每行「第N行」。
// 竖走廊只在第一行写「走廊」（页面上是 rowspan 合并，导出用空格代替合并）；
// 横走廊（整行都是走廊）整行每列都写「走廊」，否则那一行会是一条看不出含义的空行。
function tSeats() {
  const row = get("SELECT mode, rows, cols, seats, types FROM seat_slots WHERE kind = 'current'");
  const seats = safeJson(row ? row.seats : null, [], 'seat_slots.seats');
  const seatRows = Array.isArray(seats) ? seats : [];
  const types = safeJson(row ? row.types : null, [], 'seat_slots.types');

  // 实际列数取「声明值」和「最长一行」的较大者：历史数据里 seats 可能比 cols 宽，
  // 只信 cols 会把右边几列整段截掉
  let cols = Number(row && row.cols) || 0;
  for (const line of seatRows) {
    if (Array.isArray(line) && line.length > cols) cols = line.length;
  }
  let rows = Number(row && row.rows) || 0;
  if (seatRows.length > rows) rows = seatRows.length;

  const nameById = studentNameMap();
  const colHeaders = columnLabels(cols, types);
  const aisleRow = (r) => rowIsAisle(types, r);

  const out = [];
  // 讲台行：导出器按 _isPodium 识别，且要求第一列表头是「行号」才会合并成一格
  out.push({ 行号: '讲台', _isPodium: true, label: '讲  台' });

  for (let r = 0; r < rows; r++) {
    const line = seatRows[r] || [];
    const obj = { 行号: `第${r + 1}行` };
    const wholeRowAisle = aisleRow(r);
    for (let c = 0; c < cols; c++) {
      const header = colHeaders[c] || `列${c + 1}`;
      if (types[r] && types[r][c] === SEAT_CELL.AISLE) {
        obj[header] = (wholeRowAisle || r === 0) ? '走廊' : '';
        continue;
      }
      // 空位要写成「空位」：留白的话导出表和「这个座位还没人」完全一样，
      // 用户拿导出的表对布局根本分不出「这儿没桌子」和「这儿空着」
      if (types[r] && types[r][c] === SEAT_CELL.HOLE) {
        obj[header] = '空位';
        continue;
      }
      const v = line[c];
      obj[header] = v === null || v === undefined || v === ''
        ? ''
        : (typeof v === 'number' ? (nameById[v] || '') : String(v));
    }
    out.push(obj);
  }

  return table(['行号', ...colHeaders], out);
}

// 值日：cells = { 项目: { 列: [人名] } }
// ⚠️ 当前值日表（kind='current'）的 cells 是**按模式分键**的 {daily:{...},big:{...}}，
//    列名也按模式分键（日常值日=星期几，大扫除=分组名+全部）。
//    这里导出**当前模式**的值日表：日常值日与大扫除的列名不同，混在一张表里没法看，
//    所以按模式各导一张（key 不同、label 不同）。
function tDuties(mode) {
  const m = mode === 'big' ? 'big' : 'daily';
  const row = get("SELECT cells FROM duty_slots WHERE kind = 'current'");
  const packed = safeJson(row ? row.cells : null, {}, 'duty_slots.cells');
  const cells = (packed && typeof packed === 'object' && packed[m] && typeof packed[m] === 'object')
    ? packed[m] : {};
  const dayList = dutyConfig.readDays(m);
  const out = [];
  for (const item of Object.keys(cells || {})) {
    const byDay = cells[item] || {};
    const line = { 项目: item };
    for (const d of dayList) {
      const ppl = byDay[d];
      line[d] = Array.isArray(ppl) ? ppl.filter(Boolean).join('、') : (ppl || '');
    }
    out.push(line);
  }
  return table(['项目', ...dayList], out);
}

// 课程表：cells 是「节次 × 星期」的二维数组，单元格可能是字符串或对象
function tSchedule() {
  const row = get("SELECT cells, settings FROM schedule_slots WHERE kind = 'current'");
  const cells = safeJson(row ? row.cells : null, [], 'schedule_slots.cells');
  const settings = safeJson(row ? row.settings : null, {}, 'schedule_slots.settings');
  const dayList = Array.isArray(settings && settings.days) && settings.days.length
    ? settings.days
    : WEEK.slice(0, 5);
  const out = [];
  const list = Array.isArray(cells) ? cells : [];
  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    if (!Array.isArray(line)) continue;
    const rowObj = { 节次: `第${i + 1}节` };
    for (let j = 0; j < dayList.length; j++) {
      const v = line[j];
      if (v === null || v === undefined || v === '') rowObj[dayList[j]] = '';
      else if (typeof v === 'object') rowObj[dayList[j]] = v.course || v.课程 || JSON.stringify(v);
      else rowObj[dayList[j]] = String(v);
    }
    out.push(rowObj);
  }
  return table(['节次', ...dayList], out);
}

function tSemesters() {
  const cols = ['学期名', '开始日期', '结束日期', '是否当前'];
  const rows = all('SELECT * FROM semesters ORDER BY id ASC').map((r) => ({
    学期名: r.name || '',
    开始日期: r.start_date || '',
    结束日期: r.end_date || '',
    是否当前: r.is_current ? '是' : '',
  }));
  return table(cols, rows);
}

function tGroups() {
  const cols = ['分组维度', '小组名', '成员', '备注'];
  const dims = {};
  for (const d of all('SELECT id, name FROM group_dimensions')) dims[d.id] = d.name || '';
  const groups = all('SELECT id, dimension_id, name FROM groups ORDER BY sort_order ASC, id ASC');
  const members = {};
  for (const m of all('SELECT group_id, member_name, remark FROM group_members ORDER BY sort_order ASC, id ASC')) {
    if (!members[m.group_id]) members[m.group_id] = [];
    members[m.group_id].push({ name: m.member_name || '', remark: m.remark || '' });
  }
  const rows = groups.map((g) => {
    const list = members[g.id] || [];
    return {
      分组维度: dims[g.dimension_id] || '',
      小组名: g.name || '',
      成员: list.map((x) => x.name).filter(Boolean).join('、'),
      备注: list.map((x) => x.remark).filter(Boolean).join('；'),
    };
  });
  return table(cols, rows);
}

function tCadres() {
  const cols = ['职务', '上级职务', '成员'];
  const cadres = all('SELECT id, name, parent_id FROM cadres ORDER BY sort_order ASC, id ASC');
  const byId = {};
  for (const c of cadres) byId[c.id] = c.name || '';
  const members = {};
  for (const m of all('SELECT cadre_id, student_name FROM cadre_members ORDER BY sort_order ASC, id ASC')) {
    if (!members[m.cadre_id]) members[m.cadre_id] = [];
    members[m.cadre_id].push(m.student_name || '');
  }
  const rows = cadres.map((c) => ({
    职务: c.name || '',
    上级职务: c.parent_id ? (byId[c.parent_id] || '') : '',
    成员: (members[c.id] || []).filter(Boolean).join('、'),
  }));
  return table(cols, rows);
}

function tActivities() {
  const cols = ['时间', '主题', '地点', '简介', '参与人员'];
  const rows = all('SELECT * FROM activities ORDER BY position ASC, id ASC').map((r) => pick(r, cols));
  return table(cols, rows);
}

function tCountdowns() {
  const cols = ['名称', '截止日', '包含这一天'];
  const rows = all('SELECT * FROM countdowns ORDER BY position ASC, id ASC').map((r) => ({
    名称: r.名称 || '',
    截止日: r.截止日 || '',
    包含这一天: r.包含这一天 ? '是' : '',
  }));
  return table(cols, rows);
}

function tAlbums() {
  const cols = ['相册名', '文件夹', '相册类型', '照片数'];
  const counts = {};
  for (const p of all('SELECT album_id, COUNT(*) AS n FROM album_photos GROUP BY album_id')) {
    counts[p.album_id] = p.n;
  }
  const rows = all('SELECT * FROM albums ORDER BY sort_order ASC, id ASC').map((r) => ({
    相册名: r.name || '',
    文件夹: r.folder_path || '',
    相册类型: labelOf(ALBUM_KIND_LABELS, r.kind),
    照片数: counts[r.id] || 0,
  }));
  return table(cols, rows);
}

function tAlbumPhotos() {
  const cols = ['相册', '文件名', '大小(KB)', '拍摄日期', '路径'];
  const names = {};
  for (const a of all('SELECT id, name FROM albums')) names[a.id] = a.name || '';
  const rows = all('SELECT * FROM album_photos ORDER BY album_id ASC, photo_date ASC, id ASC').map((r) => ({
    相册: names[r.album_id] || '',
    文件名: r.file_name || '',
    '大小(KB)': r.file_size ? Math.round(r.file_size / 1024) : '',
    拍摄日期: r.photo_date || r.exif_date || '',
    路径: r.file_path || '',
  }));
  return table(cols, rows);
}

function tDomainHistory() {
  const cols = ['时间', '类型', '周起始', '快照日期', '内容'];
  const rows = all('SELECT * FROM domain_history ORDER BY id ASC').map((r) => ({
    时间: r.created_at || '',
    类型: labelOf(DOMAIN_LABELS, r.domain),
    周起始: r.week_start || '',
    快照日期: r.snap_date || '',
    // payload 是整张课表/值日/座位表的快照对象，展开成键值串而不是原样塞 JSON
    内容: readable(safeJson(r.payload, r.payload, 'domain_history.payload'), 0, LABELS_SNAPSHOT),
  }));
  return table(cols, rows);
}

function tUndoHistory() {
  const cols = ['时间', '类型', '说明', '方向', '来源', '内容'];
  const rows = all('SELECT * FROM undo_history ORDER BY id ASC').map((r) => ({
    时间: r.ts || '',
    类型: labelOf(UNDO_TYPE_LABELS, r.type),
    说明: r.label || '',
    方向: r.dir === 1 ? '撤销' : '重做',
    来源: r.origin || '',
    内容: readable(safeJson(r.payload, r.payload, 'undo_history.payload'), 0, LABELS_UNDO),
  }));
  return table(cols, rows);
}

function tAiConversations() {
  const cols = ['标题', '消息数', '创建时间', '更新时间'];
  const counts = {};
  for (const m of all('SELECT conversation_id, COUNT(*) AS n FROM ai_messages GROUP BY conversation_id')) {
    counts[m.conversation_id] = m.n;
  }
  const rows = all('SELECT * FROM ai_conversations ORDER BY id ASC').map((r) => ({
    标题: r.title || '',
    消息数: counts[r.id] || 0,
    创建时间: r.created_at || '',
    更新时间: r.updated_at || '',
  }));
  return table(cols, rows);
}

function tAiMessages() {
  const cols = ['对话标题', '角色', '内容', '时间'];
  const titles = {};
  for (const c of all('SELECT id, title FROM ai_conversations')) titles[c.id] = c.title || '';
  const rows = all('SELECT * FROM ai_messages ORDER BY id ASC').map((r) => ({
    对话标题: titles[r.conversation_id] || '',
    角色: r.role === 'user' ? '我' : (r.role === 'assistant' ? 'AI' : (r.role || '')),
    内容: r.content || '',
    时间: r.created_at || '',
  }));
  return table(cols, rows);
}

// 应用设置：做成「设置项 / 值」两列的长表。
// ⚠️ API 密钥必须打码：这份导出是给用户拷到 U 盘/发同事的，明文密钥等于把账号送人。
function tSettings() {
  const rows = [];
  const ai = get('SELECT * FROM ai_settings WHERE id = 1') || {};
  const mask = (v) => (v ? '已设置（不导出）' : '');
  rows.push({ 设置项: 'AI 功能开关', 值: ai.enabled ? '开启' : '关闭' });
  rows.push({ 设置项: 'AI 浮窗', 值: ai.floating_enabled ? '显示' : '隐藏' });
  rows.push({ 设置项: 'AI 服务商', 值: ai.provider || '' });
  rows.push({ 设置项: 'AI 接口地址', 值: ai.base_url || '' });
  rows.push({ 设置项: 'AI 模型', 值: ai.model || '' });
  rows.push({ 设置项: 'AI 密钥', 值: mask(ai.api_key) });

  const w = get('SELECT * FROM widget_settings WHERE id = 1') || {};
  rows.push({ 设置项: '工具箱', 值: w.toolbox_enabled ? '开启' : '关闭' });
  rows.push({ 设置项: '便签保存路径', 值: w.note_save_path || '' });
  rows.push({ 设置项: '截图保存路径', 值: w.screenshot_save_path || '' });
  rows.push({ 设置项: '班级信息', 值: readable(safeJson(w.class_info, {}, 'widget_settings.class_info'), 0, LABELS_CLASS_INFO) });
  rows.push({ 设置项: '桌面常用软件', 值: readable(safeJson(w.desktop_apps, [], 'widget_settings.desktop_apps'), 0, LABELS_DESKTOP_APP) });
  return table(['设置项', '值'], rows);
}

// ---------- 清单 ----------
// 顺序即界面上的显示顺序。key 只用于前后端对照，label 是用户看到的名字。
// py：表名的拼音首字母，供设置页搜索框用（与 SettingsView 的搜索同一个匹配口径：
// 命中「表名片段」或「拼音首字母」即算匹配，输入 xs 能找到「学生名单」）。
// 它必须和 label 一起维护 —— 探针里有断言守着（长度按 label 的中/英文字数算）。
// count：只给「一行对应物理表一行」的表实现（1-3）。座位/值日/课程表/设置是整块 JSON
// 的单一文档，行数由内容派生，没有对应物理表，因此不提供 count、由 build 兜底。
const TABLES = [
  { key: 'students', label: '学生名单', py: 'xsmd', build: tStudents, count: () => countOf('students') },
  { key: 'scores', label: '成绩记录', py: 'cjjl', build: tScores, count: () => countOf('score_records') },
  { key: 'fees', label: '班费记录', py: 'bfjl', build: tFees, count: () => countOf('fee_records') },
  { key: 'leaves', label: '请假记录', py: 'qjjl', build: tLeaves, count: () => countOf('leave_records') },
  { key: 'seats', label: '座位表', py: 'zwb', build: tSeats },
  { key: 'duties', label: '值日表', py: 'zrb', build: () => tDuties('daily') },
  { key: 'dutiesBig', label: '值日表（大扫除）', py: 'zrbdsc', build: () => tDuties('big') },
  { key: 'schedule', label: '课程表', py: 'kcb', build: tSchedule },
  { key: 'semesters', label: '学期列表', py: 'xqlb', build: tSemesters, count: () => countOf('semesters') },
  { key: 'groups', label: '小组', py: 'xz', build: tGroups, count: () => countOf('groups') },
  { key: 'cadres', label: '班干', py: 'bg', build: tCadres, count: () => countOf('cadres') },
  { key: 'activities', label: '活动', py: 'hd', build: tActivities, count: () => countOf('activities') },
  { key: 'countdowns', label: '倒计时', py: 'djs', build: tCountdowns, count: () => countOf('countdowns') },
  { key: 'albums', label: '相册索引', py: 'xcsy', build: tAlbums, count: () => countOf('albums') },
  { key: 'albumPhotos', label: '相册照片清单', py: 'xczpqd', build: tAlbumPhotos, count: () => countOf('album_photos') },
  { key: 'domainHistory', label: '课程历史', py: 'kcls', build: tDomainHistory, count: () => countOf('domain_history') },
  { key: 'undoHistory', label: '撤销记录', py: 'cxjl', build: tUndoHistory, count: () => countOf('undo_history') },
  { key: 'aiConversations', label: 'AI 对话', py: 'aidh', build: tAiConversations, count: () => countOf('ai_conversations') },
  { key: 'aiMessages', label: 'AI 消息', py: 'aixx', build: tAiMessages, count: () => countOf('ai_messages') },
  { key: 'settings', label: '应用设置', py: 'yysz', build: tSettings },
];

const BY_KEY = new Map(TABLES.map((t) => [t.key, t]));

// GET /api/data/tables —— 只回清单和行数，不搬数据（设置页一进来就要显示列表）
router.get('/tables', (req, res) => {
  const list = TABLES.map((t) => {
    let count = 0;
    try {
      // 1-3：有 count() 的表只取行数；座位/值日/课程表/设置是「整块 JSON」单一文档，
      // 行数由内容派生，仍走 build（成本与表大小无关，且没有对应的物理表）。
      count = t.count ? t.count() : (t.build() || { rows: [] }).rows.length;
    } catch (_) { count = 0; }
    return { key: t.key, label: t.label, py: t.py, count };
  });
  res.json({ tables: list });
});

// POST /api/data/sources { keys: [...] } —— 取指定表的数据
router.post('/sources', (req, res) => {
  const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
  const out = [];
  for (const key of keys) {
    const def = BY_KEY.get(key);
    if (!def) continue;
    const data = def.build();
    out.push({ key: def.key, label: def.label, fields: data.fields, rows: data.rows });
  }
  res.json({ tables: out });
});

// zip 里的目录/文件名清洗：不能带 ../、盘符或控制字符
function safeSegment(s, fallback) {
  const v = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return v || fallback;
}

// POST /api/data/zip {
//   entries: [{ name, data(base64) }],
//   receiptGroups: [{ code, items: [{ path, name }] }],   // 可选：前端已分好组时直接给
//   includeReceipts: true,                                 // 可选：后端按库里的 fee_records 自己分组
//   password, filename
// }
// 返回 zip 字节流。前端用现有的 SAVE_FILE 通道落盘，因此不必新开 IPC 通道。
//
// 为什么是流式：收据原件可能有几百 MB，旧实现「readFileSync 收据 → deflate 副本 →
// 每条局部块 → 终包 concat」会在内存里叠出四份，大班导出直接把后端顶爆（v6 · P2-01）。
// 现在收据只传磁盘路径，条目边读边写进响应，任何时刻只持有一个 256KB 块。
router.post('/zip', async (req, res) => {
  const body = req.body || {};
  const entries = Array.isArray(body.entries) ? body.entries : [];

  // 条目统一成 { name, data } / { name, path }：前者来自前端（表格化文本），
  // 后者来自 uploads（收据原件，交给写入器流式读盘，不在这里整份读进内存）。
  const items = [];
  for (const e of entries) {
    const name = String((e && e.name) || '').trim();
    if (!name) continue;
    let buf;
    try {
      buf = Buffer.from(String((e && e.data) || ''), 'base64');
    } catch (_) {
      return res.status(400).json({ error: `文件「${name}」内容无法解析` });
    }
    items.push({ name, data: buf, method: 'deflate' });
  }

  // 数据管理传 includeReceipts（它手里只有表格化后的文本，没有原始路径）；
  // 班费页传 receiptGroups（它要导的是「当前页面看到的数据」）。两种来源二选一。
  const groups = Array.isArray(body.receiptGroups)
    ? body.receiptGroups
    : (body.includeReceipts ? collectReceiptGroups() : []);

  // 收据文件：从 uploads 读，按「收据文件/收支编码/原文件名」塞进包。
  // 只认 uploads 根目录下的文件名（basename 压平），穿越不出去；
  // 单个文件读失败只跳过它，不让整包导出失败（少一张收据也比全丢好）。
  if (groups.length) {
    const uploadsRoot = path.resolve(dbManager.uploadsDir);
    for (const g of groups) {
      // 收支编码可能为空（用户没填）或重名，空就落到「未编号」
      const code = safeSegment(g && g.code, '未编号');
      for (const it of (g && Array.isArray(g.items) ? g.items : [])) {
        const base = path.basename(String((it && it.path) || ''));
        if (!base || base === '.' || base === '..') continue;
        const abs = path.join(uploadsRoot, base);
        if (!abs.startsWith(uploadsRoot + path.sep)) continue;
        try {
          if (!fs.existsSync(abs)) continue;
          const display = safeSegment(it.name, base);
          // 只登记路径：文件在写入器里流式读，读失败时整包中断（旧实现会跳过，
          // 但那要求先把文件读进内存；收据不存在已在上面的 existsSync 挡掉）
          items.push({ name: `收据文件/${code}/${display}`, path: abs });
        } catch (_) { /* 被占用/权限不足：跳过这一个 */ }
      }
    }
  }

  if (!items.length) return res.status(400).json({ error: '没有要打包的文件' });

  const password = typeof body.password === 'string' ? body.password : '';
  const safeName = String(body.filename || '数据导出').replace(/[\\/:*?"<>|]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  // 文件名走 RFC 5987，中文名不会变成乱码或被截断
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(safeName + '.zip')}`
  );
  // 不设 Content-Length：长度要等整包写完才知道，预置就等于把流式又变回「先拼完」
  // PERF_EXPORT=1 时记录导出前后内存差值；默认空操作，不影响普通导出。
  const memBefore = memSnapshot();
  let finished = false;
  try {
    await writeZip(items, res, { password });
    res.end();
    finished = true;
  } catch (err) {
    // 已经开始写响应体了：只能中断连接，让客户端看到「下载不完整」而不是一个坏包
    console.error('[data] 导出 zip 失败:', err && err.message);
    try { res.destroy(); } catch (_) { /* 已断开 */ }
  } finally {
    logExportMemory(finished ? 'zip 完成' : 'zip 失败', memBefore);
  }
});

module.exports = router;
