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
      origin TEXT NOT NULL DEFAULT '',
      -- 统一来源分类：manual（手改）/ ai_assistant（助手）/ mcp（外部工具）。
      -- 与 origin 正交：origin 保留批次语义（整批回退靠它），source 只用于面板筛选/展示，
      -- 不能只看 origin<>'' 分类——那会把 AI 助手和 MCP 混在一起。
      source TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  // 旧库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，必须显式 ALTER。
  // 重复执行安全（先查 PRAGMA，缺列才加）。
  const cols = conn.prepare('PRAGMA table_info(undo_history)').all().map((c) => c.name)
  if (!cols.includes('source')) {
    // 补列默认值故意用空串（不是 'manual'）：这样下面的回填 WHERE source='' 才能命中历史行。
    conn.exec(`ALTER TABLE undo_history ADD COLUMN source TEXT NOT NULL DEFAULT ''`)
  }
  // 回填：把历史记录按 origin 归类。WHERE source='' 只命中「补列后尚未归类」的历史行；
  // 新库 CREATE 的默认值是 'manual'，本条不会动到正常新写入的数据。
  // 归类规则与 services/undoStore.sourceOfOrigin 一致：
  //   origin='' → manual；32 位小写 hex → mcp；其余 → ai_assistant。
  conn.exec(`
    UPDATE undo_history SET source = CASE
      WHEN origin = '' THEN 'manual'
      WHEN length(origin) = 32 AND origin NOT GLOB '*[^0-9a-f]*' THEN 'mcp'
      ELSE 'ai_assistant'
    END
    WHERE source = ''
  `);
  // 修正历史误标：op- 批次是「老师一次动作」（一次改多格、拖一次座位），
  // 旧版 sourceOfOrigin 把所有非 32 位 hex 的 origin 都当成助手，把它们整批标成了
  // ai_assistant。只动 op- 这个词形，真助手（ai- / 子agent）与 MCP（32 hex）不受影响。
  // 幂等：再跑一次没有可匹配的行。
  conn.exec(`
    UPDATE undo_history SET source = 'manual'
    WHERE source = 'ai_assistant' AND origin LIKE 'op-%'
  `);
  // 优化：按资源分组查询/删最旧记录
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_undo_key ON undo_history (key, id);`);  // 优化：按 (dir, origin) 查询 —— AI 批次的整批回退/撤销列表都走这个条件
  //   （见 routes/undo/undo.records.js：`WHERE dir = 1 AND origin = ?`、
  //    `WHERE dir = 1 AND origin <> ''`）。
  //   原来的 idx_undo_key 是 (key, id)，**不覆盖**这两个条件 → 每次查批次都全表扫。
  //   undo_history 的写入不频繁（只在用户编辑/AI 改动时插），多这一个索引很划算。
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_undo_dir_origin ON undo_history (dir, origin);`);
}

module.exports = { migrateUndo };
