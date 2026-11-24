// =========================================================================
// provisionalStudents.js —— 临时学生的「解析 / 建档」单源实现
//
// 背景：值日 / 座位 / 小组成员允许直接输入名字。为了让这些引用有稳定的身份，
// 名字第一次出现时落一条 is_provisional = 1 的 students 记录：
//   · 与正式学生共用 students.id，转正只是把状态位改回 0，引用不需要重指；
//   · 按姓名部分唯一索引兜底，同一个名字反复输入只可能命中同一条；
//   · 正式名单里已有唯一同名时直接复用正式学生，不建临时。
//
// 解析顺序（重要）：
//   1. 正式学生精确同名 1 个  → 用它
//   2. 正式学生同名 ≥2 个     → 返回候选，不建临时（重名是正式名单自己的问题，不能替用户选）
//   3. 已有同名临时学生       → 用它（唯一索引保证最多一条）
//   4. 都没有且 create=true   → 建临时
// =========================================================================
const { db } = require('../db');
const { insertRow } = require('./tableService');

function findByName(name) {
  return db.prepare(
    'SELECT id, 姓名, 学号, is_provisional FROM students WHERE 姓名 = ? ORDER BY is_provisional, id'
  ).all(name);
}

function resolveOne(rawName, { create = true } = {}) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name) return { name: '', id: null, error: '姓名为空' };
  const rows = findByName(name);
  const formal = rows.filter((r) => !r.is_provisional);
  if (formal.length === 1) {
    return { name, id: Number(formal[0].id), created: false, is_provisional: false };
  }
  if (formal.length > 1) {
    return {
      name,
      id: null,
      created: false,
      ambiguous: true,
      candidates: formal.map((r) => ({ id: Number(r.id), 姓名: r.姓名, 学号: r.学号 || '' })),
    };
  }
  const provisional = rows.find((r) => r.is_provisional);
  if (provisional) {
    return { name, id: Number(provisional.id), created: false, is_provisional: true };
  }
  if (!create) return { name, id: null, created: false, missing: true };
  try {
    const info = insertRow('students', { 姓名: name, is_provisional: 1 });
    return { name, id: Number(info.id), created: true, is_provisional: true };
  } catch (err) {
    // 兜底：唯一索引冲突说明另一个请求刚建了同名临时学生（多进程/极端并发）。
    // 重新查一次拿它的 id，而不是把「已经存在」当失败抛给调用方。
    if (/UNIQUE/i.test(String(err && err.message))) {
      const again = findByName(name).find((r) => r.is_provisional);
      if (again) return { name, id: Number(again.id), created: false, is_provisional: true };
    }
    throw err;
  }
}

// 批量解析（去重、按传入顺序返回）。整批放在一个事务里：
// 后端是单进程同步执行，这样「查-插」不会被另一个请求插进来；唯一索引再兜一层。
function resolveNames(rawNames, { create = true } = {}) {
  const list = Array.isArray(rawNames) ? rawNames : [];
  const seen = new Set();
  const out = [];
  const run = db.transaction(() => {
    for (const raw of list) {
      const name = String(raw == null ? '' : raw).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      try {
        out.push(resolveOne(name, { create }));
      } catch (err) {
        // 单个名字非法（超长等）不拖垮整批：把原因回给调用方，其它名字照常解析。
        out.push({ name, id: null, error: err.message });
      }
    }
  });
  run();
  return out;
}

// 单条写入接口（小组成员等）用：确保这个名字有学生记录，没有就建临时。
// 重名（正式名单 ≥2 个同名）返回 ambiguous，且不建临时 —— 名字本来就存在，不该再多一条。
function ensureProvisionalStudent(rawName) {
  try {
    return resolveOne(rawName, { create: true });
  } catch (err) {
    return { name: String(rawName == null ? '' : rawName).trim(), id: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 行式表里的「学生引用」列
//
// 通用行式写入器（AI 批量 apply-batch）是按列名直写 SQL 的，不知道哪一列是学生姓名，
// 于是同一件事在三条路径上有三套口径。映射放在这里，让「谁写这一列」都走同一处。
//
//   group_members  P2-1 起有 student_id（权威）+ member_name（快照）
//   cadre_members  姓名是快照、student_id 才是权威（P1-1 已定）→ 认人后回填 id，姓名跟权威走
//   score_records / leave_records
//                  与各自路由的 POST 同口径：名册外的姓名要落临时学生，否则 AI 批量写进来的
//                  记录只剩下一个字符串（改名、统计、删学生全对不上人）。这两张表的姓名列
//                  叫「姓名」而不是 student_name，名字不同但语义一样，所以映射按表分开写。
//
// 全部口径已统一：都不许「只写姓名、id 空着」的孤儿行。
// ---------------------------------------------------------------------------
const ROW_STUDENT_REFS = {
  group_members: { name: 'member_name', id: 'student_id' },
  cadre_members: { name: 'student_name', id: 'student_id' },
  score_records: { name: '姓名', id: 'student_id' },
  leave_records: { name: '姓名', id: 'student_id' },
};

// 让一行行式数据里的学生引用与名册一致，**就地修改 row**。不涉及学生引用时返回 null。
//
//   · 只有姓名列：保证该姓名有学生记录（名册外的建临时学生）。建档失败不抛 ——
//     与 groupDim.addMember 同口径（尽力而为，不阻断业务写入）。
//   · 还有 id 列：
//       - 给了有效 id → 姓名一律以 students.姓名 为准（快照不许覆盖权威）；
//         id 指向不存在的学生 → 抛错（宁可整批失败，也不要写一行断链的快照）
//       - 没给 id → 按姓名认人，命中/建档就把 id 回填进去；
//         同名歧义 → id 留空、姓名照存（与 cadres 路由同口径，不替用户猜）
function applyRowStudentRef(table, row) {
  const spec = ROW_STUDENT_REFS[table];
  if (!spec || !row) return null;
  const rawName = row[spec.name] == null ? '' : row[spec.name];
  const name = String(rawName).trim();
  if (!spec.id) {
    if (!name) return null;
    return ensureProvisionalStudent(name);
  }

  const curId = Number(row[spec.id]);
  if (Number.isInteger(curId) && curId > 0) {
    const stu = db.prepare('SELECT id, 姓名, is_provisional FROM students WHERE id = ?').get(curId);
    if (!stu) {
      // 前端带了「已经被删掉的学生」的 id —— 这是用户填错/界面过期，不是服务端故障。
      // 带上 status 让路由按 400 回，别让「学生不存在」显示成「服务器错误」。
      const err = new Error(`学生 id=${curId} 不存在（${table}.${spec.id}）`);
      err.status = 400;
      throw err;
    }
    row[spec.name] = String(stu.姓名 == null ? '' : stu.姓名);
    return { name: row[spec.name], id: curId, created: false, is_provisional: !!stu.is_provisional };
  }
  if (!name) return null;
  const r = ensureProvisionalStudent(name);
  if (r && r.id) row[spec.id] = r.id; // 歧义时 r.id 为 null → 保持留空
  return r;
}

// ---------------------------------------------------------------------------
// 批量导入的同名选人：用户在导入前已为某一行指定了学生，这里把决定落成权威 id。
//
// picked: 数字 id（名册里选中的某位）| 'new'（名册外的新同学）| undefined（没指定）
// 返回 { id, name, is_provisional } 或 null（没指定 / 指定无效）。
// 数字 id 必须校验存在，并**忽略表里填的姓名**：权威是用户选中的那个人，
// 快照姓名以 students 表为准；'new' 才按名字建临时学生（正式名单里有同名也不复用）。
// ---------------------------------------------------------------------------
function resolvePickedForImport(picked, rawName) {
  if (picked === undefined || picked === null || picked === '') return null
  const name = String(rawName == null ? '' : rawName).trim()
  if (picked === 'new') {
    if (!name) return null
    // 直接建临时学生：正式名单里已有同名也照建（用户明确说这是新同学）。
    const info = insertRow('students', { 姓名: name, is_provisional: 1 })
    return { id: Number(info.id), name, is_provisional: true, created: true }
  }
  const id = Number(picked)
  if (!Number.isInteger(id) || id <= 0) return null
  const stu = db.prepare('SELECT id, 姓名, is_provisional FROM students WHERE id = ?').get(id)
  if (!stu) {
    const err = new Error(`选择的学生 id=${id} 不存在`)
    err.status = 400
    throw err
  }
  return { id: Number(stu.id), name: String(stu.姓名 ?? ''), is_provisional: !!stu.is_provisional, created: false }
}

module.exports = {
  resolveOne,
  resolveNames,
  ensureProvisionalStudent,
  resolvePickedForImport,
  ROW_STUDENT_REFS,
  applyRowStudentRef,
};
