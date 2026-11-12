const { db, getFields, renumber } = require('../db');
const { sanitizeField } = require('./sanitize');
const { studentRelations } = require('./studentRelations');
const { readRowsByIds } = require('./createdRows');
const { GENERIC_CRUD_TABLES } = require('../schema/tableRegistry');

// 列名白名单：与 addColumn/renameColumn 保持一致，防止列名拼入 SQL 造成注入。
// 仅允许中英文、数字、下划线，且禁止保留字段（id/position 由内部管理，atPosition 为插入位置参数）。
const COLUMN_NAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
const RESERVED_COLUMNS = ['id', 'position', 'atPosition'];

// 表名白名单：本模块把 tableName 直接拼进 SQL，列名有 assertValidColumn 把守，
// 表名此前完全依赖调用方自觉。这里补一层纵深防御，新调用方漏白名单也不会变成注入入口。
// 名单本身在 schema/tableRegistry.js —— 散在业务文件里的表名清单靠人脑同步，必漏。
const ALLOWED_TABLES = new Set(GENERIC_CRUD_TABLES);

function assertValidColumn(name) {
  if (!name || RESERVED_COLUMNS.includes(name) || !COLUMN_NAME_RE.test(name)) {
    throw new Error('字段名不合法');
  }
}

function assertValidTable(name) {
  if (!ALLOWED_TABLES.has(name)) throw new Error('表名不合法');
}

// sanitizeField 的 json 类规则（如班费「收据」多图）产出的是**数组/对象**，
// 而 SQLite 只能绑定原始类型，直接 .run(数组) 会抛「只支持数字/字符串/BigInt/Buffer/null」。
// 动态表列都是 TEXT，约定就是「JSON 文本」，所以在这里统一序列化 ——
// 这是「列级规则可以声明结构化值」这条通路的落地点，缺了它 json 规则在动态表上根本用不了。
function bindable(v) {
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// 列名 → 类型 映射（取自 table_meta；缺省按「文字」处理），供写入时按类型清洗
function fieldTypeMap(tableName) {
  const map = {};
  for (const f of getFields(tableName)) map[f.name] = f.type || '文字';
  return map;
}

function queryAll(tableName) {
  assertValidTable(tableName);
  const results = db.prepare(`SELECT * FROM ${tableName} ORDER BY position ASC`).all();
  let fields = getFields(tableName);
  if (fields.length === 0 && results.length > 0) {
    fields = Object.keys(results[0]).filter(k => k !== 'id' && k !== 'position').map(k => ({ name: k, type: '文字' }));
  }
  return { data: results, fields };
}

function insertRow(tableName, data) {
  assertValidTable(tableName);
  const atPosition = data.atPosition;
  delete data.atPosition;

  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error('没有字段');

  const cleaned = {};
  const typeMap = fieldTypeMap(tableName);
  keys.forEach(k => {
    assertValidColumn(k);
    cleaned[k] = sanitizeField(data[k], tableName, k, typeMap[k]);
  });

  let insertId;

  // 让位 + 插入 + 重排必须是一个原子动作：中间失败会留下 position 空洞（后续 renumber 只是事后补救）。
  db.transaction(() => {
    const basePos = db.prepare(`SELECT MAX(position) AS maxPos FROM ${tableName}`).get().maxPos || 0;
    let insertPos;
    if (atPosition && atPosition <= basePos) {
      insertPos = atPosition;
      db.prepare(`UPDATE ${tableName} SET position = position + 1 WHERE position >= ?`).run(atPosition);
    } else {
      insertPos = basePos + 1;
    }

    cleaned.position = insertPos;
    const columns = Object.keys(cleaned).map(c => `"${c}"`).join(',');
    const placeholders = Object.keys(cleaned).map(() => '?').join(',');
    const values = Object.values(cleaned).map(bindable);

    insertId = db.prepare(`INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`).run(...values).lastInsertRowid;
    renumber(tableName);
  })();

  return { id: insertId };
}

function updateRow(tableName, id, data) {
  assertValidTable(tableName);
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error('没有字段');

  const cleaned = {};
  const typeMap = fieldTypeMap(tableName);
  keys.forEach(k => {
    assertValidColumn(k);
    cleaned[k] = sanitizeField(data[k], tableName, k, typeMap[k]);
  });

  const setClause = Object.keys(cleaned).map(k => `"${k}" = ?`).join(', ');
  const values = Object.values(cleaned).map(bindable);
  values.push(id);

  db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...values);
}

// —— 删学生的「关联不变量」——
// 学生与 请假/加分/座位/值日/小组/班干部 是松耦合（老数据甚至只存姓名），删主表不会连带清。
// 界面上删学生走 `POST /students/:id/delete-with-relations`：它先按用户勾选 purge，再把被删
// 的整行交回前端登记撤销。通用 `DELETE /students/:id` 没有这层，直调就会留六类孤儿
// （审查 v6 · N2-05）—— 而且不报错：值日指数、名单统计继续把已删除的人算进去。
//
// 这里的取舍：**拒绝，不偷偷帮你清**。
//   · 偷偷清 → 绕过撤销登记：前端只登记了「删学生」一条，撤销回来是个没有加分/请假的空壳。
//   · 放任 → 留孤儿（就是现在的问题）。
//   · 拒绝 → 调用方必须走「一并删除」，用户看得见自己勾了什么。
// 已经按要求 purge 过的调用方传 `allowStudentOrphans: true` 显式放行（关联已清，或用户明确选择保留）。
function assertStudentRelationsCleared(id) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!student) return;
  const rel = studentRelations(student);
  if (!rel.total) return;
  const parts = [
    rel.leave && `请假 ${rel.leave}`,
    rel.score && `加分 ${rel.score}`,
    rel.seat && `座位 ${rel.seat}`,
    rel.duty && `值日 ${rel.duty}`,
    rel.group && `小组 ${rel.group}`,
    rel.cadre && `班干部 ${rel.cadre}`,
  ].filter(Boolean).join('、');
  throw new Error(`该学生还有 ${rel.total} 条关联记录（${parts}）：请用「一并删除」并选择要清理的项，直接删主表会留下孤儿数据`);
}

function deleteRow(tableName, id, options = {}) {
  assertValidTable(tableName);
  const { minCount = 0, allowStudentOrphans = false } = options;

  if (minCount > 0) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
    if (count <= minCount) throw new Error('至少需要保留一条记录');
  }

  const row = db.prepare(`SELECT position FROM ${tableName} WHERE id = ?`).get(id);
  if (!row) throw new Error('记录不存在');

  if (tableName === 'students' && !allowStudentOrphans) assertStudentRelationsCleared(id);

  db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
  db.prepare(`UPDATE ${tableName} SET position = position - 1 WHERE position > ?`).run(row.position);
}

// 批量删除：整批包在一个事务里，任一 id 失败整批回滚（不留半截状态）。
// 与单条删除的差别只有两处：
//   · minCount 按「整批删完后」的行数判断 —— 逐条判会把「删完还剩 ≥minCount」的正常批量误拦；
//   · 任一 id 不存在直接报错，不静默跳过（调用方应保证传的是当前全表里的行）。
// allowStudentOrphans / 关联检查与单条删除同一套，批量路径不得绕过。
function deleteRows(tableName, ids, options = {}) {
  assertValidTable(tableName);
  const { minCount = 0, allowStudentOrphans = false } = options;
  const list = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)
  )];
  if (!list.length) throw new Error('缺少要删除的记录');

  const placeholders = list.map(() => '?').join(',');
  return db.transaction(() => {
    // 先确认每个 id 都真的存在：夹一个脏 id 时要报「记录不存在」而不是被行数下限抢先，
    // 否则调用方会以为是「不能删」而不是「传错了」。校验与删除同事务，失败即整批回滚。
    const rows = db.prepare(`SELECT id FROM ${tableName} WHERE id IN (${placeholders})`).all(...list);
    if (rows.length !== list.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = list.filter((id) => !found.has(id));
      throw new Error(`记录不存在: ${missing.join(',')}`);
    }

    if (minCount > 0) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
      if (count - list.length < minCount) throw new Error('至少需要保留一条记录');
    }

    if (tableName === 'students' && !allowStudentOrphans) {
      for (const id of list) assertStudentRelationsCleared(id);
    }

    db.prepare(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`).run(...list);
    // 位置重排：删掉中间若干行后要连续，否则移动/拖拽会按空档算错
    renumber(tableName);
    return { deleted: list.length };
  })();
}

function moveRow(tableName, id, direction) {
  assertValidTable(tableName);
  if (!id || !direction) throw new Error('缺少参数');

  const row = db.prepare(`SELECT position FROM ${tableName} WHERE id = ?`).get(id);
  if (!row) throw new Error('记录不存在');

  const cur = row.position;
  const maxPos = db.prepare(`SELECT MAX(position) AS maxPos FROM ${tableName}`).get().maxPos;
  let target;
  if (direction === 'up') target = cur - 1;
  else if (direction === 'down') target = cur + 1;
  else throw new Error('无效方向');

  if (target < 1 || target > maxPos) throw new Error('已到边界');

  const targetRow = db.prepare(`SELECT id FROM ${tableName} WHERE position = ?`).get(target);
  if (!targetRow) throw new Error('目标行异常');

  db.prepare(`UPDATE ${tableName} SET position = CASE WHEN id = ? THEN ? WHEN id = ? THEN ? END WHERE id IN (?, ?)`)
    .run(id, target, targetRow.id, cur, id, targetRow.id);
}

function addColumn(tableName, columnName, dataType, after) {
  assertValidTable(tableName);
  if (!columnName || !/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(columnName)) throw new Error('列名不合法');
  if (columnName === 'id' || columnName === 'position') throw new Error('不能使用保留字段');

  let sqlType = 'TEXT';
  if (dataType === '整数') sqlType = 'INTEGER';
  else if (dataType === '小数') sqlType = 'REAL';
  else if (dataType === '日期') sqlType = 'TEXT';

  // 物理列可能已经存在：deleteColumn 只删 table_meta 登记、保留物理列（隐形列），
  // 所以「删掉字段再加回同名列」时不能无脑 ALTER —— 那会抛 duplicate column name，
  // 与 deleteColumn 注释承诺的「误删字段可通过重新加同名列找回数据」正好相反。
  // 三种情况：已登记 → 明确报重复；未登记但物理列在 → 只补登记（旧值即找回）；都没有 → 建列 + 登记。
  const registered = db.prepare('SELECT 1 AS hit FROM table_meta WHERE table_name = ? AND column_name = ?')
    .get(tableName, columnName);
  if (registered) throw new Error('字段已存在');

  const physicalExists = db.prepare(`PRAGMA table_info("${tableName}")`).all()
    .some((c) => c.name === columnName);
  // 物理列已在（deleteColumn 保留的隐形列）时只补登记、不 ALTER —— 这样「删掉字段再用
  // 同名列加回」能找回旧数据。这里**不校验类型是否一致**：加回同名即视为「找回」的意图，
  // 类型不符时以已有物理列为准（审查 v5 · V5-049 按此设计决策回退）。
  if (!physicalExists) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN "${columnName}" ${sqlType}`).run();
  }

  const metas = db.prepare('SELECT column_name, sort_order FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(tableName);
  let sortOrder;
  if (after === 'first' || !after) {
    sortOrder = 1;
    db.prepare('UPDATE table_meta SET sort_order = sort_order + 1 WHERE table_name = ?').run(tableName);
  } else {
    const targetMeta = metas.find(m => m.column_name === after);
    if (!targetMeta) throw new Error('目标列不存在');
    sortOrder = targetMeta.sort_order + 1;
    db.prepare('UPDATE table_meta SET sort_order = sort_order + 1 WHERE table_name = ? AND sort_order >= ?').run(tableName, sortOrder);
  }

  db.prepare('INSERT INTO table_meta (table_name, column_name, data_type, sort_order) VALUES (?, ?, ?, ?)')
    .run(tableName, columnName, dataType || '文字', sortOrder);
}

// 删除字段：只删 table_meta 里的登记，不执行 ALTER TABLE DROP COLUMN。
// SQLite 的 DROP COLUMN 在旧版本不可用，且物理删列会让已导出/引用的旧数据不可逆丢失；
// 因此物理列会保留为「隐形列」——列表页按 table_meta 展示时看不到它，但 SELECT * 仍能读到旧值。
// 这样做也保证「误删字段」可以通过重新加同名列的方式找回数据（新值仍写在原列上）。
function deleteColumn(tableName, columnName, options = {}) {
  assertValidTable(tableName);
  const { protectedColumns = [] } = options;

  if (columnName === 'id' || columnName === 'position') throw new Error('不能删除保留字段');
  if (protectedColumns.includes(columnName)) throw new Error('该字段受保护，无法删除');

  const deletable = db.prepare('SELECT COUNT(*) AS cnt FROM table_meta WHERE table_name = ?').get(tableName).cnt;
  if (deletable <= 1) throw new Error('至少需要保留一个数据字段');

  db.prepare('DELETE FROM table_meta WHERE table_name = ? AND column_name = ?').run(tableName, columnName);
  const remaining = db.prepare('SELECT column_name FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(tableName);
  const stmt = db.prepare('UPDATE table_meta SET sort_order = ? WHERE table_name = ? AND column_name = ?');
  remaining.forEach((m, i) => stmt.run(i + 1, tableName, m.column_name));
}

function reorderRows(tableName, ids) {
  assertValidTable(tableName);
  if (!ids || !Array.isArray(ids)) throw new Error('ids 必须为数组');
  const stmt = db.prepare(`UPDATE ${tableName} SET position = ? WHERE id = ?`);
  ids.forEach((id, index) => stmt.run(index + 1, id));
}

function moveColumn(tableName, columnName, targetColumnName, position) {
  assertValidTable(tableName);
  if (!columnName || columnName === 'id' || columnName === 'position') {
    throw new Error('列名不合法或为保留字段');
  }
  if (position === 'after' && (targetColumnName === columnName || !targetColumnName)) {
    throw new Error('无效的目标列');
  }

  const metas = db.prepare('SELECT column_name, sort_order FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(tableName);
  const col = metas.find(m => m.column_name === columnName);
  if (!col) throw new Error('列不存在');

  const target = position === 'first' ? null : metas.find(m => m.column_name === targetColumnName);
  if (position === 'after' && !target) throw new Error('目标列不存在');

  const withoutMoved = metas.filter(m => m.column_name !== columnName);
  let newOrder = [...withoutMoved];
  if (position === 'first') {
    newOrder.unshift(col);
  } else {
    const targetIdx = newOrder.findIndex(m => m.column_name === targetColumnName);
    newOrder.splice(targetIdx + 1, 0, col);
  }

  const stmt = db.prepare('UPDATE table_meta SET sort_order = ? WHERE table_name = ? AND column_name = ?');
  // 整表重排一次事务写完（原来是逐行提交，列多时会有 N 次提交）
  db.transaction(() => {
    newOrder.forEach((m, i) => stmt.run(i + 1, tableName, m.column_name));
  })();
}

function importRows(tableName, fields, rows) {
  assertValidTable(tableName);
  if (!fields || !rows || !Array.isArray(fields) || !Array.isArray(rows)) {
    throw new Error('缺少有效的字段或数据');
  }

  const fieldMeta = getFields(tableName);
  const existingFields = fieldMeta.map(f => f.name);
  const typeMap = {};
  fieldMeta.forEach(f => { typeMap[f.name] = f.type || '文字'; });

  if (fields.length === 0) throw new Error('缺少有效的字段');

  // 建列（DDL）+ 插行 + 重排收进同一个事务：SQLite 的 DDL 可回滚，
  // 插入阶段失败不会留下刚加的空列与 table_meta 登记。原实现建列在事务外，脏数据会留半套空列。
  const insertMany = db.transaction((dataRows) => {
    // 物理列清单要和 table_meta 分开看（deleteColumn 保留隐形列）。
    const physicalCols = new Set(
      db.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => c.name)
    );
    for (const f of fields) {
      assertValidColumn(f);
      if (!existingFields.includes(f)) {
        // deleteColumn 只删登记、保留物理列（隐形列）：只查 table_meta 就 ALTER，
        // 重新导入同名列会抛 duplicate column name 并让整次导入回滚（审查 v5 · V5-048）。
        if (!physicalCols.has(f)) {
          db.prepare(`ALTER TABLE ${tableName} ADD COLUMN "${f}" TEXT`).run();
          physicalCols.add(f);
        }
        const maxSort = db.prepare(`SELECT MAX(sort_order) AS max FROM table_meta WHERE table_name = ?`).get(tableName).max || 0;
        db.prepare(`INSERT INTO table_meta (table_name, column_name, data_type, sort_order) VALUES (?, ?, '文字', ?)`)
          .run(tableName, f, maxSort + 1);
        existingFields.push(f);
        typeMap[f] = '文字';
      }
    }

    // 必须显式写 position：漏掉时新行 position 为 NULL，而 SQLite 的 NULL 在
    // `ORDER BY position, id`（db.js renumber / queryAll 都这么排）里最小 ——
    // 导入的几百行会整块排到表头，与「追加到末尾」的直觉相反。
    const placeholders = fields.map(() => '?').join(',');
    const columnNames = fields.map(f => `"${f}"`).join(',');
    const insertStmt = db.prepare(`INSERT INTO ${tableName} (${columnNames}, "position") VALUES (${placeholders}, ?)`);
    const maxPos = db.prepare(`SELECT MAX(position) AS maxPos FROM ${tableName}`).get().maxPos || 0;

    const ids = [];
    dataRows.forEach((row, i) => {
      const filledRow = fields.map((f, idx) => bindable(sanitizeField(row[idx], tableName, f, typeMap[f] || '文字')));
      filledRow.push(maxPos + i + 1);
      ids.push(Number(insertStmt.run(...filledRow).lastInsertRowid));
    });

    renumber(tableName);
    return ids;
  });

  const ids = insertMany(rows);

  // created = 本次真正新建的行（含 renumber 后的最终 position）：
  // 前端据此登记一条可撤销的批量导入，不需要再按请求参数猜列（Q2-04 / Q2-06）。
  return { count: rows.length, created: readRowsByIds(tableName, ids) };
}

function renameColumn(tableName, oldName, newName) {
  assertValidTable(tableName);
  if (!oldName || !newName) throw new Error('缺少参数');
  // 新旧列名都必须走白名单：oldName 会原样拼进 SQL，只校验 newName 会被引号闭合注入。
  assertValidColumn(oldName);
  assertValidColumn(newName);
  if (oldName === newName) throw new Error('新列名与旧列名相同');

  const existing = db.prepare('SELECT column_name FROM table_meta WHERE table_name = ? AND column_name = ?').get(tableName, newName);
  if (existing) throw new Error('该列名已存在');

  db.prepare(`ALTER TABLE ${tableName} RENAME COLUMN "${oldName}" TO "${newName}"`).run();
  db.prepare('UPDATE table_meta SET column_name = ? WHERE table_name = ? AND column_name = ?').run(newName, tableName, oldName);
}

module.exports = {
  queryAll, insertRow, updateRow, deleteRow, deleteRows, moveRow,
  addColumn, deleteColumn, reorderRows, moveColumn, importRows, renameColumn
};
