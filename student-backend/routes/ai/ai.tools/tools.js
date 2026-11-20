// ===== AI 工具门面：装配 schema / executors / subagent，并提供统一派发入口 =====
// 只负责 require 装配、runTool 派发与对外导出；
// 具体定义见 tools.schema.js（工具定义）、tools.executors/executors.js（执行逻辑）、tools.subagent.js（子助手）。
//
// 原 tools.js 的内部分节与拆分后的去向（原文保留，便于对照）：
//   ---------------- 工具定义 ----------------
//       → tools.schema.js
//   ===================== 通用小工具（日期 / JSON / 姓名） =====================
//       → tools.executors/executors.common.js
//   ===== export_image 工具：课表/座位表/值日表 → 排布图规格（前端渲染成 PNG） =====
//       → tools.executors/executors.image.js
const dbManager = require('../../../dbManager/dbManager');
const accessLog = require('../../../services/accessLogStore');
const { privacy, hasUnrestoredToken } = require('../../../services/aiPrivacy');
const { writeScope } = require('../../../services/aiWriteScope');
const schema = require('./tools.schema');
const exec = require('./tools.executors/executors');
const { subagentTool, runSubagent } = require('./tools.subagent');

const {
  runQuery, runAggregate, runResolveStudent, runListChanges, runSearchAll, runChecks,
  runConflictChecks, runScoreWeights, buildExportImage, runDescribeTable, runSnapshotCreate,
  runSnapshotList, runSnapshotRestoreProposal, runDeleteImpact, runTeachingWeek, runShowRecord,
  runShowChart, currentTimeInfo, runWebSearch, runUndoChange, normalizeProposal,
  normalizeBatchProposal, normalizeBatchDelete, normalizeJsonProposal, normalizeFrontProposal,
  runProposeSkill, normalizeBatchUpdate, normalizeBatchOps, normalizeAsk, normalizeExport,
  seatNameHint,
} = exec;

// 统一的工具执行入口：流式 / 非流式共用
//   ctx.blocks 收集 record / chart 数据块；返回 { result, proposal?, ask? }
//   async：OCR 等工具需要等待外部进程，故统一 await 调用
// 会落库 / 落文件 / 渲染给用户的工具：代号必须全部还原，认不出就拒绝，
// 绝不能把 P-xxxxxx 写进数据库或导出的文件里。
const TOKEN_STRICT_TOOL_RE = /^(propose_|save_memory$|export_file$|show_chart$)/;

// 「只读 / 读写」闸门：写类工具在派发前统一拦一次，读类工具一律不受影响。
// 只拦「老师显式设成只读」的表 —— 不支持写入的表仍由各自的 normalize 报原有文案，
// 不能把「这表本来就不支持写」说成「你设了只读」，否则老师会去设置里找个不存在的开关。
const WRITE_TOOL_TABLE_REFS = {
  propose_write: (a) => [a && a.table],
  propose_add_many: (a) => [a && a.table],
  propose_delete_many: (a) => [a && a.table],
  propose_update_many: (a) => [a && a.table],
  propose_json_write: (a) => [a && a.table],
  // 批量提案里每个 op 各自带 table，要逐个查，不能只看第一层
  propose_batch: (a) => (Array.isArray(a && a.ops) ? a.ops.map((o) => o && o.table) : []),
};
function readonlyBlockedError(name, args) {
  const pick = WRITE_TOOL_TABLE_REFS[name];
  if (!pick) return '';
  const ro = writeScope.readonlyTables();
  for (const t of pick(args)) {
    const key = String(t || '').trim();
    if (key && ro.includes(key)) return writeScope.readonlyError(key).error;
  }
  return '';
}

async function dispatchTool(name, args, ctx) {
  // 入站还原必须在 normalizeProposal 之前：diff 的「旧值」来自库里真值，
  // 「新值」若还是代号，确认卡片会显示「真号 → P-xxxxxx」这种荒谬对照。
  // 只有显式带 slug 的主对话 / 子助手才还原；MCP 方向 B 不传 slug，保持原样。
  if (ctx && ctx.slug && args && typeof args === 'object' && !Array.isArray(args)) {
    try { args = privacy.restore(args, ctx.slug); } catch (_) { /* 保护模块故障不阻断工具 */ }
    if (TOKEN_STRICT_TOOL_RE.test(name) && hasUnrestoredToken(args)) {
      return { result: { ok: false, error: 'AI 数据保护：内容里有无法识别的代号（S-/P-），请按原名重新填写后再试' } };
    }
  }
  // 「只读」闸门：老师把某张表设成只读后，写类工具在派发前就被挡下，
  // 模型拿到明确原因（而不是先拼出提案、等老师点确认时才失败）。
  const roErr = readonlyBlockedError(name, args);
  if (roErr) return { result: { ok: false, error: roErr } };
  switch (name) {
    case 'query':
      return { result: runQuery(args) };
    case 'aggregate':
      return { result: runAggregate(args) };
    case 'resolve_student':
      return { result: runResolveStudent(args) };
    case 'list_changes':
      return { result: runListChanges(args) };
    case 'search_all':
      return { result: runSearchAll(args) };
    case 'run_checks':
      return { result: runChecks(args) };
    case 'run_conflict_checks':
      return { result: runConflictChecks(args) };
    case 'score_weights':
      return { result: runScoreWeights(args) };
    case 'export_image': {
      const e = buildExportImage(args || {});
      if (e.error) return { result: { ok: false, error: e.error } };
      return {
        exportImage: e.spec,
        result: {
          ok: true,
          generated: true,
          targets: e.spec.items.map((it) => it.target),
          count: e.spec.items.length,
          note: '排布图已生成，界面会弹出系统保存对话框由用户选择保存位置；正文用一句话说明导出了什么即可，不要编造保存路径，也不要重复调用本工具',
        },
      };
    }
    case 'propose_write': {
      const p = normalizeProposal(args);
      if (!p.ok) return { result: { ok: false, error: p.error } };
      return {
        proposal: { operation: p.operation, table: p.table, data: p.data, label: p.label, ...(p.diff ? { diff: p.diff } : {}), ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: {
          ok: true, message: p.label, pending_user_confirmation: true,
          ...(p.diff && p.diff.length ? { diff: p.diff } : {}),
        },
      };
    }
    case 'propose_add_many': {
      const b = normalizeBatchProposal(args);
      if (!b.ok) return { result: { ok: false, error: b.error } };
      return {
        proposal: { operation: 'add', batch: true, table: b.table, data: { rows: b.rows }, label: b.label, ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: { ok: true, message: b.label, count: b.count, pending_user_confirmation: true },
      };
    }
    case 'propose_delete_many': {
      const d = normalizeBatchDelete(args);
      if (!d.ok) return { result: { ok: false, error: d.error } };
      return {
        proposal: { operation: 'delete', batch: true, table: d.table, data: { ids: d.ids }, label: d.label, ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: {
          ok: true, message: d.label, count: d.count, pending_user_confirmation: true,
          ...(d.missing.length ? { note: `已忽略不存在的 id：${d.missing.join('、')}` } : {}),
        },
      };
    }
    case 'propose_json_write': {
      const j = normalizeJsonProposal(args);
      if (!j.ok) return { result: { ok: false, error: j.error } };
      // 座位表的人名核对结果必须回到模型上下文：模型要在回复里说明「这些名字名册里
      // 没有、确认后会自动建档」。不塞进去，模型就只会说「座位表已生成」。
      const seatNote = j.seatNames ? seatNameHint(j.seatNames) : '';
      return {
        proposal: { kind: 'json', table: j.table, id: j.id, values: j.values, before: j.before, label: j.label, ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: {
          ok: true,
          message: j.label,
          pending_user_confirmation: true,
          ...(seatNote ? { note: seatNote, seat_name_check: j.seatNames } : {}),
        },
      };
    }
    case 'propose_frontend_setting': {
      const f = normalizeFrontProposal(args);
      if (!f.ok) return { result: { ok: false, error: f.error } };
      return {
        proposal: { kind: 'front', key: f.key, value: f.value, label: f.label },
        result: { ok: true, message: f.label, pending_user_confirmation: true },
      };
    }
    case 'propose_skill': {
      const s = runProposeSkill(args, ctx);
      if (s.error) return { result: { ok: false, error: s.error } };
      return {
        proposal: s.proposal,
        result: { ok: true, message: s.proposal.label, pending_user_confirmation: true },
      };
    }
    case 'propose_update_many': {
      const u = normalizeBatchUpdate(args || {});
      if (!u.ok) return { result: { ok: false, error: u.error } };
      return {
        proposal: { operation: 'update', batch: true, table: u.table, data: { updates: u.updates }, diffs: u.diffs, label: u.label, ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: { ok: true, message: u.label, count: u.count, diffs: u.diffs, pending_user_confirmation: true },
      };
    }
    case 'propose_batch': {
      const b = normalizeBatchOps(args || {});
      if (!b.ok) return { result: { ok: false, error: b.error } };
      return {
        proposal: { kind: 'batch_ops', ops: b.ops, label: b.label, ...(args.source ? { originNote: String(args.source).slice(0, 80) } : {}) },
        result: { ok: true, message: b.label, count: b.count, pending_user_confirmation: true },
      };
    }
    case 'describe_table':
      return { result: runDescribeTable(args || {}) };
    case 'snapshot_create':
      return { result: await runSnapshotCreate(ctx) };
    case 'snapshot_list':
      return { result: runSnapshotList(ctx) };
    case 'snapshot_restore': {
      const r = runSnapshotRestoreProposal(ctx && ctx.slug, args || {});
      if (!r.ok) return { result: { ok: false, error: r.error } };
      return {
        proposal: { kind: 'snapshot_restore', snapshot: r.snapshot, label: r.label, warning: '还原将覆盖当前全部数据（含快照之后的所有改动），且无法撤销' },
        result: { ok: true, message: r.label, pending_user_confirmation: true, warning: '还原会覆盖当前全部数据，请向用户说明清楚后再确认' },
      };
    }
    case 'delete_impact':
      return { result: runDeleteImpact(args || {}) };
    case 'teaching_week':
      return { result: runTeachingWeek(args || {}) };
    case 'run_subagent': {
      const out = await runSubagent(args || {}, ctx);
      // trace（子助手的思考与工具轨迹）只给界面过程块，不进 result：
      // result 会被 toolResultContent 回灌给主模型，带进去只会白白撑大上下文。
      const { trace, ...result } = out || {};
      return { result, trace };
    }
    case 'show_record': {
      const sr = runShowRecord(args);
      if (!sr.block) return { result: { ok: false, error: sr.error } };
      ctx.blocks.push(sr.block);
      return { result: { ok: true, displayed: true, table: sr.table, count: sr.count, note: '表格数据块已附加在回复末尾，由界面渲染；正文只需一句话说明这是什么数据，不要声明「已渲染」' } };
    }
    case 'show_chart': {
      const sc = runShowChart(args);
      if (!sc.block) return { result: { ok: false, error: sc.error } };
      ctx.blocks.push(sc.block);
      return { result: { ok: true, displayed: true, type: sc.type, count: sc.count, title: sc.title, note: '图表数据块已附加在回复末尾，由界面渲染；正文只需一句话概括结论，不要声明「已渲染」' } };
    }
    case 'get_time':
      return { result: currentTimeInfo() };
    case 'web_search':
      return { result: await runWebSearch(args, ctx) };
    case 'undo_change':
      return { result: await runUndoChange(args) };
    case 'save_memory': {
      const r = dbManager.appendMemory(ctx && ctx.slug, args.items);
      if (r.error) return { result: { ok: false, error: r.error } };
      return { result: { ok: true, saved: true, count: r.count, note: '已写入长期记忆，正文用一句话确认即可' } };
    }
    case 'ask_user': {
      const a = normalizeAsk(args);
      if (!a.ok) return { result: { ok: false, error: a.error } };
      return { ask: a.ask, result: { ok: true, asked: true, count: a.ask.questions.length, questions: a.ask.questions.map((q) => q.question) } };
    }
    case 'read_document': {
      // 读取本轮用户上传的附件内容（前端上传时已解析成文本并随请求带来，无需任何界面交互）
      const list = ((ctx && Array.isArray(ctx.attachments)) ? ctx.attachments : [])
        .map((a) => ({ name: String((a && a.name) || '文件'), text: String((a && a.text) || '') }))
        .filter((a) => a.text.trim());
      if (!list.length) {
        return { result: { ok: false, error: '本轮没有可读取的附件文件，请提示用户用输入框旁的「上传文件」按钮添加后再试' } };
      }
      const MAX_LEN = 100000; // 与上传解析接口保持一致的截断上限
      let body = list.map((a) => `文件「${a.name}」的内容：\n${a.text}`).join('\n\n');
      if (body.length > MAX_LEN) body = body.slice(0, MAX_LEN) + `\n\n...（文件过长，已截断至 ${MAX_LEN} 字符）`;
      return {
        result: {
          ok: true,
          count: list.length,
          names: list.map((a) => a.name),
          text: body,
          note: '以上是用户本轮上传的文件内容，请据此作答；正文不要原样照抄整段文件内容',
        },
      };
    }
    case 'ocr_image': {
      const imgs = (ctx && ctx.images) || [];
      if (!imgs.length) return { result: { ok: false, error: '当前对话里没有可识别的图片' } };
      const n = Math.min(Math.max(parseInt(args && args.image, 10) || 1, 1), imgs.length);
      const ocr = require('../../../services/ocr');
      const r = await ocr.recognizeDataUrl(imgs[n - 1]);
      if (!r.ok) return { result: { ok: false, error: r.error } };
      if (r.empty) {
        return { result: { ok: true, text: '', empty: true, note: '图片里没有识别到文字' } };
      }
      return { result: { ok: true, text: r.text, note: '以上是从图片中识别出的文字，请据此继续处理' } };
    }
    case 'export_file': {
      const e = normalizeExport(args || {});
      if (e.error) return { result: { ok: false, error: e.error } };
      return {
        exportFile: e.spec,
        result: {
          ok: true,
          generated: true,
          filename: e.spec.filename,
          format: e.spec.format,
          count: e.spec.rows.length,
          note: '导出文件已生成，界面会弹出系统保存对话框由用户选择保存位置；正文用一句话说明导出了什么即可，不要编造保存路径，也不要重复调用本工具',
        },
      };
    }
    default:
      return { result: { error: '未知工具' } };
  }
}

// ===== 数据访问记录：只覆盖「读」 =====
// 与 MCP 侧同一张 access_log 表，source 区分。写类工具**不记这里** —— 写入在
// 「设置 → 更改审查」（undo_history，带来源色标与回退入口）里有完整前后值，
// 再记一份只会让两份记录的口径互相打脸。三者边界：
//   AI 数据保护 → AI 访问记录（只看 ai）
//   MCP 服务管理 → MCP 访问记录（只看 mcp）
//   设置 → 更改审查 → 全部来源的写入与回退
const AI_READ_TOOLS = new Set([
  'query', 'aggregate', 'search_all', 'describe_table',
  'show_record', 'export_image', 'export_file', 'delete_impact',
]);

function describeAiRead(name, args, result) {
  if (!AI_READ_TOOLS.has(name)) return null;
  const a = args || {};
  const r = result || {};
  let target = '';
  if (name === 'search_all') target = String(a.q || '');
  else if (name === 'export_image') target = String(a.target || '');
  else if (name === 'export_file') target = String(a.filename || '');
  else target = String(a.table || (Array.isArray(a.tables) ? a.tables.join('、') : '') || '');
  let amount = 0;
  let detail = '';
  if (Array.isArray(r.rows)) { amount = r.rows.length; detail = `${amount} 行`; }
  else if (Array.isArray(r.groups)) { amount = r.groups.length; detail = `${amount} 组结果`; }
  else if (typeof r.count === 'number') { amount = r.count; detail = `${amount} 条`; }
  return { target, detail, amount };
}

// 记录失败绝不影响工具结果（观测不能反过来打断业务）。
// 「被拒」= 撞上按表关闭，与普通失败分开记：那是权限真的生效的证据。
function logAiRead(name, args, ctx, result) {
  const slug = ctx && ctx.slug;
  if (!slug) return;
  const d = describeAiRead(name, args, result);
  if (!d) return;
  const errorText = String((result && result.error) || '');
  // 读工具的成功返回并不都带 ok:true（如 query 只回 { count, rows }），
  // 所以判据是「有 error 才算失败」，不能写成 result.ok 真值判断 ——
  // 否则每一次正常查询都会被记成 failed，这一页就变成噪音了。
  const hasError = !!result && (result.ok === false || errorText !== '');
  const denied = hasError && /设置中关闭/.test(errorText);
  const write = () => accessLog.record({
    source: 'ai',
    actor: (ctx && ctx.convTitle) || '',
    tool: name,
    target: d.target,
    detail: d.detail,
    amount: d.amount,
    result: hasError ? (denied ? 'denied' : 'failed') : 'ok',
    reason: hasError ? errorText : '',
  });
  // 工具调用本来就在本轮 withDb 里：再套一层要多一次开库解析（含密钥解密）。
  // 只有当前没绑定到同一个库时才自己绑一次。
  if (dbManager.currentSlug() === slug) write();
  else dbManager.withDb(slug, write);
}

// 统一的工具执行入口：流式 / 非流式共用
async function runTool(name, args, ctx) {
  const out = await dispatchTool(name, args, ctx);
  try { logAiRead(name, args, ctx, out && out.result); } catch (_) { /* 记录失败不阻断 */ }
  return out;
}

module.exports = {
  runTool,
  appendBlocks: exec.appendBlocks,
  latestUserImages: exec.latestUserImages,
  toolSummary: exec.toolSummary,
  toolDetailText: exec.toolDetailText,
  TOOL_INFO: exec.TOOL_INFO,
  MAX_BATCH_OPS: schema.MAX_BATCH_OPS,
  BATCH_ROW_TABLES: schema.BATCH_ROW_TABLES,
  SNAPSHOT_NAME_RE: exec.SNAPSHOT_NAME_RE,
  runSnapshotCreate: exec.runSnapshotCreate,
  runSnapshotList: exec.runSnapshotList,
  queryTool: schema.queryTool,
  proposeWriteTool: schema.proposeWriteTool,
  showRecordTool: schema.showRecordTool,
  batchAddTool: schema.batchAddTool,
  batchDeleteTool: schema.batchDeleteTool,
  jsonWriteTool: schema.jsonWriteTool,
  frontSettingTool: schema.frontSettingTool,
  chartTool: schema.chartTool,
  askUserTool: schema.askUserTool,
  memoryTool: schema.memoryTool,
  readDocumentTool: schema.readDocumentTool,
  ocrTool: schema.ocrTool,
  exportTool: schema.exportTool,
  timeTool: schema.timeTool,
  webSearchTool: schema.webSearchTool,
  undoTool: schema.undoTool,
  aggregateTool: schema.aggregateTool,
  resolveStudentTool: schema.resolveStudentTool,
  listChangesTool: schema.listChangesTool,
  searchAllTool: schema.searchAllTool,
  runChecksTool: schema.runChecksTool,
  conflictChecksTool: schema.conflictChecksTool,
  exportImageTool: schema.exportImageTool,
  scoreWeightsTool: schema.scoreWeightsTool,
  batchUpdateTool: schema.batchUpdateTool,
  batchOpsTool: schema.batchOpsTool,
  describeTableTool: schema.describeTableTool,
  snapshotCreateTool: schema.snapshotCreateTool,
  snapshotListTool: schema.snapshotListTool,
  snapshotRestoreTool: schema.snapshotRestoreTool,
  deleteImpactTool: schema.deleteImpactTool,
  teachingWeekTool: schema.teachingWeekTool,
  skillTool: schema.skillTool,
  subagentTool,
  runSubagent,
};
