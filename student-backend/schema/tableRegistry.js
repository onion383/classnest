'use strict';

// 表名的唯一名单（v6 · 6-2）。
//
// 单独成文件的理由：物理表名此前只存在于 schema/*.js 的 DDL 文本里，业务层要
// 用「某类表」时各自抄一份数组（通用 CRUD 白名单、撤销白名单、AI 检索枚举、
// 座位当前表），四处之间没有任何约束。抄漏一处不会报错：撤销悄悄不记录、
// AI 少查一张表、座位写到 draft 上，全都要靠用户撞见。
//
// 本文件只放**名字与分组**，不 require 任何模块：业务代码、路由、单元测试与
// ESLint 配置都会引用它，带一个 require 就会把 db / electron 拖进纯计算场景。
//
// 两类名字必须分开存，混用会写错表：
//   物理表：CREATE TABLE 真建出来的表（由 architecture-guard 测试与 DDL 双向锁定）
//   逻辑表：slotStore 的 key —— 多行表里按 kind 区分的一类槽位，物理上共用一张表
//           （例如 seat_layout / seat_template 都落在 seat_slots）

// 按 schema 文件分组，分组名与文件名一致，便于对账。
// pending_requests 已移除（P3-1）：功能被 mcp_proposals 取代后它只剩余 DDL，业务引用为 0。
// 老库里那张表**不主动 DROP** —— 保留无害，删它就成了一次不可逆操作。
const PHYSICAL = {
  core: ['students', 'table_meta', 'users'],
  fee: ['fee_records'],
  leave: ['leave_records'],
  score: ['score_records'],
  cadre: ['cadres', 'cadre_members'],
  group: ['group_dimensions', 'groups', 'group_members'],
  duty: ['duty_slots'],
  seat: ['seat_slots'],
  schedule: ['semesters', 'schedule_slots'],
  history: ['domain_history'],
  activity: ['activities', 'countdowns'],
  album: ['albums', 'album_photos', 'album_scan_tasks'],
  ai: ['ai_settings', 'ai_models', 'ai_conversations', 'ai_messages'],
  undo: ['undo_history'],
  widget: ['widget_settings'],
  // 方向 B：外部 MCP 客户端提交的待确认写提案（schema.mcp.js）
  // mcp_tokens 是令牌明文副本（班级库加密，主密钥保护），漏登记过一次 ——
  // 漏登记不会报错，只会让 architecture-guard 的「DDL ↔ registry 双向一致」挂掉。
  mcp: ['mcp_proposals', 'mcp_tokens'],
  // 数据访问记录（schema.log.js）：AI / MCP 的读操作，只存元信息
  log: ['access_log'],
};

const ALL_PHYSICAL = Object.freeze(Object.values(PHYSICAL).flat());

// 逻辑表 → 物理表。与 services/slotStore.js 的 SPEC 保持一致（由架构测试锁）。
const LOGICAL = Object.freeze({
  schedule: 'schedule_slots',
  master_schedule: 'schedule_slots',
  duty_settings: 'duty_slots',
  duty_layout: 'duty_slots',
  duty_template: 'duty_slots',
  duty_weight: 'duty_slots',
  duty_draft: 'duty_slots',
  seat_layout: 'seat_slots',
  seat_template: 'seat_slots',
  seat_weight: 'seat_slots',
  seat_draft: 'seat_slots',
});

const ALL_LOGICAL = Object.freeze(Object.keys(LOGICAL))

// 三张历史只读视图（schema.history.js 基于 domain_history 建）：
// 名字不是物理表也不是逻辑槽位，但 AI 可读名单里有它们，isKnownName 必须认得（X3-20）。
const HISTORY_VIEWS = Object.freeze(['schedule_history', 'duty_history', 'seat_history']);

// ---- 业务白名单：引用方只 import，不许再抄一份 ----

// services/tableService.js：通用行列增删改能碰的表。
const GENERIC_CRUD_TABLES = Object.freeze(['students', 'fee_records', 'leave_records']);

// routes/undo/undo.executors.js：允许记录撤销的动态表名（防注入）。
// 含 cadre_members：跨表批量写入（propose_batch）会写职务成员，必须可撤。
const UNDO_WRITE_TABLES = Object.freeze([
  'students',
  'fee_records',
  'leave_records',
  'score_records',
  'group_members',
  'groups',
  'group_dimensions',
  'activities',
  'countdowns',
  'cadres',
  'cadre_members',
]);

// routes/ai/ai.tools/tools.schema.js：search_all 允许检索的表。
// 座位 / 值日在这里是**逻辑表**：AI 面向用户描述的是「座位表」「值日表」。
const AI_SEARCH_TABLES = Object.freeze([
  'students',
  'score_records',
  'leave_records',
  'cadre_members',
  'group_members',
  'seat_layout',
  'duty_layout',
]);

// services/seatWrite.js：只有这两张有「当前座位」语义，写错表必须当场失败。
const SEAT_CURRENT_SLOTS = Object.freeze(['seat_layout', 'seat_template']);

// services/undoStore.js：以二维 `cells` 矩阵存几何的表（课表两份）。
// 撤销/重做越界格前要用「当前矩阵形状」校验——形状来自数据本身，不是写死的行列数。
const MATRIX_GEOMETRY_TABLES = Object.freeze(['schedule', 'master_schedule']);

// routes/undo/undo.executors.js：以「整块 JSON 列」存数据、撤销时整列还原的表。
// 除 widget_settings 外都是逻辑表；混在一张清单里是因为撤销只认「表名 + 列名」。
const UNDO_DOC_TABLES = Object.freeze([
  'schedule',
  'master_schedule',
  'seat_layout',
  'seat_template',
  'seat_weight',
  'duty_settings',
  'duty_layout',
  'duty_template',
  'duty_weight',
  'widget_settings',
]);

// 值日有两张存学生引用的表：当前表 + 模板。删学生的关联统计/清理/撤销、
// 「应用模板」都要同时覆盖两张（模板引用会在当前表为空时被读出来）。
const DUTY_TABLES = Object.freeze(['duty_layout', 'duty_template']);

// routes/ai/ai.tools/tools.executors/executors.checks.js：每条体检 / 冲突规则实际会读的表。
// AI 的「完全禁止」读闸门直接消费这份声明；规则实现里不许再手抄表名数组，
// 新增规则必须在这里登记，否则执行器的 fail-closed 判定会拒绝它。
const AI_CHECK_RULE_TABLES = Object.freeze({
  cadre_dangling: Object.freeze(['cadre_members', 'students']),
  group_dangling: Object.freeze(['group_members', 'students']),
  score_dangling: Object.freeze(['score_records', 'students']),
  leave_dangling: Object.freeze(['leave_records', 'students']),
  seat_dangling: Object.freeze(['seat_layout', 'students']),
  duty_dangling: Object.freeze(['duty_layout', 'students']),
  leave_reversed: Object.freeze(['leave_records']),
  fee_negative: Object.freeze(['fee_records']),
  sno_duplicate: Object.freeze(['students']),
  seat_duplicate: Object.freeze(['seat_layout', 'students']),
  duty_duplicate: Object.freeze(['duty_layout']),
  countdown_passed: Object.freeze(['countdowns']),
  schedule_conflict: Object.freeze(['schedule']),
});

// score_weights 的两组依赖：座位指数要权重 + 历史 + 学生姓名映射，值日指数只要权重 + 历史。
const AI_SCORE_TABLES = Object.freeze({
  seat: Object.freeze(['seat_weight', 'seat_history', 'students']),
  duty: Object.freeze(['duty_weight', 'duty_history']),
});

// 物理表名与逻辑表名都算「已知表名」；白名单 / 配置里出现别的名字即视为手抄。
function isKnownName(name) {
  return ALL_PHYSICAL.includes(name) || ALL_LOGICAL.includes(name) || HISTORY_VIEWS.includes(name);
}

module.exports = {
  PHYSICAL,
  ALL_PHYSICAL,
  LOGICAL,
  ALL_LOGICAL,
  HISTORY_VIEWS,
  GENERIC_CRUD_TABLES,
  UNDO_WRITE_TABLES,
  UNDO_DOC_TABLES,
  AI_SEARCH_TABLES,
  AI_CHECK_RULE_TABLES,
  AI_SCORE_TABLES,
  SEAT_CURRENT_SLOTS,
  MATRIX_GEOMETRY_TABLES,
  DUTY_TABLES,
  isKnownName,
};
