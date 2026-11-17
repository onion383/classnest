// =========================================================================
// foreignKeyProbe.js —— 探测某个库的连接「实际受不受外键保护」
//
// ============================ 为什么需要它 ============================
// 外键声明只在**建表那一刻**写进表结构。而 schema 用的是 `CREATE TABLE IF NOT EXISTS`，
// 对已经存在的表是空操作 —— 所以：
//   · 新建的库：9 条声明全部生效，删学生会级联、写孤儿 id 会抛 FOREIGN KEY
//   · 老库（本次改动前建的）：一条外键都没有，两件事都不会发生
//
// 而 better-sqlite3 打开连接时 `PRAGMA foreign_keys` 默认就是 ON（裸库实测 = 1，
// 不写在任何业务代码里）。于是同一个版本、同一份代码，行为取决于「库是什么时候建的」——
// 这是**不确定性**，不是兼容性，而且在代码里完全看不出来。
//
// 本模块把这件事实变成可查的：每个连接探一次，结果缓存，供日志与需要分支的地方使用。
// **只读**：不建表、不改数据、不开 PRAGMA、不影响任何现有行为。
// =========================================================================

'use strict';

const { FK_DECLARATIONS } = require('./foreignKeySpec');

// 每个连接只探一次。用 WeakMap 而不是 Map：连接被 close 并从 connCache 移除后，
// 这里不会留下指向已关闭连接的强引用。缓存的是完整结果对象，重复调用返回同一个引用，
// 调用方可以放心用 `===` 判断「这次和上次是不是同一份结论」。
const cache = new WeakMap();

// 读一张表的外键列表。表不存在 / 连接异常时返回空数组：
// 探测发生在 initSchema 之后，表理应都在；但探测失败绝不能反过来阻断开库，
// 所以这里吞掉异常，让「读不到」表现为「没声明」—— 对调用方是同一个可处理的事实。
function readFkList(conn, table) {
  try {
    return conn.pragma(`foreign_key_list(${JSON.stringify(table)})`) || [];
  } catch (_) {
    return [];
  }
}

// 一条实际声明是否与契约一致：父表、父列、删除策略三项都要对。
// 只比对「有没有」是不够的 —— ON DELETE 从 CASCADE 被改成 NO ACTION 时，
// 「声明在」但行为完全不同，那种情况必须报出来而不是算通过。
function matchesSpec(actual, spec) {
  return !!actual
    && actual.table === spec.parent
    && actual.to === 'id'
    && String(actual.on_delete || '').toUpperCase() === spec.onDelete;
}

// 探测结果：
//   total    契约清单里的条数
//   count    实际生效的条数
//   complete 是否全部生效（= 这个库受外键保护）
//   present  生效的条目
//   missing  缺失或语义不符的条目（老库上通常就是全部 9 条）
function probeForeignKeys(conn) {
  const hit = cache.get(conn);
  if (hit) return hit;

  const present = [];
  const missing = [];
  for (const spec of FK_DECLARATIONS) {
    const actual = readFkList(conn, spec.table).find((r) => r.from === spec.column);
    (matchesSpec(actual, spec) ? present : missing).push(spec);
  }

  const result = Object.freeze({
    total: FK_DECLARATIONS.length,
    count: present.length,
    complete: missing.length === 0,
    present: Object.freeze(present),
    missing: Object.freeze(missing),
  });
  cache.set(conn, result);
  return result;
}

// 单条查询：某表某列此刻是否真的带外键。
// 给「删学生要不要走应用层级联」这类需要分支的地方用，避免再去写一份 PRAGMA。
function hasFkFor(conn, table, column) {
  const r = probeForeignKeys(conn);
  return r.present.some((spec) => spec.table === table && spec.column === column);
}

// 一行摘要，给启动日志用（不在这里 console：本模块保持纯逻辑，好测）
function describeForeignKeys(result) {
  return `${result.count}/${result.total}`;
}

module.exports = { probeForeignKeys, hasFkFor, describeForeignKeys };
