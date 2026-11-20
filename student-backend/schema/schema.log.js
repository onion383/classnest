// =========================================================================
// schema.log.js —— 数据访问记录（AI 助手 / MCP 外部客户端「读了什么」）
//
// 只记**读**：读表、读整块文档、全局搜索、列出目录。
// 写操作不记这里 —— 写入在「设置 → 更改审查」（undo_history）里已有完整的前后值
// 与回退入口，再抄一份到访问记录里，两份口径迟早会互相打脸。
// 所以三者的边界是固定的：
//   AI 数据保护  → AI 访问记录（只看 ai）
//   MCP 服务管理 → MCP 访问记录（只看 mcp）
//   设置 → 更改审查 → 全部来源的写入与回退
//
// 刻意**不存数据内容**：只留「哪张表 / 多少行 / 结果如何」这类元信息，
// 绝不把学生姓名电话复制到第二张表里（那是隐私红线）。
// result 单列 denied，是为了事后能证明「我关掉的那张表确实挡住了请求」，
// 而不是关了个寂寞 —— 这是这一张表存在的主要理由。
//
// 裁剪交给 services/accessLogStore（只留最近 500 条）：它用于回看，不是账本。
// =========================================================================
function migrateLog(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS access_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      actor TEXT DEFAULT '',
      tool TEXT NOT NULL,
      target TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      -- 行数 / 结果组数等「量」的数值副本：按天合并时要用 SUM 求和，
      -- 全靠 detail 字符串没法算术。0 表示这次读没有可计量的量。
      amount INTEGER DEFAULT 0,
      result TEXT NOT NULL DEFAULT 'ok',
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_created ON access_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_access_log_source ON access_log(source, created_at);
  `);
}

module.exports = { migrateLog };
