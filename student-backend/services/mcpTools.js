// =========================================================================
// mcpTools.js —— 方向 B 暴露给外部 AI 客户端的工具实现（与传输层解耦）
//
// 所有 handler 都在 dbManager.withDb(slug, ...) 上下文内被调用（由 routes/mcp 包装），
// 因此复用 db Proxy / aiStore / slotStore 与本地 AI 工具是同一口径。
//
// 写操作只「生成提案」，不落库——与本地 propose_* 同一原则；真正的写入在老师
// 于班集 UI 确认后由 mcpProposalExec.confirm 执行。
// =========================================================================

const { db } = require('../db');
const aiStore = require('./aiStore');
const store = require('./slotStore');
const { runSearch } = require('./searchQuery');
const { stripVersionDeep } = require('../utils/json');
const { READ_TABLES, WRITE_TABLES } = require('../routes/ai/ai.constants');
// MCP 侧用自己的那一份权限（mcp_privacy_json）：给外部客户端关掉的表
// 不该连带锁住老师自己的 AI 助手，反之亦然。
const { mcpReadScope } = require('./aiReadScope');
const { mcpWriteScope } = require('./aiWriteScope');
const { privacy, hasUnrestoredToken } = require('./aiPrivacy');
const proposals = require('./mcpProposalStore');
const aiConfigStore = require('./aiConfigStore');
// 自动执行复用确认链路：撤销登记、只读复核、状态抢占、学生引用三道保护都在 exec 里。
// 自己另写一份写入迟早漏掉其中一环（典型是漏 renameStudentRefs，改名后留下旧名的历史）。
const mcpProposalExec = require('./mcpProposalExec');
const { toolResultContent } = require('../routes/ai/ai.helpers');

const MAX_ROWS = 200;
// 单批提案的操作条数上限：一次导入一个班（约 50 人）绰绰有余，
// 又不至于让老师在一次确认里签下几千行改动。
const MAX_BATCH_OPS = 200;

function ok(data) { return { ok: true, ...(data || {}) }; }
function fail(error) { return { ok: false, error: String(error) }; }

// ---- 数据保护：外部 AI 读写也要走同一套混淆 ----
// 出站：把真名/真号换成代号再交给外部 AI（开关关时 privacy 零拷贝直接返回）。
// 进 substitute 之前先剥掉 JSON 版本标记（__v）：那是库内部记账用的键，
// 外部模型看到会当成真实列照抄回写。所有 MCP 出站结果都过这个函数，收口在这里一处即可。
// 失败**不返回原文** —— 那是把真实姓名/电话交给外部模型（#1）。
// 也不让整个 MCP 读表挂掉：返回不含真实数据的占位结果，让外部客户端知道数据暂不可用。
function maskResult(result, slug) {
  try { return privacy.substitute(stripVersionDeep(result), slug, 'mcp'); }
  catch (_) { return { ok: false, error: '数据保护脱敏失败，本次结果暂不可用' }; }
}
// 入站：外部 AI 从读接口看到的是代号，写回时先还原成真值；认不出的 S-/P- 代号必须拒绝，
// 否则会把代号写进库（与本地 AI 工具 runTool 的守卫同一口径）。
// 返回 { error } 表示拒绝，否则返回还原后的参数。
function unmaskArgs(args, slug) {
  let out = args;
  try { out = privacy.restore(args, slug, 'mcp'); }
  catch (_) { return { error: '数据保护还原失败，已拒绝本次写入' }; }
  if (privacy.enabled(slug, 'mcp') && hasUnrestoredToken(out)) {
    return { error: 'AI 数据保护：内容里有无法识别的代号（S-/P-），请按原名重新填写后再提交' };
  }
  return { value: out };
}

// ---- 自动执行（老师在设置里显式打开时才生效）----
// 读开关失败一律当「关闭」：读不到配置时宁可多问老师一次，也不能默默改数据。
function autoRunProposal(proposalId) {
  let on = false;
  try { on = aiConfigStore.readMcpPrefs().auto_confirm === true; } catch (_) { on = false; }
  if (!on) return null;
  try { return mcpProposalExec.confirm(proposalId, 'confirm'); }
  catch (e) { return { ok: false, error: e.message }; }
}

// 把 confirm 的结果翻译成外部 AI 能据以行动的结论。三件事必须说清：
// 已经执行了（别重复提交）、失败已整批回滚（别以为写了一半）、失败别原样重试。
// 出站要过 maskResult：result 里带 before/after 真值，与 read_table 同口径。
function autoPayload(proposalId, auto, extra, slug) {
  const status = auto && auto.ok ? (auto.status || 'confirmed') : 'failed';
  const result = (auto && (auto.result || (auto.error ? { error: auto.error } : null))) || {};
  if (status === 'confirmed') {
    return maskResult(ok({
      proposal_id: proposalId,
      status,
      auto: true,
      ...(extra || {}),
      result,
      message: '已直接执行（老师在设置中开启了自动执行，无需确认）。改动已登记，仍可回溯撤销。',
      hint: '不需要再次提交同一条修改。',
    }), slug);
  }
  const err = result.error || '未知原因';
  return maskResult(ok({
    proposal_id: proposalId,
    status: 'failed',
    auto: true,
    ...(extra || {}),
    result: { error: err },
    message: `自动执行失败，数据已整批回滚：${err}`,
    hint: '请按错误修正后重新提交，不要原样重试。',
  }), slug);
}

// 按表读闸门：与 list_tables 共用 mcpReadScope，防止外部 AI 猜表名绕过 closed_tables。
// 只对 READ_TABLES 里的表生效——搜索结果里的派生组（duty_items 等）不在其列、老师也没有
// 对应开关，不能误伤。返回 null 表示可读；否则返回含「设置」的错误文案（判据：报错要指明
// 去哪重新开启，不能让模型以为「查不到数据」）。
function readGateError(key) {
  const k = String(key || '');
  if (Object.prototype.hasOwnProperty.call(READ_TABLES, k) && !mcpReadScope.isTableReadable(k)) {
    return mcpReadScope.closedError(k).error;
  }
  return null;
}

// 列出可读的表（供外部 AI 知道有哪些数据）。slug 由其 token 绑定，此处不返回。
function listTables() {
  // §4.2：list_tables 与其它读表入口共用同一个有效表集，被关的表不再列出
  const out = Object.entries(mcpReadScope.effectiveReadTables()).map(([key, description]) => ({ key, description }));
  // 标注哪些可写（仍需提案确认）；被老师设成「只读」的表在这里就不该说可写
  for (const t of out) t.writable = mcpWriteScope.isTableWritable(t.key);
  return ok({ tables: out, note: '写操作需先 propose_write（少量）或 propose_batch（批量），由老师在班集内确认后执行' });
}

// 读一张行式表：白名单校验 + 行数上限 + 列裁剪由 search 的口径决定，这里直接读全列。
function readTable({ table, limit, offset } = {}, ctx) {
  const key = String(table || '');
  if (!Object.prototype.hasOwnProperty.call(READ_TABLES, key)) return fail(`不可读的表：${key}`);
  // 按表读闸门：被老师在「AI 数据保护」里关掉的表，猜到表名也不许读
  const gateErr = readGateError(key);
  if (gateErr) return fail(gateErr);
  // 整块 JSON 表走 getDoc，不按行读
  if (store.isDoc(key)) return readDoc({ table: key }, ctx);
  const cap = Math.max(1, Math.min(MAX_ROWS, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  try {
    // 表名来自白名单 key，非用户输入拼接，安全
    const rows = db.prepare(`SELECT * FROM "${key}" LIMIT ? OFFSET ?`).all(cap, off);
    const total = aiStore.tableColumns(key) ? db.prepare(`SELECT COUNT(*) AS n FROM "${key}"`).get().n : rows.length;
    return maskResult(ok({ table: key, rows, total, limit: cap, offset: off, truncated: rows.length >= cap }), ctx && ctx.slug);
  } catch (e) {
    return fail(`读取失败：${e.message}`);
  }
}

// 读整块 JSON 文档（课表/座位/值日等单例表）
function readDoc({ table } = {}, ctx) {
  const key = String(table || '');
  if (!store.isDoc(key)) return fail(`不是整块文档表：${key}`);
  // 与 readTable 同口径：整块 JSON 表（课表/座位/值日）被关掉同样不许读
  const gateErr = readGateError(key);
  if (gateErr) return fail(gateErr);
  const doc = store.getDoc(key);
  if (!doc) return fail(`该表暂无数据：${key}`);
  return maskResult(ok({ table: key, doc }), ctx && ctx.slug);
}

// 搜索：复用本地 AI 的 runSearch（白名单表 + 分页），再按 mcpReadScope 过滤掉被关表的分组。
// searchQuery.js 是本地 AI 全局搜索共用的，不能在里面加 MCP 的闸门；在这里过滤 results.groups，
// meta（分页口径）原样保留，派生组（duty_items 等不在 READ_TABLES）不会被误伤。
function search({ q } = {}, ctx) {
  const query = String(q || '').trim();
  if (!query) return fail('缺少搜索词 q');
  try {
    const result = runSearch({ q: query });
    result.groups = (result.groups || []).filter((g) => !readGateError(g.table));
    return maskResult(ok(result), ctx && ctx.slug);
  } catch (e) {
    return fail(`搜索失败：${e.message}`);
  }
}

// 这条改动提交后真正会写进哪几列？口径与执行侧 runRowOp 完全一致：跳过 id、
// 跳过这张表里没有的列、跳过 undefined。返回空数组 = 执行时什么都不会发生。
// 列名拿不到（PRAGMA 失败）时不做列过滤——宁可比执行侧宽松，也不能把合法提案误拒。
function effectiveWriteKeys(table, data) {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const keys = Object.keys(obj).filter((k) => k !== 'id' && obj[k] !== undefined);
  let cols = null;
  try { cols = aiStore.tableColumns(table); } catch (_) { cols = null; }
  return Array.isArray(cols) ? keys.filter((k) => cols.includes(k)) : keys;
}

// 单条写操作的公共校验：propose_write 与 propose_batch 共用同一份判据，
// 否则两处口径迟早分叉（批量能写的表单条不能写，或反之）。
// 返回错误文案，通过则返回 null；prefix 用于批量时指明是第几条。
function checkOp(raw, prefix = '') {
  const op = raw && typeof raw === 'object' ? raw : {};
  const key = String(op.table || '');
  if (!Object.prototype.hasOwnProperty.call(WRITE_TABLES, key)) return `${prefix}该表不支持通过 MCP 写入：${key}`;
  // 「只读」档同样约束外部 AI：提案阶段就拒绝，别让它以为提交成功
  if (mcpWriteScope.readonlyTables().includes(key)) return prefix + mcpWriteScope.readonlyError(key).error;
  const act = String(op.operation || '');
  if (!['add', 'update', 'delete'].includes(act)) return `${prefix}不支持的操作：${act}`;
  if (act !== 'add') {
    const rid = Number(op.id);
    if (!Number.isInteger(rid) || rid <= 0) return `${prefix}记录 id 无效：${op.id == null ? '' : op.id}`;
  }
  if (op.data != null && (typeof op.data !== 'object' || Array.isArray(op.data))) return `${prefix}data 必须是对象`;
  // 空改动守卫：add/update 必须至少留下一个真会被写入的字段。
  // 执行侧（runRowOp）本来也会报「缺少可写字段」，但那时老师已经点过确认了：卡片上没有
  // 任何 diff 可判断，只能凭 label 点，既白占一次确认动作，又养出「不看内容就点」的习惯。
  // 文案要点明两种成因——data 是空的，或字段名都不属于这张表（执行时会被静默筛掉）。
  if (act !== 'delete' && !effectiveWriteKeys(key, op.data).length) {
    return `${prefix}${act === 'add' ? '新增' : '修改'}需要至少一个可写字段：data 不能为空，字段名也必须属于这张表`;
  }
  return null;
}

// 提交单条写提案：只校验白名单与基本结构，不执行。
// 外部 AI 写回的 data 里可能是它从读接口看到的代号，先还原成真值再存提案；
// 认不出的代号直接拒绝，绝不让 S-/P- 混进提案、更不会在老师确认后落库。
function proposeWrite(raw = {}, ctx) {
  const un = unmaskArgs(raw, ctx && ctx.slug);
  if (un.error) return fail(un.error);
  const { table, operation, id, data, label } = un.value;
  const err = checkOp({ table, operation, id, data });
  if (err) return fail(err);
  const key = String(table);
  const op = String(operation);
  const payload = { id: op === 'add' ? undefined : Number(id), data: data || {} };
  const proposalId = proposals.create({
    kind: 'row_write',
    label: String(label || `${WRITE_TABLES[key]} · ${op}`).slice(0, 200),
    table: key,
    operation: op,
    payload,
    requestedBy: 'mcp',
  });
  // 自动执行：建完立刻走确认链路。关着时下面那段原样返回 pending。
  const auto = autoRunProposal(proposalId);
  if (auto) return autoPayload(proposalId, auto, null, ctx && ctx.slug);
  return ok({
    proposal_id: proposalId,
    status: 'pending',
    message: '提案已提交，等待老师在班集内确认。请用 get_proposal_result 查询结果。',
    hint: '本工具不会立即改动数据。',
  });
}

// 提交批量写提案：一条提案 = 一批操作 = 老师确认一次。
// 逐条校验，任何一条不合法就整批拒绝（不建提案），避免「部分能过」这种歧义。
// 执行侧（mcpProposalExec.runBatch）在同一事务里跑，任一条失败整批回滚。
function proposeBatch(raw = {}, ctx) {
  const un = unmaskArgs(raw, ctx && ctx.slug);
  if (un.error) return fail(un.error);
  const { ops, label } = un.value;
  if (!Array.isArray(ops) || !ops.length) return fail('ops 不能为空：把每条修改作为 ops 数组的一项');
  if (ops.length > MAX_BATCH_OPS) return fail(`单批最多 ${MAX_BATCH_OPS} 条操作，请拆成多次提交`);
  const clean = [];
  for (let i = 0; i < ops.length; i += 1) {
    const err = checkOp(ops[i], `第 ${i + 1} 条：`);
    if (err) return fail(err);
    const act = String(ops[i].operation);
    clean.push({
      table: String(ops[i].table),
      operation: act,
      id: act === 'add' ? undefined : Number(ops[i].id),
      data: ops[i].data && typeof ops[i].data === 'object' ? ops[i].data : {},
    });
  }
  const proposalId = proposals.create({
    kind: 'row_batch',
    label: String(label || `${clean.length} 条数据修改`).slice(0, 200),
    table: '',
    operation: 'batch',
    payload: { ops: clean },
    requestedBy: 'mcp',
  });
  // 批量：任一条失败由 exec 整批回滚，外部 AI 收到的是 failed + 失败原因
  const auto = autoRunProposal(proposalId);
  if (auto) return autoPayload(proposalId, auto, { op_count: clean.length }, ctx && ctx.slug);
  return ok({
    proposal_id: proposalId,
    status: 'pending',
    op_count: clean.length,
    message: `已提交 ${clean.length} 条修改，等待老师在班集内确认；任一条不通过则整批都不执行。请用 get_proposal_result 查询结果。`,
    hint: '本工具不会立即改动数据。',
  });
}

// 查询提案结果：外部 AI 隔一段时间回来取。
// result 里带 before/after（改动字段的真值）与 deleted（删掉的整行），必须和读接口同口径
// 过一遍脱敏：否则老师开了「AI 数据保护」后，读表给的是 S-/P- 代号，提案结果把真名真号还回去，
// 开关等于没开。落库的提案本身仍是真值（老师要看真名才判断得了），只在出站这一层换。
function getProposalResult({ proposal_id } = {}, ctx) {
  const p = proposals.get(proposal_id);
  if (!p) return fail('提案不存在或已过期清理');
  return maskResult(ok({
    proposal_id: p.proposal_id,
    status: p.status,
    label: p.label,
    table: p.table,
    operation: p.operation,
    // 批量提案外层没有单表/单操作，告诉外部 AI 这一批有多少条
    op_count: p.kind === 'row_batch' && Array.isArray(p.payload && p.payload.ops) ? p.payload.ops.length : 1,
    result: p.result,
    created_at: p.created_at,
    decided_at: p.decided_at,
  }), ctx && ctx.slug);
}

// 把结果序列化成回填文本（沿用本地 AI 工具的截断口径，防止撑爆上下文）
function toContent(result) {
  return toolResultContent(result);
}

module.exports = {
  listTables,
  readTable,
  readDoc,
  search,
  checkOp,
  proposeWrite,
  proposeBatch,
  getProposalResult,
  toContent,
  MAX_ROWS,
  MAX_BATCH_OPS,
};
