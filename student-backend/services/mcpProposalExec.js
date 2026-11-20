// =========================================================================
// mcpProposalExec.js —— 执行已确认的 MCP 写提案（方向 B）
//
// 与 routes/ai/ai.dataRoutes.js 的 apply-batch「行式表」分支同构，复用同一组
// service 原语（aiStore / sanitizeField / validateRow），SQL 只在 store 里。
// 学生引用的三道保护也走同一组 service：写关联表认人（applyRowStudentRef）、
// 改学生名级联（renameStudentRefs）、删学生清关联（purgeStudentRelations）。
// 不接这三道会写出「只有姓名没有 id」的孤儿行、留下改了名却还挂旧名的历史记录。
// 首版只放行「行式表」增删改（WRITE_TABLES 白名单）；整块 JSON 表（课表/座位/值日）
// 的写入涉及快照与几何联动，暂不通过 MCP 暴露——需要时再按 ai.dataRoutes 的 doc 分支补。
//
// 两种提案：row_write（单条）与 row_batch（一批，同一事务、全成功或全回滚）。
//
// 调用方必须已在 dbManager.withDb(slug, ...) 内。执行与状态抢占在同一调用中完成，
// 由 mcpProposalStore.decide 的「仅 pending 可改」保证幂等。
// =========================================================================

const { db } = require('../db');
const aiStore = require('./aiStore');
const { sanitizeField } = require('./sanitize');
const { validateRow } = require('./businessRules');
const { getFields } = require('../db');
const { WRITE_TABLES } = require('../routes/ai/ai.constants');
// 执行时的只读复核也走 MCP 那一份：老师在「MCP 数据权限」里设的只读，
// 不能靠「提案先建好、确认时再执行」绕过去。
const { mcpWriteScope } = require('./aiWriteScope');
const { applyRowStudentRef } = require('./provisionalStudents');
const { renameStudentRefs } = require('./studentRename');
const { purgeStudentRelations } = require('./studentRelations');
const undoStore = require('./undoStore');
const proposals = require('./mcpProposalStore');

function colType(table, col) {
  const meta = getFields(table) || [];
  const f = meta.find((x) => x.name === col);
  return f && f.type ? f.type : '文字';
}

function serializeVal(v) {
  if (v != null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// 执行一条行式写操作。返回 { ok, ... } 或 { error }，不抛。
function runRowOp(op) {
  const table = String((op && op.table) || '');
  if (!Object.prototype.hasOwnProperty.call(WRITE_TABLES, table)) {
    return { error: `该表不支持通过 MCP 写入：${table || '未指定'}` };
  }
  // 提案提交后老师才改成「只读」时，执行这一下也不能放行（确认的是当时的状态）
  if (mcpWriteScope.readonlyTables().includes(table)) return mcpWriteScope.readonlyError(table);
  const action = String((op && op.operation) || '');
  const cols = aiStore.tableColumns(table);
  const data = op.data && typeof op.data === 'object' && !Array.isArray(op.data) ? op.data : {};

  if (action === 'add') {
    const row = {};
    for (const k of Object.keys(data)) {
      if (k === 'id' || !cols.includes(k)) continue;
      row[k] = sanitizeField(data[k], table, k, colType(table, k));
    }
    if (!Object.keys(row).length) return { error: '新增缺少可写字段' };
    if (cols.includes('position') && row.position === undefined) row.position = aiStore.maxPosition(table) + 1;
    try {
      validateRow(table, row);
    } catch (e) { return { error: e.message }; }
    // 认人：请假/加减分/组员/任职只填姓名时，名册外姓名要建临时学生并回填 student_id；
    // 填了失效 id 则整条拒绝。它会就地补/改 row，keys 必须在它之后重算。
    try { applyRowStudentRef(table, row); } catch (e) { return { error: e.message }; }
    const keys = Object.keys(row);
    const info = aiStore.insertRow(table, keys, keys.map((k) => serializeVal(row[k])));
    const id = Number(info.lastInsertRowid);
    // _undoRow 是撤销用的整行快照（内部字段，对外回执会剥离）；row_insert 执行器
    // 撤销时按 id 删、重做时整行插回，只回 id 不够。
    return { ok: true, action: 'add', table, id, _undoRow: aiStore.findRow(table, id) };
  }

  const id = Number(op.id);
  if (!Number.isInteger(id) || id <= 0) return { error: `记录 id 无效：${op.id == null ? '' : op.id}` };
  const existing = aiStore.findRow(table, id);
  if (!existing) return { error: `表中没有 id=${id} 的行` };

  if (action === 'update') {
    const changes = {};
    for (const k of Object.keys(data)) {
      if (k === 'id' || !cols.includes(k) || data[k] === undefined) continue;
      changes[k] = sanitizeField(data[k], table, k, colType(table, k));
    }
    if (!Object.keys(changes).length) return { error: '修改缺少可写字段' };
    try {
      validateRow(table, changes, existing);
    } catch (e) { return { error: e.message }; }
    // 与新增同口径认人；给了 student_id 时姓名以名册为准（会改写 changes 里的姓名）
    try { applyRowStudentRef(table, changes); } catch (e) { return { error: e.message }; }
    const keys = Object.keys(changes);
    // before/after 保持「仅改动字段」的旧语义（对外回执/提案视图依赖），撤销另用整行快照
    const before = {};
    keys.forEach((k) => { before[k] = existing[k]; });
    aiStore.updateColumns(table, id, keys, keys.map((k) => serializeVal(changes[k])));
    // 改学生姓名要连带六张关联表（值日/座位/加分/请假/小组/班干部），否则同一人在不同表
    // 叫不同名字。镜像 tableService.updateRowWithRename：students 行已写成新名后才级联，
    // 改名与级联同在这个事务里；带上 id，同名两人各自改名不互相踩。
    let renamed = null;
    let after = null;
    if (table === 'students' && changes['姓名'] != null) {
      after = aiStore.findRow(table, id);
      if (after && existing['姓名'] !== after['姓名']) {
        renamed = renameStudentRefs(existing['姓名'], after['姓名'], id);
      }
    }
    // row_update 执行器要整行 before/after（撤销整行回写 + 学生改名反向级联），
    // before 用改前查到的 existing 整行，after 回库读改后整行（部分字段改动的 after 不完整）。
    return {
      ok: true, action: 'update', table, id, before, after: changes, renamed,
      _undoBefore: existing, _undoAfter: after || aiStore.findRow(table, id),
    };
  }

  if (action === 'delete') {
    try {
      validateRow(table, {}, existing);
    } catch (e) { return { error: e.message }; }
    // 删学生必须连带清理松耦合关联（请假/加分/座位/值日/小组/班干部）：与 AI 助手
    // apply-batch 同口径，purge 在删主表前拿整行做（含姓名，供按姓名匹配历史空 id 行）。
    // 不清理就留下指向已删学生的孤儿，值日指数/名单统计继续把不存在的人算进去。
    let purged = null;
    if (table === 'students') {
      // purge 返回七处快照，正好是 student_cascade_delete 撤销 payload 所需（含座位/值日 JSON）
      purged = purgeStudentRelations(existing, { leave: true, score: true, seat: true, duty: true, group: true, cadre: true });
    }
    aiStore.deleteRow(table, id);
    // deleted 保持旧语义；撤销整行快照 + purge 的七处快照供 student_cascade_delete 还原。
    return { ok: true, action: 'delete', table, id, deleted: existing, _undoRow: existing, _undoPurged: purged };
  }

  return { error: `不支持的操作：${action}` };
}

// 执行一批行式写操作：**同一事务内**逐条执行，任一条失败就抛错回滚整批。
// 为什么必须抛而不是返回 error：返回对象的话事务会正常提交，前面几条已经落库了，
// 「任一条不通过则整批不执行」就成了假话。
// 调用方必须已在 db.transaction 内（事务由 confirm 开）。
function runBatch(ops) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return { error: '提案里没有可执行的操作' };
  const done = [];
  const records = []; // 撤销用的完整结果（含整行快照），不回给外部 AI
  for (let i = 0; i < list.length; i += 1) {
    const r = runRowOp(list[i]);
    if (!r.ok) {
      const e = new Error(`第 ${i + 1} 条失败：${r.error}`);
      e.failedIndex = i;
      e.failedOp = list[i];
      throw e;
    }
    records.push(r);
    // 回执只留定位信息：整批的 before/after 回给外部 AI 没意义，只会撑爆上下文
    done.push({ action: r.action, table: r.table, id: r.id });
  }
  return { ok: true, count: done.length, ops: done, _records: records };
}

// —— 撤销登记 ——
// MCP 确认是「外部 AI 提案 → 老师在设置面板确认」，确认时没有 AI 会话/消息载体可挂
// 前端撤销栈，所以服务端在写入事务内直接落撤销记录（undo_history）。origin 用提案 id，
// 同一次确认的多条操作天然成一批，可按 origin 整批撤销；跨会话/重启都还在。
function rowLabel(row) {
  if (!row) return '';
  return row['姓名'] || row.group_name || row['主题'] || row['名称'] || row.name || (row.id != null ? `#${row.id}` : '');
}

// 把一条写操作的完整结果转成撤销记录；返回 undo id 或 null（无对应类型）。
function pushUndoForOp(r, proposalId) {
  if (!r || !r.ok) return null;
  const key = r.table;
  const origin = String(proposalId || '');
  if (r.action === 'add' && r._undoRow) {
    return undoStore.push({
      key, type: 'row_insert', label: rowLabel(r._undoRow),
      payload: { table: key, row: r._undoRow }, origin,
    });
  }
  if (r.action === 'update' && r._undoBefore && r._undoAfter) {
    return undoStore.push({
      key, type: 'row_update', label: rowLabel(r._undoAfter),
      // 执行器 undo 会自己调 renameRefsIfStudent 反向改关联表姓名，这里只给整行前后态
      payload: { table: key, rowId: r.id, oldRow: r._undoBefore, newRow: r._undoAfter }, origin,
    });
  }
  if (r.action === 'delete' && r._undoRow) {
    // 删学生连带清了六处关联，必须整包登记为 student_cascade_delete，
    // 否则撤销只能插回主表、被 purge 掉的请假/加分/座位/值日全丢失。
    if (key === 'students' && r._undoPurged) {
      return undoStore.push({
        key, type: 'student_cascade_delete', label: rowLabel(r._undoRow),
        payload: { student: r._undoRow, ...r._undoPurged }, origin,
      });
    }
    return undoStore.push({
      key, type: 'row_delete', label: rowLabel(r._undoRow),
      payload: { table: key, row: r._undoRow }, origin,
    });
  }
  return null;
}

// 对外结果去掉所有下划线开头的内部字段（整行快照/批量完整记录只给撤销登记用），
// 避免整行数据撑爆外部 AI 上下文。单条 update 带 _undoBefore/_undoAfter、
// 批量带 _records，统一在这里剥离。
function publicResult(r) {
  if (!r || typeof r !== 'object') return r;
  const pub = {};
  for (const k of Object.keys(r)) if (!k.startsWith('_')) pub[k] = r[k];
  return pub;
}

// 确认执行：先原子抢占（pending → processing），再执行，最后定稿。
//
// 幂等的关键在顺序：旧实现是「读 pending → 写库 → 改状态」，并发两次确认时两个请求
// 都读到 pending、都写一遍，只是最后改状态有一次被 WHERE pending 挡掉——数据已经重复了。
// 现在 claim 用一条 UPDATE 原子占位，只有抢到的那次能往下走；写入与定稿又在同一个
// 事务里，进程崩溃时整批回滚，状态停在 processing，超时后可安全重抢。
//
// 返回 { ok, status, result } 或 { ok:false, error }。
function confirm(proposalId, decision) {
  if (decision !== 'confirm' && decision !== 'reject') return { ok: false, error: '无效的决议' };

  const p = proposals.get(proposalId);
  if (!p) return { ok: false, error: '提案不存在' };
  // processing 不能直接拦在这里：进程崩溃卡住的那条要交给 claim 判断是否超时可重抢。
  // 未超时的 processing 会被 claim 拒绝，效果一样；已定稿/已过期的状态则直接返回冲突。
  if (p.status !== 'pending' && p.status !== 'processing') {
    return { ok: false, status: p.status, error: `提案当前状态为 ${p.status}，无法再处理` };
  }

  // 原子抢占：并发的第二次 confirm / reject 到这里拿不到锁，直接返回冲突，绝不写第二遍。
  if (!proposals.claim(proposalId)) {
    const cur = proposals.get(proposalId);
    return { ok: false, status: cur && cur.status, error: `提案已被处理（${cur ? cur.status : '未知'}）` };
  }

  // 拒绝不改数据，定稿成 rejected 即可（同样经过抢占，不会和 confirm 并发双跑）
  if (decision === 'reject') {
    proposals.settle(proposalId, 'rejected', { message: '用户拒绝' });
    return { ok: true, status: 'rejected', result: { message: '用户拒绝' } };
  }

  let result;
  try {
    result = db.transaction(() => {
      let r;
      if (p.kind === 'row_write') {
        const op = { table: p.table, operation: p.operation, ...(p.payload || {}) };
        r = runRowOp(op);
      } else if (p.kind === 'row_batch') {
        // 批量：一条提案 = 一批操作，老师确认一次跑完；任一条失败抛错整批回滚
        r = runBatch((p.payload && p.payload.ops) || []);
      } else {
        r = { error: `暂不支持执行此提案类型：${p.kind}` };
      }

      // 撤销登记与写入同事务：登记失败（如 payload 不合法）会连同数据一起回滚，
      // 绝不留下「数据改了却撤不回来」的半截状态。origin=proposal_id 让一次确认成一批。
      if (r && r.ok) {
        const records = r._records || [r];
        for (const rec of records) pushUndoForOp(rec, proposalId);
      }

      // 定稿与写入同事务：成功一起提交，崩溃一起回滚（状态留 processing 等超时重抢）。
      const pub = publicResult(r);
      proposals.settle(proposalId, r && r.ok ? 'confirmed' : 'failed', pub);
      return pub;
    })();
  } catch (e) {
    // runBatch 第 N 条失败会抛出来 → 上面的事务连同 settle 一起回滚。
    // 注意 claim 在事务外已提交，回滚后状态是 processing 而非 pending，所以这里必须
    // 用认 processing 的 settle 定稿成 failed，否则提案卡在 processing、老师反复点反复失败。
    result = { error: e.message };
    if (e.failedIndex != null) result.failed_index = e.failedIndex;
    proposals.settle(proposalId, 'failed', result);
  }

  return { ok: true, status: result && result.ok ? 'confirmed' : 'failed', result };
}

module.exports = { confirm, runRowOp };
