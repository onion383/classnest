// =========================================================================
// schema.mcp.js —— 方向 B（应用作为 MCP 服务端）的提案表
//
// 外部 AI 客户端通过 /mcp 提交的写操作不直接落库，先在这里存一条「待确认提案」，
// 由班集前端轮询展示、老师确认后才走现有写入链路执行。这是「后端绝不直接改库」
// 原则在方向 B 的等价物：外部写请求和本地 AI 的 propose_* 一样必须过用户确认。
//
// proposal_id 用随机 hex（不递增），避免外部客户端枚举；状态流转：
//   pending → confirmed / rejected / failed / expired
// =========================================================================
function migrateMcp(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS mcp_proposals (
      proposal_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'row_write',
      label TEXT DEFAULT '',
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      requested_by TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_proposals_status ON mcp_proposals(status, created_at);
  `);
}

module.exports = { migrateMcp };
