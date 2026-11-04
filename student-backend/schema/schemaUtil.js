// =========================================================================
// schemaUtil.js —— 建表前的小工具
// =========================================================================

// 按「真实类型」删除同名对象。
//
// 为什么需要它：SQLite 的 DROP VIEW 只认视图、DROP TABLE 只认表，
// 而 `IF EXISTS` 只抑制「根本不存在」，**不抑制「类型不对」**。
// 老库里这些名字可能还是**表**（比如 schedule 拆分前就是表），
// 此时 `DROP VIEW IF EXISTS schedule` 会抛
//   "use DROP TABLE to delete table schedule"
// 整个 initSchema 在 conn.exec 的批量语句里中断 → 库直接打不开，
// 而且报错信息完全指不到「是哪个名字型不对」（审查 v4 · B05-06）。
//
// 用法：在每个 migrate 函数开头，把将要 CREATE VIEW 的名字挨个过一遍。
// 之后 SQL 里原有的 DROP VIEW / DROP TABLE 语句会变成无害的空操作，不必删。
function dropObjectIfExists(conn, name) {
  const row = conn
    .prepare("SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table','view')")
    .get(name)
  if (!row) return false
  conn.exec(`DROP ${row.type === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS "${name}"`)
  return true
}

module.exports = { dropObjectIfExists }
