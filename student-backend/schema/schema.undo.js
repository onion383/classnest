// schema 拆分子文件：撤销历史（持久化 undo）+ 分组索引。
function migrateUndo(conn) {
  // ======================== 撤销历史（持久化 undo） ========================
  // 按资源 key 分组记录编辑动作，支持跨重启后继续撤销。
  // dir：1=可撤销（undo侧），0=已撤销（redo侧）。
  conn.exec(`
    CREATE TABLE IF NOT EXISTS undo_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      dir INTEGER NOT NULL DEFAULT 1,
      ts TEXT NOT NULL DEFAULT '',
      -- 来源标记：空字符串=老师手动编辑产生；非空=AI 助手一次更改的批次标识，同一批次整批回退。
      origin TEXT NOT NULL DEFAULT ''
    );
  `);
  // 优化：按资源分组查询/删最旧记录
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_undo_key ON undo_history (key, id);`);
  // 优化：按 (dir, origin) 查询 —— AI 批次的整批回退/撤销列表都走这个条件
  //   （见 routes/undo/undo.records.js：`WHERE dir = 1 AND origin = ?`、
  //    `WHERE dir = 1 AND origin <> ''`）。
  //   原来的 idx_undo_key 是 (key, id)，**不覆盖**这两个条件 → 每次查批次都全表扫。
  //   undo_history 的写入不频繁（只在用户编辑/AI 改动时插），多这一个索引很划算。
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_undo_dir_origin ON undo_history (dir, origin);`);
}

module.exports = { migrateUndo };
