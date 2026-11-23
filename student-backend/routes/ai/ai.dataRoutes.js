const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, getFields } = require('../../db');
const aiStore = require('../../services/aiStore');
const store = require('../../services/slotStore');
const { sanitizeField } = require('../../services/sanitize');
const { validateRow } = require('../../services/businessRules');
const { purgeStudentRelations } = require('../../services/studentRelations');
const { renameStudentRefs } = require('../../services/studentRename');
const { applyRowStudentRef } = require('../../services/provisionalStudents');
const { resolveNameCellsDetailed } = require('../../services/seatWrite');
const dbManager = require('../../dbManager/dbManager');
const { READ_TABLES, JSON_WRITE_TABLES } = require('./ai.constants');
const { writeScope } = require('../../services/aiWriteScope');
const { tableColumns, displayColumns, serializeColVal, clearTableColumnsCache } = require('./ai.helpers');
const { safeJson } = require('../../utils/json');
const { localDateStr, mondayOf } = require('../../utils/date');
const { toModeMap } = require('../../services/dutyMode');
const { seatSnapshotPayload } = require('../../services/seatSnapshot');
// 工具相关常量/执行器惰性加载：仅在真正处理对应路由时才 require
const tools = () => require('./ai.tools/tools');

const router = express.Router();

// GET /api/ai/records/:table?ids=1,2 —— 供前端按 id 取整条记录的完整字段（仅限可读表白名单）
router.get('/records/:table', (req, res) => {
  try {
    const table = req.params.table;
    if (!READ_TABLES[table]) return res.status(400).json({ error: '不支持的数据表' });
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      // 上限 50：与批量删除（propose_delete_many）的条数上限对齐，保证删除预览能完整列出全部记录
      .slice(0, 50);
    if (!ids.length) return res.status(400).json({ error: '缺少记录 id' });
    const rows = aiStore.rowsByIds(table, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // 只返回列表页展示的列（过滤 position / 外键 / created_at 等内部列），整行不再全部露出
    res.json({ success: true, data: { columns: displayColumns(table), rows: ids.map((id) => byId.get(id)).filter(Boolean) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 整块写入前的自动快照：只对「当前在用」的表生效（模板/权重表无对应历史语义，不存）。
// 历史快照统一存于 domain_history（经 slotStore 写入）：
//   schedule   → 按周快照
//   duty_layout→ 按天 + 模式（daily/big）各存一条
//   seat_layout→ 按天快照
// 解析统一用 utils/json 的 safeJson；模式拆包用 services/dutyMode 的 toModeMap。
// 这两个函数此前在本文件各写了一份，与 duty.js / search.js / AI 执行器逐字重复。

// 取某天所在周的周一（YYYY-MM-DD），与各页历史快照的周口径一致。
// 实现见 utils/date.js 的 mondayOf（入参兼容 Date，且不会改掉调用方的 Date）。

// 写入前把当前行的旧值快照进 domain_history（幂等 upsert，失败不阻断写入，仅记录）
function snapshotBeforeWrite(table, row) {
  if (table !== 'schedule' && table !== 'duty_layout' && table !== 'seat_layout') return;
  const today = new Date();
  const week = mondayOf(today);
  if (table === 'schedule') {
    store.histUpsert('schedule', {
      weekStart: week,
      payload: {
        cells: safeJson(row.cells, []),
        settings: safeJson(row.settings, {}),
      },
    });
    return;
  }
  const snapDate = localDateStr(today);
  if (table === 'duty_layout') {
    // 值日快照：按 daily/big 拆开各存一条
    const cellsMap = toModeMap(row.cells);
    const settingsMap = toModeMap(row.settings);
    ['daily', 'big'].forEach((m) => {
      store.histUpsert('duty', {
        weekStart: week,
        snapDate,
        mode: m,
        payload: { cells: cellsMap[m] || {}, settings: settingsMap[m] || {} },
      });
    });
    return;
  }
  // 座位快照：保留几何与分组等全部字段
  // 字段表统一取自 services/seatSnapshot.js —— 这里曾经只手抄了 seats，
  // 于是 AI 整块写座位表前的自动快照丢掉了 types，回看历史时走廊列显示成空座位。
  store.histUpsert('seat', {
    weekStart: week,
    snapDate,
    mode: row.mode || 'single',
    payload: seatSnapshotPayload(row),
  });
}

// 取某列在 table_meta 登记的字段类型（供 sanitizeField 的「按类型兜底」使用），未登记默认「文字」
function colType(table, col) {
  const meta = getFields(table) || [];
  const f = meta.find((x) => x.name === col);
  return f && f.type ? f.type : '文字';
}

// 整块写入一张「非行式」表的指定列（供 /doc 单次写入与 /api/ai/apply-batch 事务内复用）。
// 统一顺序：清洗（列级业务规则）→ 依赖既有数据的一致性校验 → 写入前历史快照 → 覆盖写入。
// 返回 { ok, table, id, before, after } 或 { error }；不抛异常，由调用方统一处理。
function applyDocWrite(table, id, values) {
  if (!JSON_WRITE_TABLES[table]) return { error: '该表暂不支持 AI 整块写入' };
  // 「只读」档：整块写入与行式写入同一口径（行式在 tools.js 派发前拦，这里是整块写入的入口）
  if (writeScope.readonlyTables().includes(String(table))) return writeScope.readonlyError(table);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { error: '缺少要写入的列值' };
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid <= 0) return { error: `记录 id 无效（收到：${id == null ? '' : id}）` };
  const cols = tableColumns(table);
  const row = aiStore.findRow(table, rid);
  if (!row) return { error: `表中没有 id=${rid} 的行` };
  // ① 先按列级业务规则清洗（JSON 形状 / 枚举 / 数值 / 日期 / 路径），不合法直接拒绝、不落库
  const cleaned = {};
  try {
    for (const k of Object.keys(values)) {
      if (k === 'id' || !cols.includes(k) || values[k] === undefined) continue;
      // 用该列在 table_meta 登记的真实类型兜底：写死 '文字' 会让数值/日期列
      // 走文本清洗，脏值（如 '2026-13-45'）能直接落库（审查 v4 · B03-05）
      cleaned[k] = sanitizeField(values[k], table, k, colType(table, k));
    }
  } catch (e) {
    return { error: e.message };
  }
  const keys = Object.keys(cleaned);
  if (!keys.length) return { error: '没有可写入的字段' };
  const before = {};
  const after = {};
  keys.forEach((k) => { before[k] = row[k]; after[k] = cleaned[k]; });
  // 座位解析实际发生在事务里，这里先把变量备好：新建了谁 / 谁同名认不出，
  // 都要回到调用方（确认结果页与 AI 回复），否则多出来的临时学生没人看得见。
  let createdStudents = [];
  let ambiguousNames = [];

  // ② 校验 + 快照 + 写入放进**同一个事务**。
  // 校验（validateRow → assertDutyRefs）会把值日名单里的新名字建档，这是有意的副作用；
  // 原先它跑在事务外，只要写入或快照失败，值日表没写成、名册里却多出一个临时学生
  // （审查 v6 · Q4-01）。放进事务后，抛错即整体回滚，建档不会留下残骸。
  try {
    return db.transaction(() => {
      // 座位表里的姓名字符串要有人认领：与 routes/seats.js 同口径（resolveNameCells 给
      // 名册外姓名建临时学生）。不在这里解析的话，AI 写进来的名字只是一段字符串 ——
      // 名册里查不到这个人，改名、删学生、统计全都对不上，而界面看不出任何异常。
      // 顺序：必须在 validateRow **之前**。解析成 id 之后，「id 是否真实存在」
      // 「洞里/走廊里能不能坐人」这些依赖既有数据的校验才有对象。
      if ((table === 'seat_layout' || table === 'seat_template') && Array.isArray(cleaned.seats)) {
        const parsed = resolveNameCellsDetailed(cleaned.seats);
        cleaned.seats = parsed.seats;
        createdStudents = parsed.created;
        ambiguousNames = parsed.ambiguous;
        // after 是在解析前填的，仍指向「姓名数组」；落库的是 id 数组。
        // 不同步的话确认页给用户看的是一份假 after。
        after.seats = cleaned.seats;
      }
      // ②-1 依赖既有数据的一致性校验（座位引用的学生是否真实存在、值日项目/星期/姓名是否合法等）
      validateRow(table, cleaned, row);
      // ②-2 整块写入是「整体替换」，先把旧值快照进历史表（课表/座位），留一颗后悔药
      try {
        snapshotBeforeWrite(table, row);
      } catch (e) {
        console.warn(`[ai] 写入前快照失败（已跳过，不影响本次写入）：${e.message}`);
      }
      if (store.isDoc(table)) {
        // 单例文档表已合并为槽位表，写入统一走 slotStore
        store.setDoc(table, cleaned);
      } else {
        aiStore.updateColumns(table, rid, keys, keys.map((k) => serializeColVal(cleaned[k])));
      }
      return { ok: true, table, id: rid, before, after, createdStudents, ambiguousNames };
    })();
  } catch (e) {
    return { error: e.message };
  }
}

// POST /api/ai/doc —— 整块写入「非行式」表（座位/权重/课表/值日/模板等）
//   body: { table, id, values }，values 为「列名 → 该列完整新值」。
//   仅限 JSON_WRITE_TABLES 白名单、仅真实列；入库前统一走列级业务规则清洗
//   （JSON 形状 / 枚举 / 数值范围 / 严格日期 / 路径），不合法直接 400 拒绝、不落库；
//   写入前对课表/座位先把旧值快照进历史表。返回写入前后的列值（before/after），供前端登记「整块撤销」。
router.post('/doc', (req, res) => {
    const { table, id, values } = req.body || {};
  const r = applyDocWrite(table, id, values);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({
    ok: true, table: r.table, id: r.id, before: r.before, after: r.after,
    // 座位表里的名册外姓名会自动建临时学生，必须回传让前端/AI 说清楚
    createdStudents: r.createdStudents, ambiguousNames: r.ambiguousNames,
  });
});

// 当前请求所属班主任库的 slug（取自鉴权中间件写入 token 的 dbSlug，与 AI 工具 ctx.slug 口径一致）
function currentSlug(req) {
  return (req.user && req.user.dbSlug) || 'default';
}

// POST /api/ai/apply-batch —— 把多张表/多类写操作放进「单个事务」执行：任一步失败整体回滚。
//   body: { ops }，ops 由 propose_batch 归一化产出（行式 add/update/delete + doc 整块写入）。
//   返回 results（每项含 before/after 或整行），供前端逐条登记「同批次撤销」。
router.post('/apply-batch', (req, res) => {
  try {
    const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
    if (!ops.length) return res.status(400).json({ error: '缺少要执行的操作（ops 不能为空）' });
    if (ops.length > tools().MAX_BATCH_OPS) return res.status(400).json({ error: `一次最多 ${tools().MAX_BATCH_OPS} 个操作（当前 ${ops.length} 个）` });
    const results = [];
    const run = db.transaction(() => {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i] || {};
        const at = `第 ${i + 1} 个操作`;
        const action = String(op.action || '');
        const table = String(op.table || '');
        if (action === 'doc') {
          const r = applyDocWrite(table, op.id, op.values);
          if (r.error) throw new Error(`${at}：${r.error}`);
          results.push({
            action: 'doc', table: r.table, id: r.id, before: r.before, after: r.after,
            createdStudents: r.createdStudents, ambiguousNames: r.ambiguousNames,
          });
          continue;
        }
        if (!tools().BATCH_ROW_TABLES[table]) throw new Error(`${at}：该表不支持按行写入（${table || '未指定表'}）`);
        const cols = tableColumns(table);
        if (action === 'add') {
          const data = op.data && typeof op.data === 'object' && !Array.isArray(op.data) ? op.data : {};
          const row = {};
          for (const k of Object.keys(data)) {
            if (k === 'id' || !cols.includes(k)) continue;
            row[k] = sanitizeField(data[k], table, k, colType(table, k));
          }
          if (!Object.keys(row).length) throw new Error(`${at}：新增缺少字段数据`);
          // 行式表若有 position 列且未提供，补为当前最大值 +1（与各业务路由的排序接续一致）
          if (cols.includes('position') && row.position === undefined) {
            row.position = aiStore.maxPosition(table) + 1;
          }
          validateRow(table, row);
          // 行式表里的学生引用（group_members.member_name / cadre_members.student_id）：
          // 与业务路由同口径认人。它会**就地补/改字段**（cadre_members 回填 student_id），
          // 所以 keys 必须在它之后重算，否则补出来的 id 不会进 INSERT。
          applyRowStudentRef(table, row);
          const keys = Object.keys(row);
          const info = aiStore.insertRow(table, keys, keys.map((k) => serializeColVal(row[k])));
          const full = aiStore.findRow(table, info.lastInsertRowid);
          results.push({ action: 'add', table, id: info.lastInsertRowid, row: full });
        } else if (action === 'update') {
          const id = Number(op.id);
          if (!Number.isInteger(id) || id <= 0) throw new Error(`${at}：缺少有效的记录 id`);
          const changes = op.changes && typeof op.changes === 'object' && !Array.isArray(op.changes) ? op.changes : {};
          const old = aiStore.findRow(table, id);
          if (!old) throw new Error(`${at}：要修改的记录不存在（${table} id=${id}）`);
          const row = {};
          for (const k of Object.keys(changes)) {
            if (k === 'id' || !cols.includes(k)) continue;
            row[k] = sanitizeField(changes[k], table, k, colType(table, k));
          }
          if (!Object.keys(row).length) throw new Error(`${at}：没有可修改的字段`);
          validateRow(table, row, old);
          // 改名同样要认人；给了 student_id 时姓名以名册为准（这里会改写 row 里的姓名）
          applyRowStudentRef(table, row);
          const keys = Object.keys(row);
          aiStore.updateColumns(table, id, keys, keys.map((k) => serializeColVal(row[k])));
          const after = aiStore.findRow(table, id);
          // 改学生姓名必须级联六张关联表（值日/座位/请假/加分/小组/班干部 + 历史 payload）：
          // 普通编辑（tableService.updateRowWithRename）与 MCP 提案（mcpProposalExec）都做了，
          // 只有 AI 批量这条漏了 —— 改完同一人在不同表叫不同名字。带 id 避免同名两人互踩。
          // 整段在 run 事务内，改名与级联同生共死；撤销侧 row_update 已有反向级联。
          let renamed = null;
          if (table === 'students' && old && old['姓名'] != null && after && after['姓名'] != null
              && old['姓名'] !== after['姓名']) {
            renamed = renameStudentRefs(old['姓名'], after['姓名'], id);
          }
          results.push({ action: 'update', table, id, before: old, after, ...(renamed ? { renamed } : {}) });
        } else if (action === 'delete') {
          const id = Number(op.id);
          if (!Number.isInteger(id) || id <= 0) throw new Error(`${at}：缺少有效的记录 id`);
          const old = aiStore.findRow(table, id);
          if (!old) throw new Error(`${at}：要删除的记录不存在（${table} id=${id}）`);
          // 删学生必须连带清理松耦合关联（请假/加分/座位/值日/小组/班干部）：
          // 界面上删学生走的是 purgeStudentRelations，AI 这条路径原先只删主表，
          // 于是留下「指向不存在学生的孤儿记录」——值日指数、名单统计全被污染，
          // 而且用户看不见（审查 v4 · B03-01）。
          // 保留 purge 的七处快照随结果返回：前端据此登记 student_cascade_delete
          // 撤销记录（而不是只恢复主表的 row_delete），否则撤销后 6 类关联永久丢失。
          let purged = null;
          if (table === 'students') {
            purged = purgeStudentRelations(old, { leave: true, score: true, seat: true, duty: true, group: true, cadre: true });
          }
          aiStore.deleteRow(table, id);
          results.push({
            action: 'delete', table, id, row: old,
            ...(purged ? { purged, undoType: 'student_cascade_delete' } : {}),
          });
        } else {
          throw new Error(`${at}：未知操作类型「${action}」`);
        }
      }
    });
    run();
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/ai/snapshot —— 立即创建一份整库快照（加密 .db 副本），自动保留最近 20 份
router.post('/snapshot', async (req, res) => {
    const r = await tools().runSnapshotCreate({ slug: currentSlug(req) });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, snapshot: r.snapshot, count: r.count });
});

// GET /api/ai/snapshots —— 列出已有快照（最新在前）
router.get('/snapshots', (req, res) => {
    const r = tools().runSnapshotList({ slug: currentSlug(req) });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, count: r.count, snapshots: r.snapshots });
});

// POST /api/ai/snapshot/restore —— 还原到指定快照（覆盖整库，须老师在界面二次确认后才调用）
//   顺序：先断开该库连接（含缓存）→ 覆盖 .db → 清 -wal/-shm 残留 → 重新打开。
router.post('/snapshot/restore', (req, res) => {
  try {
    const slug = currentSlug(req);
    const name = String((req.body && req.body.snapshot) || '').trim().replace(/\.db$/, '');
    if (!tools().SNAPSHOT_NAME_RE.test(name)) return res.status(400).json({ error: '无效的快照标识' });
    const dir = dbManager.snapshotsDir(slug);
    const src = path.join(dir, `${name}.db`);
    if (!fs.existsSync(src)) return res.status(404).json({ error: `快照不存在：${name}` });
    const target = dbManager.dbFilePath(slug);
    // 还原要用独占文件句柄（而且必须把旧连接丢掉，否则下次查询还连着还原前的库）。
    // evictConn 默认会跳过「仍有请求在用」的连接，这里必须强制关：
    // 本请求自己就持有计数，默认行为会静默跳过 → 文件覆盖了但连接还指着旧句柄，
    // 表现为「回滚成功但界面没变」。（这条是 B05-04 加守卫后冒烟立即抓出来的）
    // 同样要先通知扫描子进程关掉该库连接，否则它可能在覆盖文件期间读写旧库（#12）。
    try { require('../../scanWorker').lockDb(slug); } catch (_) { /* 子进程未启动 */ }
    dbManager.evictConn(slug, { force: true });
    fs.copyFileSync(src, target);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.rmSync(target + suffix, { force: true }); } catch (_) { /* 忽略 */ }
    }
    dbManager.withDb(slug, () => {}); // 重新打开（懒加载）该库
    // 快照里的表结构可能和还原前不同（例如快照后又增删过列）：AI 的列名缓存必须一并失效，
    // 否则会拿旧列集合继续校验写入/查询，把新列当「不存在」拒绝、或放行已删列。
    clearTableColumnsCache();
    res.json({ ok: true, snapshot: name, reload: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
